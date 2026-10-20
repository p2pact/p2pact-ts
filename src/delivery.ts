// Delivery (spec §5). The decrypted content of a data packet:
//
//   flags (1) | [ack: varint "all up to N" + varint bitmap of the 32 parts after N+1] | [varint part number | part]
//
// A message is cut into packet-sized parts numbered consecutively; the receiver reassembles
// them in order. Anything unacknowledged is retransmitted while the session lives.

export const fAck = 1; // carries an ack
export const fMsg = 2; // carries a message part
export const fMore = 4; // more parts follow
export const fZip = 8; // compressed; set on every part of a compressed message
export const fOnce = 16; // do not ack (keepalive)
export const fFirst = 32; // first part of a message on a stream: stream and number follow
export const fCont = 64; // a further part of a message on a stream

export const MaxPacket = 1200;
export const dataHeader = 9;
const ackBudget = 60;
// 1200 − 9 (header) − 16 (tag) − 1 (flags) − the ack − up to 5 (number) − up to 20 (stream)
export const maxPart = MaxPacket - dataHeader - 16 - 1 - ackBudget - 5 - 20;

const rtoStart = 500; // ms, before the first round-trip sample
const rtoMin = 50;
const rtoMax = 4000;
export const ackDelay = 40;
const cwndStart = 32;
const cwndMin = 32;
const cwndMax = 4096;
const gotMax = 8192;
export const msgMax = 16 << 20;

interface Part {
  seq: number;
  data: Uint8Array;
  more: boolean;
  zip: boolean;
  stream: number;
  num: number;
  firstOfStream: boolean;
  first: number; // first sent at, ms (0 — not yet)
  sent: number;
  tries: number;
  delivered: number; // bytes delivered when sent: its ack gives a delivery-rate sample
}

export function putUvarint(out: number[], v: number | bigint) {
  let x = BigInt(v);
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
}

export function readUvarint(b: Uint8Array, pos: number): [bigint, number] {
  let x = 0n;
  let shift = 0n;
  for (let i = pos; i < b.length && i < pos + 10; i++) {
    x |= BigInt(b[i] & 0x7f) << shift;
    if (b[i] < 0x80) return [x, i + 1];
    shift += 7n;
  }
  throw new Error("short varint");
}

/** Stream is delivery to one device, both directions. */
export class Stream {
  next = 1;
  inflight = new Map<number, Part>();
  queue: Part[] = [];

  // congestion control as in TCP NewReno + HyStart; RTT per RFC 6298; delivery rate as in BBR
  cwnd = cwndStart;
  ssthresh = cwndMax;
  srtt = 0;
  rttvar = 0;
  minRTT = 0;
  lastCut = 0;
  delivered = 0;
  inflightBytes = 0;
  reliable = false;
  bw = 0; // bytes per ms
  bwAt = 0;

  snext = new Map<number, number>();
  recvAck = 1; // first part not received yet
  got = new Map<number, RPart>();
  next0 = 1;
  asm0: Uint8Array[] = [];
  asm0Len = 0;
  zip0 = false;
  streams = new Map<number, { next: number; ready: Map<number, { msg: Uint8Array; zip: boolean }> }>();
  ackDue = 0;
  unacked = 0;

  private resetRecv() {
    this.snext = new Map();
    this.recvAck = 1;
    this.got = new Map();
    this.next0 = 1;
    this.asm0 = [];
    this.asm0Len = 0;
    this.zip0 = false;
    this.streams = new Map();
    this.ackDue = 0;
    this.unacked = 0;
  }

  rto(): number {
    if (this.srtt === 0) return rtoStart;
    return Math.min(Math.max(this.srtt + 4 * this.rttvar, rtoMin), rtoMax);
  }

  private rate(now: number, r: number) {
    if (r >= this.bw || now - this.bwAt > 2000) {
      this.bw = r;
      this.bwAt = now;
    }
  }

  /** canSend: the congestion window, capped by twice the BDP (in bytes) while a queue builds;
   * no window of our own on a reliable road (TCP controls congestion itself). */
  canSend(): boolean {
    if (this.reliable) return this.inflight.size < cwndMax;
    if (this.inflight.size >= Math.floor(this.cwnd)) return false;
    const queue = this.srtt > this.minRTT + Math.max(this.minRTT / 2, 10);
    if (queue && this.bw > 0 && this.minRTT > 0) return this.inflightBytes < 2 * this.bw * this.minRTT + 4 * maxPart;
    return true;
  }

