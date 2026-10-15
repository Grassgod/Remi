import type { TaskStreamEvent } from "@connectors/base.js";
import type { FeishuPresentationCheckpoint } from "@multiremi/contracts/types.js";
import type {
  CommandAction,
  TraceAgentMessageItem,
  TraceEvent,
  TraceEventBody,
  TraceItem,
  TraceItemBase,
  TraceItemOf,
  TraceItemType,
  TraceTurn,
  TraceTurnPatch,
  TraceTurnStatus,
} from "@multiremi/contracts/trace.js";
import { completeTurn } from "@shared/turn-trace.js";

// Turn + items fixtures, shaped as the daemon's trace translator writes them.

export const TS = "2026-10-15T00:00:00.000Z";

/** A stored trace event, as the trace subscription delivers it. */
export function traceEvent(seq: number, body: TraceEventBody, ts = TS): TraceEvent {
  return { seq, ts, ...body } as TraceEvent;
}
/** One presentation stream item carrying a trace event. */
export function event(seq: number, body: TraceEventBody): TaskStreamEvent {
  return { kind: "message", message: traceEvent(seq, body) };
}

export function turn(patch: Partial<TraceTurn> = {}): TraceTurn {
  return { id: "tsk_test", turn_id: null, agent_id: "agent_test", agent_name: "Remi", provider: "claude", requested_model: null,
    model: null, status: "running", error: null, started_at: TS, completed_at: null, duration_ms: null, final_item_id: null,
    final_started_at: null, context_usage: null,
    stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] }, ...patch };
}

type ItemFields<T extends TraceItemType> = Omit<TraceItemOf<T>, keyof TraceItemBase | "type">;
const DEFAULTS: { [T in TraceItemType]: ItemFields<T> } = {
  user_message: { origin: "input", text: "", message_ids: [], attachments: [], steer: null },
  agent_message: { text: "", phase: "unknown" },
  reasoning: { text: "" },
  command: { tool: "Bash", source: "shell", command: null, cwd: null, actions: [], output: null, exit_code: null, duration_ms: null },
  file_change: { tool: "Edit", changes: [], output: null, duration_ms: null },
  web_search: { tool: "WebSearch", action: "search", query: null, url: null, output: null, duration_ms: null },
  tool: { tool: "Tool", server: null, kind: null, title: null, input: null, output: null, duration_ms: null },
  subagent: { tool: "Agent", title: null, prompt: null, output: null, duration_ms: null },
  plan: { entries: [] },
  permission: { tool_item_id: null, title: "Tool", message_id: null, options: [], decision: null, outcome: null,
    responded_by: null, reply_message_id: null },
  question: { tool_item_id: null, message: "", message_id: null, questions: [], answers: null, responded_by: null,
    reply_message_id: null },
  compaction: { trigger: "automatic", summary: null, pre_tokens: null, post_tokens: null, error: null },
  notice: { severity: "info", title: "", description: null, category: null, error_kind: null },
};

/** A completed top-level item of `type`; `patch` overrides any field. */
export function item<T extends TraceItemType>(type: T, id: string, patch: Partial<TraceItemOf<T>> = {}): TraceItemOf<T> {
  return { id, parent_id: null, status: "completed", started_at: TS, completed_at: TS, type, ...DEFAULTS[type], ...patch } as unknown as TraceItemOf<T>;
}

export const agentMessage = (id: string, text: string, phase: TraceAgentMessageItem["phase"] = "unknown",
  patch: Partial<TraceAgentMessageItem> = {}) => item("agent_message", id, { text, phase, ...patch });
export const reasoning = (id: string, text: string) => item("reasoning", id, { text });
/** A shell command; `actions` are what `parseCommand` returns for it. */
export const command = (id: string, script: string, actions: CommandAction[] = [{ type: "unknown", command: script }],
  patch: Partial<TraceItemOf<"command">> = {}) => item("command", id, { command: script, actions, ...patch });
/** Claude's Read tool: a command item with one read action and no command text. */
export const read = (id: string, path: string, patch: Partial<TraceItemOf<"command">> = {}) => item("command", id, {
  tool: "Read", source: "tool", actions: [{ type: "read", command: null, name: path.split("/").at(-1)!, path }], ...patch });
/** The turn's input message, as the daemon records it right after `turn.started` (`in:<attempt>`). */
export const input = (text: string, attempt = "tsk_test") => item("user_message", `in:${attempt}`, {
  origin: "input", text, message_ids: [`msg_in_${attempt}`] });
export const plan = (entries: TraceItemOf<"plan">["entries"], patch: Partial<TraceItemOf<"plan">> = {}) =>
  item("plan", "plan", { entries, ...patch });

