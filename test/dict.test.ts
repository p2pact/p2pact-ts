import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commonDict, decode, encode, ErrFailed, Invite, Node, P2PACTError } from "../src/index.js";
import { bootstrap, holdTiming } from "../src/node.js";
import { compress, decompress, Dict, DictStore } from "../src/compress.js";
import { buildDict, entropyEnd, trainDict } from "../src/cover.js";
import { historyPath, learnTiming } from "../src/learn.js";
import { equal, hex } from "../src/crypto.js";

learnTiming.tick = 200;
learnTiming.lull = 300;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-ts-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chatLine(i: number): Uint8Array {
  const words = ["the agent", "finished", "the task", "run the tests", "and commit", "messages do not reach",
    "the phone", "why is it so slow", "checked the logs", "a delivery bug", "fixed it", "pushed to the branch"];
  let s = `step ${i}: `;
  for (let j = 0; j < 12; j++) s += words[(i * 7 + j * j) % words.length] + ", ";
  return new TextEncoder().encode(s);
}

const dirs = new WeakMap<Node, string>();

async function node(name: string, dir = tmp()): Promise<Node> {
  const n = new Node(dir, name);
  dirs.set(n, dir);
  await n.listenUDP("127.0.0.1:0");
  n.handle(64, 1, (_peer, args) => [decode(args[0])]); // echo
  n.start();
  return n;
}

async function pair(a: Node, b: Node) {
  await b.join(Invite.parse(a.invite(60_000).toString()), 10_000);
  await waitFor("the invite owner remembers the joiner", () => !!a.trust.get(b.id.addr));
}

async function waitFor(what: string, cond: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(20)) if (Date.now() > end) assert.fail(what);
}

async function echo(from: Node, to: Node, data: Uint8Array) {
  const res = await from.call(to.id.addr, 64, 1, data);
  assert.deepEqual(decode(res[0]), data);
}

const testDict = (i: number) => buildDict(new TextEncoder().encode(`dictionary ${i}: `.repeat(20)), 40_000 + i);
const ids = (l: Uint8Array[]) => l.map((x) => (x.length ? hex(x).slice(0, 8) : "-"));

// The trainer finds the repeated content: a dictionary from it compresses new lines better than
// none, and it is a valid zstd dictionary with our id.
test("trained dictionary", () => {
  const train = Array.from({ length: 400 }, (_, i) => chatLine(i));
  const tst = Array.from({ length: 50 }, (_, i) => chatLine(400 + i));
  const raw = trainDict(train, tst, 8 << 10, 123_456);
  assert.ok(raw.length <= (8 << 10) + 200 && entropyEnd(raw) < raw.length);
  const d = new Dict(raw);
  assert.equal(d.zid, 123_456);
  let withD = 0, without = 0;
  for (const m of tst) {
    const z = compress(m, d, 1)!;
    assert.deepEqual(decompress(z, d, 1 << 20), m);
    withD += z.length;
    without += compress(m, null, 0)!.length;
  }
  assert.ok(withD * 2 <= without, `the dictionary should at least halve these lines: ${withD} with, ${without} without`);
  assert.throws(() => trainDict(train.slice(0, 3), tst, 8 << 10, 1));
});

test("the common dictionary ships with the package", () => {
  assert.equal(commonDict.length, 65536);
  assert.equal(new Dict(commonDict).zid, 1345470787);
  assert.equal(entropyEnd(commonDict), 173);
});

// A dictionary keeps its slot while listed: a message compressed with it may arrive after the
// new list, on another stream. A dropped one leaves a free slot; new ones go to the end.
test("dictionary slots stay", () => {
  const s = new DictStore(tmp());
  const ds = Array.from({ length: 6 }, (_, i) => new Dict(testDict(i), "b", true));
  s.add(ds[0]);
  s.add(ds[1]);
  const first = s.ids("b");
  s.add(ds[2]);
  let got = s.ids("b");
  assert.ok(equal(got[0], first[0]) && equal(got[1], first[1]) && equal(got[2], ds[2].id), "a new dictionary moved the others");
  for (const d of ds.slice(3)) s.add(d); // 6 own ones: the 2 oldest are dropped (4 kept)
  got = s.ids("b");
  assert.deepEqual(ids(got), ["-", "-", ...ids(ds.slice(2).map((d) => d.id))]);
  assert.deepEqual(s.pick("b", [ds[5].id], []).map((x) => (x instanceof Dict ? "d" : x)), ["d", 6]);
  assert.equal(s.ids("c").length, 0, "another device sees b's dictionaries");
  assert.equal(s.pick("b", [ds[5].id], [ds[5].id])[0], null, "a dictionary b asked for is not used until it announces again");
});

