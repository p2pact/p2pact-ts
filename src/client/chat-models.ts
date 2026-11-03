// Types of tool 1 `p2pact.chat` (chat spec): ACP with `_meta.p2pact`. Unknown fields are ignored;
// every value keeps the JSON it was read from in `raw`.
import { asList, bool, num, obj, objs, p2pactMeta, str, type JsonMap } from "./support.js";

export interface AgentInfo {
  id: string;
  name: string;
  version?: string;
  raw: JsonMap;
}

export const parseAgent = (m: JsonMap): AgentInfo => ({ id: str(m, "id") ?? "", name: str(m, "name") ?? str(m, "id") ?? "", version: str(m, "version"), raw: m });

/** The answer to `initialize`: what the computer's chat offers. */
export interface InitializeResult {
  protocolVersion: number;
  agentName?: string;
  agentTitle?: string;
  agentVersion?: string;
  /** `session/load` works. */
  loadSession: boolean;
  /** The agents the computer can start (`_meta.p2pact.agents`), the first is the default. */
  agents: AgentInfo[];
  /** The computer speaks the `_p2pact/<name>` extensions. */
  extensions: boolean;
  raw: JsonMap;
}

export function parseInitialize(m: JsonMap): InitializeResult {
  const info = obj(m, "agentInfo");
  const meta = p2pactMeta(m);
  return {
    protocolVersion: num(m, "protocolVersion") ?? 1,
    agentName: info && str(info, "name"),
    agentTitle: info && str(info, "title"),
    agentVersion: info && str(info, "version"),
    loadSession: bool(obj(m, "agentCapabilities") ?? {}, "loadSession") ?? false,
    agents: objs(meta, "agents").map(parseAgent),
    extensions: (num(meta, "ext") ?? 0) >= 1,
    raw: m,
  };
}

export type SessionState = "working" | "waiting" | "idle" | "closed" | "unknown";

const states = new Set(["working", "waiting", "idle", "closed"]);

/** A chat of a computer: an entry of `session/list` or `_p2pact/session_changed`. */
export interface ChatSession {
  id: string;
  cwd?: string;
  title?: string;
  agent?: string;
  /** `waiting` — waits for the person. */
  state: SessionState;
  /** RFC 3339. */
  updatedAt?: string;
  raw: JsonMap;
}

export function parseSession(m: JsonMap): ChatSession {
  const meta = p2pactMeta(m);
  const st = str(meta, "state");
  return {
    id: str(m, "sessionId") ?? "",
    cwd: str(m, "cwd"),
    title: str(meta, "title") ?? str(m, "title"),
    agent: str(meta, "agent"),
    state: st && states.has(st) ? (st as SessionState) : "unknown",
    updatedAt: str(meta, "updatedAt") ?? str(m, "updatedAt"),
    raw: m,
  };
}

export interface SessionList {
  sessions: ChatSession[];
  nextCursor?: string;
  raw: JsonMap;
}

/** An ACP content block: text, image, resource_link… */
export interface ContentBlock {
  type: string;
  text?: string;
  raw: JsonMap;
}

export const parseBlock = (m: JsonMap | undefined): ContentBlock => ({ type: (m && str(m, "type")) ?? "", text: m && str(m, "text"), raw: m ?? {} });
export const textBlock = (text: string): JsonMap => ({ type: "text", text });
export const imageBlock = (mimeType: string, base64: string): JsonMap => ({ type: "image", mimeType, data: base64 });

/** A tool call of an agent (`tool_call`, `tool_call_update` and the `toolCall` of a permission request). */
export interface ToolCallInfo {
  toolCallId: string;
  title?: string;
  /** ACP's kind: execute, read, edit… */
  kind?: string;
  /** pending, in_progress, completed, failed. */
  status?: string;
  raw: JsonMap;
}

export const parseToolCall = (m: JsonMap): ToolCallInfo => ({ toolCallId: str(m, "toolCallId") ?? "", title: str(m, "title"), kind: str(m, "kind"), status: str(m, "status"), raw: m });

export interface PlanEntry {
  content: string;
  priority?: string;
  status?: string;
  raw: JsonMap;
}

interface UpdateBase {
  sessionId: string;
  /** Numbers the messages of a session; a client that loads a session again skips what it has shown
   * (chat spec §8). The pieces of a streamed agent message carry no `seq` but the first. */
  seq?: number;
  /** RFC 3339. */
  time?: string;
  /** The `update` object. */
  raw: JsonMap;
}

/** ChatUpdate is a `session/update`: a live message of a chat or a replayed one (`session/load`).
 * Switch on `type`; `other` is an update this SDK has no type for (read `raw`). */
export type ChatUpdate =
  | (UpdateBase & { type: "user_message" | "agent_message" | "agent_thought"; content: ContentBlock; text: string })
  | (UpdateBase & { type: "tool_call" | "tool_call_update"; call: ToolCallInfo })
  | (UpdateBase & { type: "plan"; entries: PlanEntry[] })
  | (UpdateBase & { type: "mode_changed"; modeId: string })
  | (UpdateBase & { type: "other"; updateType: string });

