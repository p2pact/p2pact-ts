// Node is a device in a P2PACT network (spec §1–§8): pairing, sessions over any road,
// delivery, messages and compression. Single-threaded: everything runs on the event loop. This
// file is for Node.js and browsers alike: roads, storage and the zstd codec come from outside
// (node-fs.ts is the Node.js flavour, browser.ts the browser's).
import { AttachedRoad, MaxRoadPacket as MaxRoadPacketSize, type AppRoad, type AppRoadConfig } from "./approad.js";
import { decode, decodeArrayRaw, encode, type CborValue } from "./cbor.js";
import { Dict, DictStore, dictId, frameCompress, frameDecompress, has, type Codec } from "./compress.js";
import { address, equal, hex, randomBytes } from "./crypto.js";
import { dataHeader, keepalive, msgMax, Stream, type StreamId } from "./delivery.js";
import { cleanGrants, defaultGrants, grantLevel, grantsWire, LevelRead, LevelWrite, parseGrants, type Grant } from "./grants.js";
import { FirstNamedTool, fixedTool, fixedTools, validToolName, type ToolRef } from "./tools.js";
import { CipherState, concat, Handshake } from "./noise.js";
import { endpointKey, type AddrRoad, type Endpoint, type Road } from "./roads.js";
import { WsRelayRoad, type WebSocketCtor } from "./relay-ws.js";
import type { Storage } from "./storage.js";
import { addrBytes, addrText, DefaultForwardRate, evForward, evForwarded, forwardBurst, forwardQueue, forwardStream, FwdBucket, isVia, ViaRoad, type FwdPending } from "./forward.js";
import { allowed, hintsFromWire, hintsToWire, Identity, Invite, offered, Prologue, relayChannel, Trust, type Hints, type Peer } from "./store.js";

const pInit = 1, pResp = 2, pPair1 = 3, pPair2 = 4, pPair3 = 5, pData = 6, pReset = 7;
const tsSkew = 120_000n * 1_000_000n; // ns
const initEvery = 1000;
const autoConnect = 30_000;
const aliveFor = 60_000;
const keepaliveGap = 25_000;
const sessionIdle = 180_000;
const prologue = new TextEncoder().encode(Prologue);

/** probeTiming: how often the direct roads are tried while a session runs over a relay, an
 * application road or a road via a third device (spec §7). Tests shorten it. */
export const probeTiming = { every: 30_000 };

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

/** LevelHandler is a tool method that checks the caller's level itself: the node only requires
 * read, and passes the level (1 or 2) on. For a tool whose single method carries many (chat 1.1:
 * one P2PACT method for all of ACP), where what a call needs depends on its arguments. */
export type LevelHandler = (peer: string, level: number, args: Uint8Array[]) => CborValue[] | Later | Promise<CborValue[] | Later>;

/** ToolHandler is one handler for every method of a tool (see {@link Node.handleToolAll}): it gets
 * the method number and the caller's level (1 or 2), and checks the level itself. */
export type ToolHandler = (peer: string, level: number, method: number, args: Uint8Array[]) => CborValue[] | Later | Promise<CborValue[] | Later>;

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
  wants?: Grant[]; // pairing, we join: what we ask to use on the inviting device (spec §2)
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
  waiting: { msg: Uint8Array; zip: boolean; stream: StreamId }[]; // waiting for a dictionary (spec §5)
  waitSince: number; // when the head of waiting started to wait (unhold unblocks it)
  fetching: boolean;
  askingInfo: boolean; // our 0.2 info call is on its way (askInfo)
  askedInfo: number; // when we asked
  tried: Uint8Array[]; // dictionaries of its list we asked it for and did not get
  named?: Map<string, ToolRef>; // its named tools, from its hello (spec §8)
  fixed?: Map<number, number>; // its tools of the spec, {tool: version} from its hello; undefined — no hello yet
  sysCalls: Set<number>; // our calls of tool 0: their results are not conversation
  inbox: Map<StreamId, (() => Promise<void> | void)[]>; // calls and events waiting for their turn, per stream
  forwards: string[]; // the devices it forwards to for us, from its hello (spec §3)
  lastProbe: number; // when we last tried its direct roads (probe)
}

/** Kinds of device (spec §1): what a device is for, told in the pairing payload and the hello. */
export const KindUnknown = 0; // not said (an older device): guess as before, e.g. by OS
export const KindComputer = 1; // runs agents, serves tools
export const KindClient = 2; // an app a person holds: a phone, a desktop or web app
export const KindPlugin = 3; // a program on the same computer that adds tools to it

/** pairInfo is the pairing handshake payload [name, boot, hints, signing key, os, kind, wants]:
 * the last two are optional and a shorter one (an older device) leaves them zero; more elements
 * than we know are ignored. */
export interface PairInfo {
  name: string;
  boot: number;
  hints: Hints;
  signKey?: Uint8Array;
  os?: string;
  kind: number;
  wants: Grant[];
  hasWants: boolean; // the newcomer asked for something (spec §2); otherwise it asks for everything
}

/** @internal */
export function parsePair(b: Uint8Array): PairInfo {
  let a: CborValue[] = [];
  try {
    const v = decode(b);
    if (Array.isArray(v)) a = v;
  } catch {
    /* an unreadable payload reads as empty */
  }
  const wants = a.length > 6 ? parseGrants(a[6]) : undefined;
  return {
    name: String(a[0] ?? ""),
    boot: typeof a[1] === "number" ? a[1] : 0,
    hints: hintsFromWire(a[2] ?? null),
    signKey: a[3] instanceof Uint8Array ? a[3] : undefined,
    os: typeof a[4] === "string" ? a[4] : undefined,
    kind: typeof a[5] === "number" ? a[5] : KindUnknown,
    wants: wants ?? [],
    hasWants: wants !== undefined,
  };
}

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0);
const be32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
};
const goos = (): string => {
  const p = (globalThis as { process?: { platform?: string } }).process?.platform;
  return p ? ({ win32: "windows" } as Record<string, string>)[p] ?? p : "browser";
};

/** DictLearner trains our own dictionaries (spec §5): Node.js has one (learn.ts); a browser
 * trains none. */
export interface DictLearner {
  talk(peer: string, msg: Uint8Array, d: Dict | null, z: Uint8Array | null): void;
  hear(peer: string, msg: Uint8Array): void;
  tick(): void;
  close(): void;
  forget(peer: string): void;
  training(peer: string): boolean;
}

export interface NodeOptions {
  /** zstd: Node.js uses node:zlib (compress-node.ts), a browser a wasm decoder (codec-wasm.ts).
   * Without one, nothing is compressed or decompressed: a peer that compresses for us is held. */
  codec?: Codec;
  /** makes the learner of our own dictionaries; onDict gets the dictionaries it trained */
  learner?: (dicts: DictStore, onDict: (d: Dict) => void) => DictLearner;
  /** WebSocket constructor for the relay (default: the global one) */
  WebSocket?: WebSocketCtor;
}

