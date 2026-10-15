/**
 * Vendor `_meta` reading for the daemon trace translator (PR 2, ARCH §3.2).
 *
 * ACP leaves most of what a trace needs to agent-specific `_meta` keys, titles
 * and kinds. Every such read lives here so the translator
 * (`packages/server/src/worker/trace-translator.ts`) only maps facts to items.
 * The shapes are those of the pinned bridges (`runtime-versions.json`):
 *
 * - claude-agent-acp 0.90.0 (`CA` = its `dist/`). The `CA` line numbers below
 *   were taken from 0.89.0; 0.90.0 keeps the cited behaviour (its compaction,
 *   notice, elicitation and diff modules are unchanged; renderer and agent code
 *   moved by a few dozen lines).
 * - codex-acp 2.2.2 (`CX` = its `dist/index.js`)
 * - antigravity-acp 1.4.0, Google's official (proprietary) ACP server (PR 4 §5):
 *   behaviour notes from its observable protocol and the live probe, re-checked
 *   on every pin bump; nothing here cites or copies its source
 *
 * Title parsing is version-pinned on purpose (risk R6): Codex sends single-action
 * reads, lists and searches with only a title and locations.
 */

import { basename } from "node:path";
import type { CommandAction, FileChange, TraceCompactionItem, TraceNoticeItem } from "@multiremi/contracts/trace.js";
import { shlexJoin, shortDisplayPath } from "@shared/command-parse.js";
import { fileChangeFromTexts } from "@shared/trace-file-change.js";
import { capFileChanges } from "@shared/trace-sanitize.js";
import { airMetadata, record, type AcpSessionFailure } from "../session-failure.js";

export { readSessionFailure, type AcpSessionFailure } from "../session-failure.js";

/** One ACP `session/update` body, read loosely: bridges add fields freely. */
export type VendorFrame = Record<string, unknown>;

function meta(frame: VendorFrame): Record<string, unknown> | null {
  return record(frame._meta);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── Messages ────────────────────────────────────────────────────────────────

export type MessagePhase = "final" | "commentary" | "unknown";

/**
 * The phase of an `agent_message_chunk`. codex-acp 2.x sends it only to AIR
 * clients, as `_meta.jetbrains.air.phase` (CX:29575-29580, 31504-31508); 1.x
 * used `_meta.codex.phase`; a top-level `phase` is the oldest spelling. Values
 * are Codex's snake_case `MessagePhase`: `final_answer` is the answer,
 * `commentary` is a progress note, and `partial_answer` or no phase is left to
 * the final-reply rule (risk R4).
 */
export function messagePhase(frame: VendorFrame): MessagePhase {
  const raw = airMetadata(frame._meta)?.phase ?? record(meta(frame)?.codex)?.phase ?? frame.phase ?? meta(frame)?.phase;
  if (raw === "final_answer" || raw === "final") return "final";
  if (raw === "commentary") return "commentary";
  return "unknown";
}

/**
 * The message id that groups chunks into one item. Claude sends the Anthropic
 * API message id on message, thought and user chunks only (CA/acp-agent.js:
 * 8465-8489); Codex sends the item id (CX:29596-29630).
 */
export function messageId(frame: VendorFrame): string | null {
  return str(frame.messageId);
}

/** Plain text of a content block or a list of them; non-text blocks are skipped. */
export function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  let text = "";
  for (const block of blocks) {
    if (typeof block === "string") text += block;
    else if (block && typeof block === "object") {
      const row = block as Record<string, unknown>;
      if (row.type === "diff" || row.type === "terminal") continue;
      if (typeof row.text === "string") text += row.text;
      else if (row.content !== undefined) text += contentText(row.content);
    }
  }
  return text;
}

// ── Attribution ─────────────────────────────────────────────────────────────

/**
 * The subagent tool call a frame belongs to: claude-agent-acp stamps
 * `_meta.claudeCode.parentToolUseId` on a subagent's chunks and tool calls
 * (CA/acp-agent.js:502-510, 8599, 8985). Codex stays flat because Remi does not
 * advertise subagent sessions (CX:39918-39924).
 */
export function parentToolUseId(frame: VendorFrame): string | null {
  return str(record(meta(frame)?.claudeCode)?.parentToolUseId);
}

// ── Tools ───────────────────────────────────────────────────────────────────

