// Tool 5 p2pact.term and the rule "Former names" (core spec §8, §8.1; as p2pact-go).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, ErrForbidden, ErrNoMethod, fixedTool, FirstNamedTool, LevelRead, LevelWrite, P2PACTError, type ToolHandler } from "../src/index.js";
import { close, code, eventually, node, pair, sleep } from "./util.js";

const FORMER = "com.example.term";

const served = (name: string): ToolHandler => (_peer, level, method) => {
  if (method !== 1 && level < LevelWrite) throw new P2PACTError(ErrForbidden, "read only");
  return [name];
};

const nameOf = async (p: Promise<Uint8Array[]>) => decode((await p)[0]);

// A tool of the spec served by the application under its fixed number, announced in {tool:
// version}; the node checks read, the handler the rest; it leaves the hello when taken back.
test("a fixed tool served by the application", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    assert.equal(fixedTool("p2pact.term"), 5);
    assert.equal(fixedTool("com.example.x"), undefined);
    assert.throws(() => a.registerTool("p2pact.term", 1), "a name of the spec was registered as a named tool");
    await pair(a, b);
    const addr = a.id.addr, me = b.id.addr;
    a.handleToolAll("p2pact.term", served("term"));
    await eventually("term in the hello", () => b.peerHasTool(addr, "p2pact.term"));
    assert.deepEqual(b.peerTools(addr), [], "a tool of the spec went into the named map");
    assert.deepEqual(b.resolveTool(addr, "p2pact.term"), { number: 5, called: "p2pact.term" });
    const call = (m: number) => code(b.callTool(addr, "p2pact.term", m));
    assert.equal(await call(1), 0);
    a.setGrants(me, [{ tool: "p2pact.term", level: LevelRead }]);
    assert.equal(await call(1), 0, "read");
    assert.equal(await call(2), ErrForbidden, "write at read");
    a.setGrants(me, [{ tool: "p2pact.chat", level: LevelWrite }]);
    assert.equal(await call(1), ErrForbidden, "no grant on term");
    a.unregisterTool("p2pact.term");
    await eventually("term gone from the hello", () => !b.peerHasTool(addr, "p2pact.term"));
  } finally {
    close(a, b);
  }
});

// One tool under the spec's name and a former one: the highest level on either name counts for
// both, for calls and for events; each name answers under its own number.
test("alias rights: both names, read does not give write", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    assert.throws(() => a.aliasTool("p2pact.chat", "p2pact.term"), "a name of the spec taken as an alias");
    assert.throws(() => a.aliasTool(FORMER, FORMER), "a tool its own alias");
    a.aliasTool(FORMER, "p2pact.term");
    a.handleToolAll("p2pact.term", served("p2pact.term"));
    a.handleToolAll(FORMER, served(FORMER));
    const events: number[] = [];
    b.onEvent = (_p, tool) => void events.push(tool);
    await pair(a, b);
    const addr = a.id.addr, me = b.id.addr;
    await eventually("both names", () => b.peerHasTool(addr, "p2pact.term") && b.peerHasTool(addr, FORMER));
    const alias = b.toolNumber(addr, FORMER)!;
    assert.ok(alias >= FirstNamedTool);
    const cases: [{ tool: string; level: number }[], number][] = [
      [[{ tool: FORMER, level: LevelWrite }], LevelWrite],
      [[{ tool: "p2pact.term", level: LevelWrite }], LevelWrite],
      [[{ tool: "p2pact.term", level: LevelRead }, { tool: FORMER, level: LevelWrite }], LevelWrite],
      [[{ tool: FORMER, level: LevelRead }], LevelRead],
      [[{ tool: "p2pact.chat", level: LevelWrite }], 0],
    ];
    for (const [grants, level] of cases) {
      a.setGrants(me, grants);
      for (const name of ["p2pact.term", FORMER]) {
        assert.equal(a.level(me, name), level, `${JSON.stringify(grants)}: level on ${name}`);
        assert.equal((await code(b.callTool(addr, name, 1))) === 0, level >= LevelRead, `read on ${name}`);
        assert.equal((await code(b.callTool(addr, name, 2))) === 0, level >= LevelWrite, `write on ${name}`);
      }
      events.length = 0;
      a.event(me, 5, 3);
      a.event(me, alias, 3);
      await sleep(level >= LevelRead ? 0 : 200);
      if (level >= LevelRead) await eventually("events", () => events.length >= 2);
      assert.deepEqual(events, level >= LevelRead ? [5, alias] : [], `${JSON.stringify(grants)}: events`);
    }
    // an answer comes under the name the caller used
    a.setGrants(me, [{ tool: "p2pact.term", level: LevelWrite }]);
    assert.equal(await nameOf(b.callTool(addr, "p2pact.term", 1)), "p2pact.term");
    assert.equal(await nameOf(b.callTool(addr, FORMER, 1)), FORMER);
    assert.equal(b.peerToolName(addr, 5), "p2pact.term", "an event under 5 is p2pact.term");
    assert.equal(b.peerToolName(addr, alias), FORMER);
  } finally {
    close(a, b);
  }
});

// An old device (the terminal only under its former name) and a new one (both) talk both ways.
test("alias: old and new devices", async () => {
  const old = await node("Old"), nw = await node("New"), phone = await node("Phone");
  try {
    const answer = (who: string): ToolHandler => () => [who];
    old.handleToolAll(FORMER, answer("old"));
    nw.aliasTool(FORMER, "p2pact.term");
    nw.handleToolAll("p2pact.term", answer("new:5"));
    nw.handleToolAll(FORMER, answer("new:alias"));
    phone.aliasTool(FORMER, "p2pact.term"); // a new caller
    await pair(nw, old);
    await pair(phone, old);
    await pair(phone, nw);
    const [o, n] = [old.id.addr, nw.id.addr];
    await eventually("hellos", () => phone.peerHasTool(o, FORMER) && phone.peerHasTool(n, "p2pact.term") && old.peerHasTool(n, FORMER) && nw.peerHasTool(o, FORMER));
    assert.equal(phone.peerHasTool(o, "p2pact.term"), false, "the old device announced 5");
    const r = phone.resolveTool(o, "p2pact.term")!;
    assert.ok(r.number >= FirstNamedTool && r.called === FORMER, "new -> old goes by the former name");
    assert.deepEqual(phone.resolveTool(n, "p2pact.term"), { number: 5, called: "p2pact.term" }, "new -> new goes to 5");
    assert.equal(phone.resolveTool(n, FORMER)!.called, FORMER, "by the alias itself");
    nw.setGrants(o, [{ tool: "p2pact.term", level: LevelWrite }]); // an old caller, granted the new name
    assert.equal(await nameOf(phone.callTool(o, "p2pact.term", 1)), "old");
    assert.equal(await nameOf(phone.callTool(n, "p2pact.term", 1)), "new:5");
    assert.equal(await nameOf(nw.callTool(o, "p2pact.term", 1)), "old");
    assert.equal(await nameOf(old.callTool(n, FORMER, 1)), "new:alias");
    // without the alias declared the old device cannot reach the new name; an unknown tool is error 1
    assert.equal(await code(old.callTool(phone.id.addr, "com.example.none", 1)), ErrNoMethod);
  } finally {
    close(old, nw, phone);
  }
});
