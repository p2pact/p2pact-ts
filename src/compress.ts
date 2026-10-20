// Compression (spec §5): zstd with a dictionary. A compressed message is [dictionary slot 1]
// [zstd frame without its magic and dictionary id]: the receiver knows both from the slot in
// the sender's dictionary list. Slot 0 means no dictionary.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { blake2s, equal, hex } from "./crypto.js";

export const zipMin = 64;
const dictKeep = 4;
const MAGIC = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);
const DICT_MAGIC = 0xec30a437;

export class Dict {
  readonly id: Uint8Array;
  readonly zid: number; // dictionary id inside zstd (0 for a raw-content dictionary)

  constructor(readonly raw: Uint8Array) {
    this.id = dictId(raw);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
    this.zid = raw.length >= 8 && dv.getUint32(0, true) === DICT_MAGIC ? dv.getUint32(4, true) : 0;
  }
}

/** dictId is a dictionary's id: the first 16 bytes of BLAKE2s of its bytes. */
export function dictId(raw: Uint8Array): Uint8Array {
  return blake2s(raw).subarray(0, 16);
}

function zopts(d: Dict | null): zlib.ZstdOptions {
  const c = zlib.constants as unknown as Record<string, number>;
  const o: zlib.ZstdOptions = { params: { [c.ZSTD_c_compressionLevel]: 19, [c.ZSTD_c_checksumFlag]: 0 } };
  if (d) (o as { dictionary?: Buffer }).dictionary = Buffer.from(d.raw);
  return o;
}

/** compress returns [slot | frame] for a receiver that has d (null — none), or null when not worth it. */
export function compress(msg: Uint8Array, d: Dict | null, slot: number): Uint8Array | null {
  if (msg.length < zipMin) return null;
  let frame: Uint8Array | null;
  try {
    frame = stripFrame(new Uint8Array(zlib.zstdCompressSync(msg, zopts(d))));
  } catch {
    return null;
  }
  if (!frame || 1 + frame.length >= msg.length) return null;
  const out = new Uint8Array(1 + frame.length);
  out[0] = slot;
  out.set(frame, 1);
  return out;
}

/** decompress reverses compress; d is the dictionary for the slot in the first byte. */
export function decompress(b: Uint8Array, d: Dict | null, max: number): Uint8Array {
  if (b.length < 2) throw new Error("short");
  const frame = restoreFrame(b.subarray(1), d ? d.zid : 0);
  if (!frame) throw new Error("bad frame");
  const o: zlib.ZstdOptions = { maxOutputLength: max };
  if (d) (o as { dictionary?: Buffer }).dictionary = Buffer.from(d.raw);
  const out = zlib.zstdDecompressSync(frame, o);
  return new Uint8Array(out);
}

/** stripFrame drops the zstd magic (4 bytes) and the dictionary id (up to 4) from a frame. */
export function stripFrame(f: Uint8Array): Uint8Array | null {
  if (f.length < 6 || !equal(f.subarray(0, 4), MAGIC)) return null;
  f = f.subarray(4);
  const fhd = f[0];
  const didLen = [0, 1, 2, 4][fhd & 3];
  let at = 1;
  if ((fhd & 0x20) === 0) at++; // a window descriptor follows
  if (f.length < at + didLen) return null;
  const out = new Uint8Array(f.length - didLen);
  out[0] = fhd & ~3;
  out.set(f.subarray(1, at), 1);
  out.set(f.subarray(at + didLen), at);
  return out;
}

/** restoreFrame puts back the magic and dictionary id zid (0 — no dictionary). */
export function restoreFrame(f: Uint8Array, zid: number): Uint8Array | null {
  if (f.length < 2 || (f[0] & 3) !== 0) return null;
  const fhd = f[0];
  let at = 1;
  if ((fhd & 0x20) === 0) at++;
  if (f.length < at) return null;
  if (zid === 0) {
    const out = new Uint8Array(4 + f.length);
    out.set(MAGIC);
    out.set(f, 4);
    return out;
  }
  const out = new Uint8Array(4 + f.length + 4);
  out.set(MAGIC);
  out[4] = fhd | 3;
  out.set(f.subarray(1, at), 5);
  new DataView(out.buffer).setUint32(4 + at, zid, true);
  out.set(f.subarray(at), 4 + at + 4);
  return out;
}

/** DictStore keeps dictionaries in dir/net-dicts/<id hex>, newest first in "order". */
export class DictStore {
  dicts: Dict[] = [];
  private dir: string;

  constructor(dir: string) {
    this.dir = path.join(dir, "net-dicts");
    let order = "";
    try {
      order = fs.readFileSync(path.join(this.dir, "order"), "utf8");
    } catch {
      return;
    }
    for (const h of order.split(/\s+/).filter(Boolean)) {
      try {
        const d = new Dict(new Uint8Array(fs.readFileSync(path.join(this.dir, h))));
        if (hex(d.id) === h) this.dicts.push(d);
      } catch {
        /* missing file: skip */
      }
    }
  }

  get(id: Uint8Array): Dict | undefined {
    return this.dicts.find((d) => equal(d.id, id));
  }

  add(d: Dict) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, hex(d.id)), d.raw, { mode: 0o600 });
    const out = [d, ...this.dicts.filter((x) => !equal(x.id, d.id))];
    for (const x of out.slice(dictKeep)) fs.rmSync(path.join(this.dir, hex(x.id)), { force: true });
    this.dicts = out.slice(0, dictKeep);
    fs.writeFileSync(path.join(this.dir, "order"), this.dicts.map((x) => hex(x.id)).join("\n") + "\n", { mode: 0o600 });
  }

  ids(): Uint8Array[] {
    return this.dicts.map((d) => d.id);
  }

  /** pick returns our newest dictionary the receiver also has (minus lacks) and its slot. */
  pick(theirs: Uint8Array[], lacks: Uint8Array[]): [Dict | null, number] {
    const has = (l: Uint8Array[], id: Uint8Array) => l.some((x) => equal(x, id));
    for (let i = 0; i < this.dicts.length; i++) {
      const d = this.dicts[i];
      if (has(theirs, d.id) && !has(lacks, d.id)) return [d, i + 1];
    }
    return [null, 0];
  }
}
