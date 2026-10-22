// Node is a device in a P2PACT network (spec §1–§8): pairing, sessions over any road,
// delivery, messages and compression. Single-threaded: everything runs on the event loop.
import { decode, decodeArrayRaw, encode, type CborValue } from "./cbor.js";
import { compress, decompress, Dict, DictStore, dictId, has } from "./compress.js";
import { address, equal, hex, randomBytes } from "./crypto.js";
import { dataHeader, keepalive, msgMax, Stream } from "./delivery.js";
import { Learner, learnTiming } from "./learn.js";
import { CipherState, concat, Handshake } from "./noise.js";
import { endpointKey, TCPRoad, UDPRoad, type Endpoint, type Road } from "./roads.js";
import { hintsFromWire, hintsToWire, Identity, Invite, Prologue, Trust, type Hints, type Peer } from "./store.js";

const pInit = 1, pResp = 2, pPair1 = 3, pPair2 = 4, pPair3 = 5, pData = 6, pReset = 7;
const tsSkew = 120_000n * 1_000_000n; // ns
const initEvery = 1000;
const autoConnect = 30_000;
const aliveFor = 60_000;
const keepaliveGap = 25_000;
const sessionIdle = 180_000;
const prologue = new TextEncoder().encode(Prologue);

/** holdTiming: held messages (spec §5) wait for the sender's dictionary or its list. That must not
 * last: after ask we ask again (its hello, the dictionary); after drop the held messages are
 * dropped — the sender resends what matters — and the lists are learnt anew. Tests shorten them. */
export const holdTiming = { ask: 15_000, drop: 120_000 };

/** Error codes (spec §6). */
export const ErrNoMethod = 1, ErrBadArgs = 2, ErrNotFound = 3, ErrForbidden = 4, ErrFailed = 5, ErrNotDelivered = 6;

export class P2PACTError extends Error {
  constructor(readonly code: number, text: string) {
    super(text);
  }
}

/** Handler is a tool method: raw CBOR arguments → result values. Its call's turn on the stream
 * lasts until the returned promise settles; a handler that waits long returns {@link later}. */
export type Handler = (peer: string, args: Uint8Array[]) => CborValue[] | Later | Promise<CborValue[] | Later>;

/** Later is a reply taken out of the stream's turn: see {@link later}. */
export class Later {
  /** @internal */
  constructor(readonly reply: PromiseLike<CborValue[]>) {}
}

/** later answers a call later (spec §6): a handler returns later(reply), its turn on the stream
 * ends there, so the stream's next calls and events run (a cancel among them), and the call's
 * result or error goes when reply settles — unless the caller restarted meanwhile.
 *
 *     node.handle(1, 1, (peer, args) => later(runTurn(args)));
 */
export function later(reply: PromiseLike<CborValue[]>): Later {
  Promise.resolve(reply).catch(() => {}); // a rejection is the call's error, handled when the turn ends
  return new Later(reply);
}

class Window {
  private top = 0n;
  private bits = new Set<bigint>();
  accept(n: bigint): boolean {
    if (n + 1n > this.top) {
      for (const b of this.bits) if (b + 2048n <= n) this.bits.delete(b);
      this.top = n + 1n;
    } else if (this.top - n > 2048n || this.bits.has(n)) return false;
    this.bits.add(n);
    return true;
  }
}

interface Session {
  peer: string;
  local: number;
  remote: number;
  send: CipherState;
  recv: CipherState;
  sendN: number;
  win: Window;
  lastRecv: number;
}

interface PendingHandshake {
  pair: boolean;
  hs: Handshake;
  peer?: string;
  invite?: Invite;
  done?: { resolve: () => void; reject: (e: Error) => void };
  at: number;
  remoteIdx?: number;
  early: { pkt: Uint8Array; from: Endpoint }[];
}

interface EpState {
  ep: Endpoint;
  lastRecv: number;
  lastSend: number;
  session: number; // our index of the session its last packet belonged to
}

interface PeerState {
  addr: string;
  st: Stream;
  eps: Map<string, EpState>;
  lastTS: bigint;
  boot: number;
  heard: boolean; // it knows our boot id: sent us session data or answered our handshake
  lastInit: number;
  calls: Map<number, { resolve: (v: Uint8Array[]) => void; reject: (e: Error) => void }>;
  callID: number;
  dicts: Uint8Array[]; // its dictionaries (ids), by slot — from its hello and 0.5
  lacks: Uint8Array[]; // it asked us for these, so it lacks them until it announces again
  waiting: { msg: Uint8Array; zip: boolean; stream: number }[]; // waiting for a dictionary (spec §5)
  waitSince: number; // when the head of waiting started to wait (unhold unblocks it)
  fetching: boolean;
  askingInfo: boolean; // our 0.2 info call is on its way (askInfo)
  askedInfo: number; // when we asked
  tried: Uint8Array[]; // dictionaries of its list we asked it for and did not get
  sysCalls: Set<number>; // our calls of tool 0: their results are not conversation
  inbox: Map<number, (() => Promise<void> | void)[]>; // calls and events waiting for their turn, per stream
}

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0);
const be32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
};
const goos = (): string => ({ win32: "windows" } as Record<string, string>)[process.platform] ?? process.platform;

export class Node {
  readonly id: Identity;
  readonly trust: Trust;
  /** onEvent receives tool events (except tool 0) from known devices: in the order sent on each
   * stream, one at a time, together with that stream's calls (spec §6); a returned promise is
   * awaited before the next one runs. */
  onEvent?: (peer: string, tool: number, event: number, args: Uint8Array[]) => void | Promise<void>;
  onPaired?: (p: Peer) => void;
  onHello?: (peer: string) => void;
  /** onHeld is called when messages from a device waited too long for a dictionary or its list
   * and were dropped (held — how many): the application can tell the user or resend. */
  onHeld?: (peer: string, held: number) => void;
  /** allowDict decides whether a known device may fetch a dictionary (0.5); unset — all may. */
  allowDict?: (peer: string, id: Uint8Array) => boolean;
  /** noCompression turns compression off for what we send (benchmarks, debugging). */
  noCompression = false;
  /** noLearning: do not train our own dictionaries on what we send (spec §5). */
  noLearning = false;

