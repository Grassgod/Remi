export type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "./base.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";

import type { AgentAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

const adapters: Record<string, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
};

export function createAdapter(agentType: string): AgentAdapter {
  const factory = adapters[agentType];
  if (!factory) throw new Error(`Unknown agent type: ${agentType}. Available: ${Object.keys(adapters).join(", ")}`);
  return factory();
}
