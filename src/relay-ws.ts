// The relay over WebSocket (spec §3): the relay line protocol with one WebSocket message per
// line, for browsers (which have no sockets). The server is the Go relay with -ws-addr or -ws-host
// (p2pact-go/cmd/p2pact-relay); it shares its channels with the TLS listener.
//
//   → {"relay":1,"channel":"<32 hex>","role":"a"}   first message
//   ← {"ok":true}                                    or {"error":"…"} and close
//   → "p"                                            keepalive, answered with "P"
//   → base64 of a packet                             forwarded to the other side of the channel
//
// The browser's WebSocket and Node's (the global one, or the `ws` package) both fit: pass the
// constructor if the global one is not wanted.
import { fromBase64, toBase64 } from "./bytes.js";
import { MaxPacket } from "./delivery.js";
import type { Endpoint, Road, RoadStats } from "./roads.js";

/** WebSocketLike is the part of the WebSocket API the road uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

const OPEN = 1;
const queueMax = 256;
const keepaliveEvery = 25_000;
const silentFor = 90_000;

interface Chan {
  role: string;
  queue: string[]; // lines waiting for the connection
  stop: boolean;
  ws?: WebSocketLike;
  ready: boolean;
  backoff: number;
  timer?: ReturnType<typeof setTimeout>;
  ka?: ReturnType<typeof setInterval>;
  lastRecv: number;
}

export class WsRelayRoad implements Road {
  readonly rank = 2;
  readonly reliable = true;
  stats: RoadStats = { sentBytes: 0, sentPackets: 0, recvBytes: 0, recvPackets: 0 };
  private chans = new Map<string, Chan>();
  private closed = false;

  /** url is the relay's WebSocket address (wss://…). recv gets the packets of every channel,
   * from the endpoint {road, addr: channel}. */
  constructor(readonly url: string, private recv: (pkt: Uint8Array, from: Endpoint) => void, private ctor?: WebSocketCtor) {}

  get name(): string {
    return "relay:" + this.url;
  }

  /** join keeps channel (32 hex) open as role "a" or "b", reconnecting until leave. */
  join(channel: string, role: "a" | "b") {
    if (this.closed || this.chans.has(channel)) return;
    const c: Chan = { role, queue: [], stop: false, ready: false, backoff: 500, lastRecv: 0 };
    this.chans.set(channel, c);
    this.connect(channel, c);
  }

  leave(channel: string) {
    const c = this.chans.get(channel);
    if (!c) return;
    this.chans.delete(channel);
    this.stopChan(c);
  }

  /** send puts a packet into a channel; one not joined drops it, one not connected yet queues it. */
  send(channel: string, pkt: Uint8Array) {
    const c = this.chans.get(channel);
    if (!c) return;
    this.stats.sentBytes += pkt.length;
    this.stats.sentPackets++;
    const line = toBase64(pkt);
    if (c.ready && c.ws?.readyState === OPEN) {
      try {
        c.ws.send(line);
        return;
      } catch {
        /* the connection broke: queue it, the close handler reconnects */
      }
    }
    c.queue.push(line);
    if (c.queue.length > queueMax) c.queue.shift();
  }

  /** connected says whether channel has a live connection to the relay. */
  connected(channel: string): boolean {
    return !!this.chans.get(channel)?.ready;
  }

  close() {
    this.closed = true;
    for (const c of this.chans.values()) this.stopChan(c);
    this.chans.clear();
  }

  private stopChan(c: Chan) {
    c.stop = true;
    clearTimeout(c.timer);
    clearInterval(c.ka);
    const ws = c.ws;
    c.ws = undefined;
    c.ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private connect(channel: string, c: Chan) {
    if (c.stop || this.closed) return;
    const Ctor = this.ctor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error("no WebSocket: pass a constructor (the ws package, say)");
    let ws: WebSocketLike;
    try {
      ws = new Ctor(this.url);
    } catch {
      this.retry(channel, c);
      return;
    }
    c.ws = ws;
    c.ready = false;
    const ep: Endpoint = { road: this, addr: channel };
    ws.onopen = () => {
      ws.send(JSON.stringify({ relay: 1, channel, role: c.role }));
    };
    ws.onmessage = (ev) => {
      const line = text(ev.data).trim();
      c.lastRecv = Date.now();
      if (!c.ready) {
        if (!line.includes('"ok":true')) {
          ws.close(); // refused: reconnect later
          return;
        }
        c.ready = true;
        c.backoff = 500;
        clearInterval(c.ka);
        c.ka = setInterval(() => {
          if (Date.now() - c.lastRecv > silentFor) return ws.close();
          try {
            ws.send("p");
          } catch {
            /* closing */
          }
        }, keepaliveEvery);
        const q = c.queue;
        c.queue = [];
        for (const l of q) ws.send(l);
        return;
      }
      if (line === "P" || line === "") return;
      const pkt = fromBase64(line);
      if (pkt.length === 0 || pkt.length > MaxPacket + 64) return;
      this.stats.recvBytes += pkt.length;
      this.stats.recvPackets++;
      this.recv(pkt, ep);
    };
    ws.onclose = () => {
      if (c.ws !== ws) return;
      c.ws = undefined;
      c.ready = false;
      clearInterval(c.ka);
      this.retry(channel, c);
    };
    ws.onerror = () => {
      /* followed by close */
    };
  }

  private retry(channel: string, c: Chan) {
    if (c.stop || this.closed) return;
    const wait = c.backoff;
    c.backoff = Math.min(c.backoff * 2, 30_000);
    c.timer = setTimeout(() => this.connect(channel, c), wait);
  }
}

function text(d: unknown): string {
  if (typeof d === "string") return d;
  if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
  if (ArrayBuffer.isView(d)) return new TextDecoder().decode(d);
  return String(d);
}
