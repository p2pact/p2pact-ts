#!/usr/bin/env node
// Interop peer for p2pact-tests: a P2PACT node driven by JSON lines on stdin, answering on
// stdout. Every implementation ships one, so any two can be tested against each other.
//
//   {"cmd":"listen","udp":"127.0.0.1:0","tcp":"127.0.0.1:0"}  → {"addr":"…","udp":"…","tcp":"…"}
//   {"cmd":"relay","addr":"host:port","fp":"hex","ws":["ws://…"]} → {"ok":true}  (say it before "invite")
//   {"cmd":"invite"}                                          → {"invite":"p2pact1.…"}
//   {"cmd":"join","invite":"…"}                               → {"peer":"…"}
//   {"cmd":"known","peer":"…"}                                → {"known":true|false}
//   {"cmd":"call","peer":"…","data":"<base64>"}               → {"data":"<base64>"}  (echo, tool 64 method 1)
//   {"cmd":"later","peer":"…","data":"<base64>","stream":N}   → {"data":"<base64>"}
//     a call answered later (spec §6): calls tool 64 method 2 on the stream, which the other side
//     holds until a 64.1 call reaches it, then a 64.1 call on the same stream; answers with the
//     64.2 result, or an error if the 64.1 call waited behind the held one
//   {"cmd":"dict","raw":"<base64>"}                           → {"ok":true}
//   {"cmd":"dict-state","peer":"…"}                           → {"own":"<base64>"|null,"using":…,"training":bool}
//   {"cmd":"close"}
// Kinds, named tools, grants, wants, the local socket and hosted tools: "kind", "peer-info", "tool",
// "call-tool", "grant", "set-grants", "grants", "emit", "events", "on-wants", "local", "plugin-env", "proxy" and
// join with "wants" (see p2pact-go/cmd/p2pact-interop for their JSON).
// Errors: {"error":"…"}.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { decode } from "./cbor.js";
import { ErrFailed, later, P2PACTError } from "./node.js";
import { Node } from "./node-fs.js";
import type { Grant } from "./grants.js";
import { Invite } from "./store.js";

const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-interop-"));
const node = new Node(dir, process.argv[3] ?? "ts");
// 64.2 echoes too, but answers later: once a 64.1 call has run after it (on its stream, that call
// is behind it; it passes only if the held call does not hold up the stream)
let held: (() => void)[] = [];
node.handle(64, 1, (_p, args) => {
  for (const r of held) r();
  held = [];
  return [decode(args[0])];
});
node.handle(64, 2, (_p, args) => {
  const data = decode(args[0]);
  return later(new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new P2PACTError(ErrFailed, "no call came behind")), 30_000);
    held.push(() => {
      clearTimeout(t);
      resolve([data]);
    });
  }));
});
node.start();

