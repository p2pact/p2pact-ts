// Grants (spec §8.1): what a trusted device may use of a device's tools.
import type { CborValue } from "./cbor.js";

/** Levels of a grant. */
export const LevelRead = 1; // the methods a tool marks as read, and the tool's events
export const LevelWrite = 2; // everything

/** AllTools is the tool name that stands for every tool, present and future. */
export const AllTools = "*";

/** Grant lets a device use a tool at a level: one element of [[tool name, level]…]. */
export interface Grant {
  tool: string;
  level: number;
}

/** defaultGrants is what a person's own device gets: everything, ["*", 2]. */
export const defaultGrants = (): Grant[] => [{ tool: AllTools, level: LevelWrite }];

/** grantLevel is the level a list of grants gives for a tool name: the highest of the entries
 * that name it or "*"; 0 — none. An undefined list is the default (everything). */
export function grantLevel(grants: Grant[] | undefined, tool: string): number {
  if (!grants) return LevelWrite;
  let level = 0;
  for (const g of grants) if ((g.tool === tool || g.tool === AllTools) && g.level > level) level = g.level;
  return level;
}

export function isDefaultGrants(g: Grant[] | undefined): boolean {
  return !g || (g.length === 1 && g[0].tool === AllTools && g[0].level === LevelWrite);
}

/** grantsWire is the grants as they go on the wire: [[tool name, level]…]. */
export const grantsWire = (g: Grant[]): CborValue => g.map((x) => [x.tool, x.level]);

/** parseGrants reads [[tool name, level]…]; a malformed entry is skipped. undefined — not a list. */
export function parseGrants(v: CborValue): Grant[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Grant[] = [];
  for (const e of v) {
    if (!Array.isArray(e) || e.length < 2 || typeof e[0] !== "string" || typeof e[1] !== "number" || e[1] < 1) continue;
    out.push({ tool: e[0], level: Math.min(e[1], LevelWrite) });
  }
  return out;
}

/** cleanGrants drops entries without a level and merges repeats, keeping the highest. */
export function cleanGrants(list: Grant[]): Grant[] {
  const out: Grant[] = [];
  for (const g of list) {
    if (!g.tool || g.level < 1) continue;
    const level = Math.min(g.level, LevelWrite);
    const old = out.find((x) => x.tool === g.tool);
    if (old) old.level = Math.max(old.level, level);
    else out.push({ tool: g.tool, level });
  }
  return out;
}
