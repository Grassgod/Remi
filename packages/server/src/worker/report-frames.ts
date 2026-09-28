import { encodeDaemonProtocolFrame, type DaemonOutboundFrame } from "../api/daemon-protocol/frames.js";
import type { MultiremiOutboxRecord } from "./outbox.js";

export function outboxRecordFrame(record: MultiremiOutboxRecord): DaemonOutboundFrame {
  const runtimeId = record.taskId.startsWith("rt:") ? record.taskId.slice(3) : record.payload.runtime_id;
  const type = record.kind.includes(".") ? record.kind : `task.${record.kind}`;
  const payload = { ...record.payload };
  if (!record.taskId.startsWith("rt:")) payload.task_id = record.taskId;
  if (record.kind === "session_pin" || record.kind === "complete" || record.kind === "fail") {
    if ("sessionId" in payload) { payload.session_id = payload.sessionId; delete payload.sessionId; }
    if ("workDir" in payload) { payload.work_dir = payload.workDir; delete payload.workDir; }
    if ("failureReason" in payload) { payload.failure_reason = payload.failureReason; delete payload.failureReason; }
  }
  if (record.kind === "usage" && Array.isArray(payload.usage)) {
    payload.usage = payload.usage.map((entry: Record<string, unknown>) => ({
      provider: entry.provider, model: entry.model,
      input_tokens: entry.input_tokens ?? entry.inputTokens, output_tokens: entry.output_tokens ?? entry.outputTokens,
      cache_read_tokens: entry.cache_read_tokens ?? entry.cacheReadTokens, cache_write_tokens: entry.cache_write_tokens ?? entry.cacheWriteTokens,
      total_tokens: entry.total_tokens ?? entry.totalTokens,
    }));
  }
  if (record.kind === "workspace") {
    payload.runtime_id ??= payload.runtimeId;
    payload.root_path ??= payload.rootPath;
    payload.branch_name ??= payload.branchName;
    if (Array.isArray(payload.repos)) payload.repos = payload.repos.map((repo: Record<string, unknown>) => ({
      repo_url: repo.repo_url ?? repo.repoUrl, repo_name: repo.repo_name ?? repo.repoName,
      worktree_path: repo.worktree_path ?? repo.worktreePath, branch_name: repo.branch_name ?? repo.branchName,
      base_ref: repo.base_ref ?? repo.baseRef, base_commit: repo.base_commit ?? repo.baseCommit,
      status: repo.status, dirty: repo.dirty, error: repo.error,
    }));
    delete payload.runtimeId; delete payload.rootPath; delete payload.branchName;
  }
  return { t: type, seq: record.id, ...(typeof runtimeId === "string" && runtimeId ? { rt: runtimeId } : {}), p: payload };
}

/** Reserve the largest piggybacked ack so enqueue and window accounting are conservative. */
export function outboxRecordBytes(record: MultiremiOutboxRecord): number {
  return Buffer.byteLength(encodeDaemonProtocolFrame({ ...outboxRecordFrame(record), ack: Number.MAX_SAFE_INTEGER }));
}
