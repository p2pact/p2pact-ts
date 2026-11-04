import { test } from "node:test";
import assert from "node:assert/strict";
import { LevelRead, LevelWrite, type Grant } from "../src/index.js";
import {
  BadArgsError, DEFAULT_WANTS, FailedError, ForbiddenError, NoMethodError, NotDeliveredError, NotFoundError, ProtocolError, RpcError, Tools,
  PermissionRequest, QuestionRequest, type ChatUpdate, type JsonMap,
} from "../src/client/index.js";
import { typed } from "../src/client/errors.js";
import { P2PACTError } from "../src/index.js";
import { str } from "../src/client/support.js";
import { Fixtures, Harness } from "./client-util.js";

/** run starts a harness, runs the body and closes everything. */
async function run(body: (h: Harness) => Promise<void>) {
  const h = new Harness();
  try {
    await body(h);
  } finally {
    h.close();
  }
}

const sentIs = (h: Harness, method: string, fixture: string) => assert.deepEqual(h.sent(1, method), Fixtures.params("p2pact.chat", fixture), method);

test("pairing with wants: grants and state", () => run(async (h) => {
  const computer = await h.connect();
  assert.deepEqual(h.client.computers().map((c) => c.id), [computer.id]);
  assert.equal(computer.name, "MacBook Pro");
  assert.equal(computer.state, "online");
  assert.deepEqual(computer.grants, [...DEFAULT_WANTS]);
  assert.equal(computer.level(Tools.CHAT), LevelWrite);
  assert.equal(computer.level(Tools.PLUGINS), LevelRead);
  assert.equal(computer.canWrite(Tools.PLUGINS), false);
  // the engine knows us as a client
  assert.equal(h.engine.node.trust.get(h.engine.clientAddr)!.kind, 2);
}));

test("initialize and list", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const info = await chat.initialize();
  sentIs(h, "initialize", "initialize.request");
  assert.deepEqual(info.agents.map((a) => a.id), ["claude"]);
  assert.equal(info.agents[0].name, "Claude Code");
  assert.ok(info.loadSession);
  assert.ok(info.extensions);
  assert.equal(info.agentTitle, "MacBook Pro");

  const list = await chat.listSessions();
  sentIs(h, "session/list", "session.list.request");
  assert.equal(list.sessions.length, 1);
  const s = list.sessions[0];
  assert.equal(s.id, "s1");
  assert.equal(s.cwd, "/w/proj");
  assert.equal(s.agent, "claude");
  assert.equal(s.state, "working");
  assert.equal(s.updatedAt, "2026-11-03T10:00:00Z");
  assert.equal(list.nextCursor, undefined);
  assert.equal(s.raw.sessionId, "s1"); // the raw JSON stays reachable
  assert.deepEqual(chat.sessions, [s]);
}));

test("calls initialize first by themselves", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  await chat.listAllSessions();
  assert.deepEqual(h.engine.seen.map((s) => s.method), ["initialize", "session/list"]);
}));

test("new, prompt, cancel", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const created = await chat.newSession("/w/app", { agent: "codex", model: "gpt-5", text: "собери проект", perms: "ask", mid: "n1" });
  assert.equal(created.sessionId, "nomad-1");
  sentIs(h, "session/new", "session.new.request");

  const result = await chat.prompt("s1", "запусти тесты", "m1");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.duplicate, false);
  sentIs(h, "session/prompt", "session.prompt.request");

  const got = h.engine.fromClient.next();
  chat.cancel("s1");
  const n = await got;
  assert.equal(n.method, "session/cancel");
  assert.equal((n.params as JsonMap).sessionId, "s1");
}));

test("load gives the whole history", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const live: ChatUpdate[] = [];
  chat.updates.subscribe((u) => live.push(u));
  const loaded = await chat.loadSession("s1", "/w/proj");
  sentIs(h, "session/load", "session.load.request");
  assert.ok(loaded.older);
  // all three replayed messages are in the result, in order, though the answer may come first
  const u = loaded.updates;
  assert.equal(u.length, 3);
  const user = u[0];
  assert.ok(user.type === "user_message");
  assert.equal(user.text, "привет");
  assert.equal(user.seq, 1);
  const agent = u[1];
  assert.ok(agent.type === "agent_message");
  assert.equal(agent.text, "Привет! Чем помочь?");
  assert.equal(agent.seq, 2);
  assert.equal(agent.time, "2026-11-03T10:00:01Z");
  const tool = u[2];
  assert.ok(tool.type === "tool_call");
  assert.equal(tool.call.toolCallId, "m3");
  assert.equal(tool.call.title, "Bash: go test");
  assert.equal(tool.call.kind, "execute");
  assert.equal(tool.call.status, "completed");
  assert.equal(live.length, 3); // and they went to the listeners too
}));

