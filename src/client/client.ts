// P2pactClient: an application's side of P2PACT (as the p2pact-kotlin client SDK).
import { decode, type CborValue } from "../cbor.js";
import type { StreamId } from "../delivery.js";
import { grantLevel, LevelRead, LevelWrite, type Grant } from "../grants.js";
import { ErrForbidden, KindClient, KindPlugin, later, Node, P2PACTError } from "../node.js";
import type { Peer } from "../store.js";
import { Invite } from "../store.js";
import { ChatClient } from "./chat.js";
import { FailedError, NoMethodError, RpcError, typed } from "./errors.js";
import { FleetClient } from "./fleet.js";
import { DEFAULT_WANTS, Tools } from "./names.js";
import { PluginsClient } from "./plugins.js";
import { asMap, deferred, Events, normalize, obj, str, withTimeout, wire, type JsonMap } from "./support.js";

export { DEFAULT_WANTS, Tools };

/** ClientConfig is how a client reaches computers. `udp` and `tcp` are the addresses it listens on
 * (`""` for tcp — only dials; `null` — no such road). */
export interface ClientConfig {
  /** Default "0.0.0.0:0". */
  udp?: string | null;
  /** Default "": dial only. */
  tcp?: string | null;
  /** How long a call waits for its answer, ms; 0 — for ever. Prompts never time out. Default 60 s. */
  callTimeoutMs?: number;
  /** Default 30 s. */
  pairTimeoutMs?: number;
}

export type ConnectionState = "offline" | "online";

/** A change of a computer the application may show. */
export type ComputerEvent =
  /** Pairing finished (on our side). */
  | { type: "paired"; computer: Computer }
  /** The computer's hello came: a session runs, its tools are known. After a restart it comes again. */
  | { type: "online"; computer: Computer }
  /** The computer told what we may use of its tools (event 0.6). */
  | { type: "grantsChanged"; computer: Computer; grants: Grant[] }
  | { type: "forgotten"; computer: Computer };

/** An event of a tool the SDK has no typed layer for (a plugin's tool): the numbers are the computer's. */
export interface ToolEvent {
  computer: Computer;
  tool: string;
  toolNumber: number;
  event: number;
  args: CborValue[];
}

/**
 * P2pactClient is an application's side of P2PACT: it pairs with computers (devices running the
 * P2PACT engine) by their invite, keeps them, and gives the typed clients of their public tools.
 * The state (keys, paired computers) lives in `dir`; keeping that safe is the application's job.
 *
 *     const client = await P2pactClient.open(dataDir, "My app");
 *     const computer = await client.pair("p2pact1.…");
 *     const chats = await computer.chat.listSessions();
 *
 * Calls return promises that reject with a ProtocolError (the P2PACT error codes) or an RpcError
 * (the tool's own errors).
 */
export class P2pactClient {
  /** Pairing, hellos and grants of computers. */
  readonly computerEvents = new Events<ComputerEvent>();
  /** Events of tools without a typed layer (a plugin's tool). */
  readonly toolEvents = new Events<ToolEvent>();

  private computersByAddr = new Map<string, Computer>();
  private sequence = new Map<string, number>();

  private constructor(
    /** The protocol node: for what this SDK does not wrap. Do not set its callbacks (unless you wrapped it: see {@link P2pactClient.wrap}). */
    readonly node: Node,
    readonly config: Required<Pick<ClientConfig, "callTimeoutMs" | "pairTimeoutMs">> & ClientConfig,
    private readonly owned: boolean,
  ) {
    // the computer's calls into the chat tool: permissions and questions of agents (chat spec §6, §9.1)
    node.handle(Tools.CHAT_NUMBER, 1, (peer, args) => {
      const c = this.computerOrNull(peer);
      if (!c) throw new P2PACTError(ErrForbidden, "unknown computer");
      return later(c.chat.incoming(args));
    });
  }

  /** open makes the node in `dir` and runs it: listens on the roads of `config`, ready to pair.
   * Node.js only (a browser builds its node itself and uses {@link P2pactClient.wrap}). */
  static async open(dir: string, name: string, config: ClientConfig = {}): Promise<P2pactClient> {
    const { Node: FsNode } = await import("../node-fs.js");
    const node = new FsNode(dir, name);
    node.kind = KindClient;
    const c = new P2pactClient(node, withDefaults(config), true);
    try {
      const udp = config.udp === undefined ? "0.0.0.0:0" : config.udp;
      const tcp = config.tcp === undefined ? "" : config.tcp;
      if (udp !== null) await node.listenUDP(udp);
      if (tcp !== null) await node.listenTCP(tcp);
    } catch (e) {
      node.close();
      throw e;
    }
    node.onPaired = (p) => c.paired(p);
    node.onHello = (addr) => c.hello(addr);
    node.onGranted = (addr, g) => c.granted(addr, g);
    node.onEvent = (addr, tool, ev, args) => c.event(addr, tool, ev, args);
    node.start();
    return c;
  }

