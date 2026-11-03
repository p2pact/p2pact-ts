// Tool 1 `p2pact.chat`: ACP over P2PACT with the `_p2pact/<name>` extensions (chat spec).
import type { CborValue } from "../cbor.js";
import { hex, randomBytes } from "../crypto.js";
import { decode } from "../cbor.js";
import type { StreamId } from "../delivery.js";
import {
  parseInitialize, parseMessage, parseSession, parseUpdate, parseToolCall, textBlock, PermissionRequest, QuestionRequest,
  type ChatMessage, type ChatSession, type ChatUpdate, type DiffResult, type ImageResult, type InitializeResult, type LoadedSession,
  type NewSession, type OlderPage, type PermissionHandler, type PermissionOutcome, type PromptResult, type QuestionHandler,
  type RequestAnswered, type SessionList,
} from "./chat-models.js";
import type { Computer } from "./client.js";
import { FailedError, RpcError } from "./errors.js";
import { Tools } from "./names.js";
import { afterEvents, asMap, deferred, bool, Events, normalize, num, obj, objs, p2pactMeta, str, streamOf, wire, type JsonMap } from "./support.js";

/**
 * ChatClient is tool 1 `p2pact.chat` of one computer. Methods that read need level 1 on the
 * tool, the others level 2; a method the grants refuse rejects with ForbiddenError.
 *
 * `initialize` goes first by itself (and again after the computer's hello comes anew). All calls
 * about one session ride the session's own stream, as the spec says.
 */
export class ChatClient {
  /** Live messages of chats (and the history while a session is loaded). */
  readonly updates = new Events<ChatUpdate>();
  /** A chat appeared, changed state or title, or closed (`_p2pact/session_changed`). */
  readonly sessionChanges = new Events<ChatSession>();
  /** Another client answered a request: stop showing it. */
  readonly requestAnswered = new Events<RequestAnswered>();
  /** Late lines of extension commands (`_p2pact/report`): JSON objects with `cmd`. */
  readonly reports = new Events<JsonMap>();

  /** Answers `session/request_permission`; without one the computer gets "no such method" and asks elsewhere. */
  permissionHandler?: PermissionHandler;
  /** Answers `_p2pact/question`. */
  questionHandler?: QuestionHandler;

  private known = new Map<string, ChatSession>();
  private collectors = new Set<{ id: string; list: ChatUpdate[] }>();
  private pending = new Map<string, () => void>();
  private initialized?: Promise<InitializeResult>;
  private initResult?: InitializeResult;

  /** @internal */
  constructor(private readonly computer: Computer) {}

  /** The chats seen so far (from lists and changes), without the closed. */
  get sessions(): ChatSession[] {
    return [...this.known.values()];
  }

  /** What `initialize` said, once it has. */
  get info(): InitializeResult | undefined {
    return this.initResult;
  }

  // --- connection ---

  /** initialize says hello to the computer's chat: capabilities, the agents it offers. It also asks
   * for the extension notifications (`_meta.p2pact.ext: 1`). The other calls do it for you. */
  initialize(): Promise<InitializeResult> {
    const params = { protocolVersion: 1, clientCapabilities: {}, _meta: { p2pact: { ext: 1 } } };
    const p = this.computer.rpc(Tools.CHAT_NUMBER, "initialize", params).then((r) => (this.initResult = parseInitialize(r)));
    this.initialized = p;
    p.catch(() => {
      if (this.initialized === p) this.initialized = undefined;
    });
    return p;
  }

  /** @internal */
  reconnected() {
    this.initialized = undefined;
  }

  private async call(method: string, params: JsonMap | undefined, stream: StreamId = 0, timeoutMs?: number): Promise<JsonMap> {
    await (this.initialized ?? this.initialize());
    return this.computer.rpc(Tools.CHAT_NUMBER, method, params, stream, timeoutMs);
  }

  /** call, then wait for the events queued on the stream before the result (a result may come ahead of them). */
  private async settledCall(method: string, params: JsonMap | undefined, stream: StreamId): Promise<JsonMap> {
    const r = await this.call(method, params, stream);
    await afterEvents();
    return r;
  }

  // --- chats ---

  /** listSessions is `session/list`: one page. */
  async listSessions(cwd?: string, cursor?: string): Promise<SessionList> {
    const r = await this.call("session/list", { cwd, cursor });
    const sessions = objs(r, "sessions").map(parseSession);
    sessions.forEach((s) => this.remember(s));
    return { sessions, nextCursor: str(r, "nextCursor"), raw: r };
  }

  /** listAllSessions follows the cursor to the end. */
  async listAllSessions(cwd?: string): Promise<ChatSession[]> {
    const all: ChatSession[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listSessions(cwd, cursor);
      all.push(...page.sessions);
      if (!page.nextCursor || page.sessions.length === 0) return all;
      cursor = page.nextCursor;
    }
  }

