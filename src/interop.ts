#!/usr/bin/env node
// Interop peer for p2pact-tests: a P2PACT node driven by JSON lines on stdin, answering on
// stdout. Every implementation ships one, so any two can be tested against each other.
//
//   {"cmd":"listen","udp":"127.0.0.1:0","tcp":"127.0.0.1:0"}  → {"addr":"…","udp":"…","tcp":"…"}
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
// Errors: {"error":"…"}.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { decode } from "./cbor.js";
import { ErrFailed, later, Node, P2PACTError } from "./node.js";
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

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let req: Record<string, string>;
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
      case "invite":
        say({ invite: node.invite(600_000).toString() });
        break;
      case "join":
        say({ peer: (await node.join(Invite.parse(req.invite), 15_000)).addr });
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