/** The same item while it runs. */
export function running<T extends TraceItem>(value: T, patch: Partial<T> = {}): T {
  return { ...value, status: "in_progress", completed_at: null, ...patch };
}

export const started = (seq: number, value: TraceItem) => event(seq, { type: "item.started", item: running(value) });
export const updated = (seq: number, value: TraceItem) => event(seq, { type: "item.updated", item: running(value) });
export const completed = (seq: number, value: TraceItem) => event(seq, { type: "item.completed", item: value });
export const delta = (seq: number, itemId: string, text: string, field: "text" | "output" = "text") =>
  event(seq, { type: "item.delta", item_id: itemId, field, delta: text });
export const turnStarted = (seq: number, patch: Partial<TraceTurn> = {}) => event(seq, { type: "turn.started", turn: turn(patch) });
export const turnUpdated = (seq: number, patch: TraceTurnPatch) => event(seq, { type: "turn.updated", patch });
/** `turn.completed` as the transport derives it from the items at close. */
export function turnCompleted(seq: number, items: TraceItem[], patch: Partial<TraceTurn> = {},
  status: Exclude<TraceTurnStatus, "running"> = "completed"): TaskStreamEvent {
  const done = completeTurn({ turn: turn(patch), items }, { status, completedAt: "2026-10-15T00:00:46.000Z" })!;
  return event(seq, { type: "turn.completed", turn: done });
}

/** A text item streamed and closed: started, one delta, completed. */
export function streamedText(seq: number, value: TraceAgentMessageItem | TraceItemOf<"reasoning">): TaskStreamEvent[] {
  return [started(seq, { ...value, text: "" }), delta(seq + 1, value.id, value.text), completed(seq + 2, value)];
}

export const terminal: TaskStreamEvent = { kind: "snapshot", snapshot: { taskId: "tsk_test", status: "completed",
  result: "Final answer", error: null, sessionId: "session_original", workDir: "/test", usage: [] } };
/** The terminal snapshot with other fields. */
export function snapshot(patch: Record<string, unknown>): TaskStreamEvent {
  return { kind: "snapshot", snapshot: { ...(terminal as { snapshot: object }).snapshot, ...patch } } as unknown as TaskStreamEvent;
}

/** The items of {@link transcript}, as the transport closes them. */
export const transcriptItems = {
  prompt: input("Check the source and answer."),
  intro: agentMessage("msg:intro", "I will inspect the source."),
  read: read("toolu_read", "/source.ts"),
  answer: agentMessage("msg:answer", "Final answer", "final"),
};

/**
 * One Claude turn: commentary, a Read whose path arrives late (AIR), the
 * answer the final-reply rule promoted, context usage and the closing turn.
 */
export async function* transcript(): AsyncGenerator<TaskStreamEvent> {
  const { prompt, intro, read: tool, answer } = transcriptItems;
  yield turnStarted(1);
  yield completed(2, prompt);
  yield turnUpdated(3, { model: "claude-fable-5-1" });
  yield* streamedText(4, intro);
  yield started(7, { ...tool, actions: [] });
  yield updated(8, tool);
  yield completed(9, tool);
  yield* streamedText(10, { ...answer, phase: "unknown" });
  yield turnUpdated(13, { context_usage: { used: 82000, size: 1000000 } });
  yield completed(14, answer);
  yield turnCompleted(15, [prompt, intro, tool, answer], { model: "claude-fable-5-1", context_usage: { used: 82000, size: 1000000 } });
  yield terminal;
}

export function nativeHarness() {
  const calls: Array<{ operation: string; input: any }> = [];
  const uuids = new Map<string, string>();
  let nextId = 0;
  const send = async (operation: string, input: any) => {
    calls.push({ operation, input });
    const key = input.data.uuid ?? `new_${nextId}`;
    if (!uuids.has(key)) uuids.set(key, `om_${++nextId}`);
    return { code: 0, data: { message_id: uuids.get(key) } };
  };
  const client = {
    request: async (input: any) => { calls.push({ operation: input.method, input });
      return { code: 0, data: input.method === "POST" ? { cot_id: "cot_1", message_id: "om_cot" } : {} }; },
    im: { message: {
      create: (input: any) => send("create", input), reply: (input: any) => send("reply", input),
      patch: async (input: any) => { calls.push({ operation: "patch", input }); return { code: 0 }; },
    } },
  };
  let checkpoint: FeishuPresentationCheckpoint | undefined;
  return { client, calls, uuids,
    get checkpoint() { return checkpoint; },
    save: async (p: FeishuPresentationCheckpoint) => { checkpoint = structuredClone(p); },
    events: () => calls.filter(c => c.operation === "PUT").flatMap(c => c.input.data.events),
    cards: () => calls.filter(c => ["create", "reply", "patch"].includes(c.operation)).map(c => JSON.parse(c.input.data.content)),
  };
}
