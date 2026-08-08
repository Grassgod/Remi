// Task request plumbing: status predicates, the daemon pending-task ordering, task-message and
// usage input normalisers, and the usage query parser.
import type { Context } from "hono";
import { MultiremiStore } from "@multiremi/store/store.js";
import { parseOptionalInt } from "../wire/index.js";
import type {
  MultiremiRuntime,
  MultiremiTask,
  MultiremiTaskStatus,
  TaskMessageInput,
  TaskUsageEntry,
} from "@multiremi/contracts/types.js";

export function parseOptionalTaskMessageSince(value: string | undefined): number | undefined | { error: string } {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return { error: "invalid since parameter" };
  return parsed;
}

export function daemonTaskUsageEntries(raw: unknown): TaskUsageEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: TaskUsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    entries.push({
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      inputTokens: normalizeDaemonUsageNumber(record.input_tokens),
      outputTokens: normalizeDaemonUsageNumber(record.output_tokens),
      cacheReadTokens: normalizeDaemonUsageNumber(record.cache_read_tokens),
      cacheWriteTokens: normalizeDaemonUsageNumber(record.cache_write_tokens),
      totalTokens: normalizeDaemonUsageNumber(record.total_tokens),
    });
  }
  return entries;
}

export function normalizeDaemonUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

export function taskFromParam(
  store: MultiremiStore,
  c: Context,
  param: string,
): MultiremiTask | null {
  return store.getTaskByRef(c.req.param(param) ?? "");
}

export const MAX_TASK_MESSAGES_PER_REQUEST = 256;

// Whitelist an untrusted daemon message body to TaskMessageInput, tolerating
// both camelCase (the daemon client serializes TaskMessageInput directly) and
// snake_case field names.
export function daemonTaskMessageInput(raw: unknown): TaskMessageInput {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof m[k] === "string") return m[k] as string;
    return undefined;
  };
  const obj = (...keys: string[]): Record<string, unknown> | undefined => {
    for (const k of keys) if (m[k] && typeof m[k] === "object" && !Array.isArray(m[k])) return m[k] as Record<string, unknown>;
    return undefined;
  };
  return {
    seq: typeof m.seq === "number" ? m.seq : undefined,
    type: str("type") ?? "text",
    tool: str("tool") ?? null,
    content: str("content") ?? null,
    input: obj("input") ?? null,
    output: str("output") ?? null,
    toolCallId: str("toolCallId", "tool_call_id") ?? null,
    status: str("status") ?? null,
    meta: obj("meta") ?? null,
  };
}

export function isPendingForRuntime(store: MultiremiStore, runtime: MultiremiRuntime, task: MultiremiTask): boolean {
  if ((runtime.workspaceId ?? "local") !== (task.workspaceId ?? "local")) return false;
  if (isInFlightTaskStatus(task.status)) return task.runtimeId === runtime.id;
  if (task.status !== "queued") return false;
  const agent = store.getAgent(task.agentId);
  if (!agent || agent.archivedAt) return false;
  if (task.runtimeId && task.runtimeId !== runtime.id) return false;
  if (agent.runtimeId && agent.runtimeId !== runtime.id) return false;
  if (runtime.provider !== "any" && agent.provider !== runtime.provider) return false;
  // Mirrors the claim SQL's ownership predicate: a private runtime only runs
  // its owner's agents (COALESCE(...,'local') so single-machine NULL owners
  // still pair). A task stamp is deliberately NOT an escape hatch — the /tasks
  // API lets any member stamp an arbitrary agent+runtime.
  if (
    runtime.visibility !== "public" &&
    (runtime.ownerId ?? "local") !== (agent.ownerId ?? "local")
  ) {
    return false;
  }
  return true;
}

export function isDaemonPendingTaskForRuntime(task: MultiremiTask, runtimeId: string): boolean {
  return task.runtimeId === runtimeId && (task.status === "queued" || task.status === "dispatched");
}

export function compareDaemonPendingTasks(left: MultiremiTask, right: MultiremiTask): number {
  return right.priority - left.priority || Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

export function isTerminalTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isActiveTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "queued"
    || status === "dispatched"
    || status === "running"
    || status === "waiting_local_directory"
    || status === "awaiting_human";
}

export function isInFlightTaskStatus(status: MultiremiTaskStatus): boolean {
  return status === "dispatched"
    || status === "running"
    || status === "waiting_local_directory"
    || status === "awaiting_human";
}

export function usageQuery(c: { req: { query: (name: string) => string | undefined } }, extra: { runtimeId?: string | null } = {}): {
  workspaceId?: string | null;
  projectId?: string | null;
  runtimeId?: string | null;
  days?: number;
} {
  return {
    workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local",
    projectId: c.req.query("projectId") ?? c.req.query("project_id") ?? null,
    runtimeId: extra.runtimeId,
    days: parseOptionalInt(c.req.query("days")),
  };
}
