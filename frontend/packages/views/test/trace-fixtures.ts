import type {
  CommandAction,
  FileChange,
  TraceEvent,
  TraceEventBody,
  TraceItem,
  TraceItemOf,
  TraceTurn,
  TraceTurnPage,
} from "@multiremi/contracts/trace";
import { turnTraceFromPage } from "@multiremi/shared/turn-trace";

// Builders for turn + items traces (PR 2) shared by the views tests. Every
// builder returns a value that passes the contract validators, so a fixture
// that parses through the API schemas behaves like a real daemon page.

export const T0 = "2026-10-15T08:00:00.000Z";

/** ISO time `seconds` after {@link T0}. */
export function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

export function traceTurn(overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    id: "att_1",
    turn_id: "turn_1",
    agent_id: "agt_1",
    agent_name: "Remi",
    provider: "codex",
    requested_model: null,
    model: null,
    status: "running",
    error: null,
    started_at: T0,
    completed_at: null,
    duration_ms: null,
    final_item_id: null,
    final_started_at: null,
    context_usage: null,
    stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] },
    ...overrides,
  };
}

type Base = Pick<TraceItem, "id" | "parent_id" | "status" | "started_at" | "completed_at">;

function base(id: string, overrides: Partial<Base>): Base {
  return { id, parent_id: null, status: "completed", started_at: T0, completed_at: T0, ...overrides };
}

export function message(id: string, text: string, phase: TraceItemOf<"agent_message">["phase"] = "commentary",
  overrides: Partial<TraceItemOf<"agent_message">> = {}): TraceItemOf<"agent_message"> {
  return { ...base(id, overrides), type: "agent_message", text, phase, ...overrides };
}

export function reasoning(id: string, text: string, overrides: Partial<TraceItemOf<"reasoning">> = {}): TraceItemOf<"reasoning"> {
  return { ...base(id, overrides), type: "reasoning", text, ...overrides };
}

export function userMessage(id: string, text: string): TraceItemOf<"user_message"> {
  return { ...base(id, {}), type: "user_message", origin: "input", text, message_ids: [], attachments: [], steer: null };
}

export const read = (path: string, name = path.split("/").at(-1)!): CommandAction =>
  ({ type: "read", command: `cat ${path}`, name, path });
export const search = (query: string | null, path: string | null = null): CommandAction =>
  ({ type: "search", command: `rg ${query ?? ""}`, query, path });
export const listFiles = (path: string | null = null): CommandAction => ({ type: "list_files", command: "ls", path });
export const unknown = (command: string): CommandAction => ({ type: "unknown", command });

export function command(id: string, actions: CommandAction[], overrides: Partial<TraceItemOf<"command">> = {}): TraceItemOf<"command"> {
  const text = actions.map((action) => action.command).filter(Boolean).join(" && ") || null;
  return {
    ...base(id, overrides), type: "command", tool: "Bash", source: "shell", command: text, cwd: null, actions,
    output: null, exit_code: 0, duration_ms: 10, ...overrides,
  };
}

export const change = (path: string, kind: FileChange["kind"] = "update", diff: string | null = "@@\n-a\n+b"): FileChange =>
  ({ path, kind, move_path: null, diff, added: diff ? 1 : 0, removed: diff ? 1 : 0 });

export function fileChange(id: string, changes: FileChange[], overrides: Partial<TraceItemOf<"file_change">> = {}): TraceItemOf<"file_change"> {
  return { ...base(id, overrides), type: "file_change", tool: "Edit", changes, output: null, duration_ms: 5, ...overrides };
}

export function webSearch(id: string, query: string | null, overrides: Partial<TraceItemOf<"web_search">> = {}): TraceItemOf<"web_search"> {
  return { ...base(id, overrides), type: "web_search", tool: "WebSearch", action: "search", query, url: null, output: null, duration_ms: 5, ...overrides };
}

export function tool(id: string, name: string, overrides: Partial<TraceItemOf<"tool">> = {}): TraceItemOf<"tool"> {
  return { ...base(id, overrides), type: "tool", tool: name, server: null, kind: null, title: null, input: null, output: null, duration_ms: 5, ...overrides };
}

export function subagent(id: string, title: string, overrides: Partial<TraceItemOf<"subagent">> = {}): TraceItemOf<"subagent"> {
  return { ...base(id, overrides), type: "subagent", tool: "Agent", title, prompt: null, output: null, duration_ms: 5, ...overrides };
}

export function plan(entries: TraceItemOf<"plan">["entries"], overrides: Partial<TraceItemOf<"plan">> = {}): TraceItemOf<"plan"> {
  return { ...base("plan", overrides), type: "plan", entries, ...overrides };
}

export function permission(id: string, title: string): TraceItemOf<"permission"> {
  return { ...base(id, {}), type: "permission", tool_item_id: null, title, message_id: null, options: [], decision: null,
    outcome: "selected", responded_by: null, reply_message_id: null };
}

export function notice(id: string, title: string, severity: TraceItemOf<"notice">["severity"] = "warning"): TraceItemOf<"notice"> {
  return { ...base(id, {}), type: "notice", severity, title, description: null, category: null, error_kind: null };
}

export function compaction(id: string, overrides: Partial<TraceItemOf<"compaction">> = {}): TraceItemOf<"compaction"> {
  return { ...base(id, overrides), type: "compaction", trigger: "automatic", summary: null, pre_tokens: null, post_tokens: null, error: null, ...overrides };
}

/** One `view=turn` page with the read status the routes add. */
export function turnPage(turn: TraceTurn | null, items: TraceItem[], overrides: Partial<TraceTurnPage> & Record<string, unknown> = {}) {
  return {
    view: "turn" as const, format: "v2" as const, turn, items, next_item_cursor: null, head: items.length + 1,
    closed: turn ? turn.status !== "running" : false, state: "ok" as const, source: "daemon" as const, ...overrides,
  };
}

let seq = 1000;
/** A live event with a fresh seq above any page head the tests use. */
export function event(body: TraceEventBody, eventSeq = ++seq): TraceEvent {
  return { seq: eventSeq, ts: T0, ...body } as TraceEvent;
}

/** The `["task-trace", id]` cache value a loaded read leaves behind. */
export function turnTraceCache(page: ReturnType<typeof turnPage>) {
  return { state: turnTraceFromPage(page), read: { state: page.state, format: page.format }, pending: [] };
}
