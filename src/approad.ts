// Application roads (spec §3): a link the application opens and the node cannot — a WebRTC data
// channel, Bluetooth LE, a serial line, a pipe to another program. The application hands the
// node a way to send (AppRoad) and gives it what arrives (AttachedRoad.receive); the node
// treats it like any other road.
import { concatBytes } from "./bytes.js";
import { MaxPacket } from "./delivery.js";
import type { Endpoint, Road } from "./roads.js";

/** MaxRoadPacket is the largest packet a road must carry: MaxPacket, and a handshake start with
 * data in it may be up to 64 bytes longer (the TCP road's frame takes the same). */
export const MaxRoadPacket = MaxPacket + 64;

/** DefaultAppRate is assumed for a road that does not declare its rate (bytes a second). */
export const DefaultAppRate = 16 << 10;

const appQueue = 256;

/** AppRoad is what the application provides: send carries one unit of at most mtu bytes — a
 * packet on a datagram road, a piece of the byte stream on a stream road. It may be async: the
 * node calls it one at a time and waits (a data channel's backpressure, a GATT write's ack). An
 * error on a stream road detaches it: the stream is broken mid-packet. */
export interface AppRoad {
  send(b: Uint8Array): void | Promise<void>;
}

export interface AppRoadConfig {
  /** the kind of road, shown by paths() as "app:<name>" ("webrtc", "ble"); default "app" */
  name?: string;
  /** The link keeps order and loses nothing while it is up (GATT, a serial line, a pipe, a
   * reliable data channel): packets are framed as on TCP — a 2-byte length, then the packet —
   * and the frames cut into pieces of at most mtu bytes. Otherwise it carries datagrams that may
   * be lost or reordered (a data channel with ordered:false, maxRetransmits:0), one packet each,
   * and must take any packet whole: mtu at least MaxRoadPacket. */
  stream?: boolean;
  /** the largest unit send takes */
  mtu: number;
  /** what the link carries, bytes a second, if known (default DefaultAppRate) */
  rate?: number;
  /** the link is direct between the two devices (a data channel, a LAN link): it ranks with TCP,
   * above a relay (spec §7) */
  direct?: boolean;
}

/** AttachedRoad is an application road attached to a node (Node.attachRoad). */
export class AttachedRoad implements Road {
  readonly name: string;
  readonly rank: number;
  readonly reliable: boolean;
  /** the endpoint address of this attachment */
  readonly id: string;
  private out: Uint8Array[] = [];
  private writing = false;
  private buf: Uint8Array = new Uint8Array(0);
  private dead = false;
  private static seq = 0;

  /** @internal made by Node.attachRoad */
  constructor(
    private recv: (pkt: Uint8Array, from: Endpoint) => void,
    private onDetach: (a: AttachedRoad) => void,
    private app: AppRoad,
    readonly cfg: Required<Pick<AppRoadConfig, "mtu">> & AppRoadConfig,
    /** the device it reaches, as the application told us ("" — learnt from what arrives) */
    readonly peer: string,
  ) {
    this.name = "app:" + (cfg.name || "app");
    this.rank = cfg.direct ? 1 : 3;
    this.reliable = !!cfg.stream;
    this.id = "#" + ++AttachedRoad.seq;
  }

  get detached(): boolean {
    return this.dead;
  }

  /** the rate the node plans with until it has measured the link */
  get rate(): number {
    return this.cfg.rate ?? DefaultAppRate;
  }

  /** send queues a packet for the application's send (the node's Road interface); a full queue
   * drops it, as a full network queue does: delivery resends. */
  send(_addr: string, pkt: Uint8Array) {
    if (this.dead || pkt.length > MaxRoadPacket || this.out.length >= appQueue) return;
    if (this.cfg.stream) {
      const framed = new Uint8Array(2 + pkt.length);
      framed[0] = pkt.length >> 8;
      framed[1] = pkt.length & 255;
      framed.set(pkt, 2);
      this.out.push(framed);
    } else {
      this.out.push(pkt.slice());
    }
    void this.pump();
  }

  private async pump() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.out.length > 0 && !this.dead) {
        const b = this.out.shift()!;
        // a stream packet goes in pieces of at most mtu, one write after another
        for (let i = 0; i < b.length && !this.dead; i += this.cfg.mtu) {
          try {
            await this.app.send(b.subarray(i, Math.min(b.length, i + this.cfg.mtu)));
          } catch {
            if (this.cfg.stream) return this.detach(); // broken mid-packet: attach the link again
            break;
          }
        }
      }
    } finally {
      this.writing = false;
    }
  }

  /** receive is what arrived on the link: a datagram, or any piece of the byte stream. */
  receive(b: Uint8Array) {
    if (this.dead) return;
    const ep: Endpoint = { road: this, addr: this.id };
    if (!this.cfg.stream) {
      if (b.length >= 5 && b.length <= MaxRoadPacket) this.recv(b.slice(), ep);
      return;
    }
    this.buf = this.buf.length ? concatBytes(this.buf, b) : b.slice();
    while (this.buf.length >= 2) {
      const n = (this.buf[0] << 8) | this.buf[1];
      if (n > MaxRoadPacket) return this.detach(); // the stream is damaged
      if (this.buf.length < 2 + n) break;
      const pkt = this.buf.slice(2, 2 + n);
      this.buf = this.buf.subarray(2 + n);
      this.recv(pkt, ep);
    }
  }

  /** detach takes the road off the node (the link is gone); attach a new one when it is back. */
  detach() {
    if (this.dead) return;
    this.dead = true;
    this.out = [];
    this.buf = new Uint8Array(0);
    this.onDetach(this);
  }

  close() {
    this.detach();
  }
}
