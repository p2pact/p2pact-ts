// The local socket road (spec §3): programs on the same computer (a plugin, a CLI, an MCP
// server) talk to the node with the same packets over a stream socket, framed as on TCP. The
// node listens (Node.listenLocal); a program dials (Node.useLocal, then join or a session as
// usual). Only the device's own OS user may open the socket: that is who may even try to pair;
// trust still comes from pairing.
//
// A Unix domain socket (mode 0600) on Unix; on Windows a named pipe (\\.\pipe\name), which Node's
// `net` opens the same way. Node only: the browser has no such road.
import * as fs from "node:fs";
import * as net from "node:net";
import { TCPRoad, type Endpoint } from "./roads.js";

/** isPipePath reports a Windows named pipe path (\\.\pipe\name). */
const isPipePath = (path: string) => process.platform === "win32" && /^\\\\[.?]\\pipe\\/i.test(path);

/** probe reports whether somebody listens on path. */
function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect({ path });
    const timer = setTimeout(() => done(false), 1000);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      c.destroy();
      resolve(ok);
    };
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
}

export class LocalRoad extends TCPRoad {
  private seq = 0;

  private constructor(recv: (pkt: Uint8Array, from: Endpoint) => void, private path: string) {
    super(recv, "local");
  }

  /** open makes the road. path "" — dial only. Otherwise it listens there: on a socket readable and
   * writable by our OS user only (mode 0600); an old socket file nobody listens on is replaced. */
  static async open(path: string, recv: (pkt: Uint8Array, from: Endpoint) => void): Promise<LocalRoad> {
    const road = new LocalRoad(recv, path);
    if (!path) return road;
    if (!isPipePath(path)) {
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(path);
      } catch {
        /* nothing there */
      }
      if (st) {
        if (!st.isSocket()) throw new Error(path + " is not a socket");
        if (await probe(path)) throw new Error(path + " is in use");
        fs.rmSync(path, { force: true });
      }
    } else if (await probe(path)) throw new Error(path + " is in use");
    road.server = net.createServer((c) => road.serve(c, road.acceptAddr(c)));
    await new Promise<void>((resolve, reject) => {
      road.server!.once("error", reject);
      road.server!.listen(path, () => resolve());
    });
    if (!isPipePath(path)) {
      try {
        fs.chmodSync(path, 0o600);
      } catch (e) {
        road.close();
        throw e;
      }
    }
    return road;
  }

  protected override dial(addr: string): net.Socket {
    return net.connect({ path: addr });
  }

  // peers of a unix socket have no address: number them
  protected override acceptAddr(_c: net.Socket): string {
    return "local-" + ++this.seq;
  }

  localAddr(): string {
    return this.path;
  }

  /** localAddrs: the socket is not an address for hints. */
  localAddrs(): string[] {
    return [];
  }
}
