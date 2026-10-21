// Our own dictionaries (spec §5): a device trains a dictionary for each device it talks to, on
// that conversation, so the dictionary shows the other side nothing it has not already seen.
// It learns what it sent; while that is little, what it got fills the history up to 256 KB
// (it helps then, and stops helping once there is enough of our own). The first dictionary
// comes at 32 KB of history; then a new one when the history has doubled (up to 1 MB), monthly,
// or when compression got 15 % worse than right after training.
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { Dict, type DictStore } from "./compress.js";
import { blake2s, hex, randomBytes } from "./crypto.js";

const learnFirst = 32 << 10; // history to train the first dictionary on
const learnMax = 1 << 20; // our messages kept: the newest
const learnHeard = 256 << 10; // the received ones fill the history up to this
const learnSample = 4 << 10; // a message is cut to this: a dictionary helps its start most
const learnWindow = 32 << 10; // bytes sent to measure compression over
const learnWorse = 1.15; // retrain when compression is this much worse than the first window
const learnMonth = 30 * 24 * 3600_000;
const learnDictMax = 64 << 10;
// learnQueueMax: bytes waiting for the history; past it messages are skipped — a dictionary
// needs what the conversation is like, not every message of it.
const learnQueueMax = 1 << 20;
// learnOwnMin: a device that sends (almost) nothing worth compressing has no use for a
// dictionary of its own, however much it receives.
const learnOwnMin = 8;
const zipMin = 64;

/** learnTiming: learning is deferred. Sending and receiving only queue the message; once a tick
 * the queue goes into the history in one go, off the sending path, and training waits for a
 * lull in the conversation (no message for lull, or after waiting wait); the monthly and the
 * 15 % checks run once a check. Tests shorten them. */
export const learnTiming = { tick: 1000, lull: 1000, wait: 60_000, check: 24 * 3600_000 };

/** History is one conversation, kept in dir/net-history/<hash of the device's address> as
 * records [length 4][1 — received, 0 — sent][bytes]. */
class History {
  fileSize = 0;
  buf: Uint8Array[] = []; // records not yet written
  bufSize = 0;
  rewrite = false; // the file has outgrown the history: write it anew
  flushing = false;
  gone = false; // the device was forgotten: write nothing more
  own: Uint8Array[] = [];
  heard: Uint8Array[] = [];
  ownSize = 0;
  heardSize = 0;
  trained = 0; // history size when the current dictionary was trained
  at = 0; // when it was trained
  plain = 0; // compression with the current dictionary over the current window
  zips = 0;
  base = 0; // and over the first window after training
  worse = false; // a window came out 15 % worse than the first
  checked = 0; // the last monthly and 15 % check
  due = ""; // a new dictionary is due ("" — not), waiting for a lull since dueAt
  dueAt = 0;
  training = false;

  constructor(readonly path: string) {}

  /** size is how much the next dictionary would be trained on. */
  size(): number {
    return this.ownSize + Math.min(this.heardSize, Math.max(0, learnHeard - this.ownSize));
  }

  add(m: Uint8Array, heard: boolean) {
    if (m.length > learnSample) m = m.subarray(0, learnSample);
    if (heard) {
      this.heard.push(m);
      this.heardSize += m.length;
      while (this.heardSize > learnHeard) this.heardSize -= this.heard.shift()!.length;
    } else {
      this.own.push(m);
      this.ownSize += m.length;
      while (this.ownSize > learnMax) this.ownSize -= this.own.shift()!.length;
    }
  }
}

export function historyPath(dir: string, peer: string): string {
  return path.join(dir, "net-history", hex(blake2s(new TextEncoder().encode(peer)).subarray(0, 8)));
}

function record(m: Uint8Array, heard: boolean): Uint8Array {
  const r = new Uint8Array(5 + m.length);
  new DataView(r.buffer).setUint32(0, m.length);
  r[4] = heard ? 1 : 0;
  r.set(m, 5);
  return r;
}

interface Pending {
  msg: Uint8Array; // not copied: a message is not changed once sent or received
  heard: boolean;
  plain: number; // compressed with our dictionary for the device: its size before and after
  zips: number;
}

interface PeerLearn {
  queue: Pending[];
  queued: number;
  lastTalk: number;
  hist?: History;
}

/** Learner keeps the conversation histories and trains our dictionaries for each device. */
export class Learner {
  private peers = new Map<string, PeerLearn>();
  private chain: Promise<void> = Promise.resolve(); // one dictionary is trained at a time
  private worker?: Worker;
  private closed = false;

  /** onDict gets a dictionary we trained, to store and announce. */
  constructor(private dir: string, private dicts: DictStore, private onDict: (d: Dict) => void) {}

