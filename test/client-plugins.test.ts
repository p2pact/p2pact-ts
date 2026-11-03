import { test } from "node:test";
import assert from "node:assert/strict";
import { LevelRead, LevelWrite, type Grant } from "../src/index.js";
import { DEFAULT_WANTS, ForbiddenError, NoMethodError, Tools } from "../src/client/index.js";
import { Fixtures, Harness } from "./client-util.js";

const wants: Grant[] = [...DEFAULT_WANTS, { tool: "com.example.hello", level: LevelWrite }];

async function run(body: (h: Harness) => Promise<void>) {
  const h = new Harness();
  try {
    await body(h);
  } finally {
    h.close();
  }
}

test("plugins: list, log, grants", () => run(async (h) => {
  const plugins = (await h.connect(wants)).plugins;
  const p = (await plugins.list())[0];
  assert.equal(p.name, "com.example.hello");
  assert.equal(p.status, "running");
  assert.ok(p.enabled);
  assert.equal(p.pid, 4242);
  assert.deepEqual(p.announced, ["com.example.hello"]);
  assert.deepEqual(p.needs, ["p2pact.chat:read"]);

  assert.equal(await plugins.log("com.example.hello", 2), "started\nready\n");
  assert.deepEqual(h.sent(4, "plugins/log"), Fixtures.params("p2pact.plugins", "plugins.log.request"));

  const g = await plugins.grants("com.example.hello");
  assert.deepEqual(g.grants, [{ tool: "p2pact.chat", level: LevelRead }]);
  assert.deepEqual(g.read, { "com.example.hello": [2] });

  // plugins are asked for with read only: writing needs the person to widen it
  await assert.rejects(plugins.enable("com.example.hello"), ForbiddenError);
}));

test("plugins: enable and disable with write", () => run(async (h) => {
  const computer = await h.connect([...wants.filter((g) => g.tool !== Tools.PLUGINS), { tool: Tools.PLUGINS, level: LevelWrite }]);
  await computer.plugins.enable("com.example.hello");
  assert.deepEqual(h.sent(4, "plugins/enable"), Fixtures.params("p2pact.plugins", "plugins.enable.request"));
  await computer.plugins.disable("com.example.hello");
  assert.deepEqual(h.sent(4, "plugins/disable"), Fixtures.params("p2pact.plugins", "plugins.disable.request"));
}));

test("calls a plugin's tool by name", () => run(async (h) => {
  const computer = await h.connect(wants);
  const n = computer.toolNumber("com.example.hello");
  assert.ok(n !== undefined && n >= 64, "a number from 64 up, the computer's own");
  assert.deepEqual(await computer.plugins.callTool("com.example.hello", 1, "world"), ["hello world"]);
  // a tool the computer does not announce
  await assert.rejects(computer.plugins.callTool("com.example.nothing", 1), NoMethodError);
}));

test("a tool without a grant is forbidden", () => run(async (h) => {
  const computer = await h.connect(); // no grant on the hosted tool
  await assert.rejects(computer.callTool("com.example.hello", 1, "x"), ForbiddenError);
}));
