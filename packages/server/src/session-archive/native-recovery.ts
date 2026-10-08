import { createHash } from "node:crypto";
import type { MultiremiTaskTrace } from "@multiremi/contracts/session-archive.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

/** An operator's exact terminal-task snapshot, never inferred from a file name. */
export interface NativeTraceRecoveryTaskSnapshot {
  taskId: string;
  workspaceId: string;
  agentId: string;
  runtimeId: string;
  provider: string;
  status: "completed" | "failed" | "cancelled";
  issueId: string | null;
  issueSessionId: string | null;
  chatSessionId: string | null;
  /** Provider session recorded on the Task, not the Remi Issue/Chat Session. */
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

export interface NativeTraceRecoveryEvidence {
  sourceSha256: string;
  sourceBytes: number;
  nativeSessionId: string;
  nativeTurnIds: readonly string[];
  /** Stable descriptions/hashes of exact identity matches, never raw prompts or credentials. */
  taskIdentityEvidence: readonly string[];
  sourceStartLine: number;
  sourceEndLine: number;
  recoveredEventKinds: readonly string[];
  /** Explicitly states omissions; an empty list is allowed only if none were found. */
  omissions: readonly string[];
  /** The operator must establish absence before choosing to replace a daemon pointer. */
  missingTrace: { checkedAt: string; reason: "trace_not_hot" | "normalized_file_absent" };
  /** Narrow exception for an executed native turn whose start acknowledgement never reached Remi. */
  nativeExecutionBinding?: NativeTraceExecutionBinding;
}

export interface NativeTraceExecutionBinding {
  kind: "cancelled_without_start_ack";
  taskId: string;
  providerSessionId: string;
  nativeStartedAt: string;
  nativeCompletedAt: string;
  /** Hash of the exact persisted task prompt matched in the provider's user message. */
  promptSha256: string;
  directTaskIdRecords: readonly {
    kind: "remi_context" | "structured_tool_result";
    sourceLine: number;
    taskId: string;
    providerSessionId: string;
  }[];
}

export interface NativeTraceRecoveryTask {
  task: NativeTraceRecoveryTaskSnapshot;
  expectedPointer: MultiremiTaskTrace;
  evidence: NativeTraceRecoveryEvidence;
}

export class NativeTraceRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTraceRecoveryError";
  }
}

/** Stable across caller object-key order, needed for exact replay and audit hashes. */
export function canonicalRecoveryJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalRecoveryJson(object[key])}`).join(",")}}`;
}

export function nativeRecoveryEndedAt(task: NativeTraceRecoveryTaskSnapshot): string | null {
  return task.status === "completed" ? task.completedAt : task.status === "failed" ? task.failedAt : task.cancelledAt;
}

export function nativeRecoverySessionId(task: NativeTraceRecoveryTaskSnapshot): string {
  return task.issueSessionId ?? task.chatSessionId ?? task.taskId;
}

export function nativeRecoveryStartedAt(candidate: NativeTraceRecoveryTask): string {
  const value = candidate.task.startedAt ?? candidate.evidence.nativeExecutionBinding?.nativeStartedAt;
  if (!value) throw new NativeTraceRecoveryError(`native recovery lacks a proven execution start: ${candidate.task.taskId}`);
  return value;
}

/** Read-only preflight; repeated under the commit's workspace/task row locks. */
export function assertNativeExecutionBinding(db: SqlDatabase, candidate: NativeTraceRecoveryTask): void {
  const binding = candidate.evidence.nativeExecutionBinding;
  if (!binding) return;
  const task = candidate.task;
  const row = db.query("SELECT prompt, created_at, dispatched_at, started_at, status, result FROM multiremi_tasks WHERE id = ?").get(task.taskId);
  if (!row || row.status !== "cancelled" || row.started_at !== null || row.result !== null
    || typeof row.prompt !== "string" || !row.prompt.trim()
    || createHash("sha256").update(row.prompt).digest("hex") !== binding.promptSha256) {
    throw new NativeTraceRecoveryError(`native execution prompt binding changed: ${task.taskId}`);
  }
  // For this proved missing-ack class dispatched_at can be recorded by a
  // later offer/retry, after the native process already ran. Creation remains
  // the immutable lower bound; prompt, session uniqueness and direct task IDs
  // provide attribution independently of that delayed acknowledgement.
  const lower = Date.parse(String(row.created_at ?? ""));
  const upper = Date.parse(task.cancelledAt ?? "");
  const started = Date.parse(binding.nativeStartedAt), ended = Date.parse(binding.nativeCompletedAt);
  if (![lower, upper, started, ended].every(Number.isFinite) || started < lower || ended < started || ended > upper) {
    throw new NativeTraceRecoveryError(`native execution is outside the cancelled task window: ${task.taskId}`);
  }
  // Use the persisted provider snapshot, not today's Agent configuration.
  const owners = Number(db.query(`SELECT COUNT(*) AS n FROM multiremi_tasks
    WHERE workspace_id = ? AND provider = ? AND session_id = ?`)
    .get(task.workspaceId, task.provider, binding.providerSessionId)?.n ?? 0);
  if (owners !== 1) throw new NativeTraceRecoveryError(`native execution session is not exclusively owned: ${task.taskId}`);
}

