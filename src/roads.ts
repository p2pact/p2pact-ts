// Roads (spec §3): anything that sends and receives packets. They may lose, duplicate and
// reorder packets; sessions and delivery cope. The node takes roads from outside: UDP and TCP
// (roads-node.ts) for Node.js, the relay over WebSocket (relay-ws.ts), application roads
// (approad.ts) anywhere.
export interface Road {
  readonly name: string;
  /** rank orders kinds of roads (spec §7), lower is better: UDP 0, TCP and the local socket 1,
   * a relay 2, an application road 3 (1 if declared direct). Default 2. */
  readonly rank?: number;
  /** reliable: the road keeps order and loses nothing while it is up, so delivery plans no
   * window of its own on it. Default: every road but UDP. */
  readonly reliable?: boolean;
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

/** AddrRoad is a road that listens on an address of ours, which goes into the hints. */
export interface AddrRoad extends Road {
  localAddrs(): string[];
}
