# p2pact-ts

TypeScript implementation of **P2PACT — the P2P Agent Chat Transport Protocol** for Node.js: chat with
your AI agents, and let them chat with each other, across your own devices — no servers, no
accounts, over any connection.

Spec: [p2pact/p2pact](https://github.com/p2pact/p2pact). It interoperates with the
[Go implementation](https://github.com/p2pact/p2pact-go): pairing, calls and events both ways,
over UDP and TCP, compressed and not — checked by the interop tests in
[p2pact-tests](https://github.com/p2pact/p2pact-tests).

No runtime dependencies: X25519, Ed25519, ChaCha20-Poly1305, BLAKE2s and zstd all come from
Node's own `crypto` and `zlib` (Node 22.15+). Noise and CBOR are implemented here.

## Install

```sh
npm i p2pact
```

Node 22.15+. The client SDK is imported from `p2pact/client`.

## Use

```ts
import { Node, Invite, decode } from "p2pact";

const laptop = new Node("./laptop-data", "Laptop");     // keys and known devices live here
await laptop.listenUDP("0.0.0.0:48730");
await laptop.listenTCP("0.0.0.0:48730");                // fallback where UDP is blocked
laptop.handle(1, 2, (peer, args) => []);                 // chat.send: accept a message
laptop.start();

const invite = laptop.invite(10 * 60_000).toString();   // p2pact1.… — show it as a QR code

const phone = new Node("./phone-data", "Phone");
await phone.listenUDP("0.0.0.0:0");
phone.start();
const peer = await phone.join(Invite.parse(invite));     // pair once
await phone.call(peer.addr, 1, 2, 1, "run the tests");
```

- `call` / `handle` — calls and results; `event` / `onEvent` — events either way. Calls and events of one device on one stream run in the order sent, one at a time; other streams do not wait.
- `later` — a handler that waits long (an agent's turn, a person's answer) returns `later(promise)`: its stream goes on at once, and the call's result goes when the promise settles.
- `callOn` / `eventOn` — the same on a stream (one per chat): a loss on one chat does not hold
  up the others.
- `addDict(commonDict)` — the common compression dictionary (spec §5), shipped in `dict/`.
  Each device also trains its own dictionary for every device it talks to, off the sending
  path, and the other side fetches it; `dictState` tells which one compresses now,
  `noLearning` turns training off.
- `befriend` — add a device known from the family book without pairing.
- `kind` — what the device is for (`KindComputer`, `KindClient`, `KindPlugin`), told in pairing and the hello (spec §1).
- Named tools (spec §8): `registerTool` / `handleTool` / `callTool` / `toolNumber` — a tool has a reverse-domain name and each device numbers it itself; `handleToolAll` serves every method of a tool you host for another program.
- Grants (spec §8.1): `setGrants` / `grant` / `revokeGrants` say what a trusted device may use (calls outside are error 4, events only with read); `markRead`, `handleLevel` mark read methods; `grantedBy` / `onGranted` tell what a device lets *you* use. `joinWants` asks at pairing, `onWants` lets the inviting application narrow or refuse.
- Local programs (spec §2, §3): `listenLocal(path)` opens a Unix socket (mode 0600; a named pipe on Windows), `pluginEnv` gives a program it starts `P2PACT_SOCKET` and `P2PACT_INVITE`, and the program calls `newPlugin(dir, name)` to pair as a plugin. See [`examples/plugin-hello`](examples/plugin-hello).
- `allowForward(a, b, on)` — opt this device in as a forwarder between two devices it trusts
  (spec §3, via a third device): they reach each other through it when nothing else works, end
  to end encrypted. Kept with the trusted list; `forwardRate` limits each direction (256 KB/s by
  default). The two devices need nothing: they learn it from the hello and use the road
  `via:<forwarder>` (`paths`) with the same rank as an application road; a direct road takes over
  as soon as it answers. `forwards`, `forwarders` and `forwardStats` tell who forwards for whom
  and how much; `setAdvertise` announces other addresses (or none) in invites and hellos.

## Client SDK (`p2pact/client`)

A typed client of the public tools for applications (the same as `p2pact-client` of
[p2pact-kotlin](https://github.com/p2pact/p2pact-kotlin)): pair with a computer by its invite and use
its chat (tool 1, ACP), fleet (tool 2) and plugins (tool 4).

```ts
import { P2pactClient } from "p2pact/client";

const client = await P2pactClient.open("./app-data", "My app");
const computer = await client.pair("p2pact1.…");        // asks for chat, fleet, plugins:read
await computer.whenOnline();
console.log(computer.grants);                            // what the person at the computer allowed

const chat = computer.chat;
const { sessions } = await chat.listSessions();
chat.permissionHandler = (r) => r.allow();               // or ask the person; r.deny(), r.select(option)
for await (const u of chat.updates) {                    // or chat.updates.subscribe(fn), .next()
  if (u.type === "agent_message") process.stdout.write(u.text);
}
await chat.prompt(sessions[0].id, "run the tests");      // resolves when the turn ends

await computer.fleet.watch();                            // computer.fleet.events
await computer.plugins.list();
```

Calls reject with `ForbiddenError` (grants do not allow it, spec §8.1), `NoMethodError`,
`NotFoundError`… (P2PACT error codes) or `RpcError` (the tool's own JSON-RPC errors). Every value
keeps the JSON it was read from in `raw`. `P2pactClient.wrap(node)` puts the clients over a node you
already run. See [`examples/client-cli`](examples/client-cli).

## In a browser (`p2pact/browser`)

An ESM bundle (about 250 KB, 100 KB gzipped, with the common dictionary and the zstd decoder
embedded). The state lives in IndexedDB, the network is a relay over WebSocket
(`p2pact-relay -ws-host …` of p2pact-go: `wss://`), and an application road (`node.attachRoad`)
takes a WebRTC data channel. A browser decodes zstd (wasm, with dictionaries) and never compresses.

```js
import { createBrowserNode, Invite, KindClient } from "p2pact/browser";
const node = await createBrowserNode({ name: "My page", db: "p2pact-1", relay: "wss://relay.example/", kind: KindClient });
const peer = await node.join(Invite.parse(inviteString));
const result = await node.call(peer.addr, tool, method, ...args);
```

The same classes work in Node.js with other parts: `new Node(storage, name, { codec })` takes a
`Storage` (`FileStorage`, `IdbStorage`, `MemoryStorage`) and a `Codec`; `new Node(dir, name)`
from `p2pact` is the Node.js flavour (files, node:zlib, UDP, TCP, the local socket).
`node.setRelay(url)` listens on a WebSocket relay in either.

## Status

Pairing, sessions, UDP and TCP roads, delivery with congestion control, messages,
compression with the common dictionary and per-device own dictionaries, device kinds, named tools, grants, wants at pairing, the local socket road and plugins, forwarding via a third device. The relay road over WebSocket (browsers and Node.js). Not yet: the TLS relay road, the family tool, Bluetooth.

## Develop

```sh
npm install
npm test
```

`dist/src/interop.js` is the interop peer used by p2pact-tests.

Own dictionaries are trained in a worker thread: the content by fastCover (the algorithm of
`zstd --train`, as p2pact-go), the entropy tables taken from the common dictionary — Node's
zstd has no trainer, and any valid zstd dictionary works, since only its owner compresses with it.

## Publishing

For maintainers. `.github/workflows/publish.yml` runs on a `v*` tag (or by hand): build, unit
tests, then `npm publish --provenance --access public`. Before the first tag:

- npm: create an automation (or granular, publish-enabled) access token and save it as the
  repository secret `NPM_TOKEN`.
- The tag must equal `v` + `version` from `package.json`: `git tag v0.1.0 && git push origin v0.1.0`.

## License

[Apache License 2.0](LICENSE).
