// Helpers shared by the tests of the Go reference's suites (kind, tools, grants, wants, local).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decode, Invite, Node, P2PACTError } from "../src/index.js";

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-ts-"));

/** shortDir: a directory with a short path — a unix socket path is limited to about 100 bytes. */
export const shortDir = () => fs.mkdtempSync(path.join("/tmp", "p2p"));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function node(name: string, udp = true, kind = 0): Promise<Node> {
  const n = new Node(tmp(), name);
  if (udp) await n.listenUDP("127.0.0.1:0");
  n.handle(64, 1, (_peer, args) => [decode(args[0])]); // echo
  n.kind = kind;
  n.start();
  return n;
}

export async function pair(a: Node, b: Node) {
  const inv = Invite.parse(a.invite(60_000).toString());
  const p = await b.join(inv, 10_000);
  assert.equal(p.addr, a.id.addr);
  await eventually("the inviter remembers the joiner", () => !!a.trust.get(b.id.addr));
}

export async function echo(from: Node, to: Node, data: Uint8Array) {
  const res = await from.call(to.id.addr, 64, 1, data);
  assert.deepEqual(decode(res[0]), data);
}

/** eventually polls until cond holds. */
export async function eventually(what: string, cond: () => boolean) {
  for (let i = 0; !cond(); i++) {
    if (i > 500) assert.fail("timeout: " + what);
    await sleep(10);
  }
}

/** code is the error code of a rejected call (0 — it succeeded). */
export async function code(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    return e instanceof P2PACTError ? e.code : -1;
  }
}

export const close = (...nodes: Node[]) => nodes.forEach((n) => n.close());