export class Node {
  readonly id: Identity;
  readonly trust: Trust;
  /** onEvent receives tool events (except tool 0) from known devices: in the order sent on each
   * stream, one at a time, together with that stream's calls (spec §6); a returned promise is
   * awaited before the next one runs. */
  onEvent?: (peer: string, tool: number, event: number, args: Uint8Array[]) => void | Promise<void>;
  onPaired?: (p: Peer) => void;
  /** onGranted is called when a known device tells what we may use of its tools (event 0.6). */
  /** onWants is called on the inviting device when a newcomer has paired (spec §2), with what it
   * asks to use (everything, if it did not say): the application shows it to its person and
   * returns what the newcomer is granted, or null to refuse (the newcomer is forgotten). It may
   * wait for the person; the newcomer can use nothing meanwhile. onPaired follows when it
   * accepts. Unset — the newcomer gets what it asked for. */
  onWants?: (p: Peer, wants: Grant[]) => Grant[] | null | Promise<Grant[] | null>;
  onGranted?: (peer: string, grants: Grant[]) => void;
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
  /** kind is what this device is for (KindComputer…), told in pairing and the hello (spec §1). */
  kind = KindUnknown;
  /** forwardRate is how many bytes a second we forward in one direction of a pair we forward
   * for (allowForward); 0 — DefaultForwardRate. */
  forwardRate = 0;

  private vias = new Map<string, ViaRoad>(); // roads through forwarders, by forwarder
  private fwdBuckets = new Map<string, FwdBucket>(); // rate limit per forwarded direction ("from>to")
  /** @internal tests: what we forward */
  forwardTap?: (from: string, to: string, pkt: Uint8Array) => void;
  private fwdCount = 0;
  private fwdDropped = 0;
  private advertise?: Hints; // addresses announced instead of our own (setAdvertise)

  private boot = u32(randomBytes(4), 0) || 1;
  private udp?: AddrRoad;
  private tcp?: AddrRoad;
  private loc?: Road; // the local socket road (local.ts)
  private localPath_ = ""; // the socket we listen on, or dial
  private apps = new Set<AttachedRoad>(); // application roads (attachRoad)
  private relays = new Map<string, WsRelayRoad>(); // by WebSocket URL
  private ownWs: string[] = []; // our relay's WebSocket URLs (setRelay)
  private codec?: Codec;
  private wsCtor?: WebSocketCtor;
  // invites made for programs (pluginInvite) and the grants their install gave
  private inviteGrants = new Map<string, Grant[]>();
  private sessions = new Map<number, Session>();
  private current = new Map<string, Session>();
  private hs = new Map<number, PendingHandshake>();
  private invites = new Map<string, Invite>();
  private peers = new Map<string, PeerState>();
  private handlers = new Map<string, Handler>();
  // named tools: name → number and back, versions
  // grants: methods that check the level themselves, methods marked read
  private levelHandlers = new Map<string, LevelHandler>();
  private readMethods = new Set<string>();
  private toolHandlers = new Map<number, ToolHandler>(); // one handler for all methods of a tool (handleToolAll)
  private names = new Map<string, number>();
  private numbers = new Map<number, string>();
  private versions = new Map<number, number>();
  private aliases = new Map<string, string>(); // aliasTool: a former name → the tool's name now
  private resetAt = new Map<string, number>();
  private dicts: DictStore;
  private learner?: DictLearner;
  private timers: ReturnType<typeof setInterval>[] = [];
  private woken = false;
  private closed = false;
  private hintsSent: Uint8Array | null = null; // our addresses as last announced (reannounce)
  private hintsAt = 0; // when last checked
  handshakes = 0;

  /** storage keeps the keys, the known devices and the dictionaries (FileStorage, IdbStorage). */
  constructor(storage: Storage, readonly name: string, opts: NodeOptions = {}) {
    this.id = Identity.load(storage);
    this.trust = new Trust(storage);
    this.dicts = new DictStore(storage);
    this.dicts.listedBy = (d) => has(this.peers.get(d.peer)?.dicts ?? [], d.id);
    this.codec = opts.codec;
    this.wsCtor = opts.WebSocket;
    this.learner = opts.learner?.(this.dicts, (d) => this.addDictLocal(d));
    this.handle(0, 1, () => []);
    this.handle(0, 2, (peer) => this.info(peer));
    this.handle(0, 5, (peer, args) => this.dictHandler(peer, args));
    this.handle(0, 6, (peer) => [grantsWire(this.grants(peer))]); // what the caller may use
  }

  /** setUDP gives the node its UDP road (UDPRoad.listen); its address goes into the hints. The
   * road's receive callback is {@link receive}. */
  setUDP(road: AddrRoad) {
    this.udp = road;
  }

  /** setTCP gives the node the fallback road (TCPRoad.listen). */
  setTCP(road: AddrRoad) {
    this.tcp = road;
  }

  /** setLocal gives the node the local socket road (spec §3) at path: we listen on it, or dial it. */
  setLocal(road: Road, path: string) {
    if (this.loc) throw new Error("the local socket is already in use");
    this.loc = road;
    this.localPath_ = path;
  }

  /** localPath is the path of the local socket: the one we listen on, or the one we dial ("" — none). */
  get localPath(): string {
    return this.localPath_;
  }

  private isLocal(from: Endpoint): boolean {
    return this.loc !== undefined && from.road === this.loc;
  }

  get udpRoad() {
    return this.udp;
  }

  get tcpRoad() {
    return this.tcp;
  }

  /** tickMs: how often the learner takes its queues (learn.ts learnTiming.tick) */
  start(tickMs = 1000) {
    this.timers.push(setInterval(() => this.pump(), 20), setInterval(() => this.maintain(), 1000));
    if (this.learner) this.timers.push(setInterval(() => this.learner!.tick(), tickMs));
    for (const p of this.trust.list()) this.joinPairRelay(p);
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.learner?.close();
    this.udp?.close();
    this.tcp?.close();
    this.loc?.close();
    for (const r of this.relays.values()) r.close();
    for (const a of [...this.apps]) a.detach();
    for (const ps of this.peers.values()) for (const c of ps.calls.values()) c.reject(new Error("node closed"));
  }

  /** handle registers method tool.method. Calls of one device on one stream run one at a time,
   * in the order sent, together with its events there (spec §6); other streams do not wait. A
   * handler that waits long returns {@link later}, so that the stream goes on without it. */
  handle(tool: number, method: number, h: Handler) {
    this.handlers.set(`${tool}.${method}`, h);
  }

  // --- programs on this computer (spec §2, §8.2) ---

  /** pluginInvite makes the invite for a program the device starts: single use, no hints (the
   * program reaches the device over the local socket), valid for ttlMs, and the program is
   * granted exactly grants — the install gave them, nobody is asked. The program must pair with
   * kind plugin over the local socket; it is never added to the family and never reached over
   * another road. */
  pluginInvite(ttlMs: number, grants: Grant[] = []): Invite {
    const inv = new Invite(this.id.key.public, this.name, randomBytes(32), new Date(Date.now() + ttlMs), {});
    this.invites.set(hex(inv.id), inv);
    this.inviteGrants.set(hex(inv.id), cleanGrants(grants));
    return inv;
  }

  /** pluginEnv is {@link pluginInvite} and the environment to start the program with
   * (P2PACT_SOCKET and P2PACT_INVITE). The node must listen on its local socket. */
  pluginEnv(ttlMs: number, grants: Grant[] = []): Record<string, string> {
    if (!this.localPath_) throw new Error("the node does not listen on a local socket");
    return { P2PACT_SOCKET: this.localPath_, P2PACT_INVITE: this.pluginInvite(ttlMs, grants).toString() };
  }

  // --- grants (spec §8.1) ---

  /** handleLevel registers method tool.method like {@link handle}, for a handler that checks the
   * level itself (see {@link LevelHandler}). */
  handleLevel(tool: number, method: number, h: LevelHandler) {
    this.levelHandlers.set(`${tool}.${method}`, h);
  }

  /** markRead declares methods of a tool as read (spec §8.1): a device with read on the tool may
   * call them. The others are write. */
  markRead(tool: number, ...methods: number[]) {
    for (const m of methods) this.readMethods.add(`${tool}.${m}`);
  }

