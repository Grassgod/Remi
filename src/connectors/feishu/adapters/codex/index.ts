/**
 * Codex agent adapter — stub for future Codex ACP integration.
 * Codex uses the same ACP protocol but may have different _meta fields.
 */

import type {
  ToolCallUpdate,
  ToolCallProgressUpdate,
  ToolCallMeta,
  NewSessionMeta,
} from "@shared/contracts/acp-protocol.js";
import type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "../base.js";

export class CodexAdapter implements AgentAdapter {
  readonly agentType = "codex";

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    const metaToolName = this._metaToolName(update);
    if (metaToolName) return normalizeToolName(metaToolName, update.kind ?? undefined);

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

  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    const codexOpts: Record<string, unknown> = {};
    if (options.model) codexOpts.model = options.model;
    if (options.permissionMode) codexOpts.approval_mode = options.permissionMode;
    if (options.additionalDirectories?.length) codexOpts.additionalDirectories = options.additionalDirectories;

    if (Object.keys(codexOpts).length === 0) return undefined;
    return { codex: { options: codexOpts } };
  }

  defaultExecutable(): string {
    return "codex-acp";
  }

  private _metaToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string | undefined {
    const meta = update._meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== "object") return undefined;

    for (const key of ["codex", "codexCli", "openaiCodex", "acpCodex"]) {
      const candidate = meta[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const name = firstString(candidate as Record<string, unknown>, ["toolName", "tool_name", "name", "type"]);
        if (name) return name;
      }
    }

    return firstString(meta, ["toolName", "tool_name", "name", "type"]);
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
  const lower = name.trim().toLowerCase().replace(/[-_\s]+/g, "");
  if (!lower) return kind ? kindToToolName(kind, undefined) : "unknown";
  if (["bash", "shell", "exec", "execute", "command", "commandexecution"].includes(lower)) return "Bash";
  if (["read", "readfile", "fileread"].includes(lower)) return "Read";
  if (["write", "writefile", "create", "createfile", "filewrite"].includes(lower)) return "Write";
  if (["edit", "applypatch", "patch", "filechange", "fileedit"].includes(lower)) return "Edit";
  if (["grep", "search", "filesearch", "rg"].includes(lower)) return "Grep";
  if (["webfetch", "fetch", "openurl"].includes(lower)) return "WebFetch";
  if (["websearch", "searchweb"].includes(lower)) return "WebSearch";
  if (["think", "reasoning"].includes(lower)) return "Think";
  if (["todo", "todowrite", "plan"].includes(lower)) return "TodoWrite";
  if (["askuserquestion", "ask", "askuser"].includes(lower)) return "AskUserQuestion";
  if (["exitplanmode", "planmode", "readytocode"].includes(lower)) return "ExitPlanMode";
  if (["enterplanmode"].includes(lower)) return "EnterPlanMode";
  if (["agent", "spawnagent"].includes(lower)) return "Agent";
  if (["glob"].includes(lower)) return "Glob";
  return name;
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

function titleToToolName(title: string): string {
  const exact = normalizeToolName(title, null);
  const lower = title.toLowerCase().replace(/[-_\s]+/g, "");
  if (exact !== title || KNOWN_TOOL_NAMES.has(exact)) return exact;

  if (lower.includes("bash") || lower.includes("terminal") || lower.includes("shell")) return "Bash";
  if (lower === "read" || title.toLowerCase().startsWith("read ")) return "Read";
  if (lower.includes("write") || lower.includes("create")) return "Write";
  if (lower.includes("edit") || lower.includes("patch") || lower.includes("diff")) return "Edit";
  if (lower.includes("grep") || lower.includes("searchfile") || title.toLowerCase().startsWith("search ")) return "Grep";
  if (lower.includes("websearch")) return "WebSearch";
  if (lower.includes("webfetch") || lower.includes("fetch")) return "WebFetch";
  if (lower.includes("think") || lower.includes("reason")) return "Think";
  if (lower.includes("todo") || lower.includes("plan")) return "TodoWrite";
  return title || "unknown";
}

const KNOWN_TOOL_NAMES = new Set([
  "Bash", "Read", "Write", "Edit", "Grep", "WebFetch", "WebSearch", "Think",
  "TodoWrite", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "Agent", "Glob",
]);

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
