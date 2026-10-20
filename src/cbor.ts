// A small CBOR (RFC 8949) codec for P2PACT messages: unsigned and negative integers (number,
// or bigint beyond 2^53), byte strings (Uint8Array), text, arrays, maps (Map), booleans,
// null/undefined and floats. Encoding uses the shortest forms, as the reference
// implementation does.

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>
  | { [k: string]: CborValue };

/** Raw is an already-encoded CBOR item, inserted as is. */
export class Raw {
  constructor(readonly bytes: Uint8Array) {}
}

class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }

  byte(b: number) {
    this.grow(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  head(major: number, n: number | bigint): void {
    const m = major << 5;
    if (typeof n === "bigint") {
      if (n < 2n ** 32n) return this.head(major, Number(n));
      this.byte(m | 27);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n);
      return this.bytes(b);
    }
    if (n < 24) this.byte(m | n);
    else if (n < 0x100) {
      this.byte(m | 24);
      this.byte(n);
    } else if (n < 0x10000) {
      this.byte(m | 25);
      this.byte(n >> 8);
      this.byte(n & 0xff);
    } else if (n < 0x100000000) {
      this.byte(m | 26);
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n);
      this.bytes(b);
    } else {
      this.head(major, BigInt(n));
    }
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

function write(w: Writer, v: unknown): void {
  if (v instanceof Raw) return w.bytes(v.bytes);
  if (v === null) return w.byte(0xf6);
  if (v === undefined) return w.byte(0xf7);
  if (v === false) return w.byte(0xf4);
  if (v === true) return w.byte(0xf5);
  if (typeof v === "number") {
    if (Number.isInteger(v) && Number.isSafeInteger(v)) {
      return v >= 0 ? w.head(0, v) : w.head(1, -1 - v);
    }
    w.byte(0xfb);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return w.bytes(b);
  }
  if (typeof v === "bigint") return v >= 0n ? w.head(0, v) : w.head(1, -1n - v);
  if (typeof v === "string") {
    const b = utf8.encode(v);
    w.head(3, b.length);
    return w.bytes(b);
  }
  if (v instanceof Uint8Array) {
    w.head(2, v.length);
    return w.bytes(v);
  }
  if (Array.isArray(v)) {
    w.head(4, v.length);
    for (const x of v) write(w, x);
    return;
  }
  if (v instanceof Map) {
    w.head(5, v.size);
    for (const [k, x] of v) {
      write(w, k);
      write(w, x);
    }
    return;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as object);
    w.head(5, entries.length);
    for (const [k, x] of entries) {
      write(w, k);
      write(w, x);
    }
    return;
  }
  throw new Error("cbor: cannot encode " + typeof v);
}

/** encode serialises a value to CBOR. */
export function encode(v: unknown): Uint8Array {
  const w = new Writer();
  write(w, v);
  return w.done();
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  need(n: number) {
    if (this.pos + n > this.b.length) throw new Error("cbor: truncated");
  }

  arg(info: number): number | bigint {
    if (info < 24) return info;
    const dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.length);
    switch (info) {
      case 24:
        this.need(1);
        return this.b[this.pos++];
      case 25: {
        this.need(2);
        const v = dv.getUint16(this.pos);
        this.pos += 2;
        return v;
      }
      case 26: {
        this.need(4);
        const v = dv.getUint32(this.pos);
        this.pos += 4;
        return v;
      }
      case 27: {
        this.need(8);
        const v = dv.getBigUint64(this.pos);
        this.pos += 8;
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
    }
    throw new Error("cbor: indefinite lengths are not supported");
  }

  len(info: number): number {
    const n = this.arg(info);
    if (typeof n === "bigint" || n > this.b.length) throw new Error("cbor: length too large");
    return n;
  }

  /** item reads one item; raw keeps nested arrays' elements as encoded bytes when asked. */
  item(): CborValue {
    this.need(1);
    const ib = this.b[this.pos++];
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0:
        return this.arg(info);
      case 1: {
        const n = this.arg(info);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2: {
        const n = this.len(info);
        this.need(n);
        const v = this.b.slice(this.pos, this.pos + n);
        this.pos += n;
        return v;
      }
      case 3: {
        const n = this.len(info);
        this.need(n);
        const v = fromUtf8.decode(this.b.subarray(this.pos, this.pos + n));
        this.pos += n;
        return v;
      }
      case 4: {
        const n = this.len(info);
        const a: CborValue[] = [];
        for (let i = 0; i < n; i++) a.push(this.item());
        return a;
      }
      case 5: {
        const n = this.len(info);
        const m = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = this.item();
          m.set(k, this.item());
        }
        return m;
      }
      case 6:
        this.arg(info); // tag: ignored, the value follows
        return this.item();
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        const dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.length);
        if (info === 25) {
          this.need(2);
          const h = dv.getUint16(this.pos);
          this.pos += 2;
          return half(h);
        }
        if (info === 26) {
          this.need(4);
          const v = dv.getFloat32(this.pos);
          this.pos += 4;
          return v;
        }
        if (info === 27) {
          this.need(8);
          const v = dv.getFloat64(this.pos);
          this.pos += 8;
          return v;
        }
      }
    }
    throw new Error("cbor: unsupported item 0x" + ib.toString(16));
  }

  /** skip returns the encoded bytes of the next item. */
  skip(): Uint8Array {
    const start = this.pos;
    this.item();
    return this.b.subarray(start, this.pos);
  }
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** decode parses one CBOR item; trailing bytes are an error. */
export function decode(b: Uint8Array): CborValue {
  const r = new Reader(b);
  const v = r.item();
  if (r.pos !== b.length) throw new Error("cbor: trailing bytes");
  return v;
}

/** decodeArrayRaw splits a top-level CBOR array into its elements' encoded bytes. */
export function decodeArrayRaw(b: Uint8Array): Uint8Array[] {
  const r = new Reader(b);
  r.need(1);
  const ib = b[r.pos++];
  if (ib >> 5 !== 4) throw new Error("cbor: not an array");
  const n = r.len(ib & 31);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) out.push(r.skip());
  if (r.pos !== b.length) throw new Error("cbor: trailing bytes");
  return out;
}
