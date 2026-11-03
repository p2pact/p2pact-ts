// zstd from node:zlib: the codec of Node.js (spec §5).
import * as zlib from "node:zlib";
import { frameCompress, frameDecompress, type Codec, type Dict } from "./compress.js";

// zipFastFrom: from this size on, a faster level — the best one costs more time than the few
// percent of bytes it saves; zipQuickBelow: shorter messages with a dictionary at the fastest
// level (most chat messages; loading a 64 KB dictionary for the best one costs milliseconds).
const zipFastFrom = 32 << 10;
const zipQuickBelow = 1 << 10;

const buffers = new WeakMap<Dict, Buffer>();
const dictBuffer = (d: Dict): Buffer => {
  let b = buffers.get(d);
  if (!b) buffers.set(d, (b = Buffer.from(d.raw)));
  return b;
};

function zopts(d: Dict | null, size: number): zlib.ZstdOptions {
  const c = zlib.constants as unknown as Record<string, number>;
  let level = d ? 7 : 19;
  if (size >= zipFastFrom) level = 3;
  else if (d && size < zipQuickBelow) level = 1;
  const o: zlib.ZstdOptions = { params: { [c.ZSTD_c_compressionLevel]: level, [c.ZSTD_c_checksumFlag]: 0 } };
  if (d) (o as { dictionary?: Buffer }).dictionary = dictBuffer(d);
  return o;
}

export const zlibCodec: Codec = {
  compress(msg, d) {
    return new Uint8Array(zlib.zstdCompressSync(msg, zopts(d, msg.length)));
  },
  decompress(frame, d, max) {
    const o: zlib.ZstdOptions = { maxOutputLength: max };
    if (d) (o as { dictionary?: Buffer }).dictionary = dictBuffer(d);
    return new Uint8Array(zlib.zstdDecompressSync(frame, o));
  },
};

/** compress returns [slot | frame] with node:zlib, or null when not worth it. */
export const compress = (msg: Uint8Array, d: Dict | null, slot: number) => frameCompress(zlibCodec, msg, d, slot);

/** decompress reverses compress; d is the dictionary for the slot in the first byte. */
export const decompress = (b: Uint8Array, d: Dict | null, max: number) => frameDecompress(zlibCodec, b, d, max);
