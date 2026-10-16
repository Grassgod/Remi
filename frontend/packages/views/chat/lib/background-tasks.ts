import type { TraceItem } from "@multiremi/contracts/trace";
import type { BackgroundTaskDoorbellMetadata, BackgroundTaskStopReason } from "@multiremi/contracts/unified-model";
import type { ChatBackgroundTask } from "@multiremi/core/types";
import { BACKGROUND_KEEPALIVE_MS, readBackgroundDoorbell } from "@multiremi/shared/background-tasks";
import {
  backgroundTaskResolver,
  backgroundTaskStatusPhase,
  type BackgroundTaskLaunch,
  type BackgroundTaskResolver,
} from "@multiremi/shared/trace-step-copy";

/**
 * A Chat's background tasks (PR 6 §8), for the 后台任务 view of the right
 * panel, the running strip, the end notices, the doorbell line and the launch
 * rows of the steps. Rows come from the session registry
 * (`GET /api/chat/sessions/:id/background-tasks`, `chat:background_tasks`),
 * never from a finished turn's trace (MUL-472). Pure.
 */

export type BackgroundTask = ChatBackgroundTask;

/** The type's muted label key under `chat:bg_tasks`, or null for a type with no label. */
export type BackgroundTaskTypeKey = "type_shell" | "type_workflow" | "type_monitor";

export function backgroundTaskTypeKey(taskType: string): BackgroundTaskTypeKey | null {
  switch (taskType) {
    case "shell": return "type_shell";
    case "workflow": return "type_workflow";
    case "monitor": return "type_monitor";
    default: return null;
  }
}

/** A process is still behind it. `unknown` (computer offline) is not counted as running. */
export function isLiveBackgroundTask(row: Pick<BackgroundTask, "status">): boolean {
  return row.status === "running" || row.status === "paused";
}

export function runningBackgroundTasks(rows: readonly BackgroundTask[]): BackgroundTask[] {
  return rows.filter(isLiveBackgroundTask);
}

