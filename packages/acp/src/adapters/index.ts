export type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "@shared/contracts/acp-protocol.js";
export { ClaudeAdapter } from "./claude-code/index.js";
export { CodexAdapter } from "./codex/index.js";
export { AntigravityAdapter } from "./antigravity.js";

import type { AgentAdapter } from "@shared/contracts/acp-protocol.js";
import { ClaudeAdapter } from "./claude-code/index.js";
import { CodexAdapter } from "./codex/index.js";
import { AntigravityAdapter } from "./antigravity.js";

const registry: Record<string, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  antigravity: () => new AntigravityAdapter(),
};

export function createAdapter(agentType: string): AgentAdapter {
  const factory = registry[agentType];
  if (!factory) throw new Error(`Unknown agent type: ${agentType}. Available: ${Object.keys(registry).join(", ")}`);
  return factory();
}
