// Compression (spec §5): zstd with a dictionary. A compressed message is [dictionary slot 1]
// [zstd frame without its magic and dictionary id]: the receiver knows both from the slot in
// the sender's dictionary list. Slot 0 means no dictionary.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { blake2s, equal, hex } from "./crypto.js";

export const zipMin = 64;
// zipFastFrom: from this size on, a faster level — the best one costs more time than the few
// percent of bytes it saves; zipQuickBelow: shorter messages with a dictionary at the fastest
// level (most chat messages; loading a 64 KB dictionary for the best one costs milliseconds).
const zipFastFrom = 32 << 10;
const zipQuickBelow = 1 << 10;
const MAGIC = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);
const DICT_MAGIC = 0xec30a437;

export class Dict {
  readonly id: Uint8Array;
  readonly zid: number; // dictionary id inside zstd (0 for a raw-content dictionary)
  private buf?: Buffer;

  /** peer: "" — a common dictionary, anyone may have it; otherwise it belongs to the pair with
   * this device and is never shown or given to another. own: we trained it (for peer). */
  constructor(readonly raw: Uint8Array, readonly peer = "", readonly own = false) {
    this.id = dictId(raw);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
    this.zid = raw.length >= 8 && dv.getUint32(0, true) === DICT_MAGIC ? dv.getUint32(4, true) : 0;
  }

  /** visible reports whether the dictionary may be used with, listed to or given to peer. */
  visible(peer: string): boolean {
    return this.peer === "" || this.peer === peer;
  }

  get buffer(): Buffer {
    return (this.buf ??= Buffer.from(this.raw));
  }
}

/** dictId is a dictionary's id: the first 16 bytes of BLAKE2s of its bytes. */
export function dictId(raw: Uint8Array): Uint8Array {
  return blake2s(raw).subarray(0, 16);
}

function zopts(d: Dict | null, size: number): zlib.ZstdOptions {
  const c = zlib.constants as unknown as Record<string, number>;
  let level = d ? 7 : 19;
  if (size >= zipFastFrom) level = 3;
  else if (d && size < zipQuickBelow) level = 1;
  const o: zlib.ZstdOptions = { params: { [c.ZSTD_c_compressionLevel]: level, [c.ZSTD_c_checksumFlag]: 0 } };
  if (d) (o as { dictionary?: Buffer }).dictionary = d.buffer;
  return o;
}