  /**
   * wrap gives the typed clients over a node the application already runs (it owns the keys, the
   * roads, the pairing and the node's callbacks). The SDK only serves the chat tool's calls from the
   * computers. The application keeps `onHello`, `onEvent`, `onGranted` and `onPaired` of the node
   * and passes them on: {@link hello}, {@link event}, {@link granted}, {@link paired}. `close()`
   * leaves the node open.
   */
  static wrap(node: Node, config: ClientConfig = {}): P2pactClient {
    return new P2pactClient(node, withDefaults(config), false);
  }

  /** The computer's hello came (the node's `onHello`): for a wrapped node, pass it on first thing. */
  hello(addr: string) {
    this.computerOrNull(addr)?.helloArrived();
  }

  /** An event of a tool from a computer (the node's `onEvent`): for a wrapped node, in the order the node gave it. */
  event(addr: string, tool: number, ev: number, args: Uint8Array[]) {
    this.dispatch(addr, tool, ev, args);
  }

  /** The computer told what we may use (the node's `onGranted`). */
  granted(addr: string, grants: Grant[]) {
    const c = this.computerOrNull(addr);
    if (c) this.computerEvents.emit({ type: "grantsChanged", computer: c, grants });
  }

  /** Pairing finished (the node's `onPaired`). */
  paired(p: Peer) {
    if (usable(p)) this.computerEvents.emit({ type: "paired", computer: this.computerOf(p.addr) });
  }

  /** pair pairs with a computer by its invite (`p2pact1.…`, from `nomad invite` or the like) as a
   * client application, asking for `wants`. It resolves when the pairing is done; the person at the
   * computer may narrow the grants later still: {@link ComputerEvent} `grantsChanged`. */
  async pair(invite: string, wants: readonly Grant[] = DEFAULT_WANTS, timeoutMs = this.config.pairTimeoutMs): Promise<Computer> {
    const inv = Invite.parse(invite);
    const p = await this.node.joinWants(inv, [...wants], timeoutMs);
    return this.computerOf(p.addr);
  }

  /** computers lists the paired computers. */
  computers(): Computer[] {
    return this.node.trust.list().filter(usable).map((p) => this.computerOf(p.addr));
  }

  /** computer finds a paired computer by its address (`Computer.id`). */
  computer(id: string): Computer | undefined {
    return this.computerOrNull(id);
  }

  /** forget unpairs a computer: its keys and conversation state go. */
  forget(computer: Computer) {
    this.node.forget(computer.id);
    this.computersByAddr.delete(computer.id);
    this.computerEvents.emit({ type: "forgotten", computer });
  }

  /** close stops the node, if the SDK made it. */
  close() {
    if (this.owned) this.node.close();
  }

  // --- internals ---

  /** @internal */
  computerOrNull(addr: string): Computer | undefined {
    const known = this.computersByAddr.get(addr);
    if (known) return known;
    const p = this.node.trust.get(addr);
    return p && usable(p) ? this.computerOf(addr) : undefined;
  }

  private computerOf(addr: string): Computer {
    let c = this.computersByAddr.get(addr);
    if (!c) this.computersByAddr.set(addr, (c = new Computer(this, addr)));
    return c;
  }

  private dispatch(addr: string, tool: number, ev: number, raw: Uint8Array[]) {
    const c = this.computerOrNull(addr);
    if (!c) return;
    let args: CborValue[];
    try {
      args = raw.map((a) => decode(a));
    } catch {
      return;
    }
    if (tool === Tools.CHAT_NUMBER && ev === 1) c.chat.notified(args);
    else if (tool === Tools.FLEET_NUMBER && ev === 1) c.fleet.notified(args);
    else if (tool === Tools.PLUGINS_NUMBER) {
      if (ev === 1) c.plugins.notified(args);
    }
    else this.toolEvents.emit({ computer: c, tool: this.node.peerToolName(addr, tool), toolNumber: tool, event: ev, args });
  }

  /** The number of our next notification on a stream: from 1 for each pair of devices and stream (fleet spec §1). @internal */
  nextEventNumber(addr: string, stream: StreamId): number {
    const key = `${addr}/${stream}`;
    const n = (this.sequence.get(key) ?? 0) + 1;
    this.sequence.set(key, n);
    return n;
  }

  /** @internal */
  resetEventNumbers(addr: string) {
    for (const k of [...this.sequence.keys()]) if (k.startsWith(addr + "/")) this.sequence.delete(k);
  }
}

const usable = (p: Peer) => p.kind !== KindPlugin && p.kind !== KindClient;

const withDefaults = (c: ClientConfig) => ({ ...c, callTimeoutMs: c.callTimeoutMs ?? 60_000, pairTimeoutMs: c.pairTimeoutMs ?? 30_000 });