const NAME_MAX = 60;

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split("\n").map((part) => part.trim()).find(Boolean);
  return line ?? null;
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** The row's label: its name (a shell's is the command title or the command), else the command's first line, at most 60 characters. */
export function backgroundTaskName(row: Pick<BackgroundTask, "name" | "command" | "task_id">): string {
  return cut(firstLine(row.name) ?? firstLine(row.command) ?? row.task_id, NAME_MAX);
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function backgroundTaskStartedAt(row: Pick<BackgroundTask, "started_at">): number | null {
  return parseTime(row.started_at);
}

/** How long an ended task ran: its reported duration, else end − start. */
export function backgroundTaskDurationMs(row: Pick<BackgroundTask, "duration_ms" | "started_at" | "ended_at">): number | null {
  if (row.duration_ms != null) return row.duration_ms;
  const start = parseTime(row.started_at);
  const end = parseTime(row.ended_at);
  return start !== null && end !== null ? Math.max(0, end - start) : null;
}

/**
 * The panel's two sections: 运行中 (running and paused, plus `unknown`: it
 * was last seen running) in start order, and 已结束 with the latest end first.
 */
export function splitBackgroundTasks(rows: readonly BackgroundTask[]): { running: BackgroundTask[]; done: BackgroundTask[] } {
  const running: BackgroundTask[] = [];
  const done: BackgroundTask[] = [];
  for (const row of rows) (isLiveBackgroundTask(row) || row.status === "unknown" ? running : done).push(row);
  const start = (row: BackgroundTask) => parseTime(row.started_at) ?? 0;
  const end = (row: BackgroundTask) => parseTime(row.ended_at) ?? parseTime(row.updated_at) ?? start(row);
  running.sort((a, b) => start(a) - start(b));
  done.sort((a, b) => end(b) - end(a));
  return { running, done };
}

// ── End reasons ─────────────────────────────────────────────────────────────

export type BackgroundStopReasonKey =
  | "stopped_user"
  | "stopped_turn_end"
  | "stopped_keepalive_cap"
  | "stopped_evicted"
  | "stopped_daemon_restart"
  | "stopped_lane_reset"
  | "stopped_session_closed"
  | "stopped_config_changed"
  | "lost";

const STOP_REASON_KEYS: Record<BackgroundTaskStopReason, BackgroundStopReasonKey> = {
  user: "stopped_user",
  turn_end: "stopped_turn_end",
  // A cancelled turn reads the same way: its attempt ended and took the task with it.
  cancelled: "stopped_turn_end",
  keepalive_cap: "stopped_keepalive_cap",
  evicted: "stopped_evicted",
  no_capacity: "stopped_evicted",
  daemon_restart: "stopped_daemon_restart",
  lane_reset: "stopped_lane_reset",
  session_closed: "stopped_session_closed",
  config_changed: "stopped_config_changed",
  lost: "lost",
};

/** Why a stopped task stopped, as a `chat:bg_tasks` key; null when the registry gave no reason. */
export function backgroundStopReasonKey(row: Pick<BackgroundTask, "status" | "stop_reason">): BackgroundStopReasonKey | null {
  if (row.status !== "stopped" || !row.stop_reason) return null;
  return STOP_REASON_KEYS[row.stop_reason] ?? null;
}

// ── Stop requests ───────────────────────────────────────────────────────────

/** After this long with no answer a stop reads 「停止请求已发送，等待电脑响应」 (§6.1). */
export const BACKGROUND_STOP_SENT_AFTER_MS = 15_000;

/**
 * Where a stop of this task stands: none asked; asked and waiting
 * (`stopping`, then `sent` after 15 s); or answered `not_running` (it had
 * ended) or `failed` (stop again). A task that ended reads none.
 */
export type BackgroundStopState = "none" | "stopping" | "sent" | "not_running" | "failed";

export function backgroundStopState(
  row: Pick<BackgroundTask, "status" | "stop_requested_at" | "stop_outcome">,
  now: number,
): BackgroundStopState {
  if (!isLiveBackgroundTask(row) || !row.stop_requested_at) return "none";
  if (row.stop_outcome === "failed") return "failed";
  if (row.stop_outcome === "not_running") return "not_running";
  const requested = parseTime(row.stop_requested_at);
  return requested !== null && now - requested >= BACKGROUND_STOP_SENT_AFTER_MS ? "sent" : "stopping";
}

/** ■ and 停止 are offered: the task runs, the bridge can stop it, and no stop is waiting for an answer. */
export function canStopBackgroundTask(row: BackgroundTask, now: number): boolean {
  if (!isLiveBackgroundTask(row) || !row.can_stop) return false;
  const state = backgroundStopState(row, now);
  return state === "none" || state === "failed";
}

/** What 「全部停止」 would stop. */
export function stoppableBackgroundTasks(rows: readonly BackgroundTask[], now: number): BackgroundTask[] {
  return rows.filter((row) => canStopBackgroundTask(row, now));
}

// ── Output ──────────────────────────────────────────────────────────────────

/** The detail shows the last 40 lines of the output tail. */
export const OUTPUT_LINES = 40;

export function backgroundOutputLines(tail: string | null | undefined, max = OUTPUT_LINES): string[] {
  if (!tail) return [];
  const lines = tail.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-max);
}

/** The last line with text, for a running row's second line. */
export function lastBackgroundOutputLine(tail: string | null | undefined): string | null {
  const lines = backgroundOutputLines(tail, Number.MAX_SAFE_INTEGER);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (line) return cut(line, 160);
  }
  return null;
}

// ── Keep-alive ──────────────────────────────────────────────────────────────

/** When the session's parked process stops at the latest: the latest `parked_until` of a running task. */
export function backgroundKeptUntil(rows: readonly BackgroundTask[]): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    if (!isLiveBackgroundTask(row)) continue;
    const until = parseTime(row.parked_until);
    if (until !== null && (latest === null || until > latest)) latest = until;
  }
  return latest;
}