  private boot = u32(randomBytes(4), 0) || 1;
  private udp?: UDPRoad;
  private tcp?: TCPRoad;
  private sessions = new Map<number, Session>();
  private current = new Map<string, Session>();
  private hs = new Map<number, PendingHandshake>();
  private invites = new Map<string, Invite>();
  private peers = new Map<string, PeerState>();
  private handlers = new Map<string, Handler>();
  private resetAt = new Map<string, number>();
  private dicts: DictStore;
  private learner: Learner;
  private timers: NodeJS.Timeout[] = [];
  private woken = false;
  private closed = false;
  private hintsSent: Uint8Array | null = null; // our addresses as last announced (reannounce)
  private hintsAt = 0; // when last checked
  handshakes = 0;

  constructor(dir: string, readonly name: string) {
    this.id = Identity.load(dir);
    this.trust = new Trust(dir);
    this.dicts = new DictStore(dir);
    this.learner = new Learner(dir, this.dicts, (d) => this.addDictLocal(d));
    this.handle(0, 1, () => []);
    this.handle(0, 2, (peer) => this.info(peer));
    this.handle(0, 5, (peer, args) => this.dictHandler(peer, args));
  }

  async listenUDP(addr: string) {
    this.udp = await UDPRoad.listen(addr, (p, f) => this.receive(p, f));
  }

  /** listenTCP opens the fallback road; "" — dial only. */
  async listenTCP(addr: string) {
    this.tcp = await TCPRoad.listen(addr, (p, f) => this.receive(p, f));
  }

  get udpRoad() {
    return this.udp;
  }

  get tcpRoad() {
    return this.tcp;
  }

  start() {
    this.timers.push(setInterval(() => this.pump(), 20), setInterval(() => this.maintain(), 1000),
      setInterval(() => this.learner.tick(), learnTiming.tick));
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.learner.close();
    this.udp?.close();
    this.tcp?.close();
    for (const ps of this.peers.values()) for (const c of ps.calls.values()) c.reject(new Error("node closed"));
  }

  /** handle registers method tool.method. Calls of one device on one stream run one at a time,
   * in the order sent, together with its events there (spec §6); other streams do not wait. A
   * handler that waits long returns {@link later}, so that the stream goes on without it. */
  handle(tool: number, method: number, h: Handler) {
    this.handlers.set(`${tool}.${method}`, h);
  }

  // --- pairing ---

  invite(ttlMs: number): Invite {
    const inv = new Invite(this.id.key.public, this.name, randomBytes(32), new Date(Date.now() + ttlMs), this.hints());
    this.invites.set(hex(inv.id), inv);
    return inv;
  }

  /** join pairs using an invite, trying all its hints until one answers. */
  async join(inv: Invite, timeoutMs = 30_000): Promise<Peer> {
    const eps: Endpoint[] = [];
    if (this.udp) for (const a of inv.hints.udp ?? []) eps.push({ road: this.udp, addr: a });
    if (this.tcp) for (const a of inv.hints.tcp ?? []) eps.push({ road: this.tcp, addr: a });
    if (eps.length === 0) throw new Error("the invite has no road we can use");
    const deadline = Date.now() + timeoutMs;
    let local = 0;
    for (;;) {
      this.hs.delete(local);
      const hs = new Handshake({ pattern: "XXpsk2", initiator: true, prologue, s: this.id.key, psk: inv.secret });
      const msg1 = hs.writeMessage();
      local = this.newIndex();
      const done = new Promise<void>((resolve, reject) => {
        this.hs.set(local, { pair: true, hs, invite: inv, done: { resolve, reject }, at: Date.now(), early: [] });
      });
      const pkt = concat(Uint8Array.of(pPair1), inv.id, be32(local), msg1);
      for (const e of eps) e.road.send(e.addr, pkt);
      const r = await Promise.race([done.then(() => "ok"), new Promise((r) => setTimeout(() => r("again"), initEvery))]);
      if (r === "ok") {
        const p = this.trust.get(address(inv.key));
        if (!p) throw new Error("pairing was not saved");
        return p;
      }
      if (Date.now() > deadline) {
        this.hs.delete(local);
        throw new Error("pairing timed out");
      }
    }
  }

  private pairPayload(): Uint8Array {
    return encode([this.name, this.boot, hintsToWire(this.hints()), this.id.sign.public, goos()]);
  }

  /** befriend adds a device known from the family book, without pairing. */
  befriend(p: Peer) {
    if (p.key.length !== 32 || address(p.key) !== p.addr) throw new Error("key does not match address");
    const old = this.trust.get(p.addr);
    if (old) {
      this.trust.put({ ...old, name: p.name, signKey: p.signKey, os: p.os });
      return;
    }
    this.trust.put({ ...p, pairSecret: this.id.shared(p.key, "family-pair") });
  }

  /** forget drops a known device; our conversation's dictionaries and history go too. */
  forget(addr: string) {
    this.dicts.forget(addr);
    this.learner.forget(addr);
    for (const c of this.peers.get(addr)?.calls.values() ?? []) c.reject(new Error("device forgotten"));
    this.peers.delete(addr);
    const s = this.current.get(addr);
    if (s) {
      this.current.delete(addr);
      this.sessions.delete(s.local);
    }
    this.trust.remove(addr);
  }

  // --- calls and events ---

  /** call invokes tool.method on a known device (stream 0, in order); raw CBOR result elements. */
  call(peer: string, tool: number, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
    return this.callOn(peer, 0, tool, method, ...args);
  }

