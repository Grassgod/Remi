/**
 * Provider protocol — re-exports from @remi/acp-provider.
 * All provider types are defined in the acp-provider package.
 */
export type {
  Provider,
  AgentResponse,
  SendOptions,
  ProviderEvent,
  MediaAttachment,
} from "@remi/acp-provider";

export { createAgentResponse } from "@remi/acp-provider";

/** Custom tool that the agent can call, handled within Remi. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (...args: unknown[]) => string | Promise<string>;
}