  /** grants is what we let a device use of ours (spec §8.1). */
  grants(peer: string): Grant[] {
    const p = this.trust.get(peer);
    return p ? allowed(p) : [];
  }

  /** grantedBy is what a device lets us use of its tools, as it told us (event 0.6 or method
   * 0.6); the default if it never did. */
  grantedBy(peer: string): Grant[] {
    const p = this.trust.get(peer);
    return p ? offered(p) : [];
  }

  /** level is the level a device has on one of our tools, by name. */
  level(peer: string, tool: string): number {
    const p = this.trust.get(peer);
    return p ? this.levelIn(p.grants, tool) : 0;
  }

  /** levelIn is the level a list of grants gives on a tool, counting its aliases ({@link aliasTool}):
   * {@link grantLevel} for a tool known by more than one name. */
  levelIn(grants: Grant[] | undefined, tool: string): number {
    let level = 0;
    for (const nm of this.toolNames(tool)) level = Math.max(level, grantLevel(grants, nm));
    return level;
  }

  /** toolNames is a tool name with its aliases: the tool's name now first, then its former ones. */
  private toolNames(name: string): string[] {
    const c = this.aliases.get(name);
    if (c !== undefined) name = c;
    const out = [name];
    for (const [a, canon] of this.aliases) if (canon === name) out.push(a);
    return out;
  }

  /** aliasTool declares alias a former name of the tool canonical (spec §8.1): a device may serve
   * one tool under both names, the name of the spec (say "p2pact.term", tool 5) and the one it
   * had before (say "dev.nomadcode.term", a named tool from 64 up). Grants on either name count
   * for both: a call or an event of either gets the highest level granted on any of them
   * ({@link levelIn}). It is also what {@link callTool} by canonical falls back to on a device
   * that announces only the alias. The alias is served as any named tool: register its handlers
   * ({@link handleToolAll}, {@link handleTool}) — the same as canonical's — and answer and send
   * events under the number it was called by. */
  aliasTool(alias: string, canonical: string): void {
    if (!validToolName(alias)) throw new Error("bad alias: " + alias);
    if (fixedTool(canonical) === undefined && !validToolName(canonical)) throw new Error("bad tool name: " + canonical);
    canonical = this.aliases.get(canonical) ?? canonical; // an alias of an alias names the same tool
    if (alias === canonical) throw new Error("a tool is not its own alias: " + alias);
    this.aliases.set(alias, canonical);
  }

  /** peerHasTool reports whether a device announced the tool in its last hello: a tool of the spec
   * in its {tool: version}, a named one in its named map. false before its hello. */
  peerHasTool(peer: string, name: string): boolean {
    const ps = this.peers.get(peer);
    if (!ps) return false;
    const num = fixedTool(name);
    if (num !== undefined) return ps.fixed?.has(num) ?? false;
    return ps.named?.has(name) ?? false;
  }

  /** resolveTool is the number to call a tool on a device by, and the name it goes under there:
   * the name itself if the device announced it, else an alias of it ({@link aliasTool}) the device
   * announced — a device that knows the tool only by its former name — else, for a tool of the
   * spec, its fixed number (the hello has not come, or does not list the tool). undefined — a
   * named tool the device has not announced under any of its names. */
  resolveTool(peer: string, name: string): { number: number; called: string } | undefined {
    const names = [name, ...this.toolNames(name).filter((s) => s !== name)];
    for (const nm of names) {
      if (!this.peerHasTool(peer, nm)) continue;
      const num = fixedTool(nm) ?? this.peers.get(peer)?.named?.get(nm)?.number;
      if (num !== undefined) return { number: num, called: nm };
    }
    const num = fixedTool(name);
    return num === undefined ? undefined : { number: num, called: name };
  }

  /** setGrants replaces what a trusted device may use (an empty list revokes everything), keeps
   * it with the trust and tells the device with event 0.6. */
  setGrants(peer: string, grants: Grant[]) {
    grants = cleanGrants(grants);
    if (!this.trust.setGrants(peer, grants)) throw new Error("unknown device");
    this.event(peer, 0, 6, grantsWire(grants));
  }

  /** grant changes one entry: the device gets level on the tool (LevelRead, LevelWrite); level 0
   * removes the entry. */
  grant(peer: string, tool: string, level: number) {
    const p = this.trust.get(peer);
    if (!p) throw new Error("unknown device");
    const list = allowed(p).filter((g) => g.tool !== tool);
    if (level > 0) list.push({ tool, level });
    this.setGrants(peer, list);
  }

  /** revokeGrants takes everything away from a device but tool 0: it stays trusted and in session. */
  revokeGrants(peer: string) {
    this.setGrants(peer, []);
  }

  /** grantsEvent tells the device what it may use, unless we never set it (the default it assumes).
   * A newcomer that asked has an explicit set, even ["*", 2]: it waits for this event (spec §2). */
  private grantsEvent(peer: string) {
    const p = this.trust.get(peer);
    const ps = this.peers.get(peer);
    if (!p || !ps || !p.grants) return;
    this.push(ps, encode([3, 0, 6, grantsWire(p.grants!)]));
  }

  /** requiredLevel is the level a call needs. */
  private requiredLevel(tool: number, method: number): number {
    const k = `${tool}.${method}`;
    return this.levelHandlers.has(k) || this.readMethods.has(k) || (this.toolHandlers.has(tool) && !this.handlers.has(k)) ? LevelRead : LevelWrite;
  }

  // --- named tools (spec §8) ---

  /** registerTool gives a tool of ours a name and picks its number: the first one from 64 up that
   * no other tool of ours uses. The same name gets the same number for the rest of the run. The
   * number is announced in the hello's named map, and the devices in session get the new hello
   * at once. Other devices may number the same name differently: callers use {@link toolNumber}. */
  registerTool(name: string, version = 1): number {
    if (!validToolName(name)) throw new Error("bad tool name: " + name);
    const old = this.names.get(name);
    if (old !== undefined) {
      if (this.versions.get(old) !== version) {
        this.versions.set(old, version);
        this.reannounceTools();
      }
      return old;
    }
    let num = FirstNamedTool;
    while (this.toolUsed(num)) num++;
    this.names.set(name, num);
    this.numbers.set(num, name);
    this.versions.set(num, version);
    this.reannounceTools();
    return num;
  }

  private toolUsed(num: number): boolean {
    if (this.numbers.has(num)) return true;
    for (const k of [...this.handlers.keys(), ...this.levelHandlers.keys()]) if (Number(k.split(".")[0]) === num) return true;
    return false;
  }

  private reannounceTools() {
    for (const peer of this.current.keys()) this.sendInfo(peer);
  }

  /** handleTool is {@link handle} by tool name (the tool is registered at version 1 if it is not yet). */
  handleTool(name: string, method: number, h: Handler) {
    const num = fixedTools[name] ?? this.registerTool(name, 1);
    this.handle(num, method, h);
  }

  /** toolName is the name of a tool of ours by its number ("" — it has none: a number of the
   * implementation's own). */
  toolName(tool: number): string {
    for (const [name, num] of Object.entries(fixedTools)) if (num === tool) return name;
    return this.numbers.get(tool) ?? "";
  }

  /** toolNumber resolves a tool name to the number the device announced for it in its hello (spec
   * §8); the tools of the spec have their fixed numbers. undefined — the device has not announced
   * it (or we have not heard its hello yet). */
  toolNumber(peer: string, name: string): number | undefined {
    return fixedTools[name] ?? this.peers.get(peer)?.named?.get(name)?.number;
  }

