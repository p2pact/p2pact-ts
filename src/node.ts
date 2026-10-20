// Node is a device in a P2PACT network (spec §1–§8): pairing, sessions over any road,
// delivery, messages and compression. Single-threaded: everything runs on the event loop.
import { decode, decodeArrayRaw, encode, type CborValue } from "./cbor.js";
import { compress, decompress, Dict, DictStore, dictId } from "./compress.js";
import { address, equal, hex, randomBytes } from "./crypto.js";
import { dataHeader, keepalive, msgMax, Stream } from "./delivery.js";
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

/** Error codes (spec §6). */
export const ErrNoMethod = 1, ErrBadArgs = 2, ErrNotFound = 3, ErrForbidden = 4, ErrFailed = 5, ErrNotDelivered = 6;

export class P2PACTError extends Error {
  constructor(readonly code: number, text: string) {
    super(text);
  }
}

/** Handler is a tool method: raw CBOR arguments → result values. */
export type Handler = (peer: string, args: Uint8Array[]) => CborValue[] | Promise<CborValue[]>;

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
}

interface PeerState {
  st: Stream;
  eps: Map<string, EpState>;
  lastTS: bigint;
  boot: number;
  lastInit: number;
  calls: Map<number, { resolve: (v: Uint8Array[]) => void; reject: (e: Error) => void }>;
  callID: number;
  dicts: Uint8Array[];
  lacks: Uint8Array[];
  waiting: { msg: Uint8Array; zip: boolean }[];
  fetching: boolean;
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
  /** onEvent receives tool events (except tool 0) from known devices. */
  onEvent?: (peer: string, tool: number, event: number, args: Uint8Array[]) => void;
  onPaired?: (p: Peer) => void;
  onHello?: (peer: string) => void;
  allowDict?: (peer: string, id: Uint8Array) => boolean;
  noCompression = false;

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
  private timers: NodeJS.Timeout[] = [];
  private woken = false;
  handshakes = 0;

  constructor(dir: string, readonly name: string) {
    this.id = Identity.load(dir);
    this.trust = new Trust(dir);
    this.dicts = new DictStore(dir);
    this.handle(0, 1, () => []);
    this.handle(0, 2, () => this.info());
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
    this.timers.push(setInterval(() => this.pump(), 20), setInterval(() => this.maintain(), 1000));
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.udp?.close();
    this.tcp?.close();
    for (const ps of this.peers.values()) for (const c of ps.calls.values()) c.reject(new Error("node closed"));
  }

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

  forget(addr: string) {
    this.peers.delete(addr);
    const s = this.current.get(addr);
    if (s) {
      this.current.delete(addr);
      this.sessions.delete(s.local);
    }
    this.trust.remove(addr);
  }

  // --- calls and events ---

  /** call invokes tool.method on a known device; the result elements come as raw CBOR. */
  call(peer: string, tool: number, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
    const ps = this.peerState(peer);
    if (!ps) return Promise.reject(new Error("unknown device"));
    const id = ++ps.callID;
    return new Promise((resolve, reject) => {
      ps.calls.set(id, {
        resolve: (v) => {
          ps.calls.delete(id);
          resolve(v);
        },
        reject: (e) => {
          ps.calls.delete(id);
          reject(e);
        },
      });
      this.push(ps, encode([0, id, tool, method, ...args]));
    });
  }

  event(peer: string, tool: number, ev: number, ...args: unknown[]) {
    const ps = this.peerState(peer);
    if (!ps) throw new Error("unknown device");
    this.push(ps, encode([3, tool, ev, ...args]));
  }

  /** paths lists live roads to a known device. */
  paths(peer: string): string[] {
    const ps = this.peers.get(peer);
    if (!ps) return [];
    const now = Date.now();
    return [...new Set([...ps.eps.values()].filter((e) => now - e.lastRecv <= aliveFor).map((e) => e.ep.road.name))];
  }

  private info(): CborValue[] {
    const tools = new Map<CborValue, CborValue>();
    for (const k of this.handlers.keys()) {
      const t = Number(k.split(".")[0]);
      if (t !== 0) tools.set(t, 1);
    }
    return [this.name, goos(), "p2pact-ts", tools, this.dicts.ids(), hintsToWire(this.hints())];
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
    this.seen(ps, from, now);
    ps.st.receive(now, plain, (m, z) => this.inbound(s.peer, m, z));
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
    this.seen(ps, from, now);
    this.bootOf(ps, u32(payload, 8));
    from.road.send(from.addr, concat(Uint8Array.of(pResp), be32(s.remote), be32(local), resp));
    if (payload.length > 12) ps.st.receive(now, payload.subarray(12), (m, z) => this.inbound(peer, m, z));
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
    this.seen(ps, from, now);
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
    this.seen(ps, from, now);
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
    this.seen(ps, from, now);
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
    this.push(this.peerState(peer)!, encode([3, 0, 2, ...this.info()]));
  }

