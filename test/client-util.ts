// Helpers of the client SDK's tests: the engine's reference messages and a fake engine built from the library alone.
import * as fs from "node:fs";
import * as path from "node:path";
import { decode, ErrBadArgs, ErrForbidden, KindComputer, LevelWrite, Node, P2PACTError, type CborValue, type Grant } from "../src/index.js";
import { DEFAULT_WANTS, Events, P2pactClient, streamOf, type Computer, type ComputerEvent, type JsonMap } from "../src/client/index.js";
import { asMap, normalize, obj, str, wire } from "../src/client/support.js";
import { tmp } from "./util.js";

const root = path.resolve(import.meta.dirname, "../../test/fixtures/contract/tools");

/** The engine's reference messages (contract/tools of the engine repository, copied to the test fixtures). */
export const Fixtures = {
  exists: (dir: string, name: string) => fs.existsSync(path.join(root, dir, name + ".json")),
  read: (dir: string, name: string): JsonMap => JSON.parse(fs.readFileSync(path.join(root, dir, name + ".json"), "utf8")),
  /** The `params` of a request fixture ({} when it has none). */
  params: (dir: string, name: string): JsonMap => obj(Fixtures.read(dir, name), "params") ?? {},
};

export interface Seen {
  tool: number;
  method: string;
  params: JsonMap;
  level: number;
}

const CHAT_READ = new Set(["initialize", "session/list", "session/load", "_p2pact/older", "_p2pact/commands", "_p2pact/files",
  "_p2pact/history", "_p2pact/projects", "_p2pact/agents", "_p2pact/image", "_p2pact/diff"]);
const FLEET_READ = new Set(["fleet/hello", "node/get", "session/list", "session/get", "session/messages", "fleet/watch", "fleet/unwatch"]);
const PLUGINS_READ = new Set(["plugins/list", "plugins/log", "plugins/grants"]);

/** FakeEngine is a computer built from the library alone: it serves tools 1, 2 and 4 and a hosted
 * tool, and answers with the messages of the contract fixtures. What a client sent is in `seen`. */
export class FakeEngine {
  readonly node = new Node(tmp(), "MacBook Pro");
  readonly seen: Seen[] = [];
  /** Notifications the client sent (`session/cancel`…), as JSON-RPC messages. */
  readonly fromClient = new Events<JsonMap>();
  /** What the person grants a newcomer that asked for `wants`; by default what it asked. */
  decide: (wants: Grant[]) => Grant[] = (w) => w;
  /** The address of the paired client. */
  clientAddr = "";
  private pairedWaiters: (() => void)[] = [];
  /** Answers for a method ("1:session/list"), in place of the fixture's. */
  readonly overrides = new Map<string, (params: JsonMap) => JsonMap>();
  readonly watchers: boolean[] = [];
  private numbers = new Map<string, number>();

  static async start(): Promise<FakeEngine> {
    const e = new FakeEngine();
    await e.node.listenUDP("127.0.0.1:0");
    e.node.kind = KindComputer;
    e.node.onWants = (_p, wants) => e.decide(wants);
    e.node.onPaired = (p) => {
      e.clientAddr = p.addr;
      e.pairedWaiters.splice(0).forEach((w) => w());
    };
    e.node.onEvent = (_peer, tool, ev, args) => {
      if (tool === 1 && ev === 1) {
        const m = asMap(normalize(decode(args[0])));
        if (m) e.fromClient.emit(m);
      }
    };
    e.node.handleLevel(1, 1, (_p, level, args) => e.rpc(1, level, args, CHAT_READ));
    e.node.handleLevel(2, 1, (_p, level, args) => e.rpc(2, level, args, FLEET_READ));
    e.node.handleLevel(4, 1, (_p, level, args) => e.rpc(4, level, args, PLUGINS_READ));
    e.node.handleTool("com.example.hello", 1, (_p, args) => ["hello " + decode(args[0])]);
    e.node.start();
    return e;
  }

  invite(): string {
    return this.node.invite(60_000).toString();
  }

  async paired(): Promise<string> {
    if (!this.clientAddr) await new Promise<void>((r) => this.pairedWaiters.push(r));
    return this.clientAddr;
  }

  private rpc(tool: number, level: number, args: Uint8Array[], reads: Set<string>): CborValue[] {
    const req = asMap(normalize(decode(args[0])));
    const method = req && str(req, "method");
    if (!req || !method) throw new P2PACTError(ErrBadArgs, "no method");
    const params = obj(req, "params") ?? {};
    this.seen.push({ tool, method, params, level });
    // one P2PACT method carries all of the tool: the level is checked on the JSON-RPC method (chat spec §6)
    if (!reads.has(method) && level < LevelWrite) throw new P2PACTError(ErrForbidden, "forbidden");
    const resp = this.overrides.get(`${tool}:${method}`)?.(params) ?? (tool === 1 ? this.chat(method) : tool === 2 ? this.fleet(method, params) : this.plugins(method));
    return [wire(resp)];
  }