  /** peerToolName is the name of a tool of a device by the number it announced: what an onEvent
   * handler needs ("" — unnamed). */
  peerToolName(peer: string, tool: number): string {
    for (const [name, num] of Object.entries(fixedTools)) if (num === tool) return name;
    for (const [name, ref] of this.peers.get(peer)?.named ?? []) if (ref.number === tool) return name;
    return "";
  }

  /** callTool is {@link call} by tool name: the number is the device's own. */
  callTool(peer: string, name: string, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
    return this.callToolOn(peer, 0, name, method, ...args);
  }

  /** callToolOn is {@link callOn} by tool name. */
  callToolOn(peer: string, stream: StreamId, name: string, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
    const r = this.resolveTool(peer, name);
    if (r === undefined) return Promise.reject(new P2PACTError(ErrNoMethod, "the device has no tool " + name));
    return this.callOn(peer, stream, r.number, method, ...args);
  }

  /** handleToolAll serves every method of the named tool with h (the tool is registered at
   * version 1 if it is not yet). The node only requires read on the tool; what each method needs
   * is for h to check. Methods registered one by one with {@link handle} keep their own handlers.
   * For a device that hosts another program's tool (spec §8.2), or one that serves a tool of the
   * spec (a name of {@link fixedTools}, such as "p2pact.term") itself: it is announced under its
   * fixed number. */
  handleToolAll(name: string, h: ToolHandler) {
    const fixed = fixedTool(name);
    if (fixed === undefined) {
      this.toolHandlers.set(this.registerTool(name, 1), h);
      return;
    }
    this.toolHandlers.set(fixed, h);
    this.reannounceTools();
  }

  /** unregisterTool takes a tool back: it leaves the hello (sent again to the devices in session)
   * and its handlers are dropped. Registering a name again may give another number. For a tool of
   * the spec, its handlers are dropped and it leaves the hello. */
  unregisterTool(name: string) {
    const fixed = fixedTool(name);
    const num = fixed !== undefined && fixed !== 0 ? fixed : this.names.get(name);
    if (num === undefined) return;
    if (fixed === undefined) {
      this.names.delete(name);
      this.numbers.delete(num);
      this.versions.delete(num);
    }
    this.toolHandlers.delete(num);
    for (const m of [this.handlers, this.levelHandlers]) for (const k of [...m.keys()]) if (Number(k.split(".")[0]) === num) m.delete(k);
    for (const k of [...this.readMethods]) if (Number(k.split(".")[0]) === num) this.readMethods.delete(k);
    this.reannounceTools();
  }

  /** peerTools lists the named tools a device announced in its hello, sorted by name. */
  peerTools(peer: string): string[] {
    return [...(this.peers.get(peer)?.named?.keys() ?? [])].sort();
  }

  /** namedMap is the hello's named map: {name: [tool, version]}. */
  private namedMap(): CborValue {
    const out = new Map<CborValue, CborValue>();
    for (const [name, num] of this.names) out.set(name, [num, this.versions.get(num) ?? 1]);
    return out;
  }

  // --- pairing ---

  invite(ttlMs: number): Invite {
    const inv = new Invite(this.id.key.public, this.name, randomBytes(32), new Date(Date.now() + ttlMs), this.hints());
    this.invites.set(hex(inv.id), inv);
    if (this.ownWs.length) this.relayFor(this.ownWs[0]).join(hex(inv.id), "a");
    return inv;
  }

  /** join pairs using an invite, trying all its hints until one answers. */
  join(inv: Invite, timeoutMs = 30_000): Promise<Peer> {
    return this.joinWants(inv, undefined, timeoutMs);
  }

  /** joinWants is {@link join} asking for permissions (spec §2, `wants`): what we want to use on
   * the inviting device. Its person may narrow it; the result comes back as event 0.6
   * ({@link grantedBy}, onGranted); until the first 0.6 the device grants us nothing. undefined — we
   * ask for everything, as between one person's own devices (everything until told). */
  async joinWants(inv: Invite, wants: Grant[] | undefined, timeoutMs = 30_000): Promise<Peer> {
    const eps: Endpoint[] = [];
    if (this.udp) for (const a of inv.hints.udp ?? []) eps.push({ road: this.udp, addr: a });
    if (this.tcp) for (const a of inv.hints.tcp ?? []) eps.push({ road: this.tcp, addr: a });
    if (this.loc && this.localPath_) eps.push({ road: this.loc, addr: this.localPath_ }); // a device on this computer, over its socket
    const inviter = address(inv.key);
    for (const a of this.apps) if (a.peer === "" || a.peer === inviter) eps.push({ road: a, addr: a.id }); // a link the application opened
    const wsUrl = inv.hints.ws?.[0];
    let invRelay: WsRelayRoad | undefined;
    if (wsUrl && (this.wsCtor || (globalThis as { WebSocket?: unknown }).WebSocket)) { // the inviter's relay: its channel is the invite's
      invRelay = this.relayFor(wsUrl);
      invRelay.join(hex(inv.id), "b");
      eps.push({ road: invRelay, addr: hex(inv.id) });
    }
    if (eps.length === 0) throw new Error("the invite has no road we can use");
    const leaveInvite = () => invRelay?.leave(hex(inv.id));
    const deadline = Date.now() + timeoutMs;
    let local = 0;
    for (;;) {
      this.hs.delete(local);
      const hs = new Handshake({ pattern: "XXpsk2", initiator: true, prologue, s: this.id.key, psk: inv.secret });
      const msg1 = hs.writeMessage();
      local = this.newIndex();
      const done = new Promise<void>((resolve, reject) => {
        this.hs.set(local, { pair: true, hs, invite: inv, done: { resolve, reject }, at: Date.now(), early: [], wants });
      });
      const pkt = concat(Uint8Array.of(pPair1), inv.id, be32(local), msg1);
      for (const e of eps) e.road.send(e.addr, pkt);
      const r = await Promise.race([done.then(() => "ok"), new Promise((r) => setTimeout(() => r("again"), initEvery))]);
      if (r === "ok") {
        leaveInvite();
        const p = this.trust.get(address(inv.key));
        if (!p) throw new Error("pairing was not saved");
        return p;
      }
      if (Date.now() > deadline) {
        this.hs.delete(local);
        leaveInvite();
        throw new Error("pairing timed out");
      }
    }
  }

  /** pairPayload is our payload; wants are what we ask to use (undefined — not asking, the field
   * is left out, and so is the kind if we do not say one: an older device gets what it knows). */
  private pairPayload(wants?: Grant[]): Uint8Array {
    const a: CborValue[] = [this.name, this.boot, hintsToWire(this.hints()), this.id.sign.public, goos()];
    if (this.kind !== KindUnknown || wants) a.push(this.kind);
    if (wants) a.push(grantsWire(cleanGrants(wants)));
    return encode(a);
  }

  /** befriend adds a device known from the family book, without pairing. */
  befriend(p: Peer) {
    if (p.kind === KindPlugin) throw new Error("a plugin is never in the family");
    if (p.key.length !== 32 || address(p.key) !== p.addr) throw new Error("key does not match address");
    const old = this.trust.get(p.addr);
    if (old) {
      this.trust.put({ ...old, name: p.name, signKey: p.signKey, os: p.os, kind: p.kind ? p.kind : old.kind });
      return;
    }
    this.trust.put({ ...p, pairSecret: this.id.shared(p.key, "family-pair") });
    this.joinPairRelay(this.trust.get(p.addr)!);
  }

