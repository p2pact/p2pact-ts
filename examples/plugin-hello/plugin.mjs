// An example P2PACT plugin: the device starts it, it pairs over the local socket, announces the
// tool dev.p2pact.example.hello.ts and sends an event every few seconds.
//
//   tool dev.p2pact.example.hello.ts
//     method 1  greet [name]  -> "Hello, <name>"   (read: listed in plugin.json "read")
//     method 2  bump          -> counter            (write)
//     event  1  tick [counter]  every HELLO_INTERVAL (default 5s; "500ms", "2s" or milliseconds)
import { decode, newPlugin } from "p2pact";

const tool = "dev.p2pact.example.hello.ts";
const methodGreet = 1, methodBump = 2, eventTick = 1;

// "2s", "500ms" or plain milliseconds
function interval(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(text ?? "");
  const ms = m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : 0;
  return ms > 0 ? ms : 5000;
}

// Keys live in the folder the device gives the plugin; the invite and the socket come from the
// environment (P2PACT_INVITE, P2PACT_SOCKET), read by newPlugin.
const dir = process.env.P2PACT_PLUGIN_DATA || "data";
let node, host;
try {
  ({ node, host } = await newPlugin(dir, "Hello plugin (Node.js)"));
} catch (e) {
  console.error(`not started by a P2PACT device: ${e.message}`);
  process.exit(1);
}
console.log(`paired with ${host.name}`);

let counter = 0;
node.handleTool(tool, methodGreet, (_peer, args) => {
  const name = args.length ? decode(args[0]) : "";
  return [`Hello, ${typeof name === "string" && name ? name : "world"}`];
});
node.handleTool(tool, methodBump, () => [++counter]);
const num = node.registerTool(tool, 1);

const timer = setInterval(() => {
  counter++;
  try {
    node.event(host.addr, num, eventTick, counter);
  } catch (e) {
    console.error("tick:", e.message);
  }
}, interval(process.env.HELLO_INTERVAL));

const stop = () => {
  clearInterval(timer);
  node.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
