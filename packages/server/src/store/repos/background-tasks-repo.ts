/**
 * PR 6 (keep-alive on demand, spec §2.5–§2.7, §5–§7): the session-level
 * background-task registry, `multiremi_background_tasks`.
 *
 * A Chat lane's bridge process may outlive its attempt while background tasks
 * run ("parked"). The daemon reports each lane's whole task list in
 * best-effort `lane.background_tasks` snapshots; this repo keeps them, and is
 * the source of the session's 后台任务 view, the running strip and the sidebar
 * count. A trace keeps only its own attempt's part.
 *
 * - Snapshots are revision-guarded per row: a row keeps the revision of the
 *   snapshot that last wrote it and an older one never overwrites it. A
 *   `closed` snapshot ends any row it still holds running as `stopped` /
 *   `lost`.
 * - `hello` reconciles: a running row of the runtime that neither a parked
 *   lane nor an active attempt still owns is `stopped` / `daemon_restart`.
 * - A runtime offline for 10 minutes turns its running rows `unknown`.
 * - A person's stop is stored on the row; the daemon learns it from the
 *   DB-derived `lane.background_stop` downlink. A dead lane (session closed,
 *   lineage reset) derives `lane.background_release`.
 * - The doorbell (`lane.background_wake`) writes a platform `status` message
 *   to the agent and lets the lane machine create, merge or steer a turn.
 * - Every visible change tells the Chat's creator `chat:background_tasks`.
 */
import {
  type BackgroundLaneReleaseReason,
  type BackgroundLaneState,
  type BackgroundTaskDoorbellMetadata,
  type BackgroundTaskStatus,
  type BackgroundTaskStopOutcome,
  type BackgroundTaskStopReason,
  type MultiremiBackgroundTask,
} from "@multiremi/contracts/unified-model.js";
import type {
  DaemonLaneBackgroundReleasePayload,
  DaemonLaneBackgroundStopPayload,
  DaemonLaneBackgroundTask,
  DaemonLaneBackgroundTasksPayload,
  DaemonLaneBackgroundWakePayload,
  DaemonLaneBackgroundWakeReply,
  DaemonLaneRef,
  DaemonParkedLane,
} from "@multiremi/contracts/daemon-protocol.js";
import type { TraceBackgroundTaskUsage } from "@multiremi/contracts/trace.js";
import { backgroundDoorbellBody, backgroundDoorbellDedupeKey } from "@shared/background-tasks.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { createCommitEventQueue, type StoreContext } from "../context.js";
import { afterCommit } from "../db/postgres.js";
import { parseJson, toJson } from "../helpers.js";
import { lockLane } from "../inbox/lane-machine.js";
import { getMessage, sendMessageWithinTransaction } from "../inbox/send-message.js";

type Row = Record<string, any>;

/** Ended rows are kept this long (spec §7). */
export const BACKGROUND_TASK_ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** And at most this many per session, newest first. */
export const BACKGROUND_TASK_ENDED_PER_SESSION = 50;
/** `GET /api/chat/sessions/:id/background-tasks` lists the live rows and this many ended ones. */
export const BACKGROUND_TASK_ENDED_LISTED = 20;
/** A runtime without a heartbeat for this long turns its running rows `unknown` (spec §2.7). */
export const BACKGROUND_TASK_OFFLINE_UNKNOWN_MS = 10 * 60 * 1000;
/** The realtime event the Chat's creator hears on every visible change. */
export const CHAT_BACKGROUND_TASKS_EVENT = "chat:background_tasks";

/** Rows with a process behind them. */
const LIVE_SQL = "status IN ('running','paused')";
/** Rows the server does not know to have ended: live, or `unknown` while the runtime is away. */
const ALIVE_SQL = "status IN ('running','paused','unknown')";
const ENDED_SQL = "status IN ('completed','failed','stopped')";
const LANE_SQL = "session_id = ? AND agent_id = ? AND execution_scope = ?";

export type BackgroundTaskErrorCode =
  | "task_not_running"
  | "runtime_offline"
  | "lane_moved"
  | "session_closed"
  | "authority_revoked"
  | "invalid_report";

/** A deterministic refusal; the API and the protocol map the code, never the message. */
export class BackgroundTaskError extends Error {
  constructor(readonly code: BackgroundTaskErrorCode, message: string = code) { super(message); }
}

/** `chat:background_tasks` and the session read: the rows plus the live count. */
export interface SessionBackgroundTasks {
  session_id: string;
  /** Rows running or paused. */
  running: number;
  rows: MultiremiBackgroundTask[];
}

export interface BackgroundTaskStopTarget {
  /** One task: the row's bridge `task_id`, or its registry `id`. */
  taskId?: string;
  /** Every running task of the session. */
  all?: boolean;
}

export interface BackgroundTaskStopResult {
  requested_at: string;
  rows: MultiremiBackgroundTask[];
}