  /** forget drops a known device; our conversation's dictionaries and history go too. */
  forget(addr: string) {
    this.dicts.forget(addr);
    this.learner?.forget(addr);
    const gone = this.trust.get(addr);
    if (gone) this.pairRelay(gone)?.leave(relayChannel(gone));
    for (const c of this.peers.get(addr)?.calls.values() ?? []) c.reject(new Error("device forgotten"));
    this.peers.delete(addr);
    const s = this.current.get(addr);
    if (s) {
      this.current.delete(addr);
      this.sessions.delete(s.local);
    }
    const fw = gone?.forward ?? []; // the devices we forwarded to it for: they learn it is withdrawn
    this.trust.remove(addr);
    for (const a of fw) this.hello(a);
  }

  // --- calls and events ---

  /** call invokes tool.method on a known device (stream 0, in order); raw CBOR result elements. */
  call(peer: string, tool: number, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
    return this.callOn(peer, 0, tool, method, ...args);
  }

  /** callOn is call on a stream: ordered within it, independent of other streams (one per chat). */
  callOn(peer: string, stream: StreamId, tool: number, method: number, ...args: unknown[]): Promise<Uint8Array[]> {
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

  eventOn(peer: string, stream: StreamId, tool: number, ev: number, ...args: unknown[]) {
    const ps = this.peerState(peer);
    if (!ps) throw new Error("unknown device");
    // a tool's events go only to devices with at least read on it (spec §8.1)
    if (tool !== 0 && this.levelIn(this.trust.get(peer)?.grants, this.toolName(tool)) < LevelRead) return;
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
    // tools whose handlers check the caller's level are tools too
    for (const k of [...this.handlers.keys(), ...this.levelHandlers.keys()]) {
      const t = Number(k.split(".")[0]);
      if (t !== 0 && !this.numbers.has(t)) tools.set(t, 1);
    }
    for (const t of this.toolHandlers.keys()) if (t !== 0 && !this.numbers.has(t)) tools.set(t, 1); // a tool of the spec served by one handler
    const info: CborValue[] = [this.name, goos(), "p2pact-ts", tools, this.dicts.ids(peer), hintsToWire(this.hints()), this.kind, this.namedMap()];
    const fw = this.forwardsWire(peer); // whom we forward to for it (spec §3)
    if (fw.length) info.push(fw);
    return info;
  }

  /** setAdvertise announces these addresses instead of our own in invites and hellos (behind a
   * NAT with a forwarded port, say); an empty one announces none — known devices reach us only
   * over roads they already have, or through a forwarder. undefined — our own again. The relay
   * of setRelay is still announced unless h names one. */
  setAdvertise(h?: Hints) {
    this.advertise = h ? { ...h } : undefined;
  }

  private hints(): Hints {
    if (this.advertise) {
      const h: Hints = { ...this.advertise };
      if (!h.ws?.length && this.ownWs.length) h.ws = [...this.ownWs];
      return h;
    }
    const h: Hints = {};
    const udp = this.udp?.localAddrs();
    if (udp?.length) h.udp = udp;
    const tcp = this.tcp?.localAddrs();
    if (tcp?.length) h.tcp = tcp;
    if (this.ownWs.length) h.ws = [...this.ownWs];
    return h;
  }

  // --- via a third device (spec §3, forward.ts) ---

  /** allowForward opts this device in (on) or out as a forwarder between two devices it trusts:
   * one consent for both directions, kept with the trusted list. Both devices learn it from our
   * hello, sent again to them at once. */
  allowForward(a: string, b: string, on: boolean) {
    if (a === b || a === this.id.addr || b === this.id.addr) throw new Error("forwarding needs two other devices");
    const pa = this.trust.get(a), pb = this.trust.get(b);
    if (!pa || !pb) throw new Error("unknown device");
    if (pa.kind === KindPlugin || pb.kind === KindPlugin) throw new Error("a plugin is reachable over the local socket only");
    const set = (p: Peer, other: string): boolean => {
      const old = p.forward ?? [];
      const list = old.filter((s) => s !== other);
      if (on) list.push(other);
      list.sort();
      if (list.length === old.length && list.every((s, i) => s === old[i])) return false;
      this.trust.setForward(p.addr, list);
      return true;
    };
    if (set(pa, b)) this.hello(a);
    if (set(pb, a)) this.hello(b);
  }

  /** forwards lists the devices we forward to for a known device (allowForward). */
  forwards(peer: string): string[] {
    const p = this.trust.get(peer);
    if (!p) return [];
    return (p.forward ?? []).filter((a) => a !== peer && this.trust.get(a));
  }

  /** forwarders lists the devices that forward for us to peer: their hellos list it. */
  forwarders(peer: string): string[] {
    const out: string[] = [];
    for (const [x, xs] of this.peers) if (x !== peer && xs.forwards.includes(peer)) out.push(x);
    return out.sort();
  }

  /** forwardStats: packets this device forwarded for others, and those it dropped. */
  forwardStats(): { forwarded: number; dropped: number } {
    return { forwarded: this.fwdCount, dropped: this.fwdDropped };
  }

  /** hello sends our hello again to a device in session (what we forward for it changed). */
  private hello(peer: string) {
    if (!this.current.has(peer)) return;
    const ps = this.peerState(peer);
    if (ps) this.push(ps, encode([3, 0, 2, ...this.info(peer)]));
  }

  /** forwardsWire is the hello's ninth element: what we forward to for peer. */
  private forwardsWire(peer: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const a of this.forwards(peer)) {
      const b = addrBytes(a);
      if (b) out.push(b);
    }
    return out;
  }

  /** via is the road through forwarder x. */
  private via(x: string): ViaRoad {
    let v = this.vias.get(x);
    if (!v) {
      v = new ViaRoad(x, (fx, to, pkt) => this.viaSend(fx, to, pkt));
      this.vias.set(x, v);
    }
    return v;
  }

  /** viaSend wraps a packet for another device into event 0.7 to forwarder x. What cannot go is
   * dropped: the session resends it, or another road carries it. */
  private viaSend(x: string, to: string, pkt: Uint8Array) {
    const raw = addrBytes(to);
    const ps = this.peers.get(x);
    if (pkt.length > MaxRoadPacketSize || !raw || !ps || !this.direct(ps, Date.now())) return;
    if (ps.st.queue.length >= forwardQueue) return; // our own traffic to x goes first
    ps.st.push(encode([3, 0, evForward, raw, pkt]), false, forwardStream(raw), false);
    this.wake();
  }

  /** direct: we are in session with the device and have a live road to it that is not via a
   * third device. Forwarding takes one hop only — no chains, no loops. */
  private direct(ps: PeerState, now: number): boolean {
    if (!this.current.has(ps.addr)) return false;
    for (const e of ps.eps.values()) if (!isVia(e.ep.road) && now - e.lastRecv <= aliveFor) return true;
    return false;
  }

  /** heardForwards takes the list a device's hello gave: the devices it forwards to for us. A
   * device newly reachable through it gets a handshake at once. */
  private heardForwards(x: string, ps: PeerState, v: CborValue) {
    const old = ps.forwards;
    ps.forwards = [];
    for (const b of idsOf(v)) {
      if (b.length !== 16) continue;
      const a = addrText(b);
      if (a !== x && a !== this.id.addr && !ps.forwards.includes(a)) ps.forwards.push(a); // trust is checked on use
    }
    const now = Date.now();
    for (const a of ps.forwards) {
      if (old.includes(a) || this.current.has(a)) continue;
      const pa = this.peerState(a);
      if (!pa) continue;
      pa.lastInit = 0;
      const first = pa.st.idle() ? null : pa.st.nextPacket(now, false)?.plain ?? null;
      this.startInit(now, a, pa, first);
    }
  }