  /** timeout: current estimate plus link time for the parts ahead, doubled per retry. */
  private timeout(p: Part, ahead: number): number {
    let t = this.rto();
    if (this.bw > 0) t += (ahead * maxPart) / this.bw;
    // back off only on congestion, or after three tries in a row: a random loss is no reason
    const backoff = this.queueing() ? p.tries - 1 : Math.max(0, p.tries - 3);
    for (let i = 0; i < backoff && t < rtoMax; i++) t *= 2;
    return Math.min(t, rtoMax);
  }

  private sample(rtt: number) {
    if (this.minRTT === 0 || rtt < this.minRTT) this.minRTT = rtt;
    if (this.cwnd < this.ssthresh && rtt > this.minRTT + Math.max(this.minRTT / 2, 4)) this.ssthresh = this.cwnd;
    if (this.srtt === 0) {
      this.srtt = rtt;
      this.rttvar = rtt / 2;
      return;
    }
    this.rttvar = (3 * this.rttvar + Math.abs(this.srtt - rtt)) / 4;
    this.srtt = (7 * this.srtt + rtt) / 8;
  }

  private queueing(): boolean {
    return this.srtt > this.minRTT + Math.max(this.minRTT / 2, 10);
  }

  private acked(n: number) {
    const queue = this.queueing(); // slow start, and while no queue builds (as BBR probes)
    for (let i = 0; i < n; i++) this.cwnd += this.cwnd < this.ssthresh || !queue ? 1 : 1 / this.cwnd;
    this.cwnd = Math.min(this.cwnd, cwndMax);
  }

  private lost(now: number) {
    // only while a queue builds: a loss without one is random, not congestion
    if (now - this.lastCut < Math.max(this.srtt, rtoMin) || !this.queueing()) return;
    this.lastCut = now;
    this.ssthresh = Math.max(this.cwnd / 2, cwndMin);
    this.cwnd = this.ssthresh;
  }

  /** reset handles a restart of the other device: renumber what we have, receive from 1. */
  reset() {
    const pending = [...this.inflight.values()].sort((a, b) => a.seq - b.seq).concat(this.queue);
    this.next = 1;
    this.inflight = new Map();
    this.inflightBytes = 0;
    this.queue = [];
    this.resetRecv();
    for (const p of pending) {
      Object.assign(p, { seq: this.next++, first: 0, sent: 0, tries: 0, delivered: 0 });
      if (p.firstOfStream) {
        const n = (this.snext.get(p.stream) ?? 0) + 1;
        this.snext.set(p.stream, n);
        p.num = n;
      }
      this.queue.push(p);
    }
  }

  /** push queues a message in parts on a stream (0 — the ordered default); zip — compressed. */
  push(msg: Uint8Array, zip: boolean, stream = 0) {
    let num = 0;
    if (stream !== 0) {
      num = (this.snext.get(stream) ?? 0) + 1;
      this.snext.set(stream, num);
    }
    let off = 0;
    let first = true;
    do {
      const n = Math.min(msg.length - off, maxPart);
      this.queue.push({ seq: this.next++, data: msg.subarray(off, off + n), more: off + n < msg.length, zip,
        stream, num: first ? num : 0, firstOfStream: stream !== 0 && first, first: 0, sent: 0, tries: 0, delivered: 0 });
      first = false;
      off += n;
    } while (off < msg.length);
  }

