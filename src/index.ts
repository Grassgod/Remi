/**
 * Remi - Personal AI Assistant.
 *
 * Library entry point — re-exports public API.
 */

export const VERSION = "0.1.0";

// Config
export { loadConfig, type RemiConfig, type ProviderConfig } from "./config.js";

// Core
export { Remi, SYSTEM_PROMPT } from "./core.js";

// Providers
export {
  type Provider,
  type AgentResponse,
  type ToolDefinition,
  createAgentResponse,
} from "./providers/base.js";
export { ClaudeCLIProvider } from "./providers/claude-cli/index.js";

// Connectors
export { type Connector, type IncomingMessage, type MessageHandler } from "./connectors/base.js";
export { CLIConnector } from "./connectors/cli.js";

// Memory
export { MemoryStore } from "./memory/store.js";

// Daemon
export { RemiDaemon } from "./daemon.js";

// Scheduler
export { Scheduler } from "./scheduler/jobs.js";
