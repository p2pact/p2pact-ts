// Device identity, known devices and invites (spec §1, §2). Files use the same format as the
// Go implementation: dir/net-key.json and dir/net-peers.json.
import * as fs from "node:fs";
import * as path from "node:path";
import { decode, encode, type CborValue } from "./cbor.js";
import { address, ed25519Keypair, mac, randomBytes, x25519, x25519Keypair, type KeyPair } from "./crypto.js";

export const Prologue = "p2pact/1";
const invitePrefix = "p2pact1.";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class Identity {
  constructor(readonly key: KeyPair, readonly sign: KeyPair) {}

  get addr(): string {
    return address(this.key.public);
  }

  /** shared derives a pair secret with pub without pairing (devices known from the family book). */
  shared(pub: Uint8Array, label: string): Uint8Array {
    return mac(x25519(this.key.private, pub), label);
  }

  /** load reads dir/net-key.json, creating keys (owner-only) when missing. */
  static load(dir: string): Identity {
    const file = path.join(dir, "net-key.json");
    let f: { private?: string; public?: string; sign?: string } = {};
    try {
      f = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* new device */
    }
    let changed = false;
    if (!f.private) {
      const k = x25519Keypair();
      f.private = b64(k.private);
      f.public = b64(k.public);
      changed = true;
    }
    if (!f.sign) {
      f.sign = b64(randomBytes(32));
      changed = true;
    }
    if (changed) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(f), { mode: 0o600 });
    }
    const key = x25519Keypair(unb64(f.private));
    return new Identity(key, ed25519Keypair(unb64(f.sign)));
  }
}

export interface RelayHint {
  addr: string;
  fp: string;
}

export interface Hints {
  udp?: string[];
  tcp?: string[];
  relay?: RelayHint;
}

export interface Peer {
  addr: string;
  key: Uint8Array;
  name: string;
  pairSecret: Uint8Array;
  hints: Hints;
  added: number;
  signKey?: Uint8Array;
  os?: string;
  via?: string;
}

/** phone reports a phone OS: a phone is never the family parent. */
export const phone = (os?: string) => os === "android" || os === "ios";

export function relayChannel(p: Peer): string {
  return Buffer.from(mac(p.pairSecret, "relay").subarray(0, 16)).toString("hex");
}

/** hintsWire is [UDP addresses, [relay address, fingerprint], TCP addresses]. */
export function hintsToWire(h: Hints): CborValue {
  return [h.udp ?? null, h.relay ? [h.relay.addr, h.relay.fp] : null, h.tcp ?? null];
}

export function hintsFromWire(v: CborValue): Hints {
  const a = Array.isArray(v) ? v : [];
  const strs = (x: CborValue) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : undefined);
  const h: Hints = {};
  const udp = strs(a[0]);
  if (udp?.length) h.udp = udp;
  const r = strs(a[1]);
  if (r && r.length === 2 && r[0]) h.relay = { addr: r[0], fp: r[1] };
  const tcp = strs(a[2]);
  if (tcp?.length) h.tcp = tcp;
  return h;
}

/** Trust is the set of known devices in dir/net-peers.json. */
export class Trust {
  private peers = new Map<string, Peer>();
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "net-peers.json");
    try {
      const list = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>[];
      for (const j of list) {
        const p: Peer = {
          addr: j.addr as string, key: unb64(j.key as string), name: (j.name as string) ?? "",
          pairSecret: unb64((j.pair_secret as string) ?? ""), hints: (j.hints as Hints) ?? {}, added: (j.added as number) ?? 0,
          signKey: j.sign_key ? unb64(j.sign_key as string) : undefined, os: j.os as string | undefined,
          via: j.via as string | undefined,
        };
        if (p.key.length === 32 && address(p.key) === p.addr) this.peers.set(p.addr, p);
      }
    } catch {
      /* none yet */
    }
  }

  get(addr: string): Peer | undefined {
    return this.peers.get(addr);
  }

  list(): Peer[] {
    return [...this.peers.values()].sort((a, b) => (a.addr < b.addr ? -1 : 1));
  }

  put(p: Peer) {
    if (!p.added) p.added = Date.now();
    this.peers.set(p.addr, p);
    this.save();
  }

  setHints(addr: string, name: string, os: string, h: Hints) {
    const p = this.peers.get(addr);
    if (!p) return;
    if (name) p.name = name;
    if (os) p.os = os;
    if (h.udp?.length) p.hints.udp = h.udp;
    if (h.tcp?.length) p.hints.tcp = h.tcp;
    if (h.relay) p.hints.relay = h.relay;
    this.save();
  }

  remove(addr: string): boolean {
    const had = this.peers.delete(addr);
    if (had) this.save();
    return had;
  }

  private save() {
    const list = this.list().map((p) => ({
      addr: p.addr, key: b64(p.key), name: p.name, pair_secret: b64(p.pairSecret), hints: p.hints, added: p.added,
      ...(p.signKey ? { sign_key: b64(p.signKey) } : {}), ...(p.os ? { os: p.os } : {}), ...(p.via ? { via: p.via } : {}),
    }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // replaced in one step: a node starting meanwhile never reads it half-written
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
}

/** Invite is an invitation to pair (spec §2): `p2pact1.<base64url(CBOR)>`. */
export class Invite {
  constructor(
    readonly key: Uint8Array,
    readonly name: string,
    readonly secret: Uint8Array,
    readonly exp: Date,
    readonly hints: Hints,
  ) {}

  /** id is the invite id in pairing packets and its relay channel. */
  get id(): Uint8Array {
    return mac(this.secret, "invite").subarray(0, 16);
  }

  toString(): string {
    const b = encode([1, this.key, this.name, this.secret, Math.floor(this.exp.getTime() / 1000), hintsToWire(this.hints)]);
    return invitePrefix + Buffer.from(b).toString("base64url");
  }

  static parse(s: string): Invite {
    s = s.trim();
    if (!s.startsWith(invitePrefix)) throw new Error("not an invite");
    let v: CborValue;
    try {
      v = decode(new Uint8Array(Buffer.from(s.slice(invitePrefix.length), "base64url")));
    } catch {
      throw new Error("invite is corrupt");
    }
    if (!Array.isArray(v) || v[0] !== 1 || !(v[1] instanceof Uint8Array) || v[1].length !== 32 ||
      !(v[3] instanceof Uint8Array) || v[3].length !== 32) {
      throw new Error("invite is corrupt");
    }
    const inv = new Invite(v[1], String(v[2] ?? ""), v[3], new Date(Number(v[4]) * 1000), hintsFromWire(v[5]));
    if (Date.now() > inv.exp.getTime()) throw new Error("invite expired");
    return inv;
  }
}