  /** callOn is call on a stream: ordered within it, independent of other streams (one per chat). */
  callOn(peer: string, stream: number, tool: number, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
    if (this.closed) return Promise.reject(new Error("node closed"));
    const ps = this.peerState(peer);
    if (!ps) return Promise.reject(new Error("unknown device"));
    const id = ++ps.callID;
    if (tool === 0) ps.sysCalls.add(id);
    return new Promise((resolve, reject) => {
      ps.calls.set(id, {
        resolve: (v) => {
          ps.calls.delete(id);
          ps.sysCalls.delete(id);
          resolve(v);
        },
        reject: (e) => {
          ps.calls.delete(id);
          ps.sysCalls.delete(id);
          reject(e);
        },
      });
      this.push(ps, encode([0, id, tool, method, ...args]), stream, tool !== 0);
    });
  }

  event(peer: string, tool: number, ev: number, ...args: unknown[]) {
    this.eventOn(peer, 0, tool, ev, ...args);
  }

  eventOn(peer: string, stream: number, tool: number, ev: number, ...args: unknown[]) {
    const ps = this.peerState(peer);
    if (!ps) throw new Error("unknown device");
    this.push(ps, encode([3, tool, ev, ...args]), stream, tool !== 0);
  }

  /** paths lists live roads to a known device. */
  paths(peer: string): string[] {
    const ps = this.peers.get(peer);
    if (!ps) return [];
    const now = Date.now();
    return [...new Set([...ps.eps.values()].filter((e) => now - e.lastRecv <= aliveFor).map((e) => e.ep.road.name))];
  }

  /** info is the hello (spec §6, 0.2); the dictionaries are those peer may see. */
  private info(peer: string): CborValue[] {
    const tools = new Map<CborValue, CborValue>();
    for (const k of this.handlers.keys()) {
      const t = Number(k.split(".")[0]);
      if (t !== 0) tools.set(t, 1);
    }
    return [this.name, goos(), "p2pact-ts", tools, this.dicts.ids(peer), hintsToWire(this.hints())];
  }

  private hints(): Hints {
    const h: Hints = {};
    const udp = this.udp?.localAddrs();
    if (udp?.length) h.udp = udp;
    const tcp = this.tcp?.localAddrs();
    if (tcp?.length) h.tcp = tcp;
    return h;
  }

  // --- receiving ---

  private receive(pkt: Uint8Array, from: Endpoint) {
    if (pkt.length < 5) return;
    const now = Date.now();
    try {
      switch (pkt[0]) {
        case pData:
          return this.onData(now, pkt, from);
        case pInit:
          return this.onInit(now, pkt, from);
        case pResp:
          return this.onResp(now, pkt, from);
        case pPair1:
          return this.onPair1(now, pkt, from);
        case pPair2:
          return this.onPair2(now, pkt, from);
        case pPair3:
          return this.onPair3(now, pkt, from);
        case pReset: {
          const idx = u32(pkt, 1);
          for (const s of [...this.sessions.values()]) {
            if (s.remote === idx) {
              this.sessions.delete(s.local);
              if (this.current.get(s.peer) === s) this.current.delete(s.peer);
            }
          }
        }
      }
    } catch {
      /* a malformed packet is dropped */
    }
  }

  private onData(now: number, pkt: Uint8Array, from: Endpoint) {
    if (pkt.length < dataHeader + 16) return;
    const idx = u32(pkt, 1);
    const s = this.sessions.get(idx);
    if (!s) {
      const h = this.hs.get(idx);
      if (h && !h.pair && h.early.length < 16) {
        h.early.push({ pkt: pkt.slice(), from }); // data overtook the handshake reply
        return;
      }
      const k = endpointKey(from);
      if (now - (this.resetAt.get(k) ?? 0) >= 5000) {
        this.resetAt.set(k, now);
        from.road.send(from.addr, concat(Uint8Array.of(pReset), be32(idx)));
      }
      return;
    }
    const cnt = u32(pkt, 5);
    const plain = s.recv.decryptAt(BigInt(cnt), pkt.subarray(0, dataHeader), pkt.subarray(dataHeader));
    if (!plain || !s.win.accept(BigInt(cnt))) return;
    s.lastRecv = now;
    if (!this.current.has(s.peer)) this.current.set(s.peer, s);
    const ps = this.peerState(s.peer)!;
    ps.heard = true;
    this.seen(ps, from, now, s.local);
    ps.st.receive(now, plain, (m, z, st) => this.inbound(s.peer, m, z, st));
    if (ps.st.ackDue !== 0 && now >= ps.st.ackDue) this.wake();
  }

  private onInit(now: number, pkt: Uint8Array, from: Endpoint) {
    const hs = new Handshake({ pattern: "IK", initiator: false, prologue, s: this.id.key });
    const payload = hs.readMessage(pkt.subarray(5));
    if (payload.length < 12) return;
    const peer = address(hs.rs!);
    if (!this.trust.get(peer)) return; // silence to strangers
    const ps = this.peerState(peer)!;
    const ts = new DataView(payload.buffer, payload.byteOffset, 8).getBigUint64(0);
    const age = BigInt(now) * 1_000_000n - ts;
    if (ts <= ps.lastTS || age > tsSkew || age < -tsSkew) return; // replay
    ps.lastTS = ts;
    const local = this.newIndex();
    const resp = hs.writeMessage(be32(this.boot));
    const [c1, c2] = hs.ciphers!;
    const s: Session = { peer, local, remote: u32(pkt, 1), send: c2, recv: c1, sendN: 0, win: new Window(), lastRecv: now };
    this.sessions.set(local, s);
    this.current.set(peer, s);
    this.handshakes++;
    this.seen(ps, from, now, s.local);
    this.bootOf(ps, u32(payload, 8));
    from.road.send(from.addr, concat(Uint8Array.of(pResp), be32(s.remote), be32(local), resp));
    // data in the first packet; from a device that has not heard our boot id it may be
    // numbered for our previous boot, to be renumbered once it gets our reply: drop it
    // unacknowledged, it comes again in the session
    if (payload.length > 12 && ps.heard) ps.st.receive(now, payload.subarray(12), (m, z, st) => this.inbound(peer, m, z, st));
    this.sendInfo(peer);
  }

