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

## Status

Pairing, sessions, UDP and TCP roads, delivery with congestion control, messages,
compression with the common dictionary and per-device own dictionaries. Not yet: the relay road, the family tool, Bluetooth.

## Develop

```sh
npm install
npm test
```

`dist/src/interop.js` is the interop peer used by p2pact-tests.

Own dictionaries are trained in a worker thread: the content by fastCover (the algorithm of
`zstd --train`, as p2pact-go), the entropy tables taken from the common dictionary — Node's
zstd has no trainer, and any valid zstd dictionary works, since only its owner compresses with it.

## License

[Apache License 2.0](LICENSE).
