# plugin-hello

A minimal P2PACT plugin for Node.js (the same as the Go example in nomad-code, in TypeScript's
library). It announces the tool `dev.p2pact.example.hello.ts`:

- method 1 `greet [name]` returns `"Hello, <name>"` (a read method),
- method 2 `bump` increments a counter (a write method),
- event 1 `tick [counter]` every `HELLO_INTERVAL` (default 5s).

The device hosts the tool for other devices under the same name and forwards calls and events;
read or write is decided by `"read"` in `plugin.json` (methods not listed need write).

Install into a running Nomad Code engine:

```sh
npm install && npm run build            # in the repository root: builds dist/
cd examples/plugin-hello
npm install --install-links             # copies p2pact into node_modules (no symlink)
nomad plugin install .
nomad plugin log dev.p2pact.example.hello.ts
```

The device starts `node plugin.mjs` in the plugin folder with `P2PACT_SOCKET` and `P2PACT_INVITE`
(plus `P2PACT_PLUGIN_NAME`, `P2PACT_PLUGIN_DIR`, `P2PACT_PLUGIN_DATA`); `newPlugin` reads them,
dials the socket and pairs as a plugin. Keys live in `P2PACT_PLUGIN_DATA`. Node.js 22.15+.
