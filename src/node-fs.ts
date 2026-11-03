// The Node.js flavour of the node: state in a directory (FileStorage), zstd from node:zlib,
// our own dictionaries trained in a worker thread, and the roads of Node.js — UDP, TCP and the
// local socket. `new Node(dir, name)` is what applications use; the browser's is browser.ts.
import { Node as CoreNode, type DictLearner, type NodeOptions } from "./node.js";
import { zlibCodec } from "./compress-node.js";
import { Learner, learnTiming } from "./learn.js";
import { LocalRoad } from "./local.js";
import { TCPRoad, UDPRoad } from "./roads-node.js";
import type { Storage } from "./storage.js";
import { FileStorage } from "./storage-node.js";

export class Node extends CoreNode {
  /** dir keeps the keys, known devices and dictionaries (a path, or a Storage). */
  constructor(dir: string | Storage, name: string, opts: NodeOptions = {}) {
    const st = typeof dir === "string" ? new FileStorage(dir) : dir;
    super(st, name, {
      codec: zlibCodec,
      learner: st instanceof FileStorage ? (dicts, onDict) => new Learner(st.dir, dicts, onDict) : undefined,
      ...opts,
    });
  }

  override start() {
    super.start(learnTiming.tick);
  }

  override get learning(): Learner {
    return super.learning as Learner;
  }

  async listenUDP(addr: string) {
    this.setUDP(await UDPRoad.listen(addr, (p, f) => this.receive(p, f)));
  }

  /** listenTCP opens the fallback road; "" — dial only. */
  async listenTCP(addr: string) {
    this.setTCP(await TCPRoad.listen(addr, (p, f) => this.receive(p, f)));
  }

  /** listenLocal opens the local socket at path (spec §3): a Unix domain socket readable and
   * writable by our OS user only (mode 0600), on Windows a named pipe. An old socket file nobody
   * listens on is replaced. */
  async listenLocal(path: string) {
    if (!path) throw new Error("no socket path");
    if (this.localPath) throw new Error("the local socket is already in use");
    this.setLocal(await LocalRoad.open(path, (p, f) => this.receive(p, f)), path);
  }

  /** useLocal makes the node reach a device on this computer over its local socket at path: join
   * and the session use it. The node does not listen. */
  async useLocal(path: string) {
    if (!path) throw new Error("no socket path");
    if (this.localPath) throw new Error("the local socket is already in use");
    this.setLocal(await LocalRoad.open("", (p, f) => this.receive(p, f)), path);
  }

  get udpRoad(): UDPRoad | undefined {
    return super.udpRoad as UDPRoad | undefined;
  }

  get tcpRoad(): TCPRoad | undefined {
    return super.tcpRoad as TCPRoad | undefined;
  }
}

export type { DictLearner };
