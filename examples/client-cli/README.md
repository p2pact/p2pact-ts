# client-cli

A small command-line client of the P2PACT engine, built on `p2pact/client` (the same as
`examples/cli` of p2pact-kotlin).

```sh
npm install && npm run build            # in the repository root: builds dist/
cd examples/client-cli
npm install --install-links             # copies p2pact into node_modules (no symlink)

# on the computer: create an invite
nomad invite                            # prints p2pact1.…
node cli.mjs pair p2pact1.…             # the person at the computer approves the grants
node cli.mjs chats                      # id, state, agent, title, folder of every chat
node cli.mjs send <session> "run the tests"   # prints the reply, asks on permission requests
node cli.mjs watch                      # fleet changes, new messages and notifications, until Ctrl-C
```

Keys and paired computers are kept in `$P2PACT_CLI_HOME` (default `~/.p2pact-cli`). Node.js 22.15+.
