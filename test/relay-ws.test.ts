// The relay over WebSocket against the Go relay (p2pact-relay -ws-addr, loopback ws): TS nodes
// that have nothing but the relay pair and call each other, and so does one with a Go device on
// the relay's TLS listener — they share one hub. Needs Go and ../p2pact-go (P2PACT_GO).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decode } from "../src/cbor.js";
import { zlibCodec } from "../src/compress-node.js";
import { randomBytes } from "../src/crypto.js";
import { Node } from "../src/node.js";
import { MemoryStorage } from "../src/storage.js";
import { Invite } from "../src/store.js";
import { eventually } from "./util.js";
import { goBinaries, GoPeer, startRelay, type GoRelay } from "./go-util.js";

const bins = goBinaries();
const skip = bins ? false : "Go or ../p2pact-go is not available";
let relay: GoRelay;

before(async () => {
  if (bins) relay = await startRelay(bins.relay);
});
after(() => relay?.stop());

function browserLike(name: string): Node {
  const n = new Node(new MemoryStorage(), name, { codec: zlibCodec }); // no UDP, no TCP: the relay only
  n.handle(64, 1, (_peer, args) => [decode(args[0])]);
  n.setRelay(relay.ws);
  n.start();
  return n;
}

test("two nodes with only a WebSocket relay pair and call both ways", { skip }, async () => {
  const a = browserLike("A"), b = browserLike("B");
  try {
    const inv = Invite.parse(a.invite(60_000).toString());
    assert.deepEqual(inv.hints.ws, [relay.ws]);
    const p = await b.join(inv, 15_000);
    assert.equal(p.addr, a.id.addr);
    await eventually("the inviter remembers the joiner", () => !!a.trust.get(b.id.addr));
    for (const [from, to] of [[b, a], [a, b]] as const) {
      const data = randomBytes(5000);
      assert.deepEqual(decode((await from.call(to.id.addr, 64, 1, data))[0]), data);
    }
    assert.ok(b.paths(a.id.addr)[0].startsWith("relay:"));
  } finally {
    a.close();
    b.close();
  }
});

test("the pair channel survives a restart of one side", { skip }, async () => {
  const a = browserLike("A");
  const store = new MemoryStorage();
  let b = new Node(store, "B", { codec: zlibCodec });
  b.setRelay(relay.ws);
  b.start();
  try {
    await b.join(Invite.parse(a.invite(60_000).toString()), 15_000);
    b.close();
    b = new Node(store, "B", { codec: zlibCodec });
    b.setRelay(relay.ws);
    b.start();
    const data = randomBytes(100);
    assert.deepEqual(decode((await b.call(a.id.addr, 64, 1, data))[0]), data);
  } finally {
    a.close();
    b.close();
  }
});

test("a WebSocket node pairs with a Go device on the relay's TLS listener", { skip }, async () => {
  const go = new GoPeer(bins!.interop);
  const b = browserLike("Browser");
  try {
    await go.cmd({ cmd: "listen" });
    await go.cmd({ cmd: "relay", addr: relay.addr, fp: relay.fp, ws: [relay.ws] });
    const inv = Invite.parse(String((await go.cmd({ cmd: "invite" })).invite));
    assert.deepEqual(inv.hints.ws, [relay.ws]);
    assert.equal(inv.hints.relay?.addr, relay.addr);
    const p = await b.join(inv, 20_000);
    const goAddr = p.addr;
    // a call to the Go device, and one from it (a long compressible text: Go compresses it for us
    // with the common dictionary or plain zstd, and the Go device decompresses nothing of ours)
    const text = new TextEncoder().encode("The quick brown fox jumps over the lazy dog. ".repeat(400));
    assert.deepEqual(decode((await b.call(goAddr, 64, 1, text))[0]), text);
    const back = await go.cmd({ cmd: "call", peer: b.id.addr, data: Buffer.from(text).toString("base64") });
    assert.deepEqual(new Uint8Array(Buffer.from(String(back.data), "base64")), text);
  } finally {
    go.stop();
    b.close();
  }
});
