import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTraceEvent, type TraceEvent, type TraceEventInput, type TraceEventLine, type TraceItem } from "@multiremi/contracts/trace.js";
import { TRACE_FILE_FORMAT_V1, type TraceEndStatus } from "@multiremi/contracts/trace-file.js";
import { applyTurnTraceEvents, EMPTY_TURN_TRACE, type TurnTraceState } from "@shared/turn-trace.js";
import { InMemoryTraceStore, type TraceStore } from "@multiremi/worker/trace-store.js";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import { DaemonTraceTransport, type TraceCloseError } from "@multiremi/worker/trace-transport.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";

/** Fold the stored lines of a daemon trace (`TraceStore.read().events`) with the shared reducer. */
export function foldTraceLines(events: readonly TraceEventLine[]): TurnTraceState {
  return applyTurnTraceEvents(EMPTY_TURN_TRACE, events.filter(isTraceEvent));
}

/** The folded items of a daemon trace, in first-seen order. */
export function traceItems(events: readonly TraceEventLine[]): readonly TraceItem[] {
  return foldTraceLines(events).items;
}

/** Text of every agent message item, in order. */
export function agentTexts(events: readonly TraceEventLine[]): string[] {
  return traceItems(events).flatMap((item) => item.type === "agent_message" ? [item.text] : []);
}

// ── Fixtures for the read path (server, CLI, organizer) ─────────────────────

/**
 * The daemon's trace owner over `store`, with a disconnected stub protocol: it
 * never uploads, but appends, folds and seals exactly as production does, so a
 * test reading through `InMemoryDaemonTraceReader(() => store)` sees the real
 * running fold and the real closed snapshot.
 */
export function traceWriter(store: TraceStore = new InMemoryTraceStore(), options: { runtimeId?: string; now?: () => string } = {}) {
  const runtimeId = options.runtimeId ?? "rt_trace";
  const protocol = {
    onWelcome: () => () => {}, onFrame: () => () => {}, connectionState: () => "disconnected", send: () => true,
  } as unknown as DaemonProtocolClient;
  const transport = new DaemonTraceTransport(protocol, store, () => false, () => {}, new Map(), options.now);
  return {
    store,
    transport,
    append: (taskId: string, events: TraceEventInput[]) => transport.append(taskId, runtimeId, events),
    close: (taskId: string, status: TraceEndStatus = "completed", error?: TraceCloseError) => transport.close(taskId, status, error),
    stop: () => transport.stop(),
  };
}

/** A workspaces root holding one v1 (fragment) trace file, read through the daemon's file store. */
export function legacyTraceFile(taskId: string, events: Array<Record<string, unknown>>, options: { runtimeId?: string; closed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "remi-legacy-trace-"));
  const startedAt = "2026-09-28T00:00:00.000Z";
  const lines = [
    JSON.stringify({ format: TRACE_FILE_FORMAT_V1, task_id: taskId, session_id: "ises_legacy", agent_id: "agt_legacy",
      provider: "codex", started_at: startedAt, runtime_id: options.runtimeId ?? "rt_trace" }),
    ...events.map((event) => JSON.stringify(event)),
    ...(options.closed ? [JSON.stringify({ end: { status: "completed", head: Number(events.at(-1)?.seq ?? 0),
      event_count: events.length, ended_at: startedAt } })] : []),
  ];
  mkdirSync(join(root, "traces", "iss_legacy"), { recursive: true });
  writeFileSync(join(root, "traces", "iss_legacy", `${taskId}.jsonl`), `${lines.join("\n")}\n`);
  const store = new TraceFileStore({ workspacesRoot: root, resolveTask: () => {
    throw new Error("a v1 trace is read-only");
  } });
  return { store, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A well-formed stored event for transport tests that treat events as opaque
 * (hub, sink, streamer): an `item.delta` appending `delta` to agent message `msg`.
 */
export function deltaTraceEvent(seq: number, delta = `t-${seq}`, ts = new Date(1_700_000_000_000 + seq).toISOString()): TraceEvent {
  return { seq, ts, type: "item.delta", item_id: "msg", field: "text", delta };
}