/** The tool name a bridge reports: Claude's `_meta.claudeCode.toolName` or `name`, Codex's `name`. */
export function toolName(frame: VendorFrame): string | null {
  return str(record(meta(frame)?.claudeCode)?.toolName) ?? str(frame.name);
}

/** Tool names that spawn a Claude subagent; `Task` is the legacy name of `Agent`. */
export const CLAUDE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** Codex collaboration tools (CX:29815-29835, 30016-30061), all subagent steps. */
const CODEX_COLLAB_TOOLS: ReadonlySet<string> = new Set(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent", "followupTask"]);

/** The parsed `rawInput` of a frame: an object, a JSON object string, or nothing. */
export function rawInputOf(frame: VendorFrame): Record<string, unknown> | null {
  const raw = frame.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
    } catch {
      return { value: raw };
    }
  }
  return null;
}

/** Whether the tool is an MCP call: Claude `mcp__s__t`, Codex `is_mcp_tool_call` / `mcp.s.t` (CX:28236-28238, 29493-29510). */
export function isMcp(frame: VendorFrame, name: string | null): boolean {
  if (meta(frame)?.is_mcp_tool_call === true) return true;
  if (name?.startsWith("mcp__")) return true;
  const title = str(frame.title);
  return !!title && /^mcp\.[^.\s]+\.[^\s]+$/.test(title);
}

/** The MCP server of a call, from its name, its title or its input. */
export function mcpServer(frame: VendorFrame, name: string | null, input: Record<string, unknown> | null): string | null {
  const claude = name?.match(/^mcp__(.+?)__/);
  if (claude) return claude[1]!;
  const fromInput = str(input?.server);
  if (fromInput) return fromInput;
  const title = str(frame.title)?.match(/^mcp\.([^.\s]+)\./);
  return title ? title[1]! : null;
}

/** `_meta.terminal_output` / `terminal_output_delta` data: one chunk of a command's output. */
export function terminalChunk(frame: VendorFrame): string | null {
  const m = meta(frame);
  const data = record(m?.terminal_output)?.data ?? record(m?.terminal_output_delta)?.data;
  return typeof data === "string" ? data : null;
}

/**
 * `_meta.terminal_exit.exit_code`, or undefined when the frame has no exit.
 * Claude AIR reports 1 for any failure or interruption (CA/tool-calls/renderer.js:
 * 219-227, risk R5).
 */
export function terminalExit(frame: VendorFrame): number | null | undefined {
  const exit = record(meta(frame)?.terminal_exit);
  if (!exit) return undefined;
  return Number.isSafeInteger(exit.exit_code) ? exit.exit_code as number : null;
}

/** `_meta.terminal_info`: present on a command that shows a terminal; Codex adds its cwd. */
export function terminalInfo(frame: VendorFrame): { cwd: string | null } | null {
  const info = record(meta(frame)?.terminal_info);
  return info ? { cwd: str(info.cwd) } : null;
}

/** Whether the frame carries a `terminal` content block. */
export function hasTerminalContent(frame: VendorFrame): boolean {
  return Array.isArray(frame.content) && frame.content.some((block) => record(block)?.type === "terminal");
}

/** Codex AIR marks a spawned subagent with `_meta.jetbrains.air.subagent` (CX:29830). */
function isAirSubagent(frame: VendorFrame): boolean {
  return airMetadata(frame._meta)?.subagent === true;
}

/**
 * The model-written label of a Claude shell call, `_meta.jetbrains.air.commandTitle`
 * (the Bash `description`; CA/tool-calls/renderer.js `toolUseMeta`).
 */
export function commandTitle(frame: VendorFrame): string | null {
  return str(airMetadata(frame._meta)?.commandTitle);
}

/** `_meta.claudeCode.toolResponse`: the PostToolUse markers or a progress beat (CA/tool-calls/content.js:175-194). */
function toolResponse(frame: VendorFrame): Record<string, unknown> | null {
  return record(record(meta(frame)?.claudeCode)?.toolResponse);
}

/**
 * Whether the Agent call's PostToolUse hook update reports an async launch:
 * `toolResponse.isAsync === true` or `status: "async_launched"`. The bridge sends
 * it before the call's result, which is then only the launch acknowledgement
 * (recorded with claude-agent-acp 0.89; 0.90 keeps the markers).
 */
