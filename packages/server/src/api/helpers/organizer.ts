import type { Context } from "hono";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import type { ConversationLogTurnMetadata } from "@multiremi/contracts/conversation-log.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { TraceReader } from "@multiremi/trace/trace-reader.js";
import { agentRoleAtLeast } from "@multiremi/store/agent-role.js";
import { currentTaskAccessToken } from "../wire/index.js";

export * from "../../organizer/settings.js";

export const ORGANIZER_SUPERVISOR_SCOPE = "organizer:supervisor";

export interface SupervisorTaskIdentity {
  token: NonNullable<ReturnType<typeof currentTaskAccessToken>>;
  task: MultiremiTask;
  agentId: string;
}

export function supervisorTaskIdentity(c: Context, store: MultiremiStore): SupervisorTaskIdentity | null {
  const token = currentTaskAccessToken(c);
  if (!token?.taskId || !token.agentId || !token.scopes?.includes(ORGANIZER_SUPERVISOR_SCOPE)) return null;
  const task = store.getTask(token.taskId);
  const agent = store.getAgent(token.agentId);
  if (
    !task
    || !agent
    || !agentRoleAtLeast(agent.role, "supervisor")
    || task.agentId !== token.agentId
    || task.workspaceId !== token.workspaceId
    || agent.workspaceId !== token.workspaceId
  ) return null;
  return { token, task, agentId: agent.id };
}

export function organizerTaskListItem(task: MultiremiTask): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    agent_id: task.agentId,
    issue_id: task.issueId,
    runtime_id: task.runtimeId,
    progress_summary: task.progressSummary,
    progress_step: task.progressStep,
    progress_total: task.progressTotal,
    failure_reason: task.failureReason,
    wait_reason: task.waitReason,
    created_at: task.createdAt,
    started_at: task.startedAt,
    updated_at: task.updatedAt,
    completed_at: task.completedAt,
  };
}

export interface OrganizerTurnStats {
  toolCallCount: number;
  eventCount: number;
  typeHistogram: Array<{ type: string; tool: string | null; count: number }>;
}

export interface OrganizerInspectionSources {
  readTrace?: Pick<TraceReader, "readTrace">;
  getTurnStats?: (taskId: string) => OrganizerTurnStats | null;
}

export function organizerTurnStats(store: MultiremiStore, taskId: string): OrganizerTurnStats | null {
  const metadata = store.findTurnEntry(taskId)?.metadata as ConversationLogTurnMetadata | undefined;
  if (metadata?.tool_call_count == null || metadata.event_count == null || !Array.isArray(metadata.type_histogram)) return null;
  if (!Number.isSafeInteger(metadata.tool_call_count) || metadata.tool_call_count < 0
    || !Number.isSafeInteger(metadata.event_count) || metadata.event_count < 0) return null;
  if (metadata.type_histogram.some((bucket) => !bucket || typeof bucket.type !== "string"
    || (bucket.tool != null && typeof bucket.tool !== "string")
    || !Number.isSafeInteger(bucket.count) || bucket.count < 0)) return null;
  return {
    toolCallCount: metadata.tool_call_count,
    eventCount: metadata.event_count,
    typeHistogram: metadata.type_histogram.map((bucket) => ({ ...bucket, tool: bucket.tool ?? null })),
  };
}

export async function organizerTaskInspection(
  store: MultiremiStore,
  task: MultiremiTask,
  sources: OrganizerInspectionSources = {},
): Promise<Record<string, unknown>> {
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  const card = terminal ? sources.getTurnStats?.(task.id) ?? null : null;
  let traceEvents: Awaited<ReturnType<TraceReader["readTrace"]>>["events"] | null = null;
  if (!terminal && sources.readTrace) {
    const probe = await sources.readTrace.readTrace(task.id, Number.MAX_SAFE_INTEGER, 1);
    if (probe.state === "ok") {
      const tail = await sources.readTrace.readTrace(task.id, Math.max(0, probe.head - 200), 200);
      if (tail.state === "ok") traceEvents = tail.events;
    }
  }
  // TODO(MUL-432): remove the legacy-table fallback together with that table.
  const messages = card || traceEvents ? [] : store.listTaskMessages(task.id);
  const histogram = new Map<string, { type: string; tool: string | null; count: number }>();
  for (const message of traceEvents ?? messages) {
    const key = `${message.type}\u0000${message.tool ?? ""}`;
    const bucket = histogram.get(key) ?? { type: message.type, tool: message.tool ?? null, count: 0 };
    bucket.count += 1;
    histogram.set(key, bucket);
  }
  const latestMessage = (traceEvents ?? messages).at(-1) ?? null;
  const typeHistogram = card?.typeHistogram ?? [...histogram.values()];
  const toolCallCount = card?.toolCallCount ?? (traceEvents ?? messages).filter((message) => message.type === "tool_use").length;
  const eventCount = card?.eventCount ?? (traceEvents ? traceEvents.length : messages.length);
  const requests = store.listTaskHumanRequests(task.id);
  const requestCounts = { pending: 0, responded: 0, timeout: 0, cancelled: 0 };
  for (const request of requests) requestCounts[request.status] += 1;
  const latestRequest = requests.at(-1) ?? null;
  const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
  const agent = store.getAgent(task.agentId);
  const issue = task.issueId ? store.getIssue(task.issueId) : null;
  return {
    ...organizerTaskListItem(task),
    dispatched_at: task.dispatchedAt,
    failed_at: task.failedAt,
    cancelled_at: task.cancelledAt,
    last_message: latestMessage ? { seq: latestMessage.seq, created_at: "ts" in latestMessage ? latestMessage.ts : latestMessage.createdAt } : null,
    tool_call_count: toolCallCount,
    event_count: eventCount,
    message_type_histogram: typeHistogram.map((bucket) => ({
      type: bucket.type,
      tool: bucket.tool,
      count: bucket.count,
    })),
    human_requests: {
      counts: requestCounts,
      latest: latestRequest ? {
        kind: latestRequest.kind,
        status: latestRequest.status,
        created_at: latestRequest.createdAt,
        responded_at: latestRequest.respondedAt,
      } : null,
    },
    runtime: runtime ? {
      id: runtime.id,
      status: runtime.status,
      online: runtime.status === "online",
      last_heartbeat_at: runtime.lastHeartbeatAt,
    } : task.runtimeId ? { id: task.runtimeId, status: "missing", online: false, last_heartbeat_at: null } : null,
    agent: agent ? { id: agent.id, name: agent.name, role: agent.role, supervisor: agent.supervisor === true } : { id: task.agentId },
    issue: issue ? { id: issue.id, key: issue.key, status: issue.status } : task.issueId ? { id: task.issueId } : null,
  };
}
