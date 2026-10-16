/**
 * The task context file (PR 6 §2.4): a bridge process that outlives its
 * attempt keeps the environment it was spawned with, including the attempt's
 * `MULTIREMI_TOKEN`, which the server revokes when that attempt completes. So
 * a Chat lane that may park also gets `MULTIREMI_TASK_CONTEXT_FILE`, a stable
 * path the daemon rewrites (tmp + rename) whenever an attempt starts on the
 * process, adoption and attach included, and clears (`token: null`) when the
 * lane parks with no attempt.
 *
 * Readers (the `remi` CLI, the git credential broker) prefer the file when
 * the variable names a readable one, and fall back to the environment
 * otherwise. A file with no token means the lane is parked: there is no valid
 * credential until the next attempt attaches.
 */
import { readFileSync } from "node:fs";

export const TASK_CONTEXT_FILE_ENV = "MULTIREMI_TASK_CONTEXT_FILE";

/** What a reader gets while the lane is parked (no attempt, no credential). */
export const TASK_CONTEXT_PARKED_MESSAGE = "后台任务所在的轮已结束，暂无有效凭据";

/** The file's JSON. */
export interface TaskContextFile {
  token: string | null;
  turn_id: string | null;
  attempt_id: string | null;
  /** ISO 8601. */
  written_at: string;
}

export interface TaskContext {
  token: string | null;
  turnId: string | null;
  attemptId: string | null;
  /** Where it came from: the context file, or the spawn environment. */
  source: "file" | "env";
  /** The file says no attempt runs on the process (it is parked). */
  parked: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The context file at `path`, when it is readable and well formed; null otherwise. */
export function readTaskContextFile(path: string): TaskContextFile | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.token !== null && typeof value.token !== "string") return null;
    return { token: text(value.token), turn_id: text(value.turn_id), attempt_id: text(value.attempt_id),
      written_at: typeof value.written_at === "string" ? value.written_at : "" };
  } catch {
    return null;
  }
}

/** The task's token, turn and attempt: the context file when `MULTIREMI_TASK_CONTEXT_FILE` names a readable one, else the env. */
export function resolveTaskContext(env: Readonly<Record<string, string | undefined>> = process.env): TaskContext {
  const path = text(env[TASK_CONTEXT_FILE_ENV]);
  const file = path ? readTaskContextFile(path) : null;
  if (file) {
    return { token: file.token, turnId: file.turn_id, attemptId: file.attempt_id, source: "file", parked: file.token === null };
  }
  return { token: text(env.MULTIREMI_TOKEN), turnId: text(env.MULTIREMI_TURN_ID), attemptId: text(env.MULTIREMI_ATTEMPT_ID),
    source: "env", parked: false };
}