test("live updates and changes", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const updates = chat.updates.next();
  const changes = chat.sessionChanges.next();
  h.engine.notify(1, Fixtures.read("p2pact.chat", "session.update.agent_message.notification"));
  h.engine.notify(1, Fixtures.read("p2pact.chat", "_p2pact.session_changed.notification"));
  const u = await updates;
  assert.ok(u.type === "agent_message");
  assert.equal(u.sessionId, "s1");
  assert.equal(u.text, "Привет! Чем помочь?");
  const s = await changes;
  assert.equal(s.id, "s1");
  assert.equal(s.state, "idle");
  assert.equal(s.agent, "claude");
  assert.equal(s.title, "proj");
  assert.deepEqual(chat.sessions.map((x) => x.id), ["s1"]);
  // closing removes it from the known chats
  const closed = chat.sessionChanges.next();
  h.engine.notify(1, { jsonrpc: "2.0", method: "_p2pact/session_changed", params: { sessionId: "s1", _meta: { p2pact: { state: "closed" } } } });
  assert.equal((await closed).state, "closed");
  assert.equal(chat.sessions.length, 0);
}));

test("events can be iterated", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const seen: string[] = [];
  const done = (async () => {
    for await (const u of chat.updates) {
      if (u.type === "agent_message") seen.push(u.text);
      if (seen.length === 2) break;
    }
  })();
  const m = Fixtures.read("p2pact.chat", "session.update.agent_message.notification");
  h.engine.notify(1, m);
  h.engine.notify(1, m);
  await done;
  assert.equal(seen.length, 2);
}));

test("unknown updates are kept raw", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const next = chat.updates.next();
  h.engine.notify(1, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "brand_new", x: 1, extra: ["y"] } } });
  const u = await next;
  assert.ok(u.type === "other");
  assert.equal(u.updateType, "brand_new");
  assert.equal(u.raw.x, 1);
}));

test("a permission request is answered", () => run(async (h) => {
  const computer = await h.connect();
  const seen: PermissionRequest[] = [];
  computer.chat.permissionHandler = (r) => { seen.push(r); return r.allow(); };
  const res = await h.engine.ask(1, Fixtures.read("p2pact.chat", "session.request_permission.request"), "s1");
  assert.deepEqual(res, Fixtures.read("p2pact.chat", "session.request_permission.response"));
  const r = seen[0];
  assert.equal(r.toolCall.title, "Bash: rm -rf build");
  assert.deepEqual(r.options.map((o) => o.optionId), ["allow", "always", "deny"]);
  assert.deepEqual(r.deny(), { outcome: "selected", optionId: "deny" });
}));

test("a question is answered", () => run(async (h) => {
  const computer = await h.connect();
  computer.chat.questionHandler = async (q) => {
    assert.equal(q.questions.length, 2);
    assert.equal(q.questions[0].header, "База");
    assert.deepEqual(q.questions[0].options.map((o) => o.label), ["Postgres", "SQLite"]);
    assert.equal(q.questions[0].options[0].description, "основная");
    assert.ok(q.questions[1].multi);
    return { "База?": "SQLite", "Что проверить?": QuestionRequest.join(["Тесты"]) };
  };
  const res = await h.engine.ask(1, Fixtures.read("p2pact.chat", "_p2pact.question.request"), "s1");
  assert.deepEqual(res, Fixtures.read("p2pact.chat", "_p2pact.question.response"));
}));

test("a request answered elsewhere ends", () => run(async (h) => {
  const computer = await h.connect();
  const shown: PermissionRequest[] = [];
  // the person never decides here
  computer.chat.permissionHandler = (r) => { shown.push(r); return new Promise(() => {}); };
  const answered = computer.chat.requestAnswered.next();
  const res = h.engine.ask(1, Fixtures.read("p2pact.chat", "session.request_permission.request"), "s1");
  while (!shown.length) await new Promise((r) => setTimeout(r, 5));
  h.engine.notify(1, Fixtures.read("p2pact.chat", "_p2pact.request_answered.notification"));
  assert.equal((await answered).toolCallId, "w1");
  await shown[0].answered;
  // the call does not hang: the computer got an error answer
  assert.ok((await res).error);
}));

