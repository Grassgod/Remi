/**
 * Synthetic `multiremi_task_messages` data for the MUL-432 trace backfill.
 *
 * Local only: rows are inserted with plain SQL into a store the caller owns
 * (an in-memory SQLite database, a throwaway Postgres database). The tests,
 * the local drill and the read-latency bench share these helpers so they all
 * exercise the same shapes.
 */
import type { SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { TRACE_TRUNCATION_MARKER } from "../../packages/shared/src/trace-sanitize.js";

export const SYNTHETIC_WORKSPACE_ID = "local";

export interface SyntheticMessage {
  seq: number;
  type: string;
  tool?: string | null;
  content?: string | null;
  input?: string | null;
  output?: string | null;
  tool_call_id?: string | null;
  status?: string | null;
  meta?: string | null;
  created_at: string;
}

export interface SyntheticTask {
  id: string;
  agentId: string;
  runtimeId?: string | null;
  issueId?: string | null;
  issueSessionId?: string | null;
  chatSessionId?: string | null;
  status: string;
  provider?: string | null;
  createdAt: string;
  startedAt?: string | null;
  /** Written to the column of the terminal status (`completed_at`, `failed_at`, `cancelled_at`). */
  endedAt?: string | null;
  workspaceId?: string;
}

export function insertSyntheticAgent(db: SqlDatabase, input: { id: string; provider: string; createdAt: string }): void {
  db.run(
    `INSERT INTO multiremi_agents (id, workspace_id, name, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.id, input.provider, input.createdAt, input.createdAt,
  );
}

export function insertSyntheticRuntime(
  db: SqlDatabase,
  input: { id: string; provider: string; daemonId: string | null; createdAt: string },
): void {
  db.run(
    `INSERT INTO multiremi_runtimes (id, workspace_id, name, provider, daemon_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.id, input.provider, input.daemonId, input.createdAt, input.createdAt,
  );
}

export function insertSyntheticIssue(
  db: SqlDatabase,
  input: { id: string; number: number; createdAt: string; lifecycleState?: "active" | "deleting" },
): void {
  db.run(
    `INSERT INTO multiremi_issues (id, workspace_id, issue_number, title, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.number, `synthetic ${input.number}`,
    input.lifecycleState ?? "active", input.createdAt, input.createdAt,
  );
}

export function insertSyntheticChat(db: SqlDatabase, input: { id: string; agentId: string; createdAt: string }): void {
  db.run(
    `INSERT INTO multiremi_chat_sessions (id, workspace_id, agent_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.agentId, input.id, input.createdAt, input.createdAt,
  );
}

export function insertSyntheticTask(db: SqlDatabase, task: SyntheticTask): void {
  const ended = task.endedAt ?? null;
  db.run(
    `INSERT INTO multiremi_tasks (
       id, workspace_id, agent_id, runtime_id, issue_id, issue_session_id, chat_session_id, status, provider,
       prompt, created_at, updated_at, dispatched_at, started_at, completed_at, failed_at, cancelled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id,
    task.workspaceId ?? SYNTHETIC_WORKSPACE_ID,
    task.agentId,
    task.runtimeId ?? null,
    task.issueId ?? null,
    task.issueSessionId ?? null,
    task.chatSessionId ?? null,
    task.status,
    task.provider ?? null,
    "synthetic",
    task.createdAt,
    ended ?? task.createdAt,
    task.startedAt ?? null,
    task.startedAt ?? null,
    task.status === "completed" ? ended : null,
    task.status === "failed" ? ended : null,
    task.status === "cancelled" ? ended : null,
  );
}

export function insertSyntheticMessages(db: SqlDatabase, taskId: string, messages: readonly SyntheticMessage[]): void {
  const insert = db.prepare(
    `INSERT INTO multiremi_task_messages (
       id, task_id, seq, type, tool, content, input, output, tool_call_id, status, meta, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const message of messages) {
      insert.run(
        `msg_${taskId}_${message.seq}`,
        taskId,
        message.seq,
        message.type,
        message.tool ?? null,
        message.content ?? null,
        message.input ?? null,
        message.output ?? null,
        message.tool_call_id ?? null,
        message.status ?? null,
        message.meta ?? null,
        message.created_at,
      );
    }
  })();
}

/**
 * Text the old write path produced for an oversized JSON column: the first
 * `bytes` characters of a JSON document, cut mid-value, plus the marker.
 */
export function truncatedJsonText(bytes: number, seed = "x"): string {
  const body = JSON.stringify({ blob: seed.repeat(Math.max(1, bytes)) });
  return `${body.slice(0, bytes)}${TRACE_TRUNCATION_MARKER}`;
}
