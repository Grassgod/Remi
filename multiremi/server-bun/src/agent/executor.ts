/**
 * Agent task executor — the bridge between the task queue and the unified ACP
 * provider. This is where the Go daemon's per-agent execenv collapses: a queued
 * agent_task_queue row resolves to its agent + runtime, builds the prompt from
 * the linked issue, and runs through the ONE AcpProvider (any of the 12 agent
 * types). The Go daemon's 12 per-agent execution paths become this single call.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/client.js";
import { agent as agentTbl, agentRuntime, agentTaskQueue, comment, issue } from "../db/schema.js";
import { bus } from "../realtime/bus.js";
import { AcpProvider } from "./acp/index.js";
import { resolveRepoPlan } from "../db/queries/projectResources.js";
import { getWorkspacePrefix } from "../db/queries/issues.js";
import { prepareWorkdir, removeWorktree } from "./repo.js";
import { buildTaskPrompt, type PromptComment, type PromptIssue } from "./prompt.js";
import type { AgentEvent } from "./types.js";

export interface ExecuteTaskOptions {
  /** Override the ACP executable (tests inject the mock ACP agent). */
  executable?: string;
  /** Stream callback for live progress. */
  onEvent?: (e: AgentEvent) => void;
  /** Root under which per-task git worktrees are created. */
  workBaseDir?: string;
  /** This daemon's id — scopes which `local_directory` resources match. */
  daemonId?: string;
}

/** Resolved working directory for a task + its teardown (worktree removal). */
interface WorkdirPlan {
  cwd?: string;
  cleanup?: () => Promise<void>;
}

/** First 8 hex chars of a UUID (dashes stripped) — the worktree dir name. */
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/**
 * Turn a task's project resource into the agent's working directory:
 *   - explicit `task.workDir`  → run there (no teardown);
 *   - `local_directory`        → run in-place on the pinned path (no teardown);
 *   - `github_repo`            → check out a fresh git worktree (teardown removes it);
 *   - none                     → no repo; run in the process cwd.
 */
async function setupWorkdir(db: Db, task: typeof agentTaskQueue.$inferSelect, opts: ExecuteTaskOptions): Promise<WorkdirPlan> {
  if (task.workDir) return { cwd: task.workDir };
  if (!task.issueId) return {};
  const [iss] = await db.select({ projectId: issue.projectId }).from(issue).where(eq(issue.id, task.issueId));
  if (!iss?.projectId) return {};

  const plan = await resolveRepoPlan(db, iss.projectId, opts.daemonId);
  if (plan.kind === "local") return { cwd: plan.localPath };
  if (plan.kind === "repo") {
    const base = opts.workBaseDir ?? join(tmpdir(), "multimira-work");
    const r = await prepareWorkdir(base, plan.url, shortId(task.id), plan.branchHint);
    return { cwd: r.workdir, cleanup: () => removeWorktree(r.barePath, r.workdir, r.branch) };
  }
  return {};
}

export type TaskOutcome =
  | { status: "completed"; text: string; sessionId: string }
  | { status: "failed"; error: string };

