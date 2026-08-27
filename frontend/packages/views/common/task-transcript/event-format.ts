import type { AgentTask } from "@multiremi/core/types/agent";
import type { TimelineItem, UsageSnapshot } from "./build-timeline";

// Pure presentation helpers shared by the transcript dialog and its rows:
// how an event is coloured, labelled and summarised, plus the small value
// formatters the rows print.

export type EventColor = "agent" | "thinking" | "tool" | "result" | "steer" | "error";

export function getEventColor(item: TimelineItem): EventColor {
  switch (item.type) {
    case "text":
      return "agent";
    case "thinking":
      return "thinking";
    case "tool_use":
      return "tool";
    case "tool_result":
      return "result";
    case "steer":
      return "steer";
    case "error":
      return "error";
    default:
      return "result";
  }
}

export const colorClasses: Record<EventColor, { bg: string; bgActive: string; label: string }> = {
  agent: { bg: "bg-emerald-400/60", bgActive: "bg-emerald-500", label: "bg-emerald-500" },
  thinking: { bg: "bg-violet-400/60", bgActive: "bg-violet-500", label: "bg-violet-500/20 text-violet-700 dark:text-violet-300" },
  tool: { bg: "bg-blue-400/60", bgActive: "bg-blue-500", label: "bg-blue-500/20 text-blue-700 dark:text-blue-300" },
  result: { bg: "bg-slate-300/60 dark:bg-slate-600/60", bgActive: "bg-slate-400 dark:bg-slate-500", label: "bg-muted text-muted-foreground" },
  steer: { bg: "bg-amber-400/60", bgActive: "bg-amber-500", label: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  error: { bg: "bg-red-400/60", bgActive: "bg-red-500", label: "bg-red-500/20 text-red-700 dark:text-red-300" },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getEventLabel(item: TimelineItem): string {
  switch (item.type) {
    case "text":
      return "Agent";
    case "thinking":
      return "Thinking";
    case "compaction":
      return "Compaction";
    case "tool_use":
      return item.tool ?? "Tool";
    case "tool_result":
      return item.tool ? `${item.tool}` : "Result";
    case "steer":
      return item.meta?.steer_kind === "force_answer" ? "Deliver now" : "User steer";
    case "error":
      return "Error";
    case "permission_request":
      return "Permission";
    case "permission_response":
      return "Permission";
    case "question_request":
      return "Question";
    case "question_response":
      return "Answer";
    default:
      // Unknown/new message kinds render their raw type rather than a generic
      // "Event" — the old default paired with an empty summary produced the
      // uninformative "Event (empty)" rows. (`type` is exhaustive for the
      // current union, so this is future-proofing for widened payloads.)
      return (item.type as string) ? String(item.type).replace(/_/g, " ") : "Event";
  }
}

export function getEventSummary(item: TimelineItem): string {
  switch (item.type) {
    case "text":
      return item.content?.split("\n").find((l) => l.trim().length > 0) ?? "";
    case "thinking":
      return item.content?.slice(0, 200) ?? "";
    case "tool_use": {
      if (!item.input) return "";
      const inp = item.input as Record<string, string>;
      if (inp.query) return inp.query;
      if (inp.file_path) return shortenPath(inp.file_path);
      if (inp.path) return shortenPath(inp.path);
      if (inp.pattern) return inp.pattern;
      if (inp.description) return String(inp.description);
      if (inp.command) {
        const cmd = String(inp.command);
        return cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
      }
      if (inp.prompt) {
        const p = String(inp.prompt);
        return p.length > 120 ? p.slice(0, 120) + "..." : p;
      }
      if (inp.skill) return String(inp.skill);
      for (const v of Object.values(inp)) {
        if (typeof v === "string" && v.length > 0 && v.length < 120) return v;
      }
      return "";
    }
    case "tool_result":
      return item.output?.slice(0, 200) ?? "";
    case "error":
      return item.content ?? "";
    case "steer":
      return item.content?.split("\n").find((line) => line.trim().length > 0) ?? "";
    case "permission_request":
    case "question_request": {
      // daemon already writes a human-readable line into content
      // ("Permission requested: Bash" / the question text); append a count of
      // the options / questions carried in input.
      const base = item.content ?? getEventLabel(item);
      const inp = item.input as Record<string, unknown> | undefined;
      const options = Array.isArray(inp?.options) ? (inp!.options as unknown[]).length : 0;
      const questions = Array.isArray(inp?.questions) ? (inp!.questions as unknown[]).length : 0;
      const n = options || questions;
      return n > 0 ? `${base} (${n})` : base;
    }
    case "permission_response":
    case "question_response": {
      const inp = item.input as Record<string, unknown> | undefined;
      const chosen = inp?.option_id ?? (Array.isArray(inp?.answers) ? (inp!.answers as unknown[]).join(", ") : undefined);
      const status = inp?.status;
      return [chosen, status].filter(Boolean).map(String).join(" · ") || (item.content ?? "");
    }
    default:
      // Any other kind: first non-empty line of content, else output.
      return (
        item.content?.split("\n").find((l) => l.trim().length > 0) ??
        item.output?.slice(0, 200) ??
        ""
      );
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

export function formatProvider(provider: string): string {
  const map: Record<string, string> = {
    claude: "Claude Code",
    "claude-code": "Claude Code",
    codex: "Codex",
    pi: "Pi",
  };
  return map[provider.toLowerCase()] ?? provider;
}

/** Agent / Task (legacy) steps delegate to a subagent — they own children and report Markdown. */
export function isSubagentStep(tool?: string): boolean {
  return tool === "Agent" || tool === "Task";
}

export function omitKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([k]) => !keys.includes(k)));
}

/** Thread ids are UUIDs — show a recognizable head, never the full id inline. */
export function shortThreadId(id: string): string {
  return id.slice(0, 8);
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

// Fold the server-side per-provider usage rollup (camelCase on the wire) into a
// single header snapshot. Terminal tasks carry this; live fallback (last usage
// message) is a Batch 3 concern.
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
