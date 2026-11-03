import { test } from "node:test";
import assert from "node:assert/strict";
import { LevelRead, type Grant } from "../src/index.js";
import { ForbiddenError, RpcError, type FleetEvent } from "../src/client/index.js";
import { DEFAULT_WANTS } from "../src/client/index.js";
import { eventually } from "./util.js";
import { Fixtures, Harness } from "./client-util.js";

const ID = "0b7c2e64-1d2a-4f5e-9a10-6c3b8d7e9f01";

async function run(body: (h: Harness) => Promise<void>) {
  const h = new Harness();
  try {
    await body(h);
  } finally {
    h.close();
  }
}

const sentIs = (h: Harness, method: string, fixture: string) => assert.deepEqual(h.sent(2, method), Fixtures.params("p2pact.fleet", fixture), method);

test("fleet read methods", () => run(async (h) => {
  const fleet = (await h.connect()).fleet;
  const hello = await fleet.hello();
  assert.equal(hello.protocol, "0.2");
  assert.equal(hello.node.name, "MacBook Pro");
  assert.equal(hello.node.os, "darwin");
  assert.equal(hello.node.agents[0].id, "claude");
  assert.equal(hello.node.status.working, 1);
  assert.equal((await fleet.node()).name, "MacBook Pro");

  const s = (await fleet.sessions())[0];
  assert.equal(s.id, ID);
  assert.equal(s.agent, "claude");
  assert.equal(s.dir, "/Users/me/app");
  assert.equal(s.phase, "working");
  assert.equal(s.title, "Починить вход");
  assert.equal(s.updated, "2026-10-27T10:00:00Z");
  assert.equal(((s.raw.status as any).owner as any).node, "3f2a9c01d4e5b6a7");
  assert.equal((await fleet.session(ID)).id, ID);
  sentIs(h, "session/get", "session-get.request");

  const m = await fleet.messages(ID, { after: 2 });
  sentIs(h, "session/messages", "session-messages.request");
  assert.equal(m.last, 3);
  assert.ok(m.older);
  assert.equal(m.messages[0].text, "Готово");
  assert.equal(m.messages[0].role, "assistant");
}));

test("watch delivers events in order", () => run(async (h) => {
  const fleet = (await h.connect()).fleet;
  const events: FleetEvent[] = [];
  fleet.events.subscribe((e) => events.push(e));
  const watch = await fleet.watch(false);
  sentIs(h, "fleet/watch", "watch.request");
  assert.equal(watch.sessions[0].id, ID);

  for (const n of ["notify-session-changed", "notify-session-messages", "notify-notify"]) h.engine.notify(2, Fixtures.read("p2pact.fleet", n));
  h.engine.notify(2, { jsonrpc: "2.0", method: "session/resync", params: { id: ID } });
  h.engine.notify(2, { jsonrpc: "2.0", method: "something/new", params: { k: 1 } });
  await eventually("five events", () => events.length === 5);
  const [changed, msgs, notify, resync, other] = events;
  assert.ok(changed.type === "sessions");
  assert.equal(changed.sessions[0].phase, "working");
  assert.ok(msgs.type === "messages");
  assert.equal(msgs.id, ID);
  assert.equal(msgs.messages[0].seq, 4);
  assert.equal(msgs.messages[0].text, "Продолжай");
  assert.ok(notify.type === "notify");
  assert.equal(notify.text, "Агент ждёт ответа");
  assert.ok(resync.type === "resync");
  assert.equal(resync.id, ID);
  assert.ok(other.type === "other");
  assert.equal(other.method, "something/new");

  await watch.close();
  assert.ok(h.engine.seen.some((s) => s.method === "fleet/unwatch"));
}));

test("fleet write methods", () => run(async (h) => {
  const fleet = (await h.connect()).fleet;
  const s = await fleet.create({ agent: "claude", dir: "/Users/me/app", perms: "ask" }, "Почини вход");
  sentIs(h, "session/create", "session-create.request");
  assert.equal(s.phase, "starting");

  await fleet.send(ID, "Продолжай");
  sentIs(h, "session/send", "session-send.request");

  await assert.rejects(fleet.send("нет", "?"), (e: unknown) => e instanceof RpcError && e.isNoSuchResource && e.code === -32004);

  assert.deepEqual(await fleet.setSettings({ sleep_after: 15 }), { sleep_after: 15 });
  sentIs(h, "settings/set", "settings-set.request");

  await fleet.answer(ID, { waitId: "w1", answers: { Q: "A" } });
  assert.deepEqual(h.sent(2, "session/answer"), { id: ID, waitId: "w1", answers: { Q: "A" } });
  await fleet.interrupt(ID);
  assert.equal((await fleet.close(ID)).warning, undefined);
  await fleet.setKeep(ID, true);
  assert.deepEqual(h.sent(2, "session/setKeep"), { id: ID, on: true });
}));

test("a read-only fleet refuses writes", () => run(async (h) => {
  const computer = await h.connect(DEFAULT_WANTS, (): Grant[] => [{ tool: "p2pact.fleet", level: LevelRead }]);
  const fleet = computer.fleet;
  assert.equal((await fleet.sessions()).length, 1);
  for (const write of [() => fleet.send(ID, "x"), () => fleet.create({ agent: "claude" }), () => fleet.interrupt(ID)]) {
    await assert.rejects(write(), ForbiddenError);
  }
  // no grant on the chat at all: even reading is refused
  await assert.rejects(computer.chat.listSessions(), ForbiddenError);
}));
