// The browser build (dist/browser/p2pact.js) run in Node with a browser's parts: the global
// WebSocket and IndexedDB (fake-indexeddb). A node made by createBrowserNode — keys in
// IndexedDB, the wasm zstd decoder, the relay over WebSocket — pairs with a Go device through the
// Go relay, calls it and is called, with messages the Go device compresses with the common dictionary.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { zlibCodec } from "../src/compress-node.js";
import { frameCompress, Dict } from "../src/compress.js";
import { contentSize, WasmCodec } from "../src/codec-wasm.js";
import { commonDict } from "../src/common.js";
import { randomBytes } from "../src/crypto.js";
import { bundle } from "./browser-util.js";
import { goBinaries, GoPeer, root, startRelay, type GoRelay } from "./go-util.js";
import { frameDecompress } from "../src/compress.js";

const wasmFile = `${root}/node_modules/zstd-wasm-decoder/_esm/zstd-decoder.wasm`;

test("the wasm decoder reads what node:zlib compresses, with and without a dictionary", async () => {
  const codec = await WasmCodec.load(new Uint8Array(fs.readFileSync(wasmFile)));
  const common = new Dict(commonDict);
  const texts = ["Hello, could you write a function that sorts a list of numbers? ".repeat(30), "Привет, как дела? ".repeat(200), "x".repeat(70_000)];
  for (const d of [null, common]) {
    for (const t of texts) {
      const msg = new TextEncoder().encode(t);
      const z = frameCompress(zlibCodec, msg, d, d ? 1 : 0);
      assert.ok(z, "compressible");
      assert.deepEqual(frameDecompress(codec, z, d, 1 << 20), msg);
    }
  }
  assert.equal(codec.compress(), null, "a browser never compresses");
  // a frame with no declared size (the Go library writes those): one raw block, no size field
  const raw = new TextEncoder().encode("a frame that declares no content size");
  const noSize = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, ((raw.length << 3) | 1) & 255, (raw.length << 3) >> 8, 0, ...raw);
  assert.equal(contentSize(noSize), -1);
  assert.deepEqual(codec.decompress(noSize, null, 1 << 20), raw, "a stream decode when the size is not declared");
  assert.throws(() => codec.decompress(noSize, null, 10), /too big/, "the limit is checked on what came out");
  const big = frameCompress(zlibCodec, randomBytes(50_000).map((x) => x & 7), null, 0)!;
  assert.throws(() => frameDecompress(codec, big, null, 1000), /too big|unknown/, "output beyond the limit is refused");
  assert.throws(() => frameDecompress(codec, Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7), null, 1000));
});

const bins = goBinaries();
const skip = bins ? false : "Go or ../p2pact-go is not available";
let relay: GoRelay;
before(async () => {
  if (bins) relay = await startRelay(bins.relay);
});
after(() => relay?.stop());

test("a browser-build node pairs with a Go node through the WebSocket relay and calls it", { skip }, async () => {
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  const b = (await import(pathToFileURL(await bundle()).href)) as typeof import("../src/browser.js");
  const go = new GoPeer(bins!.interop);
  const node = await b.createBrowserNode({ name: "Browser", db: "smoke", relay: relay.ws, kind: b.KindClient });
  node.handle(64, 1, (_peer, args) => [b.decode(args[0])]);
  try {
    await go.cmd({ cmd: "listen" });
    await go.cmd({ cmd: "dict", raw: Buffer.from(b.commonDict).toString("base64") }); // Go compresses for us with it
    await go.cmd({ cmd: "relay", addr: relay.addr, fp: relay.fp, ws: [relay.ws] });
    const inv = b.Invite.parse(String((await go.cmd({ cmd: "invite" })).invite));
    const peer = await node.join(inv, 20_000);
    const text = new TextEncoder().encode("Could you explain how a relay works? I would like a long, detailed answer. ".repeat(300));
    assert.deepEqual(b.decode((await node.call(peer.addr, 64, 1, text))[0]), text);
    const back = await go.cmd({ cmd: "call", peer: node.id.addr, data: Buffer.from(text).toString("base64") });
    assert.deepEqual(new Uint8Array(Buffer.from(String(back.data), "base64")), text);
    // the dictionary is in the list the browser sent, and the Go device used it (slot 1)
    assert.ok(node.dictIds(peer.addr).length >= 1);
  } finally {
    go.stop();
    node.close();
  }
});