  /** newSession is `session/new`. `agent` is one of `info.agents` (default: the first), `model`
   * one of the agent's models, `text` the first task (sent at once), `perms` "skip" or "ask".
   * `mid` makes a repeat after a restart harmless. */
  async newSession(cwd: string, opts: { agent?: string; model?: string; text?: string; perms?: string; mid?: string } = {}): Promise<NewSession> {
    const meta = { agent: opts.agent, mid: opts.mid ?? newMid(), model: opts.model, text: opts.text, perms: opts.perms };
    const r = await this.call("session/new", { cwd, mcpServers: [], _meta: { p2pact: meta } });
    const sessionId = str(r, "sessionId");
    if (!sessionId) throw new FailedError("no sessionId in the answer");
    return { sessionId, raw: r };
  }

  /** loadSession is `session/load`: the chat's history comes as updates (also to `updates`) and
   * is in the result when it resolves. A long chat comes as its tail: `LoadedSession.older`;
   * `older()` fetches the earlier part. */
  async loadSession(sessionId: string, cwd = ""): Promise<LoadedSession> {
    const entry = { id: sessionId, list: [] as ChatUpdate[] };
    this.collectors.add(entry);
    try {
      const r = await this.settledCall("session/load", { sessionId, cwd, mcpServers: [] }, streamOf(sessionId));
      return { sessionId, updates: [...entry.list], older: bool(p2pactMeta(r), "older") ?? false, raw: r };
    } finally {
      this.collectors.delete(entry);
    }
  }

  /** prompt is `session/prompt`: it resolves when the agent's turn ends (minutes, no timeout);
   * the reply comes as `updates` meanwhile. `mid` is kept for repeats: send the same one if you do
   * not know whether the first went. */
  async prompt(sessionId: string, text: string | JsonMap[], mid = newMid()): Promise<PromptResult> {
    const blocks = typeof text === "string" ? [textBlock(text)] : text;
    const r = await this.call("session/prompt", { sessionId, prompt: blocks, _meta: { p2pact: { mid } } }, streamOf(sessionId), 0);
    return { stopReason: str(r, "stopReason"), duplicate: bool(r, "duplicate") ?? false, raw: r };
  }

  /** cancel is the notification `session/cancel`: the agent stops the turn. */
  cancel(sessionId: string) {
    this.computer.notify(Tools.CHAT_NUMBER, "session/cancel", { sessionId }, streamOf(sessionId));
  }

  setMode(sessionId: string, modeId: string): Promise<JsonMap> {
    return this.call("session/set_mode", { sessionId, modeId }, streamOf(sessionId));
  }

  setModel(sessionId: string, modelId: string): Promise<JsonMap> {
    return this.call("session/set_model", { sessionId, modelId }, streamOf(sessionId));
  }

  /** request is any ACP or extension method that has no typed call: the `result` object. It rides
   * the stream of the params' `sessionId`, or `stream` when given (0: the computer's own stream).
   * Like `loadSession`, it resolves after the events the computer sent before the result have been handled. */
  request(method: string, params: JsonMap, stream?: StreamId): Promise<JsonMap> {
    return this.settledCall(method, params, stream ?? streamOf(str(params, "sessionId")));
  }

  // --- extensions (chat spec §10) ---

  /** command calls `_p2pact/<name>` and gives its lines (§9.3): JSON objects with `cmd`. Lines that
   * come later arrive in `reports`. A failure the person should see is the line `{"cmd":"alert"}`. */
  async command(name: string, params: JsonMap = {}): Promise<JsonMap[]> {
    return objs(await this.settledCall(`_p2pact/${name}`, params, streamOf(str(params, "sessionId"))), "lines");
  }

  /** close closes the chat: it leaves the list. */
  close(sessionId: string) {
    return this.command("close", { sessionId });
  }

  /** restart starts the agent of a chat again. */
  restart(sessionId: string) {
    return this.command("restart", { sessionId });
  }

  /** hide hides a chat from the list (on) or shows it again. */
  hide(sessionId: string, on = true) {
    return this.command("hide", { sessionId, on });
  }

  /** older is `_p2pact/older`: the page of messages just before `before` (the `seq` of the oldest you have). */
  async older(sessionId: string, before: number): Promise<OlderPage> {
    const l = (await this.command("older", { sessionId, before })).find((x) => str(x, "cmd") === "older") ?? {};
    const messages: ChatMessage[] = objs(l, "messages").map(parseMessage);
    return { sessionId, messages, more: bool(l, "more") ?? false, raw: l };
  }

  /** diff is `_p2pact/diff`: the changes in the chat's folder (git). */
  async diff(sessionId: string): Promise<DiffResult> {
    const l = (await this.command("diff", { sessionId })).find((x) => str(x, "cmd") === "diff") ?? {};
    return {
      files: objs(l, "files").map((f) => ({ path: str(f, "path") ?? "", added: num(f, "added") ?? 0, removed: num(f, "removed") ?? 0, status: str(f, "status") })),
      patch: str(l, "patch") ?? "", truncated: bool(l, "truncated") ?? false, error: str(l, "error"), raw: l,
    };
  }

