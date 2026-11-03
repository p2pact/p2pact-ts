// P2PACT in a browser: `import { createBrowserNode } from "p2pact/browser"`. The same node as in
// Node.js, with its roads, storage and zstd coming from outside: state in IndexedDB, the relay
// over WebSocket (a wss:// URL of p2pact-relay -ws-host), application roads (a WebRTC data
// channel, attachRoad), and a zstd decoder in wasm (a browser never compresses, spec §5). The
// common dictionary is embedded.
import commonDictBytes from "../dict/common-1.zdict";
import zstdWasm from "../node_modules/zstd-wasm-decoder/_esm/zstd-decoder.wasm";
import { WasmCodec } from "./codec-wasm.js";
import { dictId, has } from "./compress.js";
import { Node, type NodeOptions } from "./node.js";
import type { WebSocketCtor } from "./relay-ws.js";
import { IdbStorage } from "./storage-idb.js";
import type { Storage } from "./storage.js";

export { Node, KindUnknown, KindComputer, KindClient, KindPlugin, later, Later, P2PACTError, ErrNoMethod, ErrBadArgs, ErrNotFound, ErrForbidden, ErrFailed, ErrNotDelivered } from "./node.js";
export type { Handler, LevelHandler, ToolHandler, NodeOptions } from "./node.js";
export { Invite, Trust, Prologue, allowed, offered, type Peer, type Hints, type RelayHint } from "./store.js";
export { encode, decode, Raw, type CborValue } from "./cbor.js";
export { address } from "./crypto.js";
export { Dict, dictId, type Codec } from "./compress.js";
export { WasmCodec } from "./codec-wasm.js";
export { LevelRead, LevelWrite, AllTools, defaultGrants, grantLevel, type Grant } from "./grants.js";
export type { StreamId } from "./delivery.js";
export type { Road, Endpoint } from "./roads.js";
export { WsRelayRoad, type WebSocketCtor, type WebSocketLike } from "./relay-ws.js";
export { AttachedRoad, MaxRoadPacket, DefaultAppRate, type AppRoad, type AppRoadConfig } from "./approad.js";
export { MemoryStorage, type Storage } from "./storage.js";
export { IdbStorage } from "./storage-idb.js";
export { P2pactClient, Computer, DEFAULT_WANTS, Tools } from "./client/client.js";
export type { ClientConfig, ComputerEvent, ConnectionState, ToolEvent } from "./client/client.js";
export { ChatClient } from "./client/chat.js";
export { FleetClient } from "./client/fleet.js";
export { PluginsClient } from "./client/plugins.js";
export * from "./client/errors.js";
export * from "./client/chat-models.js";
export * from "./client/fleet-models.js";
export { Events, streamOf, type JsonMap } from "./client/support.js";

/** The common dictionary (spec §5, dict/common-1.zdict), embedded. */
export const commonDict: Uint8Array = commonDictBytes;

export interface BrowserNodeOptions {
  /** name of this device, shown to the others */
  name: string;
  /** IndexedDB database holding the keys and known devices; one per identity (default "p2pact") */
  db?: string;
  /** or any Storage (MemoryStorage: a node that forgets everything on reload) */
  storage?: Storage;
  /** the relay's WebSocket URL (wss://…): the node listens on it, and invites and pairs meet through it */
  relay?: string | string[];
  /** a WebSocket constructor, if the global one is not wanted */
  WebSocket?: WebSocketCtor;
  /** what the device is for: KindClient for an application */
  kind?: number;
}

/** createBrowserNode opens the storage, loads the zstd decoder and makes a started node. */
export async function createBrowserNode(o: BrowserNodeOptions): Promise<Node> {
  const storage = o.storage ?? (await IdbStorage.open(o.db ?? "p2pact"));
  const opts: NodeOptions = { codec: await WasmCodec.load(zstdWasm), WebSocket: o.WebSocket };
  const node = new Node(storage, o.name, opts);
  if (o.kind !== undefined) node.kind = o.kind;
  if (!has(node.dictIds(""), dictId(commonDict))) node.addDict(commonDict);
  if (o.relay) node.setRelay(o.relay);
  node.start();
  return node;
}
