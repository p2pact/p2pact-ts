// Training our own dictionaries (spec §5). The content is picked by fastCover, the algorithm of
// `zstd --train` (facebook/zstd, lib/dictBuilder/fastcover.c), as p2pact-go does. A zstd
// dictionary also carries entropy tables (Huffman for literals, FSE for the sequence codes);
// Node's zstd has no trainer to build them, so ours reuses the tables of the common dictionary:
// they were made by `zstd --train` on conversations in many languages, describe every symbol,
// and are valid with any content. Only the owner compresses with a dictionary, so the receiver
// needs nothing but a valid one — and libzstd and klauspost/compress both take it.
import * as zlib from "node:zlib";
import { commonDict } from "./common.js";

export const zstdDictMagic = 0xec30a437;

/** trainDict trains a zstd dictionary of up to size bytes; like zstd, it tries several segment
 * and d-mer sizes on train and keeps the content that compresses test best. */
export function trainDict(train: Uint8Array[], test: Uint8Array[], size: number, id: number): Uint8Array {
  if (train.length < 4 || test.length < 2) throw new Error("too few samples");
  test = capBytes(test, 128 << 10);
  let best: Uint8Array | null = null;
  let bestCost = Infinity;
  for (const d of [6, 8]) {
    const c = new Cover(train, d);
    if (!c.ok) continue;
    for (const k of [64, 128, 256, 512, 1024, 2000]) {
      const content = c.content(size, k);
      if (content.length < 8) continue;
      const cost = dictCost(buildDict(content, id), test);
      if (cost < bestCost) [best, bestCost] = [content, cost];
    }
  }
  if (!best) throw new Error("no repeated content");
  return buildDict(best, id);
}

/** buildDict makes a zstd dictionary: magic, id, the common dictionary's entropy tables, repeat
 * offsets 1, 4, 8 (each must fit in the content: at least 8 bytes of it), content. */
export function buildDict(content: Uint8Array, id: number): Uint8Array {
  if (content.length < 8) throw new Error("dictionary content too short");
  const tables = entropyTables();
  const out = new Uint8Array(8 + tables.length + 12 + content.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, zstdDictMagic, true);
  dv.setUint32(4, id, true);
  out.set(tables, 8);
  let at = 8 + tables.length;
  for (const rep of [1, 4, 8]) {
    dv.setUint32(at, rep, true);
    at += 4;
  }
  out.set(content, at);
  return out;
}

let tablesCache: Uint8Array | null = null;

/** entropyTables are the Huffman and FSE tables of the common dictionary (without its offsets). */
function entropyTables(): Uint8Array {
  if (!tablesCache) tablesCache = commonDict.slice(8, entropyEnd(commonDict) - 12);
  return tablesCache;
}

/** entropyEnd is where a zstd dictionary's content starts (RFC 8878 §5): after the Huffman
 * table, the FSE tables of offset, match length and literal length codes and 3 offsets. */
export function entropyEnd(raw: Uint8Array): number {
  if (raw.length < 8 || new DataView(raw.buffer, raw.byteOffset).getUint32(0, true) !== zstdDictMagic) {
    throw new Error("not a zstd dictionary");
  }
  const hb = raw[8];
  let at = 8 + (hb < 128 ? 1 + hb : 1 + Math.ceil((hb - 127) / 2));
  for (const maxLog of [8, 9, 9]) at = ncountEnd(raw, at, maxLog);
  at += 12;
  if (at > raw.length) throw new Error("dictionary truncated");
  return at;
}

/** ncountEnd is the end of an FSE table description (RFC 8878 §4.1.1) that starts at at. */
function ncountEnd(b: Uint8Array, at: number, maxLog: number): number {
  let pos = 0; // in bits
  const bits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      const byte = at + (pos >> 3);
      if (byte >= b.length) throw new Error("dictionary truncated");
      v |= ((b[byte] >> (pos & 7)) & 1) << i;
    }
    return v;
  };
  const log = bits(4) + 5;
  if (log > maxLog) throw new Error("bad dictionary table");
  let remaining = (1 << log) + 1, threshold = 1 << log, nb = log + 1, sym = 0, zero = false;
  while (remaining > 1 && sym < 256) {
    if (zero) { // repeat flags: 2 bits each, 3 — more follow
      for (let r = 3; r === 3; ) sym += r = bits(2);
      zero = false;
    }
    const max = 2 * threshold - 1 - remaining;
    let count = bits(nb - 1);
    if (count >= max) {
      pos -= nb - 1;
      count = bits(nb);
      if (count >= threshold) count -= max;
    }
    count--; // -1 — a "less than 1" probability
    remaining -= Math.abs(count);
    sym++;
    zero = count === 0;
    while (remaining < threshold) {
      nb--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1) throw new Error("bad dictionary table");
  return at + ((pos + 7) >> 3);
}

/** capBytes returns the first samples that fit in n bytes (at least one). */
function capBytes(samples: Uint8Array[], n: number): Uint8Array[] {
  for (let i = 0; i < samples.length; i++) if ((n -= samples[i].length) < 0) return samples.slice(0, Math.max(i, 1));
  return samples;
}