  /** nextPacket builds the next packet content, or null when there is nothing to send. */
  nextPacket(now: number, forceAck: boolean): { plain: Uint8Array; retry: boolean } | null {
    let p: Part | undefined;
    let lowest = 0;
    for (const seq of this.inflight.keys()) if (lowest === 0 || seq < lowest) lowest = seq;
    for (const x of this.inflight.values()) {
      if (now - x.sent >= this.timeout(x, x.seq - lowest) && (!p || x.seq < p.seq)) p = x;
    }
    let retry = false;
    if (p) {
      retry = true;
      this.lost(now);
    } else if (this.queue.length > 0 && this.canSend()) {
      p = this.queue.shift()!;
      this.inflight.set(p.seq, p);
      this.inflightBytes += p.data.length;
    }
    const received = this.recvAck > 1 || this.got.size > 0;
    const ack = received && (p !== undefined || forceAck || (this.ackDue !== 0 && now >= this.ackDue));
    if (!p && !ack) return null;
    let flags = 0;
    const b: number[] = [0];
    if (ack) {
      flags |= fAck;
      this.appendAck(b);
      this.ackDue = 0;
      this.unacked = 0;
    }
    let data: Uint8Array | null = null;
    if (p) {
      flags |= fMsg;
      if (p.more) flags |= fMore;
      if (p.zip) flags |= fZip;
      putUvarint(b, p.seq);
      if (p.firstOfStream) {
        flags |= fFirst;
        putUvarint(b, p.stream);
        putUvarint(b, p.num);
      } else if (p.stream !== 0) flags |= fCont;
      data = p.data;
      if (p.first === 0) p.first = now;
      p.delivered = this.delivered;
      p.sent = now;
      p.tries++;
    }
    b[0] = flags;
    const head = Uint8Array.from(b);
    if (!data) return { plain: head, retry };
    const out = new Uint8Array(head.length + data.length);
    out.set(head);
    out.set(data, head.length);
    return { plain: out, retry };
  }

  /** appendAck: all up to recvAck−1, then (missing, received) ranges above the first gap. */
  private appendAck(b: number[]) {
    putUvarint(b, this.recvAck - 1);
    const above = [...this.got.keys()].filter((k) => k > this.recvAck).sort((x, y) => x - y);
    const ranges: number[] = [];
    let count = 0;
    let cursor = this.recvAck;
    for (let i = 0; i < above.length; ) {
      let j = i;
      while (j + 1 < above.length && above[j + 1] === above[j] + 1) j++;
      const r: number[] = [];
      putUvarint(r, above[i] - cursor);
      putUvarint(r, j - i + 1);
      if (ranges.length + r.length > ackBudget - 12) break;
      ranges.push(...r);
      count++;
      cursor = above[j] + 1;
      i = j + 1;
    }
    putUvarint(b, count);
    b.push(...ranges);
  }

  /** receive handles packet content; deliver gets each message as it becomes deliverable. */
  receive(now: number, b: Uint8Array, deliver: (msg: Uint8Array, zip: boolean, stream: number) => void) {
    if (b.length === 0) throw new Error("empty packet");
    const flags = b[0];
    let pos = 1;
    if (flags & fAck) {
      const [upto, p1] = readUvarint(b, pos);
      const [count, p2] = readUvarint(b, p1);
      pos = p2;
      if (count > 64n) throw new Error("too many ranges");
      let done = 0;
      let newest = 0; // the latest send time among the parts this ack covers
      const ack = (seq: number) => {
        const p = this.inflight.get(seq);
        if (!p) return;
        if (p.sent > newest) newest = p.sent;
        this.delivered += p.data.length;
        if (p.tries === 1) {
          this.sample(now - p.sent);
          const dt = now - p.sent;
          if (dt > 0) this.rate(now, (this.delivered - p.delivered) / dt);
        }
        this.inflight.delete(seq);
        this.inflightBytes -= p.data.length;
        done++;
      };
      for (const seq of [...this.inflight.keys()]) if (BigInt(seq) <= upto) ack(seq);
      let beyond = 0;
      let cursor = Number(upto) + 1;
      for (let i = 0n; i < count; i++) {
        const [gap, q1] = readUvarint(b, pos);
        const [run, q2] = readUvarint(b, q1);
        pos = q2;
        const start = cursor + Number(gap);
        for (let seq = start; seq < start + Number(run); seq++) ack(seq);
        beyond += Number(run);
        cursor = start + Number(run);
      }
      this.acked(done);
      if (newest > 0) { // time-based loss detection (RACK): sent well before one that arrived
        const reorder = Math.max(this.srtt / 4, 1);
        let lost = false;
        for (const p of this.inflight.values()) {
          if (p.sent !== 0 && p.sent + reorder < newest) {
            p.sent = 0;
            lost = true;
          }
        }
        if (lost) this.lost(now);
      }
      if (beyond > 0) { // fast retransmit: three parts past the gap, or a quarter of a round trip
        const gap = this.inflight.get(Number(upto) + 1);
        if (gap && (beyond >= 3 || now - gap.sent >= Math.max(this.srtt / 4, ackDelay))) gap.sent = 0;
      }
    }
    if (!(flags & fMsg)) return;
    const [seq64, p3] = readUvarint(b, pos);
    pos = p3;
    const r: RPart = { data: new Uint8Array(0), more: !!(flags & fMore), zip: !!(flags & fZip), first: false, streamed: false,
      used: false, stream: 0, num: 0 };
    if (flags & fFirst) {
      const [st, q1] = readUvarint(b, pos);
      const [num, q2] = readUvarint(b, q1);
      pos = q2;
      Object.assign(r, { first: true, streamed: true, stream: Number(st), num: Number(num) });
    } else if (flags & fCont) r.streamed = true;
    const seq = Number(seq64);
    if (this.ackDue === 0) this.ackDue = now + ackDelay;
    if (++this.unacked >= 2 || seq !== this.recvAck) this.ackDue = now;
    if (seq < this.recvAck || this.got.has(seq) || this.got.size >= gotMax) return;
    r.data = b.slice(pos);
    this.got.set(seq, r);
    while (this.got.has(this.recvAck)) this.recvAck++;
    if (r.streamed) this.assemble(seq, deliver);
    this.take0(deliver);
    for (const [k, x] of this.got) if (x.used && k < this.recvAck && k < this.next0) this.got.delete(k);
  }

