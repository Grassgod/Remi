/**
 * Tool-specific formatters for Feishu card display.
 *
 * Provides three display modes:
 * 1. Streaming steps: div + standard_icon per tool (appended to process_panel)
 * 2. Final card steps: div + standard_icon per tool (for process_panel elements)
 * 3. Final card detail: nested collapsible_panel with input/output per tool
 */

// ── Constants ────────────────────────────────────────────

/** Maximum length for tool result preview in display. */
const MAX_RESULT_PREVIEW = 800;
/** Maximum length for a tool input display line. */
const MAX_INPUT_LINE = 400;

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
  // Codex collab verb, lowercase as the bridge reports it (spawnAgent resolves
  // to Agent and reuses the robot icon).
  wait:      "time_outlined",
  Skill:     "file-link-mindnote_outlined",
  TodoWrite: "list-check_outlined",
  NotebookEdit: "edit_outlined",
  EnterPlanMode: "list-check_outlined",
  _thinking: "robot_outlined",
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


/** Build a Feishu Card 2.0 div element for thinking text (robot icon, grey notation). */
export function buildThinkingDiv(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/\n{3,}/g, "\n\n");
  const content = clean;
  return {
    tag: "div",
    icon: { tag: "standard_icon", token: "robot_outlined", color: "grey" },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content,
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
  /** Whether session.addStep has been called for this entry. */
  stepAdded?: boolean;
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
  // Subagent activity is titled "Start subagent <name>", so its tool name can't
  // key the icon table — borrow the Agent robot instead of the wrench default.
  const iconName = isSubagentActivityInput(entry.input) ? "Agent" : entry.name;
  const desc = `${entry.name} ${summary}${dur}`.trim();
  return buildStepDiv(iconName, desc);
}

// ── Tool-specific input summary (one-liner for headers) ──

type ToolFormatter = (input: Record<string, unknown>) => string;

const TOOL_FORMATTERS: Record<string, ToolFormatter> = {
  Read: (input) => {
    const path = shortPath(str(input.file_path));
    if (!path) return "";
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
    const cmd = commandSummary(str(input.command), MAX_INPUT_LINE);
    return `\`$ ${cmd}\``;
  },

  Grep: (input) => {
    const pattern = str(input.pattern);
    const path = input.path ? ` in \`${shortPath(str(input.path))}\`` : "";
    const glob = input.glob ? ` (${input.glob})` : "";
    return `\`/${pattern}/\`${path}${glob}`;
  },

  Glob: (input) => {
    const pattern = shortPath(str(input.pattern));
    const path = input.path ? ` in \`${shortPath(str(input.path))}\`` : "";
    return `\`${pattern}\`${path}`;
  },

  WebFetch: (input) => {
    const url = truncate(str(input.url), 200);
    return `\`${url}\``;
  },

  WebSearch: (input) => {
    const query = truncate(str(input.query), 200);
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

  Agent: (input) => agentPromptSummary(input),

  Skill: (input) => {
    const skill = str(input.skill);
    const args = input.args ? ` ${truncate(str(input.args), 120)}` : "";
    return `\`${skill}${args}\``;
  },
};

export function formatToolInputSummary(name: string, input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "";
  // Shape before name: a delegation keeps the prompt summary (spawnAgent already
  // resolves to Agent), a prompt-less collab verb summarizes agent states, and
  // subagent activity is titled per subagent so it has no usable name key.
  if (isSubagentActivityInput(input)) return subagentActivitySummary(input);
  if (isCollabInput(input)) {
    return str(input.prompt) ? agentPromptSummary(input) : collabStateSummary(input);
  }
  const formatter = TOOL_FORMATTERS[name];
  if (formatter) return formatter(input);
  return defaultFormatter(input);
}

function agentPromptSummary(input: Record<string, unknown>): string {
  const desc = str(input.description ?? input.prompt ?? "");
  return desc ? `"${truncate(desc, 200)}"` : "";
}

/**
 * Codex collab (subagent delegation) calls, recognized by input shape rather
 * than verb name — mirrors isCollabInput in the web port
 * (frontend/packages/views/common/task-transcript/tool-summaries.ts), as this
 * whole file is intentionally parallel to it. `spawnAgent` normalizes to
 * `Agent`, but `wait` and any send/close verb pass through raw and would hit
 * defaultFormatter, which prints a bare senderThreadId. `prompt` is null on
 * `wait`, so it cannot be the discriminator.
 */
export function isCollabInput(input?: Record<string, unknown>): boolean {
  return typeof input?.senderThreadId === "string" && Array.isArray(input.receiverThreadIds);
}

/**
 * Codex subagent activity (codex-acp >= 1.1.14) — a third shape, distinct from
 * the `senderThreadId` collab calls. The ACP title is "Start subagent <name>",
 * so the resolved tool name varies per subagent and only the shape identifies
 * it. Mirrors isSubagentActivityInput in the web port.
 */
export function isSubagentActivityInput(input?: Record<string, unknown>): boolean {
  return typeof input?.agentThreadId === "string" && typeof input.activityKind === "string";
}

/** Last segment of an agentPath — the subagent's name. */
export function subagentName(agentPath: unknown): string {
  const parts = str(agentPath).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Verb plus subagent name; the thread id never reaches a one-line summary. */
function subagentActivitySummary(input: Record<string, unknown>): string {
  const kind = str(input.activityKind);
  const name = subagentName(input.agentPath);
  if (kind && name) return `${kind} · ${name}`;
  return name || kind;
}

/** Counts, never thread ids. Only `completed` is terminal. */
function collabStateSummary(input: Record<string, unknown>): string {
  const states = input.agentsStates;
  const values =
    states && typeof states === "object" && !Array.isArray(states)
      ? Object.values(states as Record<string, unknown>)
      : [];
  const done = values.filter(
    (v) => v && typeof v === "object" && (v as Record<string, unknown>).status === "completed",
  ).length;
  const running = values.length - done;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (parts.length > 0) return parts.join(" · ");
  const receivers = Array.isArray(input.receiverThreadIds) ? input.receiverThreadIds.length : 0;
  return `waiting for ${receivers} agents`;
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

/**
 * Summarize a shell command for a one-line header — first line, head-truncated,
 * plus how many lines were dropped. A command is not a path, so shortPath() must
 * not touch it; and a raw multi-line command would break the inline code span the
 * caller wraps it in. The `(+N)` suffix stays symbols-only on purpose: it renders
 * inside a monospaced command string, not prose.
 */
function commandSummary(command: string, max: number): string {
  const lines = command.trimEnd().split("\n");
  const dropped = lines.length - 1;
  const head = truncate(lines[0] ?? "", max);
  return dropped > 0 ? `${head} (+${dropped})` : head;
}

/** Shorten a file path for display — replace home dir with ~/, keep relative. */
export function shortPath(path: string): string {
  if (!path) return "";
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const home = process.env.HOME || "/home";
  let out = path.replace(new RegExp(`^${escapeRe(home)}/`), "~/");

  // Some platforms expose two equivalent home roots (e.g. /data00/home/<user>
  // vs /home/<user>). Normalize the alternate root if present.
  const homeAlt = process.env.HOME_ALT;
  if (homeAlt) {
    out = out.replace(new RegExp(`^${escapeRe(homeAlt)}/`), "~/");
  }
  return out;
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
