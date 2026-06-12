/**
 * Autopilot dispatch — the run-execution half of autopilots (the Go
 * handler/autopilot.go + autopilot_webhook.go trigger path). When an autopilot
 * fires (from a schedule tick or an inbound webhook), this records an
 * autopilot_run and, for the `create_issue` execution mode, creates the issue
 * assigned to the autopilot's assignee and enqueues an agent task when that
 * assignee is an agent. `run_only` records the run without creating an issue.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { autopilot, autopilotRun, agent as agentTbl, agentTaskQueue } from "../db/schema.js";
import { createIssue, nextIssueNumber } from "../db/queries/issues.js";
import { bus } from "../realtime/bus.js";

export interface DispatchParams {
  autopilotId: string;
  /** Where the firing came from, e.g. "schedule" | "webhook" | "manual". */
  source: string;
  triggerId?: string;
  payload?: unknown;
}

export interface DispatchResult {
  runId: string;
  issueId?: string;
  taskId?: string;
}

/** Fire an autopilot: create its run and (per execution_mode) issue + task. */
export async function dispatchAutopilot(db: Db, params: DispatchParams): Promise<DispatchResult> {
  const [ap] = await db.select().from(autopilot).where(eq(autopilot.id, params.autopilotId));
  if (!ap) throw new Error(`autopilot not found: ${params.autopilotId}`);

  const [run] = await db
    .insert(autopilotRun)
    .values({
      autopilotId: ap.id,
      triggerId: params.triggerId ?? null,
      source: params.source,
      status: "running",
      triggerPayload: params.payload === undefined ? null : (params.payload as object),
    })
    .returning();

  let issueId: string | undefined;
  let taskId: string | undefined;

  if (ap.executionMode === "create_issue") {
    const assigneeIsAgent = ap.assigneeType === "agent";
    const number = await nextIssueNumber(db, ap.workspaceId);
    const created = await createIssue(db, {
      workspaceId: ap.workspaceId,
      title: ap.issueTitleTemplate?.trim() || ap.title,
      number,
      originType: "autopilot",
      originId: ap.id,
      creatorType: assigneeIsAgent ? "agent" : "member",
      creatorId: assigneeIsAgent ? ap.assigneeId : ap.createdById,
      projectId: ap.projectId ?? null,
      assigneeType: ap.assigneeType,
      assigneeId: ap.assigneeId,
    });
    issueId = created.id;

    // When the assignee is an agent, enqueue a task so the daemon picks it up.
    if (assigneeIsAgent) {
      const [ag] = await db.select().from(agentTbl).where(eq(agentTbl.id, ap.assigneeId));
      if (ag) {
        const [task] = await db
          .insert(agentTaskQueue)
          .values({ agentId: ag.id, runtimeId: ag.runtimeId, issueId: created.id, status: "queued" })
          .returning();
        taskId = task!.id;
      }
    }

    bus.publish({ type: "issue.created", workspaceId: ap.workspaceId, payload: { id: created.id } });
  }

  // create_issue runs land on 'issue_created'; run_only completes outright.
  const finalStatus = issueId ? "issue_created" : "completed";
  await db
    .update(autopilotRun)
    .set({ issueId: issueId ?? null, taskId: taskId ?? null, status: finalStatus, completedAt: sql`now()` })
    .where(eq(autopilotRun.id, run!.id));

  await db.update(autopilot).set({ lastRunAt: sql`now()`, updatedAt: sql`now()` }).where(eq(autopilot.id, ap.id));

  return { runId: run!.id, issueId, taskId };
}