/**
 * Computer is a paired computer: the device that runs agents. The typed clients of its tools hang
 * off it: `chat`, `fleet`, `plugins`.
 */
export class Computer {
  private helloSeen = false;
  private ready = deferred<Computer>();
  private chat_?: ChatClient;
  private fleet_?: FleetClient;
  private plugins_?: PluginsClient;

  /** @internal */
  constructor(readonly owner: P2pactClient, readonly id: string) {}

  private get node() {
    return this.owner.node;
  }

  private get peer() {
    return this.node.trust.get(this.id);
  }

  get name(): string {
    return this.peer?.name ?? "";
  }

  get os(): string | undefined {
    return this.peer?.os;
  }

  /** Whether a session with the computer runs and it has told its tools. */
  get state(): ConnectionState {
    return this.helloSeen && this.node.paths(this.id).length > 0 ? "online" : "offline";
  }

  /** The roads in use: `udp`, `tcp`… */
  get paths(): string[] {
    return this.node.paths(this.id);
  }

  /** What the computer lets us use of its tools, as it told us (event 0.6). Paired with wants (the SDK always asks):
   * nothing until the first 0.6 arrives. A device that joined without wants has everything until told. */
  get grants(): Grant[] {
    return this.node.grantedBy(this.id);
  }

  /** The level we have on a tool of the computer: 0 none, 1 LevelRead, 2 LevelWrite. */
  level(tool: string): number {
    return grantLevel(this.grants, tool);
  }

  canRead(tool: string) {
    return this.level(tool) >= LevelRead;
  }

  canWrite(tool: string) {
    return this.level(tool) >= LevelWrite;
  }

  get chat(): ChatClient {
    return (this.chat_ ??= new ChatClient(this));
  }

  get fleet(): FleetClient {
    return (this.fleet_ ??= new FleetClient(this));
  }

  get plugins(): PluginsClient {
    return (this.plugins_ ??= new PluginsClient(this));
  }

  /** whenOnline resolves when the computer's hello has come (at once, if it has). */
  whenOnline(): Promise<Computer> {
    return this.ready.promise;
  }

  /** @internal */
  helloArrived() {
    this.helloSeen = true;
    this.owner.resetEventNumbers(this.id);
    this.chat.reconnected();
    this.fleet.reconnected();
    this.plugins_?.reconnected();
    this.ready.resolve(this);
    this.owner.computerEvents.emit({ type: "online", computer: this });
  }

  /** rpc is a JSON-RPC call over the tool's `rpc` method (chat spec §2): the result object, or the tool's error.
   * @internal */
  async rpc(tool: number, method: string, params?: JsonMap, stream: StreamId = 0, timeoutMs = this.owner.config.callTimeoutMs): Promise<JsonMap> {
    const req = { jsonrpc: "2.0", method, params };
    let res: Uint8Array[];
    try {
      res = await withTimeout(this.node.callOn(this.id, stream, tool, 1, wire(req)), timeoutMs, method);
    } catch (e) {
      throw typed(e);
    }
    const msg = res.length ? asMap(normalize(decode(res[0]))) : undefined;
    if (!msg) throw new FailedError("empty response");
    const err = obj(msg, "error");
    if (err) throw new RpcError(typeof err.code === "number" ? err.code : RpcError.FAILED, str(err, "message") ?? "", err.data);
    return obj(msg, "result") ?? {};
  }

  /** notify sends a JSON-RPC notification as the tool's `notify` event. @internal */
  notify(tool: number, method: string, params: JsonMap, stream: StreamId) {
    this.node.eventOn(this.id, stream, tool, 1, wire({ jsonrpc: "2.0", method, params }), this.owner.nextEventNumber(this.id, stream));
  }

  /** toolNumber is the number the computer gave a tool of its own (a plugin's) in its hello;
   * undefined until it is known. */
  toolNumber(name: string): number | undefined {
    return this.node.toolNumber(this.id, name);
  }

  /** callTool calls a method of a tool by name; the number is the computer's own (hosted tools,
   * core spec §8.2). It waits for the computer's hello if it has not come. Arguments are JSON
   * trees (numbers, text, lists, maps, bytes); the result values are decoded CBOR as they are. */
  async callTool(name: string, method: number, ...args: unknown[]): Promise<CborValue[]> {
    const go = async () => {
      const n = this.toolNumber(name);
      if (n === undefined) throw new NoMethodError(`the computer has no tool ${name}`);
      try {
        const res = await withTimeout(this.node.callOn(this.id, 0, n, method, ...args), this.owner.config.callTimeoutMs, name);
        return res.map((r) => decode(r));
      } catch (e) {
        throw typed(e);
      }
    };
    if (this.toolNumber(name) !== undefined || this.helloSeen) return go();
    // the hello may still be on its way after pairing
    const limit = this.owner.config.callTimeoutMs || 10_000;
    await withTimeout(this.ready.promise, limit, "hello").catch(() => {});
    return go();
  }
}
