import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { AllTools, allowed, defaultGrants, ErrForbidden, P2PACTError, grantLevel, LevelRead, LevelWrite, Node, Trust, type Grant } from "../src/index.js";
import { parseGrants } from "../src/grants.js";
import { decode } from "../src/index.js";
import { close, code, echo, eventually, node, pair, sleep, tmp } from "./util.js";

test("grant level", () => {
  const g: Grant[] = [{ tool: "com.a.x", level: LevelRead }, { tool: "com.a.y", level: LevelWrite }];
  const want: Record<string, number> = { "com.a.x": 1, "com.a.y": 2, "com.a.z": 0, "": 0 };
  for (const [tool, level] of Object.entries(want)) assert.equal(grantLevel(g, tool), level, tool);
  assert.equal(grantLevel(undefined, "any"), LevelWrite, "undefined is the default");
  assert.equal(grantLevel([], "any"), 0, "an empty list grants nothing");
  assert.equal(grantLevel([{ tool: AllTools, level: LevelRead }, { tool: "com.a.x", level: LevelWrite }], "com.a.x"), LevelWrite, "the highest entry wins");
});

// Devices whose grants were never set (every device paired before grants) use everything.
test("grants default", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    await pair(a, b);
    assert.deepEqual(a.grants(b.id.addr), defaultGrants());
    await echo(b, a, new TextEncoder().encode("as before"));
    // a trust file from before grants has no such field
    const dir = tmp();
    const list = a.trust.list().map((p) => ({ addr: p.addr, key: Buffer.from(p.key).toString("base64"), name: p.name,
      pair_secret: Buffer.from(p.pairSecret).toString("base64"), hints: p.hints, added: p.added }));
    fs.writeFileSync(path.join(dir, "net-peers.json"), JSON.stringify(list));
    const p = new Trust(dir).get(b.id.addr);
    assert.ok(p && p.grants === undefined);
    assert.deepEqual(allowed(p), defaultGrants());
    // a file written by the Go library has "grants": null
    fs.writeFileSync(path.join(dir, "net-peers.json"), JSON.stringify(list.map((x) => ({ ...x, grants: null }))));
    assert.equal(new Trust(dir).get(b.id.addr)!.grants, undefined);
  } finally {
    close(a, b);
  }
});

test("grants persist", async () => {
  const dir = tmp();
  const a = new Node(dir, "Mac");
  await a.listenUDP("127.0.0.1:0");
  a.start();
  const b = await node("Phone");
  try {
    await pair(a, b);
    const want: Grant[] = [{ tool: "com.a.x", level: LevelRead }];
    a.setGrants(b.id.addr, want);
    assert.deepEqual(allowed(new Trust(dir).get(b.id.addr)!), want);
    a.revokeGrants(b.id.addr);
    const p = new Trust(dir).get(b.id.addr)!;
    assert.ok(p.grants && allowed(p).length === 0, "revoked grants come back as the default");
    assert.throws(() => a.setGrants("nobody", want), "grants for a stranger");
  } finally {
    close(a, b);
  }
});