  private onResp(now: number, pkt: Uint8Array, from: Endpoint) {
    if (pkt.length < 9) return;
    const local = u32(pkt, 1);
    const h = this.hs.get(local);
    if (!h || h.pair) return;
    const payload = h.hs.readMessage(pkt.subarray(9));
    if (payload.length < 4 || !h.hs.ciphers) return;
    this.hs.delete(local);
    const [c1, c2] = h.hs.ciphers;
    const s: Session = { peer: h.peer!, local, remote: u32(pkt, 5), send: c1, recv: c2, sendN: 0, win: new Window(), lastRecv: now };
    this.sessions.set(local, s);
    this.current.set(h.peer!, s);
    this.handshakes++;
    const ps = this.peerState(h.peer!)!;
    ps.heard = true;
    this.seen(ps, from, now, s.local);
    this.bootOf(ps, u32(payload, 0));
    this.sendInfo(h.peer!);
    for (const e of h.early) this.onData(now, e.pkt, e.from);
  }

  private onPair1(now: number, pkt: Uint8Array, from: Endpoint) {
    if (pkt.length < 21) return;
    const inv = this.invites.get(hex(pkt.subarray(1, 17)));
    if (!inv || now > inv.exp.getTime()) return;
    const hs = new Handshake({ pattern: "XXpsk2", initiator: false, prologue, s: this.id.key, psk: inv.secret });
    hs.readMessage(pkt.subarray(21));
    const msg2 = hs.writeMessage(this.pairPayload());
    const local = this.newIndex();
    const remoteIdx = u32(pkt, 17);
    this.hs.set(local, { pair: true, hs, invite: inv, at: now, remoteIdx, early: [] });
    from.road.send(from.addr, concat(Uint8Array.of(pPair2), be32(remoteIdx), be32(local), msg2));
  }

  private onPair2(now: number, pkt: Uint8Array, from: Endpoint) {
    if (pkt.length < 9) return;
    const local = u32(pkt, 1);
    const h = this.hs.get(local);
    if (!h || !h.pair || !h.done) return;
    let payload: Uint8Array;
    try {
      payload = h.hs.readMessage(pkt.subarray(9));
    } catch {
      return; // wrong secret or a stranger
    }
    const inv = h.invite!;
    if (!equal(h.hs.rs!, inv.key)) {
      this.hs.delete(local);
      h.done.reject(new Error("device key does not match the invite"));
      return;
    }
    const pp = decode(payload) as CborValue[];
    const msg3 = h.hs.writeMessage(this.pairPayload());
    const [c1, c2] = h.hs.ciphers!;
    this.hs.delete(local);
    const peer = address(inv.key);
    const hints = hintsFromWire(pp[2] ?? null);
    hints.udp ??= inv.hints.udp;
    hints.tcp ??= inv.hints.tcp;
    hints.relay ??= inv.hints.relay;
    const p: Peer = { addr: peer, key: inv.key, name: String(pp[0] ?? ""), pairSecret: inv.secret, hints, added: 0,
      signKey: pp[3] instanceof Uint8Array ? pp[3] : undefined, os: typeof pp[4] === "string" ? pp[4] : undefined };
    this.trust.put(p);
    const s: Session = { peer, local, remote: u32(pkt, 5), send: c1, recv: c2, sendN: 0, win: new Window(), lastRecv: now };
    this.sessions.set(local, s);
    this.current.set(peer, s);
    const ps = this.peerState(peer)!;
    this.seen(ps, from, now, s.local);
    this.bootOf(ps, Number(pp[1] ?? 0));
    from.road.send(from.addr, concat(Uint8Array.of(pPair3), be32(s.remote), msg3));
    this.paired(p);
    h.done.resolve();
  }

  private onPair3(now: number, pkt: Uint8Array, from: Endpoint) {
    const local = u32(pkt, 1);
    const h = this.hs.get(local);
    if (!h || !h.pair || h.done) return;
    const payload = h.hs.readMessage(pkt.subarray(5));
    if (!h.hs.ciphers) return;
    const [c1, c2] = h.hs.ciphers;
    this.hs.delete(local);
    const inv = h.invite!;
    this.invites.delete(hex(inv.id)); // single use
    const key = h.hs.rs!;
    const peer = address(key);
    const pp = decode(payload) as CborValue[];
    const p: Peer = { addr: peer, key: key.slice(), name: String(pp[0] ?? ""), pairSecret: inv.secret,
      hints: hintsFromWire(pp[2] ?? null), added: 0, signKey: pp[3] instanceof Uint8Array ? pp[3] : undefined,
      os: typeof pp[4] === "string" ? pp[4] : undefined, via: hex(inv.id) };
    this.trust.put(p);
    const s: Session = { peer, local, remote: h.remoteIdx!, send: c2, recv: c1, sendN: 0, win: new Window(), lastRecv: now };
    this.sessions.set(local, s);
    this.current.set(peer, s);
    const ps = this.peerState(peer)!;
    this.seen(ps, from, now, s.local);
    this.bootOf(ps, Number(pp[1] ?? 0));
    this.paired(p);
  }

  private paired(p: Peer) {
    this.sendInfo(p.addr);
    if (this.onPaired) queueMicrotask(() => this.onPaired!(p));
  }

  private bootOf(ps: PeerState, boot: number) {
    if (ps.boot !== 0 && ps.boot !== boot) ps.st.reset();
    ps.boot = boot;
  }