// Past 32 slots a new dictionary takes the oldest empty slot instead of growing the list.
test("slots are reused only past 32", () => {
  const s = new DictStore(tmp());
  const common = Array.from({ length: 40 }, (_, i) => new Dict(testDict(100 + i)));
  for (let i = 0; i < 32; i++) {
    s.add(common[i]);
    s.ids("b"); // listed to b now: each keeps the slot it got
  }
  let got = s.ids("b");
  assert.equal(got.length, 32);
  assert.equal(got.filter((x) => x.length === 0).length, 28); // 4 common ones kept
  s.add(common[32]);
  got = s.ids("b");
  assert.equal(got.length, 32);
  assert.ok(equal(got[0], common[32].id), "the oldest empty slot is taken");
});

// A damaged line in the order file never makes a pair's dictionary a common one.
test("a damaged order line keeps a pair's dictionary private", () => {
  const dir = tmp();
  const s = new DictStore(dir);
  const d = new Dict(testDict(0), "b", true);
  s.add(d);
  assert.equal(new DictStore(dir).ids("b").length, 1, "the pair's dictionary survives a restart");
  assert.equal(new DictStore(dir).own("b")?.own, true);
  fs.writeFileSync(path.join(dir, "net-dicts", "order"), hex(d.id) + " b\n");
  assert.equal(new DictStore(dir).ids("c").length, 0, "a damaged line made b's dictionary visible to c");
});

// With the common dictionary on both sides, messages go compressed with it.
test("the common dictionary compresses between two devices", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    a.noLearning = b.noLearning = true;
    await pair(a, b);
    a.addDict(commonDict);
    b.addDict(commonDict);
    await waitFor("a did not see b's list", () => a.dictState(b.id.addr).using !== null);
    assert.ok(equal(a.dictState(b.id.addr).using!, new Dict(commonDict).id));
    for (let i = 0; i < 20; i++) await echo(a, b, chatLine(i));
  } finally {
    a.close();
    b.close();
  }
});

// A device trains its own dictionary for the device it talks to; that device fetches it, and
// then messages go compressed with it. A third device neither sees nor gets it, from either.
test("own dictionary per device", async () => {
  const a = await node("Mac"), b = await node("Phone"), c = await node("Laptop");
  try {
    await pair(a, b);
    await pair(a, c);
    await pair(b, c);
    for (let i = 0; i < 300; i++) await echo(a, b, chatLine(i));
    await waitFor("a did not train a dictionary for b", () => a.dictState(b.id.addr).own !== null);
    const own = a.dictState(b.id.addr).own!;
    await waitFor("b did not take a's dictionary", () => {
      const u = a.dictState(b.id.addr).using;
      return u !== null && equal(u, own);
    });
    for (let i = 1000; i < 1010; i++) await echo(a, b, chatLine(i));
    await waitFor("b did not train a dictionary for a", () => b.dictState(a.id.addr).own !== null);

    assert.ok(!c.dictIds(a.id.addr).some((x) => equal(x, own)), "c sees a's dictionary for b");
    assert.ok(!a.dictIds(c.id.addr).some((x) => equal(x, own)), "a lists its dictionary for b to c");
    for (const from of [a, b]) {
      await assert.rejects(c.call(from.id.addr, 0, 5, own), (e: P2PACTError) => e.code === 3, `${from.name} gave c the dictionary`);
    }

    // it survives a restart: the history and the dictionary are on disk
    await waitFor("the history was not written", () => a.learning.flushed(b.id.addr));
    const before = a.learning.historySize(b.id.addr);
    const dir = dirs.get(a)!;
    const again = new DictStore(dir);
    assert.ok(again.own(b.id.addr) && equal(again.own(b.id.addr)!.id, own), "the own dictionary was not saved");
    const n2 = new Node(dir, "Mac");
    const after = n2.learning.historySize(b.id.addr);
    assert.equal(after.own, before.own);
    assert.ok(after.heard > 0);
    n2.close();
  } finally {
    a.close();
    b.close();
    c.close();
  }
});

// A device that only receives trains nothing: the dictionary is for what it sends.
test("no dictionary for a device that only listens", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    await pair(a, b);
    b.handle(64, 2, () => []); // answers nothing worth compressing
    for (let i = 0; i < 300; i++) await a.call(b.id.addr, 64, 2, chatLine(i));
    await waitFor("a did not train", () => a.dictState(b.id.addr).own !== null);
    await sleep(3 * learnTiming.lull);
    assert.equal(b.dictState(a.id.addr).own, null, "b trained a dictionary on what it only received");
  } finally {
    a.close();
    b.close();
  }
});

