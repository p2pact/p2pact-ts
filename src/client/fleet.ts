// Tool 2 `p2pact.fleet` (fleet spec): the computer and its agent sessions. JSON-RPC over `2.1 rpc`.
import type { CborValue } from "../cbor.js";
import type { Computer } from "./client.js";
import {
  parseFleetMessage, parseFleetSession, parseNode,
  type CloseResult, type FleetEvent, type FleetHello, type FleetMessages, type FleetNode, type FleetSession, type FleetWatch, type SessionSpec,
} from "./fleet-models.js";
import { Tools } from "./names.js";
import { asMap, bool, Events, normalize, num, obj, objs, str, streamOf, type JsonMap } from "./support.js";

export class FleetClient {
  /** The events of the watch (`watch`); also after the computer restarted (the watch is repeated). */
  readonly events = new Events<FleetEvent>();

  private watching?: boolean; // partial, or undefined — not watching

  /** @internal */
  constructor(private readonly computer: Computer) {}

  private call(method: string, params?: JsonMap, timeoutMs?: number): Promise<JsonMap> {
    return this.computer.rpc(Tools.FLEET_NUMBER, method, params, streamOf(params && str(params, "id")), timeoutMs);
  }

  // --- read ---

  async hello(): Promise<FleetHello> {
    const r = await this.call("fleet/hello");
    return { protocol: str(r, "protocol"), node: parseNode(obj(r, "node") ?? {}), raw: r };
  }

  async node(): Promise<FleetNode> {
    return parseNode(await this.call("node/get"));
  }

  async sessions(): Promise<FleetSession[]> {
    return objs(await this.call("session/list"), "sessions").map(parseFleetSession);
  }

  /** session is `session/get`; no such session — RpcError -32004. */
  async session(id: string): Promise<FleetSession> {
    return parseFleetSession(await this.call("session/get", { id }));
  }

  /** messages is `session/messages`: the replies after number `after` (without it, the last `limit`). */
  async messages(id: string, opts: { after?: number; limit?: number } = {}): Promise<FleetMessages> {
    const r = await this.call("session/messages", { id, after: opts.after, limit: opts.limit });
    return { messages: objs(r, "messages").map(parseFleetMessage), last: num(r, "last"), older: bool(r, "older") ?? false, raw: r };
  }

  /** watch subscribes to the fleet: `events` get the changes. Close the result to stop. With
   * `partial` the agent's text comes while it is written. */
  async watch(partial = false): Promise<FleetWatch> {
    this.watching = partial;
    const r = await this.call("fleet/watch", { partial });
    return {
      sessions: objs(r, "sessions").map(parseFleetSession),
      close: async () => {
        this.watching = undefined;
        await this.call("fleet/unwatch");
      },
    };
  }

  // --- write ---

  async create(spec: SessionSpec, text?: string): Promise<FleetSession> {
    const { extra, ...fields } = spec;
    return parseFleetSession(await this.call("session/create", { spec: { ...fields, ...extra }, text }));
  }

  /** send puts a message into the session. */
  async send(id: string, text: string): Promise<void> {
    await this.call("session/send", { id, text });
  }

  /** answer answers an agent's question (`answers`: question → label) or permission (`allow`). */
  async answer(id: string, opts: { waitId?: string; answers?: Record<string, string>; allow?: boolean } = {}): Promise<void> {
    await this.call("session/answer", { id, waitId: opts.waitId, answers: opts.answers, allow: opts.allow });
  }

  async interrupt(id: string): Promise<void> {
    await this.call("session/interrupt", { id });
  }

  async close(id: string): Promise<CloseResult> {
    const r = await this.call("session/close", { id });
    return { ok: bool(r, "ok") ?? true, warning: str(r, "warning"), raw: r };
  }

  /** setKeep keeps the agent running (on) or lets it stop. */
  async setKeep(id: string, on: boolean): Promise<void> {
    await this.call("session/setKeep", { id, on });
  }

  /** The engine's state: version, mode, link, clients, peers (write: it names the device's data directory). */
  status(): Promise<JsonMap> {
    return this.call("engine/status");
  }

  settings(): Promise<JsonMap> {
    return this.call("settings/get");
  }

  /** setSettings changes settings and gives them as they are after; invalid `patch` — RpcError -32602. */
  setSettings(patch: JsonMap): Promise<JsonMap> {
    return this.call("settings/set", { patch });
  }

  /** Any other method of the fleet. */
  request(method: string, params?: JsonMap): Promise<JsonMap> {
    return this.call(method, params);
  }

  // --- events ---

  /** @internal */
  reconnected() {
    // the device forgot the subscription with its restart (fleet spec §4)
    if (this.watching === undefined) return;
    this.call("fleet/watch", { partial: this.watching }).catch(() => {});
  }

  /** @internal */
  notified(args: CborValue[]) {
    const msg = asMap(normalize(args[0]));
    const method = msg && str(msg, "method");
    if (!msg || !method) return;
    const p = obj(msg, "params") ?? {};
    switch (method) {
      case "session/changed": return this.events.emit({ type: "sessions", sessions: objs(p, "sessions").map(parseFleetSession) });
      case "session/messages": return this.events.emit({ type: "messages", id: str(p, "id") ?? "", messages: objs(p, "messages").map(parseFleetMessage) });
      case "session/resync": return this.events.emit({ type: "resync", id: str(p, "id") ?? "" });
      case "session/partial": return this.events.emit({ type: "partial", id: str(p, "id") ?? "", message: obj(p, "message") ?? {} });
      case "notify": return this.events.emit({ type: "notify", text: str(p, "text") ?? "" });
      default: return this.events.emit({ type: "other", method, params: p });
    }
  }
}
