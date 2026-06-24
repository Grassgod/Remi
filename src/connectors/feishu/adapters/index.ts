export type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "./base.js";
export { ClaudeAdapter } from "./claude-code/index.js";
export { CodexAdapter } from "./codex/index.js";
export { handleAgentStream, allowCurrentToolOption, approvePlanOption, rejectPermissionOption, isPlanApproval } from "./stream-handler.js";
export type { StreamMeta, StreamHandlerLog } from "./stream-handler.js";

import type { AgentAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude-code/index.js";
import { CodexAdapter } from "./codex/index.js";

const registry: Record<string, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
};

export function createAdapter(agentType: string): AgentAdapter {
  const factory = registry[agentType];
  if (!factory) throw new Error(`Unknown agent type: ${agentType}. Available: ${Object.keys(registry).join(", ")}`);
  return factory();
}