  private message(peer: string, msg: Uint8Array) {
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
      const h = this.handlers.get(`${decode(a[2])}.${decode(a[3])}`);
      const args = a.slice(4);
      void (async () => {
        let out: unknown[];
        if (!h) out = [2, id, ErrNoMethod, "no such method"];
        else {
          try {
            out = [1, id, ...(await h(peer, args))];
          } catch (e) {
            const err = e instanceof P2PACTError ? e : new P2PACTError(ErrFailed, (e as Error).message);
            out = [2, id, err.code, err.message];
          }
        }
        const ps2 = this.peerState(peer);
        if (ps2) this.push(ps2, encode(out));
      })();
    } else if (kind === 1 || kind === 2) {
      const c = ps.calls.get(decode(a[1]) as number);
      if (!c) return;
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
        this.drain(peer, ps);
        if (this.onHello) queueMicrotask(() => this.onHello!(peer));
        return;
      }
      if (tool === 0 && ev === 5 && a.length >= 4) {
        ps.dicts = idsOf(decode(a[3]));
        ps.lacks = [];
        this.drain(peer, ps);
        return;
      }
      if (this.onEvent) {
        const args = a.slice(3);
        queueMicrotask(() => this.onEvent!(peer, tool, ev, args));
      }
    }
  }

  // --- sending ---

  private peerState(peer: string): PeerState | undefined {
    let ps = this.peers.get(peer);
    if (!ps) {
      if (!this.trust.get(peer)) return undefined;
      ps = { st: new Stream(), eps: new Map(), lastTS: 0n, boot: 0, lastInit: 0, calls: new Map(), callID: 0, dicts: [],
        lacks: [], waiting: [], fetching: false };
      this.peers.set(peer, ps);
    }
    return ps;
  }

  private seen(ps: PeerState, from: Endpoint, now: number) {
    const k = endpointKey(from);
    let e = ps.eps.get(k);
    if (!e) {
      e = { ep: from, lastRecv: 0, lastSend: 0 };
      ps.eps.set(k, e);
    }
    e.lastRecv = now;
  }

  private candidates(peer: string, ps: PeerState, now: number, all: boolean): EpState[] {
    const alive = [...ps.eps.values()].filter((e) => now - e.lastRecv <= aliveFor);
    if (alive.length > 0 && !all) {
      const rank = (e: EpState) => ({ udp: 0, tcp: 1 } as Record<string, number>)[e.ep.road.name] ?? 2;
      return [alive.reduce((b, e) => (rank(e) < rank(b) ? e : b))];
    }
    const out = alive;
    const p = this.trust.get(peer);
    if (!p) return out;
    const add = (road: Road | undefined, addrs: string[] | undefined) => {
      if (!road) return;
      for (const a of addrs ?? []) {
        const ep = { road, addr: a };
        const k = endpointKey(ep);
        if (!ps.eps.has(k)) ps.eps.set(k, { ep, lastRecv: 0, lastSend: 0 });
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
    if (!p || now - ps.lastInit < initEvery) return;
    ps.lastInit = now;
    for (const [idx, h] of this.hs) if (!h.pair && h.peer === peer) this.hs.delete(idx);
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
    if (this.woken) return;
    this.woken = true;
    setImmediate(() => {
      this.woken = false;
      this.pump();
    });
  }

  private pump() {
    const now = Date.now();
    for (const [peer, ps] of this.peers) {
      const s = this.current.get(peer);
      if (!s) {
        if (!ps.st.idle() && now - ps.lastInit >= initEvery && this.trust.get(peer)) {
          const first = ps.st.nextPacket(now, false);
          this.startInit(now, peer, ps, first?.plain ?? null);
        }
        continue;
      }
      if (!ps.st.idle() && now - s.lastRecv > 10_000 && ps.st.stuck()) {
        this.current.delete(peer);
        continue;
      }
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
  }

  private newIndex(): number {
    for (;;) {
      const i = u32(randomBytes(4), 0);
      if (i !== 0 && !this.sessions.has(i) && !this.hs.has(i)) return i;
    }
  }

  // --- compression (spec §5) ---

  private push(ps: PeerState, msg: Uint8Array) {
    const [d, slot] = this.dicts.pick(ps.dicts, ps.lacks);
    const z = this.noCompression ? null : compress(msg, d, slot);
    if (z) ps.st.push(z, true);
    else ps.st.push(msg, false);
    this.wake();
  }

  private inbound(peer: string, msg: Uint8Array, zip: boolean) {
    const ps = this.peerState(peer);
    if (!ps) return;
    if (ps.waiting.length > 0) {
      const r = this.unzip(ps, msg, zip);
      if (r.plain && outOfOrder(r.plain)) {
        this.message(peer, r.plain);
        this.drain(peer, ps);
        return;
      }
    }
    ps.waiting.push({ msg, zip });
    this.drain(peer, ps);
  }

  private drain(peer: string, ps: PeerState) {
    while (ps.waiting.length > 0) {
      const w = ps.waiting[0];
      const r = this.unzip(ps, w.msg, w.zip);
      if (r.missing) return void this.fetchDict(peer, ps, ps.dicts[w.msg[0] - 1]);
      if (r.noList) return;
      ps.waiting.shift();
      if (r.plain) this.message(peer, r.plain);
    }
  }

  private unzip(ps: PeerState, msg: Uint8Array, zip: boolean): { plain?: Uint8Array; missing?: boolean; noList?: boolean } {
    if (!zip) return { plain: msg };
    if (msg.length < 1) return {};
    let d: Dict | null = null;
    const slot = msg[0];
    if (slot > 0) {
      if (slot > ps.dicts.length) return { noList: true };
      d = this.dicts.get(ps.dicts[slot - 1]) ?? null;
      if (!d) return { missing: true };
    }
    try {
      return { plain: decompress(msg, d, msgMax) };
    } catch {
      return {};
    }
  }

  private fetchDict(peer: string, ps: PeerState, id: Uint8Array) {
    if (ps.fetching) return;
    ps.fetching = true;
    void (async () => {
      let d: Dict | null = null;
      for (let i = 0; i < 3 && !d; i++) {
        try {
          const res = await withTimeout(this.call(peer, 0, 5, id), 30_000);
          const raw = decode(res[0]);
          if (raw instanceof Uint8Array && equal(dictId(raw), id)) d = new Dict(raw);
        } catch {
          /* retry */
        }
      }
      ps.fetching = false;
      if (d) this.addDictLocal(d);
      else ps.waiting.shift(); // unreachable dictionary: this message is lost
      this.drain(peer, ps);
    })();
  }

  private dictHandler(peer: string, args: Uint8Array[]): CborValue[] {
    const id = args.length ? decode(args[0]) : null;
    if (!(id instanceof Uint8Array)) throw new P2PACTError(ErrBadArgs, "dictionary id required");
    if (this.allowDict && !this.allowDict(peer, id)) throw new P2PACTError(ErrForbidden, "dictionary is for the family only");
    this.peers.get(peer)?.lacks.push(id);
    const d = this.dicts.get(id);
    if (!d) throw new P2PACTError(ErrNotFound, "no such dictionary");
    return [d.raw];
  }

  /** addDict stores a new (newest) dictionary and announces it (event 0.5). */
  addDict(raw: Uint8Array) {
    this.addDictLocal(new Dict(raw));
  }

  private addDictLocal(d: Dict) {
    this.dicts.add(d);
    const msg = encode([3, 0, 5, this.dicts.ids()]);
    for (const p of this.trust.list()) {
      const ps = this.peerState(p.addr);
      if (ps) ps.st.push(msg, false);
    }
    this.wake();
  }

  dictIds(): Uint8Array[] {
    return this.dicts.ids();
  }
}

function idsOf(v: CborValue): Uint8Array[] {
  return Array.isArray(v) ? v.filter((x): x is Uint8Array => x instanceof Uint8Array) : [];
}

/** outOfOrder: results/errors of our calls, hellos and dictionary lists may skip the queue. */
function outOfOrder(m: Uint8Array): boolean {
  if (m.length < 2) return false;
  return m[1] === 1 || m[1] === 2 || (m.length > 3 && m[1] === 3 && m[2] === 0 && (m[3] === 2 || m[3] === 5));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

