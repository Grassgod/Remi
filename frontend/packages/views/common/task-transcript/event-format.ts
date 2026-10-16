import type { TraceItem } from "@multiremi/contracts/trace";
import type { AgentTask } from "@multiremi/core/types/agent";

// Pure presentation helpers shared by the transcript dialog and its rows: how
// a trace item is coloured, labelled and summarised, plus the small value
// formatters the rows print.

export type EventColor = "agent" | "thinking" | "tool" | "result" | "steer" | "error";

const TOOL_TYPES: ReadonlySet<TraceItem["type"]> = new Set(["command", "file_change", "web_search", "tool", "subagent"]);

export function isToolTraceItem(item: TraceItem): boolean {
  return TOOL_TYPES.has(item.type);
}

export function getItemColor(item: TraceItem): EventColor {
  switch (item.type) {
    case "agent_message":
      return "agent";
    case "reasoning":
      return "thinking";
    case "user_message":
      return "steer";
    case "notice":
      return item.severity === "error" ? "error" : "result";
    case "compaction":
      return item.status === "failed" ? "error" : "result";
    default:
      if (!isToolTraceItem(item)) return "result";
      return item.status === "failed" ? "error" : "tool";
  }
}

export const colorClasses: Record<EventColor, { bg: string; bgActive: string; label: string }> = {
  agent: { bg: "bg-emerald-400/60", bgActive: "bg-emerald-500", label: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" },
  thinking: { bg: "bg-violet-400/60", bgActive: "bg-violet-500", label: "bg-violet-500/20 text-violet-700 dark:text-violet-300" },
  tool: { bg: "bg-blue-400/60", bgActive: "bg-blue-500", label: "bg-blue-500/20 text-blue-700 dark:text-blue-300" },
  result: { bg: "bg-slate-300/60 dark:bg-slate-600/60", bgActive: "bg-slate-400 dark:bg-slate-500", label: "bg-muted text-muted-foreground" },
  steer: { bg: "bg-amber-400/60", bgActive: "bg-amber-500", label: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  error: { bg: "bg-red-400/60", bgActive: "bg-red-500", label: "bg-red-500/20 text-red-700 dark:text-red-300" },
};

// ─── Labels and summaries ───────────────────────────────────────────────────

export function getItemLabel(item: TraceItem): string {
  switch (item.type) {
    case "user_message":
      if (item.origin !== "steer") return "Input";
      return item.steer?.kind === "force_answer" ? "Deliver now" : "User steer";
    case "agent_message":
      return item.phase === "final" ? "Final" : "Agent";
    case "reasoning":
      return "Thinking";
    case "command":
      return item.tool || "Command";
    case "file_change":
      return item.tool || "Edit";
    case "web_search":
      return item.tool || (item.action === "fetch" ? "Fetch" : "Web search");
    case "tool":
      return item.tool || "Tool";
    case "subagent":
      return item.tool || "Subagent";
    case "plan":
      return "Plan";
    case "permission":
      return "Permission";
    case "question":
      return "Question";
    case "compaction":
      return "Compaction";
    case "notice":
      return "Notice";
    case "background_task":
      return item.task_type === "shell" ? "Background command" : item.task_type === "workflow" ? "Background workflow" : "Background task";
  }
}

function firstLine(text: string | null | undefined): string {
  return text?.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

export function shortenPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-2).join("/");
}

function inputSummary(input: Record<string, unknown> | null): string {
  if (!input) return "";
  for (const key of ["query", "file_path", "path", "pattern", "description", "command", "prompt", "url", "skill"]) {
    const value = input[key];
    if (typeof value !== "string" || !value) continue;
    return key.endsWith("path") ? shortenPath(value) : value.length > 120 ? `${value.slice(0, 120)}...` : value;
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0 && value.length < 120) return value;
  }
  return "";
}

/** One line that says what an item was, for the row and for "copy all". */
export function getItemSummary(item: TraceItem): string {
  switch (item.type) {
    case "user_message":
    case "agent_message":
      return firstLine(item.text);
    case "reasoning":
      return item.text.slice(0, 200);
    case "command": {
      const command = item.command ?? item.actions.map((action) => action.command).filter(Boolean).join(" && ");
      if (command) return command.length > 160 ? `${command.slice(0, 160)}...` : command;
      const action = item.actions[0];
      return action?.type === "read" ? shortenPath(action.path) : action?.type === "search" ? action.query ?? "" : "";
    }
    case "file_change":
      return item.changes.map((change) => shortenPath(change.path)).join(", ");
    case "web_search":
      return item.query ?? item.url ?? "";
    case "tool":
      return item.title ?? inputSummary(item.input);
    case "subagent":
      return item.title ?? firstLine(item.prompt);
    case "plan": {
      const done = item.entries.filter((entry) => entry.status === "completed").length;
      return item.entries.length ? `${done}/${item.entries.length} · ${item.entries.map((entry) => entry.content).join(" · ")}` : "";
    }
    case "permission": {
      const decision = item.decision?.name ?? item.outcome;
      return [item.title, decision].filter(Boolean).join(" · ");
    }
    case "question":
      return firstLine(item.message);
    case "compaction":
      if (item.error) return item.error;
      if (item.pre_tokens != null && item.post_tokens != null) return `${formatTokenCount(item.pre_tokens)} → ${formatTokenCount(item.post_tokens)}`;
      return firstLine(item.summary);
    case "notice":
      return [item.title, firstLine(item.description)].filter(Boolean).join(" · ");
    case "background_task": {
      // A task still running when its attempt ended continues in the chat's background tasks.
      const name = firstLine(item.name) || firstLine(item.description);
      return item.handed_off ? [name, "handed off"].filter(Boolean).join(" · ")
        : item.stop_reason ? [name, `stopped: ${item.stop_reason}`].join(" · ") : name;
    }
  }
}

function formatTokenCount(value: number): string {
  return value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value);
}

/** Filter value: tool items by their tool, everything else by type. */
export function itemFilterKey(item: TraceItem): string {
  return isToolTraceItem(item) && "tool" in item && item.tool ? `tool:${item.tool}` : item.type;
}

/** The daemon's duration for tools, else the item's own start-to-end time. */
export function itemDurationMs(item: TraceItem): number | null {
  if ("duration_ms" in item && typeof item.duration_ms === "number") return item.duration_ms;
  if (!item.completed_at || item.type === "agent_message" || item.type === "user_message") return null;
  const ms = Date.parse(item.completed_at) - Date.parse(item.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

export function formatProvider(provider: string): string {
  const map: Record<string, string> = {
    claude: "Claude Code",
    "claude-code": "Claude Code",
    codex: "Codex",
    pi: "Pi",
  };
  return map[provider.toLowerCase()] ?? provider;
}

export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Rolled-up token snapshot for the transcript header. */
export interface UsageSnapshot {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

// Fold the server-side per-provider usage rollup (camelCase on the wire) into a
// single header snapshot. Terminal tasks carry this.
export function usageSnapshotFromTask(task: AgentTask): UsageSnapshot | null {
  const entries = task.usage;
  if (!entries || entries.length === 0) return null;
  const acc: UsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let any = false;
  for (const e of entries) {
    if (e.inputTokens) { acc.inputTokens = (acc.inputTokens ?? 0) + e.inputTokens; any = true; }
    if (e.outputTokens) { acc.outputTokens = (acc.outputTokens ?? 0) + e.outputTokens; any = true; }
    if (e.totalTokens) { acc.totalTokens = (acc.totalTokens ?? 0) + e.totalTokens; any = true; }
    if (e.model) acc.model = e.model;
  }
  return any ? acc : null;
}
