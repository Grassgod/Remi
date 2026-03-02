/**
 * Tool-specific formatters for Feishu card display.
 *
 * Provides two display modes:
 * 1. Streaming: rich markdown text appended to thinking content
 * 2. Final card: nested collapsible_panel JSON for each tool call
 */

// ── Constants ────────────────────────────────────────────

/** Maximum length for tool result preview in display. */
const MAX_RESULT_PREVIEW = 800;
/** Maximum length for a tool input display line. */
const MAX_INPUT_LINE = 200;

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
    parts.push(`\n🔧 **${name}** ${inputSummary} ⏳`);
  } else {
    const dur = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
    parts.push(`\n✅ **${name}** ${inputSummary}${dur}`);
  }

  if (resultPreview) {
    const formatted = formatResultPreview(resultPreview);
    if (formatted) parts.push(formatted);
  }

  parts.push("");  // trailing newline
  return parts.join("\n");
}

/**
 * Replace the last ⏳ marker in thinking text with ✅ + result preview.
 * Returns the updated thinking text.
 */
export function replaceLastPending(
  thinkingText: string,
  name: string,
  resultPreview?: string,
  durationMs?: number,
): string {
  const dur = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
  let replacement = `✅${dur}`;
  if (resultPreview) {
    const preview = formatResultPreview(resultPreview);
    if (preview) replacement += "\n" + preview;
  }
  replacement += "\n";

  // Replace the last ⏳ (with optional trailing whitespace/newline)
  const lastIdx = thinkingText.lastIndexOf("⏳");
  if (lastIdx === -1) return thinkingText;

  // Find the end of the ⏳ line
  const afterEmoji = lastIdx + "⏳".length;
  let endIdx = afterEmoji;
  while (endIdx < thinkingText.length && thinkingText[endIdx] === " ") endIdx++;
  if (endIdx < thinkingText.length && thinkingText[endIdx] === "\n") endIdx++;

  return thinkingText.slice(0, lastIdx) + replacement + thinkingText.slice(endIdx);
}

// ── Final card mode: nested collapsible_panel JSON ───────

/** Build a nested collapsible_panel element for one tool call. */
export function buildToolCollapsible(entry: ToolEntry): Record<string, unknown> {
  const dur = entry.durationMs != null ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : "";
  const icon = entry.status === "done" ? "✅" : "⏳";
  const summary = formatToolInputSummary(entry.name, entry.input);

  // Build detailed markdown content for inside the collapsible
  const details: string[] = [];

  // Input section
  const inputLines = formatToolInputDetailed(entry.name, entry.input);
  if (inputLines) {
    details.push("**Input:**");
    details.push(inputLines);
  }

  // Output section
  if (entry.resultPreview) {
    details.push("**Output:**");
    const trimmed = entry.resultPreview.trim();
    const truncated = trimmed.length > MAX_RESULT_PREVIEW
      ? trimmed.slice(0, MAX_RESULT_PREVIEW) + "\n... (truncated)"
      : trimmed;
    details.push("```\n" + truncated + "\n```");
  }

  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: `${icon} ${entry.name} ${summary}${dur}`,
      },
    },
    vertical_spacing: "2px",
    elements: details.length > 0
      ? [{ tag: "markdown", content: details.join("\n") }]
      : [{ tag: "markdown", content: "*No details available*" }],
  };
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

/** Shorten a file path for display — show last 3 segments. */
function shortPath(path: string): string {
  if (!path) return "";
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-3).join("/");
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
