// The browser's zstd (spec §5): a decoder in wasm (zstd-wasm-decoder, 13 KB) with dictionary
// support, and no compressor — a browser sends every message as it is, which §5 allows, and
// still lists the dictionaries it can decode with. Instances are made synchronously from a module
// compiled once by load(), so the node's synchronous path stays synchronous.
import { ZstdDecoder } from "zstd-wasm-decoder";
import type { Codec, Dict } from "./compress.js";

const MAX_DECODERS = 3; // each instance holds about 12 MB of wasm memory

export class WasmCodec implements Codec {
  private plain?: ZstdDecoder;
  private withDict = new Map<Dict, ZstdDecoder>(); // least recently used first

  private constructor(private module: WebAssembly.Module) {}

  /** load compiles the decoder from the bytes of zstd-decoder.wasm. */
  static async load(wasm: Uint8Array): Promise<WasmCodec> {
    return new WasmCodec(await WebAssembly.compile(wasm as BufferSource));
  }

  compress(): null {
    return null;
  }

  private make(o: { dictionary?: Uint8Array }): ZstdDecoder {
    // init is synchronous (the typings say Promise): a module compiled by load() is instantiated at once
    return new ZstdDecoder(o).init(this.module) as unknown as ZstdDecoder;
  }

  private decoder(d: Dict | null): ZstdDecoder {
    if (!d) return (this.plain ??= this.make({}));
    let z = this.withDict.get(d);
    if (z) {
      this.withDict.delete(d); // to the end: most recently used
    } else {
      if (this.withDict.size >= MAX_DECODERS) {
        const [old, oz] = this.withDict.entries().next().value as [Dict, ZstdDecoder];
        this.withDict.delete(old);
        oz._destroy();
      }
      z = this.make({ dictionary: d.raw });
    }
    this.withDict.set(d, z);
    return z;
  }

  decompress(frame: Uint8Array, d: Dict | null, max: number): Uint8Array {
    const size = contentSize(frame);
    if (size > max) throw new Error("zstd: too big");
    if (size < 0) {
      // the Go library writes frames without a declared size (small messages, dictionary
      // encoders): decode as a stream and check the limit on what came out
      const streamed = this.decoder(d).decompressStream(frame, true).buf;
      if (streamed.length > max) throw new Error("zstd: too big");
      return streamed;
    }
    const out = this.decoder(d).decompressSync(frame, size);
    if (out.length !== size) throw new Error("zstd: size mismatch");
    return out;
  }
}

/** contentSize reads the frame's declared decompressed size; -1 if it declares none (decoded as a
 * stream, the limit checked afterwards). */
export function contentSize(f: Uint8Array): number {
  if (f.length < 6) return -1;
  const fhd = f[4];
  const single = (fhd & 0x20) !== 0;
  const fcsFlag = fhd >> 6;
  const didLen = [0, 1, 2, 4][fhd & 3];
  const fcsLen = fcsFlag === 0 ? (single ? 1 : 0) : 1 << fcsFlag;
  if (fcsLen === 0) return -1;
  const at = 5 + (single ? 0 : 1) + didLen;
  if (f.length < at + fcsLen) return -1;
  const dv = new DataView(f.buffer, f.byteOffset + at, fcsLen);
  switch (fcsLen) {
    case 1: return dv.getUint8(0);
    case 2: return dv.getUint16(0, true) + 256;
    case 4: return dv.getUint32(0, true);
    default: {
      const n = dv.getBigUint64(0, true);
      return n > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(n);
    }
  }
}