  /** hear queues a conversation message we got from the device. */
  hear(peer: string, msg: Uint8Array) {
    this.queue(peer, { msg, heard: true, plain: 0, zips: 0 });
  }

  /** talk queues a conversation message we send; d and z are the dictionary it was compressed
   * with and the result (null — sent as is). */
  talk(peer: string, msg: Uint8Array, d: Dict | null, z: Uint8Array | null) {
    const p: Pending = { msg, heard: false, plain: 0, zips: 0 };
    if (d?.own) [p.plain, p.zips] = [msg.length, z ? z.length : msg.length];
    this.queue(peer, p);
  }

  private queue(peer: string, p: Pending) {
    if (p.msg.length < zipMin) return;
    let pl = this.peers.get(peer);
    if (!pl) this.peers.set(peer, (pl = { queue: [], queued: 0, lastTalk: 0 }));
    if (pl.queued >= learnQueueMax) return;
    pl.queue.push(p);
    pl.queued += Math.min(p.msg.length, learnSample);
    pl.lastTalk = Date.now();
  }

  /** tick takes the queues into the histories and trains when it is time. */
  tick(now = Date.now()) {
    for (const [peer, pl] of this.peers) {
      if (pl.queue.length === 0 && !pl.hist?.due) continue;
      const q = pl.queue;
      pl.queue = [];
      pl.queued = 0;
      const h = this.history(peer, pl);
      for (const p of q) {
        const m = p.msg.slice(0, learnSample);
        h.add(m, p.heard);
        this.save(h, m, p.heard);
        h.plain += p.plain;
        h.zips += p.zips;
      }
      this.consider(peer, pl, h, now);
    }
  }

  private history(peer: string, pl: PeerLearn): History {
    if (pl.hist) return pl.hist;
    const h = (pl.hist = new History(historyPath(this.dir, peer)));
    let b = new Uint8Array(0);
    try {
      b = new Uint8Array(fs.readFileSync(h.path));
    } catch {
      /* a new conversation */
    }
    h.fileSize = b.length;
    for (let at = 0; at + 5 <= b.length; ) {
      const l = new DataView(b.buffer, b.byteOffset + at).getUint32(0);
      if (l > learnSample || at + 5 + l > b.length || b[at + 4] > 1) break; // a torn record: the rest is lost
      h.add(b.subarray(at + 5, at + 5 + l), b[at + 4] === 1);
      at += 5 + l;
    }
    const d = this.dicts.own(peer);
    if (d) {
      h.trained = h.size();
      try {
        h.at = fs.statSync(path.join(this.dicts.dir, hex(d.id))).mtimeMs;
      } catch {
        /* unknown: the monthly check retrains */
      }
    }
    return h;
  }

  /** save queues a record for the file; when the file has outgrown the history twice, it is
   * written anew from the history. */
  private save(h: History, m: Uint8Array, heard: boolean) {
    h.buf.push(record(m, heard));
    h.bufSize += 5 + m.length;
    if (h.fileSize + h.bufSize > 2 * (learnMax + learnHeard)) h.rewrite = true;
    if (!h.flushing) {
      h.flushing = true;
      void this.flush(h);
    }
  }

  private async flush(h: History) {
    for (;;) {
      const whole = h.rewrite;
      const recs = whole ? [...h.own.map((m) => record(m, false)), ...h.heard.map((m) => record(m, true))] : h.buf;
      h.buf = [];
      h.bufSize = 0;
      h.rewrite = false;
      if (recs.length === 0 || h.gone) {
        h.flushing = false;
        return;
      }
      const data = Buffer.concat(recs);
      try {
        await fs.promises.mkdir(path.dirname(h.path), { recursive: true, mode: 0o700 });
        if (whole) {
          await fs.promises.writeFile(h.path + ".tmp", data, { mode: 0o600 });
          await fs.promises.rename(h.path + ".tmp", h.path);
        } else await fs.promises.appendFile(h.path, data, { mode: 0o600 });
      } catch {
        /* the history lives on in memory */
      }
      if (h.gone) await fs.promises.rm(h.path, { force: true }); // forgotten while writing
      h.fileSize = whole ? data.length : h.fileSize + data.length;
    }
  }