// A call outside the grants is error 4; read methods need read, the rest write; tool 0 is always allowed.
test("grants are enforced", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    const ok = () => ["ok"];
    a.handleTool("com.acme.notes", 1, ok); // write
    a.handleTool("com.acme.notes", 2, ok); // read
    a.handleTool("com.acme.mail", 1, ok);
    a.markRead(a.registerTool("com.acme.notes", 1), 2);
    await pair(a, b);
    const addr = a.id.addr, me = b.id.addr;
    const call = (tool: string, method: number) => code(b.callTool(addr, tool, method));
    await eventually("hello", () => b.toolNumber(addr, "com.acme.notes") !== undefined);
    assert.equal(await call("com.acme.notes", 1), 0, "the default allows everything");
    assert.equal(await call("com.acme.mail", 1), 0);
    a.setGrants(me, [{ tool: "com.acme.notes", level: LevelRead }]);
    await sleep(0);
    assert.equal(await call("com.acme.notes", 2), 0, "read method at read");
    assert.equal(await call("com.acme.notes", 1), ErrForbidden, "write method at read");
    assert.equal(await call("com.acme.mail", 1), ErrForbidden, "a tool outside the grants");
    assert.equal(await code(b.call(addr, 64, 1, new Uint8Array([1]))), ErrForbidden, "an unnamed tool without *");
    assert.equal(await code(b.call(addr, 0, 1)), 0, "ping");
    a.grant(me, "com.acme.notes", LevelWrite);
    assert.equal(await call("com.acme.notes", 1), 0, "write after widening");
    a.revokeGrants(me);
    assert.equal(await call("com.acme.notes", 2), ErrForbidden, "after revoking");
    a.setGrants(me, [{ tool: AllTools, level: LevelRead }]);
    assert.deepEqual([await call("com.acme.mail", 1), await call("com.acme.notes", 2)], [ErrForbidden, 0], "* at read");
  } finally {
    close(a, b);
  }
});

// A tool whose one method carries many checks the level itself.
test("level handlers", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    a.handleLevel(1, 1, (_peer, level, args) => {
      const m = decode(args[0]) as string;
      if (m !== "session/list" && level < LevelWrite) throw new P2PACTError(ErrForbidden, "read only");
      return [m];
    });
    await pair(a, b);
    const tools = (a as any).info(b.id.addr)[3] as Map<number, number>;
    assert.equal(tools.get(1), 1, "a tool with a level handler is missing from the hello");
    const addr = a.id.addr;
    a.setGrants(b.id.addr, [{ tool: "p2pact.chat", level: LevelRead }]);
    assert.equal(await code(b.call(addr, 1, 1, "session/list")), 0, "read");
    assert.equal(await code(b.call(addr, 1, 1, "session/prompt")), ErrForbidden, "write at read");
    a.setGrants(b.id.addr, [{ tool: "p2pact.chat", level: LevelWrite }]);
    assert.equal(await code(b.call(addr, 1, 1, "session/prompt")), 0, "write");
    a.setGrants(b.id.addr, []);
    assert.equal(await code(b.call(addr, 1, 1, "session/list")), ErrForbidden, "no grant");
  } finally {
    close(a, b);
  }
});

// Events of a tool go only to devices with at least read on it; the device is told its grants (0.6).
test("events need read; the device is told its grants", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    const events: string[] = [];
    const told: Grant[][] = [];
    b.onEvent = (_p, _t, _e, args) => void events.push(decode(args[0]) as string);
    b.onGranted = (_p, g) => void told.push(g);
    const num = a.registerTool("com.acme.feed", 1);
    await pair(a, b);
    const addr = a.id.addr, me = b.id.addr;
    a.event(me, num, 1, "everyone");
    await eventually("event", () => events.length === 1);
    assert.equal(events[0], "everyone");
    a.setGrants(me, [{ tool: "com.acme.other", level: LevelWrite }]);
    await eventually("event 0.6", () => told.length > 0);
    assert.deepEqual(told.at(-1), [{ tool: "com.acme.other", level: LevelWrite }]);
    assert.deepEqual(b.grantedBy(addr), [{ tool: "com.acme.other", level: LevelWrite }]);
    a.event(me, num, 1, "hidden"); // no read: not sent
    await sleep(300);
    a.grant(me, "com.acme.feed", LevelRead);
    a.event(me, num, 1, "visible");
    await eventually("visible", () => events.length === 2);
    assert.equal(events[1], "visible"); // "hidden" never came
    // method 0.6: what the caller may use
    const res = await b.call(addr, 0, 6);
    assert.equal(res.length, 1);
    assert.deepEqual(parseGrants(decode(res[0])), [{ tool: "com.acme.other", level: LevelWrite }, { tool: "com.acme.feed", level: LevelRead }]);
  } finally {
    close(a, b);
  }
});
