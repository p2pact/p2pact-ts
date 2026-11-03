import { test } from "node:test";
import assert from "node:assert/strict";
import { Invite, AllTools, allowed, defaultGrants, ErrForbidden, KindClient, LevelRead, LevelWrite, type Grant, type Peer } from "../src/index.js";
import { close, code, echo, eventually, node, pair } from "./util.js";

test("wants asked are granted", async () => {
  const a = await node("Mac"), b = await node("App", true, KindClient);
  try {
    const want: Grant[] = [{ tool: "com.acme.x", level: LevelRead }, { tool: "p2pact.chat", level: LevelWrite }];
    await pair(a, b, want);
    const p = a.trust.get(b.id.addr)!;
    assert.deepEqual(allowed(p), want);
    assert.equal(p.kind, KindClient);
    await eventually("the newcomer is told", () => JSON.stringify(b.grantedBy(a.id.addr)) === JSON.stringify(want));
  } finally {
    close(a, b);
  }
});

// Pairing without wants asks for everything: behaviour as before, and no event 0.6 is needed.
test("no wants is everything", async () => {
  const a = await node("Mac"), b = await node("Phone");
  try {
    await pair(a, b);
    const p = a.trust.get(b.id.addr)!;
    assert.equal(p.grants, undefined);
    assert.deepEqual(allowed(p), defaultGrants());
    await echo(b, a, new Uint8Array([120]));
  } finally {
    close(a, b);
  }
});

// The inviting application sees the wants and decides what is granted before it accepts.
test("wants decided by the application", async () => {
  const a = await node("Mac"), b = await node("App", true, KindClient);
  try {
    let seen: { peer: Peer; wants: Grant[] } | undefined;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const paired: Peer[] = [];
    a.onWants = async (peer, wants) => {
      seen = { peer, wants };
      await released;
      return [{ tool: "com.acme.x", level: LevelRead }];
    };
    a.onPaired = (p) => void paired.push(p);
    await pair(a, b, [{ tool: AllTools, level: LevelWrite }]);
    await eventually("asked", () => !!seen);
    assert.equal(seen!.peer.name, "App");
    assert.equal(seen!.peer.kind, KindClient);
    assert.deepEqual(seen!.wants, [{ tool: AllTools, level: LevelWrite }]);
    // undecided: the newcomer may use nothing
    assert.deepEqual(a.grants(b.id.addr), []);
    assert.equal(await code(b.call(a.id.addr, 64, 1, new Uint8Array([1]))), ErrForbidden, "a call before the decision");
    release();
    await eventually("onPaired", () => paired.length === 1);
    assert.deepEqual(allowed(paired[0]), [{ tool: "com.acme.x", level: LevelRead }]);
    await eventually("narrowed grants told", () => JSON.stringify(b.grantedBy(a.id.addr)) === JSON.stringify([{ tool: "com.acme.x", level: LevelRead }]));
  } finally {
    close(a, b);
  }
});

// No wants in the payload (an older device): the application is shown ["*", 2]; it may refuse.
test("wants refused", async () => {
  const a = await node("Mac"), b = await node("Old");
  try {
    let got: Grant[] | undefined;
    a.onWants = (_p, wants) => {
      got = wants;
      return null;
    };
    await b.join(Invite.parse(a.invite(60_000).toString()), 10_000);
    await eventually("asked", () => !!got);
    assert.deepEqual(got, defaultGrants());
    await eventually("forgotten", () => a.trust.get(b.id.addr) === undefined);
  } finally {
    close(a, b);
  }
});
