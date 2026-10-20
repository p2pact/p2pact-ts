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

export const MaxPacket = 1200;
export const dataHeader = 9;
// 1200 − 9 (header) − 16 (tag) − 1 (flags) − up to 10 (ack) − up to 5 (number)
export const maxPart = MaxPacket - dataHeader - 16 - 1 - 10 - 5;

const rtoStart = 500; // ms, before the first round-trip sample
const rtoMin = 50;
const rtoMax = 4000;
export const ackDelay = 40;
const cwndStart = 32;
const cwndMin = 32;
const cwndMax = 4096;
const earlyMax = 512;
export const msgMax = 16 << 20;

interface Part {
  seq: number;
  data: Uint8Array;
  more: boolean;
  zip: boolean;
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

  recvNext = 1;
  early = new Map<number, Part>();
  assembling: Uint8Array[] = [];
  assembled = 0;
  zipped = false;
  ackDue = 0;
  unacked = 0;

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
    for (let i = 1; i < p.tries && t < rtoMax; i++) t *= 2;
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

  private acked(n: number) {
    for (let i = 0; i < n; i++) this.cwnd += this.cwnd < this.ssthresh ? 1 : 1 / this.cwnd;
    this.cwnd = Math.min(this.cwnd, cwndMax);
  }

  private lost(now: number) {
    if (now - this.lastCut < Math.max(this.srtt, rtoMin)) return;
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
    for (const p of pending) {
      Object.assign(p, { seq: this.next++, first: 0, sent: 0, tries: 0, delivered: 0 });
      this.queue.push(p);
    }
    this.recvNext = 1;
    this.early = new Map();
    this.assembling = [];
    this.assembled = 0;
    this.zipped = false;
    this.ackDue = 0;
    this.unacked = 0;
  }

  /** push queues a message in parts; zip marks it compressed. */
  push(msg: Uint8Array, zip: boolean) {
    let off = 0;
    do {
      const n = Math.min(msg.length - off, maxPart);
      this.queue.push({ seq: this.next++, data: msg.subarray(off, off + n), more: off + n < msg.length, zip,
        first: 0, sent: 0, tries: 0, delivered: 0 });
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
    const ack = this.recvNext > 1 && (p !== undefined || forceAck || (this.ackDue !== 0 && now >= this.ackDue));
    if (!p && !ack) return null;
    let flags = 0;
    const b: number[] = [0];
    if (ack) {
      flags |= fAck;
      putUvarint(b, this.recvNext - 1);
      let bits = 0n;
      for (let i = 0; i < 32; i++) if (this.early.has(this.recvNext + 1 + i)) bits |= 1n << BigInt(i);
      putUvarint(b, bits);
      this.ackDue = 0;
      this.unacked = 0;
    }
    let data: Uint8Array | null = null;
    if (p) {
      flags |= fMsg;
      if (p.more) flags |= fMore;
      if (p.zip) flags |= fZip;
      putUvarint(b, p.seq);
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

  /** receive handles packet content; deliver is called for every reassembled message in order. */
  receive(now: number, b: Uint8Array, deliver: (msg: Uint8Array, zip: boolean) => void) {
    if (b.length === 0) throw new Error("empty packet");
    const flags = b[0];
    let pos = 1;
    if (flags & fAck) {
      const [upto, p1] = readUvarint(b, pos);
      const [bits, p2] = readUvarint(b, p1);
      pos = p2;
      let done = 0;
      const ack = (seq: number) => {
        const p = this.inflight.get(seq);
        if (!p) return;
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
      let ones = 0;
      for (let i = 0n; i < 32n; i++) {
        if (bits & (1n << i)) {
          ones++;
          ack(Number(upto + 2n + i));
        }
      }
      this.acked(done);
      if (bits !== 0n) { // fast retransmit: three parts past the gap, or a quarter of a round trip
        const gap = this.inflight.get(Number(upto + 1n));
        if (gap && (ones >= 3 || now - gap.sent >= Math.max(this.srtt / 4, ackDelay))) gap.sent = 0;
      }
    }
    if (!(flags & fMsg)) return;
    const [seq64, p3] = readUvarint(b, pos);
    const seq = Number(seq64);
    const data = b.subarray(p3);
    if (this.ackDue === 0) this.ackDue = now + ackDelay;
    // like TCP: ack at once every second part and on anything out of order
    if (++this.unacked >= 2 || seq !== this.recvNext) this.ackDue = now;
    if (seq < this.recvNext) return; // duplicate: just ack
    if (seq > this.recvNext) {
      if (this.early.size < earlyMax) {
        this.early.set(seq, { seq, data: data.slice(), more: !!(flags & fMore), zip: !!(flags & fZip), first: 0, sent: 0, tries: 0, delivered: 0 });
      }
      return;
    }
    this.take(data, !!(flags & fMore), !!(flags & fZip), deliver);
    for (;;) {
      const p = this.early.get(this.recvNext);
      if (!p) return;
      this.early.delete(this.recvNext);
      this.take(p.data, p.more, p.zip, deliver);
    }
  }

  private take(data: Uint8Array, more: boolean, zip: boolean, deliver: (m: Uint8Array, z: boolean) => void) {
    this.recvNext++;
    if (this.assembling.length === 0) this.zipped = zip;
    if (this.assembled + data.length > msgMax) {
      this.assembling = [];
      this.assembled = 0;
      return;
    }
    this.assembling.push(data.slice());
    this.assembled += data.length;
    if (more) return;
    const msg = new Uint8Array(this.assembled);
    let at = 0;
    for (const x of this.assembling) {
      msg.set(x, at);
      at += x.length;
    }
    this.assembling = [];
    this.assembled = 0;
    deliver(msg, this.zipped);
  }

  idle(): boolean {
    return this.inflight.size === 0 && this.queue.length === 0;
  }

  stuck(): boolean {
    for (const p of this.inflight.values()) if (p.tries >= 4) return true;
    return false;
  }
}

export const keepalive = () => Uint8Array.of(fOnce);
