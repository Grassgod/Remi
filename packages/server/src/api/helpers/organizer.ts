import type { Context } from "hono";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
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
    || !agent?.supervisor
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

export function organizerTaskInspection(store: MultiremiStore, task: MultiremiTask): Record<string, unknown> {
  const messages = store.listTaskMessages(task.id);
  const histogram = new Map<string, { type: string; tool: string | null; count: number }>();
  for (const message of messages) {
    const key = `${message.type}\u0000${message.tool ?? ""}`;
    const bucket = histogram.get(key) ?? { type: message.type, tool: message.tool, count: 0 };
    bucket.count += 1;
    histogram.set(key, bucket);
  }
  const latestMessage = messages.at(-1) ?? null;
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
    last_message: latestMessage ? { seq: latestMessage.seq, created_at: latestMessage.createdAt } : null,
    message_type_histogram: [...histogram.values()].map((bucket) => ({
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
    agent: agent ? { id: agent.id, name: agent.name, supervisor: agent.supervisor === true } : { id: task.agentId },
    issue: issue ? { id: issue.id, key: issue.key, status: issue.status } : task.issueId ? { id: task.issueId } : null,
  };
}
