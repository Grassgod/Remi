/**
 * Tool-specific formatters for Feishu card display.
 *
 * Provides three display modes:
 * 1. Streaming steps: emoji + one-liner per tool (for process_content markdown)
 * 2. Final card steps: div + standard_icon per tool (for process_panel elements)
 * 3. Final card detail: nested collapsible_panel with input/output per tool
 */

// ── Constants ────────────────────────────────────────────

/** Maximum length for tool result preview in display. */
const MAX_RESULT_PREVIEW = 800;
/** Maximum length for a tool input display line. */
const MAX_INPUT_LINE = 200;

// ── Tool icon mappings ──────────────────────────────────

/** Feishu standard_icon tokens for final card div elements. */
export const TOOL_ICONS: Record<string, string> = {
  Bash:      "computer_outlined",
  Read:      "file-link-bitable_outlined",
  Write:     "edit_outlined",
  Edit:      "edit_outlined",
  Glob:      "card-search_outlined",
  Grep:      "doc-search_outlined",
  WebFetch:  "language_outlined",
  WebSearch: "search_outlined",
  Agent:     "robot_outlined",
  Skill:     "file-link-mindnote_outlined",
  TodoWrite: "task_outlined",
  NotebookEdit: "edit_outlined",
  EnterPlanMode: "task_outlined",
  _default:  "setting-inter_outlined",
};

// TOOL_EMOJI removed — all rendering now uses standard_icon via TOOL_ICONS or plain text.

/** Build a Feishu Card 2.0 div element with standard_icon for final card. */
export function buildStepDiv(toolName: string, desc: string): Record<string, unknown> {
  const iconToken = TOOL_ICONS[toolName] ?? TOOL_ICONS._default;
  return {
    tag: "div",
    icon: { tag: "standard_icon", token: iconToken, color: "grey" },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: desc,
    },
  };
}


// ── Tool entry data structure ────────────────────────────

export interface ToolEntry {
  name: string;
  input?: Record<string, unknown>;
  resultPreview?: string;
  durationMs?: number;
  status: "pending" | "done";
  /** Thinking text that appeared before this tool call. */
  thinkingBefore: string;
}

// ── Streaming mode: markdown text for thinking panel ─────

/** Format a tool entry as markdown for the streaming thinking panel. */
export function formatToolEntryMarkdown(
  name: string,
  input?: Record<string, unknown>,
  resultPreview?: string,
  durationMs?: number,
  status: "pending" | "done" = "done",
): string {
  const parts: string[] = [];
  const inputSummary = formatToolInputSummary(name, input);

  if (status === "pending") {
    parts.push(`\n→ **${name}** ${inputSummary}`);
  } else {
    const dur = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
    parts.push(`\n✓ **${name}** ${inputSummary}${dur}`);
  }

  if (resultPreview) {
    const formatted = formatResultPreview(resultPreview);
    if (formatted) parts.push(formatted);
  }

  parts.push("");  // trailing newline
  return parts.join("\n");
}

/**
 * Replace the last pending marker (→) in thinking text with ✓ + result preview.
 * Returns the updated thinking text.
 */
export function replaceLastPending(
  thinkingText: string,
  name: string,
  resultPreview?: string,
  durationMs?: number,
): string {
  const PENDING = "→ **";
  const dur = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
  let replacement = `✓ **`;
  // Find the last pending marker
  const lastIdx = thinkingText.lastIndexOf(PENDING);
  if (lastIdx === -1) return thinkingText;

  // Find end of line
  const lineEnd = thinkingText.indexOf("\n", lastIdx);
  const endIdx = lineEnd === -1 ? thinkingText.length : lineEnd + 1;

  // Reconstruct: replace "→ **Name** summary" with "✓ **Name** summary (dur)"
  const oldLine = thinkingText.slice(lastIdx, lineEnd === -1 ? undefined : lineEnd);
  const newLine = oldLine.replace("→", "✓") + dur;

  let result = thinkingText.slice(0, lastIdx) + newLine;
  if (resultPreview) {
    const preview = formatResultPreview(resultPreview);
    if (preview) result += "\n" + preview;
  }
  result += "\n" + thinkingText.slice(endIdx);

  return result;
}

// ── Final card mode: lightweight div element ─────────────

/** Build a lightweight div element for one tool call (no Input/Output). */
export function buildToolDiv(entry: ToolEntry): Record<string, unknown> {
  const dur = entry.durationMs != null ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : "";
  const summary = formatToolInputSummary(entry.name, entry.input);
  const desc = `${entry.name} ${summary}${dur}`.trim();
  return buildStepDiv(entry.name, desc);
}

// ── Tool-specific input summary (one-liner for headers) ──

