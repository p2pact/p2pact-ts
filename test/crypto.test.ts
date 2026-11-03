// The @noble primitives against Node's own crypto: one code path for Node and browsers must give
// the bytes OpenSSL gives (and the Go implementation, through the interop suite).
import assert from "node:assert/strict";
import * as c from "node:crypto";
import { test } from "node:test";
import { blake2s, ed25519Keypair, ed25519Sign, ed25519Verify, hmac, open, randomBytes, seal, x25519, x25519Keypair } from "../src/crypto.js";

const u8 = (b: Buffer) => new Uint8Array(b);

test("x25519 matches node:crypto", () => {
  for (let i = 0; i < 20; i++) {
    const a = x25519Keypair(), b = x25519Keypair();
    const ka = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), a.private]), format: "der", type: "pkcs8" });
    const pb = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), b.public]), format: "der", type: "spki" });
    assert.deepEqual(x25519(a.private, b.public), u8(c.diffieHellman({ privateKey: ka, publicKey: pb })));
    assert.deepEqual(x25519(a.private, b.public), x25519(b.private, a.public));
  }
});

test("ed25519 signs and verifies like node:crypto", () => {
  const seed = randomBytes(32);
  const kp = ed25519Keypair(seed);
  const key = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const msg = randomBytes(100);
  const sig = ed25519Sign(seed, msg);
  assert.deepEqual(sig, u8(c.sign(null, msg, key))); // Ed25519 is deterministic
  assert.equal(c.verify(null, msg, c.createPublicKey(key), sig), true);
  assert.equal(ed25519Verify(kp.public, msg, sig), true);
  assert.equal(ed25519Verify(kp.public, randomBytes(100), sig), false);
  assert.equal(ed25519Verify(kp.public, msg, new Uint8Array(10)), false);
});

test("blake2s and HMAC-BLAKE2s match node:crypto", () => {
  for (const n of [0, 1, 63, 64, 65, 1000]) {
    const m = randomBytes(n), k = randomBytes(32);
    assert.deepEqual(blake2s(m), u8(c.createHash("blake2s256").update(m).digest()));
    assert.deepEqual(blake2s(m.subarray(0, n >> 1), m.subarray(n >> 1)), blake2s(m));
    assert.deepEqual(hmac(k, m), u8(c.createHmac("blake2s256", k).update(m).digest()));
  }
});

test("ChaCha20-Poly1305 matches node:crypto in both directions", () => {
  const key = randomBytes(32);
  for (const n of [0n, 1n, 2n ** 40n + 7n]) {
    const ad = randomBytes(9), pt = randomBytes(300);
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(n, 4);
    const ci = c.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    ci.setAAD(ad, { plaintextLength: pt.length });
    const want = u8(Buffer.concat([ci.update(pt), ci.final(), ci.getAuthTag()]));
    const got = seal(key, n, ad, pt);
    assert.deepEqual(got, want);
    assert.deepEqual(open(key, n, ad, want), pt);
  }
  const ct = seal(key, 1n, new Uint8Array(0), randomBytes(20));
  ct[3] ^= 1;
  assert.equal(open(key, 1n, new Uint8Array(0), ct), null, "a damaged message is refused");
  assert.equal(open(key, 1n, new Uint8Array(0), new Uint8Array(5)), null);
});
