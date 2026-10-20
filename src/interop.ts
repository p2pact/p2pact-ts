#!/usr/bin/env node
// Interop peer for p2pact-tests: a P2PACT node driven by JSON lines on stdin, answering on
// stdout. Every implementation ships one, so any two can be tested against each other.
//
//   {"cmd":"listen","udp":"127.0.0.1:0","tcp":"127.0.0.1:0"}  → {"addr":"…","udp":"…","tcp":"…"}
//   {"cmd":"invite"}                                          → {"invite":"p2pact1.…"}
//   {"cmd":"join","invite":"…"}                               → {"peer":"…"}
//   {"cmd":"known","peer":"…"}                                → {"known":true|false}
//   {"cmd":"call","peer":"…","data":"<base64>"}               → {"data":"<base64>"}  (echo, tool 64 method 1)
//   {"cmd":"dict","raw":"<base64>"}                           → {"ok":true}
//   {"cmd":"close"}
// Errors: {"error":"…"}.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { decode } from "./cbor.js";
import { Node } from "./node.js";
import { Invite } from "./store.js";

const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-interop-"));
const node = new Node(dir, process.argv[3] ?? "ts");
node.handle(64, 1, (_p, args) => [decode(args[0])]);
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
        const res = await node.call(req.peer, 64, 1, new Uint8Array(Buffer.from(req.data, "base64")));
        say({ data: b64(decode(res[0]) as Uint8Array) });
        break;
      }
      case "dict":
        node.addDict(new Uint8Array(Buffer.from(req.raw, "base64")));
        say({ ok: true });
        break;
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