  private assemble(seq: number, deliver: (m: Uint8Array, z: boolean, s: number) => void) {
    let start = seq;
    for (;;) {
      const x = this.got.get(start);
      if (!x || x.used) return;
      if (x.first) break;
      if (!x.streamed || start === 0) return;
      start--;
    }
    const head = this.got.get(start)!;
    const parts: Uint8Array[] = [];
    let len = 0;
    let end = start;
    for (;;) {
      const x = this.got.get(end);
      if (!x || !x.streamed || x.used || (end !== start && x.first)) return;
      if (len + x.data.length > msgMax) return;
      parts.push(x.data);
      len += x.data.length;
      if (!x.more) break;
      end++;
    }
    for (let k = start; k <= end; k++) this.got.get(k)!.used = true;
    let st = this.streams.get(head.stream);
    if (!st) {
      st = { next: 1, ready: new Map() };
      this.streams.set(head.stream, st);
    }
    if (head.num < st.next) return;
    st.ready.set(head.num, { msg: joinParts(parts, len), zip: head.zip });
    for (;;) {
      const m = st.ready.get(st.next);
      if (!m) return;
      st.ready.delete(st.next);
      st.next++;
      deliver(m.msg, m.zip, head.stream);
    }
  }

  private take0(deliver: (m: Uint8Array, z: boolean, s: number) => void) {
    for (;;) {
      const x = this.got.get(this.next0);
      if (!x) return;
      this.next0++;
      if (x.streamed) continue;
      x.used = true;
      if (this.asm0.length === 0) this.zip0 = x.zip;
      if (this.asm0Len + x.data.length > msgMax) {
        this.asm0 = [];
        this.asm0Len = 0;
        continue;
      }
      this.asm0.push(x.data);
      this.asm0Len += x.data.length;
      if (x.more) continue;
      const msg = joinParts(this.asm0, this.asm0Len);
      this.asm0 = [];
      this.asm0Len = 0;
      deliver(msg, this.zip0, 0);
    }
  }

  idle(): boolean {
    return this.inflight.size === 0 && this.queue.length === 0;
  }

  stuck(): boolean {
    for (const p of this.inflight.values()) if (p.tries >= 4) return true;
    return false;
  }
}

interface RPart {
  data: Uint8Array;
  more: boolean;
  zip: boolean;
  first: boolean;
  streamed: boolean;
  used: boolean;
  stream: number;
  num: number;
}

function joinParts(parts: Uint8Array[], len: number): Uint8Array {
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const keepalive = () => Uint8Array.of(fOnce);
