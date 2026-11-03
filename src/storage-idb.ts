// IdbStorage: a node's state in IndexedDB (browsers). The node reads and writes synchronously,
// so the whole database is loaded into memory when it is opened, and writes go to IndexedDB
// behind (flush() waits for them). One database per identity: give each its own name.
import { MemoryStorage } from "./storage.js";

const STORE = "files";

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbStorage extends MemoryStorage {
  private pending: Promise<void> = Promise.resolve();
  private failed?: unknown;

  private constructor(private db: IDBDatabase) {
    super();
  }

  /** open opens (or creates) the database `name` and loads what it holds. idb defaults to the
   * global indexedDB. */
  static async open(name: string, idb: IDBFactory = globalThis.indexedDB): Promise<IdbStorage> {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    const db = await wrap(req);
    const s = new IdbStorage(db);
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const [keys, values] = await Promise.all([wrap(store.getAllKeys()), wrap(store.getAll())]);
    keys.forEach((k, i) => s.files.set(String(k), new Uint8Array(values[i] as ArrayBuffer | Uint8Array)));
    return s;
  }

  private put(op: (store: IDBObjectStore) => void): void {
    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve) => {
          const tx = this.db.transaction(STORE, "readwrite");
          op(tx.objectStore(STORE));
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => {
            this.failed = tx.error;
            resolve();
          };
        }),
    );
  }

  override write(name: string, data: Uint8Array): void {
    super.write(name, data);
    const copy = new Uint8Array(data);
    this.put((s) => s.put(copy, name));
  }

  override remove(name: string): void {
    super.remove(name);
    this.put((s) => s.delete(name));
  }

  /** flush resolves when every write so far is in the database; it rejects if one failed. */
  async flush(): Promise<void> {
    await this.pending;
    if (this.failed) {
      const e = this.failed;
      this.failed = undefined;
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /** destroy deletes the database (forgetting the identity). */
  static async destroy(name: string, idb: IDBFactory = globalThis.indexedDB): Promise<void> {
    await wrap(idb.deleteDatabase(name) as unknown as IDBRequest<undefined>);
  }
}