test("without a handler the computer hears no such method", () => run(async (h) => {
  await h.connect();
  const res = await h.engine.ask(1, Fixtures.read("p2pact.chat", "session.request_permission.request"), "s1");
  assert.equal((res.error as JsonMap).code, -32601);
  const fs = await h.engine.ask(1, { jsonrpc: "2.0", method: "fs/read_text_file", params: { sessionId: "s1" } }, "s1");
  assert.equal((fs.error as JsonMap).code, -32601);
}));

test("extensions", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  await chat.close("s1");
  sentIs(h, "_p2pact/close", "_p2pact.close.request");
  await chat.restart("s1");
  await chat.hide("s1", true);
  assert.deepEqual(h.sent(1, "_p2pact/hide"), { sessionId: "s1", on: true });

  const page = await chat.older("s1", 3);
  sentIs(h, "_p2pact/older", "_p2pact.older.request");
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].seq, 1);
  assert.equal(page.messages[0].role, "user");
  assert.equal(page.messages[0].text, "привет");
  assert.equal(page.more, false);

  const diff = await chat.diff("s1");
  sentIs(h, "_p2pact/diff", "_p2pact.diff.request");
  assert.equal(diff.files[0].path, "a.go");
  assert.equal(diff.files[0].added, 3);
  assert.equal(diff.patch, "diff --git a/a.go b/a.go\n");
  assert.equal(diff.truncated, false);

  const image = await chat.image("s1", "/w/proj/shot.png");
  sentIs(h, "_p2pact/image", "_p2pact.image.request");
  assert.equal(image.error, "not_found");
  assert.equal(image.data, undefined);
}));

/** The fixture's answer as an engine older than the typed results sends it: only `lines`. */
const legacy = (name: string): JsonMap => {
  const m = Fixtures.read("p2pact.chat", name + ".response");
  return { jsonrpc: "2.0", result: { lines: (m.result as JsonMap).lines } };
};

for (const form of ["typed", "legacy"]) {
  test(`typed extension methods, ${form} result`, () => run(async (h) => {
    const chat = (await h.connect()).chat;
    if (form === "legacy") {
      for (const n of ["older", "commands", "files", "history", "projects", "agents", "image", "diff", "close", "restart", "hide", "history_open"]) {
        h.engine.overrides.set(`1:_p2pact/${n}`, () => legacy("_p2pact." + n));
      }
    }
    // the fake serves one image fixture per method: pick by the path asked
    h.engine.overrides.set("1:_p2pact/image", (p) => {
      const n = str(p, "path") === "/w/proj/ok.png" ? "_p2pact.image.data" : "_p2pact.image";
      return form === "legacy" ? legacy(n) : Fixtures.read("p2pact.chat", n + ".response");
    });
    await chat.initialize();
    sentIs(h, "initialize", "initialize.request");
    assert.equal(((h.sent(1, "initialize")._meta as JsonMap).p2pact as JsonMap).v, 2);

    const older = await chat.older("s1", 3);
    assert.deepEqual([older.messages.map((m) => m.text), older.more, older.run], [["привет"], false, "r1"]);

    const commands = await chat.commands("s1");
    sentIs(h, "_p2pact/commands", "_p2pact.commands.request");
    assert.deepEqual(commands, [{ name: "review", desc: "Review the changes", hint: "<pr>", args: [{ value: "main", desc: "base branch" }] }]);

    const files = await chat.files("s1", "fac");
    sentIs(h, "_p2pact/files", "_p2pact.files.request");
    assert.deepEqual([files.files, files.query], [["agent/pkg/acpchat/facade.go"], "fac"]);

    const hist = await chat.history("", 0);
    sentIs(h, "_p2pact/history", "_p2pact.history.request");
    assert.deepEqual([hist.items.map((i) => [i.id, i.agent, i.dir, i.title, i.updated, i.count]), hist.from, hist.total, hist.cursor, hist.partial],
      [[["h1", "claude", "/w/proj", "Fix the build", 1793700000000, 12]], 0, 2, form === "typed" ? 1 : undefined, undefined]);

    const projects = await chat.projects("/w/proj");
    sentIs(h, "_p2pact/projects", "_p2pact.projects.request");
    assert.deepEqual([projects.dirs, projects.projectDirs, projects.dirRepos],
      [["/w/proj"], { proj: ["/w/proj", "/w/proj-api"] }, { "/w/proj": "git@example.com:team/proj.git" }]);

    const agents = await chat.agents();
    assert.deepEqual(agents.agents, [{ id: "claude", name: "Claude Code", type: "claude", enabled: true, models: ["opus", "sonnet"], default: "sonnet" }]);
    assert.deepEqual(agents.presets.map((p) => [p.id, p.name]), [["p1", "Claude Sonnet"]]);

    const ok = await chat.image("s1", "/w/proj/ok.png");
    sentIs(h, "_p2pact/image", "_p2pact.image.data.request");
    assert.deepEqual([ok.mime, ok.error, ok.data?.startsWith("iVBOR")], form === "typed" ? ["image/png", undefined, true] : [undefined, undefined, true]);
    const bad = await chat.image("s1", "/w/proj/shot.png");
    assert.deepEqual([bad.error, bad.data, bad.path], ["not_found", undefined, "/w/proj/shot.png"]);

    const diff = await chat.diff("s1");
    assert.deepEqual([diff.files, diff.patch, diff.truncated], [[{ path: "a.go", added: 3, removed: 1, status: "M" }], "diff --git a/a.go b/a.go\n", false]);

    for (const r of [await chat.close("s1"), await chat.restart("s1"), await chat.hide("s1", false), await chat.historyOpen("h1")]) {
      assert.deepEqual([r.ok, r.error], [true, undefined]);
    }
    sentIs(h, "_p2pact/history_open", "_p2pact.history_open.request");
    assert.deepEqual(h.sent(1, "_p2pact/hide"), { sessionId: "s1", on: false });
  }));
}

