// Builds the browser bundle for tests: dist/test-browser/p2pact.js (the same build as npm run build).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./go-util.js";

let built: string | undefined;

export async function bundle(): Promise<string> {
  if (built) return built;
  const mod = (await import(pathToFileURL(path.join(root, "scripts/build-browser.mjs")).href)) as { buildBrowser(out: string): Promise<string> };
  built = await mod.buildBrowser(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-bundle-")), "p2pact.js"));
  return built;
}