/** compress returns [slot | frame] for a receiver that has d (null — none), or null when not worth it. */
export function compress(msg: Uint8Array, d: Dict | null, slot: number): Uint8Array | null {
  if (msg.length < zipMin) return null;
  let frame: Uint8Array | null;
  try {
    frame = stripFrame(new Uint8Array(zlib.zstdCompressSync(msg, zopts(d, msg.length))));
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
  if (d) (o as { dictionary?: Buffer }).dictionary = d.buffer;
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


// dictKeep is how many dictionaries of one kind to keep (common ones, ours for a device, a
// device's own): new ones and those still in flight.
const dictKeep = 4;
// slotsMax: past this many slots, a new dictionary takes the oldest empty one.
const slotsMax = 32;

/** DictStore keeps dictionaries in dir/net-dicts/<id hex>; the order (newest first) is in the
 * file "order", a line per dictionary: "<id hex>" for a common one, "<id hex> <device> own|their"
 * for a pair's. */
export class DictStore {
  dicts: Dict[] = []; // newest first
  readonly dir: string;
  // slots: what we list to each device, by slot. A dictionary keeps its slot while listed (a
  // message compressed with it may still be on its way on another stream, behind the new list);
  // a dropped one leaves an empty id, and a new one goes to the end.
  private slots = new Map<string, Uint8Array[]>();
  private gen = 0; // bumped on every change of the dictionaries
  private cache = new Map<string, { gen: number; ids: Uint8Array[] }>();

  constructor(dir: string) {
    this.dir = path.join(dir, "net-dicts");
    let order = "";
    try {
      order = fs.readFileSync(path.join(this.dir, "order"), "utf8");
    } catch {
      return;
    }
    for (const line of order.split("\n")) {
      const f = line.split(/\s+/).filter(Boolean);
      if (f.length !== 1 && f.length !== 3) continue; // a damaged line: never take a pair's dictionary for a common one
      try {
        const raw = new Uint8Array(fs.readFileSync(path.join(this.dir, f[0])));
        const d = f.length === 3 ? new Dict(raw, f[1], f[2] === "own") : new Dict(raw);
        if (hex(d.id) === f[0]) this.dicts.push(d);
      } catch {
        /* missing file: skip */
      }
    }
  }

  /** get returns dictionary id if peer may see it. */
  get(id: Uint8Array, peer: string): Dict | undefined {
    return this.dicts.find((d) => equal(d.id, id) && d.visible(peer));
  }

  /** add puts a dictionary first (moving it up if known) and deletes the oldest extra ones of its kind. */
  add(d: Dict) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, hex(d.id)), d.raw, { mode: 0o600 });
    const out = [d], dropped: Dict[] = [];
    const kinds = new Map<string, number>([[`${d.peer} ${d.own}`, 1]]);
    for (const x of this.dicts) {
      if (equal(x.id, d.id) && x.peer === d.peer) continue;
      const k = `${x.peer} ${x.own}`;
      const n = (kinds.get(k) ?? 0) + 1;
      kinds.set(k, n);
      if (n > dictKeep) dropped.push(x);
      else out.push(x);
    }
    for (const x of dropped) { // one file serves the same bytes kept as another kind
      if (!listed(out, x.id)) fs.rmSync(path.join(this.dir, hex(x.id)), { force: true });
    }
    this.dicts = out;
    this.gen++;
    this.saveOrder();
  }

  /** saveOrder writes the file "order" through a temporary file: a torn one could turn a pair's
   * dictionary into a common one (though loading skips damaged lines too). */
  private saveOrder() {
    const lines = this.dicts.map((x) => hex(x.id) + (x.peer ? ` ${x.peer} ${x.own ? "own" : "their"}` : ""));
    const file = path.join(this.dir, "order");
    fs.writeFileSync(file + ".tmp", lines.join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }

  /** list is what peer sees of our dictionaries, newest first: the common ones and the pair's. */
  list(peer: string): Dict[] {
    const out: Dict[] = [];
    for (const d of this.dicts) if (d.visible(peer) && !listed(out, d.id)) out.push(d);
    return out;
  }

  /** ids is our list for peer, by slot (an empty id — a free slot). */
  ids(peer: string): Uint8Array[] {
    return [...this.slotsFor(peer)];
  }

  /** slotsFor is ids without the copy, rebuilt only when the dictionaries changed. */
  private slotsFor(peer: string): Uint8Array[] {
    const c = this.cache.get(peer);
    if (c && c.gen === this.gen) return c.ids;
    const list = this.list(peer);
    const slots = this.slots.get(peer) ?? [];
    for (let i = 0; i < slots.length; i++) if (slots[i].length > 0 && !listed(list, slots[i])) slots[i] = new Uint8Array(0);
    for (let j = list.length - 1; j >= 0; j--) { // the oldest first, so the newest gets the last slot
      const d = list[j];
      if (has(slots, d.id)) continue;
      const free = slots.length >= slotsMax ? slots.findIndex((id) => id.length === 0) : -1;
      if (free < 0) slots.push(d.id);
      else slots[free] = d.id;
    }
    this.slots.set(peer, slots);
    this.cache.set(peer, { gen: this.gen, ids: slots });
    return slots;
  }

  /** slotOf is d's slot in our list for peer (from 1). */
  slotOf(peer: string, d: Dict): number {
    return this.slotsFor(peer).findIndex((id) => equal(id, d.id)) + 1;
  }

  /** own returns our newest dictionary trained for peer. */
  own(peer: string): Dict | undefined {
    return this.dicts.find((d) => d.own && d.peer === peer);
  }

  /** pick returns the dictionary to compress for peer and its slot in our list for peer (from 1):
   * ours trained for it if it has it, else the newest it also has (its list is theirs, minus
   * lacks). Nothing in common: no dictionary, slot 0. */
  pick(peer: string, theirs: Uint8Array[], lacks: Uint8Array[]): [Dict | null, number] {
    const list = this.list(peer);
    const ok = (d: Dict) => has(theirs, d.id) && !has(lacks, d.id);
    const d = list.find((d) => d.own && ok(d)) ?? list.find(ok);
    return d ? [d, this.slotOf(peer, d)] : [null, 0];
  }

  /** forget drops what belongs to the pair with peer: our dictionaries for it and its own. */
  forget(peer: string) {
    const keep = this.dicts.filter((d) => d.peer !== peer);
    const drop = this.dicts.filter((d) => d.peer === peer);
    if (drop.length === 0) return;
    this.dicts = keep;
    for (const d of drop) if (!listed(keep, d.id)) fs.rmSync(path.join(this.dir, hex(d.id)), { force: true });
    this.slots.delete(peer);
    this.cache.delete(peer);
    this.gen++;
    try {
      this.saveOrder();
    } catch {
      /* the next add writes it */
    }
  }
}

function listed(list: Dict[], id: Uint8Array): boolean {
  return list.some((d) => equal(d.id, id));
}

export function has(list: Uint8Array[], id: Uint8Array): boolean {
  return list.some((x) => equal(x, id));
}