export function isAsyncLaunch(frame: VendorFrame): boolean {
  const response = toolResponse(frame);
  return response?.isAsync === true || response?.status === "async_launched";
}

/**
 * What the hook update says about the launch: true for an async launch, false
 * for any other hook marker (a foreground run reports `{status: "completed"}`),
 * null for a frame without markers (a progress beat carries only timing).
 */
export function launchMarker(frame: VendorFrame): boolean | null {
  if (isAsyncLaunch(frame)) return true;
  const response = toolResponse(frame);
  return response && (typeof response.status === "string" || typeof response.isAsync === "boolean") ? false : null;
}

/**
 * The line claude-agent-acp appends to a shell command's output when Claude Code
 * aborted it (CA/tool-calls/reporters/bash.js, `structuredBash.interrupted`).
 * The AIR exit code of such a command is a synthesized 1 (CA/tool-calls/renderer.js).
 */
export const CLAUDE_ABORT_MARKER = "[Command was aborted before completion]";

/** Whether a command's output ends with Claude's abort marker. */
export function endsWithAbortMarker(output: string | null): boolean {
  return !!output && output.trimEnd().endsWith(CLAUDE_ABORT_MARKER);
}

/** What one tool call becomes in the trace. */
export type ToolClass =
  | {
    type: "command";
    source: "shell" | "tool";
    command: string | null;
    cwd: string | null;
    actions: CommandAction[] | null;
    /** The model-written label (Claude `commandTitle`), or null. */
    title: string | null;
  }
  | { type: "file_change" }
  | { type: "web_search"; action: "search" | "fetch"; query: string | null; url: string | null }
  | { type: "tool"; server: string | null }
  | {
    type: "subagent";
    prompt: string | null;
    agentType: string | null;
    name: string | null;
    background: boolean | null;
    model: string | null;
    threadId: string | null;
  }
  /** Shown elsewhere (Claude AskUserQuestion is the `question` item). */
  | { type: "suppress" };

/** Accumulated facts of one tool call across its frames. */
export interface ToolFacts {
  /** The call's `toolCallId`. */
  id: string | null;
  name: string | null;
  kind: string | null;
  title: string | null;
  input: Record<string, unknown> | null;
  locations: string[];
  /** Any frame carried `_meta.terminal_info` or a terminal content block. */
  terminal: boolean;
  terminalCwd: string | null;
  mcp: boolean;
  /** Antigravity's `_meta.mcp.server`. */
  mcpServer: string | null;
  airSubagent: boolean;
  /** Claude AIR `commandTitle`, from any frame. */
  commandTitle: string | null;
  /**
   * The Agent call's hook update: true for an async (background) launch, false
   * for a foreground result, null before any hook marker.
   */
  asyncLaunch: boolean | null;
  /** Claude's subagent type from an Agent progress beat. */
  subagentType: string | null;
}

/**
 * Fold one frame into the facts of its tool call. Later frames win, input keys
 * merge. Antigravity names and input keys are normalized first (its frames of
 * one call spell the same argument differently).
 */
export function mergeToolFacts(previous: ToolFacts | null, frame: VendorFrame, agentType?: string): ToolFacts {
  const antigravity = agentType === "antigravity";
  const name = (antigravity ? antigravityToolName(frame) : toolName(frame)) ?? previous?.name ?? null;
  const input = antigravity ? normalizeToolInput(frame.rawInput) : rawInputOf(frame);
  const locations = Array.isArray(frame.locations)
    ? frame.locations.flatMap((location) => str(record(location)?.path) ?? [])
    : previous?.locations ?? [];
  const info = terminalInfo(frame);
  return {
    id: str(frame.toolCallId) ?? previous?.id ?? null,
    name,
    kind: str(frame.kind) ?? previous?.kind ?? null,
    title: str(frame.title) ?? previous?.title ?? null,
    input: input ? { ...(previous?.input ?? {}), ...input } : previous?.input ?? null,
    locations,
    terminal: (previous?.terminal ?? false) || info !== null || hasTerminalContent(frame),
    terminalCwd: info?.cwd ?? previous?.terminalCwd ?? null,
    mcp: (previous?.mcp ?? false) || isMcp(frame, name),
    mcpServer: str(record(meta(frame)?.mcp)?.server) ?? previous?.mcpServer ?? null,
    airSubagent: (previous?.airSubagent ?? false) || isAirSubagent(frame),
    commandTitle: commandTitle(frame) ?? previous?.commandTitle ?? null,
    asyncLaunch: previous?.asyncLaunch === true ? true : launchMarker(frame) ?? previous?.asyncLaunch ?? null,
    subagentType: str(toolResponse(frame)?.subagentType) ?? previous?.subagentType ?? null,
  };
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  // Both pinned bridges send a string (decision Q4); an argv still renders.
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) return shlexJoin(value);
  return null;
}

