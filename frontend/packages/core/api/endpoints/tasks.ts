import { MessagesEndpoints } from "./messages";
import { turnToTask } from "../turn-task";
import type {
  AgentActivityBucket,
  AgentRunCount,
  AgentTask,
  IssueUsageSummary,
} from "../../types";
import type { HttpClient } from "../http";
import { parseStrictResponse } from "../schema";
import { TaskTraceReadSchema, type TaskTraceRead } from "../schemas/tasks";

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
    return { tasks: (await this.listTasksByIssue(issueId)).filter(task => ["queued", "running", "awaiting_human"].includes(task.status)) };
  }

  async getTaskTrace(taskId: string, afterSeq = 0, limit = 500, turnId?: string): Promise<TaskTraceRead> {
    const query = new URLSearchParams({ after_seq: String(afterSeq), limit: String(limit) });
    if (turnId) query.set("attempt_id", taskId);
    const raw = await this.http.fetch<unknown>(`/api/turns/${encodeURIComponent(turnId ?? taskId)}/trace?${query}`);
    return parseStrictResponse(raw, TaskTraceReadSchema, { endpoint: "GET /api/turns/:id/trace" });
  }

  async listTasksByIssue(issueId: string): Promise<AgentTask[]> {
    const messages = new MessagesEndpoints(this.http);
    const tasks: AgentTask[] = [];
    let cursor: string | undefined;
    do { const page = await messages.listTurns({ issue: issueId, cursor, limit: 100 }); tasks.push(...page.turns.map(turn => turnToTask(turn))); cursor = page.next_cursor ?? undefined; } while (cursor);
    return tasks;
  }

  async getIssueUsage(issueId: string): Promise<IssueUsageSummary> {
    return this.http.fetch(`/api/issues/${issueId}/usage`);
  }

  async cancelTask(issueId: string, taskId: string): Promise<AgentTask> {
    const task = (await this.listTasksByIssue(issueId)).find(task => task.id === taskId || task.turn_id === taskId);
    if (!task?.turn_id) throw new Error("Turn not found");
    return turnToTask((await new MessagesEndpoints(this.http).controlTurn(task.turn_id, "cancel")).turn);
  }

  async rerunIssue(issueId: string, taskId?: string): Promise<AgentTask> {
    const tasks = await this.listTasksByIssue(issueId);
    const task = taskId ? tasks.find(task => task.id === taskId || task.turn_id === taskId) : tasks[0];
    if (!task?.turn_id) throw new Error("Turn not found");
    return turnToTask((await new MessagesEndpoints(this.http).retryTurn(task.turn_id)).turn);
  }
}
