// Where a device keeps its state (keys, known devices, dictionaries). Reads and writes are
// synchronous, as the node is: a file system does it directly, a browser's IndexedDB keeps the
// whole state in memory and writes it behind (see IdbStorage).

/** Storage is a flat store of named byte blobs. Names are like "net-key.json" or
 * "net-dicts/<id>": a path with "/" and no "..". */
export interface Storage {
  /** read returns a blob, or undefined if there is none. */
  read(name: string): Uint8Array | undefined;
  /** write replaces a blob in one step: a reader never sees it half-written. */
  write(name: string, data: Uint8Array): void;
  /** remove deletes a blob; a missing one is no error. */
  remove(name: string): void;
  /** flush resolves when everything written so far is durable (IndexedDB writes behind). */
  flush?(): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function readText(s: Storage, name: string): string | undefined {
  const b = s.read(name);
  return b === undefined ? undefined : dec.decode(b);
}

export function writeText(s: Storage, name: string, text: string): void {
  s.write(name, enc.encode(text));
}

/** MemoryStorage keeps everything in memory: tests, and nodes that need no restart. */
export class MemoryStorage implements Storage {
  protected files = new Map<string, Uint8Array>();

  read(name: string): Uint8Array | undefined {
    const b = this.files.get(name);
    return b && new Uint8Array(b);
  }

  write(name: string, data: Uint8Array): void {
    this.files.set(name, new Uint8Array(data));
  }

  remove(name: string): void {
    this.files.delete(name);
  }

  /** names lists what is stored (for tests). */
  names(): string[] {
    return [...this.files.keys()].sort();
  }
}