  private sendInfo(peer: string) {
    this.hintsSent = encode(hintsToWire(this.hints())); // what the devices know of us (reannounce)
    this.push(this.peerState(peer)!, encode([3, 0, 2, ...this.info(peer)]));
  }

  private message(peer: string, msg: Uint8Array, stream = 0) {
    let a: Uint8Array[];
    try {
      a = decodeArrayRaw(msg);
    } catch {
      return;
    }
    if (a.length < 2) return;
    const kind = decode(a[0]);
    const ps = this.peerState(peer);
    if (!ps) return;
    if (kind === 0) {
      if (a.length < 4) return;
      const id = decode(a[1]) as number;
      const tool = decode(a[2]);
      if (tool !== 0) this.hear(peer, msg);
      const method = decode(a[3]);
      const h = this.handlers.get(`${tool}.${method}`);
      const args = a.slice(4);
      const boot = ps.boot;
      const reply = async (res: CborValue[] | PromiseLike<CborValue[]>) => {
        let out: unknown[];
        try {
          out = [1, id, ...(await res)];
        } catch (e) {
          const err = e instanceof P2PACTError ? e : new P2PACTError(ErrFailed, (e as Error).message);
          out = [2, id, err.code, err.message];
        }
        // the result goes back on the call's stream, unless the caller restarted meanwhile
        const ps2 = this.peerState(peer);
        if (!ps2 || (boot !== 0 && ps2.boot !== boot)) return;
        if (tool === 0 && method === 2) { // a hello, like the event: never compressed
          ps2.st.push(encode(out), false, stream, true);
          this.wake();
        } else this.push(ps2, encode(out), stream, tool !== 0, true);
      };
      const run = async () => {
        if (!h) return reply(Promise.reject(new P2PACTError(ErrNoMethod, "no such method")));
        let res: CborValue[] | Later;
        try {
          res = await h(peer, args);
        } catch (e) {
          return reply(Promise.reject(e));
        }
        if (res instanceof Later) void reply(res.reply); // the turn ends here; the reply goes when ready
        else return reply(res);
      };
      if (tool === 0) void run(); // service calls (a dictionary, a ping) never wait behind a slow handler
      else this.enqueue(ps, stream, run);
    } else if (kind === 1 || kind === 2) {
      const id = decode(a[1]) as number;
      const c = ps.calls.get(id);
      if (!c) return;
      if (!ps.sysCalls.has(id)) this.hear(peer, msg);
      if (kind === 1) c.resolve(a.slice(2));
      else c.reject(new P2PACTError(a.length > 2 ? Number(decode(a[2])) : ErrFailed, a.length > 3 ? String(decode(a[3])) : ""));
    } else if (kind === 3) {
      if (a.length < 3) return;
      const tool = decode(a[1]) as number;
      const ev = decode(a[2]) as number;
      if (tool === 0 && ev === 2 && a.length >= 9) {
        this.trust.setHints(peer, String(decode(a[3]) ?? ""), String(decode(a[4]) ?? ""), hintsFromWire(decode(a[8])));
        ps.dicts = idsOf(decode(a[7]));
        ps.lacks = [];
        ps.tried = [];
        this.fetchNew(peer, ps);
        this.drain(peer, ps);
        if (this.onHello) queueMicrotask(() => this.onHello!(peer));
        return;
      }
      if (tool === 0 && ev === 5 && a.length >= 4) {
        ps.dicts = idsOf(decode(a[3]));
        ps.lacks = [];
        ps.tried = [];
        this.fetchNew(peer, ps);
        this.drain(peer, ps);
        return;
      }
      if (tool !== 0) this.hear(peer, msg);
      const on = this.onEvent;
      if (on) {
        const args = a.slice(3);
        this.enqueue(ps, stream, () => on(peer, tool, ev, args));
      }
    }
  }

  /** enqueue runs f behind the stream's earlier calls and events, one at a time, in the order
   * they came (spec §6). Each stream drains on its own: a slow handler holds up its stream only. */
  private enqueue(ps: PeerState, stream: number, f: () => Promise<void> | void) {
    const q = ps.inbox.get(stream);
    if (q) {
      q.push(f);
      return;
    }
    const queue = [f];
    ps.inbox.set(stream, queue);
    void (async () => {
      await Promise.resolve(); // never inside the caller: as an event handler would run
      for (let g = queue.shift(); g; g = queue.shift()) {
        try {
          await g();
        } catch {
          /* an app's handler failing does not stop its stream */
        }
      }
      ps.inbox.delete(stream);
    })();
  }

  // --- sending ---

  private peerState(peer: string): PeerState | undefined {
    let ps = this.peers.get(peer);
    if (!ps) {
      if (!this.trust.get(peer)) return undefined;
      ps = { addr: peer, st: new Stream(), eps: new Map(), lastTS: 0n, boot: 0, heard: false, lastInit: 0, calls: new Map(), callID: 0, dicts: [],
        lacks: [], waiting: [], waitSince: 0, fetching: false, askingInfo: false, askedInfo: 0, tried: [], sysCalls: new Set(), inbox: new Map() };
      this.peers.set(peer, ps);
    }
    return ps;
  }

  private seen(ps: PeerState, from: Endpoint, now: number, session: number) {
    const k = endpointKey(from);
    let e = ps.eps.get(k);
    if (!e) {
      e = { ep: from, lastRecv: 0, lastSend: 0, session };
      ps.eps.set(k, e);
    }
    e.lastRecv = now;
    e.session = session;
  }

