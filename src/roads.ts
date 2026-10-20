// Roads (spec §3): anything that sends and receives packets. They may lose, duplicate and
// reorder packets; sessions and delivery cope. UDP is the main road, TCP the fallback.
import * as dgram from "node:dgram";
import * as net from "node:net";
import * as os from "node:os";
import { MaxPacket } from "./delivery.js";

export interface Road {
  readonly name: string;
  send(addr: string, pkt: Uint8Array): void;
  close(): void;
}

export interface Endpoint {
  road: Road;
  addr: string;
}

export const endpointKey = (e: Endpoint) => e.road.name + "|" + e.addr;

export interface RoadStats {
  sentBytes: number;
  sentPackets: number;
  recvBytes: number;
  recvPackets: number;
}

function splitHostPort(addr: string): [string, number] {
  const i = addr.lastIndexOf(":");
  return [addr.slice(0, i).replace(/^\[|\]$/g, ""), Number(addr.slice(i + 1))];
}

function joinHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** localAddrs lists our addresses for hints: the listen address, or every IPv4 address. */
function localAddrs(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [joinHostPort(host, port)];
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(joinHostPort(a.address, port));
    }
  }
  return out;
}

export class UDPRoad implements Road {
  readonly name = "udp";
  stats: RoadStats = { sentBytes: 0, sentPackets: 0, recvBytes: 0, recvPackets: 0 };
  /** drop is for tests: the packet is lost. */
  drop?: () => boolean;

  private constructor(private sock: dgram.Socket) {}

  static listen(addr: string, recv: (pkt: Uint8Array, from: Endpoint) => void): Promise<UDPRoad> {
    const [host, port] = splitHostPort(addr);
    const sock = dgram.createSocket({ type: host.includes(":") ? "udp6" : "udp4", recvBufferSize: 1 << 20, sendBufferSize: 1 << 20 });
    const road = new UDPRoad(sock);
    sock.on("message", (msg, rinfo) => {
      road.stats.recvBytes += msg.length;
      road.stats.recvPackets++;
      if (road.drop?.()) return;
      recv(new Uint8Array(msg), { road, addr: joinHostPort(rinfo.address, rinfo.port) });
    });
    return new Promise((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(port, host || undefined, () => {
        sock.off("error", reject);
        sock.on("error", () => {});
        resolve(road);
      });
    });
  }

  send(addr: string, pkt: Uint8Array) {
    this.stats.sentBytes += pkt.length;
    this.stats.sentPackets++;
    if (this.drop?.()) return;
    const [host, port] = splitHostPort(addr);
    this.sock.send(pkt, port, host);
  }

  localAddr(): string {
    const a = this.sock.address();
    return joinHostPort(a.address, a.port);
  }

  localAddrs(): string[] {
    const a = this.sock.address();
    return localAddrs(a.address, a.port);
  }

  close() {
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }
}

/** TCPRoad: a 2-byte length, then the packet. Connections on demand, used both ways. */
export class TCPRoad implements Road {
  readonly name = "tcp";
  stats: RoadStats = { sentBytes: 0, sentPackets: 0, recvBytes: 0, recvPackets: 0 };
  private conns = new Map<string, net.Socket>();
  private server?: net.Server;

  private constructor(private recv: (pkt: Uint8Array, from: Endpoint) => void) {}

  /** listen opens the road; addr "" — dial only. */
  static async listen(addr: string, recv: (pkt: Uint8Array, from: Endpoint) => void): Promise<TCPRoad> {
    const road = new TCPRoad(recv);
    if (!addr) return road;
    const [host, port] = splitHostPort(addr);
    road.server = net.createServer((c) => road.serve(c, joinHostPort(c.remoteAddress!, c.remotePort!)));
    await new Promise<void>((resolve, reject) => {
      road.server!.once("error", reject);
      road.server!.listen(port, host || undefined, () => resolve());
    });
    return road;
  }

  private serve(c: net.Socket, addr: string) {
    this.conns.get(addr)?.destroy();
    this.conns.set(addr, c);
    c.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const ep: Endpoint = { road: this, addr };
    c.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 2) {
        const n = buf.readUInt16BE(0);
        if (n > MaxPacket + 64) {
          c.destroy();
          return;
        }
        if (buf.length < 2 + n) break;
        const pkt = new Uint8Array(buf.subarray(2, 2 + n));
        buf = buf.subarray(2 + n);
        this.stats.recvBytes += 2 + n;
        this.stats.recvPackets++;
        this.recv(pkt, ep);
      }
    });
    const drop = () => {
      if (this.conns.get(addr) === c) this.conns.delete(addr);
    };
    c.on("close", drop);
    c.on("error", drop);
  }

  send(addr: string, pkt: Uint8Array) {
    let c = this.conns.get(addr);
    if (!c) {
      const [host, port] = splitHostPort(addr);
      c = net.connect({ host, port });
      this.serve(c, addr);
    }
    const frame = Buffer.alloc(2 + pkt.length);
    frame.writeUInt16BE(pkt.length, 0);
    frame.set(pkt, 2);
    this.stats.sentBytes += frame.length;
    this.stats.sentPackets++;
    c.write(frame);
  }

  localAddr(): string {
    const a = this.server?.address();
    return a && typeof a === "object" ? joinHostPort(a.address, a.port) : "";
  }

  localAddrs(): string[] {
    const a = this.server?.address();
    return a && typeof a === "object" ? localAddrs(a.address, a.port) : [];
  }

  close() {
    this.server?.close();
    for (const c of this.conns.values()) c.destroy();
    this.conns.clear();
  }
}
