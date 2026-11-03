// Application roads (spec §3): a link the application gives the node — here two in-memory links
// standing in for Bluetooth LE (a stream with 20-byte writes) and a WebRTC data channel (datagrams).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AttachedRoad, MaxRoadPacket } from "../src/approad.js";
import { zlibCodec } from "../src/compress-node.js";
import { decode } from "../src/cbor.js";
import { Node } from "../src/node.js";
import { Invite } from "../src/store.js";
import { MemoryStorage } from "../src/storage.js";
import { eventually, sleep } from "./util.js";
import { randomBytes } from "../src/crypto.js";

function mk(name: string): Node {
  const n = new Node(new MemoryStorage(), name, { codec: zlibCodec });
  n.handle(64, 1, (_peer, args) => [decode(args[0])]);
  n.start();
  return n;
}

interface Link { ra: AttachedRoad; rb: AttachedRoad; sent: () => number }

/** link joins a and b: what one sends arrives at the other, a moment later; lose drops datagrams. */
function link(a: Node, b: Node, cfg: { stream: boolean; mtu: number; direct?: boolean; lose?: number; name?: string }): Link {
  let bytes = 0;
  const holder: { ra?: AttachedRoad; rb?: AttachedRoad } = {};
  const wire = (to: () => AttachedRoad | undefined) => ({
    async send(u: Uint8Array) {
      assert.ok(u.length <= cfg.mtu, "a unit within the MTU");
      bytes += u.length;
      if (!cfg.stream && Math.random() < (cfg.lose ?? 0)) return;
      const copy = u.slice();
      await sleep(1);
      to()?.receive(copy);
    },
  });
  holder.ra = a.attachRoad("", wire(() => holder.rb), { name: cfg.name ?? "ble", ...cfg });
  holder.rb = b.attachRoad("", wire(() => holder.ra), { name: cfg.name ?? "ble", ...cfg });
  return { ra: holder.ra, rb: holder.rb, sent: () => bytes };
}

async function pairOver(a: Node, b: Node) {
  const inv = Invite.parse(a.invite(60_000).toString());
  const p = await b.join(inv, 15_000);
  assert.equal(p.addr, a.id.addr);
  await eventually("the inviter remembers the joiner", () => !!a.trust.get(b.id.addr));
}

for (const [label, cfg] of [
  ["stream road (BLE, 20-byte writes)", { stream: true, mtu: 20 }],
  ["datagram road (data channel, 2 % loss)", { stream: false, mtu: MaxRoadPacket, lose: 0.02, name: "webrtc", direct: true }],
] as const) {
  test(`pairing and calls over a ${label}`, async () => {
    const a = mk("A"), b = mk("B");
    try {
      const l = link(a, b, cfg);
      await pairOver(a, b);
      const small = randomBytes(40);
      assert.deepEqual(decode((await b.call(a.id.addr, 64, 1, small))[0]), small);
      const big = randomBytes(30_000);
      assert.deepEqual(decode((await a.call(b.id.addr, 64, 1, big))[0]), big);
      assert.deepEqual(b.paths(a.id.addr), [l.rb.name]);
      assert.ok(l.sent() > 60_000);
    } finally {
      a.close();
      b.close();
    }
  });
}

test("a direct application road ranks with TCP, above a relay; others below", () => {
  const a = mk("A"), b = mk("B");
  try {
    const plain = a.attachRoad("", { send() {} }, { stream: true, mtu: 20 });
    const direct = b.attachRoad("", { send() {} }, { stream: false, mtu: MaxRoadPacket, direct: true });
    assert.equal(plain.rank, 3);
    assert.equal(direct.rank, 1);
    assert.equal(plain.reliable, true);
    assert.equal(direct.reliable, false);
  } finally {
    a.close();
    b.close();
  }
});

test("attachRoad refuses a datagram road that is too small and an unknown device", () => {
  const a = mk("A");
  try {
    assert.throws(() => a.attachRoad("", { send() {} }, { stream: false, mtu: 512 }), /stream road/);
    assert.throws(() => a.attachRoad("nobody", { send() {} }, { stream: true, mtu: 20 }), /unknown device/);
  } finally {
    a.close();
  }
});

test("a damaged stream detaches the road; a detached road takes no more", async () => {
  const a = mk("A");
  try {
    const sent: Uint8Array[] = [];
    const r = a.attachRoad("", { send: (u) => void sent.push(u) }, { stream: true, mtu: 20 });
    r.receive(Uint8Array.of(0xff, 0xff, 1, 2, 3)); // a length over the maximum
    assert.equal(r.detached, true);
    r.send("#x", new Uint8Array(10));
    await sleep(5);
    assert.equal(sent.length, 0);
  } finally {
    a.close();
  }
});