/** A wall-clock time: 「14:05」 today, with the date on another day. */
export function formatBackgroundClock(ms: number, locale: string, now = Date.now()): string {
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  try {
    return new Intl.DateTimeFormat(locale, sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(sameDay ? 11 : 5, 16).replace("T", " ");
  }
}

/** The keep-alive cap (U1) in words: 「2小时」, "2 hours", 「30分钟」. */
export function formatKeepAliveCap(locale: string, ms: number = BACKGROUND_KEEPALIVE_MS): string {
  const hour = 3_600_000;
  const [value, unit] = ms % hour === 0 ? [ms / hour, "hour"] as const : [Math.max(1, Math.round(ms / 60_000)), "minute"] as const;
  try {
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
  } catch {
    return `${value}${unit === "hour" ? "h" : "m"}`;
  }
}

// ── End notices (§8.1 "Ends without a reply") ───────────────────────────────

/** An end notice stays this long after the task ended. */
export const ENDED_NOTICE_MS = 10 * 60_000;
/**
 * A parked task that completed or failed waits this long for its doorbell
 * (which then explains it, with a reply) before it gets a notice of its own.
 */
export const ENDED_NOTICE_GRACE_MS = 5_000;

/** Stops Remi made, which no reply explains. The person's own stops are not repeated. */
const NOTICE_REASONS: ReadonlySet<BackgroundTaskStopReason> = new Set([
  "keepalive_cap", "evicted", "no_capacity", "daemon_restart", "lane_reset", "session_closed", "config_changed", "lost",
]);

/**
 * Tasks that ended in the last 10 minutes with nothing in the conversation to
 * say so: stopped by Remi (the cap, eviction, a restart, a reset or closed
 * session, a config change, a lost process), or ended between turns without
 * a doorbell (Codex: no self-started reply). Latest first.
 */
export function backgroundEndedNotices(
  rows: readonly BackgroundTask[],
  options: { now: number; doorbells: ReadonlySet<string>; dismissed: ReadonlySet<string> },
): BackgroundTask[] {
  const notices: Array<{ row: BackgroundTask; ended: number }> = [];
  for (const row of rows) {
    if (options.dismissed.has(row.id)) continue;
    const ended = parseTime(row.ended_at);
    if (ended === null || options.now - ended > ENDED_NOTICE_MS) continue;
    if (row.status === "stopped") {
      if (row.stop_requested_by || !row.stop_reason || !NOTICE_REASONS.has(row.stop_reason)) continue;
    } else if (row.status === "completed" || row.status === "failed") {
      // An end inside an attempt shows in that turn; a doorbell brings its own line and reply.
      if (row.lane_state === "in_attempt" || options.doorbells.has(row.task_id) || options.now - ended < ENDED_NOTICE_GRACE_MS) continue;
    } else continue;
    notices.push({ row, ended });
  }
  return notices.sort((a, b) => b.ended - a.ended).map(({ row }) => row);
}

/** When the next notice change is due (one leaves its window or ends its grace), for a timer. */
export function nextNoticeChange(rows: readonly BackgroundTask[], now: number): number | null {
  let next: number | null = null;
  for (const row of rows) {
    const ended = parseTime(row.ended_at);
    if (ended === null) continue;
    for (const due of [ended + ENDED_NOTICE_GRACE_MS, ended + ENDED_NOTICE_MS + 1]) {
      if (due > now && (next === null || due < next)) next = due;
    }
  }
  return next;
}

// ── Doorbells ───────────────────────────────────────────────────────────────

type LogRow = { kind: string; sender_type?: string | null; metadata?: unknown };

/**
 * The doorbell a log row carries: a platform message (`sender_type`
 * "platform") with well-formed `metadata.background_task`. A person's own
 * message never reads as one, whatever its metadata says.
 */
export function rowDoorbell(row: LogRow): BackgroundTaskDoorbellMetadata | null {
  return row.kind === "message" && row.sender_type === "platform" ? readBackgroundDoorbell(row.metadata) : null;
}

/** The task ids a loaded conversation already rang the doorbell for. */
export function doorbellTaskIds(entries: ReadonlyArray<LogRow>): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const doorbell = rowDoorbell(entry);
    if (doorbell) ids.add(doorbell.task_id);
  }
  return ids;
}