type ToolFormatter = (input: Record<string, unknown>) => string;

const TOOL_FORMATTERS: Record<string, ToolFormatter> = {
  Read: (input) => {
    const path = shortPath(str(input.file_path));
    const offset = input.offset ? ` L${input.offset}` : "";
    const limit = input.limit ? `-${Number(input.offset ?? 1) + Number(input.limit)}` : "";
    return `\`${path}${offset}${limit}\``;
  },

  Edit: (input) => {
    const path = shortPath(str(input.file_path));
    return `\`${path}\``;
  },

  Write: (input) => {
    const path = shortPath(str(input.file_path));
    return `\`${path}\``;
  },

  Bash: (input) => {
    const cmd = truncate(str(input.command), MAX_INPUT_LINE);
    return `\`$ ${cmd}\``;
  },

  Grep: (input) => {
    const pattern = str(input.pattern);
    const path = input.path ? ` in \`${shortPath(str(input.path))}\`` : "";
    const glob = input.glob ? ` (${input.glob})` : "";
    return `\`/${pattern}/\`${path}${glob}`;
  },

  Glob: (input) => {
    const pattern = str(input.pattern);
    const path = input.path ? ` in \`${shortPath(str(input.path))}\`` : "";
    return `\`${pattern}\`${path}`;
  },

  WebFetch: (input) => {
    const url = truncate(str(input.url), 100);
    return `\`${url}\``;
  },

  WebSearch: (input) => {
    const query = truncate(str(input.query), 100);
    return `"${query}"`;
  },

  TodoWrite: (input) => {
    const todos = input.todos as Array<Record<string, unknown>> | undefined;
    if (!todos) return "";
    const count = todos.length;
    const completed = todos.filter((t) => t.status === "completed").length;
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    return `${count} tasks (${completed} done, ${inProgress} active)`;
  },

  Agent: (input) => {
    const desc = str(input.description ?? input.prompt ?? "");
    return desc ? `"${truncate(desc, 80)}"` : "";
  },

  Skill: (input) => {
    const skill = str(input.skill);
    const args = input.args ? ` ${truncate(str(input.args), 60)}` : "";
    return `\`${skill}${args}\``;
  },
};

function formatToolInputSummary(name: string, input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "";
  const formatter = TOOL_FORMATTERS[name];
  if (formatter) return formatter(input);
  return defaultFormatter(input);
}

function defaultFormatter(input: Record<string, unknown>): string {
  const entries = Object.entries(input).slice(0, 3);
  const parts = entries.map(([k, v]) => {
    const val = truncate(String(v), 80);
    return `${k}=\`${val}\``;
  });
  return parts.join(" ");
}

// ── Detailed input for collapsible panel interior ────────

function formatToolInputDetailed(name: string, input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "";

  // Tool-specific detailed formatting
  if (name === "Edit") {
    const parts: string[] = [];
    parts.push(`file: \`${str(input.file_path)}\``);
    if (input.old_string) {
      parts.push("```diff");
      parts.push("- " + truncate(str(input.old_string), 300));
      parts.push("+ " + truncate(str(input.new_string), 300));
      parts.push("```");
    }
    return parts.join("\n");
  }

  if (name === "Bash") {
    return "```bash\n" + truncate(str(input.command), 500) + "\n```";
  }

  if (name === "Write") {
    const content = str(input.content);
    const lines = content.split("\n").length;
    return `file: \`${str(input.file_path)}\` (${lines} lines)`;
  }

  // Generic: show all key-value pairs
  const entries = Object.entries(input);
  return entries.map(([k, v]) => {
    const val = typeof v === "string" ? truncate(v, 200) : JSON.stringify(v)?.slice(0, 200) ?? "";
    return `${k}: \`${val}\``;
  }).join("\n");
}

// ── Helpers ──────────────────────────────────────────────

function str(val: unknown): string {
  if (val === undefined || val === null) return "";
  return String(val);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/** Shorten a file path for display — replace home dir with ~/, keep relative. */
export function shortPath(path: string): string {
  if (!path) return "";
  return path
    .replace(/^\/data00\/home\/hehuajie\//, "~/")
    .replace(/^\/home\/hehuajie\//, "~/");
}

function formatResultPreview(resultPreview: string): string {
  const trimmed = resultPreview.trim();
  if (!trimmed) return "";
  const truncated = trimmed.length > MAX_RESULT_PREVIEW
    ? trimmed.slice(0, MAX_RESULT_PREVIEW) + "\n... (truncated)"
    : trimmed;
  // Wrap in blockquote for visual distinction
  return truncated.split("\n").map((l) => `> ${l}`).join("\n");
}
