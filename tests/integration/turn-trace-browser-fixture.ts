/**
 * Turn + items traces (PR 2, ADR 0019) for the browser harnesses
 * (`durable-trace-browser-check.ts`, `task-trace-dialog-check.ts`).
 *
 * Every builder returns a value that passes the contract validators, so the web
 * client parses the pages and frames exactly as it would a real daemon's. The
 * fake daemon reader folds the stored events with the shared reducer and pages
 * the fold for `view=turn` (the running fold, or the snapshot once closed), like
 * the daemon's `trace.read`; `view=events` returns the raw lines.
 */
import type {
  CommandAction,
  TraceEvent,
  TraceEventBody,
  TraceItemOf,
  TraceTurn,
} from "@multiremi/contracts/trace.js";
import { applyTurnTraceEvents, closeTurnTrace, completeTurn, EMPTY_TURN_TRACE, pageTurnTrace } from "@shared/turn-trace.js";
import type { DaemonTraceReader, DaemonTraceReadRequest } from "@multiremi/api/trace/daemon-trace-reader.js";

export function traceTurn(id: string, startedAt: string): TraceTurn {
  return {
    id, turn_id: null, agent_id: "agt_browser_fixture", agent_name: null, provider: "codex",
    requested_model: null, model: null, status: "running", error: null, started_at: startedAt,
    completed_at: null, duration_ms: null, final_item_id: null, final_started_at: null, context_usage: null,
    stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] },
  };
}

export function agentMessage(id: string, text: string, phase: TraceItemOf<"agent_message">["phase"], at: string): TraceItemOf<"agent_message"> {
  return { id, parent_id: null, status: "completed", started_at: at, completed_at: at, type: "agent_message", text, phase };
}

/** A completed Codex single-action read of `path`. */
export function readCommand(id: string, path: string, at: string): TraceItemOf<"command"> {
  const action: CommandAction = { type: "read", command: null, name: path.split("/").at(-1)!, path };
  return {
    id, parent_id: null, status: "completed", started_at: at, completed_at: at, type: "command", tool: "read",
    source: "tool", command: null, cwd: null, actions: [action], output: null, exit_code: null, duration_ms: 0,
  };
}

/** Assigns dense seqs from `after + 1`, as `TraceStore.append` does. */
export function sequence(bodies: TraceEventBody[], ts: string, after = 0): TraceEvent[] {
  return bodies.map((body, index) => ({ seq: after + index + 1, ts, ...body }) as TraceEvent);
}

/** The `turn.completed` event body for the trace so far: final item, timing and stats from the fold. */
export function turnCompleted(events: readonly TraceEvent[], completedAt: string): TraceEventBody {
  const state = applyTurnTraceEvents(EMPTY_TURN_TRACE, events);
  const turn = completeTurn(state, { status: "completed", completedAt });
  if (!turn) throw new Error("turn.completed needs a turn.started first");
  return { type: "turn.completed", turn };
}

export interface FakeTraceRead {
  taskId: string;
  view: DaemonTraceReadRequest["view"];
  /** `item_cursor` for `view=turn`, `after_seq` for `view=events`. */
  cursor: number;
  limit: number;
}

/**
 * A daemon trace reader over in-memory event lists. `closed` holds the task ids
 * whose trace is sealed; `reachable` returning false answers `daemon_unreachable`.
 */
export function fakeDaemonTraceReader(
  events: ReadonlyMap<string, TraceEvent[]>,
  closed: ReadonlySet<string>,
  options: { reads?: FakeTraceRead[]; reachable?: () => boolean } = {},
): DaemonTraceReader {
  return {
    async read(request) {
      if (options.reachable && !options.reachable()) {
        return { ok: false, code: "daemon_unreachable", last_seen_at: "2026-10-05T00:00:00.000Z" };
      }
      const { taskId, limit = 200, maxBytes = 1024 * 1024 } = request;
      const all = events.get(taskId) ?? [];
      const head = all.at(-1)?.seq ?? 0;
      const sealed = closed.has(taskId);
      if (request.view === "turn") {
        const itemCursor = request.itemCursor ?? 0;
        options.reads?.push({ taskId, view: "turn", cursor: itemCursor, limit });
        let state = applyTurnTraceEvents(EMPTY_TURN_TRACE, all);
        if (sealed) state = closeTurnTrace(state);
        return { ok: true, ...pageTurnTrace(state, { itemCursor, limit, maxBytes }) };
      }
      const afterSeq = request.afterSeq ?? 0;
      options.reads?.push({ taskId, view: "events", cursor: afterSeq, limit });
      const page = all.filter(event => event.seq > afterSeq).slice(0, limit);
      const next = page.at(-1)?.seq ?? afterSeq;
      return {
        ok: true, view: "events", format: "v2", events: page as unknown as Array<Record<string, unknown> & TraceEvent>,
        next_after_seq: next, head, eof: next >= head, closed: sealed,
      };
    },
  };
}