/** The row a reference names: its task id, in that provider session when given; the latest start wins. */
export function findBackgroundTask(
  rows: readonly BackgroundTask[],
  ref: { task_id: string; provider_session_id?: string | null } | null | undefined,
): BackgroundTask | null {
  if (!ref) return null;
  let found: BackgroundTask | null = null;
  for (const row of rows) {
    if (row.task_id !== ref.task_id || (ref.provider_session_id && row.provider_session_id !== ref.provider_session_id)) continue;
    if (!found || (parseTime(row.started_at) ?? 0) > (parseTime(found.started_at) ?? 0)) found = row;
  }
  return found;
}

// ── Launch rows (§8.1 Steps) ────────────────────────────────────────────────

/**
 * A launch as the web reads it. `moved`: the trace says the task was handed
 * to the background when its attempt ended, but nothing confirms it still
 * runs, so the row says it moved to the background (「… 已转到后台运行」),
 * never that it is still running.
 */
export type WebBackgroundTaskLaunch = BackgroundTaskLaunch & { moved?: true };

/** Whether a launch only knows its task was handed off (see {@link WebBackgroundTaskLaunch}). */
export function isMovedLaunch(launch: BackgroundTaskLaunch | null | undefined): boolean {
  return !!launch && (launch as WebBackgroundTaskLaunch).moved === true;
}

/**
 * The launch rows of one attempt's steps: a call that started a background
 * task reads as that task (PR 6 §8.1).
 *
 * Only the session registry can say a task still runs: its row's status
 * decides the phase (`backgroundTaskStatusPhase`; running after the attempt
 * ended reads 「… 仍在后台运行」). Without a row for the task (the registry not
 * loaded, the chat counts none running, or the row aged out of the last 20
 * ended) or with an `unknown` one, a trace item frozen as `handed_off` reads
 * as moved to the background: the trace was written when the attempt ended
 * and the task may have ended since. No trace or registry is read for this
 * (MUL-472). Undefined when the trace started no task.
 */
export function backgroundLaunchResolver(
  items: readonly TraceItem[],
  rows: readonly BackgroundTask[] | null | undefined,
  attemptId: string | null | undefined,
  attemptEnded: boolean,
): BackgroundTaskResolver | undefined {
  const byCall = new Map<string, { task_id: string; task_type: string; name: string }>();
  for (const item of items) {
    if (item.type !== "background_task" || !item.tool_item_id || byCall.has(item.tool_item_id)) continue;
    byCall.set(item.tool_item_id, item);
  }
  if (!byCall.size) return undefined;
  const fallback = backgroundTaskResolver(items);
  const unconfirmed = (launch: BackgroundTaskLaunch | null): WebBackgroundTaskLaunch | null =>
    launch?.phase === "handed_off" ? { ...launch, moved: true } : launch;
  const registry = new Map<string, BackgroundTask>();
  if (attemptId) for (const row of rows ?? []) if (row.origin_attempt_id === attemptId) registry.set(row.task_id, row);
  return (toolItemId) => {
    const traced = byCall.get(toolItemId);
    const row = traced ? registry.get(traced.task_id) : undefined;
    if (!traced || !row) return unconfirmed(fallback(toolItemId));
    const launch = {
      task_type: row.task_type || traced.task_type,
      name: row.name.trim() ? row.name : traced.name,
      phase: backgroundTaskStatusPhase(row.status, attemptEnded),
    };
    // `unknown`: last seen running while its computer was online; not a confirmation.
    return row.status === "unknown" ? unconfirmed(launch) : launch;
  };
}