  /** image is `_p2pact/image`: the bytes (base64) of an image a message points to. */
  async image(sessionId: string, path: string): Promise<ImageResult> {
    const l = (await this.command("image", { sessionId, path })).find((x) => str(x, "cmd") === "image") ?? {};
    return { data: str(l, "data"), error: str(l, "error"), raw: l };
  }

  // --- from the computer ---

  private remember(s: ChatSession) {
    if (!s.id) return;
    if (s.state === "closed") this.known.delete(s.id);
    else this.known.set(s.id, s);
  }

  /** A `notify` event (`session/update`, `_p2pact/…`). @internal */
  notified(args: CborValue[]) {
    const msg = asMap(normalize(args[0]));
    if (!msg) return;
    const params = obj(msg, "params") ?? {};
    switch (str(msg, "method")) {
      case "session/update": {
        const sid = str(params, "sessionId"), u = obj(params, "update");
        if (!sid || !u) return;
        const update = parseUpdate(sid, u);
        for (const c of this.collectors) if (c.id === sid) c.list.push(update);
        this.updates.emit(update);
        return;
      }
      case "_p2pact/session_changed": {
        const s = parseSession(params);
        this.remember(s);
        this.sessionChanges.emit(s);
        return;
      }
      case "_p2pact/request_answered": {
        const sid = str(params, "sessionId"), tc = str(params, "toolCallId");
        if (!sid || !tc) return;
        this.pending.get(`${sid}/${tc}`)?.();
        this.requestAnswered.emit({ sessionId: sid, toolCallId: tc });
        return;
      }
      // _nomad/…: an engine older than the ext flag
      case "_p2pact/report":
      case "_nomad/report": {
        const line = obj(params, "line");
        if (line) this.reports.emit(line);
      }
    }
  }

  /** A request of the computer (`1.1 rpc`): the answer as a JSON-RPC message. @internal */
  async incoming(args: Uint8Array[]): Promise<CborValue[]> {
    let req: JsonMap | undefined;
    try {
      req = asMap(normalize(decode(args[0])));
    } catch {
      /* answered below */
    }
    if (!req) return error(RpcError.INVALID_PARAMS, "bad request");
    const params = obj(req, "params") ?? {};
    const sid = str(params, "sessionId") ?? "";
    switch (str(req, "method")) {
      case "session/request_permission": {
        const h = this.permissionHandler;
        if (!h) return error(RpcError.METHOD_NOT_FOUND, "method not found");
        const call = parseToolCall(obj(params, "toolCall") ?? {});
        const key = `${sid}/${call.toolCallId}`;
        const { promise: answered, resolve } = deferred<void>();
        this.pending.set(key, resolve);
        const request = new PermissionRequest(sid, call, objs(params, "options").map((o) => ({
          optionId: str(o, "optionId") ?? "", name: str(o, "name") ?? "", kind: str(o, "kind"), description: str(p2pactMeta(o), "description"), raw: o,
        })), params, answered);
        return this.ask(answered, key, () => h(request), (o: PermissionOutcome) => result({ outcome: o }));
      }
      case "_p2pact/question":
      case "_nomad/question": { // _nomad/…: an engine older than the ext flag
        const h = this.questionHandler;
        if (!h) return error(RpcError.METHOD_NOT_FOUND, "method not found");
        const tc = str(params, "toolCallId") ?? "";
        const key = `${sid}/${tc}`;
        const { promise: answered, resolve } = deferred<void>();
        this.pending.set(key, resolve);
        const request = new QuestionRequest(sid, tc, objs(params, "questions").map((q) => ({
          question: str(q, "question") ?? "", header: str(q, "header"), multi: bool(q, "multi") ?? false,
          options: objs(q, "options").map((o) => ({ label: str(o, "label") ?? "", description: str(o, "description") })),
        })), params, answered);
        return this.ask(answered, key, () => h(request), (a: Record<string, string>) => result({ answers: a }));
      }
      // fs and terminal methods: the agent device does not use our files (chat spec §7)
      default:
        return error(RpcError.METHOD_NOT_FOUND, "method not found");
    }
  }

  /** ask runs the application's handler; the request ends when it answers or another client did first. */
  private async ask<T>(answered: Promise<void>, key: string, run: () => T | Promise<T>, reply: (v: T) => CborValue[]): Promise<CborValue[]> {
    try {
      // another client answered first: our reply is not needed, but the stream must go on
      const first = await Promise.race([Promise.resolve().then(run).then((v) => ({ v })), answered.then(() => undefined)]);
      return first ? reply(first.v) : error(RpcError.FAILED, "answered elsewhere");
    } catch (e) {
      return error(RpcError.FAILED, (e as Error)?.message || "failed");
    } finally {
      this.pending.delete(key);
    }
  }

  /** A fresh message id for `prompt` and `newSession`. */
  static newMid(): string {
    return newMid();
  }
}

const newMid = () => hex(randomBytes(8));

const result = (r: unknown): CborValue[] => [wire({ jsonrpc: "2.0", result: r })];

const error = (code: number, message: string): CborValue[] => [wire({ jsonrpc: "2.0", error: { code, message } })];
