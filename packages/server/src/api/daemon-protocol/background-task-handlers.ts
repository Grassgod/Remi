/**
 * PR 6 (keep-alive on demand, spec §5): the daemon -> server background-task
 * frames, both gated by the negotiated `lane.background` cap.
 *
 * - `lane.background_tasks` (best effort): one lane's whole task list. The
 *   frame is authorized like every runtime report and scoped to the lane's
 *   runtime: each task must name an origin attempt of the lane that ran there.
 *   A malformed or unauthorized frame writes nothing; without an `id` it gets
 *   no reply, so the next debounced snapshot or refresh replaces it.
 * - `lane.background_wake` (RPC): a parked Claude task ended; the store writes
 *   the doorbell and lets the lane machine create, merge or steer a turn, or
 *   refuses with `lane_moved` / `session_closed`.
 *
 * A socket that did not negotiate the cap is treated as an older server
 * would: the snapshot is ignored and the wake refused.
 */
import {
  BACKGROUND_LANE_STATES,
  BACKGROUND_TASK_STOP_REASONS,
  type BackgroundLaneState,
  type BackgroundTaskReportedStatus,
  type BackgroundTaskStopReason,
} from "@multiremi/contracts/unified-model.js";
import {
  DAEMON_LANE_BACKGROUND_MAX_BYTES,
  DAEMON_LANE_BACKGROUND_MAX_TASKS,
  type DaemonLaneBackgroundTask,
  type DaemonLaneBackgroundTasksPayload,
  type DaemonLaneBackgroundWakePayload,
} from "@multiremi/contracts/daemon-protocol.js";
import {
  isTraceBackgroundTaskStopRequest,
  isTraceBackgroundTaskUsage,
  isTraceTimestamp,
} from "@multiremi/contracts/trace.js";
import {
  TRACE_ITEM_COMMAND_MAX_BYTES,
  TRACE_ITEM_SUMMARY_MAX_BYTES,
  capLabel,
  capOutputTail,
  truncateUtf8,
} from "@shared/trace-sanitize.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { BackgroundTaskError } from "@multiremi/store/repos/background-tasks-repo.js";
import type { DaemonProtocolLayer } from "./index.js";
import type { DaemonProtocolSession } from "./session.js";
import type { DaemonParsedFrame } from "./frames.js";
import { authorizeReportRuntime } from "./report-handlers.js";

class Malformed extends Error {
  constructor(readonly code = "invalid_report") { super(code); }
}

function malformed(code?: string): never { throw new Malformed(code); }
const REPORTED_STATUSES: readonly BackgroundTaskReportedStatus[] = ["running", "paused", "completed", "failed", "stopped"];
/** Bridge ids are short; a long one is a malformed frame, not a task. */
const MAX_ID_BYTES = 512;

function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES) malformed();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") malformed();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return text(value);
}

function nullableCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) malformed();
  return Math.round(value);
}

function nullableTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isTraceTimestamp(value)) malformed();
  return value;
}

function laneTask(value: unknown): DaemonLaneBackgroundTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const task = value as Record<string, unknown>;
  const status = task.status as BackgroundTaskReportedStatus;
  if (!REPORTED_STATUSES.includes(status) || typeof task.can_stop !== "boolean" || !isTraceTimestamp(task.started_at)) malformed();
  const stopReason = task.stop_reason ?? null;
  if (stopReason !== null && !BACKGROUND_TASK_STOP_REASONS.includes(stopReason as BackgroundTaskStopReason)) malformed();
  const stopRequest = task.stop_request ?? null;
  if (stopRequest !== null && !isTraceBackgroundTaskStopRequest(stopRequest)) malformed();
  const usage = task.usage ?? null;
  if (usage !== null && !isTraceBackgroundTaskUsage(usage)) malformed();
  if (task.output_unreadable !== undefined && typeof task.output_unreadable !== "boolean") malformed();
  const command = nullableText(task.command);
  const summary = nullableText(task.summary);
  return {
    task_id: id(task.task_id),
    task_type: capLabel(text(task.task_type)),
    name: capLabel(text(task.name)),
    command: truncateUtf8(command, TRACE_ITEM_COMMAND_MAX_BYTES),
    origin_attempt_id: id(task.origin_attempt_id),
    origin_item_id: task.origin_item_id === undefined || task.origin_item_id === null ? null : id(task.origin_item_id),
    status,
    can_stop: task.can_stop,
    stop_request: stopRequest,
    stop_reason: stopReason as BackgroundTaskStopReason | null,
    started_at: task.started_at,
    ended_at: nullableTimestamp(task.ended_at),
    duration_ms: nullableCount(task.duration_ms),
    summary: truncateUtf8(summary, TRACE_ITEM_SUMMARY_MAX_BYTES),
    output_tail: capOutputTail(nullableText(task.output_tail)).value,
    ...(task.output_unreadable === true ? { output_unreadable: true } : {}),
    usage: usage === null ? null : { total_tokens: usage.total_tokens, tool_uses: usage.tool_uses, duration_ms: usage.duration_ms },
  };
}

