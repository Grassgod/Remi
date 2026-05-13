/**
 * Claude agent adapter — handles Claude-specific meta format and tool resolution.
 */

import type {
  ToolCallUpdate,
  ToolCallProgressUpdate,
  ToolCallMeta,
  NewSessionMeta,
} from "../protocol.js";
import type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "./base.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly agentType = "claude";

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    const claudeCode = this._claudeCodeMeta(update);
    if (claudeCode?.toolName && typeof claudeCode.toolName === "string") {
      return claudeCode.toolName;
    }
    if (update.kind === "switch_mode" || update.title === "Ready to code?") {
      return "ExitPlanMode";
    }
    return titleToToolName(update.title ?? "unknown");
  }

  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    let raw = update.rawInput;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch {}
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0) {
      return raw as Record<string, unknown>;
    }

    const toolName = this.resolveToolName(update);
    const input: Record<string, unknown> = {};

    // ACP encodes tool info in title/content/locations instead of rawInput.
    // Reconstruct input for Remi's tool formatters.

    // Bash: use title as command fallback (skip generic "Terminal" kind name)
    if (toolName === "Bash" && update.title && update.title !== "Terminal") {
      input.command = update.title;
    }

    // Read: title = "Read path (lines)", locations has file_path
    if (toolName === "Read" && update.locations?.length) {
      input.file_path = update.locations[0].path;
      if (update.locations[0].line != null) input.offset = update.locations[0].line;
    }

    // Agent: title = description
    if (toolName === "Agent" && update.title) {
      input.description = update.title;
    }

    // File path from locations (Edit, Write, Glob, etc.)
    if (update.locations?.length && !input.file_path) {
      input.file_path = update.locations[0].path;
    }

    // Diff content (Edit, Write)
    if (update.content?.length) {
      for (const c of update.content) {
        if (c.type === "diff") {
          input.file_path = c.path;
          if (c.oldText != null) input.old_string = c.oldText;
          if (c.newText != null) input.new_string = c.newText;
        } else if (c.type === "terminal") {
          input.terminal_id = c.terminalId;
        }
      }
    }

    // Grep/Glob: extract pattern from title ("Find `pattern`", "Search /regex/")
    if ((toolName === "Grep" || toolName === "Glob") && update.title) {
      const backtickMatch = update.title.match(/`([^`]+)`/);
      if (backtickMatch) {
        input.pattern = backtickMatch[1];
      }
    }

    // WebSearch: title = query
    if (toolName === "WebSearch" && update.title) {
      input.query = update.title.replace(/^Search\s*/i, "");
    }

    // WebFetch: extract URL from title
    if (toolName === "WebFetch" && update.title) {
      const urlMatch = update.title.match(/https?:\/\/\S+/);
      if (urlMatch) input.url = urlMatch[0];
    }

    return Object.keys(input).length > 0 ? input : undefined;
  }

  extractResultPreview(update: ToolCallProgressUpdate): string | undefined {
    if (!update.content?.length) return undefined;

    const parts: string[] = [];
    for (const c of update.content) {
      if (c.type === "content" && c.content.type === "text") {
        parts.push(c.content.text);
      } else if (c.type === "diff") {
        parts.push(`diff: ${c.path}`);
      } else if (c.type === "terminal") {
        const meta = update._meta as ToolCallMeta | undefined;
        if (meta?.terminal_output?.data) parts.push(meta.terminal_output.data);
      }
    }

    const preview = parts.join("\n").trim();
    if (!preview) return undefined;
    return preview.length > 800 ? preview.slice(0, 800) + "\n... (truncated)" : preview;
  }

  extractAskUserQuestion(toolCall: ToolCallProgressUpdate): AskUserQuestionData | null {
    if (this.resolveToolName(toolCall) !== "AskUserQuestion") return null;

    let rawInput = toolCall.rawInput;
    if (typeof rawInput === "string") {
      try { rawInput = JSON.parse(rawInput); } catch {}
    }
    if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
    const input = rawInput as Record<string, unknown>;
    if (!input.questions || !Array.isArray(input.questions)) return null;

    return { questions: input.questions as AskUserQuestionData["questions"] };
  }

  isExitPlanMode(toolCall: ToolCallProgressUpdate): boolean {
    return this.resolveToolName(toolCall) === "ExitPlanMode";
  }

  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    const claudeOpts: Record<string, unknown> = {};
    if (options.model) claudeOpts.model = options.model;
    if (options.allowedTools?.length) claudeOpts.allowedTools = options.allowedTools;
    if (options.permissionMode) claudeOpts.permissionMode = options.permissionMode;
    if (options.additionalDirectories?.length) claudeOpts.additionalDirectories = options.additionalDirectories;

    if (Object.keys(claudeOpts).length === 0) return undefined;
    return { claudeCode: { options: claudeOpts } };
  }

  defaultExecutable(): string {
    return "claude-agent-acp";
  }

  private _claudeCodeMeta(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    const meta = update._meta as ToolCallMeta | undefined;
    return meta?.claudeCode as Record<string, unknown> | undefined;
  }
}

function titleToToolName(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("bash") || lower.includes("terminal")) return "Bash";
  if (lower === "read" || lower.startsWith("read ")) return "Read";
  if (lower.includes("write") || lower.includes("create")) return "Write";
  if (lower.includes("edit")) return "Edit";
  if (lower.includes("glob")) return "Glob";
  if (lower.includes("grep") || lower.includes("search file")) return "Grep";
  if (lower.includes("web search")) return "WebSearch";
  if (lower.includes("web fetch") || lower.includes("fetch")) return "WebFetch";
  if (lower.includes("agent")) return "Agent";
  if (lower.includes("todo")) return "TodoWrite";
  return title;
}
