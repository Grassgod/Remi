// Autopilot run state, cron scheduling and trigger claiming, the failure-rate
// auto-pause, analytics, and webhook delivery.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, metricValue, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — autopilots, schedules, and webhooks", () => {
  it("does not create status_changed events when the issue archive sweep runs", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Archive observer", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Done observer",
      assigneeId: agent.id,
      executionMode: "trigger_issue",
    });
    store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
      },
    });
    const issue = store.createIssue({ title: "Already done", status: "done" });
    db!.run(
      "UPDATE multiremi_issues SET completed_at = ? WHERE id = ?",
      ["2026-08-18T00:00:00.000Z", issue.id],
    );
    const eventsBefore = Number((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_system_events WHERE resource_id = ?",
    ).get(issue.id) as { count: number }).count);

    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });
    expect(scheduler.runIssueArchiveSweepOnce(new Date("2026-08-22T08:00:00.000Z")))
      .toEqual([expect.objectContaining({ id: issue.id })]);
    expect(Number((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_system_events WHERE resource_id = ?",
    ).get(issue.id) as { count: number }).count)).toBe(eventsBefore);
    expect(scheduler.tickSystemEvents()).toEqual([]);
  });

  it("syncs issue and autopilot run state when tasks finish", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const runtime = store.registerRuntime({ name: "local-claude", provider: "claude" });
    const project = store.createProject({ title: "Core" });
    const autopilot = store.createAutopilot({
      title: "Regression sweep",
      projectId: project.id,
      assigneeId: agent.id,
      issueTitleTemplate: "Sweep regressions",
    });
    const run = store.runAutopilot(autopilot.id);
    expect(store.getTask(run.taskId!)?.autopilotRunId).toBe(run.id);
    expect(store.getTaskWithAgent(run.taskId!)?.autopilotRunId).toBe(run.id);
    expect(store.listTasks().find((task) => task.id === run.taskId)?.autopilotRunId).toBe(run.id);

    const comment = store.createIssueComment(run.issueId!, { body: "Looks important" });
    expect(comment.body).toBe("Looks important");
    expect(store.listIssueActivity(run.issueId!)).toHaveLength(2);

    store.updateIssue(run.issueId!, { status: "in_progress" });
    expect(store.claimTask(runtime.id)?.id).toBe(run.taskId!);
    store.startTask(run.taskId!);
    store.completeTask(run.taskId!, { output: "fixed" });

    expect(store.getIssue(run.issueId!)?.status).toBe("in_review");
    expect(store.getProject(project.id)?.doneCount).toBe(0);
    expect(store.listAutopilotRuns(autopilot.id)[0]?.status).toBe("completed");
    // Completion appends task_completed, then the agent-reply comment_created.
    const activityTypes = store.listIssueActivity(run.issueId!).map((entry) => entry.type);
    expect(activityTypes).toContain("task_completed");
    expect(activityTypes.at(-1)).toBe("comment_created");
  });

  it("records completed and failed run outcomes for member creators and agent owners", () => {
    const store = createStore();
    const creator = store.createWorkspaceMember({ id: "mem_run_creator", name: "Run Creator" });
    const owner = store.createWorkspaceMember({ id: "mem_run_owner", name: "Agent Owner" });
    const runtime = store.registerRuntime({
      name: "Run notification runtime",
      provider: "codex",
      ownerId: owner.id,
    });
    const agent = store.createAgent({
      name: "Run notification agent",
      provider: "codex",
      runtimeId: runtime.id,
      ownerId: owner.id,
    });
    const completedAutopilot = store.createAutopilot({
      title: "Daily summary",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const failedAutopilot = store.createAutopilot({
      title: "Dependency audit",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "agent",
      createdById: agent.id,
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const completedRun = store.runAutopilot(completedAutopilot.id, { source: "schedule" });
    expect(store.claimTask(runtime.id)?.id).toBe(completedRun.taskId!);
    store.startTask(completedRun.taskId!);
    store.completeTask(completedRun.taskId!, { output: "Published 12 project updates.\nNo blockers." });

    const failedRun = store.runAutopilot(failedAutopilot.id, { source: "api" });
    expect(store.claimTask(runtime.id)?.id).toBe(failedRun.taskId!);
    store.startTask(failedRun.taskId!);
    store.failTask(failedRun.taskId!, { error: "Dependency service unavailable", failureReason: "agent_error" });

    const completed = store.listInboxItems(creator.id).find((item) => item.type === "autopilot_run_completed")!;
    expect(completed.memberId).toBe(creator.id);
    expect(completed.severity).toBe("info");
    expect(completed.title).toBe("Daily summary completed");
    expect(completed.body).toContain("Trigger: schedule");
    expect(completed.body).toContain("Published 12 project updates. No blockers.");
    expect(completed.details).toMatchObject({
      autopilot_id: completedAutopilot.id,
      autopilot_title: "Daily summary",
      run_id: completedRun.id,
      task_id: completedRun.taskId,
      trigger: "schedule",
      duration_seconds: expect.any(Number),
      issue_id: null,
    });

    const failed = store.listInboxItems(owner.id).find((item) => item.type === "autopilot_run_failed")!;
    expect(failed.memberId).toBe(owner.id);
    expect(failed.severity).toBe("attention");
    expect(failed.title).toBe("Dependency audit failed");
    expect(failed.body).toContain("Trigger: api");
    expect(failed.body).toContain("Dependency service unavailable");
    expect(failed.details).toMatchObject({
      autopilot_id: failedAutopilot.id,
      autopilot_title: "Dependency audit",
      run_id: failedRun.id,
      task_id: failedRun.taskId,
      trigger: "api",
      duration_seconds: expect.any(Number),
      issue_id: null,
    });

    const inboxEvents = events.filter((event) => event.type === "inbox:new");
    expect(inboxEvents).toHaveLength(2);
  });

  it("includes autopilot run ids in daemon task payloads", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Autopilot Claude", provider: "claude" });
    const runtime = store.registerRuntime({ name: "autopilot-runtime", provider: "claude" });
    const autopilot = store.createAutopilot({
      title: "Autopilot payload",
      assigneeId: agent.id,
      executionMode: "run_only",
      description: "Execute the full Runbook",
      issueTitleTemplate: "This title is not the Runbook",
    });
    const run = store.runAutopilot(autopilot.id);
    expect(store.getTask(run.taskId!)?.prompt).toBe("Execute the full Runbook");
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const body = await claim.json();
    expect(body.task.id).toBe(run.taskId);
    expect(body.task.autopilot_run_id).toBe(run.id);
    expect(body.task.autopilotRunId).toBeUndefined();
  });

  it("rolls back a task-driven Issue status when its outbox insert fails", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Atomic Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "atomic-runtime", provider: "codex" });
    const issue = store.createIssue({ title: "Atomic task transition", status: "backlog" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Run atomically" });
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    db!.run("DELETE FROM multiremi_system_events");
    db!.exec(`
      CREATE TRIGGER reject_system_event_insert
      BEFORE INSERT ON multiremi_system_events
      BEGIN
        SELECT RAISE(ABORT, 'simulated outbox failure');
      END;
    `);

    expect(() => store.startTask(task.id)).toThrow("simulated outbox failure");
    expect(store.getTask(task.id)?.status).toBe("dispatched");
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_system_events").get()).toEqual({ count: 0 });

    db!.exec("DROP TRIGGER reject_system_event_insert");
    expect(store.startTask(task.id).status).toBe("running");
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_system_events").get()).toEqual({ count: 1 });
  });

  it("schedules active cron autopilots and unschedules inactive ones", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Scheduled triage",
      assigneeId: agent.id,
      triggerKind: "schedule",
      cronExpression: "*/5 * * * * *",
      issueTitleTemplate: "Scheduled prompt",
    });
    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });

    scheduler.start();
    expect(scheduler.scheduledIds()).toContain(autopilot.id);

    const run = scheduler.trigger(autopilot.id);
    expect(run?.source).toBe("schedule");
    expect(store.getTask(run!.taskId!)?.prompt).toBe("Scheduled prompt");

    store.updateAutopilot(autopilot.id, { status: "paused" });
    scheduler.sync();
    expect(scheduler.scheduledIds()).not.toContain(autopilot.id);
    expect(scheduler.trigger(autopilot.id)).toBeNull();
    scheduler.stop();
  });

  it("claims due schedule triggers and recovers lost next_run_at like Go", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Trigger scheduled triage",
      assigneeId: agent.id,
      triggerKind: "manual",
      issueTitleTemplate: "Trigger scheduled prompt",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "schedule",
      cronExpression: "*/5 * * * * *",
      timezone: "UTC",
      label: "Every five seconds",
    });
    expect(trigger.nextRunAt).toBeString();

    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });
    scheduler.sync();
    expect(scheduler.scheduledIds()).not.toContain(autopilot.id);

    db!.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      trigger.id,
    ]);
    const runs = scheduler.tickDueTriggers();
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("schedule");
    expect(runs[0].payload).toMatchObject({
      cronExpression: "*/5 * * * * *",
      triggerId: trigger.id,
      trigger_id: trigger.id,
      timezone: "UTC",
    });
    expect(store.getTask(runs[0].taskId!)?.prompt).toBe("Trigger scheduled prompt");
    const advanced = store.getAutopilotTrigger(trigger.id)!;
    expect(advanced.nextRunAt).toBeString();
    expect(advanced.lastFiredAt).toBeString();

    db!.run("UPDATE multiremi_autopilot_triggers SET next_run_at = NULL WHERE id = ?", [trigger.id]);
    expect(store.recoverLostScheduleTriggers()).toBe(1);
    expect(store.getAutopilotTrigger(trigger.id)!.nextRunAt).toBeString();
    scheduler.stop();
  });

  it("claims due schedule triggers atomically across sqlite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "multiremi-schedule-claim-"));
    const path = join(dir, "multiremi.db");
    const dbA = new Database(path);
    const dbB = new Database(path);
    try {
      const storeA = new MultiremiStore(dbA);
      const storeB = new MultiremiStore(dbB);
      const agent = storeA.createAgent({ name: "Codex", provider: "codex" });
      const autopilot = storeA.createAutopilot({
        title: "Atomic trigger claim",
        assigneeId: agent.id,
        triggerKind: "manual",
      });
      const trigger = storeA.createAutopilotTrigger(autopilot.id, {
        kind: "schedule",
        cronExpression: "*/5 * * * * *",
        timezone: "UTC",
      });
      dbA.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ? WHERE id = ?", [
        new Date(Date.now() - 1_000).toISOString(),
        trigger.id,
      ]);

      const first = storeA.claimDueScheduleTriggers();
      const second = storeB.claimDueScheduleTriggers();
      const claimedIds = [...first, ...second].map((item) => item.id);
      expect(claimedIds.filter((id) => id === trigger.id)).toHaveLength(1);
      expect(storeA.getAutopilotTrigger(trigger.id)?.nextRunAt).toBeNull();
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-pauses active autopilots exceeding the Go failure-rate threshold", () => {
    const store = createStore();
    const creator = store.createWorkspaceMember({ id: "mem_failure_creator", name: "Failure Creator", workspaceId: "local" });
    const owner = store.createWorkspaceMember({ id: "mem_failure_owner", name: "Failure Owner", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex", ownerId: owner.id });
    const offender = store.createAutopilot({
      title: "Failure loop",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const skippedDiluted = store.createAutopilot({
      title: "Failure loop with skips",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "agent",
      createdById: agent.id,
    });
    const outsideLookback = store.createAutopilot({
      title: "Old failures",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const belowThreshold = store.createAutopilot({
      title: "Mixed outcomes",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: creator.id,
    });
    const now = new Date();
    let seq = 0;
    const insertRun = (autopilotId: string, status: "completed" | "failed" | "skipped", createdAt: Date) => {
      const at = createdAt.toISOString();
      db!.run(
        `INSERT INTO multiremi_autopilot_runs (
          id, autopilot_id, source, status, issue_id, task_id, triggered_at,
          completed_at, failure_reason, payload, result, created_at
        ) VALUES (?, ?, 'schedule', ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
        [
          `run_failure_monitor_${++seq}`,
          autopilotId,
          status,
          at,
          at,
          status === "failed" ? "agent_error" : status === "skipped" ? "No runnable agent" : null,
          at,
        ],
      );
    };
    const recent = new Date(now.getTime() - 60 * 60 * 1000);
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 11; i++) insertRun(offender.id, "failed", recent);
    insertRun(offender.id, "completed", recent);
    for (let i = 0; i < 9; i++) insertRun(skippedDiluted.id, "failed", recent);
    insertRun(skippedDiluted.id, "completed", recent);
    for (let i = 0; i < 100; i++) insertRun(skippedDiluted.id, "skipped", recent);
    for (let i = 0; i < 12; i++) insertRun(outsideLookback.id, "failed", old);
    for (let i = 0; i < 8; i++) insertRun(belowThreshold.id, "failed", recent);
    for (let i = 0; i < 4; i++) insertRun(belowThreshold.id, "completed", recent);

    const events: Array<{ type: string; payload: Record<string, unknown>; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000, failureMonitorIntervalMs: 0 });
    const paused = scheduler.runFailureMonitorOnce({
      since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      minRuns: 10,
      failRatioThreshold: 0.9,
    });

    expect(paused.map((candidate) => candidate.autopilot.id)).toEqual([offender.id, skippedDiluted.id]);
    expect(paused.map((candidate) => [candidate.failedRuns, candidate.totalRuns])).toEqual([[11, 12], [9, 10]]);
    expect(store.getAutopilot(offender.id)?.status).toBe("paused");
    expect(store.getAutopilot(skippedDiluted.id)?.status).toBe("paused");
    expect(store.getAutopilot(outsideLookback.id)?.status).toBe("active");
    expect(store.getAutopilot(belowThreshold.id)?.status).toBe("active");

    const updateEvents = events.filter((event) => event.type === "autopilot:updated");
    expect(updateEvents).toHaveLength(2);
    expect(updateEvents.map((event) => (event.payload.autopilot as { id: string }).id)).toEqual([offender.id, skippedDiluted.id]);
    expect(updateEvents.every((event) => event.actorType === "system")).toBe(true);
    expect(updateEvents.every((event) => event.payload.reason === "auto_paused_high_failure_rate")).toBe(true);
    const inboxEvents = events.filter((event) => event.type === "inbox:new");
    expect(inboxEvents).toHaveLength(2);
    expect(inboxEvents.map((event) => (event.payload.item as { memberId: string }).memberId).sort()).toEqual([creator.id, owner.id].sort());

    const creatorInbox = store.listInboxItems(creator.id).find((item) => item.type === "autopilot_paused")!;
    expect(creatorInbox.issueId).toBeNull();
    expect(creatorInbox.severity).toBe("attention");
    expect(creatorInbox.details).toMatchObject({
      autopilot_id: offender.id,
      failed_runs: 11,
      total_runs: 12,
      threshold_min_runs: 10,
      threshold_fail_ratio: 0.9,
      reason: "auto_paused_high_failure_rate",
    });
    const ownerInbox = store.listInboxItems(owner.id).find((item) => item.type === "autopilot_paused")!;
    expect(ownerInbox.issueId).toBeNull();
    expect(ownerInbox.details).toMatchObject({ autopilot_id: skippedDiluted.id, failed_runs: 9, total_runs: 10 });
    expect(scheduler.runFailureMonitorOnce({ since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), minRuns: 10 })).toEqual([]);
  });

  it("records Go-style autopilot analytics events and metrics", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_autopilot_analytics", name: "Autopilot analytics", provider: "codex" });
    const agent = store.createAgent({ name: "Analytics Codex", provider: "codex", runtimeId: runtime.id });
    const autopilot = store.createAutopilot({
      title: "Analytics autopilot",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "member",
      createdById: "usr_analytics",
    });

    const created = store.listAnalyticsEvents({ name: "autopilot_created" })[0]!;
    expect(created.metricsOnly).toBe(false);
    expect(created.distinctId).toBe("usr_analytics");
    expect(created.workspaceId).toBe("local");
    expect(created.properties).toMatchObject({
      autopilot_id: autopilot.id,
      cadence: "manual",
      trigger_kind: "manual",
      source: "manual",
      user_id: "usr_analytics",
      is_demo: false,
    });
    expect(metricValue(store, "multiremi_autopilot_created_total", { cadence: "manual" })).toBe(1);

    const completedRun = store.runAutopilot(autopilot.id, { source: "webhook" });
    expect(store.claimTask(runtime.id)?.id).toBe(completedRun.taskId!);
    store.startTask(completedRun.taskId!);
    store.completeTask(completedRun.taskId!, { output: "done" });

    const started = store.listAnalyticsEvents({ name: "autopilot_run_started" })[0]!;
    expect(started.metricsOnly).toBe(true);
    expect(started.properties).toMatchObject({
      autopilot_id: autopilot.id,
      autopilot_run_id: completedRun.id,
      agent_id: agent.id,
      assignee_type: "agent",
      trigger_source: "webhook",
      trigger_kind: "webhook",
      cadence: "webhook",
      source: "autopilot",
      user_id: "usr_analytics",
      is_demo: false,
    });
    const completed = store.listAnalyticsEvents({ name: "autopilot_run_completed" })[0]!;
    expect(completed.properties).toMatchObject({
      autopilot_id: autopilot.id,
      autopilot_run_id: completedRun.id,
      trigger_kind: "webhook",
      duration_ms: expect.any(Number),
    });
    expect(metricValue(store, "multiremi_autopilot_run_started_total", { cadence: "webhook", trigger_kind: "webhook" })).toBe(1);
    expect(metricValue(store, "multiremi_autopilot_run_terminal_total", { cadence: "webhook", trigger_kind: "webhook", terminal_status: "completed" })).toBe(1);

    const failingAutopilot = store.createAutopilot({
      title: "Failing analytics autopilot",
      assigneeId: agent.id,
      executionMode: "run_only",
      createdByType: "agent",
      createdById: agent.id,
    });
    const failedRun = store.runAutopilot(failingAutopilot.id, { source: "schedule" });
    expect(store.claimTask(runtime.id)?.id).toBe(failedRun.taskId!);
    store.startTask(failedRun.taskId!);
    store.failTask(failedRun.taskId!, { error: "task crashed" });

    const failed = store.listAnalyticsEvents({ name: "autopilot_run_failed" })[0]!;
    expect(failed.distinctId).toBe(`agent:${agent.id}`);
    expect(failed.properties).toMatchObject({
      autopilot_id: failingAutopilot.id,
      autopilot_run_id: failedRun.id,
      agent_id: agent.id,
      trigger_source: "schedule",
      trigger_kind: "schedule",
      cadence: "schedule",
      source: "autopilot",
      failure_reason: "task crashed",
      error_type: "task_error",
      will_retry: false,
    });
    expect(failed.properties).not.toHaveProperty("user_id");
    expect(store.listAnalyticsEvents({ includeMetricsOnly: false }).map((event) => event.name)).toEqual([
      "autopilot_created",
      "autopilot_created",
    ]);
    expect(metricValue(store, "multiremi_autopilot_run_terminal_total", { cadence: "unknown", trigger_kind: "schedule", terminal_status: "failed" })).toBe(1);
  });

  it("records, deduplicates, ignores, rejects, and replays webhook deliveries", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Webhook delivery",
      assigneeId: agent.id,
      triggerKind: "webhook",
    });

    const first = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Delivery prompt", event: "opened" },
      prompt: "Delivery prompt",
      rawBody: JSON.stringify({ prompt: "Delivery prompt", event: "opened" }),
      headers: { "Idempotency-Key": "delivery-1", "Content-Type": "application/json" },
    });

    expect(first.status).toBe("accepted");
    expect(first.delivery.status).toBe("dispatched");
    expect(first.delivery.dedupeKey).toBe("delivery-1");
    expect(first.delivery.contentType).toBe("application/json");
    expect(first.delivery.selectedHeaders).toEqual({ "idempotency-key": "delivery-1" });
    expect(first.run?.source).toBe("webhook");
    expect(first.run?.payload).toMatchObject({
      event: "opened",
      eventPayload: { prompt: "Delivery prompt", event: "opened" },
      request: { contentType: "application/json" },
    });
    expect(store.getIssue(first.run!.issueId!)?.title).toBe("Delivery prompt");

    const duplicate = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Duplicate prompt" },
      headers: { "Idempotency-Key": "delivery-1" },
    });
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.delivery.id).toBe(first.delivery.id);
    expect(duplicate.delivery.attemptCount).toBe(2);
    expect(store.listWebhookDeliveries(autopilot.id)).toHaveLength(1);

    const replay = store.replayWebhookDelivery(autopilot.id, first.delivery.id);
    expect(replay.status).toBe("accepted");
    expect(replay.delivery.replayedFromDeliveryId).toBe(first.delivery.id);
    expect(store.listWebhookDeliveries(autopilot.id)).toHaveLength(2);

    const rejected = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Bad signature" },
      signatureStatus: "invalid",
      headers: { "Idempotency-Key": "bad-signature" },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.delivery.status).toBe("rejected");
    expect(() => store.replayWebhookDelivery(autopilot.id, rejected.delivery.id)).toThrow("Cannot replay");

    store.updateAutopilot(autopilot.id, { status: "paused" });
    const ignored = store.handleAutopilotWebhook(autopilot.id, {
      payload: { prompt: "Paused" },
      headers: { "Idempotency-Key": "paused-delivery" },
    });
    expect(ignored.status).toBe("ignored");
    expect(ignored.delivery.status).toBe("ignored");
    expect(ignored.run).toBeNull();

    store.updateAutopilot(autopilot.id, { status: "active" });
    const filteredTrigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "webhook",
      label: "Pull request opened only",
      eventFilters: [{ event: "pull_request", actions: ["opened"] }],
    });
    const filtered = store.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "closed" },
      rawBody: JSON.stringify({ action: "closed" }),
      headers: { "X-GitHub-Event": "pull_request", "Idempotency-Key": "filtered-delivery" },
      provider: "github",
      triggerId: filteredTrigger.id,
    });
    expect(filtered.status).toBe("ignored");
    expect(filtered.delivery.error).toBe("event_filtered");
    expect(filtered.run).toBeNull();

    const allowed = store.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "opened" },
      rawBody: JSON.stringify({ action: "opened" }),
      headers: { "X-GitHub-Event": "pull_request", "Idempotency-Key": "allowed-delivery" },
      provider: "github",
      triggerId: filteredTrigger.id,
    });
    expect(allowed.status).toBe("accepted");
    expect(allowed.run?.payload).toMatchObject({
      event: "github.pull_request.opened",
      eventPayload: { action: "opened" },
    });

    const typed = store.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "published" },
      rawBody: "\uFEFF" + JSON.stringify({ action: "published" }),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": "typed-delivery",
        "User-Agent": "WebhookClient/1.0",
        "X-Event-Type": "deploy.published",
        "X-Hub-Signature-256": "sha256=redacted",
      },
    });
    expect(typed.status).toBe("accepted");
    expect(typed.delivery.contentType).toBe("application/json");
    expect(typed.delivery.selectedHeaders).toEqual({
      "user-agent": "WebhookClient/1.0",
      "x-event-type": "deploy.published",
      "idempotency-key": "typed-delivery",
      "x-hub-signature-256-present": true,
    });
    expect(typed.run?.payload).toMatchObject({
      event: "deploy.published",
      eventPayload: { action: "published" },
      request: { contentType: "application/json" },
    });
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "dispatched" })).toBe(3);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "github", status: "dispatched" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "rejected" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "ignored" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "github", status: "ignored" })).toBe(1);
    expect(metricValue(store, "multiremi_webhook_delivery_total", { provider: "generic", status: "duplicate" })).toBe(0);
  });

  it("dispatches a completed Issue system event once into a new Issue Session", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Wiki maintainer", provider: "codex" });
    const project = store.createProject({ title: "Knowledge project" });
    const issue = store.createIssue({ title: "Ship feature", projectId: project.id, status: "in_review" });
    const autopilot = store.createAutopilot({
      title: "Maintain Wiki",
      projectId: project.id,
      assigneeId: agent.id,
      executionMode: "trigger_issue",
      sessionPolicy: "new",
      workspacePolicy: "reuse_issue",
      description: "Inspect the completed work and reconcile the Wiki",
      issueTitleTemplate: "Review the completed Issue and maintain Wiki",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
        projectId: project.id,
      },
    });
    const otherProject = store.createProject({ title: "Other project" });
    expect(() => store.updateAutopilotTrigger(autopilot.id, trigger.id, {
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
        projectId: otherProject.id,
      },
    })).toThrow("must match the Autopilot project");
    expect(() => store.updateAutopilot(autopilot.id, { executionMode: "run_only" })).toThrow(
      "system_event triggers require execution_mode trigger_issue",
    );
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "schedule",
      cronExpression: "0 9 * * *",
    })).toThrow("trigger_issue execution does not support schedule or webhook triggers");
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "webhook",
    })).toThrow("trigger_issue execution does not support schedule or webhook triggers");

    const scheduled = store.createAutopilot({
      title: "Scheduled run",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    store.createAutopilotTrigger(scheduled.id, {
      kind: "schedule",
      cronExpression: "0 9 * * *",
    });
    expect(() => store.updateAutopilot(scheduled.id, { executionMode: "trigger_issue" }))
      .toThrow("trigger_issue execution does not support schedule or webhook triggers");

    store.updateIssue(issue.id, { status: "done" });
    const eventRow = db!.query(
      "SELECT id FROM multiremi_system_events WHERE resource_id = ? AND status = 'pending'",
    ).get(issue.id) as { id: string };
    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });
    const runs = scheduler.tickSystemEvents();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      autopilotId: autopilot.id,
      source: "system_event",
      triggerId: trigger.id,
      eventId: eventRow.id,
      issueId: issue.id,
      status: "running",
    });
    expect(runs[0].issueSessionId).toBeString();
    expect(store.getTask(runs[0].taskId!)?.issueSessionId).toBe(runs[0].issueSessionId);
    expect(store.getTask(runs[0].taskId!)?.prompt).toBe("Inspect the completed work and reconcile the Wiki");
    expect(store.getIssue(issue.id)?.status).toBe("done");
    expect(store.listIssueSessions(issue.id, true)).toHaveLength(2);
    expect(store.getSystemEvent(eventRow.id)?.status).toBe("processed");

    expect(scheduler.tickSystemEvents()).toEqual([]);
    const duplicate = store.runAutopilot(autopilot.id, {
      source: "system_event",
      triggerId: trigger.id,
      eventId: eventRow.id,
      triggerIssueId: issue.id,
    });
    expect(duplicate.id).toBe(runs[0].id);
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it("does not feed automation-owned task status writes back into the same system event trigger", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Review maintainer", provider: "codex" });
    const runtime = store.registerRuntime({ name: "review-runtime", provider: "codex" });
    const issue = store.createIssue({ title: "Review without a loop", status: "todo" });
    const autopilot = store.createAutopilot({
      title: "Review on in_review",
      assigneeId: agent.id,
      executionMode: "trigger_issue",
    });
    store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "in_review" }],
      },
    });

    store.updateIssue(issue.id, { status: "in_review" });
    const initialEvent = db!.query(
      "SELECT id FROM multiremi_system_events WHERE resource_id = ? AND status = 'pending'",
    ).get(issue.id) as { id: string };
    const [run] = store.dispatchPendingSystemEvents();
    const task = store.getTask(run.taskId!)!;
    expect(task.assignmentSourceEventId).toBe(initialEvent.id);

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "reviewed" });

    // queued/running/completed lifecycle transitions stay auditable in the
    // outbox, but none may recursively create another automation task.
    expect(store.dispatchPendingSystemEvents()).toEqual([]);
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);

    // Suppression belongs to the automation lineage, not to the in_review
    // status itself: a later user transition still starts a fresh run.
    store.updateIssue(issue.id, { status: "todo" });
    store.updateIssue(issue.id, { status: "in_review" });
    expect(store.dispatchPendingSystemEvents()).toHaveLength(1);
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(2);
  });

  it("reuses the most recently updated active Issue Session when configured", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Wiki maintainer", provider: "claude" });
    const issue = store.createIssue({ title: "Reuse session", status: "in_review" });
    const latest = store.createIssueSession(issue.id, { title: "Latest context" });
    db!.run(
      "UPDATE multiremi_issue_sessions SET updated_at = ? WHERE id = ?",
      ["2099-01-01T00:00:00.000Z", latest.id],
    );
    const autopilot = store.createAutopilot({
      title: "Reuse Wiki session",
      assigneeId: agent.id,
      executionMode: "trigger_issue",
      sessionPolicy: "reuse_latest",
    });
    store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
      },
    });

    store.updateIssue(issue.id, { status: "done" });
    const [run] = store.dispatchPendingSystemEvents();
    expect(run.issueSessionId).toBe(latest.id);
    expect(store.listIssueSessions(issue.id, true)).toHaveLength(2);
  });

  it("claims each pending system event once across sqlite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "multiremi-system-event-claim-"));
    const path = join(dir, "multiremi.db");
    const dbA = new Database(path);
    const dbB = new Database(path);
    try {
      const storeA = new MultiremiStore(dbA);
      const storeB = new MultiremiStore(dbB);
      const issue = storeA.createIssue({ title: "Atomic event claim", status: "in_review" });
      storeA.updateIssue(issue.id, { status: "done" });

      const event = dbA.query(
        "SELECT id FROM multiremi_system_events WHERE resource_id = ? AND status = 'pending'",
      ).get(issue.id) as { id: string };
      const first = storeA.claimPendingSystemEvents();
      const second = storeB.claimPendingSystemEvents();
      const claimedIds = [...first, ...second].map((item) => item.id);

      expect(claimedIds.filter((id) => id === event.id)).toHaveLength(1);
      expect(storeA.getSystemEvent(event.id)?.status).toBe("processing");
      expect(storeA.getSystemEvent(event.id)?.attemptCount).toBe(1);
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requeues a system event when its trigger execution fails", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Wiki maintainer", provider: "codex" });
    const issue = store.createIssue({ title: "Retry missing Issue", status: "in_review" });
    const autopilot = store.createAutopilot({
      title: "Retry Wiki maintenance",
      assigneeId: agent.id,
      executionMode: "trigger_issue",
    });
    store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
      },
    });

    store.updateIssue(issue.id, { status: "done" });
    const event = db!.query(
      "SELECT id FROM multiremi_system_events WHERE resource_id = ? AND status = 'pending'",
    ).get(issue.id) as { id: string };
    db!.run("DELETE FROM multiremi_issues WHERE id = ?", [issue.id]);

    expect(store.dispatchPendingSystemEvents()).toEqual([]);
    const retried = store.getSystemEvent(event.id)!;
    expect(retried.status).toBe("pending");
    expect(retried.attemptCount).toBe(1);
    expect(retried.lastError).toContain("Issue not found");
    expect(new Date(retried.availableAt).getTime()).toBeGreaterThan(Date.now());
    expect(store.listAutopilotRuns(autopilot.id)).toEqual([]);
    expect(store.listTasks()).toEqual([]);
  });

  it("dedupes repository Wiki build runs by active build and pinned-revision key", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Atlas · LLM Wiki", provider: "claude" });
    const runtime = store.registerRuntime({ name: "wiki-runtime", provider: "claude" });
    const autopilot = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      assigneeId: agent.id,
      executionMode: "run_only",
      description: "Update the repository wiki",
    });
    const manualInput = {
      source: "api" as const,
      repositoryId: "repo_x",
      dedupeKey: "repo_x:bootstrap_repository:head",
      payload: { atlas_repository_id: "repo_x", atlas_mode: "bootstrap_repository" },
    };

    const first = store.runAutopilot(autopilot.id, manualInput);
    expect(first.status).toBe("running");
    expect(first.repositoryId).toBe("repo_x");
    expect(first.dedupeKey).toBe("repo_x:bootstrap_repository:head");
    expect(first.deduplicated).toBeUndefined();

    // A second request while the build is active returns the existing run.
    const duplicate = store.runAutopilot(autopilot.id, manualInput);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.deduplicated).toBe(true);
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);

    // A failed build never blocks a retry.
    expect(store.claimTask(runtime.id)?.id).toBe(first.taskId!);
    store.startTask(first.taskId!);
    store.failTask(first.taskId!, { error: "clone failed" });
    expect(store.getAutopilotRun(first.id)?.status).toBe("failed");
    const retry = store.runAutopilot(autopilot.id, manualInput);
    expect(retry.id).not.toBe(first.id);
    expect(retry.deduplicated).toBeUndefined();

    // A completed HEAD build targets a moving revision — rebuilds stay allowed.
    expect(store.claimTask(runtime.id)?.id).toBe(retry.taskId!);
    store.startTask(retry.taskId!);
    store.completeTask(retry.taskId!, { output: "ok" });
    const rebuild = store.runAutopilot(autopilot.id, manualInput);
    expect(rebuild.id).not.toBe(retry.id);
    expect(store.claimTask(runtime.id)?.id).toBe(rebuild.taskId!);
    store.startTask(rebuild.taskId!);
    store.completeTask(rebuild.taskId!, { output: "ok" });

    // A completed pinned-revision run without a Wiki write is not
    // authoritative and must not block retry.
    const pinnedInput = {
      source: "scm_event" as const,
      repositoryId: "repo_x",
      dedupeKey: "repo_x:incremental_update:abc123",
    };
    const pinned = store.runAutopilot(autopilot.id, pinnedInput);
    expect(pinned.deduplicated).toBeUndefined();
    expect(store.claimTask(runtime.id)?.id).toBe(pinned.taskId!);
    store.startTask(pinned.taskId!);
    store.completeTask(pinned.taskId!, { output: "ok" });
    expect(store.isRepositoryWikiRunPublished(pinned.id)).toBe(false);
    const unpublishedRetry = store.runAutopilot(autopilot.id, pinnedInput);
    expect(unpublishedRetry.id).not.toBe(pinned.id);
    expect(unpublishedRetry.deduplicated).toBeUndefined();

    // A document attributed to the retry task is store-owned publication
    // evidence, so later delivery for the same revision reuses that run.
    expect(store.claimTask(runtime.id)?.id).toBe(unpublishedRetry.taskId!);
    store.startTask(unpublishedRetry.taskId!);
    store.createRepositoryWikiDoc("local", "repo_x", {
      path: "task-attributed.md",
      title: "Task attributed",
      sourceTaskId: unpublishedRetry.taskId,
    });
    store.completeTask(unpublishedRetry.taskId!, { output: "published" });
    expect(store.isRepositoryWikiRunPublished(unpublishedRetry.id)).toBe(true);
    const replay = store.runAutopilot(autopilot.id, pinnedInput);
    expect(replay.id).toBe(unpublishedRetry.id);
    expect(replay.deduplicated).toBe(true);

    // A revision already present in Wiki history is a legitimate no-op.
    store.createRepositoryWikiDoc("local", "repo_x", {
      path: "revision-attributed.md",
      title: "Revision attributed",
      sourceRevision: "def456",
    });
    const noOpInput = {
      ...pinnedInput,
      dedupeKey: "repo_x:incremental_update:def456",
    };
    const noOp = store.runAutopilot(autopilot.id, noOpInput);
    expect(store.claimTask(runtime.id)?.id).toBe(noOp.taskId!);
    store.startTask(noOp.taskId!);
    store.completeTask(noOp.taskId!, { output: "no changes required" });
    expect(store.isRepositoryWikiRunPublished(noOp.id)).toBe(true);
    expect(store.runAutopilot(autopilot.id, noOpInput)).toMatchObject({
      id: noOp.id,
      deduplicated: true,
    });

    // Runs without repository scoping (every other autopilot) never dedupe.
    const other = store.createAutopilot({
      title: "Not a wiki autopilot",
      assigneeId: agent.id,
      executionMode: "run_only",
      description: "Do something else",
    });
    const a = store.runAutopilot(other.id);
    const b = store.runAutopilot(other.id);
    expect(a.id).not.toBe(b.id);
    expect(store.listAutopilotRuns(other.id)).toHaveLength(2);
  });

  it("rejects forged or inconsistent repository Wiki build scope at the store boundary", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const atlas = store.createAgent({ name: "Atlas · LLM Wiki", provider: "claude" });
    const userAgent = store.createAgent({ name: "User Wiki", provider: "claude" });
    const userOwned = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      assigneeId: userAgent.id,
      executionMode: "run_only",
    });
    const serverOwned = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      assigneeId: atlas.id,
      executionMode: "run_only",
    });

    expect(() => store.runAutopilot(userOwned.id, {
      repository_id: "repo_private",
      dedupe_key: "repo_private:incremental_update:abc123",
    })).toThrow("server-owned Atlas Repository Wiki autopilot");
    expect(() => store.runAutopilot(serverOwned.id, {
      repositoryId: "repo_private",
    })).toThrow("repository_id and dedupe_key together");
    expect(() => store.runAutopilot(serverOwned.id, {
      repositoryId: "repo_private",
      dedupeKey: "repo_other:incremental_update:abc123",
    })).toThrow("must start with its repository_id segment");

    expect(store.listAutopilotRuns(serverOwned.id)).toEqual([]);
    const ordinaryRun = store.runAutopilot(userOwned.id);
    expect(ordinaryRun).toMatchObject({ repositoryId: null, dedupeKey: null });
  });

  it("returns structured trigger summaries in slim run listings", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_widgets",
        name: "widgets",
        url: "git@github.com:acme/widgets.git",
        source: "github",
        default_branch: "main",
      }],
    });
    const agent = store.createAgent({ name: "Atlas · LLM Wiki", provider: "claude" });
    const autopilot = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      assigneeId: agent.id,
      executionMode: "run_only",
      description: "Update the repository wiki",
    });

    const mergedRun = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      payload: {
        event: {
          id: "sce_merge",
          type: "change.merged",
          repositoryId: "repo_widgets",
          occurredAt: "2026-08-24T00:00:00.000Z",
        },
        data: { number: 7, title: "Add docs", target_branch: "main", merge_sha: "abc123" },
      },
    });
    const branchRun = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      payload: {
        event: {
          id: "sce_branch",
          type: "default_branch.updated",
          repositoryId: "repo_widgets",
          occurredAt: "2026-08-24T00:01:00.000Z",
        },
        data: { branch: "main", head_sha: "def456" },
      },
    });
    const webhookRun = store.runAutopilot(autopilot.id, {
      source: "webhook",
      payload: {
        event: "github.pull_request.opened",
        eventPayload: { action: "opened" },
        request: { receivedAt: "2026-08-24T00:02:00.000Z" },
      },
    });
    const scheduleRun = store.runAutopilot(autopilot.id, {
      source: "schedule",
      payload: { cronExpression: "0 9 * * *", triggerId: "trg_sched", timezone: "UTC" },
    });
    const wikiRun = store.runAutopilot(autopilot.id, {
      source: "api",
      repositoryId: "repo_widgets",
      dedupeKey: "repo_widgets:bootstrap_repository:head",
      payload: { atlas_repository_id: "repo_widgets", atlas_mode: "bootstrap_repository" },
    });

    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/autopilots/${autopilot.id}/runs`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const byId = new Map<string, any>(body.runs.map((run: any) => [run.id, run]));
    expect(body.runs.every((run: any) => run.trigger_payload === null)).toBe(true);

    expect(byId.get(mergedRun.id)?.trigger_summary).toEqual({
      event_type: "change.merged",
      repository_id: "repo_widgets",
      repository_name: "widgets",
      change_number: 7,
      change_title: "Add docs",
      target_branch: "main",
      source_revision: "abc123",
      occurred_at: "2026-08-24T00:00:00.000Z",
      wiki_build: false,
    });
    expect(byId.get(branchRun.id)?.trigger_summary).toEqual({
      event_type: "default_branch.updated",
      repository_id: "repo_widgets",
      repository_name: "widgets",
      change_number: null,
      change_title: null,
      target_branch: "main",
      source_revision: "def456",
      occurred_at: "2026-08-24T00:01:00.000Z",
      wiki_build: false,
    });
    expect(byId.get(webhookRun.id)?.trigger_summary).toEqual({
      event_type: "github.pull_request.opened",
      repository_id: null,
      repository_name: null,
      change_number: null,
      change_title: null,
      target_branch: null,
      source_revision: null,
      occurred_at: "2026-08-24T00:02:00.000Z",
      wiki_build: false,
    });
    expect(byId.get(scheduleRun.id)?.trigger_summary).toEqual({
      event_type: "schedule",
      repository_id: null,
      repository_name: null,
      change_number: null,
      change_title: null,
      target_branch: null,
      source_revision: null,
      occurred_at: null,
      wiki_build: false,
    });
    expect(byId.get(wikiRun.id)?.trigger_summary).toEqual({
      event_type: null,
      repository_id: "repo_widgets",
      repository_name: "widgets",
      change_number: null,
      change_title: null,
      target_branch: null,
      source_revision: null,
      occurred_at: null,
      wiki_build: true,
    });
  });

  it("rolls back the reserved run when trigger_issue has no triggering Issue", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Wiki maintainer", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Missing Issue",
      assigneeId: agent.id,
      executionMode: "trigger_issue",
    });

    expect(() => store.runAutopilot(autopilot.id)).toThrow("trigger_issue_id");
    expect(store.listAutopilotRuns(autopilot.id)).toEqual([]);
    expect(store.listTasks()).toEqual([]);
  });
});