  private candidates(peer: string, ps: PeerState, now: number, all: boolean): EpState[] {
    let alive = [...ps.eps.values()].filter((e) => now - e.lastRecv <= aliveFor);
    const cur = this.current.get(peer);
    if (cur && !all) { // roads of the current session: earlier ones may be gone
      const mine = alive.filter((e) => e.session === cur.local);
      if (mine.length) alive = mine;
    }
    if (alive.length > 0 && !all) {
      const rank = (e: EpState) => ({ udp: 0, tcp: 1 } as Record<string, number>)[e.ep.road.name] ?? 2;
      // the road heard from last; a better kind only if heard within half a second of it
      let best = alive.reduce((b, e) => (e.lastRecv > b.lastRecv ? e : b));
      for (const e of alive) if (rank(e) < rank(best) && best.lastRecv - e.lastRecv < 500) best = e;
      return [best];
    }
    const out = alive;
    const p = this.trust.get(peer);
    if (!p) return out;
    const add = (road: Road | undefined, addrs: string[] | undefined) => {
      if (!road) return;
      for (const a of addrs ?? []) {
        const ep = { road, addr: a };
        const k = endpointKey(ep);
        if (!ps.eps.has(k)) ps.eps.set(k, { ep, lastRecv: 0, lastSend: 0, session: 0 });
        const e = ps.eps.get(k)!;
        if (!out.includes(e)) out.push(e);
      }
    };
    add(this.udp, p.hints.udp);
    add(this.tcp, p.hints.tcp);
    return out;
  }

  private sendData(now: number, peer: string, ps: PeerState, s: Session, plain: Uint8Array, all: boolean) {
    const hdr = concat(Uint8Array.of(pData), be32(s.remote), be32(s.sendN));
    const pkt = concat(hdr, s.send.encryptAt(BigInt(s.sendN), hdr, plain));
    s.sendN++;
    for (const e of this.candidates(peer, ps, now, all)) {
      e.ep.road.send(e.ep.addr, pkt);
      e.lastSend = now;
    }
  }

  private startInit(now: number, peer: string, ps: PeerState, first: Uint8Array | null) {
    const p = this.trust.get(peer);
    if (!p || now - ps.lastInit < initGap(ps)) return;
    ps.lastInit = now;
    // keep the last few unanswered starts: a reply to any of them opens the session
    const pending = [...this.hs.entries()].filter(([, h]) => !h.pair && h.peer === peer).sort((a, b) => a[1].at - b[1].at);
    while (pending.length >= 3) this.hs.delete(pending.shift()![0]);
    const hs = new Handshake({ pattern: "IK", initiator: true, prologue, s: this.id.key, rs: p.key });
    const ts = new Uint8Array(8);
    new DataView(ts.buffer).setBigUint64(0, BigInt(now) * 1_000_000n);
    const msg1 = hs.writeMessage(concat(ts, be32(this.boot), first ?? new Uint8Array(0)));
    const local = this.newIndex();
    this.hs.set(local, { pair: false, hs, peer, at: now, early: [] });
    const pkt = concat(Uint8Array.of(pInit), be32(local), msg1);
    for (const e of this.candidates(peer, ps, now, true)) {
      e.ep.road.send(e.ep.addr, pkt);
      e.lastSend = now;
    }
  }

  private wake() {
    if (this.woken || this.closed) return;
    this.woken = true;
    setImmediate(() => {
      this.woken = false;
      if (!this.closed) this.pump();
    });
  }

  private pump() {
    const now = Date.now();
    for (const [peer, ps] of this.peers) {
      const s = this.current.get(peer);
      if (!s) {
        if (!ps.st.idle() && now - ps.lastInit >= initGap(ps) && this.trust.get(peer)) {
          const first = ps.st.nextPacket(now, false);
          this.startInit(now, peer, ps, first?.plain ?? null);
        }
        continue;
      }
      if (!ps.st.idle() && now - s.lastRecv > 10_000 && ps.st.stuck()) {
        this.current.delete(peer);
        continue;
      }
      const c = this.candidates(peer, ps, now, false);
      if (c.length === 1) ps.st.reliable = c[0].ep.road.name !== "udp";
      for (let i = 0; ; i++) {
        if (i === 256) {
          this.wake();
          break;
        }
        const next = ps.st.nextPacket(now, false);
        if (!next) break;
        this.sendData(now, peer, ps, s, next.plain, next.retry);
      }
      for (const e of ps.eps.values()) {
        if (now - e.lastRecv <= aliveFor && now - e.lastSend >= keepaliveGap) {
          const hdr = concat(Uint8Array.of(pData), be32(s.remote), be32(s.sendN));
          const pkt = concat(hdr, s.send.encryptAt(BigInt(s.sendN), hdr, keepalive()));
          s.sendN++;
          e.ep.road.send(e.ep.addr, pkt);
          e.lastSend = now;
        }
      }
    }
  }

  private maintain() {
    const now = Date.now();
    for (const p of this.trust.list()) {
      const ps = this.peerState(p.addr);
      if (ps && !this.current.has(p.addr) && now - ps.lastInit >= autoConnect) this.startInit(now, p.addr, ps, null);
    }
    for (const [idx, s] of this.sessions) if (this.current.get(s.peer) !== s && now - s.lastRecv > sessionIdle) this.sessions.delete(idx);
    for (const [idx, h] of this.hs) if (now - h.at > 60_000) this.hs.delete(idx);
    for (const [id, inv] of this.invites) if (now > inv.exp.getTime()) this.invites.delete(id);
    this.unhold(now);
    this.reannounce(now);
  }

  /** unhold: held messages do not wait forever (holdTiming). */
  private unhold(now: number) {
    for (const [peer, ps] of this.peers) {
      if (ps.waiting.length === 0) continue;
      const held = now - ps.waitSince;
      if (held >= holdTiming.drop) {
        const k = ps.waiting.length;
        ps.waiting = [];
        ps.fetching = ps.askingInfo = false;
        ps.dicts = [];
        ps.lacks = [];
        ps.tried = [];
        this.sendInfo(peer); // ours again: the other side re-learns what we have
        if (this.onHeld) queueMicrotask(() => this.onHeld!(peer, k));
      } else if (held >= holdTiming.ask) {
        if (ps.dicts.length === 0) this.askInfo(peer, ps);
        else {
          ps.tried = [];
          this.drain(peer, ps);
        }
      }
    }
  }

