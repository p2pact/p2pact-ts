// Primitives from Node's crypto: X25519, Ed25519, ChaCha20-Poly1305, BLAKE2s. No home-made
// cryptography (spec §1).
import * as c from "node:crypto";

const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export interface KeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

export function randomBytes(n: number): Uint8Array {
  return new Uint8Array(c.randomBytes(n));
}

function x25519Private(raw: Uint8Array): c.KeyObject {
  return c.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: "der", type: "pkcs8" });
}

function x25519Public(raw: Uint8Array): c.KeyObject {
  return c.createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: "der", type: "spki" });
}

/** x25519Keypair creates a key pair, or derives the public key of a given private key. */
export function x25519Keypair(priv?: Uint8Array): KeyPair {
  const p = priv ?? randomBytes(32);
  const pub = c.createPublicKey(x25519Private(p)).export({ format: "der", type: "spki" });
  return { private: p, public: new Uint8Array(pub.subarray(pub.length - 32)) };
}

export function x25519(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return new Uint8Array(c.diffieHellman({ privateKey: x25519Private(priv), publicKey: x25519Public(pub) }));
}

/** ed25519Keypair derives a signing key pair from a 32-byte seed. */
export function ed25519Keypair(seed: Uint8Array): KeyPair {
  const key = c.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  const pub = c.createPublicKey(key).export({ format: "der", type: "spki" });
  return { private: seed, public: new Uint8Array(pub.subarray(pub.length - 32)) };
}

export function ed25519Sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
  const key = c.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  return new Uint8Array(c.sign(null, msg, key));
}

export function ed25519Verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  const key = c.createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: "der", type: "spki" });
  return c.verify(null, msg, key, sig);
}

export function blake2s(...parts: Uint8Array[]): Uint8Array {
  const h = c.createHash("blake2s256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const h = c.createHmac("blake2s256", key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** mac is HMAC-BLAKE2s(key, label): relay channels and invite ids come from secrets. */
export function mac(key: Uint8Array, label: string): Uint8Array {
  return hmac(key, new TextEncoder().encode(label));
}

function nonce(n: bigint): Buffer {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(n, 4);
  return b;
}

/** seal is ChaCha20-Poly1305 with the Noise nonce layout (4 zero bytes, 64-bit LE counter). */
export function seal(key: Uint8Array, n: bigint, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  const ci = c.createCipheriv("chacha20-poly1305", key, nonce(n), { authTagLength: 16 });
  ci.setAAD(ad, { plaintextLength: pt.length });
  const out = Buffer.concat([ci.update(pt), ci.final(), ci.getAuthTag()]);
  return new Uint8Array(out);
}

/** open reverses seal; null if the tag does not match. */
export function open(key: Uint8Array, n: bigint, ad: Uint8Array, ct: Uint8Array): Uint8Array | null {
  if (ct.length < 16) return null;
  try {
    const d = c.createDecipheriv("chacha20-poly1305", key, nonce(n), { authTagLength: 16 });
    d.setAAD(ad, { plaintextLength: ct.length - 16 });
    d.setAuthTag(ct.subarray(ct.length - 16));
    return new Uint8Array(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]));
  } catch {
    return null;
  }
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** address of a device: the first 16 bytes of BLAKE2s of its public key, lowercase base32. */
export function address(pub: Uint8Array): string {
  const h = blake2s(pub).subarray(0, 16);
  let out = "";
  let bits = 0;
  let v = 0;
  for (const b of h) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && c.timingSafeEqual(a, b);
