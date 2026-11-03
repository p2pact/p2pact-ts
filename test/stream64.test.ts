import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "../src/index.js";
import { close, eventually, node, pair } from "./util.js";

// A chat's stream is the 64-bit hash of its id: beyond 2^53 it must stay exact on the wire, and
// calls and events of one such stream run in the order sent.
test("streams beyond 2^53 are exact and ordered", async () => {
  const a = await node("A"), b = await node("B");
  try {
    await pair(a, b);
    const big = 0xfedcba9876543210n;
    const got: number[] = [];
    b.onEvent = (_peer, _tool, _ev, args) => void got.push(decode(args[0]) as number);
    for (let i = 0; i < 20; i++) a.eventOn(b.id.addr, big, 64, 1, i);
    const res = await a.callOn(b.id.addr, big, 64, 1, 7);
    assert.equal(decode(res[0]), 7);
    await eventually("events arrived", () => got.length === 20);
    assert.deepEqual(got, [...Array(20).keys()]);
  } finally {
    close(a, b);
  }
});
