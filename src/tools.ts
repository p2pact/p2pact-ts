// Named tools (spec §8): a tool has a name, and a device numbers its named tools itself.

/** fixedTools are the tools given by the spec: the same number on every device. Their names are
 * what grants (§8.1) are written in. */
export const fixedTools: Readonly<Record<string, number>> = {
  "p2pact.service": 0,
  "p2pact.chat": 1,
  "p2pact.fleet": 2,
  "p2pact.family": 3,
  "p2pact.plugins": 4,
  "p2pact.term": 5,
};

/** fixedTool is the number the spec gives a tool name (§8): 0–63, the same on every device.
 * undefined — the name is not one of the spec's. */
export function fixedTool(name: string): number | undefined {
  return Object.hasOwn(fixedTools, name) ? fixedTools[name] : undefined;
}

/** FirstNamedTool is the first number a device may choose for a named tool (spec §8). */
export const FirstNamedTool = 64;

/** validToolName reports a tool name of spec §8: lowercase, dot-separated, the reverse of a
 * domain ("com.example.jira"). Names under "p2pact." are given by the spec. */
export function validToolName(name: string): boolean {
  const parts = name.split(".");
  if (parts.length < 2 || parts[0] === "p2pact") return false;
  return parts.every((p) => /^[a-z0-9-]+$/.test(p) && !p.startsWith("-") && !p.endsWith("-"));
}

/** ToolRef is a named tool on a device: its number there and its version. */
export interface ToolRef {
  number: number;
  version: number;
}
