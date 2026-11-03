// Helpers: events, reading JSON trees, CBOR <-> JSON.
import type { CborValue } from "../cbor.js";
import { toBase64 } from "../bytes.js";
import { blake2s } from "../crypto.js";
import type { StreamId } from "../delivery.js";
import { NotDeliveredError } from "./errors.js";

/** A JSON object as the library reads it: keys are strings, numbers are numbers. */
export type JsonMap = Record<string, unknown>;

/**
 * Events is a stream of values the application listens to: `subscribe` with a callback (it
 * returns the function that unsubscribes), `next` for the next value, or `for await` over it
 * (the iteration starts at the `for await`; `break` ends it). Listeners run on the event loop in
 * the order sent; a listener that throws is skipped.
 */
export class Events<T> {
  private listeners = new Set<(v: T) => void>();

  subscribe(listener: (v: T) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** @internal */
  emit(v: T) {
    for (const l of [...this.listeners]) {
      try {
        l(v);
      } catch {
        /* a failing listener does not stop the others */
      }
    }
  }

  /** next resolves with the next value (that passes `filter`); it rejects after `timeoutMs`
   * (default 10 s; 0 — never). */
  next(opts: { filter?: (v: T) => boolean; timeoutMs?: number } = {}): Promise<T> {
    const ms = opts.timeoutMs ?? 10_000;
    return new Promise<T>((resolve, reject) => {
      const timer = ms > 0 ? setTimeout(() => { off(); reject(new Error(`no event within ${ms} ms`)); }, ms) : undefined;
      const off = this.subscribe((v) => {
        if (opts.filter && !opts.filter(v)) return;
        off();
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const queue: T[] = [];
    let waiting: ((r: IteratorResult<T>) => void) | undefined;
    let done = false;
    const off = this.subscribe((v) => {
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w({ value: v, done: false });
      } else queue.push(v);
    });
    return {
      next: () => {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (waiting = r));
      },
      return: () => {
        done = true;
        off();
        waiting?.({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// --- reading JSON trees ---

export const asMap = (v: unknown): JsonMap | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) ? (v as JsonMap) : undefined;
export const asList = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
export const str = (m: JsonMap, k: string): string | undefined => (typeof m[k] === "string" ? (m[k] as string) : undefined);
export const num = (m: JsonMap, k: string): number | undefined => (typeof m[k] === "number" ? (m[k] as number) : undefined);
export const bool = (m: JsonMap, k: string): boolean | undefined => (typeof m[k] === "boolean" ? (m[k] as boolean) : undefined);
export const obj = (m: JsonMap, k: string): JsonMap | undefined => asMap(m[k]);
export const objs = (m: JsonMap, k: string): JsonMap[] => (asList(m[k]) ?? []).map(asMap).filter((x): x is JsonMap => x !== undefined);
export const strings = (m: JsonMap, k: string): string[] => (asList(m[k]) ?? []).filter((x): x is string => typeof x === "string");

/** The object at `_meta.p2pact` of an ACP object (chat spec §8). */
export const p2pactMeta = (m: JsonMap): JsonMap => obj(obj(m, "_meta") ?? {}, "p2pact") ?? {};

/** normalize makes a decoded CBOR value into a JSON tree: byte strings become base64 text, map
 * keys strings, big integers numbers. */
export function normalize(v: CborValue): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), normalize(x)]));
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Uint8Array) return toBase64(v);
  if (typeof v === "bigint") return Number(v);
  if (v === undefined) return null;
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

/** wire makes a JSON tree ready for CBOR: `undefined` fields are left out. */
export function wire(v: unknown): CborValue {
  if (Array.isArray(v)) return v.map((x) => wire(x === undefined ? null : x));
  if (v instanceof Uint8Array || v instanceof Map) return v as CborValue;
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, wire(x)]));
  }
  return v as CborValue;
}

/** streamOf is the stream of a session or resource: the first 8 bytes of BLAKE2s(id) as an
 * unsigned number, 0 replaced by 1 (chat spec §2); no id — 0. A number while it is safe, else a
 * bigint (see StreamId). */
function hash64(id: string): bigint {
  const h = blake2s(new TextEncoder().encode(id));
  return new DataView(h.buffer, h.byteOffset, h.byteLength).getBigUint64(0);
}

export function streamOf(id: string | undefined): StreamId {
  if (!id) return 0;
  const n = hash64(id) || 1n;
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

/** withTimeout rejects with NotDeliveredError when p takes longer than ms (0 — no limit). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!ms) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new NotDeliveredError(`${what}: no answer in ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** afterEvents resolves once the events the node has already queued (each handled synchronously)
 * have run: a call's result may come ahead of the events sent before it on the same stream. */
export const afterEvents = (): Promise<void> => new Promise((r) => (typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0)));

/** deferred is a promise with its resolve and reject at hand. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
