// The Noise Protocol Framework, just what P2PACT uses: Noise_IK and Noise_XXpsk2 with
// 25519, ChaChaPoly and BLAKE2s (spec §2, §4.2).
import { blake2s, hmac, open, seal, x25519, x25519Keypair, type KeyPair } from "./crypto.js";

const SUITE = "25519_ChaChaPoly_BLAKE2s";

export class CipherState {
  n = 0n;
  constructor(readonly k: Uint8Array | null = null) {}

  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (!this.k) return pt;
    return seal(this.k, this.n++, ad, pt);
  }

  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (!this.k) return ct;
    const pt = open(this.k, this.n, ad, ct);
    if (!pt) throw new Error("noise: decryption failed");
    this.n++;
    return pt;
  }

  /** encryptAt and decryptAt use an explicit nonce: transport packets carry their number. */
  encryptAt(n: bigint, ad: Uint8Array, pt: Uint8Array): Uint8Array {
    return seal(this.k!, n, ad, pt);
  }

  decryptAt(n: bigint, ad: Uint8Array, ct: Uint8Array): Uint8Array | null {
    return open(this.k!, n, ad, ct);
  }
}

function hkdf(ck: Uint8Array, ikm: Uint8Array, n: 2 | 3): Uint8Array[] {
  const t = hmac(ck, ikm);
  const o1 = hmac(t, Uint8Array.of(1));
  const o2 = hmac(t, o1, Uint8Array.of(2));
  if (n === 2) return [o1, o2];
  return [o1, o2, hmac(t, o2, Uint8Array.of(3))];
}

class SymmetricState {
  h: Uint8Array;
  ck: Uint8Array;
  cs = new CipherState();

  constructor(name: string) {
    const b = new TextEncoder().encode(name);
    if (b.length <= 32) {
      this.h = new Uint8Array(32);
      this.h.set(b);
    } else this.h = blake2s(b);
    this.ck = this.h;
  }

  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs = new CipherState(k);
  }

  mixHash(data: Uint8Array) {
    this.h = blake2s(this.h, data);
  }

  mixKeyAndHash(ikm: Uint8Array) {
    const [ck, th, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(th);
    this.cs = new CipherState(k);
  }

  encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.cs.encrypt(this.h, pt);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.cs.decrypt(this.h, ct);
    this.mixHash(ct);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [a, b] = hkdf(this.ck, new Uint8Array(0), 2);
    return [new CipherState(a), new CipherState(b)];
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

const PATTERNS: Record<string, { pre: "rs" | null; msgs: Token[][] }> = {
  IK: { pre: "rs", msgs: [["e", "es", "s", "ss"], ["e", "ee", "se"]] },
  XXpsk2: { pre: null, msgs: [["e"], ["e", "ee", "s", "es", "psk"], ["s", "se"]] },
};

export interface HandshakeConfig {
  pattern: "IK" | "XXpsk2";
  initiator: boolean;
  prologue: Uint8Array;
  s: KeyPair;
  rs?: Uint8Array; // the responder's static key, known in advance (IK initiator)
  psk?: Uint8Array;
}

/** Handshake runs one Noise handshake. After the last message, ciphers holds [c1, c2]. */
export class Handshake {
  private ss: SymmetricState;
  private e: KeyPair | null = null;
  re: Uint8Array | null = null;
  rs: Uint8Array | null;
  private i = 0;
  private readonly msgs: Token[][];
  private readonly psk: boolean;
  ciphers: [CipherState, CipherState] | null = null;

  constructor(private cfg: HandshakeConfig) {
    const p = PATTERNS[cfg.pattern];
    this.msgs = p.msgs;
    this.psk = cfg.pattern.includes("psk");
    this.ss = new SymmetricState(`Noise_${cfg.pattern}_${SUITE}`);
    this.ss.mixHash(cfg.prologue);
    this.rs = cfg.rs ?? null;
    if (p.pre === "rs") this.ss.mixHash(cfg.initiator ? cfg.rs! : cfg.s.public);
  }

  private dh(a: KeyPair, b: Uint8Array) {
    this.ss.mixKey(x25519(a.private, b));
  }

  private token(t: Token, write: boolean, out: Uint8Array[], input: { b: Uint8Array; pos: number }) {
    const init = this.cfg.initiator;
    switch (t) {
      case "e":
        if (write) {
          this.e = x25519Keypair();
          out.push(this.e.public);
          this.ss.mixHash(this.e.public);
          if (this.psk) this.ss.mixKey(this.e.public);
        } else {
          if (input.b.length < input.pos + 32) throw new Error("noise: short message");
          this.re = input.b.slice(input.pos, input.pos + 32);
          input.pos += 32;
          this.ss.mixHash(this.re);
          if (this.psk) this.ss.mixKey(this.re);
        }
        return;
      case "s":
        if (write) out.push(this.ss.encryptAndHash(this.cfg.s.public));
        else {
          const n = 32 + (this.ss.cs.k ? 16 : 0);
          if (input.b.length < input.pos + n) throw new Error("noise: short message");
          this.rs = this.ss.decryptAndHash(input.b.subarray(input.pos, input.pos + n));
          input.pos += n;
        }
        return;
      case "ee":
        return this.dh(this.e!, this.re!);
      case "es":
        return init ? this.dh(this.e!, this.rs!) : this.dh(this.cfg.s, this.re!);
      case "se":
        return init ? this.dh(this.cfg.s, this.re!) : this.dh(this.e!, this.rs!);
      case "ss":
        return this.dh(this.cfg.s, this.rs!);
      case "psk":
        return this.ss.mixKeyAndHash(this.cfg.psk!);
    }
  }

  private finish() {
    this.i++;
    if (this.i === this.msgs.length) this.ciphers = this.ss.split();
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const out: Uint8Array[] = [];
    for (const t of this.msgs[this.i]) this.token(t, true, out, { b: new Uint8Array(0), pos: 0 });
    out.push(this.ss.encryptAndHash(payload));
    this.finish();
    return concat(...out);
  }

  readMessage(msg: Uint8Array): Uint8Array {
    const input = { b: msg, pos: 0 };
    for (const t of this.msgs[this.i]) this.token(t, false, [], input);
    const payload = this.ss.decryptAndHash(msg.subarray(input.pos));
    this.finish();
    return payload;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