  /** forwardIn: device from asks us to carry a packet to another device (event 0.7). Anything we
   * may not or cannot forward is dropped silently. */
  private forwardIn(from: string, args: Uint8Array[]) {
    let to: CborValue = null, pkt: CborValue = null;
    try {
      if (args.length >= 2) [to, pkt] = [decode(args[0]), decode(args[1])];
    } catch {
      /* dropped below */
    }
    if (!(to instanceof Uint8Array) || !(pkt instanceof Uint8Array) || to.length !== 16 || pkt.length < 5 || pkt.length > MaxRoadPacketSize) {
      this.fwdDropped++;
      return;
    }
    const now = Date.now();
    const dest = addrText(to);
    const pf = this.trust.get(from);
    if (dest === from || dest === this.id.addr || !pf || !this.trust.get(dest) || !pf.forward?.includes(dest)) {
      this.fwdDropped++;
      return;
    }
    const pd = this.peerState(dest), ps = this.peers.get(from);
    if (!ps || !pd || !this.direct(ps, now) || !this.direct(pd, now) || pd.st.queue.length >= forwardQueue) {
      this.fwdDropped++;
      return;
    }
    const src = addrBytes(from)!;
    const msg = encode([3, 0, evForwarded, src, pkt]);
    if (!this.fwdOffer(from + ">" + dest, { to: dest, msg, stream: forwardStream(src), size: pkt.length }, now)) {
      this.fwdDropped++;
      return;
    }
    this.forwardTap?.(from, dest, pkt);
  }

  /** @internal fwdOffer forwards p now, or queues it behind its direction's rate; false — dropped. */
  fwdOffer(dir: string, p: FwdPending, now: number): boolean {
    let b = this.fwdBuckets.get(dir);
    if (!b) {
      b = new FwdBucket(forwardBurst, now);
      this.fwdBuckets.set(dir, b);
    }
    b.refill(this.forwardRate > 0 ? this.forwardRate : DefaultForwardRate, now);
    if (b.q.length === 0 && b.tokens >= p.size) {
      b.tokens -= p.size;
      this.fwdSend(p);
      return true;
    }
    if (b.queued + p.size > forwardBurst) return false;
    b.q.push(p);
    b.queued += p.size;
    return true;
  }

  /** @internal fwdRelease forwards what waited for its direction's rate (called with every pump). */
  fwdRelease(now: number) {
    for (const [dir, b] of this.fwdBuckets) {
      if (b.q.length === 0) {
        if (now - b.at > 60_000) this.fwdBuckets.delete(dir); // full again long ago
        continue;
      }
      b.refill(this.forwardRate > 0 ? this.forwardRate : DefaultForwardRate, now);
      while (b.q.length > 0 && b.tokens >= b.q[0].size) {
        const p = b.q.shift()!;
        b.queued -= p.size;
        b.tokens -= p.size;
        this.fwdSend(p);
      }
    }
  }

  private fwdSend(p: FwdPending) {
    const pd = this.peers.get(p.to);
    if (!pd) return;
    pd.st.push(p.msg, false, p.stream, false);
    this.fwdCount++;
    this.wake();
  }

  /** forwardedIn: forwarder x hands over a packet another device sent us through it (event 0.8).
   * It is handled as arriving on the road via x — only from a device x told us it forwards to,
   * and only over a road to x that is not via a third device. */
  private forwardedIn(x: string, args: Uint8Array[]) {
    let src: CborValue = null, pkt: CborValue = null;
    try {
      if (args.length >= 2) [src, pkt] = [decode(args[0]), decode(args[1])];
    } catch {
      return;
    }
    if (!(src instanceof Uint8Array) || !(pkt instanceof Uint8Array) || src.length !== 16 || pkt.length < 5 || pkt.length > MaxRoadPacketSize) return;
    const from = addrText(src);
    const xs = this.peers.get(x);
    if (from === x || from === this.id.addr || !xs || !xs.forwards.includes(from) || !this.trust.get(from) || !this.direct(xs, Date.now())) return;
    this.receive(pkt.slice(), { road: this.via(x), addr: from });
  }

  // --- receiving ---

  /** receive is what a road hands the node: a packet and the endpoint it came from. */
  receive(pkt: Uint8Array, from: Endpoint) {
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
    // a packet on a better road than the one in use (a probe, spec §7) is answered on it: the
    // other side hears the road too, and both move to it
    const c = this.candidates(s.peer, ps, now, false);
    const better = c.length === 1 && (from.road.rank ?? 2) < (c[0].ep.road.rank ?? 2);
    this.seen(ps, from, now, s.local);
    if (better) this.sealTo(s, ps.eps.get(endpointKey(from))!, now, keepalive());
    ps.st.receive(now, plain, (m, z, st) => this.inbound(s.peer, m, z, st));
    if (ps.st.ackDue !== 0 && now >= ps.st.ackDue) this.wake();
  }

  private onInit(now: number, pkt: Uint8Array, from: Endpoint) {
    const hs = new Handshake({ pattern: "IK", initiator: false, prologue, s: this.id.key });
    const payload = hs.readMessage(pkt.subarray(5));
    if (payload.length < 12) return;
    const peer = address(hs.rs!);
    const known = this.trust.get(peer);
    if (!known) return; // silence to strangers
    if (known.kind === KindPlugin && !this.isLocal(from)) return; // a plugin is reachable over the local socket only (spec §2)
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
    const pp = parsePair(payload);
    const msg3 = h.hs.writeMessage(this.pairPayload(h.wants));
    const [c1, c2] = h.hs.ciphers!;
    this.hs.delete(local);
    const peer = address(inv.key);
    const hints = pp.hints;
    hints.udp ??= inv.hints.udp;
    hints.tcp ??= inv.hints.tcp;
    hints.relay ??= inv.hints.relay;
    hints.ws ??= inv.hints.ws;
    const p: Peer = { addr: peer, key: inv.key, name: pp.name, pairSecret: inv.secret, hints, added: 0,
      signKey: pp.signKey, os: pp.os, kind: pp.kind || undefined, local: this.isLocal(from) || undefined,
      granted: h.wants ? [] : undefined }; // asked: nothing until the first 0.6 (spec §2)
    this.trust.put(p);
    this.joinPairRelay(p);
    const s: Session = { peer, local, remote: u32(pkt, 5), send: c1, recv: c2, sendN: 0, win: new Window(), lastRecv: now };
    this.sessions.set(local, s);
    this.current.set(peer, s);
    const ps = this.peerState(peer)!;
    this.seen(ps, from, now, s.local);
    this.bootOf(ps, pp.boot);
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
    const inv = h.invite!;
    const pp = parsePair(payload);
    const preset = this.inviteGrants.get(hex(inv.id));
    const forProgram = preset !== undefined;
    if ((pp.kind === KindPlugin || forProgram) && (pp.kind !== KindPlugin || !this.isLocal(from))) {
      return; // a plugin pairs over the local socket only, with an invite made for programs (spec §2)
    }
    this.hs.delete(local);
    this.invites.delete(hex(inv.id)); // single use
    this.inviteGrants.delete(hex(inv.id));
    const key = h.hs.rs!;
    const peer = address(key);
    const p: Peer = { addr: peer, key: key.slice(), name: pp.name, pairSecret: inv.secret,
      hints: pp.hints, added: 0, signKey: pp.signKey, os: pp.os, kind: pp.kind || undefined, via: hex(inv.id) };
    // what the newcomer may use (spec §2): without wants it asks for everything and keeps the
    // default; with them, and no onWants to narrow them, it gets what it asked. With onWants
    // the application decides: until it does the newcomer may use nothing.
    if (pp.hasWants) p.grants = cleanGrants(pp.wants);
    let on = this.onWants;
    if (on) p.grants = [];
    if (forProgram) { // the install gave the grants: nobody is asked
      on = undefined;
      p.grants = cleanGrants(preset);
    }
    if (pp.kind === KindPlugin) p.hints = {}; // reachable over the local socket only
    this.trust.put(p);
    if (this.ownWs.length) this.relayFor(this.ownWs[0]).leave(hex(inv.id)); // the invite is single use
    this.joinPairRelay(p);
    const s: Session = { peer, local, remote: h.remoteIdx!, send: c2, recv: c1, sendN: 0, win: new Window(), lastRecv: now };
    this.sessions.set(local, s);
    this.current.set(peer, s);
    const ps = this.peerState(peer)!;
    this.seen(ps, from, now, s.local);
    this.bootOf(ps, pp.boot);
    if (on) {
      const wants = pp.hasWants ? cleanGrants(pp.wants) : defaultGrants();
      this.sendInfo(peer);
      void (async () => {
        let grants: Grant[] | null = null;
        try {
          grants = await on(p, wants);
        } catch {
          /* a failing application refuses */
        }
        if (!grants) {
          this.forget(peer);
          return;
        }
        if (!this.trust.get(peer)) return; // forgotten meanwhile
        this.setGrants(peer, grants);
        if (this.onPaired) this.onPaired(this.trust.get(peer)!);
      })();
      return;
    }
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
    this.grantsEvent(peer);
  }

