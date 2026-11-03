// A real headless Chromium (playwright-core, no browser download: P2PACT_CHROME, a Playwright
// cache, or Chrome on the machine) loads the browser bundle and runs the whole thing: IndexedDB
// identity, the wasm zstd decoder, the relay over WebSocket. The page pairs with a Go device by
// its invite and calls it; after a reload the same identity is still paired and calls again.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { bundle } from "./browser-util.js";
import { goBinaries, GoPeer, startRelay, type GoRelay } from "./go-util.js";

function chrome(): string | undefined {
  const found: string[] = [];
  if (process.env.P2PACT_CHROME) found.push(process.env.P2PACT_CHROME);
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const linux = path.join(os.homedir(), ".cache/ms-playwright");
  for (const dir of [cache, linux]) {
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir).sort().reverse()) {
      if (!d.startsWith("chromium_headless_shell-") && !d.startsWith("chromium-")) continue;
      for (const sub of fs.readdirSync(path.join(dir, d))) {
        const base = path.join(dir, d, sub);
        found.push(path.join(base, "chrome-headless-shell"), path.join(base, "chrome"),
          path.join(base, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
      }
    }
  }
  found.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium");
  return found.find((f) => fs.existsSync(f));
}

const bins = goBinaries();
const exe = chrome();
const skip = !bins ? "Go or ../p2pact-go is not available" : !exe ? "no Chromium (set P2PACT_CHROME)" : false;
let relay: GoRelay;
let server: http.Server;
let url = "";

before(async () => {
  if (skip) return;
  relay = await startRelay(bins!.relay);
  const js = fs.readFileSync(await bundle());
  server = http.createServer((req, res) => {
    if (req.url === "/p2pact.js") res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    else res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>p2pact</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
after(() => {
  relay?.stop();
  server?.close();
});

test("headless Chromium: pair with a Go node over the WebSocket relay, call, reload, call again", { skip, timeout: 90_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const go = new GoPeer(bins!.interop);
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await go.cmd({ cmd: "listen" });
    const common = await page.evaluate(async () => {
      const m = await import("/p2pact.js" as string);
      return btoa(String.fromCharCode(...m.commonDict));
    });
    await go.cmd({ cmd: "dict", raw: common });
    await go.cmd({ cmd: "relay", addr: relay.addr, fp: relay.fp, ws: [relay.ws] });
    const invite = String((await go.cmd({ cmd: "invite" })).invite);
    const text = "Could you explain how a relay works? I would like a long, detailed answer. ".repeat(200);

    const first = await page.evaluate(async ({ invite, relayUrl, text }) => {
      const m = await import("/p2pact.js" as string);
      const node = await m.createBrowserNode({ name: "Chromium", db: "smoke", relay: relayUrl, kind: m.KindClient });
      node.handle(64, 1, (_p: string, args: Uint8Array[]) => [m.decode(args[0])]);
      (window as unknown as { node: unknown }).node = node;
      const peer = await node.join(m.Invite.parse(invite), 20000);
      const r = m.decode((await node.call(peer.addr, 64, 1, new TextEncoder().encode(text)))[0]) as Uint8Array;
      return { peer: peer.addr, me: node.id.addr, echoed: new TextDecoder().decode(r) === text, paths: node.paths(peer.addr) };
    }, { invite, relayUrl: relay.ws, text });
    assert.equal(first.echoed, true);
    assert.ok(first.paths[0].startsWith("relay:"), "the session runs over the relay");
    const back = await go.cmd({ cmd: "call", peer: first.me, data: Buffer.from(text).toString("base64") });
    assert.equal(Buffer.from(String(back.data), "base64").toString(), text, "the Go node calls the page");

    await page.reload();
    const second = await page.evaluate(async ({ relayUrl, peer, text }) => {
      const m = await import("/p2pact.js" as string);
      const node = await m.createBrowserNode({ name: "Chromium", db: "smoke", relay: relayUrl, kind: m.KindClient });
      node.handle(64, 1, (_p: string, args: Uint8Array[]) => [m.decode(args[0])]);
      const known = !!node.trust.get(peer);
      const r = m.decode((await node.call(peer, 64, 1, new TextEncoder().encode(text)))[0]) as Uint8Array;
      return { me: node.id.addr, known, echoed: new TextDecoder().decode(r) === text };
    }, { relayUrl: relay.ws, peer: first.peer, text });
    assert.equal(second.me, first.me, "the identity lives in IndexedDB");
    assert.equal(second.known, true);
    assert.equal(second.echoed, true);
    assert.deepEqual(errors, []);
  } finally {
    go.stop();
    await browser.close();
  }
});