export function parseUpdate(sessionId: string, u: JsonMap): ChatUpdate {
  const meta = p2pactMeta(u);
  const base = { sessionId, seq: num(meta, "seq"), time: str(meta, "time"), raw: u };
  const message = (type: "user_message" | "agent_message" | "agent_thought"): ChatUpdate => {
    const content = parseBlock(obj(u, "content"));
    return { ...base, type, content, text: content.text ?? "" };
  };
  const updateType = str(u, "sessionUpdate") ?? "";
  switch (updateType) {
    case "user_message_chunk": return message("user_message");
    case "agent_message_chunk": return message("agent_message");
    case "agent_thought_chunk": return message("agent_thought");
    case "tool_call": return { ...base, type: "tool_call", call: parseToolCall(u) };
    case "tool_call_update": return { ...base, type: "tool_call_update", call: parseToolCall(u) };
    case "plan": return { ...base, type: "plan", entries: objs(u, "entries").map((e) => ({ content: str(e, "content") ?? "", priority: str(e, "priority"), status: str(e, "status"), raw: e })) };
    case "current_mode_update": return { ...base, type: "mode_changed", modeId: str(u, "currentModeId") ?? "" };
    default: return { ...base, type: "other", updateType };
  }
}

export interface NewSession {
  sessionId: string;
  raw: JsonMap;
}

/** What `session/load` gave: the replayed `updates` (all of them have come when it returns);
 * `older` — the chat is long and this is its tail: fetch the rest with `older()`. */
export interface LoadedSession {
  sessionId: string;
  updates: ChatUpdate[];
  older: boolean;
  raw: JsonMap;
}

export interface PromptResult {
  stopReason?: string;
  /** The `mid` was already executed; nothing was sent again. */
  duplicate: boolean;
  raw: JsonMap;
}

/** A message of a conversation, as `_p2pact/older` gives it. */
export interface ChatMessage {
  seq: number;
  role: string;
  text: string;
  time?: string;
  images: string[];
  raw: JsonMap;
}

export const parseMessage = (m: JsonMap): ChatMessage => ({
  seq: num(m, "seq") ?? 0, role: str(m, "role") ?? "", text: str(m, "text") ?? "", time: str(m, "time"),
  images: (asList(m.images) ?? []).filter((x): x is string => typeof x === "string"), raw: m,
});

export interface OlderPage {
  sessionId: string;
  messages: ChatMessage[];
  more: boolean;
  raw: JsonMap;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  status?: string;
}

export interface DiffResult {
  files: DiffFile[];
  patch: string;
  truncated: boolean;
  /** `not_found`, `not_git` or text. */
  error?: string;
  raw: JsonMap;
}

export interface ImageResult {
  /** Base64. */
  data?: string;
  /** `not_found`, `no_file`, `too_big`, `bad_image`. */
  error?: string;
  raw: JsonMap;
}

/** `_p2pact/request_answered`: another client answered; stop showing the request. */
export interface RequestAnswered {
  sessionId: string;
  toolCallId: string;
}

// --- the computer asks, the application answers ---

export interface PermissionOption {
  optionId: string;
  name: string;
  /** allow_once, allow_always, reject_once, reject_always. */
  kind?: string;
  description?: string;
  raw: JsonMap;
}

/** The outcome of a permission request. */
export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/**
 * PermissionRequest is `session/request_permission` (chat spec §6): the agent asks the person to
 * allow something. It is also how an agent asks a single question: `toolCall.title` is the
 * question and the options are the answers (§9.1).
 */
export class PermissionRequest {
  constructor(
    readonly sessionId: string,
    readonly toolCall: ToolCallInfo,
    readonly options: PermissionOption[],
    readonly raw: JsonMap,
    /** Resolves when another client answered first ({@link RequestAnswered}): stop showing the request. */
    readonly answered: Promise<void>,
  ) {}

  /** The first option that allows, once before always; cancelled if there is none. */
  allow(): PermissionOutcome {
    return this.pick("allow_once", "allow_always");
  }

  /** The first option that rejects. */
  deny(): PermissionOutcome {
    return this.pick("reject_once", "reject_always");
  }

  select(option: PermissionOption): PermissionOutcome {
    return { outcome: "selected", optionId: option.optionId };
  }

  private pick(...kinds: string[]): PermissionOutcome {
    for (const k of kinds) {
      const o = this.options.find((x) => x.kind === k);
      if (o) return this.select(o);
    }
    return { outcome: "cancelled" };
  }
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  /** The answer may take several options. */
  multi: boolean;
  options: QuestionOption[];
}

/** QuestionRequest is `_p2pact/question`: several questions, or answers that may take several options (§9.1). */
export class QuestionRequest {
  constructor(
    readonly sessionId: string,
    readonly toolCallId: string,
    readonly questions: Question[],
    readonly raw: JsonMap,
    readonly answered: Promise<void>,
  ) {}

  /** The answer to a `multi` question: the labels joined by ", ". */
  static join(labels: string[]): string {
    return labels.join(", ");
  }
}

/** The application's answer to permission requests: resolves when the person decided. */
export type PermissionHandler = (request: PermissionRequest) => PermissionOutcome | Promise<PermissionOutcome>;

/** The application's answer to questions: {question text → label} (see {@link QuestionRequest.join});
 * a rejection answers with an error (the question stays open on the computer). */
export type QuestionHandler = (request: QuestionRequest) => Record<string, string> | Promise<Record<string, string>>;
