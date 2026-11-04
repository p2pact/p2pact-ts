// Via a third device (spec §3): the Go reference's forward_test.go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, Node, Trust } from "../src/index.js";
import { Stream } from "../src/delivery.js";
import { addrBytes, addrText, evForward, forwardBurst, type FwdPending } from "../src/forward.js";
import { probeTiming } from "../src/node.js";
import { close, echo, eventually, node, pair, tmp } from "./util.js";

const pInit = 1;

const friends = (p: Node, q: Node, udp?: string[]) => {
  p.befriend({ addr: q.id.addr, key: q.id.key.public, name: q.name, pairSecret: new Uint8Array(32), hints: { udp }, added: 0 });
  q.befriend({ addr: p.id.addr, key: p.id.key.public, name: p.name, pairSecret: new Uint8Array(32), hints: { udp }, added: 0 });
};

/** threeNodes: A and B trust each other but cannot reach each other — they know only a dead
 * address of the other (as after a move) and announce none — while both are paired with X over UDP. */
async function threeNodes(): Promise<[Node, Node, Node]> {
  const a = await node("A"), x = await node("X"), b = await node("B");
  a.setAdvertise({});
  b.setAdvertise({});
  await pair(x, a);
  await pair(x, b);
  friends(a, b, ["127.0.0.1:1"]);
  return [a, x, b];
}

/** tap records what X forwards. */
function tap(x: Node): Uint8Array[] {
  const pkts: Uint8Array[] = [];
  x.forwardTap = (_from, _to, pkt) => pkts.push(pkt.slice());
  return pkts;
}

const contains = (pkts: Uint8Array[], b: Uint8Array) => pkts.some((p) => Buffer.from(p).includes(Buffer.from(b)));

