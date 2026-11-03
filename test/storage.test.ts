import assert from "node:assert/strict";
import { test } from "node:test";
import { indexedDB } from "fake-indexeddb";
import { FileStorage } from "../src/storage-node.js";
import { IdbStorage } from "../src/storage-idb.js";
import { MemoryStorage, readText, writeText, type Storage } from "../src/storage.js";
import { Node } from "../src/node.js";
import { zlibCodec } from "../src/compress-node.js";
import { Invite } from "../src/store.js";
import { tmp } from "./util.js";

function contract(name: string, make: () => Promise<Storage>) {
  test(`${name}: read, write, replace, remove`, async () => {
    const s = await make();
    assert.equal(s.read("a/b"), undefined);
    s.write("a/b", new Uint8Array([1, 2, 3]));
    assert.deepEqual(s.read("a/b"), new Uint8Array([1, 2, 3]));
    writeText(s, "a/b", "héllo");
    assert.equal(readText(s, "a/b"), "héllo");
    const got = s.read("a/b")!;
    got[0] = 0; // a copy: the store does not change under the caller
    assert.equal(readText(s, "a/b"), "héllo");
    s.remove("a/b");
    s.remove("a/b"); // a missing one is no error
    assert.equal(s.read("a/b"), undefined);
    await s.flush?.();
  });
}

contract("MemoryStorage", async () => new MemoryStorage());
contract("FileStorage", async () => new FileStorage(tmp()));
contract("IdbStorage", async () => IdbStorage.open("contract-" + Math.random(), indexedDB));

test("IdbStorage keeps the state over a reopen", async () => {
  const name = "reopen-" + Math.random();
  const a = await IdbStorage.open(name, indexedDB);
  a.write("net-key.json", new Uint8Array([9, 9]));
  a.write("net-dicts/x", new Uint8Array([1]));
  a.remove("net-dicts/x");
  await a.flush();
  a.close();
  const b = await IdbStorage.open(name, indexedDB);
  assert.deepEqual(b.read("net-key.json"), new Uint8Array([9, 9]));
  assert.equal(b.read("net-dicts/x"), undefined);
  b.close();
  await IdbStorage.destroy(name, indexedDB);
  const c = await IdbStorage.open(name, indexedDB);
  assert.equal(c.read("net-key.json"), undefined, "a destroyed database starts empty");
  c.close();
});

test("a node on IdbStorage keeps its identity and its known devices over a restart", async () => {
  const name = "node-" + Math.random();
  const s1 = await IdbStorage.open(name, indexedDB);
  const a = new Node(s1, "Browser", { codec: zlibCodec });
  const mac = new Node(new MemoryStorage(), "Mac", { codec: zlibCodec });
  const inv = Invite.parse(mac.invite(60_000).toString());
  // pair without a road: befriend, as devices known from the family book are
  a.befriend({ addr: mac.id.addr, key: mac.id.key.public, name: "Mac", pairSecret: new Uint8Array(32), hints: {}, added: 0 });
  assert.ok(inv);
  await s1.flush();
  s1.close();
  const s2 = await IdbStorage.open(name, indexedDB);
  const again = new Node(s2, "Browser", { codec: zlibCodec });
  assert.equal(again.id.addr, a.id.addr);
  assert.ok(again.trust.get(mac.id.addr), "the device is still known");
  a.close();
  again.close();
  mac.close();
  s2.close();
});