function readAction(path: string): CommandAction {
  return { type: "read", command: null, name: shortDisplayPath(path) || basename(path), path };
}

/**
 * The single action a Codex read/search/list title names (CX:28474-28488,
 * 28509-28514): `Read file '<p>'`, `List files[ in '<p>']`, `Search for '<q>'[ in
 * <p>]`, `Search in '<p>'`. Null for any other title.
 */
export function codexActionFromTitle(title: string | null, locations: readonly string[] = []): CommandAction | null {
  if (!title) return null;
  let match = /^Read file '(.*)'$/s.exec(title);
  if (match) return readAction(locations[0] ?? match[1]!);
  if (title === "List files") return { type: "list_files", command: null, path: null };
  match = /^List files in '(.*)'$/s.exec(title);
  if (match) return { type: "list_files", command: null, path: match[1]! };
  match = /^Search for '(.*)' in (.+)$/s.exec(title);
  if (match) return { type: "search", command: null, query: match[1]!, path: match[2]! };
  match = /^Search for '(.*)'$/s.exec(title);
  if (match) return { type: "search", command: null, query: match[1]!, path: null };
  match = /^Search in '(.*)'$/s.exec(title);
  if (match) return { type: "search", command: null, query: null, path: match[1]! };
  if (title === "Search") return { type: "search", command: null, query: null, path: null };
  return null;
}

function claudeClass(facts: ToolFacts): ToolClass {
  const name = facts.name ?? "";
  const input = facts.input;
  const path = str(input?.file_path) ?? str(input?.path) ?? facts.locations[0] ?? null;
  switch (name) {
    case "Bash":
    case "PowerShell": {
      // Both use the bridge's bash reporter (CA/tool-calls/reporters/index.js:13).
      // rawInput is withheld while AIR input streams (CA/tool-calls/renderer.js:
      // 91-95); the title is the command once known (bash.js:7).
      const title = facts.title && facts.title !== "Terminal" ? facts.title : null;
      // The model's label: AIR `commandTitle`, else the input's description
      // (0.90 also reads `command_description`, CA/tool-calls/reporters/bash.js).
      const label = facts.commandTitle ?? str(input?.description) ?? str(input?.command_description);
      return { type: "command", source: "shell", command: commandText(input?.command) ?? title, cwd: null, actions: null, title: label };
    }
    case "Read":
      return { type: "command", source: "tool", command: null, cwd: null, actions: path ? [readAction(path)] : [], title: null };
    case "Grep":
    case "Glob":
      return { type: "command", source: "tool", command: null, cwd: null, title: null,
        actions: [{ type: "search", command: null, query: str(input?.pattern), path: str(input?.path) ?? str(input?.file_path) }] };
    case "LS":
      return { type: "command", source: "tool", command: null, cwd: null, actions: [{ type: "list_files", command: null, path }], title: null };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return { type: "file_change" };
    case "WebSearch":
      return { type: "web_search", action: "search", query: str(input?.query), url: null };
    case "WebFetch":
      return { type: "web_search", action: "fetch", query: str(input?.prompt), url: str(input?.url) };
    case "Agent":
    case "Task": {
      // Background only from the hook's markers, never from the input's
      // `run_in_background`: the SDK backgrounds by default and may also run a
      // requested background call in the foreground.
      return {
        type: "subagent", prompt: str(input?.prompt) ?? str(input?.description),
        agentType: str(input?.subagent_type) ?? facts.subagentType, name: str(input?.description),
        background: facts.asyncLaunch, model: str(input?.model), threadId: null,
      };
    }
    case "AskUserQuestion":
      return { type: "suppress" };
    default:
      return { type: "tool", server: facts.mcp ? mcpServer({ title: facts.title }, facts.name, input) : null };
  }
}