function asEnv(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export async function executeAgentTask(
  db: Db,
  provider: AcpProvider,
  taskId: string,
  opts: ExecuteTaskOptions = {},
): Promise<TaskOutcome> {
  const [task] = await db.select().from(agentTaskQueue).where(eq(agentTaskQueue.id, taskId));
  if (!task) return failResult("task not found");

  const [ag] = await db.select().from(agentTbl).where(eq(agentTbl.id, task.agentId));
  if (!ag) return fail(db, taskId, "agent not found");
  const [rt] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, ag.runtimeId));
  if (!rt) return fail(db, taskId, "runtime not found");

  // Build the prompt by EMBEDDING the task context (issue + recent conversation)
  // — the ACP agents receive context in the prompt, not via a CLI round-trip.
  let promptIssue: PromptIssue | null = null;
  let promptComments: PromptComment[] = [];
  if (task.issueId) {
    const [iss] = await db.select().from(issue).where(eq(issue.id, task.issueId));
    if (iss) {
      const prefix = await getWorkspacePrefix(db, iss.workspaceId);
      promptIssue = {
        identifier: prefix ? `${prefix}-${iss.number}` : `#${iss.number}`,
        title: iss.title,
        description: iss.description,
        status: iss.status,
        acceptanceCriteria: iss.acceptanceCriteria,
      };
      // The most recent comments (chronological), as conversation context.
      const recent = await db
        .select({ authorType: comment.authorType, content: comment.content })
        .from(comment)
        .where(eq(comment.issueId, iss.id))
        .orderBy(desc(comment.createdAt))
        .limit(20);
      promptComments = recent.reverse().map((c) => ({ author: c.authorType, content: c.content }));
    }
  }
  const prompt = buildTaskPrompt({
    instructions: ag.instructions,
    issue: promptIssue,
    comments: promptComments,
    triggeredByComment: task.triggerCommentId != null,
  });

  // Resolve the working directory (git worktree / local dir) before marking the
  // task running, so a checkout failure fails the task instead of half-running it.
  let work: WorkdirPlan;
  try {
    work = await setupWorkdir(db, task, opts);
  } catch (e) {
    return fail(db, taskId, `workdir setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await db
    .update(agentTaskQueue)
    .set({ status: "running", startedAt: sql`now()`, workDir: work.cwd ?? task.workDir })
    .where(eq(agentTaskQueue.id, taskId));

  // Kanban lifecycle: picking up an issue task moves the card to in_progress
  // (the Go agents did this themselves via the CLI; the embedded-prompt ACP
  // agents have no write path, so the executor owns the board transitions).
  if (task.issueId) {
    await db
      .update(issue)
      .set({ status: "in_progress", updatedAt: sql`now()` })
      .where(and(eq(issue.id, task.issueId), inArray(issue.status, ["todo", "backlog"])));
    bus.publish({ type: "issue.updated", workspaceId: "", payload: { id: task.issueId } });
  }

  try {
    const gen = provider.execute({
      agentType: rt.provider, // the runtime's provider IS the ACP agent type
      prompt,
      model: ag.model,
      env: asEnv(ag.customEnv),
      permissionMode: "bypassPermissions",
      executable: opts.executable,
      cwd: work.cwd,
    });

    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      opts.onEvent?.(next.value);
    }

    await db
      .update(agentTaskQueue)
      .set({
        status: "completed",
        result: { text: result.text, stopReason: result.stopReason },
        sessionId: result.sessionId,
        completedAt: sql`now()`,
      })
      .where(eq(agentTaskQueue.id, taskId));

    // Deliver the outcome to the board: the agent's final message lands as an
    // issue comment and the card moves to in_review for human review.
    if (task.issueId) {
      await reportOutcomeToIssue(db, task.issueId, task.agentId, result.text || "(no output)", "in_review");
    }
    return { status: "completed", text: result.text, sessionId: result.sessionId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (task.issueId) {
      await reportOutcomeToIssue(db, task.issueId, task.agentId, `任务执行失败：${msg}`, null).catch(() => {});
    }
    return fail(db, taskId, msg);
  } finally {
    await work.cleanup?.().catch(() => {});
  }
}

/**
 * Write a task outcome back onto the issue: an agent-authored comment with the
 * final message, plus (optionally) a status transition out of in_progress.
 */
async function reportOutcomeToIssue(
  db: Db,
  issueId: string,
  agentId: string,
  text: string,
  nextStatus: "in_review" | null,
): Promise<void> {
  const [iss] = await db
    .select({ workspaceId: issue.workspaceId })
    .from(issue)
    .where(eq(issue.id, issueId));
  if (!iss) return;
  const content = text.length > 20000 ? text.slice(0, 20000) + "\n… (truncated)" : text;
  await db.insert(comment).values({
    workspaceId: iss.workspaceId,
    issueId,
    authorType: "agent",
    authorId: agentId,
    content,
    type: "comment",
  });
  if (nextStatus) {
    await db
      .update(issue)
      .set({ status: nextStatus, updatedAt: sql`now()` })
      .where(and(eq(issue.id, issueId), eq(issue.status, "in_progress")));
  }
  bus.publish({ type: "comment.created", workspaceId: "", payload: { issue_id: issueId } });
}

async function fail(db: Db, taskId: string, error: string): Promise<TaskOutcome> {
  await db
    .update(agentTaskQueue)
    .set({ status: "failed", error, completedAt: sql`now()` })
    .where(eq(agentTaskQueue.id, taskId));
  return failResult(error);
}

function failResult(error: string): TaskOutcome {
  return { status: "failed", error };
}