export interface BackgroundTaskDownlinks {
  stops: DaemonLaneBackgroundStopPayload[];
  releases: DaemonLaneBackgroundReleasePayload[];
}

function isLive(status: string): boolean { return status === "running" || status === "paused"; }
function isAlive(status: string): boolean { return isLive(status) || status === "unknown"; }
function isEnded(status: string): boolean { return status === "completed" || status === "failed" || status === "stopped"; }

/**
 * A stop still waiting for the daemon when the task ended without answering it
 * (it finished first, its process died, the daemon restarted): the request is
 * moot, so it reads `not_running` rather than 「正在停止…」 forever (spec §6.2).
 */
function settledStopOutcome(outcome: BackgroundTaskStopOutcome | null): BackgroundTaskStopOutcome | null {
  return outcome === "pending" ? "not_running" : outcome;
}

function elapsedMs(startedAt: string, endedAt: string): number | null {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function toBackgroundTask(row: Row): MultiremiBackgroundTask {
  const text = (value: unknown): string | null => value == null ? null : String(value);
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    session_id: String(row.session_id),
    agent_id: String(row.agent_id),
    execution_scope: String(row.execution_scope ?? ""),
    runtime_id: String(row.runtime_id),
    provider_session_id: String(row.provider_session_id),
    task_id: String(row.task_id),
    task_type: String(row.task_type),
    name: String(row.name ?? ""),
    command: text(row.command),
    origin_attempt_id: String(row.origin_attempt_id),
    origin_turn_id: text(row.origin_turn_id),
    origin_item_id: text(row.origin_item_id),
    status: String(row.status) as BackgroundTaskStatus,
    stop_reason: text(row.stop_reason) as BackgroundTaskStopReason | null,
    can_stop: Number(row.can_stop) === 1,
    stop_requested_at: text(row.stop_requested_at),
    stop_requested_by: text(row.stop_requested_by),
    stop_outcome: text(row.stop_outcome) as BackgroundTaskStopOutcome | null,
    started_at: String(row.started_at),
    ended_at: text(row.ended_at),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    summary: text(row.summary),
    output_tail: text(row.output_tail),
    output_unreadable: Number(row.output_unreadable) === 1,
    usage: parseJson<TraceBackgroundTaskUsage | null>(row.usage, null),
    lane_state: String(row.lane_state) as BackgroundLaneState,
    parked_until: text(row.parked_until),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** The columns a snapshot writes, in a comparable shape (the `usage` JSON as stored). */
type RowValues = {
  task_type: string; name: string; command: string | null; origin_item_id: string | null;
  status: BackgroundTaskStatus; stop_reason: BackgroundTaskStopReason | null; can_stop: number;
  stop_requested_at: string | null; stop_requested_by: string | null; stop_outcome: BackgroundTaskStopOutcome | null;
  started_at: string; ended_at: string | null; duration_ms: number | null; summary: string | null;
  output_tail: string | null; output_unreadable: number; usage: string | null; lane_state: BackgroundLaneState;
  parked_until: string | null;
};
const VALUE_COLUMNS: (keyof RowValues)[] = ["task_type", "name", "command", "origin_item_id", "status", "stop_reason",
  "can_stop", "stop_requested_at", "stop_requested_by", "stop_outcome", "started_at", "ended_at", "duration_ms",
  "summary", "output_tail", "output_unreadable", "usage", "lane_state", "parked_until"];

function storedValue(row: Row, column: keyof RowValues): unknown {
  const value = row[column];
  if (value == null) return null;
  return column === "can_stop" || column === "duration_ms" || column === "output_unreadable" ? Number(value) : String(value);
}

function sameValues(row: Row, values: RowValues): boolean {
  return VALUE_COLUMNS.every((column) => storedValue(row, column) === (values[column] ?? null));
}

export class BackgroundTasksRepo {
  constructor(private ctx: StoreContext) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The session's live and `unknown` rows, then its latest ended ones (spec §7: the last 20). */
  listSessionBackgroundTasks(sessionId: string): SessionBackgroundTasks {
    const alive = this.ctx.db.query(`SELECT * FROM multiremi_background_tasks WHERE session_id = ? AND ${ALIVE_SQL}
      ORDER BY started_at DESC, id DESC`).all(sessionId) as Row[];
    const ended = this.ctx.db.query(`SELECT * FROM multiremi_background_tasks WHERE session_id = ? AND ${ENDED_SQL}
      ORDER BY COALESCE(ended_at, updated_at) DESC, id DESC LIMIT ?`).all(sessionId, BACKGROUND_TASK_ENDED_LISTED) as Row[];
    const rows = [...alive, ...ended].map(toBackgroundTask);
    return { session_id: sessionId, running: rows.filter((row) => isLive(row.status)).length, rows };
  }

  /** Running or paused rows per session, for the session list's `running_background_tasks`. */
  countRunningBySession(sessionIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    const ids = [...new Set(sessionIds)];
    for (let index = 0; index < ids.length; index += 500) {
      const page = ids.slice(index, index + 500);
      const rows = this.ctx.db.query(`SELECT session_id, CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_background_tasks
        WHERE session_id IN (${page.map(() => "?").join(",")}) AND ${LIVE_SQL} GROUP BY session_id`).all(...page) as Row[];
      for (const row of rows) counts.set(String(row.session_id), Number(row.n));
    }
    return counts;
  }

  /** Runtimes holding rows of this session the server does not know to have ended. */
  runtimesWithAliveTasks(sessionId: string): string[] {
    return (this.ctx.db.query(`SELECT DISTINCT runtime_id FROM multiremi_background_tasks
      WHERE session_id = ? AND ${ALIVE_SQL}`).all(sessionId) as Row[]).map((row) => String(row.runtime_id));
  }

  // ── Daemon snapshots ──────────────────────────────────────────────────────

  /**
   * `lane.background_tasks`. The caller validated the frame's shape and the
   * runtime's authority; here every new task must name an origin attempt of
   * this lane that ran on this runtime, in its workspace. A row another
   * runtime wrote is never touched. Returns how many rows changed visibly.
   */
  upsertLaneSnapshot(runtimeId: string, workspaceId: string, payload: DaemonLaneBackgroundTasksPayload): number {
    const lane = [payload.session_id, payload.agent_id, payload.execution_scope] as const;
    const changed: Row[] = [];
    this.ctx.db.transaction(() => {
      const now = nowIso();
      const closed = payload.state === "closed";
      const parkedUntil = payload.state === "parked" ? payload.parked_until ?? null : null;
      const origins = new Map<string, string>();
      const origin = (attemptId: string): string => {
        if (!origins.has(attemptId)) {
          const attempt = this.laneAttempt(attemptId, payload, runtimeId, workspaceId);
          if (!attempt) throw new BackgroundTaskError("authority_revoked", "origin attempt is not this lane's on this runtime");
          origins.set(attemptId, attempt.turnId);
        }
        return origins.get(attemptId)!;
      };
      if (payload.attempt_id) origin(payload.attempt_id);
      const listed = new Set<string>();
      for (const task of payload.tasks) {
        listed.add(task.task_id);
        const existing = this.ctx.db.query(`SELECT * FROM multiremi_background_tasks WHERE ${LANE_SQL}
          AND provider_session_id = ? AND task_id = ?`).get(...lane, payload.provider_session_id, task.task_id) as Row | null;
        if (existing && String(existing.runtime_id) !== runtimeId) continue;
        if (existing && Number(existing.revision) >= payload.revision) continue;
        const originTurnId = origin(task.origin_attempt_id);
        const values = this.snapshotValues(task, existing, { closed, state: payload.state, parkedUntil, now });
        if (!existing) {
          const id = createId("bgt");
          const columns = ["id", "workspace_id", "session_id", "agent_id", "execution_scope", "runtime_id",
            "provider_session_id", "task_id", "origin_attempt_id", "origin_turn_id", ...VALUE_COLUMNS, "revision",
            "created_at", "updated_at"];
          this.ctx.db.run(`INSERT INTO multiremi_background_tasks (${columns.join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})`,
          [id, workspaceId, ...lane, runtimeId, payload.provider_session_id, task.task_id, task.origin_attempt_id, originTurnId,
            ...VALUE_COLUMNS.map((column) => values[column] ?? null), payload.revision, now, now]);
          changed.push(this.readRow(id));
        } else if (!sameValues(existing, values)) {
          this.writeRow(String(existing.id), values, payload.revision, now);
          changed.push(this.readRow(String(existing.id)));
        } else {
          this.ctx.db.run("UPDATE multiremi_background_tasks SET revision = ? WHERE id = ?", [payload.revision, existing.id]);
        }
      }
      // The lane's fields repeat on its rows; a `closed` lane ends the rows it no longer lists.
      const others = this.ctx.db.query(`SELECT * FROM multiremi_background_tasks WHERE ${LANE_SQL}
        AND provider_session_id = ? AND runtime_id = ? AND revision < ?`)
        .all(...lane, payload.provider_session_id, runtimeId, payload.revision) as Row[];
      for (const row of others) {
        if (listed.has(String(row.task_id)) || !isAlive(String(row.status))) continue;
        const current = toBackgroundTask(row);
        const values: RowValues = { ...this.currentValues(row), lane_state: payload.state, parked_until: parkedUntil };
        if (closed) {
          Object.assign(values, { status: "stopped", stop_reason: current.stop_reason ?? "lost", ended_at: now,
            duration_ms: elapsedMs(current.started_at, now), parked_until: null,
            stop_outcome: settledStopOutcome(current.stop_outcome) });
        }
        if (sameValues(row, values)) continue;
        this.writeRow(current.id, values, Number(row.revision), now);
        changed.push(this.readRow(current.id));
      }
      if (changed.length) this.trimEnded(payload.session_id);
    })();
    this.publish(changed);
    return changed.length;
  }

  /**
   * `hello`: every row of this runtime the server does not know to have ended
   * is kept when an active attempt of its lane is on the daemon, or its lane is
   * parked with the task listed; the rest is stopped as `daemon_restart`. A
   * kept `unknown` row is live again. A daemon without the cap sends no parked
   * lanes, so only active attempts keep rows.
   */
  reconcileParkedLanes(runtimeId: string, parkedLanes: readonly DaemonParkedLane[], activeTaskIds: readonly string[]): number {
    const changed: Row[] = [];
    this.ctx.db.transaction(() => {
      const rows = this.ctx.db.query(`SELECT * FROM multiremi_background_tasks WHERE runtime_id = ? AND ${ALIVE_SQL}`)
        .all(runtimeId) as Row[];
      if (!rows.length) return;
      const laneKey = (lane: DaemonLaneRef) => JSON.stringify([lane.session_id, lane.agent_id, lane.execution_scope ?? ""]);
      const active = new Set<string>();
      for (const id of new Set(activeTaskIds)) {
        const turn = this.ctx.db.query(`SELECT t.session_id, t.agent_id, t.execution_scope FROM multiremi_turn_attempts a
          JOIN multiremi_turns t ON t.id = a.turn_id WHERE a.id = ?`).get(id) as DaemonLaneRef | null;
        if (turn) active.add(laneKey(turn));
      }
      const parked = new Map<string, Set<string>>();
      for (const lane of parkedLanes) {
        const key = JSON.stringify([lane.session_id, lane.agent_id, lane.execution_scope, lane.provider_session_id]);
        const ids = parked.get(key) ?? new Set<string>();
        for (const id of lane.task_ids) ids.add(id);
        parked.set(key, ids);
      }
      const now = nowIso();
      for (const row of rows) {
        const current = toBackgroundTask(row);
        const values = this.currentValues(row);
        const parkedTasks = parked.get(JSON.stringify([current.session_id, current.agent_id, current.execution_scope,
          current.provider_session_id]));
        let revision = Number(row.revision);
        if (active.has(laneKey(current)) || parkedTasks?.has(current.task_id)) {
          if (current.status !== "unknown") continue;
          values.status = "running";
          if (parkedTasks?.has(current.task_id)) values.lane_state = "parked";
        } else {
          Object.assign(values, { status: "stopped", stop_reason: "daemon_restart", ended_at: now,
            duration_ms: elapsedMs(current.started_at, now), lane_state: "closed", parked_until: null,
            stop_outcome: settledStopOutcome(current.stop_outcome) });
          // A restarted daemon counts its revisions from scratch, and may reuse a task id.
          revision = 0;
        }
        this.writeRow(current.id, values, revision, now);
        changed.push(this.readRow(current.id));
      }
    })();
    this.publish(changed);
    return changed.length;
  }

  /**
   * The maintenance sweep: running rows of a runtime without a heartbeat for
   * {@link BACKGROUND_TASK_OFFLINE_UNKNOWN_MS} become `unknown` (a later
   * `hello` settles them), and ended rows past the retention are deleted.
   */
  sweep(now: number = Date.now()): { unknown: number; deleted: number } {
    const changed: Row[] = [];
    let deleted = 0;
    this.ctx.db.transaction(() => {
      const cutoff = new Date(now - BACKGROUND_TASK_OFFLINE_UNKNOWN_MS).toISOString();
      const rows = this.ctx.db.query(`SELECT b.* FROM multiremi_background_tasks b
        LEFT JOIN multiremi_runtimes r ON r.id = b.runtime_id
        WHERE b.status IN ('running','paused') AND (r.id IS NULL OR r.last_heartbeat_at IS NULL OR r.last_heartbeat_at < ?)`)
        .all(cutoff) as Row[];
      const at = new Date(now).toISOString();
      for (const row of rows) {
        this.writeRow(String(row.id), { ...this.currentValues(row), status: "unknown" }, Number(row.revision), at);
        changed.push(this.readRow(String(row.id)));
      }
      deleted = this.ctx.db.run(`DELETE FROM multiremi_background_tasks WHERE ${ENDED_SQL}
        AND COALESCE(ended_at, updated_at) < ?`, [new Date(now - BACKGROUND_TASK_ENDED_RETENTION_MS).toISOString()]).changes;
    })();
    this.publish(changed);
    return { unknown: changed.length, deleted };
  }

  // ── Stop (spec §6) ────────────────────────────────────────────────────────

  /**
   * A person's stop: one running task, or every running task of the session.
   * The rows take the request and its pending outcome, the runtimes' downlinks
   * are woken, and the daemon answers through its next snapshot. Refuses
   * `task_not_running` when no matching row runs (or none can be stopped),
   * `runtime_offline` when every matching row's runtime is offline.
   */
  requestStop(sessionId: string, target: BackgroundTaskStopTarget, memberId: string | null): BackgroundTaskStopResult {
    const changed: Row[] = [];
    const requestedAt = nowIso();
    const runtimes = new Map<string, string>();
    this.ctx.db.transaction(() => {
      const filter = target.all ? "" : " AND (task_id = ? OR id = ?)";
      const rows = (this.ctx.db.query(`SELECT * FROM multiremi_background_tasks WHERE session_id = ? AND ${LIVE_SQL}
        AND lane_state <> 'closed'${filter} ORDER BY started_at, task_id, id`)
        .all(sessionId, ...(target.all ? [] : [target.taskId ?? "", target.taskId ?? ""])) as Row[])
        .filter((row) => Number(row.can_stop) === 1);
      if (!rows.length) throw new BackgroundTaskError("task_not_running", "no running background task matches");
      const online = rows.filter((row) => this.ctx.runtimes().getRuntimeLite(String(row.runtime_id))?.status === "online");
      if (!online.length) throw new BackgroundTaskError("runtime_offline", "the computer running this session is offline");
      for (const row of online) {
        this.ctx.db.run(`UPDATE multiremi_background_tasks SET stop_requested_at = ?, stop_requested_by = ?,
          stop_outcome = 'pending', updated_at = ? WHERE id = ?`, [requestedAt, memberId, requestedAt, row.id]);
        runtimes.set(String(row.runtime_id), String(row.workspace_id));
        changed.push(this.readRow(String(row.id)));
      }
      // The stop is stored state: the downlink derives it, as a wrap-up does.
      for (const [runtimeId, workspaceId] of runtimes) {
        afterCommit(this.ctx.db, () => this.ctx.emitWorkspaceEvent({ type: "daemon:task_input", workspaceId,
          actorType: "system", actorId: null, payload: { runtime_id: runtimeId } }));
      }
    })();
    this.publish(changed);
    return { requested_at: requestedAt, rows: changed.map(toBackgroundTask) };
  }

  // ── Downlinks (spec §5.3, §6.1) ───────────────────────────────────────────

  /**
   * The stop and release entities of one runtime, recomputed from the DB on
   * every downlink run. A stop is a person's request the daemon has not yet
   * answered; a release is a parked lane whose session closed or whose lineage
   * moved (see {@link laneReleaseReason}).
   */
  downlinkEntities(runtimeId: string): BackgroundTaskDownlinks {
    const stops = (this.ctx.db.query(`SELECT session_id, agent_id, execution_scope, task_id, stop_requested_at
      FROM multiremi_background_tasks WHERE runtime_id = ? AND ${LIVE_SQL} AND lane_state <> 'closed'
        AND stop_requested_by IS NOT NULL AND stop_requested_at IS NOT NULL
        AND (stop_outcome IS NULL OR stop_outcome = 'pending')
      ORDER BY stop_requested_at, session_id, agent_id, execution_scope, task_id`).all(runtimeId) as Row[]).map((row): DaemonLaneBackgroundStopPayload => ({
      session_id: String(row.session_id), agent_id: String(row.agent_id), execution_scope: String(row.execution_scope ?? ""),
      task_id: String(row.task_id), requested_at: String(row.stop_requested_at),
    }));
    const lanes = this.ctx.db.query(`SELECT DISTINCT session_id, agent_id, execution_scope, provider_session_id
      FROM multiremi_background_tasks WHERE runtime_id = ? AND ${ALIVE_SQL} AND lane_state = 'parked'
      ORDER BY session_id, agent_id, execution_scope, provider_session_id`).all(runtimeId) as Row[];
    const releases: DaemonLaneBackgroundReleasePayload[] = [];
    for (const row of lanes) {
      const lane: DaemonLaneRef = { session_id: String(row.session_id), agent_id: String(row.agent_id),
        execution_scope: String(row.execution_scope ?? "") };
      const reason = this.laneReleaseReason(lane, runtimeId, String(row.provider_session_id));
      if (reason) releases.push({ ...lane, provider_session_id: String(row.provider_session_id), reason });
    }
    return { stops, releases };
  }

  /**
   * Why a lane's parked process on `runtimeId` with `providerSessionId` can no
   * longer serve the lane, or null while it can:
   * - `session_closed`: the Chat was deleted or archived, it belongs to another
   *   agent, or the agent is gone or archived;
   * - `lane_reset`: the Chat's lineage names another provider session or
   *   runtime, or the lane's latest attempt runs on another runtime, holds
   *   another provider session, or is a cold replacement (a reset or cold
   *   retry: a later attempt with no session and no carried trigger, the same
   *   test the turn input uses).
   *
   * Only positive evidence counts. A lane without a lineage yet (its first
   * turn was cancelled) is left to the daemon's adopt check at the next offer,
   * and so is a config change, which the daemon reports as `config_changed`.
   */
  laneReleaseReason(lane: DaemonLaneRef, runtimeId: string, providerSessionId: string): BackgroundLaneReleaseReason | null {
    const chat = this.ctx.db.query(`SELECT agent_id, status, session_id, session_runtime_id FROM multiremi_chat_sessions
      WHERE id = ?`).get(lane.session_id) as Row | null;
    if (!chat || chat.status === "archived" || String(chat.agent_id) !== lane.agent_id) return "session_closed";
    const agent = this.ctx.db.query("SELECT archived_at FROM multiremi_agents WHERE id = ?").get(lane.agent_id) as Row | null;
    if (!agent || agent.archived_at) return "session_closed";
    if ((chat.session_id && chat.session_id !== providerSessionId)
      || (chat.session_runtime_id && chat.session_runtime_id !== runtimeId)) return "lane_reset";
    const latest = this.ctx.db.query(`SELECT a.runtime_id, a.session_id, a.attempt_no, a.input_trigger_ack
      FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id = a.turn_id
      WHERE t.session_id = ? AND t.agent_id = ? AND t.execution_scope = ?
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1`).get(lane.session_id, lane.agent_id, lane.execution_scope) as Row | null;
    if (latest) {
      if (latest.runtime_id && latest.runtime_id !== runtimeId) return "lane_reset";
      if (latest.session_id && latest.session_id !== providerSessionId) return "lane_reset";
      if (Number(latest.attempt_no) > 1 && !latest.session_id && !Number(latest.input_trigger_ack)) return "lane_reset";
    }
    return null;
  }

  // ── The doorbell (spec §2.5) ──────────────────────────────────────────────

  /**
   * `lane.background_wake`, in one transaction under the workspace, Chat and
   * lane locks, in that order (the order the message write takes them):
   * validate the lane, write the platform `status` doorbell to the agent (wake
   * `now`, deduplicated per task) and let the lane machine create, merge or
   * steer a turn. A created turn whose origin attempt had a Feishu card posts
   * proactively in the origin thread. A repeated call answers the first
   * outcome, stored on the doorbell. Refusals: `session_closed`, `lane_moved`,
   * `authority_revoked`.
   */
  laneBackgroundWake(runtimeId: string, workspaceId: string, payload: DaemonLaneBackgroundWakePayload): DaemonLaneBackgroundWakeReply {
    const events = createCommitEventQueue();
    const reply = this.ctx.db.transaction((): DaemonLaneBackgroundWakeReply => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const chat = this.ctx.db.query("SELECT workspace_id FROM multiremi_chat_sessions WHERE id = ?").get(payload.session_id) as Row | null;
      if (!chat) throw new BackgroundTaskError("session_closed", "the Chat no longer exists");
      if (String(chat.workspace_id) !== workspaceId) throw new BackgroundTaskError("authority_revoked", "the Chat belongs to another workspace");
      this.ctx.db.run("UPDATE multiremi_chat_sessions SET updated_at = updated_at WHERE id = ?", [payload.session_id]);
      lockLane(this.ctx, payload.session_id, payload.agent_id, payload.execution_scope);
      const dedupeKey = backgroundDoorbellDedupeKey(payload, payload.task.task_id);
      const duplicate = this.ctx.db.query("SELECT id FROM multiremi_conversation_log WHERE session_id = ? AND dedupe_key = ?")
        .get(payload.session_id, dedupeKey) as Row | null;
      if (duplicate) return this.storedWakeReply(String(duplicate.id));
      const reason = this.laneReleaseReason(payload, runtimeId, payload.provider_session_id);
      if (reason === "session_closed") throw new BackgroundTaskError("session_closed", "the Chat or its agent is closed");
      if (reason) throw new BackgroundTaskError("lane_moved", "the lane no longer runs this provider session here");
      const origin = this.laneAttempt(payload.task.origin_attempt_id, payload, runtimeId, workspaceId);
      if (!origin) throw new BackgroundTaskError("authority_revoked", "origin attempt is not this lane's on this runtime");
      const active = this.ctx.db.query(`SELECT id, status, current_attempt_id FROM multiremi_turns WHERE ${LANE_SQL}
        AND status IN ('pending','running','awaiting_human')`).all(payload.session_id, payload.agent_id, payload.execution_scope) as Row[];
      const pending = active.find((turn) => turn.status === "pending");
      const pendingOffered = pending
        ? !!(this.ctx.db.query("SELECT offered_at FROM multiremi_turn_attempts WHERE id = ?").get(pending.current_attempt_id) as Row | null)?.offered_at
        : false;
      const doorbell: BackgroundTaskDoorbellMetadata = {
        task_id: payload.task.task_id, name: payload.task.name, task_type: payload.task.task_type,
        status: payload.task.status, origin_attempt_id: payload.task.origin_attempt_id,
        origin_turn_id: origin.turnId, provider_session_id: payload.provider_session_id,
      };
      const sent = sendMessageWithinTransaction(this.ctx, {
        session_id: payload.session_id, sender: { type: "platform", id: null },
        to: { type: "agent", ref: payload.agent_id }, message_kind: "status", wake_requested: "now",
        body_md: backgroundDoorbellBody({ name: payload.task.name, status: payload.task.status,
          duration_ms: payload.task.duration_ms, summary: payload.task.summary }),
        dedupe_key: dedupeKey, execution_scope: payload.execution_scope, metadata: { background_task: doorbell },
      }, events);
      // The wake policy refused (the agent is unavailable): nothing will answer it.
      if (!sent.turn_id) throw new BackgroundTaskError("session_closed", "the agent cannot be woken");
      const turn = this.ctx.db.query("SELECT id, current_attempt_id FROM multiremi_turns WHERE id = ?").get(sent.turn_id) as Row;
      const outcome: DaemonLaneBackgroundWakeReply["outcome"] = !active.length ? "created"
        : pending && pending.id === turn.id && !pendingOffered ? "merged" : "delivered";
      const result: DaemonLaneBackgroundWakeReply = { ok: true, outcome, turn_id: String(turn.id),
        attempt_id: turn.current_attempt_id == null ? null : String(turn.current_attempt_id) };
      const message = getMessage(this.ctx, sent.message.id)!;
      this.ctx.conversationLog().updateConversationLogWithinTransaction(payload.session_id, message.seq, { deferEmit: true,
        fields: { metadata: { ...message.metadata, background_wake: { outcome, turn_id: result.turn_id, attempt_id: result.attempt_id } } } });
      if (outcome === "created" && result.attempt_id) {
        this.ctx.feishuBot().prepareFeishuBackgroundDoorbellDeliveryWithinTransaction(payload.task.origin_attempt_id,
          origin.turnId, result.attempt_id);
      }
      return result;
    })();
    afterCommit(this.ctx.db, () => this.ctx.emitCommitEvents(events));
    return reply;
  }

  private storedWakeReply(messageId: string): DaemonLaneBackgroundWakeReply {
    const message = getMessage(this.ctx, messageId)!;
    const stored = message.metadata.background_wake as Record<string, unknown> | undefined;
    if (stored && (stored.outcome === "created" || stored.outcome === "merged" || stored.outcome === "delivered")
      && typeof stored.turn_id === "string") {
      return { ok: true, outcome: stored.outcome, turn_id: stored.turn_id,
        attempt_id: typeof stored.attempt_id === "string" ? stored.attempt_id : null };
    }
    const delivery = typeof message.metadata.delivery_turn_id === "string" ? message.metadata.delivery_turn_id : null;
    const turn = this.ctx.db.query("SELECT id, current_attempt_id FROM multiremi_turns WHERE id = ? OR trigger_message_id = ?")
      .get(delivery, messageId) as Row | null;
    if (!turn) throw new BackgroundTaskError("session_closed", "the doorbell reached no turn");
    return { ok: true, outcome: "delivered", turn_id: String(turn.id),
      attempt_id: turn.current_attempt_id == null ? null : String(turn.current_attempt_id) };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The attempt, when it belongs to this lane, ran on this runtime and is in this workspace. */
  private laneAttempt(attemptId: string, lane: DaemonLaneRef, runtimeId: string, workspaceId: string): { turnId: string } | null {
    const row = this.ctx.db.query(`SELECT t.id AS turn_id, t.session_id, t.agent_id, t.execution_scope, t.workspace_id, a.runtime_id
      FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id = a.turn_id WHERE a.id = ?`).get(attemptId) as Row | null;
    if (!row || row.session_id !== lane.session_id || row.agent_id !== lane.agent_id
      || String(row.execution_scope ?? "") !== lane.execution_scope || row.workspace_id !== workspaceId
      || row.runtime_id !== runtimeId) return null;
    return { turnId: String(row.turn_id) };
  }

  private snapshotValues(task: DaemonLaneBackgroundTask, existing: Row | null,
    lane: { closed: boolean; state: BackgroundLaneState; parkedUntil: string | null; now: string }): RowValues {
    let status: BackgroundTaskStatus = task.status;
    let stopReason: BackgroundTaskStopReason | null = task.stop_reason ?? null;
    let endedAt = task.ended_at ?? null;
    let durationMs = task.duration_ms ?? null;
    if (lane.closed && isLive(status)) {
      status = "stopped";
      stopReason = stopReason ?? "lost";
    }
    if (isEnded(status)) {
      endedAt = endedAt ?? lane.now;
      durationMs = durationMs ?? elapsedMs(task.started_at, endedAt);
    }
    // A person's request stays on the row; the snapshot adds the daemon's
    // answer to it, or a later stop Remi made.
    let stopRequestedAt: string | null = existing?.stop_requested_at ?? null;
    let stopRequestedBy: string | null = existing?.stop_requested_by ?? null;
    let stopOutcome = (existing?.stop_outcome ?? null) as BackgroundTaskStopOutcome | null;
    const reported = task.stop_request;
    if (reported) {
      if (stopRequestedAt === reported.requested_at) stopOutcome = reported.outcome;
      else if (!stopRequestedAt || Date.parse(reported.requested_at) > Date.parse(stopRequestedAt)) {
        stopRequestedAt = reported.requested_at;
        stopRequestedBy = null;
        stopOutcome = reported.outcome;
      }
    }
    if (isEnded(status)) stopOutcome = settledStopOutcome(stopOutcome);
    return {
      task_type: task.task_type, name: task.name, command: task.command ?? null, origin_item_id: task.origin_item_id ?? null,
      status, stop_reason: stopReason, can_stop: task.can_stop ? 1 : 0,
      stop_requested_at: stopRequestedAt, stop_requested_by: stopRequestedBy, stop_outcome: stopOutcome,
      started_at: task.started_at, ended_at: endedAt, duration_ms: durationMs, summary: task.summary ?? null,
      output_tail: task.output_tail ?? null, output_unreadable: task.output_unreadable === true ? 1 : 0,
      usage: task.usage ? toJson(task.usage) : null,
      lane_state: lane.state, parked_until: isLive(status) ? lane.parkedUntil : null,
    };
  }

  private currentValues(row: Row): RowValues {
    return Object.fromEntries(VALUE_COLUMNS.map((column) => [column, storedValue(row, column)])) as RowValues;
  }

  private readRow(id: string): Row {
    return this.ctx.db.query("SELECT * FROM multiremi_background_tasks WHERE id = ?").get(id) as Row;
  }

  private writeRow(id: string, values: RowValues, revision: number, now: string): void {
    this.ctx.db.run(`UPDATE multiremi_background_tasks SET ${VALUE_COLUMNS.map((column) => `${column} = ?`).join(", ")},
      revision = ?, updated_at = ? WHERE id = ?`, [...VALUE_COLUMNS.map((column) => values[column] ?? null), revision, now, id]);
  }

  /** At most {@link BACKGROUND_TASK_ENDED_PER_SESSION} ended rows per session, newest kept. */
  private trimEnded(sessionId: string): void {
    const count = Number((this.ctx.db.query(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_background_tasks
      WHERE session_id = ? AND ${ENDED_SQL}`).get(sessionId) as Row).n);
    if (count <= BACKGROUND_TASK_ENDED_PER_SESSION) return;
    const keep = (this.ctx.db.query(`SELECT id FROM multiremi_background_tasks WHERE session_id = ? AND ${ENDED_SQL}
      ORDER BY COALESCE(ended_at, updated_at) DESC, id DESC LIMIT ?`)
      .all(sessionId, BACKGROUND_TASK_ENDED_PER_SESSION) as Row[]).map((row) => String(row.id));
    this.ctx.db.run(`DELETE FROM multiremi_background_tasks WHERE session_id = ? AND ${ENDED_SQL}
      AND id NOT IN (${keep.map(() => "?").join(",")})`, [sessionId, ...keep]);
  }

  /**
   * `chat:background_tasks` per session after COMMIT: the rows that changed
   * (merge them by `id`) and the session's live count, read when published.
   * Routed to the Chat's creator only, never to daemon delivery.
   */
  private publish(rows: readonly Row[]): void {
    const bySession = new Map<string, { workspaceId: string; rows: MultiremiBackgroundTask[] }>();
    for (const row of rows) {
      if (!row) continue;
      const task = toBackgroundTask(row);
      const entry = bySession.get(task.session_id) ?? { workspaceId: task.workspace_id, rows: [] };
      entry.rows.push(task);
      bySession.set(task.session_id, entry);
    }
    for (const [sessionId, entry] of bySession) {
      if (!sessionId.startsWith("chat_")) continue;
      afterCommit(this.ctx.db, () => {
        const running = this.countRunningBySession([sessionId]).get(sessionId) ?? 0;
        this.ctx.emitWorkspaceEvent({ type: CHAT_BACKGROUND_TASKS_EVENT, workspaceId: entry.workspaceId, chatSessionId: sessionId,
          actorType: "system", actorId: null,
          payload: { chat_session_id: sessionId, session_id: sessionId, running, rows: entry.rows } });
      });
    }
  }
}