const say = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const grantsIn = (l: [string, number][] | undefined): Grant[] => (l ?? []).map(([tool, level]) => ({ tool, level }));
const grantsOut = (g: Grant[]) => g.map((x) => [x.tool, x.level]);
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const events: { peer: string; tool: string; event: number; data: string }[] = [];
const ownTools = new Map<string, number>();
node.onEvent = (peer, tool, event, args) => {
  events.push({ peer, tool: node.peerToolName(peer, tool), event, data: args.length ? b64(decode(args[0]) as Uint8Array) : "" });
};

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let req: Record<string, any>;
  try {
    req = JSON.parse(line);
  } catch {
    say({ error: "bad json" });
    continue;
  }
  try {
    switch (req.cmd) {
      case "listen":
        if (req.udp) await node.listenUDP(req.udp);
        if (req.tcp !== undefined) await node.listenTCP(req.tcp);
        say({ addr: node.id.addr, udp: node.udpRoad?.localAddr() ?? "", tcp: node.tcpRoad?.localAddr() ?? "" });
        break;
      case "relay": // the relay as a WebSocket device dials it: the ws URLs (addr and fp are the TLS road, which this peer does not have)
        node.setRelay(req.ws ?? []);
        say({ ok: true });
        break;
      case "invite":
        say({ invite: node.invite(600_000).toString() });
        break;
      case "join":
        const inv = Invite.parse(req.invite);
        const p = req.wants ? await node.joinWants(inv, grantsIn(req.wants), 15_000) : await node.join(inv, 15_000);
        say({ peer: p.addr });
        break;
      case "known":
        say({ known: !!node.trust.get(req.peer) });
        break;
      case "call": {
        const res = await node.callOn(req.peer, Number(req.stream ?? 0), 64, 1, new Uint8Array(Buffer.from(req.data, "base64")));
        say({ data: b64(decode(res[0]) as Uint8Array) });
        break;
      }
      case "later": {
        const data = new Uint8Array(Buffer.from(req.data, "base64"));
        const stream = Number(req.stream ?? 0);
        const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
          Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(what + ": no answer")), ms).unref())]);
        const first = timeout(node.callOn(req.peer, stream, 64, 2, data), 20_000, "the held call");
        first.catch(() => {});
        await new Promise((r) => setTimeout(r, 100)); // the held call goes first
        await timeout(node.callOn(req.peer, stream, 64, 1, new TextEncoder().encode("behind")), 10_000, "the call behind the held one");
        say({ data: b64(decode((await first)[0]) as Uint8Array) });
        break;
      }
      case "dict":
        node.addDict(new Uint8Array(Buffer.from(req.raw, "base64")));
        say({ ok: true });
        break;
      case "dict-state": {
        const st = node.dictState(req.peer);
        say({ own: st.own && b64(st.own), using: st.using && b64(st.using), training: st.training });
        break;
      }
      case "kind":
        node.kind = req.kind;
        say({ ok: true });
        break;
      case "peer-info":
        say({ kind: node.trust.get(req.peer)?.kind ?? 0, tools: node.peerTools(req.peer), number: (req.tool && node.toolNumber(req.peer, req.tool)) ?? null });
        break;
      case "tool": {
        const name: string = req.name;
        const num = node.registerTool(name, 1);
        ownTools.set(name, num);
        const echo = (_p: string, args: Uint8Array[]) => [decode(args[0])];
        node.handleTool(name, 1, echo);
        node.handleTool(name, 2, echo);
        node.handleTool(name, 3, () => [new TextEncoder().encode(name)]);
        node.markRead(num, 1, 3);
        say({ number: num });
        break;
      }
      case "call-tool":
        try {
          const res = await node.callToolOn(req.peer, Number(req.stream ?? 0), req.name, req.method, bytes(req.data));
          say({ data: b64(decode(res[0]) as Uint8Array) });
        } catch (e) {
          say({ error: (e as Error).message, code: e instanceof P2PACTError ? e.code : undefined });
        }
        break;
      case "grant":
        node.grant(req.peer, req.tool, req.level);
        say({ ok: true });
        break;
      case "set-grants":
        node.setGrants(req.peer, grantsIn(req.grants));
        say({ ok: true });
        break;
      case "grants":
        say({ allowed: grantsOut(node.grants(req.peer)), granted: grantsOut(node.grantedBy(req.peer)) });
        break;
      case "emit":
        node.event(req.peer, ownTools.get(req.name)!, req.event, bytes(req.data));
        say({ ok: true });
        break;
      case "events":
        say({ events });
        break;
      case "on-wants": {
        const max: number = req.level;
        node.onWants = (_p, wants) => wants.map((g) => ({ tool: g.tool, level: Math.min(g.level, max) }));
        say({ ok: true });
        break;
      }
      case "local":
        if (req.listen) await node.listenLocal(req.listen);
        else await node.useLocal(req.use);
        say({ ok: true });
        break;
      case "plugin-env": {
        const env = node.pluginEnv(600_000, grantsIn(req.grants));
        say({ socket: env.P2PACT_SOCKET, invite: env.P2PACT_INVITE });
        break;
      }
      case "proxy": {
        const name: string = req.name, plugin: string = req.plugin;
        node.handleToolAll(name, async (_p, level, method, args) => {
          if (method === 2 && level < 2) throw new P2PACTError(4, "forbidden");
          const res = await node.callTool(plugin, name, method, ...args.map((a) => decode(a)));
          return res.map((r) => decode(r));
        });
        say({ ok: true });
        break;
      }
      case "close":
        node.close();
        process.exit(0);
      default:
        say({ error: "unknown command " + req.cmd });
    }
  } catch (e) {
    say({ error: (e as Error).message });
  }
}
node.close();
