/**
 * Codex agent adapter — stub for future Codex ACP integration.
 * Codex uses the same ACP protocol but may have different _meta fields.
 */

import type {
  ToolCallUpdate,
  ToolCallProgressUpdate,
  NewSessionMeta,
} from "../protocol.js";
import type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "./base.js";

export class CodexAdapter implements AgentAdapter {
  readonly agentType = "codex";

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    // Codex may use different meta fields — for now fall back to title
    return update.title ?? "unknown";
  }

  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    if (update.rawInput && typeof update.rawInput === "object") {
      return update.rawInput as Record<string, unknown>;
    }
    return undefined;
  }

  extractResultPreview(update: ToolCallProgressUpdate): string | undefined {
    if (!update.content?.length) return undefined;
    const parts: string[] = [];
    for (const c of update.content) {
      if (c.type === "content" && c.content.type === "text") {
        parts.push(c.content.text);
      }
    }
    const preview = parts.join("\n").trim();
    if (!preview) return undefined;
    return preview.length > 800 ? preview.slice(0, 800) + "\n... (truncated)" : preview;
  }

  extractAskUserQuestion(_toolCall: ToolCallProgressUpdate): AskUserQuestionData | null {
    // TODO: implement when Codex ACP is tested
    return null;
  }

  isExitPlanMode(_toolCall: ToolCallProgressUpdate): boolean {
    return false;
  }

  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    // TODO: Codex-specific session options
    return undefined;
  }

  defaultExecutable(): string {
    return "codex-acp";
  }
}
