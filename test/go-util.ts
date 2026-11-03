// Helpers to run the Go reference (p2pact-go: the relay and the interop peer) from tests. The
// repository is taken from P2PACT_GO, else ../p2pact-go; tests that need it skip when it is
// missing or there is no Go toolchain.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const goDir = process.env.P2PACT_GO ?? path.resolve(root, "../p2pact-go");

let built: { relay: string; interop: string } | null | undefined;

/** goBinaries builds p2pact-relay and p2pact-interop once; null — Go or the repository is missing. */
export function goBinaries(): { relay: string; interop: string } | null {
  if (built !== undefined) return built;
  built = null;
  if (!fs.existsSync(path.join(goDir, "go.mod"))) return built;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-go-bin-"));
  try {
    for (const name of ["p2pact-relay", "p2pact-interop"]) {
      execFileSync("go", ["build", "-o", path.join(out, name), `./cmd/${name}`], { cwd: goDir, stdio: "pipe" });
    }
    built = { relay: path.join(out, "p2pact-relay"), interop: path.join(out, "p2pact-interop") };
  } catch {
    built = null;
  }
  return built;
}

export interface GoRelay {
  /** ws://127.0.0.1:port/ */
  ws: string;
  /** TLS address and certificate fingerprint, for Go devices */
  addr: string;
  fp: string;
  stop(): void;
}

/** startRelay runs p2pact-relay with a loopback TLS listener and a plain ws one (-ws-addr). */
export async function startRelay(bin: string): Promise<GoRelay> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-relay-"));
  const p = spawn(bin, ["-addr", "127.0.0.1:0", "-ws-addr", "127.0.0.1:0", "-data", data], { stdio: ["ignore", "ignore", "pipe"] });
  const got: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not start")), 20_000);
    p.once("exit", (c) => reject(new Error("relay exited " + c)));
    createInterface({ input: p.stderr! }).on("line", (line) => {
      const ws = /websocket relay started.*url=(\S+)/.exec(line);
      if (ws) got.ws = ws[1];
      const tls = / relay started addr=(\S+) fingerprint=(\S+)/.exec(line);
      if (tls) [got.addr, got.fp] = [tls[1], tls[2]];
      if (got.ws && got.addr) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { ws: got.ws, addr: got.addr, fp: got.fp, stop: () => p.kill() };
}

/** GoPeer drives p2pact-interop: JSON lines in, JSON lines out. */
export class GoPeer {
  private proc: ChildProcess;
  private waiting: ((v: Record<string, unknown>) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(bin: string) {
    this.proc = spawn(bin, [fs.mkdtempSync(path.join(os.tmpdir(), "p2pact-gopeer-")), "Go"], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout! }).on("line", (l) => this.waiting.shift()?.(JSON.parse(l)));
  }

  /** cmd sends one command and resolves with its answer; commands go one at a time. */
  cmd(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = async () => {
      const answer = new Promise<Record<string, unknown>>((resolve) => this.waiting.push(resolve));
      this.proc.stdin!.write(JSON.stringify(req) + "\n");
      const r = await answer;
      if (r.error) throw new Error(String(r.error));
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  stop() {
    this.proc.stdin!.end();
    setTimeout(() => this.proc.kill(), 500).unref();
  }
}
