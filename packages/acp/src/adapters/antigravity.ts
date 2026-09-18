import type { AgentAdapter } from "@shared/contracts/acp-protocol.js";
import { canonicalToolName } from "./tool-name.js";

/** Formats native agy tool events after normalization to Remi's event contract. */
export const antigravityAdapter: AgentAdapter = {
  agentType: "antigravity",
  promptUsageSettleScope: "turn",
  defaultExecutable: () => "agy",
  resolveToolName: update => canonicalToolName(update.title ?? "tool") ?? update.title ?? "tool",
  extractToolInput: update => typeof update.rawInput === "object" && update.rawInput !== null ? update.rawInput as Record<string, unknown> : undefined,
  extractResultPreview: update => update.content?.flatMap(item => item.type === "content" && item.content.type === "text" ? [item.content.text] : []).join("\n").slice(0, 800) || undefined,
  extractAskUserQuestion: () => null,
  isExitPlanMode: () => false,
  buildSessionMeta: () => undefined,
};
