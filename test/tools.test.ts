import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode, FirstNamedTool, validToolName } from "../src/index.js";
import { hintsToWire } from "../src/store.js";
import { close, echo, eventually, node, pair } from "./util.js";

test("valid tool names", () => {
  const want: Record<string, boolean> = { "com.example.jira": true, "org.a-b.c1": true, jira: false, "": false,
    "Com.example": false, "com..x": false, "p2pact.chat": false, "com.-x": false };
  for (const [name, ok] of Object.entries(want)) assert.equal(validToolName(name), ok, name);
});

// A name gets a number of the device's own, from 64 up, not one a tool already has; the same name
// on another device may have another number, and callers resolve it by name.
test("named tools are numbered per device", async () => {
  const a = await node("Mac"), b = await node("Phone"); // both have the echo at 64
  try {
    const reg = (n: typeof a, name: string) => {
      const num = n.registerTool(name, 3);
      assert.ok(num >= FirstNamedTool && num !== 64, `${name}: ${num}`);
      assert.equal(n.registerTool(name, 3), num, "the number changed");
      n.handleTool(name, 1, () => [n.name + ":" + name]);
    };
    reg(a, "com.acme.one");
    reg(a, "com.acme.two");
    reg(b, "com.acme.two");
    reg(b, "com.acme.one");
    assert.throws(() => a.registerTool("jira", 1), "a bad name was taken");
    assert.throws(() => a.registerTool("p2pact.chat", 1), "a name of the spec was taken");
    await pair(a, b);
    await eventually("hellos", () => a.toolNumber(b.id.addr, "com.acme.one") !== undefined && b.toolNumber(a.id.addr, "com.acme.one") !== undefined);
    const na = a.toolNumber(b.id.addr, "com.acme.one"); // b's number
    const nb = b.toolNumber(a.id.addr, "com.acme.one"); // a's number
    assert.notEqual(na, nb, "the numbers should differ per device");
    assert.equal(a.toolNumber(b.id.addr, "p2pact.chat"), 1);
    for (const [from, to, name] of [[a, b, "com.acme.one"], [a, b, "com.acme.two"], [b, a, "com.acme.one"]] as const) {
      const res = await from.callTool(to.id.addr, name, 1);
      assert.equal(decode(res[0]), to.name + ":" + name);
    }
    assert.equal(a.peerToolName(b.id.addr, na!), "com.acme.one");
    assert.equal(a.toolName(nb!), "com.acme.one");
    await assert.rejects(a.callTool(b.id.addr, "com.acme.none", 1), "an unannounced tool was called");
    // a tool registered after the session is up reaches the other side at once
    a.registerTool("com.acme.late", 1);
    await eventually("late tool", () => b.toolNumber(a.id.addr, "com.acme.late") !== undefined);
  } finally {
    close(a, b);
  }
});

// A hello without the named map (an older device) names nothing; its numbered tools work as before.
test("named tools: an old hello", async () => {
  const a = await node("Mac"), b = await node("Old");
  try {
    await pair(a, b);
    (a as any).message(b.id.addr, encode([3, 0, 2, "Old", "linux", "old-impl", new Map([[64, 1]]), [], hintsToWire({})]), 0);
    assert.equal(a.toolNumber(b.id.addr, "com.acme.one"), undefined, "an old hello named a tool");
    await echo(a, b, new TextEncoder().encode("numbered"));
  } finally {
    close(a, b);
  }
});
