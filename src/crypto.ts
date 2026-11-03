// Primitives: X25519, Ed25519, ChaCha20-Poly1305, BLAKE2s from the audited @noble libraries —
// no home-made cryptography (spec §1). One code path for Node and browsers.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 as curve25519 } from "@noble/curves/ed25519.js";
import { blake2s as nobleBlake2s } from "@noble/hashes/blake2.js";
import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import { equal, hex } from "./bytes.js";

export { equal, hex };

export interface KeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** x25519Keypair creates a key pair, or derives the public key of a given private key. */
export function x25519Keypair(priv?: Uint8Array): KeyPair {
  const p = priv ?? randomBytes(32);
  return { private: p, public: curve25519.getPublicKey(p) };
}

export function x25519(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return curve25519.getSharedSecret(priv, pub);
}

/** ed25519Keypair derives a signing key pair from a 32-byte seed. */
export function ed25519Keypair(seed: Uint8Array): KeyPair {
  return { private: seed, public: ed25519.getPublicKey(seed) };
}

export function ed25519Sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, seed);
}

export function ed25519Verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
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

export function blake2s(...parts: Uint8Array[]): Uint8Array {
  return nobleBlake2s(join(parts));
}

export function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  return nobleHmac(nobleBlake2s, key, join(parts));
}

/** mac is HMAC-BLAKE2s(key, label): relay channels and invite ids come from secrets. */
export function mac(key: Uint8Array, label: string): Uint8Array {
  return hmac(key, new TextEncoder().encode(label));
}

function nonce(n: bigint): Uint8Array {
  const b = new Uint8Array(12);
  new DataView(b.buffer).setBigUint64(4, n, true);
  return b;
}

/** seal is ChaCha20-Poly1305 with the Noise nonce layout (4 zero bytes, 64-bit LE counter). */
export function seal(key: Uint8Array, n: bigint, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce(n), ad).encrypt(pt);
}

/** open reverses seal; null if the tag does not match. */
export function open(key: Uint8Array, n: bigint, ad: Uint8Array, ct: Uint8Array): Uint8Array | null {
  if (ct.length < 16) return null;
  try {
    return chacha20poly1305(key, nonce(n), ad).decrypt(ct);
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