/** settles reports whether a call succeeds within ms. */
async function reaches(p: Promise<unknown>, ms: number): Promise<boolean> {
  p.catch(() => {});
  return Promise.race([p.then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

/** forge sends X an event 0.7 for B by hand. */
function forge(a: Node, x: Node, b: Node) {
  const pkt = new Uint8Array(201);
  pkt[0] = pInit;
  crypto.getRandomValues(pkt.subarray(1));
  a.event(x.id.addr, 0, evForward, addrBytes(b.id.addr), pkt);
}

// A and B, which cannot reach each other, set up a session through X and talk both ways —
// calls, events, a long message; X carries only ciphertext.
test("forward via a third device", async () => {
  const [a, x, b] = await threeNodes();
  try {
    const pkts = tap(x);
    x.allowForward(a.id.addr, b.id.addr, true);
    assert.deepEqual(x.forwards(a.id.addr), [b.id.addr]);
    await eventually("A hears X forwards to B", () => a.forwarders(b.id.addr).join() === x.id.addr);

    const marker = new TextEncoder().encode("plaintext-marker-that-X-must-never-see");
    const msg = new Uint8Array(100 + marker.length).fill(46);
    msg.set(marker, 100);
    await echo(a, b, msg);
    await echo(b, a, msg);
    assert.deepEqual(a.paths(b.id.addr), ["via:" + x.id.addr]);
    assert.deepEqual(b.paths(a.id.addr), ["via:" + x.id.addr]);

    const long = new Uint8Array(40 << 10);
    for (let i = 0; i < long.length; i += 65536) crypto.getRandomValues(long.subarray(i, i + 65536));
    await echo(a, b, long);
    await echo(b, a, long);

    const seen = new Set<string>();
    for (const n of [a, b]) n.onEvent = (_peer, _tool, _ev, args) => void seen.add(decode(args[0]) as string);
    a.event(b.id.addr, 64, 3, "to B");
    b.event(a.id.addr, 64, 3, "to A");
    await eventually("events both ways", () => seen.has("to A") && seen.has("to B"));

    assert.ok(pkts.length > 0, "X forwarded nothing");
    assert.ok(!contains(pkts, marker), "X saw the plaintext");
    assert.ok(x.forwardStats().forwarded > 0, "no forwarded packets counted");
    // the consent is kept with the trusted list
    assert.deepEqual(new Trust((x.trust as any).st).get(a.id.addr)?.forward, [b.id.addr]);
  } finally {
    close(a, x, b);
  }
});

// X forwards nothing for a pair it was not opted in for, nor to a device it does not trust,
// and stops when it forgets one of the two.
test("forward refused", async () => {
  const [a, x, b] = await threeNodes();
  const stranger = await node("S", false);
  try {
    const pkts = tap(x);
    // not opted in: no road via X, and a forged 0.7 is dropped
    assert.equal(await reaches(a.call(b.id.addr, 64, 1, new Uint8Array([1])), 2000), false, "A reached B with nobody forwarding");
    forge(a, x, b);
    await eventually("X drops the forged packet", () => x.forwardStats().dropped > 0);
    assert.equal(pkts.length, 0, "X forwarded without consent");

    // only between devices X trusts, never to itself
    assert.throws(() => x.allowForward(a.id.addr, stranger.id.addr, true), "X agreed to forward to a device it does not trust");
    assert.throws(() => x.allowForward(a.id.addr, x.id.addr, true), "X agreed to forward to itself");

    // opted in, then X forgets B: A learns it, and X forwards nothing more
    x.allowForward(a.id.addr, b.id.addr, true);
    await echo(a, b, new TextEncoder().encode("through X"));
    x.forget(b.id.addr);
    await eventually("A hears X no longer forwards to B", () => a.forwarders(b.id.addr).length === 0);
    const before = pkts.length;
    const dropped = x.forwardStats().dropped;
    forge(a, x, b);
    await eventually("X drops a packet for a device it forgot", () => x.forwardStats().dropped > dropped);
    assert.equal(pkts.length, before, "X forwarded to a device it forgot");
  } finally {
    close(a, x, b, stranger);
  }
});

// Withdrawing the consent stops forwarding and tells both devices.
test("forward withdrawn", async () => {
  const [a, x, b] = await threeNodes();
  try {
    x.allowForward(a.id.addr, b.id.addr, true);
    await echo(a, b, new TextEncoder().encode("through X"));
    x.allowForward(b.id.addr, a.id.addr, false);
    await eventually("both hear X no longer forwards", () => a.forwarders(b.id.addr).length === 0 && b.forwarders(a.id.addr).length === 0);
    const dropped = x.forwardStats().dropped;
    forge(a, x, b);
    await eventually("X drops the packet", () => x.forwardStats().dropped > dropped);
  } finally {
    close(a, x, b);
  }
});

// The rate limit: a direction may send a burst, then only its rate; what is over the rate waits,
// up to a burst, and goes as the bucket refills; past that it is dropped.
test("forward bucket", () => {
  const n = new Node(tmp(), "N");
  try {
    n.forwardRate = 1000;
    const peers = (n as any).peers as Map<string, unknown>;
    for (const p of ["a", "b"]) peers.set(p, { addr: p, st: new Stream(), eps: new Map(), calls: new Map(), forwards: [] });
    const now = Date.now();
    const p = (to: string): FwdPending => ({ to, msg: new Uint8Array([1]), stream: 1, size: 1000 });
    let offered = 0;
    while (n.fwdOffer("a>b", p("b"), now)) offered++;
    const burst = Math.floor(forwardBurst / 1000);
    assert.equal(n.forwardStats().forwarded, burst);
    assert.equal(offered, 2 * burst);
    n.fwdRelease(now + 400); // 536 left + 400: not enough
    assert.equal(n.forwardStats().forwarded, burst, "more than the rate");
    n.fwdRelease(now + 2100);
    assert.equal(n.forwardStats().forwarded, burst + 2, "the rate refills");
    assert.ok(n.fwdOffer("b>a", p("a"), now) && n.forwardStats().forwarded === burst + 3, "the other direction has its own bucket");
  } finally {
    n.close();
  }
});

test("address bytes", () => {
  const n = new Node(tmp(), "A");
  try {
    const b = addrBytes(n.id.addr);
    assert.ok(b && b.length === 16 && addrText(b) === n.id.addr);
    assert.equal(addrBytes("nonsense"), undefined);
    assert.equal(addrBytes(n.id.addr.slice(0, 25) + "1"), undefined);
  } finally {
    n.close();
  }
});

// One hop only: X reaches B only through Y, so it does not forward A's packets to B (no chains).
test("forward one hop", async () => {
  const a = await node("A"), x = await node("X"), y = await node("Y"), b = await node("B");
  try {
    a.setAdvertise({});
    b.setAdvertise({});
    await pair(y, x);
    await pair(y, b);
    await pair(x, a);
    x.setAdvertise({}); // Y and A know where X is; B never learns it
    friends(x, b);
    friends(a, b);
    y.allowForward(x.id.addr, b.id.addr, true);
    await echo(x, b, new TextEncoder().encode("X to B through Y"));
    x.allowForward(a.id.addr, b.id.addr, true);
    await eventually("A hears X forwards to B", () => a.forwarders(b.id.addr).length === 1);
    assert.equal(await reaches(a.call(b.id.addr, 64, 1, new TextEncoder().encode("two hops")), 2000), false, "A reached B over two forwarders");
    const st = x.forwardStats();
    assert.ok(st.forwarded === 0 && st.dropped > 0, `X forwarded ${st.forwarded}, dropped ${st.dropped}`);
  } finally {
    close(a, x, y, b);
  }
});

// A road via a third device gives way to a direct one as soon as it answers (spec §7).
test("forward gives way to direct", async () => {
  const old = probeTiming.every;
  probeTiming.every = 300;
  const [a, x, b] = await threeNodes();
  try {
    x.allowForward(a.id.addr, b.id.addr, true);
    await echo(a, b, new TextEncoder().encode("through X"));
    a.setAdvertise(undefined); // A announces its UDP address again: B probes it
    for (let i = 0; ; i++) {
      await echo(b, a, new TextEncoder().encode("ping"));
      if (b.paths(a.id.addr).includes("udp")) break;
      if (i > 100) assert.fail("the session never moved to UDP: " + b.paths(a.id.addr).join());
      await new Promise((r) => setTimeout(r, 100));
    }
    const fw = x.forwardStats().forwarded;
    for (let i = 0; i < 20; i++) await echo(a, b, new TextEncoder().encode("direct"));
    const now = x.forwardStats().forwarded;
    assert.ok(now - fw <= 4, `X still carried ${now - fw} packets after UDP came up`);
  } finally {
    probeTiming.every = old;
    close(a, x, b);
  }
});