function codexClass(facts: ToolFacts): ToolClass {
  const input = facts.input;
  const title = facts.title;
  if (facts.mcp) return { type: "tool", server: mcpServer({ title }, facts.name, input) };
  if (facts.airSubagent || (title !== null && CODEX_COLLAB_TOOLS.has(title))) {
    // Activity calls ("Start/Complete subagent X") carry `{agentThreadId,
    // agentPath}`; collab calls (`spawnAgent`, `wait`, …) carry `{receiverThreadIds,
    // model, prompt}` (CX:28180, 29803-29866).
    const receivers = Array.isArray(input?.receiverThreadIds) ? input.receiverThreadIds : [];
    const agentPath = str(input?.agentPath);
    return {
      type: "subagent", prompt: str(input?.prompt), agentType: null,
      name: agentPath ? agentPath.replace(/\/+$/, "").split("/").pop() || null : null,
      background: null, model: str(input?.model), threadId: str(input?.agentThreadId) ?? str(receivers[0]),
    };
  }
  switch (facts.kind) {
    case "execute": {
      const command = commandText(input?.command);
      if (command !== null || facts.terminal) {
        return { type: "command", source: "shell", command, cwd: str(input?.cwd) ?? facts.terminalCwd, actions: null, title: facts.commandTitle };
      }
      return { type: "tool", server: null };
    }
    case "read": {
      // Single-action reads and lists arrive with only a title and locations;
      // reads send no output (CX:28463-28518).
      const action = codexActionFromTitle(title, facts.locations);
      if (action && action.type !== "search") return { type: "command", source: "tool", command: null, cwd: null, actions: [action], title: null };
      return { type: "tool", server: null };
    }
    case "search": {
      // Web search: kind `search` with `rawInput {query, action}` (CX:29528-29560).
      const action = record(input?.action);
      if (action || title?.startsWith("Web search") || title?.startsWith("Open page") || title?.startsWith("Find in page")) {
        const fetch = action?.type === "openPage" || action?.type === "findInPage"
          || title?.startsWith("Open page") || title?.startsWith("Find in page");
        return { type: "web_search", action: fetch ? "fetch" : "search", query: str(input?.query) ?? str(action?.query) ?? str(action?.pattern), url: str(action?.url) };
      }
      const parsed = codexActionFromTitle(title, facts.locations);
      return { type: "command", source: "tool", command: null, cwd: null, title: null,
        actions: [parsed ?? { type: "search", command: null, query: str(input?.query), path: facts.locations[0] ?? null }] };
    }
    case "edit":
      return { type: "file_change" };
    default:
      return { type: "tool", server: null };
  }
}

// ── Antigravity ─────────────────────────────────────────────────────────────

/**
 * Canonical input keys and the spellings Antigravity uses for them. The Go
 * harness and the Python server name the same argument in PascalCase and
 * snake_case, and one call's frames mix them (`CommandLine` on the permission
 * frame, `command_line` on the live one; server 1.4.0 and the live probe).
 * The first spelling present wins.
 */
const ANTIGRAVITY_INPUT_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["command", ["CommandLine", "command_line", "command"]],
  ["cwd", ["Cwd", "working_dir", "cwd"]],
  ["path", ["AbsolutePath", "absolute_path", "TargetFile", "target_file", "FilePath", "file_path", "path", "DirectoryPath",
    "directory_path", "SearchDirectory", "search_directory", "SearchPath", "search_path"]],
  ["query", ["Query", "query", "Pattern", "pattern", "SearchPattern", "search_pattern"]],
  ["url", ["Url", "url"]],
];
const ANTIGRAVITY_INPUT_ALIASES = new Set(ANTIGRAVITY_INPUT_KEYS.flatMap(([, aliases]) => aliases));

/**
 * An Antigravity `rawInput` with canonical keys. Replay sends the arguments as
 * a JSON string (server 1.4.0); other keys are kept.
 */
export function normalizeToolInput(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try { value = JSON.parse(value); } catch { return { value: raw }; }
  }
  const input = record(value);
  if (!input) return null;
  const out: Record<string, unknown> = {};
  for (const [canonical, aliases] of ANTIGRAVITY_INPUT_KEYS) {
    const alias = aliases.find((key) => input[key] !== undefined && input[key] !== null);
    if (alias) out[canonical] = input[alias];
  }
  for (const [key, entry] of Object.entries(input)) if (!ANTIGRAVITY_INPUT_ALIASES.has(key)) out[key] = entry;
  return out;
}

