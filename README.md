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

- `call` / `handle` — calls and results; `event` / `onEvent` — events either way.
- `addDict` — a compression dictionary; a missing one is fetched from the sender.
- `befriend` — add a device known from the family book without pairing.

## Status

Pairing, sessions, UDP and TCP roads, delivery with congestion control, messages,
compression with dictionaries. Not yet: the relay road, the family tool, Bluetooth.

## Develop

```sh
npm install
npm test
```

`dist/src/interop.js` is the interop peer used by p2pact-tests.

## License

[Apache License 2.0](LICENSE).