/** dictCost is how many bytes the samples take compressed with a dictionary. */
function dictCost(dict: Uint8Array, samples: Uint8Array[]): number {
  const c = zlib.constants as unknown as Record<string, number>;
  const o = { params: { [c.ZSTD_c_compressionLevel]: 7, [c.ZSTD_c_checksumFlag]: 0 }, dictionary: Buffer.from(dict) };
  let cost = 0;
  for (const s of samples) cost += Math.min(zlib.zstdCompressSync(s, o).length, s.length);
  return cost;
}

const hashLog = 20;

/** Cover holds the samples, the hash of the d-mer at each position and how often each occurs. */
class Cover {
  ok: boolean;
  private all: Uint8Array;
  private hashes: Uint32Array;
  private freqs: Uint32Array;

  constructor(samples: Uint8Array[], private d: number) {
    let total = 0;
    for (const s of samples) total += s.length;
    this.all = new Uint8Array(total + 8); // a d-mer near the end reads 8 bytes
    let at = 0;
    for (const s of samples) {
      this.all.set(s, at);
      at += s.length;
    }
    this.ok = total >= d + 64;
    this.hashes = new Uint32Array(total);
    const a = this.all;
    for (let p = 0; p < total; p++) {
      const lo = (a[p] | (a[p + 1] << 8) | (a[p + 2] << 16) | (a[p + 3] << 24)) >>> 0;
      let hi = (a[p + 4] | (a[p + 5] << 8) | (a[p + 6] << 16) | (a[p + 7] << 24)) >>> 0;
      if (d === 6) hi &= 0xffff;
      let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca77);
      h ^= h >>> 15;
      h = Math.imul(h, 0xc2b2ae3d);
      this.hashes[p] = h >>> (32 - hashLog);
    }
    // frequency of each d-mer over all samples (as zstd: none in a sample's last 8 bytes)
    this.freqs = new Uint32Array(1 << hashLog);
    at = 0;
    for (const s of samples) {
      for (let p = 0; p + Math.max(d, 8) <= s.length; p++) this.freqs[this.hashes[at + p]]++;
      at += s.length;
    }
  }

  /** content picks the dictionary content: the samples are cut into epochs, and from each in
   * turn the segment of k bytes whose distinct d-mers are most frequent over all samples is
   * taken; its d-mers then count zero, so the next segments bring something new. The best
   * segments go last: the closer to the data, the cheaper a reference. */
  content(size: number, k: number): Uint8Array {
    const d = this.d;
    const total = this.all.length - 8;
    if (total < d + k) return new Uint8Array(0);
    const freqs = this.freqs.slice();
    const nbDmers = total - d + 1;
    // epochs, as zstd: about four passes over the dictionary, at least 10 segments per epoch
    let num = Math.max(1, Math.floor(size / k / 4));
    let esize = Math.floor(nbDmers / num);
    if (esize < 10 * k) {
      esize = Math.min(10 * k, nbDmers);
      num = Math.floor(nbDmers / esize);
    }
    const inSeg = new Uint16Array(1 << hashLog);
    const dict = new Uint8Array(size);
    let tail = size;
    for (let epoch = 0, zeroRun = 0; tail > 0; epoch = (epoch + 1) % num) {
      const begin = epoch * esize;
      const [sb, se, score] = this.segment(freqs, inSeg, begin, begin + esize, k);
      if (score === 0) {
        if (++zeroRun >= 10) break;
        continue;
      }
      zeroRun = 0;
      const n = Math.min(se - sb + d - 1, tail);
      if (n < d) break;
      tail -= n;
      dict.set(this.all.subarray(sb, sb + n), tail);
    }
    return dict.subarray(tail);
  }

  /** segment slides a window of k bytes over [begin, end): its score is the sum of the
   * frequencies of its distinct d-mers. It returns the best window trimmed of d-mers that count
   * nothing, and zeroes the frequencies of what it took. */
  private segment(freqs: Uint32Array, inSeg: Uint16Array, begin: number, end: number, k: number): [number, number, number] {
    const h = this.hashes;
    const dmersInK = k - this.d + 1;
    let bestB = 0, bestE = 0, best = 0, score = 0;
    let b = begin, e = begin;
    while (e < end) {
      const i = h[e];
      if (inSeg[i] === 0) score += freqs[i];
      inSeg[i]++;
      e++;
      if (e - b === dmersInK + 1) {
        const j = h[b];
        if (--inSeg[j] === 0) score -= freqs[j];
        b++;
      }
      if (score > best) [bestB, bestE, best] = [b, e, score];
    }
    for (; b < e; b++) inSeg[h[b]]--;
    if (best === 0) return [0, 0, 0];
    let nb = bestE, ne = bestE;
    for (let p = bestB; p < bestE; p++) {
      if (freqs[h[p]] !== 0) {
        if (nb === bestE) nb = p;
        ne = p + 1;
      }
    }
    for (let p = nb; p < ne; p++) freqs[h[p]] = 0;
    return [nb, ne, best];
  }
}