/**
 * An Antigravity tool name: `_meta.mcp.tool` for MCP calls, `run_command` for
 * kind `execute` (whose title is the command in server 1.4.0), else the
 * name in a `Run <tool>?` permission or `Running <tool>` live / replay title.
 */
export function antigravityToolName(frame: VendorFrame): string | null {
  const mcpTool = str(record(meta(frame)?.mcp)?.tool);
  if (mcpTool) return mcpTool;
  if (frame.kind === "execute") return "run_command";
  const match = /^(?:Running |Run )(\S+?)\??$/.exec(str(frame.title) ?? "");
  return match ? match[1]! : null;
}

const ANTIGRAVITY_SHELL_TOOLS: ReadonlySet<string> = new Set(["run_command", "shell"]);
const ANTIGRAVITY_READ_TOOLS: ReadonlySet<string> = new Set(["client_view_file", "view_file", "read_file"]);
const ANTIGRAVITY_SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep_search", "find_by_name", "search_directory", "find_file"]);
const ANTIGRAVITY_LIST_TOOLS: ReadonlySet<string> = new Set(["list_dir", "list_directory"]);
/** The file-editing tools of server 1.4.0 (those its `auto_edit` mode approves). */
const ANTIGRAVITY_EDIT_TOOLS: ReadonlySet<string> = new Set(["client_create_file", "client_edit_file", "create_file", "edit_file",
  "write_file", "replace_file_content", "multi_replace_file_content", "write_to_file"]);

/** The server's `ask_user` stand-in call: `interaction_<hex>` with `rawInput: {}` (server 1.4.0). */
function isInteractionCall(id: string | null, input: unknown): boolean {
  const raw = record(input);
  return !!id?.startsWith("interaction_") && (input === undefined || input === null || (raw !== null && Object.keys(raw).length === 0));
}

function antigravityClass(facts: ToolFacts): ToolClass {
  const input = facts.input;
  // The question is the `question` item (provider elicitation), like Claude's AskUserQuestion.
  if (isInteractionCall(facts.id, input ?? {})) return { type: "suppress" };
  if (facts.mcp) return { type: "tool", server: facts.mcpServer ?? str(input?.ServerName) };
  const name = facts.name ?? "";
  const path = str(input?.path) ?? facts.locations[0] ?? null;
  if (ANTIGRAVITY_SHELL_TOOLS.has(name)) {
    // Server 1.4.0 titles a shell call with its command; replay adds the model's `toolSummary`.
    const title = facts.kind === "execute" ? facts.title : null;
    return { type: "command", source: "shell", command: commandText(input?.command) ?? title, cwd: str(input?.cwd),
      actions: null, title: str(input?.toolSummary) };
  }
  if (ANTIGRAVITY_READ_TOOLS.has(name)) {
    return { type: "command", source: "tool", command: null, cwd: null, actions: path ? [readAction(path)] : [], title: null };
  }
  if (ANTIGRAVITY_SEARCH_TOOLS.has(name)) {
    return { type: "command", source: "tool", command: null, cwd: null, title: null,
      actions: [{ type: "search", command: null, query: str(input?.query), path }] };
  }
  if (ANTIGRAVITY_LIST_TOOLS.has(name)) {
    return { type: "command", source: "tool", command: null, cwd: null, actions: [{ type: "list_files", command: null, path }], title: null };
  }
  if (ANTIGRAVITY_EDIT_TOOLS.has(name) || (!facts.name && facts.kind === "edit")) return { type: "file_change" };
  // Server 1.4.0: `search_web` has kind `search`; `read_url_content` has kind `fetch`.
  if (name === "search_web") return { type: "web_search", action: "search", query: str(input?.query), url: null };
  if (name === "read_url_content") return { type: "web_search", action: "fetch", query: null, url: str(input?.url) };
  // browser_subagent and everything else: a plain tool.
  return { type: "tool", server: null };
}

/** A single-choice question the server sent as `session/request_permission`. */
export interface PermissionQuestion {
  question: string;
  options: Array<{ optionId: string; label: string }>;
}

/** Option ids of the server's real tool approvals (server 1.4.0). */
const ANTIGRAVITY_APPROVAL_OPTION_IDS: ReadonlySet<string> = new Set(["allow", "allow_always", "deny"]);