  /** reannounce: our addresses changed (another network) — tell the devices in session at once
   * with our hello, not at the next handshake: after a network switch they would keep trying the
   * old address until a relay or a restart brought them together. */
  private reannounce(now: number) {
    if (now - this.hintsAt < 5000) return;
    this.hintsAt = now;
    const cur = encode(hintsToWire(this.hints()));
    if (!this.hintsSent || equal(cur, this.hintsSent)) return; // nothing announced yet, or the same
    for (const peer of this.current.keys()) this.sendInfo(peer);
  }

  private newIndex(): number {
    for (;;) {
      const i = u32(randomBytes(4), 0);
      if (i !== 0 && !this.sessions.has(i) && !this.hs.has(i)) return i;
    }
  }

  // --- compression (spec §5) ---

  /** push queues a message, compressed when worth it: with our dictionary for this device, else
   * the newest one it also has. The slot refers to our list at send time: the list changes only
   * through event 0.5, which travels in the same order as messages. talk: the message is
   * conversation (not tool 0), so it goes to the history (learn.ts); reply: a result or error,
   * dropped if the other device restarts (spec §4.2). */
  private push(ps: PeerState, msg: Uint8Array, stream = 0, talk = false, reply = false) {
    if (this.noCompression || bootstrap(msg)) {
      ps.st.push(msg, false, stream, reply);
      this.wake();
      return;
    }
    const [d, slot] = this.dicts.pick(ps.addr, ps.dicts, ps.lacks);
    const z = compress(msg, d, slot);
    if (talk && !this.noLearning) this.learner.talk(ps.addr, msg, d, z);
    if (z) ps.st.push(z, true, stream, reply);
    else ps.st.push(msg, false, stream, reply);
    this.wake();
  }

  /** hear queues a conversation message we got from the device for the history. */
  private hear(peer: string, msg: Uint8Array) {
    if (!this.noCompression && !this.noLearning) this.learner.hear(peer, msg);
  }

  /** inbound decompresses a reassembled message and runs it in order. A missing dictionary is
   * not an error: we hold the message and everything after it and ask the sender for the
   * dictionary; if we do not know the sender's list yet (it restarted), we wait for its hello.
   * While waiting, only replies to our calls (the dictionary among them), hellos and dictionary
   * lists run out of order: nothing depends on their order. */
  private inbound(peer: string, msg: Uint8Array, zip: boolean, stream = 0) {
    const ps = this.peerState(peer);
    if (!ps) return;
    if (ps.waiting.length > 0) {
      const r = this.unzip(ps, msg, zip);
      if (r.plain && outOfOrder(r.plain)) {
        this.message(peer, r.plain, stream);
        this.drain(peer, ps);
        return;
      }
    }
    if (ps.waiting.length === 0) ps.waitSince = Date.now();
    ps.waiting.push({ msg, zip, stream });
    this.drain(peer, ps);
  }

  /** drain runs waiting messages in order until one cannot be decoded yet. */
  private drain(peer: string, ps: PeerState) {
    while (ps.waiting.length > 0) {
      const w = ps.waiting[0];
      const r = this.unzip(ps, w.msg, w.zip);
      if (r.missing) {
        const id = ps.dicts[w.msg[0] - 1];
        if (id.length > 0) return void this.fetchDict(peer, ps, id, true);
        ps.waiting.shift(); // a free slot: the message is damaged
        continue;
      }
      if (r.noList) {
        // a sender of an older version compresses its hello too: then we would wait for it
        // forever. Try the dictionaries we have for it — only a hello or a list is taken
        const plain = this.guessBootstrap(ps, w.msg);
        if (plain) {
          ps.waiting.shift();
          this.message(peer, plain, w.stream);
          continue;
        }
        this.askInfo(peer, ps);
        return; // wait for a hello or 0.5
      }
      ps.waiting.shift();
      if (r.plain) this.message(peer, r.plain, w.stream);
    }
  }

  /** guessBootstrap decompresses a message whose slot is beyond the sender's list we know with
   * each dictionary the sender may have used for us (the pair's and the common ones); only a
   * hello or a dictionary list is accepted, null — none fits. */
  private guessBootstrap(ps: PeerState, msg: Uint8Array): Uint8Array | null {
    if (msg.length < 2 || msg[0] === 0) return null;
    for (const d of this.dicts.list(ps.addr)) {
      try {
        const plain = decompress(msg, d, msgMax);
        if (!bootstrap(plain)) continue;
        decodeArrayRaw(plain);
        return plain;
      } catch {
        /* not this one */
      }
    }
    return null;
  }

  /** askInfo asks the device for its hello (0.2 info) when we hold its messages without its
   * list: it may never send the event again on its own. One at a time; a newer device answers
   * uncompressed, an older one — with a slot we may guess (guessBootstrap). */
  private askInfo(peer: string, ps: PeerState) {
    if (ps.askingInfo || Date.now() - ps.askedInfo < 10_000 || this.closed) return;
    ps.askingInfo = true;
    ps.askedInfo = Date.now();
    void (async () => {
      let res: Uint8Array[] | null = null;
      try {
        res = await withTimeout(this.call(peer, 0, 2), 30_000);
      } catch {
        /* asked again later (unhold) */
      }
      ps.askingInfo = false;
      if (this.closed || this.peers.get(peer) !== ps) return; // forgotten meanwhile
      if (!res || res.length < 5 || ps.dicts.length > 0) return;
      ps.dicts = idsOf(decode(res[4]));
      this.fetchNew(peer, ps);
      this.drain(peer, ps);
    })();
  }

