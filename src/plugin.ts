// Plugin side (spec §2, §8.2): a program a device starts, which pairs over the device's local
// socket with kind plugin and adds tools to it.
import { KindPlugin, Node } from "./node.js";
import { Invite, type Peer } from "./store.js";

/** Environment variables a device gives a program it starts (spec §2, local programs). */
export const EnvSocket = "P2PACT_SOCKET"; // the path of the device's local socket
export const EnvInvite = "P2PACT_INVITE"; // a single-use invite with no hints

/** newPlugin is the plugin side: it reads P2PACT_SOCKET and P2PACT_INVITE (from env, by default
 * process.env), dials the socket and pairs with kind plugin and no wants. dir keeps the plugin's
 * keys; the node is started. It resolves with the node and the device the plugin runs on. A
 * plugin started again gets a new invite and pairs again. */
export async function newPlugin(dir: string, name: string, opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}):
  Promise<{ node: Node; host: Peer }> {
  const env = opts.env ?? process.env;
  const sock = env[EnvSocket], inv = env[EnvInvite];
  if (!sock || !inv) throw new Error(`${EnvSocket} and ${EnvInvite} are not set: not started by a P2PACT device`);
  const invite = Invite.parse(inv);
  const node = new Node(dir, name);
  node.kind = KindPlugin;
  try {
    await node.useLocal(sock);
    node.start();
    const host = await node.join(invite, opts.timeoutMs ?? 30_000);
    return { node, host };
  } catch (e) {
    node.close();
    throw e;
  }
}