function permissionOptions(params: unknown): Array<{ optionId: string; name: string | null }> | null {
  const options = record(params)?.options;
  if (!Array.isArray(options) || !options.length) return null;
  const rows = options.map((option) => ({ optionId: str(record(option)?.optionId), name: str(record(option)?.name) }));
  return rows.every((row) => row.optionId !== null) ? rows as Array<{ optionId: string; name: string | null }> : null;
}

/** The workspace-trust prompt for repository hooks: option ids exactly `{trust, deny}` (server 1.4.0). */
export function isWorkspaceTrustPrompt(params: unknown): boolean {
  const ids = permissionOptions(params)?.map((option) => option.optionId);
  return !!ids && ids.length === 2 && ids.includes("trust") && ids.includes("deny");
}

/**
 * The model's `ask_user` question (server 1.4.0): an `interaction_` call with
 * empty input, no kind, and options that are not the approval ids. Server
 * 1.4.0 asks single-choice questions only.
 */
export function permissionAsQuestion(params: unknown): PermissionQuestion | null {
  const toolCall = record(record(params)?.toolCall);
  if (!toolCall || toolCall.kind != null || !isInteractionCall(str(toolCall.toolCallId), toolCall.rawInput)) return null;
  const options = permissionOptions(params);
  if (!options || options.some((option) => ANTIGRAVITY_APPROVAL_OPTION_IDS.has(option.optionId)) || isWorkspaceTrustPrompt(params)) return null;
  return {
    question: str(toolCall.title) ?? "",
    options: options.map((option) => ({ optionId: option.optionId, label: option.name ?? option.optionId })),
  };
}

/** A server-authored message the agent streams as ordinary assistant text. */
export type ServiceMessage =
  | { type: "failure"; source: "execution" | "connection"; details: string }
  | { type: "model_replaced"; previous: string; replacement: string; rest: string };

const EXECUTION_ERROR = "Agent execution error: ";
const CONNECTION_LOST = "Agent connection was lost and could not be re-established:";

/**
 * Classify one `agent_message_chunk` text. Gateway and harness errors arrive
 * as a single full-text chunk before `end_turn` (server 1.4.0). The
 * model-replacement notice precedes the turn's own reply in the stream.
 * Version-pinned text (risk R11).
 */
export function serviceMessage(text: string): ServiceMessage | null {
  if (text.startsWith(EXECUTION_ERROR)) return { type: "failure", source: "execution", details: text.slice(EXECUTION_ERROR.length).trim() };
  if (text.startsWith(CONNECTION_LOST)) return { type: "failure", source: "connection", details: text.slice(CONNECTION_LOST.length).trim() };
  const replaced = /^(\S+) is no longer available\. Using (\S+)\.\n\n/.exec(text);
  if (replaced) return { type: "model_replaced", previous: replaced[1]!, replacement: replaced[2]!, rest: text.slice(replaced[0].length) };
  return null;
}

/**
 * The typed session failure of a service-message failure. `gatewayStatus` is
 * the last HTTP status the shim saw in this prompt: a 401/403 makes it an
 * authentication failure the daemon classifies as such.
 */
export function serviceMessageFailure(message: Extract<ServiceMessage, { type: "failure" }>, id: string, gatewayStatus: number | null): AcpSessionFailure {
  const auth = gatewayStatus === 401 || gatewayStatus === 403;
  return {
    id, revision: 1, severity: "error",
    category: auth ? "authentication" : message.source === "connection" ? "connection" : "unknown",
    title: auth ? "Antigravity gateway rejected the credentials"
      : message.source === "connection" ? "Antigravity lost its agent connection" : "Antigravity execution error",
    details: message.details,
    ...(auth ? { errorKind: "authentication_failed" } : {}),
  };
}

/**
 * The `tool` label of an item: the bridge's own name when it sends one, else a
 * stable name per class (`resolved` is the adapter's guess from the first
 * frame), so a histogram buckets by tool rather than by command text.
 */
export function toolLabel(facts: ToolFacts, cls: ToolClass, resolved: string | null): string {
  if (facts.name) return facts.name;
  if (cls.type === "tool" && facts.mcp && facts.title) return facts.title;
  if (cls.type === "web_search") return cls.action === "fetch" ? "WebFetch" : "WebSearch";
  if (cls.type === "subagent") return facts.title ?? resolved ?? "Agent";
  return resolved && resolved !== "unknown" ? resolved : facts.title ?? "tool";
}

