// A typed client of P2PACT's public tools (core spec §8): chat (tool 1), fleet (tool 2) and
// plugins (tool 4) of a computer, for an application — `import … from "p2pact/client"`.
export { P2pactClient, Computer, DEFAULT_WANTS, Tools } from "./client.js";
export type { ClientConfig, ComputerEvent, ConnectionState, ToolEvent } from "./client.js";
export { ChatClient } from "./chat.js";
export { FleetClient } from "./fleet.js";
export { PluginsClient } from "./plugins.js";
export type { PluginGrants, PluginInfo, PluginStatus } from "./plugins.js";
export * from "./errors.js";
export * from "./chat-models.js";
export * from "./fleet-models.js";
export { Events, streamOf, type JsonMap } from "./support.js";