  /** unzip decompresses a message; missing — we lack the dictionary in that slot, noList — the
   * slot is beyond the list we know. */
  private unzip(ps: PeerState, msg: Uint8Array, zip: boolean): { plain?: Uint8Array; missing?: boolean; noList?: boolean } {
    if (!zip) return { plain: msg };
    if (msg.length < 1) return {};
    let d: Dict | null = null;
    const slot = msg[0];
    if (slot > 0) {
      if (slot > ps.dicts.length) return { noList: true };
      d = this.dicts.get(ps.dicts[slot - 1], ps.addr) ?? null;
      if (!d) return { missing: true };
    }
    try {
      return { plain: decompress(msg, d, msgMax) };
    } catch {
      return {};
    }
  }

  /** fetchNew asks the device for the newest dictionary in its list that we lack: so it can
   * compress with it (only a dictionary both have is used). One at a time; one we could not get
   * (the family's, say) is not asked for again until its list changes. */
  private fetchNew(peer: string, ps: PeerState) {
    const id = ps.dicts.find((id) => id.length > 0 && !this.dicts.get(id, peer) && !has(ps.tried, id));
    if (id) this.fetchDict(peer, ps, id, false);
  }

  /** fetchDict asks the device for dictionary id: one it compressed a waiting message with (it
   * has it), or a new one in its list. What we get belongs to the pair with it. */
  private fetchDict(peer: string, ps: PeerState, id: Uint8Array, waiting: boolean) {
    if (ps.fetching) return;
    ps.fetching = true;
    void (async () => {
      let d: Dict | null = null;
      for (let i = 0; i < 3 && !d && !this.closed; i++) {
        try {
          const res = await withTimeout(this.call(peer, 0, 5, id), 30_000);
          const raw = decode(res[0]);
          if (raw instanceof Uint8Array && equal(dictId(raw), id)) d = new Dict(raw.slice(), peer);
        } catch {
          /* retry */
        }
      }
      ps.fetching = false;
      if (this.closed || this.peers.get(peer) !== ps) return; // forgotten meanwhile
      if (d) {
        try {
          this.addDictLocal(d); // announces our list again: now with it
        } catch {
          d = null; // could not store it: do not ask again and again
        }
      }
      if (!d) {
        if (waiting && ps.waiting.length > 0) ps.waiting.shift(); // the dictionary is unreachable: this message is lost
        else ps.tried.push(id);
      }
      this.drain(peer, ps);
      this.fetchNew(peer, ps);
    })();
  }

  /** dictHandler serves 0.5 dict [id] → dictionary bytes, only one the asker may see. A device
   * that asks lacks it, so we stop compressing with it for that device (this reply included)
   * until it announces again. */
  private dictHandler(peer: string, args: Uint8Array[]): CborValue[] {
    const id = args.length ? decode(args[0]) : null;
    if (!(id instanceof Uint8Array)) throw new P2PACTError(ErrBadArgs, "dictionary id required");
    if (this.allowDict && !this.allowDict(peer, id)) throw new P2PACTError(ErrForbidden, "dictionary is for the family only");
    this.peers.get(peer)?.lacks.push(id);
    const d = this.dicts.get(id, peer);
    if (!d) throw new P2PACTError(ErrNotFound, "no such dictionary");
    return [d.raw];
  }

  /** addDict stores a new (newest) common dictionary — commonDict, say — and announces it to all
   * known devices (event 0.5). */
  addDict(raw: Uint8Array) {
    this.addDictLocal(new Dict(raw));
  }

  /** addDictLocal stores a dictionary and announces the new list to the devices that see it: all
   * for a common one, the pair's device for its own. Only over a live session: a new one starts
   * with our hello, which carries the list, and a queued announcement would open it early,
   * without the message the session is for. */
  private addDictLocal(d: Dict) {
    this.dicts.add(d);
    for (const p of this.trust.list()) {
      if (!d.visible(p.addr) || !this.current.has(p.addr)) continue;
      const ps = this.peerState(p.addr);
      if (ps) ps.st.push(encode([3, 0, 5, this.dicts.ids(p.addr)]), false);
    }
    this.wake();
  }

  /** dictIds lists the dictionary ids peer sees, by slot (an empty id — a free slot). */
  dictIds(peer: string): Uint8Array[] {
    return this.dicts.ids(peer);
  }

  /** dictState tells what compresses messages to peer: own — our newest dictionary trained for it
   * (null — none yet), using — the one used now (null — none, plain zstd), training — a new one is
   * due or being trained, or messages wait to be learnt. */
  dictState(peer: string): { own: Uint8Array | null; using: Uint8Array | null; training: boolean } {
    const own = this.dicts.own(peer)?.id ?? null;
    const ps = this.peers.get(peer);
    const using = ps ? this.dicts.pick(peer, ps.dicts, ps.lacks)[0]?.id ?? null : null;
    return { own, using, training: this.learner.training(peer) };
  }

  /** learning exposes the learner to tests. */
  get learning(): Learner {
    return this.learner;
  }
}

/** initGap: retry a handshake after three measured round trips (250 ms – 2 s), else 1 s. */
function initGap(ps: PeerState): number {
  return ps.st.srtt === 0 ? initEvery : Math.min(Math.max(3 * ps.st.srtt, 250), 2000);
}

function idsOf(v: CborValue): Uint8Array[] {
  return Array.isArray(v) ? v.filter((x): x is Uint8Array => x instanceof Uint8Array) : [];
}

/** outOfOrder: results/errors of our calls, hellos and dictionary lists may skip the queue. */
function outOfOrder(m: Uint8Array): boolean {
  if (m.length < 2) return false;
  return m[1] === 1 || m[1] === 2 || bootstrap(m);
}

/** bootstrap reports a hello or a dictionary list ([3, 0, 2|5, …]): they carry what the receiver
 * needs to decompress, so they always go uncompressed — a device that restarted (and lost our
 * list) must be able to read them. */
export function bootstrap(m: Uint8Array): boolean {
  return m.length > 3 && m[1] === 3 && m[2] === 0 && (m[3] === 2 || m[3] === 5);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms).unref();
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

