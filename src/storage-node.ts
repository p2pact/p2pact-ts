// FileStorage: a node's state in a directory (Node.js). The file names and formats are those
// of the Go implementation: dir/net-key.json, dir/net-peers.json, dir/net-dicts/…
import * as fs from "node:fs";
import * as path from "node:path";
import type { Storage } from "./storage.js";

export class FileStorage implements Storage {
  constructor(readonly dir: string) {}

  private file(name: string): string {
    if (name.split("/").includes("..")) throw new Error("bad name");
    return path.join(this.dir, name);
  }

  read(name: string): Uint8Array | undefined {
    try {
      return new Uint8Array(fs.readFileSync(this.file(name)));
    } catch {
      return undefined;
    }
  }

  /** write goes through a temporary file: a node starting meanwhile never reads half of it. */
  write(name: string, data: Uint8Array): void {
    const f = this.file(name);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f + ".tmp", data, { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
  }

  remove(name: string): void {
    fs.rmSync(this.file(name), { force: true });
  }
}