// Forgetting a device drops the pair's dictionaries and history.
test("forget drops the pair's dictionaries and history", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    await pair(a, b);
    for (let i = 0; i < 300; i++) await echo(a, b, chatLine(i));
    await waitFor("a did not train a dictionary for b", () => a.dictState(b.id.addr).own !== null && a.learning.flushed(b.id.addr));
    a.forget(b.id.addr);
    assert.equal(a.dictState(b.id.addr).own, null);
    assert.ok(!fs.existsSync(historyPath(dirs.get(a)!, b.id.addr)), "the history with b is still there");
  } finally {
    a.close();
    b.close();
  }
});

// Training waits for a lull: while the conversation goes on, no dictionary is trained.
test("training waits for a lull", async () => {
  const lull = learnTiming.lull;
  learnTiming.lull = 1500;
  const a = await node("Mac"), b = await node("Phone");
  try {
    await pair(a, b);
    const until = Date.now() + 4000;
    for (let i = 0; Date.now() < until; i++) { // 32 KB at once, then on and on
      await echo(a, b, chatLine(i));
      if (i > 250) await sleep(200);
    }
    assert.equal(a.dictState(b.id.addr).own, null, "a trained in the middle of the conversation");
    await waitFor("a did not train in the lull", () => a.dictState(b.id.addr).own !== null);
  } finally {
    learnTiming.lull = lull;
    a.close();
    b.close();
  }
});

const longText = Array.from({ length: 8 }, (_, i) => new TextDecoder().decode(chatLine(i))).join(" ");

// inside: the node's private state, for tests that break it on purpose
const inside = (n: Node) => n as unknown as {
  peers: Map<string, { dicts: Uint8Array[] }>;
  guessBootstrap(ps: { addr: string }, msg: Uint8Array): Uint8Array | null;
};

async function pairWithDict(a: Node, b: Node) {
  a.noLearning = b.noLearning = true;
  await pair(a, b);
  a.addDict(testDict(0));
  b.addDict(testDict(0));
  await waitFor("a did not see b's list", () => a.dictState(b.id.addr).using !== null);
  await waitFor("b did not see a's list", () => b.dictState(a.id.addr).using !== null);
}

// The receiver lost the sender's list (it restarted, the hello did not come again) while the
// sender keeps compressing: the receiver asks for the hello (0.2 info) and runs the messages.
test("a lost list is asked for with 0.2 info", async () => {
  const a = await node("Phone"), b = await node("Mac");
  try {
    await pairWithDict(a, b);
    inside(b).peers.get(a.id.addr)!.dicts = []; // b no longer knows a's list
    const late = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("b held the call")), ms).unref());
    for (let i = 0; i < 3; i++) await Promise.race([echo(a, b, new TextEncoder().encode(longText)), late(10_000)]);
  } finally {
    a.close();
    b.close();
  }
});

// A sender of an older version compressed its hello: the receiver without its list reads it
// with a dictionary it has for that sender. Only a hello or a list is taken this way.
test("an older sender's compressed hello is read with the pair's dictionaries", async () => {
  const b = await node("Mac");
  try {
    const d = new Dict(testDict(0));
    b.addDict(d.raw);
    const hello = encode([3, 0, 2, "Phone", "android", "p2pact-kotlin", new Map(), [d.id], new Map(), longText]);
    const z = compress(hello, d, 7);
    const other = encode([3, 64, 1, longText]);
    const zo = compress(other, d, 7);
    assert.ok(z && zo);
    const ps = { addr: "phone" };
    assert.deepEqual(inside(b).guessBootstrap(ps, z), hello);
    assert.equal(inside(b).guessBootstrap(ps, zo), null, "a message other than a hello or a list was taken");
    assert.ok(bootstrap(hello) && !bootstrap(other));
  } finally {
    b.close();
  }
});

// Messages held for a list that never comes are not held forever: they are dropped (the sender
// resends what matters), the application is told, and the lists are learnt anew.
test("held messages are dropped", async () => {
  const old = { ...holdTiming };
  holdTiming.ask = 200;
  holdTiming.drop = 1000;
  const a = await node("Phone"), b = await node("Mac");
  try {
    await pairWithDict(a, b);
    a.handle(0, 2, () => {
      throw new P2PACTError(ErrFailed, "no");
    });
    let held = 0;
    b.onHeld = (_peer, k) => (held = k);
    inside(b).peers.get(a.id.addr)!.dicts = []; // b lost a's list, and a will not tell it
    a.event(b.id.addr, 9, 1, longText);
    await waitFor("held messages were never dropped", () => held > 0, 10_000);
  } finally {
    Object.assign(holdTiming, old);
    a.close();
    b.close();
  }
});
