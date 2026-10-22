import { test } from "node:test";
import assert from "node:assert/strict";
import { Stream } from "../src/delivery.js";

const text = (s: string) => new TextEncoder().encode(s);

// A timeout fired by a queue, not a loss: the ack of the first copy comes just after the
// retransmission and must not mark the parts sent between the copies lost (spec §5).
test("an ack sooner than the minimum round trip after a timer's copy is for the earlier copy", () => {
  const a = new Stream(), b = new Stream();
  const t0 = 1000;
  const exchange = (at: number, ...pkts: Uint8Array[]) => {
    for (const p of pkts) b.receive(at, p, () => {});
    const ack = b.nextPacket(at, true)!;
    a.receive(at + 1, ack.plain, () => {});
  };
  a.push(text("first"), false, 1); // a round-trip sample: 60 ms
  exchange(t0 + 59, a.nextPacket(t0, false)!.plain);
  assert.equal(a.minRTT, 60);
  const sent = t0 + 100;
  const pkts: Uint8Array[] = [];
  for (let i = 0; i < 5; i++) {
    a.push(text("queued"), false, 1);
    pkts.push(a.nextPacket(sent, false)!.plain);
  }
  const at = sent + (a as unknown as { timeout(p: unknown, ahead: number): number }).timeout(a.inflight.get(2), 0);
  assert.equal(a.nextPacket(at, false)?.retry, true, "no retransmission on timeout");
  const srtt = a.srtt;
  exchange(at + 1, pkts[0]); // the first copy, late behind a queue
  for (const [seq, p] of a.inflight) assert.notEqual(p.sent, 0, `part ${seq} taken as lost`);
  assert.ok(a.srtt > srtt, "the ack of the first copy is a round-trip sample");
});

// The other device restarted: our unacknowledged calls go again, renumbered; replies to its
// old calls are dropped — they would answer its new calls with the same ids.
test("a restart drops replies and starts the estimates afresh", () => {
  const a = new Stream(), b = new Stream();
  a.push(text("warm up"), false, 1);
  b.receive(1030, a.nextPacket(1000, false)!.plain, () => {});
  a.receive(1060, b.nextPacket(1030, true)!.plain, () => {});
  assert.ok(a.srtt > 0 && a.minRTT > 0);
  a.push(text("call"), false, 1);
  (a.push as any)(text("reply"), false, 2, true);
  (a.push as any)(text("queued reply"), false, 2, true);
  a.nextPacket(2000, false);
  a.nextPacket(2000, false);
  a.reset();
  assert.equal(a.queue.length, 1);
  assert.equal(new TextDecoder().decode(a.queue[0].data), "call");
  assert.equal(a.queue[0].seq, 1);
  assert.equal(a.next, 2);
  assert.equal(a.inflight.size, 0);
  assert.deepEqual([a.srtt, a.rttvar, a.minRTT, a.bw, a.cwnd], [0, 0, 0, 0, 32]);
});
