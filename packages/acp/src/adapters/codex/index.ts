/**
 * Codex agent adapter — stub for future Codex ACP integration.
 * Codex uses the same ACP protocol but may have different _meta fields.
 */

import type {
  ToolCallUpdate,
  ToolCallProgressUpdate,
  ToolCallMeta,
  NewSessionMeta,
  AgentAdapter,
  AskUserQuestionData,
  AgentSessionOptions,
} from "@shared/contracts/acp-protocol.js";
import { canonicalToolName, titleToToolName } from "../tool-name.js";

/** Claude-flavored mode ids → their closest codex-acp equivalents. */
const PERMISSION_MODE_ALIASES: Record<string, string[]> = {
  bypassPermissions: ["agent-full-access"],
  dontAsk: ["agent-full-access"],
  acceptEdits: ["agent"],
  default: ["agent"],
  plan: ["read-only"],
};

export class CodexAdapter implements AgentAdapter {
  readonly agentType = "codex";

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    // No `_meta` probe here: the only tool-call `_meta` keys codex-acp emits are
    // terminal_output/terminal_output_delta/terminal_exit (dist/index.js:
    // 22761-22777, 22840-22855) and is_mcp_tool_call (:22860-22866) — none
    // carries a tool name, so rawInput/kind/title are the whole contract.
    const raw = parseRawInput(update.rawInput);
    const rawName = firstString(raw, ["toolName", "tool_name", "name", "type"]);
    if (rawName) return normalizeToolName(rawName, update.kind ?? undefined);

    if (update.kind) return kindToToolName(update.kind, update.title ?? undefined);
    return titleToToolName(update.title ?? "unknown");
  }

  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    const raw = parseRawInput(update.rawInput);
    const input: Record<string, unknown> = raw ? { ...raw } : {};
    const toolName = this.resolveToolName(update);

    if (update.locations?.length) {
      const loc = update.locations[0];
      if (!input.file_path && !input.path) input.file_path = loc.path;
      if (loc.line != null && input.offset == null) input.offset = loc.line;
    }

    for (const c of update.content ?? []) {
      if (c.type === "diff") {
        input.file_path = c.path;
        if (c.oldText != null && input.old_string == null) input.old_string = c.oldText;
        if (input.new_string == null) input.new_string = c.newText;
      } else if (c.type === "terminal" && input.terminal_id == null) {
        input.terminal_id = c.terminalId;
      }
    }

    if (toolName === "Bash" && !input.command) {
      const command = firstString(input, ["cmd", "command", "shell_command"]) ?? meaningfulTitle(update.title);
      if (command) input.command = command;
    }

    if ((toolName === "Read" || toolName === "Edit" || toolName === "Write") && !input.file_path) {
      const path = firstString(input, ["path", "file", "filePath"]);
      if (path) input.file_path = path;
    }

    if ((toolName === "Grep" || toolName === "Search") && !input.pattern) {
      const pattern = firstString(input, ["query", "regex", "pattern"]) ?? backtickText(update.title);
      if (pattern) input.pattern = pattern;
    }

    return Object.keys(input).length > 0 ? input : undefined;
  }

  extractResultPreview(update: ToolCallProgressUpdate): string | undefined {
    const parts: string[] = [];

    if (update.rawOutput != null) {
      parts.push(stringPreview(update.rawOutput));
    }

    for (const c of update.content ?? []) {
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

  /**
   * codex-acp advertises read-only / agent / agent-full-access and rejects any
   * other id on session/set_mode with -32602. Our mode names are claude-flavored,
   * so they only reach codex through this table.
   */
  mapPermissionMode(mode: string): string[] {
    return PERMISSION_MODE_ALIASES[mode] ?? [];
  }

  /**
   * codex-acp has no session-meta channel at all: the only client `_meta` keys
   * it ever dereferences are `terminal_output` (dist/index.js:22755),
   * `additionalRoots` (:27064), and the auth/clientInfo keys (:25394, 26328,
   * 28708). `_meta.codex` is never read, so model goes through
   * session/set_config_option, permission mode through session/set_mode, and
   * extra roots through the top-level `additionalDirectories` param.
   * `allowedTools` has no codex equivalent — warn rather than drop it silently.
   */
  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    if (options.allowedTools?.length) {
      console.warn(
        `[acp:codex] ignoring allowedTools (${options.allowedTools.join(", ")}): codex-acp has no allowed-tools mechanism`,
      );
    }
    if (options.systemPrompt?.trim()) {
      console.warn("[acp:codex] ignoring systemPrompt: codex-acp exposes no system-prompt channel");
    }
    return undefined;
  }

  defaultExecutable(): string {
    return "codex-acp";
  }
}

function parseRawInput(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parseRawInput(parsed);
    } catch {
      return undefined;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function firstString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function normalizeToolName(name: string, kind?: string | null): string {
  const exact = canonicalToolName(name);
  if (exact === null) return kind ? kindToToolName(kind, undefined) : "unknown";
  return exact;
}

function kindToToolName(kind: string, title?: string | null): string {
  switch (kind) {
    case "execute": return "Bash";
    case "read": return "Read";
    case "edit": return "Edit";
    case "delete": return "Delete";
    case "move": return "Move";
    case "search": return "Grep";
    case "fetch": return "WebFetch";
    case "think": return "Think";
    case "switch_mode": {
      const t = title?.toLowerCase() ?? "";
      if (t.includes("ready to code") || t.includes("exit plan") || t.includes("exitplan")) return "ExitPlanMode";
      return "SwitchMode";
    }
    default: return titleToToolName(title ?? "unknown");
  }
}

function meaningfulTitle(title: string | null | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (["terminal", "command", "execute", "bash", "shell"].includes(lower)) return undefined;
  return trimmed;
}

function backtickText(title: string | null | undefined): string | undefined {
  const match = title?.match(/`([^`]+)`/);
  return match?.[1];
}

function stringPreview(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