/** Classify a tool call by the pinned bridge's facts (spec §2.2). */
export function classifyTool(agentType: string, facts: ToolFacts): ToolClass {
  if (agentType === "antigravity") return antigravityClass(facts);
  return agentType === "claude" ? claudeClass(facts) : codexClass(facts);
}

/**
 * `FileChange`s from a frame's ACP `diff` content blocks, or null when it has
 * none. Antigravity's `replace_file_content` diffs are snippet-level: old and
 * new text are the replaced fragment, not the file. Codex sends one block per
 * hunk with `_meta.kind` (CX:29118-29233); its
 * hunks of one path merge into one change. Claude sends `{path, oldText,
 * newText}`, `oldText: null` for a created file (CA/tool-calls/reporters/
 * file-edit.js:20-32, 79-97, 108-121). Patch-only blocks (an AIR `diffPatch`
 * client, which Remi is not) carry no texts and are skipped.
 */
export function diffChanges(frame: VendorFrame): FileChange[] | null {
  if (!Array.isArray(frame.content)) return null;
  const changes: FileChange[] = [];
  for (const block of frame.content) {
    const row = record(block);
    if (row?.type !== "diff" || typeof row.path !== "string") continue;
    if (airMetadata(row._meta)?.diffPatch !== undefined) continue;
    const kind = record(row._meta)?.kind;
    const change = fileChangeFromTexts(row.path, typeof row.oldText === "string" ? row.oldText : null,
      typeof row.newText === "string" ? row.newText : null,
      kind === "add" || kind === "update" || kind === "delete" ? { kind }
        // Antigravity 1.4.0 says `modify`.
        : kind === "modify" ? { kind: "update" } : {});
    const previous = changes.at(-1);
    if (previous && previous.path === change.path && previous.kind === change.kind) {
      const diff = previous.diff !== null && change.diff !== null ? `${previous.diff}\n${change.diff}` : previous.diff ?? change.diff;
      changes[changes.length - 1] = { ...previous, diff, added: previous.added + change.added,
        removed: previous.removed + change.removed,
        ...(previous.diff_truncated || change.diff_truncated ? { diff_truncated: true as const } : {}) };
    } else {
      changes.push(change);
    }
  }
  if (changes.length === 0) return null;
  return capFileChanges(changes).value;
}

// ── Compaction and notices ──────────────────────────────────────────────────

/**
 * Compaction facts from `_meta.jetbrains.air.contextCompaction` (CA/context-
 * compaction-meta.js; `contextCompactionMetadataFromBoundary` in CA/context-
 * compaction.js). Missing facts are undefined so a later update can add them.
 */
export function compactionFacts(frame: VendorFrame): Partial<Pick<TraceCompactionItem, "trigger" | "pre_tokens" | "post_tokens">> {
  const facts = record(airMetadata(frame._meta)?.contextCompaction);
  if (!facts) return {};
  const trigger = facts.trigger === "automatic" || facts.trigger === "manual" ? facts.trigger : undefined;
  const pre = num(facts.preTokens);
  const post = num(facts.postTokens);
  return {
    ...(trigger ? { trigger } : {}),
    ...(pre !== null ? { pre_tokens: pre } : {}),
    ...(post !== null ? { post_tokens: post } : {}),
  };
}

/** The fields of an ACP `notice` update (CA/session-notices.js:6-35; CX:30671-30682). */
export function noticeFields(frame: VendorFrame): Pick<TraceNoticeItem, "severity" | "title" | "description" | "category" | "error_kind"> {
  const severity = frame.severity === "warning" || frame.severity === "error" ? frame.severity : "info";
  return {
    severity,
    title: str(frame.title) ?? "Notice",
    description: str(frame.description),
    category: str(frame.category),
    error_kind: null,
  };
}

/** The notice fields of an AIR session failure. */
export function sessionFailureNotice(failure: AcpSessionFailure): Pick<TraceNoticeItem, "severity" | "title" | "description" | "category" | "error_kind"> {
  return {
    severity: failure.severity,
    title: failure.title,
    description: failure.details ?? null,
    category: failure.category,
    error_kind: failure.errorKind ?? null,
  };
}
