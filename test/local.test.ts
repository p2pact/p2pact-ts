import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { allowed, ErrForbidden, Invite, KindClient, KindComputer, KindPlugin, LevelWrite, newPlugin, type Grant } from "../src/index.js";
import { close, code, echo, eventually, node, pair, shortDir, sleep, tmp } from "./util.js";

test("local socket: pairing and calls", async () => {
  const sock = path.join(shortDir(), "node.sock");
  const a = await node("Mac", false), b = await node("Tool", false);
  try {
    await a.listenLocal(sock);
    if (process.platform !== "win32") {
      const st = fs.statSync(sock);
      assert.ok(st.isSocket());
      assert.equal(st.mode & 0o777, 0o600);
    }
    await assert.rejects(a.listenLocal(sock), "a second listener on the same node");
    await b.useLocal(sock);
    await pair(a, b);
    await echo(b, a, new TextEncoder().encode("over the socket"));
    await echo(a, b, new TextEncoder().encode("local ".repeat(2000)));
    assert.deepEqual(b.paths(a.id.addr), ["local"]);
    assert.ok(b.trust.get(a.id.addr)!.local, "the dialing side does not remember the road");
  } finally {
    close(a, b);
  }
});

// A socket file nobody listens on is replaced; one in use is not; something else is not touched.
test("local socket: stale files", async () => {
  const dir = shortDir();
  const sock = path.join(dir, "n.sock");
  const a = await node("A", false), b = await node("B", false), c = await node("C", false);
  try {
    await a.listenLocal(sock);
    await assert.rejects(b.listenLocal(sock), "took a socket in use");
    // a stale file, as a crash leaves it: a socket whose listener was killed
    const stale = path.join(dir, "stale.sock");
    const child = spawn(process.execPath, ["-e", "require('net').createServer().listen(process.argv[1], () => console.log('up'))", stale], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => child.stdout.once("data", r));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    assert.ok(fs.lstatSync(stale).isSocket());
    await b.listenLocal(stale); // replaced
    assert.ok(fs.lstatSync(stale).isSocket());
    fs.writeFileSync(path.join(dir, "file"), "");
    await assert.rejects(c.listenLocal(path.join(dir, "file")), "replaced a regular file");
    a.close(); // closing the listener removes the file
    await sleep(50);
    assert.ok(!fs.existsSync(sock));
  } finally {
    close(a, b, c);
  }
});

// A plugin: the device starts it with the two variables; it pairs with kind 3, gets the
// install's grants, is reachable over the socket only.
test("a plugin pairs by environment", async () => {
  const sock = path.join(shortDir(), "host.sock");
  const host = await node("Mac", true); // it has UDP: a plugin must still never use it
  const extra: Array<{ close(): void }> = [];
  try {
    await host.listenLocal(sock);
    const num = host.registerTool("com.acme.host", 1);
    host.handleTool("com.acme.host", 1, () => ["host"]);
    assert.ok(num >= 64);
    const grants: Grant[] = [{ tool: "com.acme.host", level: LevelWrite }];
    const env = host.pluginEnv(3_600_000, grants);
    assert.equal(env.P2PACT_SOCKET, sock);
    const inv = Invite.parse(env.P2PACT_INVITE);
    assert.ok(!inv.hints.udp && !inv.hints.tcp && !inv.hints.relay, "the invite has hints");
    let asked = false;
    host.onWants = () => ((asked = true), null);
    // the plugin reads the variables from the process environment, as a started program does
    Object.assign(process.env, env);
    const { node: plug, host: h } = await newPlugin(tmp(), "Plugin", { timeoutMs: 10_000 });
    extra.push(plug);
    delete process.env.P2PACT_SOCKET;
    delete process.env.P2PACT_INVITE;
    assert.equal(h.addr, host.id.addr);
    assert.ok(!h.kind || h.kind === KindComputer);
    await eventually("host trusts the plugin", () => !!host.trust.get(plug.id.addr));
    const p = host.trust.get(plug.id.addr)!;
    assert.equal(p.kind, KindPlugin);
    assert.deepEqual(allowed(p), grants);
    assert.deepEqual(p.hints, {});
    assert.ok(!asked, "the person was asked about a plugin");
    // the plugin calls the host within its grants, not outside them
    await eventually("hello", () => plug.toolNumber(host.id.addr, "com.acme.host") !== undefined);
    assert.equal(await code(plug.callTool(host.id.addr, "com.acme.host", 1)), 0, "within grants");
    assert.equal(await code(plug.call(host.id.addr, 64, 1, new Uint8Array([1]))), ErrForbidden, "outside grants");
    // the host calls the plugin's tool (its grants for the host are the default)
    plug.handleTool("com.acme.plug", 1, () => ["plugin"]);
    await eventually("plugin hello", () => host.toolNumber(plug.id.addr, "com.acme.plug") !== undefined);
    assert.equal(await code(host.callTool(plug.id.addr, "com.acme.plug", 1)), 0, "host to plugin");
    assert.deepEqual(host.paths(plug.id.addr), ["local"]);
    // single use
    await assert.rejects(newPlugin(tmp(), "Again", { env, timeoutMs: 1500 }), "an invite was used twice");
    // not a family member
    assert.throws(() => host.befriend(p), "a plugin was befriended");
  } finally {
    close(host, ...(extra as any));
  }
});

// A plugin pairing over any other road is refused, and so is a program using a plugin invite as
// something else.
test("a plugin only over the local socket", async () => {
  const sock = path.join(shortDir(), "host.sock");
  const host = await node("Mac", true), other = await node("Other", true);
  try {
    await host.listenLocal(sock);
    other.kind = KindPlugin;
    // the joiner cannot tell: the host just stays silent
    await other.join(host.invite(60_000), 1500).catch(() => {});
    await sleep(200);
    assert.equal(host.trust.get(other.id.addr), undefined, "a plugin over UDP is trusted");
    other.kind = KindClient; // not a plugin: the invite made for programs is not for it
    await other.useLocal(sock);
    await other.join(host.pluginInvite(60_000), 1500).catch(() => {});
    await sleep(200);
    assert.equal(host.trust.get(other.id.addr), undefined, "a program invite was used by a client");
  } finally {
    close(host, other);
  }
});

test("plugin environment needs a socket", async () => {
  const n = await node("Mac", false);
  try {
    assert.throws(() => n.pluginEnv(60_000), "env without a socket");
    await assert.rejects(newPlugin(tmp(), "x", { env: {} }), "a plugin started by nobody");
  } finally {
    n.close();
  }
});
