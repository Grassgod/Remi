/**
 * Background tasks (PR 6, keep-alive on demand): the rules the daemon, the
 * server, the web and Feishu share. How long a parked lane keeps its process
 * (U1), which lanes park and which ring the doorbell (U2), when a stop asks
 * first (U3), and the doorbell message itself (§2.5).
 *
 * Each open user decision is one constant below, so a different answer is a
 * one-line change:
 * - U1 {@link BACKGROUND_KEEPALIVE_MS} (2 h, reset by every turn end);
 * - U2 {@link BACKGROUND_PARK_WITHOUT_WAKE} (Codex parks, with no doorbell);
 * - U3 {@link BACKGROUND_STOP_ALL_CONFIRM_MIN} (only 「全部停止」 of 2 or more asks).
 *
 * Pure: no I/O, no clock, no `process.env`. The web bundles this module, so it
 * has no relative imports.
 */

import type { BackgroundTaskDoorbellMetadata, BackgroundTaskStatus } from "@multiremi/contracts/unified-model";

// ── U1: keep-alive cap ──────────────────────────────────────────────────────

/** How long a parked lane keeps its process after the lane's latest attempt ended (U1 default: 2 hours). */
export const BACKGROUND_KEEPALIVE_MS = 2 * 60 * 60 * 1000;

/** Environment override of {@link BACKGROUND_KEEPALIVE_MS} in milliseconds, for live checks (L4). */
export const BACKGROUND_KEEPALIVE_ENV = "REMI_BACKGROUND_KEEPALIVE_MS";

/** Overrides below this are ignored: a parked lane must outlive the doorbell round trip. */
export const BACKGROUND_KEEPALIVE_MIN_MS = 1_000;

/** The keep-alive cap from an override value; a missing, malformed or too-small one gives the default. */
export function resolveBackgroundKeepAliveMs(raw: string | number | null | undefined): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value >= BACKGROUND_KEEPALIVE_MIN_MS ? value : BACKGROUND_KEEPALIVE_MS;
}

/** When a lane parked at `attemptEndedAt` (epoch ms) stops at the latest. Every attempt end moves it. */
export function backgroundParkedUntil(attemptEndedAt: number, keepAliveMs: number = BACKGROUND_KEEPALIVE_MS): number {
  return attemptEndedAt + keepAliveMs;
}

// ── U2: who parks, who rings ────────────────────────────────────────────────

/**
 * U2 default (A): a bridge whose tasks do not wake the model (Codex) still
 * parks, so the next turn can read a terminal it left running; it never rings
 * the doorbell. `false` would stop such tasks at the attempt's end instead.
 */
export const BACKGROUND_PARK_WITHOUT_WAKE = true;

/** The adapter's background-task capability (`AgentAdapter.asyncTasks`), as these rules read it. */
export interface BackgroundTaskCapability {
  wakesModel: boolean;
}

/** Whether a lane of this adapter may park with tasks running. Lane, cap and room checks are the daemon's. */
export function parksBackgroundTasks(capability: BackgroundTaskCapability | null | undefined): boolean {
  return !!capability && (capability.wakesModel || BACKGROUND_PARK_WITHOUT_WAKE);
}

/**
 * Whether a parked task's new status rings the doorbell: only an end that
 * wakes the model (completed or failed, on a bridge that wakes). A stop never
 * does: the bridge injects nothing for it.
 */
export function ringsBackgroundDoorbell(
  capability: BackgroundTaskCapability | null | undefined,
  status: BackgroundTaskStatus,
): boolean {
  return capability?.wakesModel === true && (status === "completed" || status === "failed");
}

// ── U3: confirmation ────────────────────────────────────────────────────────

/** U3 default (A): ■ and 停止 never ask; 「全部停止」 asks when it would stop at least this many tasks. */
export const BACKGROUND_STOP_ALL_CONFIRM_MIN = 2;

/** Whether a stop asks first. `all`: the 「全部停止」 action; `count`: how many running tasks it would stop. */
export function confirmsBackgroundStop(options: { all: boolean; count: number }): boolean {
  return options.all && options.count >= BACKGROUND_STOP_ALL_CONFIRM_MIN;
}

// ── Statuses ────────────────────────────────────────────────────────────────

/** A process is still behind it. */
export function isLiveBackgroundTaskStatus(status: BackgroundTaskStatus): status is "running" | "paused" {
  return status === "running" || status === "paused";
}

/** It ended; `unknown` (runtime offline) is neither live nor ended. */
export function isEndedBackgroundTaskStatus(status: BackgroundTaskStatus): status is "completed" | "failed" | "stopped" {
  return status === "completed" || status === "failed" || status === "stopped";
}

// ── Doorbell (§2.5) ─────────────────────────────────────────────────────────

/** One doorbell per task and lane: a repeated `lane.background_wake` hits it and answers the first outcome. */
export function backgroundDoorbellDedupeKey(lane: { agent_id: string; execution_scope: string }, taskId: string): string {
  return `bg:${lane.agent_id}:${lane.execution_scope}:${taskId}`;
}

/** A duration in the doorbell's Chinese: 「45 秒」, 「2 分 5 秒」, 「1 小时 3 分」. */
export function formatBackgroundDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/** How every doorbell body starts (see {@link backgroundDoorbellBody}). */
export const BACKGROUND_DOORBELL_PREFIX = "后台任务已结束：";

/**
 * The doorbell's `body_md`: 「后台任务已结束：{name}（已完成，用时 {duration}）」 and the
 * summary on the next line. It is also what the attaching attempt prompts
 * when the cycle it waited for never came, so it reads as an instruction-free fact.
 */
export function backgroundDoorbellBody(task: {
  name: string;
  status: BackgroundTaskDoorbellMetadata["status"];
  duration_ms?: number | null;
  summary?: string | null;
}): string {
  const outcome = task.status === "completed" ? "已完成" : "失败";
  const duration = typeof task.duration_ms === "number" && Number.isFinite(task.duration_ms)
    ? `，用时 ${formatBackgroundDuration(task.duration_ms)}` : "";
  const summary = task.summary?.trim();
  return `${BACKGROUND_DOORBELL_PREFIX}${task.name.trim() || "后台任务"}（${outcome}${duration}）${summary ? `\n${summary}` : ""}`;
}

/**
 * `metadata.background_task` of a message, when it is a well-formed doorbell;
 * null for any other message. Readers (attach mode, the doorbell row, Feishu)
 * treat a malformed one as an ordinary message.
 */
export function readBackgroundDoorbell(metadata: unknown): BackgroundTaskDoorbellMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).background_task;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (key: string) => typeof row[key] === "string" && (row[key] as string).length > 0;
  if (!text("task_id") || typeof row.name !== "string" || typeof row.task_type !== "string"
    || (row.status !== "completed" && row.status !== "failed")
    || !text("origin_attempt_id") || !text("provider_session_id")
    || (row.origin_turn_id != null && typeof row.origin_turn_id !== "string")) return null;
  return {
    task_id: row.task_id as string,
    name: row.name,
    task_type: row.task_type,
    status: row.status,
    origin_attempt_id: row.origin_attempt_id as string,
    origin_turn_id: (row.origin_turn_id as string | null) ?? null,
    provider_session_id: row.provider_session_id as string,
  };
}