  private message(peer: string, msg: Uint8Array, stream: StreamId = 0) {
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
      const key = `${tool}.${method}`;
      let h: Handler | undefined = this.handlers.get(key);
      let level = 0, forbidden = false;
      if (tool !== 0) { // grants (spec §8.1): tool 0 is always allowed
        level = this.levelIn(this.trust.get(peer)?.grants, this.toolName(tool as number));
        forbidden = level < this.requiredLevel(tool as number, method as number);
      }
      const lh = this.levelHandlers.get(key);
      const th = this.toolHandlers.get(tool as number);
      if (lh && !forbidden) h = (p, args) => lh(p, level, args);
      else if (th && !h && !forbidden) h = (p, args) => th(p, level, method as number, args);
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
        if (forbidden) return reply(Promise.reject(new P2PACTError(ErrForbidden, "forbidden")));
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
        const known = this.trust.get(peer);
        if (known) this.joinPairRelay(known);
        if (a.length >= 10) {
          const kind = decode(a[9]);
          if (typeof kind === "number") this.trust.setKind(peer, kind);
        }
        ps.fixed = parseFixed(decode(a[6]));
        ps.named = undefined;
        if (a.length >= 11) ps.named = parseNamed(decode(a[10]));
        ps.dicts = idsOf(decode(a[7]));
        ps.lacks = [];
        ps.tried = [];
        this.heardForwards(peer, ps, a.length >= 12 ? decode(a[11]) : null);
        this.fetchNew(peer, ps);
        this.drain(peer, ps);
        if (this.onHello) queueMicrotask(() => this.onHello!(peer));
        return;
      }
      if (tool === 0 && ev === evForward) { // carry a packet to another device (spec §3)
        this.forwardIn(peer, a.slice(3));
        return;
      }
      if (tool === 0 && ev === evForwarded) { // a packet another device sent us through this one
        this.forwardedIn(peer, a.slice(3));
        return;
      }
      if (tool === 0 && ev === 6 && a.length >= 4) { // what we may use of its tools
        const g = parseGrants(decode(a[3]));
        if (g) {
          this.trust.setGranted(peer, g);
          if (this.onGranted) queueMicrotask(() => this.onGranted!(peer, g));
        }
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
  private enqueue(ps: PeerState, stream: StreamId, f: () => Promise<void> | void) {
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
        lacks: [], waiting: [], waitSince: 0, fetching: false, askingInfo: false, askedInfo: 0, tried: [], sysCalls: new Set(), inbox: new Map(),
        forwards: [], lastProbe: 0 };
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
      const rank = (e: EpState) => e.ep.road.rank ?? 2;
      // the road heard from last; a better kind only if heard within half a second of it
      let best = alive.reduce((b, e) => (e.lastRecv > b.lastRecv ? e : b));
      for (const e of alive) if (rank(e) < rank(best) && best.lastRecv - e.lastRecv < 500) best = e;
      return [best];
    }
    // a road via a third device takes retransmissions only while no other road is live: every
    // packet on it costs the forwarder (spec §7)
    const other = alive.some((e) => !isVia(e.ep.road));
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
    if (p.local && this.loc && this.localPath_) add(this.loc, [this.localPath_]); // the device we dial on this computer
    if (p.kind === KindPlugin) return out; // reachable over the local socket only, on the connection it opened
    add(this.udp, p.hints.udp);
    add(this.tcp, p.hints.tcp);
    const relay = this.pairRelay(p);
    if (relay) add(relay, [relayChannel(p)]);
    for (const a of this.apps) if (a.peer === p.addr) add(a, [a.id]); // a link the application opened to this device
    for (const [x, xs] of this.peers) { // devices that forward to it for us (spec §3)
      if (x !== peer && this.current.has(x) && xs.forwards.includes(peer)) add(this.via(x), [peer]);
    }
    return other ? out.filter((e) => !isVia(e.ep.road)) : out;
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
    (typeof setImmediate === "function" ? setImmediate : (f: () => void) => setTimeout(f, 0))(() => {
      this.woken = false;
      if (!this.closed) this.pump();
    });
  }

  private pump() {
    const now = Date.now();
    this.fwdRelease(now);
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
      if (c.length === 1) ps.st.reliable = c[0].ep.road.reliable ?? c[0].ep.road.name !== "udp";
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
        if (now - e.lastRecv <= aliveFor && now - e.lastSend >= keepaliveGap) this.sealTo(s, e, now, keepalive());
      }
    }
  }

  private maintain() {
    const now = Date.now();
    for (const p of this.trust.list()) {
      const ps = this.peerState(p.addr);
      if (ps && !this.current.has(p.addr) && now - ps.lastInit >= autoConnect) this.startInit(now, p.addr, ps, null);
      const s = this.current.get(p.addr);
      if (ps && s) this.probe(now, p.addr, ps, s);
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

  /** probe tries the direct roads to a device while the session runs over a relay, an
   * application road or a road via a third device (spec §7): a keepalive to every UDP and TCP
   * address known for it, every probeTiming.every. The one that answers is live, and being
   * better it takes over. */
  private probe(now: number, peer: string, ps: PeerState, s: Session) {
    if (now - ps.lastProbe < probeTiming.every) return;
    const c = this.candidates(peer, ps, now, false);
    if (c.length !== 1 || (c[0].ep.road.rank ?? 2) < 2) return;
    ps.lastProbe = now;
    for (const e of this.candidates(peer, ps, now, true)) {
      if ((e.ep.road.rank ?? 2) < 2) this.sealTo(s, e, now, keepalive());
    }
  }

  /** sealTo sends session content on one endpoint only (a keepalive, a probe). */
  private sealTo(s: Session, e: EpState, now: number, plain: Uint8Array) {
    const hdr = concat(Uint8Array.of(pData), be32(s.remote), be32(s.sendN));
    const pkt = concat(hdr, s.send.encryptAt(BigInt(s.sendN), hdr, plain));
    s.sendN++;
    e.ep.road.send(e.ep.addr, pkt);
    e.lastSend = now;
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
  private push(ps: PeerState, msg: Uint8Array, stream: StreamId = 0, talk = false, reply = false) {
    if (this.noCompression || bootstrap(msg)) {
      ps.st.push(msg, false, stream, reply);
      this.wake();
      return;
    }
    const [d, slot] = this.dicts.pick(ps.addr, ps.dicts, ps.lacks);
    const z = this.codec ? frameCompress(this.codec, msg, d, slot) : null;
    if (talk && !this.noLearning) this.learner?.talk(ps.addr, msg, d, z);
    if (z) ps.st.push(z, true, stream, reply);
    else ps.st.push(msg, false, stream, reply);
    this.wake();
  }

  /** hear queues a conversation message we got from the device for the history. */
  private hear(peer: string, msg: Uint8Array) {
    if (!this.noCompression && !this.noLearning) this.learner?.hear(peer, msg);
  }

  /** inbound decompresses a reassembled message and runs it in order. A missing dictionary is
   * not an error: we hold the message and everything after it and ask the sender for the
   * dictionary; if we do not know the sender's list yet (it restarted), we wait for its hello.
   * While waiting, only replies to our calls (the dictionary among them), hellos and dictionary
   * lists run out of order: nothing depends on their order. */
  private inbound(peer: string, msg: Uint8Array, zip: boolean, stream: StreamId = 0) {
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
        if (id.length > 0) {
          if (!has(ps.tried, id)) this.fetchDict(peer, ps, id); // one we could not get: unhold asks again, then drops
          return;
        }
        ps.waiting.shift(); // a free slot: the sender dropped that dictionary, the message cannot be read
        if (this.onHeld) queueMicrotask(() => this.onHeld!(peer, 1));
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
        const plain = this.unzipWith(msg, d);
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
      return { plain: this.unzipWith(msg, d) };
    } catch {
      return {};
    }
  }

  private unzipWith(msg: Uint8Array, d: Dict | null): Uint8Array {
    if (!this.codec) throw new Error("no zstd codec");
    return frameDecompress(this.codec, msg, d, msgMax);
  }

  /** fetchNew asks the device for the newest dictionary in its list that we lack: so it can
   * compress with it (only a dictionary both have is used). One at a time; one we could not get
   * (the family's, say) is not asked for again until its list changes. */
  private fetchNew(peer: string, ps: PeerState) {
    const id = ps.dicts.find((id) => id.length > 0 && !this.dicts.get(id, peer) && !has(ps.tried, id));
    if (id) this.fetchDict(peer, ps, id);
  }

  /** fetchDict asks the device for dictionary id: one it compressed a waiting message with (it
   * has it), or a new one in its list. What we get belongs to the pair with it. */
  private fetchDict(peer: string, ps: PeerState, id: Uint8Array) {
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
      // not dropped at once even if a message waits for it: it stays held, unhold asks again
      // after holdAsk and drops it after holdDrop, telling the application (onHeld)
      if (!d) ps.tried.push(id);
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
    return { own, using, training: this.learner?.training(peer) ?? false };
  }

  /** learning exposes the learner (Node.js) to tests. */
  get learning(): DictLearner | undefined {
    return this.learner;
  }

  // --- roads from outside: the relay, application roads ---

  /** setRelay gives the node a relay it listens on over WebSocket (spec §3): its URLs go into
   * the hints (the `ws` element), invites and paired devices meet through it. For a browser
   * node that is the whole network. Call before invite() and start(). */
  setRelay(urls: string | string[]) {
    this.ownWs = Array.isArray(urls) ? [...urls] : [urls];
    for (const p of this.trust.list()) this.joinPairRelay(p);
  }

  private relayFor(url: string): WsRelayRoad {
    let r = this.relays.get(url);
    if (!r) {
      r = new WsRelayRoad(url, (p, f) => this.receive(p, f), this.wsCtor);
      this.relays.set(url, r);
    }
    return r;
  }

  /** pairRelay picks the pair's relay as the Go node does (spec §7): the one of the device with
   * the lower address, else the other's; only WebSocket relays, the one thing we dial. */
  private pairRelay(p: Peer): WsRelayRoad | undefined {
    if (!this.wsCtor && !(globalThis as { WebSocket?: unknown }).WebSocket) return undefined;
    const mine = this.ownWs[0], theirs = p.hints.ws?.[0];
    const url = p.addr < this.id.addr ? theirs ?? mine : mine ?? theirs;
    return url ? this.relayFor(url) : undefined;
  }

  private joinPairRelay(p: Peer) {
    if (p.kind === KindPlugin) return;
    this.pairRelay(p)?.join(relayChannel(p), p.addr < this.id.addr ? "b" : "a");
  }

  /** attachRoad attaches a road the application provides (spec §3): a WebRTC data channel,
   * Bluetooth LE… peer is the device it reaches, if known: the node sends to it on this road as
   * on its hints and starts a session over it at once if it has none. With peer "" the road is
   * bound by what arrives on it (a handshake or session packet names the device) and is offered
   * for pairing (join). Give what arrives to AttachedRoad.receive. */
  attachRoad(peer: string, road: AppRoad, cfg: AppRoadConfig): AttachedRoad {
    if (!road || !(cfg.mtu >= 1)) throw new Error("an application road needs send and an MTU");
    if (!cfg.stream && cfg.mtu < MaxRoadPacketSize) {
      throw new Error(`a datagram road must carry ${MaxRoadPacketSize} bytes; a smaller link that keeps order is a stream road`);
    }
    if (peer && !this.trust.get(peer)) throw new Error("unknown device");
    const a = new AttachedRoad((p, f) => this.receive(p, f), (x) => this.detached(x), road, cfg, peer);
    this.apps.add(a);
    const ps = peer ? this.peerState(peer) : undefined;
    if (ps && !this.current.has(peer)) this.startInit(Date.now(), peer, ps, null);
    return a;
  }

  private detached(a: AttachedRoad) {
    this.apps.delete(a);
    for (const ps of this.peers.values()) for (const [k, e] of ps.eps) if (e.ep.road === a) ps.eps.delete(k);
  }
}

/** initGap: retry a handshake after three measured round trips (250 ms – 2 s), else 1 s. */
function initGap(ps: PeerState): number {
  return ps.st.srtt === 0 ? initEvery : Math.min(Math.max(3 * ps.st.srtt, 250), 2000);
}

/** parseNamed reads the hello's {name: [tool, version]}; undefined — not a map. */
function parseNamed(v: CborValue): Map<string, ToolRef> | undefined {
  if (!(v instanceof Map)) return undefined;
  const out = new Map<string, ToolRef>();
  for (const [name, r] of v) {
    if (typeof name === "string" && Array.isArray(r) && r.length >= 2 && typeof r[0] === "number" && typeof r[1] === "number") {
      out.set(name, { number: r[0], version: r[1] });
    }
  }
  return out;
}

/** parseFixed reads the hello's {tool: version}; an empty map when it is not one. */
function parseFixed(v: CborValue): Map<number, number> {
  const out = new Map<number, number>();
  if (v instanceof Map) for (const [t, ver] of v) if (typeof t === "number") out.set(t, typeof ver === "number" ? ver : 1);
  return out;
}

function idsOf(v: CborValue): Uint8Array[] {
  return Array.isArray(v) ? v.filter((x): x is Uint8Array => x instanceof Uint8Array) : [];
}

/** outOfOrder: results/errors of our calls, hellos and dictionary lists may skip the queue. */
function outOfOrder(m: Uint8Array): boolean {
  if (m.length < 2) return false;
  return m[1] === 1 || m[1] === 2 || bootstrap(m) || forwardMsg(m);
}

/** forwardMsg reports events 0.7 and 0.8: never compressed, run out of order (spec §3). */
function forwardMsg(m: Uint8Array): boolean {
  return m.length > 3 && m[1] === 3 && m[2] === 0 && (m[3] === evForward || m[3] === evForwarded);
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