  /** consider decides whether a new dictionary is due and trains it in a lull. */
  private consider(peer: string, pl: PeerLearn, h: History, now: number) {
    if (h.training) return;
    const own = this.dicts.own(peer);
    const size = h.size();
    if (h.plain >= learnWindow) { // compression over the last window of what we sent with it
      const ratio = h.zips / h.plain;
      h.plain = h.zips = 0;
      if (h.base === 0) h.base = ratio;
      else if (ratio >= h.base * learnWorse) h.worse = true;
    }
    if (!h.due && h.own.length >= learnOwnMin) {
      if (!own) {
        if (size >= Math.max(learnFirst, 2 * h.trained)) h.due = "first"; // trained: a try that failed
      } else if (size < learnFirst) {
        // too little to replace what we have (the history was lost, say)
      } else if (h.trained < learnMax && size >= 2 * h.trained) {
        h.due = "doubled";
      } else if (now - h.checked >= learnTiming.check) {
        h.checked = now;
        if (now - h.at > learnMonth || h.worse) h.due = "check";
      }
      if (h.due) h.dueAt = now;
    }
    if (!h.due || (now - pl.lastTalk < learnTiming.lull && now - h.dueAt < learnTiming.wait)) return;
    h.due = "";
    h.worse = false;
    h.training = true;
    const ownMsgs = [...h.own];
    const heard = h.heard.slice(h.heard.length - countFrom(h.heard, Math.max(0, learnHeard - h.ownSize)));
    // tested on our newest messages: the dictionary is for what we send
    let train: Uint8Array[], test: Uint8Array[];
    if (ownMsgs.length >= 8) {
      const split = Math.floor((ownMsgs.length * 3) / 4);
      [train, test] = [[...heard, ...ownMsgs.slice(0, split)], ownMsgs.slice(split)];
    } else {
      const all = [...heard, ...ownMsgs];
      const split = Math.floor((all.length * 3) / 4);
      [train, test] = [all.slice(0, split), all.slice(split)];
    }
    const dictSize = Math.min(learnDictMax, Math.max(Math.floor(size / 4), 4 << 10));
    this.chain = this.chain.then(async () => {
      let raw: Uint8Array | null = null;
      if (!this.closed) raw = await this.train(train, test, dictSize).catch(() => null);
      // a failure waits like a success: until the history doubles or the next check
      h.training = false;
      h.trained = size;
      h.at = Date.now();
      if (this.closed || !raw || this.peers.get(peer) !== pl) return;
      try {
        this.onDict(new Dict(raw, peer, true));
        h.plain = h.zips = h.base = 0;
      } catch {
        /* could not store it */
      }
    });
  }

  /** train runs the trainer in a worker thread: sending never waits for it. */
  private train(train: Uint8Array[], test: Uint8Array[], size: number): Promise<Uint8Array> {
    const id = (new DataView(randomBytes(4).buffer).getUint32(0) % (2 ** 31 - 2 ** 15)) + 2 ** 15; // not a reserved id
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./train-worker.js", import.meta.url), { workerData: { train, test, size, id } });
      this.worker = w;
      const done = () => {
        if (this.worker === w) this.worker = undefined;
        void w.terminate();
      };
      w.once("message", (m: { raw?: Uint8Array; error?: string }) => {
        done();
        if (m.raw) resolve(new Uint8Array(m.raw));
        else reject(new Error(m.error ?? "training failed"));
      });
      w.once("error", (e) => {
        done();
        reject(e);
      });
      w.once("exit", () => reject(new Error("trainer stopped")));
    });
  }

  /** training tells whether a new dictionary for peer is due or being trained, or messages wait to be learnt. */
  training(peer: string): boolean {
    const pl = this.peers.get(peer);
    return !!pl && (pl.queue.length > 0 || !!pl.hist?.training || !!pl.hist?.due);
  }

  /** forget drops the conversation with peer: its history in memory and on disk. */
  forget(peer: string) {
    const pl = this.peers.get(peer);
    if (pl?.hist) pl.hist.gone = true;
    this.peers.delete(peer);
    fs.rmSync(historyPath(this.dir, peer), { force: true });
  }

  /** flushed tells whether everything learnt so far is on disk (tests). */
  flushed(peer: string): boolean {
    const h = this.peers.get(peer)?.hist;
    return !h || (!h.flushing && h.buf.length === 0);
  }

  /** historySize is how much of what we sent and got the history of peer holds (tests). */
  historySize(peer: string): { own: number; heard: number } {
    const pl = this.peers.get(peer) ?? { queue: [], queued: 0, lastTalk: 0 };
    const h = this.history(peer, pl);
    return { own: h.ownSize, heard: h.heardSize };
  }

  close() {
    this.closed = true;
    void this.worker?.terminate();
  }
}

/** countFrom is how many of the newest messages fit in n bytes. */
function countFrom(msgs: Uint8Array[], n: number): number {
  let c = 0;
  for (let i = msgs.length - 1; i >= 0 && n >= msgs[i].length; i--, c++) n -= msgs[i].length;
  return c;
}
