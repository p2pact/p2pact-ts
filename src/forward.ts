// Via a third device (spec §3): a device both trust carries a pair's packets inside its own
// sessions with each of them — event 0.7 forward [to, packet] to it, event 0.8 forwarded
// [from, packet] from it. The packets stay end-to-end encrypted: the forwarder sees what a relay
// sees. It forwards only for pairs its person opted it in for (Node.allowForward), one hop only,
// within a rate limit, and never ahead of its own traffic. The node's side is in node.ts.
import type { StreamId } from "./delivery.js";
import type { Road } from "./roads.js";

export const evForward = 7; // event 0.7 forward [to, packet]: to a forwarder
export const evForwarded = 8; // event 0.8 forwarded [from, packet]: from a forwarder

/** DefaultForwardRate is how many bytes a second a forwarder carries in one direction of a pair,
 * unless Node.forwardRate says otherwise. */
export const DefaultForwardRate = 256 << 10;
/** forwardBurst: bytes a direction may send at once above its rate, and may keep waiting. */
export const forwardBurst = 64 << 10;
/** forwardQueue: past this many parts waiting to go to a device, packets to forward to it (and
 * our own packets for a forwarder) are dropped — our own traffic goes first. */
export const forwardQueue = 128;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** addrText is an address from the wire (16 bytes): lowercase base32, no padding. */
export function addrText(b: Uint8Array): string {
  let out = "";
  let bits = 0;
  let v = 0;
  for (const x of b) {
    v = ((v << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}

/** addrBytes is an address as it goes on the wire: 16 bytes; undefined — not an address. */
export function addrBytes(addr: string): Uint8Array | undefined {
  const s = addr.toLowerCase();
  if (s.length !== 26) return undefined;
  const out = new Uint8Array(16);
  let bits = 0, v = 0, n = 0;
  for (const c of s) {
    const d = B32.indexOf(c);
    if (d < 0) return undefined;
    v = ((v << 5) | d) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (n < 16) out[n++] = (v >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return n === 16 && addrText(out) === s ? out : undefined;
}

/** forwardStream is the stream forward events about a device go on: its address's first 8
 * bytes, big-endian, 0 replaced by 1 — so a loss towards one device holds up nothing else. */
export function forwardStream(addr: Uint8Array): StreamId {
  let s = new DataView(addr.buffer, addr.byteOffset, 8).getBigUint64(0);
  if (s === 0n) s = 1n;
  return s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s;
}

/** ViaRoad is the road to other devices through forwarder x: send wraps a packet into event 0.7
 * to x; what x hands over (0.8) arrives on it. The endpoint's addr is the device at the other
 * end. It keeps order but may drop (the forwarder's limits): delivery treats it as UDP, and it
 * ranks with an application road (spec §7). */
export class ViaRoad implements Road {
  readonly name: string;
  readonly rank = 3;
  readonly reliable = false;
  constructor(readonly x: string, private out: (x: string, to: string, pkt: Uint8Array) => void) {
    this.name = "via:" + x;
  }
  send(to: string, pkt: Uint8Array) {
    this.out(this.x, to, pkt);
  }
  close() {}
}

export const isVia = (r: Road): r is ViaRoad => r instanceof ViaRoad;

/** FwdPending is a forwarded packet waiting for its direction's rate. */
export interface FwdPending {
  to: string;
  msg: Uint8Array;
  stream: StreamId;
  size: number; // the forwarded packet's bytes
}

/** FwdBucket shapes one forwarded direction: a token bucket of the forward rate with bursts of
 * forwardBurst bytes. What comes over the rate waits, up to forwardBurst bytes, and goes as the
 * bucket refills — the queue it builds tells the pair's congestion control to slow down; past
 * that it is dropped. */
export class FwdBucket {
  q: FwdPending[] = [];
  queued = 0; // bytes waiting in q
  constructor(public tokens: number, public at: number) {}

  refill(rate: number, now: number) {
    if (now <= this.at) return;
    this.tokens = Math.min(forwardBurst, this.tokens + (rate * (now - this.at)) / 1000);
    this.at = now;
  }
}