  private chat(method: string): JsonMap {
    const stem = method.replace("/", ".");
    if (method === "session/load") {
      for (const n of ["session.update.user_message", "session.update.agent_message", "session.update.tool_call"]) this.notify(1, Fixtures.read("p2pact.chat", n + ".notification"));
      return { jsonrpc: "2.0", result: { _meta: { p2pact: { older: true } } } };
    }
    return Fixtures.exists("p2pact.chat", stem + ".response") ? Fixtures.read("p2pact.chat", stem + ".response") : { jsonrpc: "2.0", result: {} };
  }

  private fleet(method: string, params: JsonMap): JsonMap {
    if (method === "node/get") return { jsonrpc: "2.0", result: obj(obj(Fixtures.read("p2pact.fleet", "hello.response"), "result")!, "node")! };
    let stem: string | undefined;
    switch (method) {
      case "fleet/hello": stem = "hello"; break;
      case "session/list": stem = "session-list"; break;
      case "session/get": stem = "session-get"; break;
      case "session/messages": stem = "session-messages"; break;
      case "fleet/watch": this.watchers.push(params.partial === true); stem = "watch"; break;
      case "fleet/unwatch": stem = "unwatch"; break;
      case "session/create": stem = "session-create"; break;
      case "session/send": stem = params.id === "нет" ? "session-send-unknown" : "session-send"; break;
      case "settings/set": stem = "settings-set"; break;
    }
    return stem ? Fixtures.read("p2pact.fleet", stem + ".response") : { jsonrpc: "2.0", result: { ok: true } };
  }

  private plugins(method: string): JsonMap {
    const stem = method.replace("/", ".");
    return Fixtures.exists("p2pact.plugins", stem + ".response")
      ? Fixtures.read("p2pact.plugins", stem + ".response")
      : { jsonrpc: "2.0", error: { code: -32601, message: "no method " + method } };
  }

  // --- to the client ---

  /** notify sends a JSON-RPC notification as the tool's event, on the stream of its session or id. */
  notify(tool: number, msg: JsonMap) {
    const p = obj(msg, "params") ?? {};
    const stream = streamOf(str(p, "sessionId") ?? str(p, "id"));
    const key = String(stream);
    const n = (this.numbers.get(key) ?? 0) + 1;
    this.numbers.set(key, n);
    this.node.eventOn(this.clientAddr, stream, tool, 1, wire(msg), n);
  }

  /** ask makes a request of the client, as the agent device does (permissions, questions). */
  async ask(tool: number, msg: JsonMap, sessionId: string): Promise<JsonMap> {
    const res = await this.node.callOn(this.clientAddr, streamOf(sessionId), tool, 1, wire(msg));
    return asMap(normalize(decode(res[0])))!;
  }

  close() {
    this.node.close();
  }
}

/** A client app paired with a FakeEngine in this process. Waits are on events, not on time. */
export class Harness {
  engine!: FakeEngine;
  client!: P2pactClient;

  /** Starts the engine and the client; pairs with `wants` and waits until the computer's hello came. */
  async connect(wants: readonly Grant[] = DEFAULT_WANTS, decide?: (w: Grant[]) => Grant[]): Promise<Computer> {
    this.engine = await FakeEngine.start();
    if (decide) this.engine.decide = decide;
    this.client = await P2pactClient.open(tmp(), "Test app", { udp: "127.0.0.1:0", tcp: null });
    const events = this.client.computerEvents;
    // the narrowed or given grants (event 0.6) come right after pairing, unless they are everything
    const everything = JSON.stringify(this.engine.decide([...wants])) === JSON.stringify([{ tool: "*", level: 2 }]);
    // (before the person decides, the newcomer is told it may use nothing: wait for the decision)
    const expected = JSON.stringify(this.engine.decide([...wants]));
    const granted = everything || wants.length === 0 ? undefined
      : events.next({ filter: (e: ComputerEvent) => e.type === "grantsChanged" && JSON.stringify(e.grants) === expected });
    const computer = await this.client.pair(this.engine.invite(), wants);
    await computer.whenOnline();
    await this.engine.paired();
    await granted;
    return computer;
  }

  close() {
    this.client?.close();
    this.engine?.close();
  }

  /** What the client sent for `method` equals the fixture's params. */
  sent(tool: number, method: string): JsonMap {
    const s = [...this.engine.seen].reverse().find((x) => x.tool === tool && x.method === method);
    if (!s) throw new Error(`${method} was not called`);
    return s.params;
  }
}