export function nativeRecoveryMetadata(algorithmVersion: string, tasks: readonly NativeTraceRecoveryTask[]): Record<string, unknown> {
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const timestamp = (value: unknown): value is string => nonempty(value) && Number.isFinite(Date.parse(value));
  const texts = (value: readonly string[], required: boolean) => Array.isArray(value)
    && (!required || value.length > 0) && value.every(nonempty);
  if (!nonempty(algorithmVersion) || tasks.length === 0) throw new NativeTraceRecoveryError("native recovery requires an algorithm version and tasks");
  const seen = new Set<string>();
  for (const { task, expectedPointer, evidence } of tasks) {
    if (seen.has(task.taskId)) throw new NativeTraceRecoveryError(`duplicate recovery task ${task.taskId}`);
    seen.add(task.taskId);
    if (![task.taskId, task.workspaceId, task.agentId, task.runtimeId, task.provider].every(nonempty)
      || !["completed", "failed", "cancelled"].includes(task.status)
      || !timestamp(nativeRecoveryEndedAt(task)) || !timestamp(task.updatedAt)) {
      throw new NativeTraceRecoveryError(`incomplete terminal task identity: ${task.taskId}`);
    }
    if (!nonempty(task.sessionId) || task.sessionId !== evidence.nativeSessionId) {
      throw new NativeTraceRecoveryError(`native recovery provider session differs from task: ${task.taskId}`);
    }
    const binding = evidence.nativeExecutionBinding;
    if (binding) {
      const records = binding.directTaskIdRecords;
      if (binding.kind !== "cancelled_without_start_ack" || task.status !== "cancelled" || task.startedAt !== null
        || !task.sessionId || binding.taskId !== task.taskId || binding.providerSessionId !== task.sessionId
        || binding.providerSessionId !== evidence.nativeSessionId || !/^[a-f0-9]{64}$/.test(binding.promptSha256)
        || !timestamp(binding.nativeStartedAt) || !timestamp(binding.nativeCompletedAt)
        || Date.parse(binding.nativeCompletedAt) < Date.parse(binding.nativeStartedAt)
        || !Array.isArray(records) || records.length < 2 || !records.some((record) => record.kind === "remi_context")
        || new Set(records.map((record) => record.sourceLine)).size !== records.length
        || records.some((record) => !["remi_context", "structured_tool_result"].includes(record.kind)
          || record.taskId !== task.taskId || record.providerSessionId !== task.sessionId
          || !Number.isSafeInteger(record.sourceLine) || record.sourceLine < evidence.sourceStartLine || record.sourceLine > evidence.sourceEndLine)) {
        throw new NativeTraceRecoveryError(`invalid cancelled-without-start execution binding: ${task.taskId}`);
      }
    } else if (!timestamp(task.startedAt)) {
      throw new NativeTraceRecoveryError(`incomplete terminal task identity: ${task.taskId}`);
    }
    if (expectedPointer.taskId !== task.taskId || expectedPointer.location !== "daemon"
      || expectedPointer.runtimeId !== task.runtimeId || expectedPointer.archiveId !== null) {
      throw new NativeTraceRecoveryError(`native recovery requires the original daemon pointer: ${task.taskId}`);
    }
    if (!/^[a-f0-9]{64}$/.test(evidence.sourceSha256) || !Number.isSafeInteger(evidence.sourceBytes) || evidence.sourceBytes < 1
      || !nonempty(evidence.nativeSessionId) || !texts(evidence.nativeTurnIds, true)
      || !texts(evidence.taskIdentityEvidence, true) || !texts(evidence.recoveredEventKinds, true) || !texts(evidence.omissions, false)
      || !Number.isSafeInteger(evidence.sourceStartLine) || evidence.sourceStartLine < 1
      || !Number.isSafeInteger(evidence.sourceEndLine) || evidence.sourceEndLine < evidence.sourceStartLine
      || !timestamp(evidence.missingTrace?.checkedAt)
      || !["trace_not_hot", "normalized_file_absent"].includes(evidence.missingTrace?.reason)) {
      throw new NativeTraceRecoveryError(`incomplete native source proof: ${task.taskId}`);
    }
  }
  const recovery = { algorithm_version: algorithmVersion, tasks: [...tasks].sort((a, b) => a.task.taskId.localeCompare(b.task.taskId)) };
  return {
    kind: "trace_backfill",
    recovery_source: "native_provider_jsonl",
    recovery_manifest_sha256: createHash("sha256").update(canonicalRecoveryJson(recovery)).digest("hex"),
    recovery,
  };
}
