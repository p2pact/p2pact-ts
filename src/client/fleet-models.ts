// Tool 2 `p2pact.fleet` (fleet spec): the computer and its agent sessions. JSON-RPC over `2.1 rpc`.
import { parseAgent, type AgentInfo } from "./chat-models.js";
import { bool, num, obj, objs, str, type JsonMap } from "./support.js";

/** The computer as the fleet describes it (`Node`). */
export interface FleetNode {
  id: string;
  name: string;
  os?: string;
  /** online, lid, battery, temperature, working… as the computer reports. */
  status: JsonMap;
  agents: AgentInfo[];
  capabilities: JsonMap;
  raw: JsonMap;
}

export function parseNode(m: JsonMap): FleetNode {
  const caps = obj(m, "capabilities") ?? {};
  return { id: str(m, "id") ?? "", name: str(m, "name") ?? "", os: str(m, "os"), status: obj(m, "status") ?? {}, agents: objs(caps, "agents").map(parseAgent), capabilities: caps, raw: m };
}

export interface FleetHello {
  protocol?: string;
  node: FleetNode;
  raw: JsonMap;
}

/** An agent session of the fleet (`Session`): the same id as the chat's. */
export interface FleetSession {
  id: string;
  agent?: string;
  model?: string;
  dir?: string;
  keep?: boolean;
  perms?: string;
  /** starting, working, waiting, idle… as the computer says. */
  phase?: string;
  title?: string;
  /** RFC 3339. */
  updated?: string;
  /** The `ask` of the status, if the agent waits for the person. */
  ask?: unknown;
  raw: JsonMap;
}

export function parseFleetSession(m: JsonMap): FleetSession {
  const spec = obj(m, "spec") ?? {};
  const st = obj(m, "status") ?? {};
  return {
    id: str(m, "id") ?? "", agent: str(spec, "agent"), model: str(spec, "model"), dir: str(spec, "dir"), keep: bool(spec, "keep"),
    perms: str(spec, "perms"), phase: str(st, "phase"), title: str(st, "title"), updated: str(st, "updated"), ask: st.ask, raw: m,
  };
}

/** What `session/create` starts. `extra` is added as it is, for fields this SDK does not know. */
export interface SessionSpec {
  agent?: string;
  dir?: string;
  model?: string;
  keep?: boolean;
  perms?: string;
  extra?: JsonMap;
}

export interface FleetMessage {
  seq: number;
  role: string;
  text: string;
  time?: string;
  raw: JsonMap;
}

export const parseFleetMessage = (m: JsonMap): FleetMessage => ({ seq: num(m, "seq") ?? 0, role: str(m, "role") ?? "", text: str(m, "text") ?? "", time: str(m, "time"), raw: m });

/** `session/messages`: the replies after a number; `older` — there are earlier ones. */
export interface FleetMessages {
  messages: FleetMessage[];
  last?: number;
  older: boolean;
  raw: JsonMap;
}

export interface CloseResult {
  ok: boolean;
  /** Done, but not smoothly. */
  warning?: string;
  raw: JsonMap;
}

/** An event of a watch (fleet spec §4). */
export type FleetEvent =
  /** The whole list, at every change. */
  | { type: "sessions"; sessions: FleetSession[] }
  /** New replies of a session. */
  | { type: "messages"; id: string; messages: FleetMessage[] }
  /** Replies of `id` were lost: read `messages(id, after)` again. */
  | { type: "resync"; id: string }
  /** The agent's text while it is written (only if the watch asked for `partial`). */
  | { type: "partial"; id: string; message: JsonMap }
  /** What the computer would show as a notification. */
  | { type: "notify"; text: string }
  | { type: "other"; method: string; params: JsonMap };

/** An active watch: `close()` unsubscribes. */
export interface FleetWatch {
  /** The sessions at the start. */
  sessions: FleetSession[];
  close(): Promise<void>;
}
