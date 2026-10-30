import type {
  AgentAdapter, AgentSessionOptions, AskUserQuestionData, NewSessionMeta,
  ToolCallProgressUpdate, ToolCallUpdate,
} from "@shared/contracts/acp-protocol.js";
import { CodexAdapter } from "./codex/index.js";

const CURSOR_TOOL_NAMES: Readonly<Record<string, string>> = {
  task: "Agent",
  updateTodos: "TodoWrite",
  askQuestion: "AskUserQuestion",
  createPlan: "TodoWrite",
};

/** Cursor's native ACP server uses standard tool cards and child-session updates. */
export class CursorAdapter implements AgentAdapter {
  readonly agentType = "cursor";
  readonly promptUsageSettleScope = "turn" as const;
  readonly nativeSubagents = { airCapability: false } as const;
  private readonly tools = new CodexAdapter();

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    let raw = update.rawInput;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch {} }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const name = (raw as Record<string, unknown>)._toolName;
      if (typeof name === "string" && Object.hasOwn(CURSOR_TOOL_NAMES, name)) return CURSOR_TOOL_NAMES[name]!;
    }
    return this.tools.resolveToolName(update);
  }
  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    return this.tools.extractToolInput(update);
  }
  extractResultPreview(update: ToolCallProgressUpdate): string | undefined { return this.tools.extractResultPreview(update); }
  extractAskUserQuestion(_update: ToolCallProgressUpdate): AskUserQuestionData | null { return null; }
  isExitPlanMode(_update: ToolCallProgressUpdate): boolean { return false; }

  mapPermissionMode(mode: string): string[] {
    if (mode === "plan" || mode === "ask" || mode === "agent") return [mode];
    return ["agent"];
  }

  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    if (Array.isArray(options.pluginPaths) && options.pluginPaths.length) throw new Error("Cursor ACP does not load Remi Agent Plugins; configure Agent Skills instead");
    if (options.systemPrompt?.trim()) {
      throw new Error("Cursor ACP session instructions must be written to the isolated provider home's AGENTS.md");
    }
    if (options.allowedTools?.length) {
      throw new Error("Cursor ACP does not expose an allowedTools session setting");
    }
    return undefined;
  }

  defaultExecutable(): string { return "cursor-agent"; }
}