test("a failed write reports ok false", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  h.engine.overrides.set("1:_p2pact/restart", () => ({ jsonrpc: "2.0", result: { ok: false, error: "not ours", lines: [] } }));
  h.engine.overrides.set("1:_p2pact/close", () => ({ jsonrpc: "2.0", result: { lines: [{ cmd: "alert", id: "s1", text: "boom" }] } }));
  const r = await chat.restart("s1");
  assert.deepEqual([r.ok, r.error], [false, "not ours"]);
  const c = await chat.close("s1");
  assert.deepEqual([c.ok, c.error], [false, "boom"]);
}));

test("late reports", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  const next = chat.reports.next();
  h.engine.notify(1, Fixtures.read("p2pact.chat", "_p2pact.report.notification"));
  assert.equal((await next).cmd, "diff_more");
}));

test("read-only grant refuses writes with ForbiddenError", () => run(async (h) => {
  const decide = (): Grant[] => [{ tool: Tools.CHAT, level: LevelRead }, { tool: Tools.FLEET, level: LevelRead }];
  const computer = await h.connect(DEFAULT_WANTS, decide);
  assert.equal(computer.level(Tools.CHAT), LevelRead);
  assert.equal(computer.canWrite(Tools.CHAT), false);
  const chat = computer.chat;
  // reading works
  assert.equal((await chat.listSessions()).sessions.length, 1);
  await chat.loadSession("s1", "/w/proj");
  // writing is the P2PACT error 4, not a JSON-RPC error
  for (const write of [() => chat.newSession("/w/app"), () => chat.prompt("s1", "x"), () => chat.close("s1")]) {
    await assert.rejects(write(), (e: unknown) => e instanceof ForbiddenError && e.code === 4);
  }
  // the refused calls did not reach the tool's handler as writes
  assert.ok(h.engine.seen.every((s) => !(s.method === "session/prompt" && s.level >= LevelWrite)));
}));

test("error codes are typed", () => {
  const cls = [[1, NoMethodError], [2, BadArgsError], [3, NotFoundError], [4, ForbiddenError], [5, FailedError], [6, NotDeliveredError]] as const;
  for (const [code, c] of cls) {
    const t = typed(new P2PACTError(code, "x"));
    assert.ok(t instanceof c);
    assert.equal((t as ProtocolError).code, code);
  }
  assert.equal((typed(new P2PACTError(99, "?")) as ProtocolError).code, 99);
});

test("JSON-RPC errors are RpcErrors", () => run(async (h) => {
  const chat = (await h.connect()).chat;
  h.engine.overrides.set("1:session/list", () => ({ jsonrpc: "2.0", error: { code: -32601, message: "nope", data: "d" } }));
  await assert.rejects(chat.listSessions(), (e: unknown) => e instanceof RpcError && e.isMethodNotFound && e.message === "nope" && e.data === "d");
}));
