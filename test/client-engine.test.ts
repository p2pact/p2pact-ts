// The client SDK against the real Nomad Code engine (Go, `agent/cmd/nomadcode`, TestAppE2E): the
// engine runs as a `go test` process on 127.0.0.1 with a random port, nothing of the user's engine
// is touched. Only with P2PACT_ENGINE_E2E=<path to nomad-code/agent> (Go is needed).
//
// The engine and the app talk through files in NOMAD_APP_E2E: the engine writes `invite`,
// `decision`, `ready` (its Stop hook waits for the app), `stop` and `perm` (what the hooks got);
// the app writes `done`. NOMAD_APP_E2E_DECIDE is what the engine's "person" grants: yes | read | no.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LevelRead, LevelWrite } from "../src/index.js";
import { ForbiddenError, P2pactClient, Tools, type FleetEvent, type PermissionRequest } from "../src/client/index.js";
import { eventually, sleep } from "./util.js";

const agent = process.env.P2PACT_ENGINE_E2E;
const skip = agent ? false : "P2PACT_ENGINE_E2E is not set";

class Engine {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-e2e-"));
  private log = "";
  private proc: ChildProcess;
  private exited: Promise<number | null>;

  constructor(decide: string) {
    this.proc = spawn("go", ["test", "-count=1", "-v", "-run", "^TestAppE2E$", "./cmd/nomadcode"], {
      cwd: agent,
      env: { ...process.env, NOMAD_APP_E2E: this.dir, NOMAD_APP_E2E_DECIDE: decide },
    });
    this.proc.stdout!.on("data", (d) => (this.log += d));
    this.proc.stderr!.on("data", (d) => (this.log += d));
    this.exited = new Promise((r) => this.proc.on("exit", (code) => r(code)));
  }

  tail(n = 3000) {
    return this.log.slice(-n);
  }

  async waitFile(name: string, ms = 120_000): Promise<string> {
    const end = Date.now() + ms;
    const f = path.join(this.dir, name);
    while (Date.now() < end) {
      if (fs.existsSync(f) && fs.statSync(f).size > 0) return fs.readFileSync(f, "utf8");
      await sleep(50);
    }
    assert.fail(`no file ${name} from the engine: ${this.tail()}`);
  }

  async finish() {
    fs.writeFileSync(path.join(this.dir, "done"), "ok");
    const code = await Promise.race([this.exited, sleep(60_000).then(() => "timeout" as const)]);
    assert.equal(code, 0, `the engine did not finish: ${this.tail(2000)}`);
  }

  close() {
    this.proc.kill();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const wants = [{ tool: Tools.CHAT, level: LevelWrite }, { tool: Tools.FLEET, level: LevelRead }];

const app = () => P2pactClient.open(fs.mkdtempSync(path.join(os.tmpdir(), "app-e2e-client-")), "E2E app", { udp: "127.0.0.1:0", tcp: null });

test("an app against the engine", { skip, timeout: 240_000 }, async () => {
  const engine = new Engine("yes");
  const client = await app();
  try {
    const computer = await client.pair(await engine.waitFile("invite"), wants, 60_000);
    await computer.whenOnline();
    assert.equal(await engine.waitFile("decision"), "approved");
    // the decision is the person's; the grants reach the app by event 0.6 a moment later
    await eventually("write level on the chat", () => computer.level(Tools.CHAT) === LevelWrite);

    const chat = computer.chat;
    assert.ok((await chat.initialize()).loadSession);
    const list = (await chat.listSessions()).sessions;
    assert.deepEqual(list.map((s) => s.id), ["s1"]);

    // history
    const loaded = await chat.loadSession("s1");
    const texts = loaded.updates.flatMap((u) => (u.type === "user_message" ? ["u:" + u.text] : u.type === "agent_message" ? ["a:" + u.text] : []));
    assert.ok(texts.includes("u:привет") && texts.includes("a:Готово"), texts.join(","));

    // fleet: read
    const fleet = computer.fleet;
    assert.deepEqual((await fleet.sessions()).map((s) => s.id), ["s1"]);
    const events: FleetEvent[] = [];
    fleet.events.subscribe((e) => events.push(e));
    await fleet.watch();

    // the permission handler answers the engine's question
    const asked: PermissionRequest[] = [];
    chat.permissionHandler = (r) => { asked.push(r); return r.allow(); };

    // the prompt answers the Stop hook
    await engine.waitFile("ready");
    const prompt = chat.prompt("s1", "из приложения");
    assert.ok((await engine.waitFile("stop")).includes("из приложения"));
    await eventually("a permission request", () => asked.length > 0);
    assert.equal(asked[0].sessionId, "s1");
    assert.ok((await engine.waitFile("perm")).includes('"behavior":"allow"'));
    // the turn ends once the permission is answered and the agent is idle again
    assert.equal((await prompt).stopReason, "end_turn");

    // the fleet watch event about the finished turn
    await eventually("a fleet event with the agent's reply", () => events.some((e) => e.type === "messages" && e.id === "s1" && e.messages.some((m) => m.text === "Сделано")));

    // fleet is read-only for us
    await assert.rejects(fleet.send("s1", "нельзя"), ForbiddenError);
    await engine.finish();
  } catch (e) {
    console.error("engine log:\n" + engine.tail());
    throw e;
  } finally {
    client.close();
    engine.close();
  }
});

test("a read-only decision forbids prompt", { skip, timeout: 240_000 }, async () => {
  const engine = new Engine("read");
  const client = await app();
  try {
    const computer = await client.pair(await engine.waitFile("invite"), wants, 60_000);
    await computer.whenOnline();
    assert.equal(await engine.waitFile("decision"), "read");
    await eventually("read level on the chat", () => computer.level(Tools.CHAT) === LevelRead);
    assert.deepEqual((await computer.chat.listSessions()).sessions.map((s) => s.id), ["s1"]);
    await assert.rejects(computer.chat.prompt("s1", "нельзя"), ForbiddenError);
    await engine.finish();
  } catch (e) {
    console.error("engine log:\n" + engine.tail());
    throw e;
  } finally {
    client.close();
    engine.close();
  }
});
