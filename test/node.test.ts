import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decode, encode, decodeArrayRaw, Invite, Node, P2PACTError, ErrNoMethod } from "../src/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-ts-"));

async function node(name: string, roads: { udp?: boolean; tcp?: string }): Promise<Node> {
  const n = new Node(tmp(), name);
  if (roads.udp) await n.listenUDP("127.0.0.1:0");
  if (roads.tcp !== undefined) await n.listenTCP(roads.tcp);
  n.handle(64, 1, (_peer, args) => [decode(args[0])]); // echo
  n.start();
  return n;
}

async function pair(a: Node, b: Node) {
  const inv = Invite.parse(a.invite(60_000).toString());
  const p = await b.join(inv, 10_000);
  assert.equal(p.addr, a.id.addr);
  for (let i = 0; i < 200 && !a.trust.get(b.id.addr); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(a.trust.get(b.id.addr), "the invite owner remembers the joiner");
}

async function echo(from: Node, to: Node, data: Uint8Array) {
  const res = await from.call(to.id.addr, 64, 1, data);
  assert.deepEqual(decode(res[0]), data);
}

test("cbor round trip", () => {
  const v = [0, 7, 1, 5, 1, "ок", new Uint8Array([1, 2, 3]), -5, 2 ** 40, null, true, [1, [2]]];
  assert.deepEqual(decode(encode(v)), v);
  assert.equal(decodeArrayRaw(encode([1, "a", [2]])).length, 3);
});

test("pair and call over UDP; errors carry codes; events arrive", async () => {
  const a = await node("Laptop", { udp: true }), b = await node("Phone", { udp: true });
  try {
    await pair(a, b);
    await echo(b, a, new TextEncoder().encode("hello"));
    await echo(a, b, new TextEncoder().encode("hello back"));
    await assert.rejects(a.call(b.id.addr, 64, 9), (e: P2PACTError) => e.code === ErrNoMethod);
    const got = new Promise<string>((r) => (b.onEvent = (_p, _t, _e, args) => r(String(decode(args[0])))));
    a.event(b.id.addr, 64, 1, "event");
    assert.equal(await got, "event");
    assert.deepEqual(a.paths(b.id.addr), ["udp"]);
  } finally {
    a.close();
    b.close();
  }
});

test("TCP only", async () => {
  const a = await node("Laptop", { tcp: "127.0.0.1:0" }), b = await node("Phone", { tcp: "" });
  try {
    await pair(a, b);
    await echo(b, a, new TextEncoder().encode("over tcp"));
    await echo(a, b, new TextEncoder().encode("long ".repeat(2000)));
    assert.deepEqual(b.paths(a.id.addr), ["tcp"]);
  } finally {
    a.close();
    b.close();
  }
});

test("a long message under loss arrives whole", async () => {
  const a = await node("Laptop", { udp: true }), b = await node("Phone", { udp: true });
  try {
    await pair(a, b);
    let seed = 1;
    const drop = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) < 0.15;
    a.udpRoad!.drop = drop;
    b.udpRoad!.drop = drop;
    const data = new Uint8Array(100_000).map((_, i) => (i * 7919) % 251);
    await echo(a, b, data);
  } finally {
    a.close();
    b.close();
  }
});

test("a restarted device resumes by itself", async () => {
  const dir = tmp();
  const a = await node("Laptop", { udp: true });
  let b = new Node(dir, "Phone");
  await b.listenUDP("127.0.0.1:0");
  b.handle(64, 1, (_p, args) => [decode(args[0])]);
  b.start();
  try {
    await pair(a, b);
    await echo(a, b, new TextEncoder().encode("before"));
    const addr = b.udpRoad!.localAddr();
    b.close();
    b = new Node(dir, "Phone");
    await b.listenUDP(addr);
    b.handle(64, 1, (_p, args) => [decode(args[0])]);
    b.start();
    await echo(a, b, new TextEncoder().encode("after"));
    await echo(b, a, new TextEncoder().encode("and back"));
  } finally {
    a.close();
    b.close();
  }
});
