#!/usr/bin/env node
// p2pact-cli: a small client of the P2PACT engine, on p2pact/client.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { P2pactClient } from "p2pact/client";

const USAGE = `p2pact-cli: a small client of the P2PACT engine

  p2pact-cli pair <invite>          pair with a computer (invite: p2pact1.… from \`nomad invite\`)
  p2pact-cli chats                  list the chats of the paired computers
  p2pact-cli send <session> <text>  send a message and print the reply
  p2pact-cli watch                  print the changes of the fleet as they come, until Ctrl-C

State (keys, paired computers) is kept in $P2PACT_CLI_HOME, by default ~/.p2pact-cli.`;

const usage = () => {
  console.error(USAGE);
  process.exit(2);
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();
if (["-h", "--help", "help"].includes(cmd)) {
  console.log(USAGE);
  process.exit(0);
}

const home = process.env.P2PACT_CLI_HOME ?? path.join(os.homedir(), ".p2pact-cli");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const client = await P2pactClient.open(home, "p2pact-cli");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (p, ms) => Promise.race([p, sleep(ms)]);

/** The computers that answer within a few seconds. */
async function online() {
  const all = client.computers();
  if (all.length === 0) console.error("no paired computers: run `p2pact-cli pair <invite>` first");
  const up = [];
  for (const c of all) {
    await wait(c.whenOnline(), 15_000);
    if (c.state === "online") up.push(c);
    else console.error(`${c.name}: offline`);
  }
  return up;
}

async function pair(invite) {
  const computer = await client.pair(invite);
  console.log(`paired with ${computer.name} (${computer.id})`);
  // the person at the computer decides what we may use; it tells us right after
  await wait(computer.whenOnline(), 10_000);
  await sleep(1000);
  console.log("grants: " + computer.grants.map((g) => `${g.tool}:${g.level >= 2 ? "write" : "read"}`).join(", "));
}

async function chats() {
  for (const c of await online()) {
    console.log(`# ${c.name}`);
    for (const s of await c.chat.listAllSessions()) console.log([s.id, s.state, s.agent ?? "-", s.title ?? "", s.cwd ?? ""].join("\t"));
  }
}

async function send(sessionId, text) {
  for (const c of await online()) {
    const chat = c.chat;
    if (!(await chat.listAllSessions()).some((s) => s.id === sessionId)) continue;
    // the agent may ask: answer on the terminal
    chat.permissionHandler = async (r) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(`\n${r.toolCall.title ?? "permission"}: allow? [y/N] `);
      rl.close();
      return answer.trim().toLowerCase() === "y" ? r.allow() : r.deny();
    };
    chat.updates.subscribe((u) => {
      if (u.sessionId === sessionId && u.type === "agent_message") process.stdout.write(u.text);
    });
    const result = await chat.prompt(sessionId, text);
    console.log(`\n[${result.stopReason}]`);
    return 0;
  }
  console.error(`no such chat: ${sessionId}`);
  return 1;
}

async function watch() {
  const computers = await online();
  if (computers.length === 0) return 1;
  for (const c of computers) {
    c.fleet.events.subscribe((e) => {
      if (e.type === "sessions") for (const s of e.sessions) console.log(`${c.name}: ${s.id} ${s.phase} ${s.title ?? ""}`);
      else if (e.type === "messages") for (const m of e.messages) console.log(`${c.name}: ${e.id} [${m.role}] ${m.text}`);
      else if (e.type === "notify") console.log(`${c.name}: notify: ${e.text}`);
      else if (e.type === "resync") console.log(`${c.name}: ${e.id} resync`);
    });
    const w = await c.fleet.watch();
    console.log(`# ${c.name}: ${w.sessions.length} sessions, watching`);
  }
  await new Promise(() => {}); // until Ctrl-C
}

let code = 0;
try {
  switch (cmd) {
    case "pair": await pair(args[0] ?? usage()); break;
    case "chats": await chats(); break;
    case "send": code = await send(args[0] ?? usage(), args.slice(1).join(" ") || usage()); break;
    case "watch": code = (await watch()) ?? 0; break;
    default: usage();
  }
} catch (e) {
  console.error(`error: ${e?.message ?? e}`);
  code = 1
} finally {
  client.close();
}
process.exit(code);
