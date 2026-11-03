// Tool 4 `p2pact.plugins` (plugins spec): the plugins a computer hosts. JSON-RPC over `4.1 rpc`.
// Install and remove stay on the computer.
import type { CborValue } from "../cbor.js";
import type { Grant } from "../grants.js";
import type { Computer } from "./client.js";
import { Tools } from "./names.js";
import { asList, asMap, bool, num, obj, objs, str, strings, wire, type JsonMap } from "./support.js";

export type PluginStatus = "running" | "starting" | "restarting" | "stopped" | "failed" | "unsupported" | "broken" | "unknown";
// stopped — switched off; failed — disabled after repeated exits; unsupported — not for this system; broken — unreadable manifest

const statuses = new Set(["running", "starting", "restarting", "stopped", "failed", "unsupported", "broken"]);

export interface PluginInfo {
  name: string;
  version?: string;
  title?: string;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  restarts: number;
  pid?: number;
  /** The tool names the manifest allows. */
  tools: string[];
  /** The tools the plugin has announced now, a subset of `tools`. */
  announced: string[];
  /** `tool[:read|:write]` the plugin asked for. */
  needs: string[];
  raw: JsonMap;
}

function parsePlugin(m: JsonMap): PluginInfo {
  const st = str(m, "status");
  return {
    name: str(m, "name") ?? "", version: str(m, "version"), title: str(m, "title"), enabled: bool(m, "enabled") ?? false,
    status: st && statuses.has(st) ? (st as PluginStatus) : "unknown", error: str(m, "error"), restarts: num(m, "restarts") ?? 0, pid: num(m, "pid"),
    tools: strings(m, "tools"), announced: strings(m, "announced"), needs: strings(m, "needs"), raw: m,
  };
}

/** What a plugin may use of the computer, and which methods of its own tools need only read. */
export interface PluginGrants {
  name: string;
  grants: Grant[];
  read: Record<string, number[]>;
  raw: JsonMap;
}

export class PluginsClient {
  /** @internal */
  constructor(private readonly computer: Computer) {}

  private call(method: string, params?: JsonMap) {
    return this.computer.rpc(Tools.PLUGINS_NUMBER, method, params);
  }

  /** list is `plugins/list`. */
  async list(): Promise<PluginInfo[]> {
    return objs(await this.call("plugins/list"), "plugins").map(parsePlugin);
  }

  /** log is `plugins/log`: the last `lines` lines of the plugin's log. */
  async log(name: string, lines?: number): Promise<string> {
    return str(await this.call("plugins/log", { name, lines }), "log") ?? "";
  }

  /** grants is `plugins/grants`. */
  async grants(name: string): Promise<PluginGrants> {
    const r = await this.call("plugins/grants", { name });
    const grants: Grant[] = [];
    for (const g of asList(r.grants) ?? []) {
      const m = asMap(g);
      const tool = m && str(m, "tool"), level = m && num(m, "level");
      if (tool !== undefined && level !== undefined) grants.push({ tool, level });
    }
    const read: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(obj(r, "read") ?? {})) read[k] = (asList(v) ?? []).filter((x): x is number => typeof x === "number");
    return { name: str(r, "name") ?? name, grants, read, raw: r };
  }

  /** enable starts a plugin (and keeps it on across the computer's restarts). Needs write. */
  async enable(name: string): Promise<void> {
    await this.call("plugins/enable", { name });
  }

  async disable(name: string): Promise<void> {
    await this.call("plugins/disable", { name });
  }

  /** callTool calls a method of a tool a plugin of the computer serves (core spec §8.2) by the
   * tool's name; the number is the computer's own. See {@link Computer.callTool}. */
  callTool(name: string, method: number, ...args: unknown[]): Promise<CborValue[]> {
    return this.computer.callTool(name, method, ...args.map(wire));
  }
}