/** `lane.background_tasks`, shape-checked and capped; throws {@link Malformed} on anything else. */
export function parseLaneBackgroundTasks(p: Record<string, unknown>, runtimeId: string): DaemonLaneBackgroundTasksPayload {
  if (Buffer.byteLength(JSON.stringify(p)) > DAEMON_LANE_BACKGROUND_MAX_BYTES) malformed();
  if (p.runtime_id !== undefined && p.runtime_id !== runtimeId) malformed("authority_revoked");
  if (!Number.isSafeInteger(p.revision) || (p.revision as number) < 0) malformed();
  if (!BACKGROUND_LANE_STATES.includes(p.state as BackgroundLaneState)) malformed();
  if (!Array.isArray(p.tasks) || p.tasks.length > DAEMON_LANE_BACKGROUND_MAX_TASKS) malformed();
  const tasks = p.tasks.map(laneTask);
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length) malformed();
  return {
    runtime_id: runtimeId,
    session_id: id(p.session_id),
    agent_id: id(p.agent_id),
    execution_scope: text(p.execution_scope),
    provider_session_id: id(p.provider_session_id),
    revision: p.revision as number,
    state: p.state as BackgroundLaneState,
    attempt_id: p.attempt_id === undefined || p.attempt_id === null ? null : id(p.attempt_id),
    parked_until: nullableTimestamp(p.parked_until),
    tasks,
  };
}

/** `lane.background_wake`, shape-checked; throws {@link Malformed} on anything else. */
export function parseLaneBackgroundWake(p: Record<string, unknown>): DaemonLaneBackgroundWakePayload {
  const task = p.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) malformed();
  const t = task as Record<string, unknown>;
  if (t.status !== "completed" && t.status !== "failed") malformed();
  return {
    session_id: id(p.session_id),
    agent_id: id(p.agent_id),
    execution_scope: text(p.execution_scope),
    provider_session_id: id(p.provider_session_id),
    task: {
      task_id: id(t.task_id),
      name: capLabel(text(t.name)),
      task_type: capLabel(text(t.task_type)),
      status: t.status,
      origin_attempt_id: id(t.origin_attempt_id),
      summary: truncateUtf8(nullableText(t.summary), TRACE_ITEM_SUMMARY_MAX_BYTES),
      duration_ms: nullableCount(t.duration_ms),
    },
  };
}

const refused = (code: string, message?: string) => ({ ok: false, code, retryable: false, ...(message ? { message } : {}) });

/**
 * Register both frames. `kick` re-runs one runtime's downlinks: a snapshot
 * that parks a lane can derive its release, and a doorbell can add turn input.
 */
export function registerBackgroundTaskHandlers(layer: DaemonProtocolLayer, store: MultiremiStore,
  kick: (runtimeId: string) => void): void {
  layer.registerBestEffortHandler("lane.background_tasks", (frame: DaemonParsedFrame, session: DaemonProtocolSession) => {
    // An older server ignores the frame; so does a socket without the cap.
    if (!session.supportsLaneBackground) return null;
    try {
      const runtimeId = frame.rt ?? (typeof frame.payload.runtime_id === "string" ? frame.payload.runtime_id : "");
      try { authorizeReportRuntime(store, session, runtimeId); }
      catch { malformed("authority_revoked"); }
      const payload = parseLaneBackgroundTasks(frame.payload, runtimeId);
      const workspaceId = store.getRuntimeLite(runtimeId)!.workspaceId ?? "local";
      if (store.upsertLaneBackgroundSnapshot(runtimeId, workspaceId, payload) > 0) kick(runtimeId);
      return { ok: true };
    } catch (error) {
      if (error instanceof Malformed) return refused(error.code);
      if (error instanceof BackgroundTaskError) return refused(error.code === "invalid_report" ? "invalid_report" : "authority_revoked");
      throw error;
    }
  });

  layer.registerRpcHandler("lane.background_wake", async (frame: DaemonParsedFrame, session: DaemonProtocolSession) => {
    if (!session.supportsLaneBackground) return refused("invalid_report", "lane.background was not negotiated");
    if (!frame.rt || !session.runtimeIds.includes(frame.rt)) return refused("authority_revoked");
    const runtime = await layer.authorizeRuntimeForTest({ accessToken: session.ownerAccessToken,
      masterToken: session.ownerAccessToken === null }, session.daemonId, frame.rt);
    if (!runtime.ok) return refused("authority_revoked");
    try {
      authorizeReportRuntime(store, session, frame.rt);
    } catch {
      return refused("authority_revoked");
    }
    let payload: DaemonLaneBackgroundWakePayload;
    try { payload = parseLaneBackgroundWake(frame.payload); }
    catch (error) {
      if (error instanceof Malformed) return refused(error.code);
      throw error;
    }
    try {
      const reply = store.laneBackgroundWake(frame.rt, store.getRuntimeLite(frame.rt)!.workspaceId ?? "local", payload);
      kick(frame.rt);
      return reply;
    } catch (error) {
      if (error instanceof BackgroundTaskError) return refused(error.code, error.message);
      throw error;
    }
  });
}
