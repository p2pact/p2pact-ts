import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode, KindClient, KindComputer, KindPlugin, KindUnknown } from "../src/index.js";
import { parsePair } from "../src/node.js";
import { hintsToWire } from "../src/store.js";
import { close, echo, eventually, node, pair } from "./util.js";

// The kind goes in the pairing payload and the hello, and is stored in trust on both sides.
test("kind in pairing and hello", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    a.kind = KindComputer;
    b.kind = KindClient;
    await pair(a, b);
    await eventually("kinds in trust", () => a.trust.get(b.id.addr)?.kind === KindClient && b.trust.get(a.id.addr)?.kind === KindComputer);
    // a later change of kind arrives with the next hello
    b.kind = KindPlugin;
    (b as any).sendInfo(a.id.addr);
    await eventually("kind from a new hello", () => a.trust.get(b.id.addr)?.kind === KindPlugin);
  } finally {
    close(a, b);
  }
});

// Older devices send a payload and a hello without the kind: they keep working, kind 0.
test("kind: older peers", async () => {
  const a = await node("Mac"), b = await node("Old");
  try {
    const hints = hintsToWire({ udp: ["1.2.3.4:5"] });
    const old = parsePair(encode(["Old", 7, hints, new Uint8Array([1]), "linux"]));
    assert.deepEqual([old.name, old.boot, old.os, old.kind, old.hints.udp?.length], ["Old", 7, "linux", KindUnknown, 1]);
    // a newer payload with fields we do not know yet is read too
    const newer = parsePair(encode(["New", 7, hintsToWire({}), new Uint8Array([1]), "linux", KindClient, [["*", 1]], "future"]));
    assert.deepEqual([newer.kind, newer.name], [KindClient, "New"]);
    // a node that does not say its kind sends the old payload
    assert.equal((decode((a as any).pairPayload()) as unknown[]).length, 5);
    b.kind = KindClient;
    await pair(a, b);
    await eventually("kind", () => a.trust.get(b.id.addr)?.kind === KindClient);
    // an old hello (nine fields, no kind) changes nothing but the usual
    (a as any).message(b.id.addr, encode([3, 0, 2, "Old", "linux", "old-impl", new Map(), [], hints]), 0);
    const p = a.trust.get(b.id.addr)!;
    assert.deepEqual([p.name, p.kind], ["Old", KindClient]);
    await echo(a, b, new TextEncoder().encode("still works"));
  } finally {
    close(a, b);
  }
});
