import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decode, encode, decodeArrayRaw, Invite, Node, P2PACTError, ErrNoMethod, later } from "../src/index.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`no answer in ${ms} ms`)))]);

// Events and calls of one stream run in the order sent, one at a time; a slow handler holds
// up its own stream only (spec §6).
test("a stream's calls and events run in order", async () => {
  const a = await node("Laptop", { udp: true }), b = await node("Phone", { udp: true });
  try {
    await pair(a, b);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    b.handle(64, 2, async () => { // slow, on stream 2
      await released;
      return [];
    });
    const total = 300;
    const got: number[] = [];
    let done!: () => void;
    const all = new Promise<void>((r) => (done = r));
    b.onEvent = async (_p, _t, ev) => {
      await sleep(Math.random() < 0.3 ? 1 : 0); // run all at once, they would reorder
      got.push(ev);
      if (got.length === total) done();
    };
    const slow = a.callOn(b.id.addr, 2, 64, 2);
    await sleep(50);
    a.eventOn(b.id.addr, 2, 64, 0); // behind the slow call
    for (let i = 1; i < total; i++) a.eventOn(b.id.addr, 1, 64, i);
    for (let i = 0; i < 300 && got.length < total - 1; i++) await sleep(10);
    await sleep(100);
    assert.equal(got.length, total - 1, "the slow call held up another stream, or an event overtook it");
    assert.ok(!got.includes(0), "an event overtook the slow call on its stream");
    release();
    await within(slow, 10_000);
    await within(all, 10_000);
    assert.equal(got[total - 1], 0);
    for (let i = 1; i < total; i++) assert.equal(got[i - 1], i, `out of order at ${i}`);
  } finally {
    a.close();
    b.close();
  }
});

// A handler that answers later lets its stream go on: an event and a call sent behind it run
// (in the order sent) while it waits, and its result comes when ready (spec §6).
test("a call answered later does not hold up its stream", async () => {
  const a = await node("Laptop", { udp: true }), b = await node("Phone", { udp: true });
  try {
    await pair(a, b);
    let release!: (v: string[]) => void;
    const turn = new Promise<string[]>((r) => (release = r));
    const started: string[] = [];
    b.handle(64, 2, async () => { // an agent's turn
      started.push("long");
      return later(turn);
    });
    b.handle(64, 3, () => {
      started.push("call");
      return ["quick"];
    });
    b.handle(64, 4, () => later(Promise.reject(new P2PACTError(4, "no")))); // an error, later
    b.onEvent = () => void started.push("event");
    let answered = false;
    const long = a.callOn(b.id.addr, 2, 64, 2).then((r) => ((answered = true), r));
    await sleep(50);
    a.eventOn(b.id.addr, 2, 64, 1); // a cancel, say
    const quick = await within(a.callOn(b.id.addr, 2, 64, 3), 3_000);
    assert.equal(decode(quick[0]), "quick");
    assert.deepEqual(started, ["long", "event", "call"]);
    assert.ok(!answered, "the long call was answered before it was done");
    release(["done"]);
    assert.equal(decode((await within(long, 5_000))[0]), "done");
    await assert.rejects(within(a.callOn(b.id.addr, 2, 64, 4), 3_000), (e: P2PACTError) => e.code === 4);
  } finally {
    a.close();
    b.close();
  }
});

// The other device restarts silently while our calls are in flight: we handshake again with
// a part in the first packet, numbered for its old boot; its reply renumbers everything
// (spec §4.2). Every call must still run exactly once, and later calls must not be lost.
test("a restart with parts in flight", async () => {
  const dir = tmp();
  const a = await node("Laptop", { udp: true });
  let b = await (async () => {
    const n = new Node(dir, "Phone");
    await n.listenUDP("127.0.0.1:0");
    n.handle(64, 1, (_p, args) => [decode(args[0])]);
    n.start();
    return n;
  })();
  const runs = new Map<string, number>();
  const count = (n: Node) =>
    n.handle(64, 3, (_p, args) => {
      const s = String(decode(args[0]));
      runs.set(s, (runs.get(s) ?? 0) + 1);
      return [s];
    });
  const call = async (s: string) => {
    const res = await within(a.call(b.id.addr, 64, 3, s), 10_000);
    assert.equal(decode(res[0]), s, `${s} answered ${String(decode(res[0]))}`);
  };
  try {
    await pair(a, b);
    for (let i = 0; i < 10; i++) await echo(a, b, text("before")); // the numbering moves on
    const addr = b.udpRoad!.localAddr();
    b.udpRoad!.drop = () => true; // the calls below never reach the old boot
    const lost = ["lost 1", "lost 2", "lost 3"].map(call);
    await sleep(300);
    b.close();
    b = new Node(dir, "Phone");
    count(b);
    await b.listenUDP(addr);
    // we notice first (the new boot only answers handshakes before start): the session is gone
    // and the lost calls are due, so the first one rides in the handshake's first packet
    const ai = a as unknown as { current: Map<string, unknown>; peers: Map<string, { st: { inflight: Map<number, { sent: number }> } }>; wake(): void };
    ai.current.delete(b.id.addr);
    for (const p of ai.peers.get(b.id.addr)!.st.inflight.values()) p.sent = 0;
    ai.wake();
    await sleep(300);
    b.start();
    await Promise.all(lost);
    for (let i = 0; i < 20; i++) await call(`after ${i}`);
    for (const [s, n] of runs) assert.equal(n, 1, `${s} ran ${n} times`);
  } finally {
    a.close();
    b.close();
  }
});

function text(s: string) {
  return new TextEncoder().encode(s);
}
