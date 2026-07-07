/**
 * Remi - Personal AI Assistant.
 *
 * Library entry point — re-exports public API.
 */

export const VERSION = "0.1.0";

// Config
export { loadConfig, type RemiConfig, type ProviderConfig } from "@shared/config.js";

// Core
export { Remi } from "./remi/core.js";

// Providers
export {
  type Provider,
  type AgentResponse,
  type ToolDefinition,
  createAgentResponse,
} from "@shared/contracts/provider-types.js";
export { AcpProvider } from "@acp/index.js";

// Connectors
export { type Connector, type IncomingMessage, type MessageHandler } from "@connectors/base.js";

// Memory
export { MemoryStore } from "@memory/store.js";

// Queue (replaced CronTimer)
export { RemiQueueManager } from "./queue/index.js";
