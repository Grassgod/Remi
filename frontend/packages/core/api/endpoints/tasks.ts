import type {
  AgentActivityBucket,
  AgentRunCount,
  AgentTask,
  IssueUsageSummary,
  TaskMessagePayload,
  TaskPromptArtifact,
} from "../../types";
import { normalizeTaskMessages } from "../../chat/normalize-message";
import type { HttpClient } from "../http";
import { parseStrictResponse, parseWithFallback } from "../schema";
import {
  EMPTY_TASK_STEER_LIST,
  TaskSteerListResponseSchema,
  TaskSteerResponseSchema,
  type TaskSteerListResponse,
  type TaskSteerResponse,
} from "../schemas/tasks";

export class TasksEndpoints {
  constructor(readonly http: HttpClient) {}

  async listAgentTasks(agentId: string): Promise<AgentTask[]> {
    return this.http.fetch(`/api/agents/${agentId}/tasks`);
  }

  // Workspace-scoped agent task snapshot: every active task
  // (queued/dispatched/running) plus each agent's most recent terminal task.
  // Powers the front-end's "active wins, else latest terminal" presence
  // derivation; one fetch backs every per-agent presence read in the app.
  // Workspace is resolved server-side from the X-Workspace-Slug header.
  async getAgentTaskSnapshot(): Promise<AgentTask[]> {
    return this.http.fetch(`/api/agent-task-snapshot`);
  }

  // Per-agent daily activity for the last 30 days, anchored on
  // completed_at. One workspace-wide fetch backs both the Agents-list
  // sparkline (uses trailing 7 buckets) and the agent detail "Last 30
  // days" panel (uses all 30).
  async getWorkspaceAgentActivity30d(): Promise<AgentActivityBucket[]> {
    return this.http.fetch(`/api/agent-activity-30d`);
  }

  // Per-agent 30-day total run count for the Agents-list RUNS column.
  async getWorkspaceAgentRunCounts(): Promise<AgentRunCount[]> {
    return this.http.fetch(`/api/agent-run-counts`);
  }

  async getActiveTasksForIssue(issueId: string): Promise<{ tasks: AgentTask[] }> {
    return this.http.fetch(`/api/issues/${issueId}/active-task`);
  }

  async listTaskMessages(taskId: string): Promise<TaskMessagePayload[]> {
    // GET returns the camelCase store object; the WS wire is snake_case. Funnel
    // both through the one normalizer so the cache holds a single shape.
    return normalizeTaskMessages(await this.http.fetch(`/api/tasks/${taskId}/messages`));
  }

  async getTaskPrompt(taskId: string): Promise<TaskPromptArtifact> {
    return this.http.fetch(`/api/tasks/${taskId}/prompt`);
  }

  async listTaskHumanRequests(taskId: string): Promise<unknown> {
    return this.http.fetch(`/api/tasks/${taskId}/human-requests`);
  }

  async respondTaskHumanRequest(taskId: string, requestId: string, response: Record<string, unknown>): Promise<unknown> {
    return this.http.fetch(`/api/tasks/${taskId}/human-requests/${requestId}/respond`, {
      method: "POST",
      body: JSON.stringify({ response }),
    });
  }

  async steerTask(
    taskId: string,
    input: { content?: string; force_answer?: boolean },
  ): Promise<TaskSteerResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/tasks/${encodeURIComponent(taskId)}/steer`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return parseStrictResponse(raw, TaskSteerResponseSchema, {
      endpoint: "POST /api/tasks/:id/steer",
    });
  }

  async listTaskSteers(taskId: string): Promise<TaskSteerListResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/tasks/${encodeURIComponent(taskId)}/steer`,
    );
    return parseWithFallback(
      raw,
      TaskSteerListResponseSchema,
      EMPTY_TASK_STEER_LIST,
      { endpoint: "GET /api/tasks/:id/steer" },
    );
  }

  async listTasksByIssue(issueId: string): Promise<AgentTask[]> {
    return this.http.fetch(`/api/issues/${issueId}/task-runs`);
  }

  async getIssueUsage(issueId: string): Promise<IssueUsageSummary> {
    return this.http.fetch(`/api/issues/${issueId}/usage`);
  }

  async cancelTask(issueId: string, taskId: string): Promise<AgentTask> {
    return this.http.fetch(`/api/issues/${issueId}/tasks/${taskId}/cancel`, {
      method: "POST",
    });
  }

  async rerunIssue(issueId: string, taskId?: string): Promise<AgentTask> {
    return this.http.fetch(`/api/issues/${issueId}/rerun`, {
      method: "POST",
      body: JSON.stringify(taskId ? { task_id: taskId } : {}),
    });
  }
}
