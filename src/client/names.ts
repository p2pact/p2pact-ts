import { LevelRead, LevelWrite, type Grant } from "../grants.js";

/** The names of the public tools (core spec §8) and their fixed numbers. */
export const Tools = {
  CHAT: "p2pact.chat",
  FLEET: "p2pact.fleet",
  PLUGINS: "p2pact.plugins",
  /** The terminal (tool 5, spec term.md): no typed client; call it with `Computer.callTool`. A
   * computer that knows it by a former name still answers once `node.aliasTool(former, TERM)`
   * is declared. */
  TERM: "p2pact.term",
  TERM_NUMBER: 5,
  CHAT_NUMBER: 1,
  FLEET_NUMBER: 2,
  PLUGINS_NUMBER: 4,
} as const;

/** What the SDK itself uses, to ask for when pairing: chat and fleet in full, the plugins' view.
 * The person of the computer may narrow it (`Computer.grants` tells what was granted). */
export const DEFAULT_WANTS: readonly Grant[] = Object.freeze([
  { tool: Tools.CHAT, level: LevelWrite },
  { tool: Tools.FLEET, level: LevelWrite },
  { tool: Tools.PLUGINS, level: LevelRead },
]);
