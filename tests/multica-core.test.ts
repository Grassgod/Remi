import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMulticaApp } from "../src/multica/api.js";
import { MulticaScheduler } from "../src/multica/scheduler.js";
import { MulticaStore } from "../src/multica/store.js";

let db: Database | null = null;

function createStore(): MulticaStore {
  db = new Database(":memory:");
  return new MulticaStore(db);
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("Bun Multica core store", () => {
  it("claims queued tasks by runtime provider and completes them", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const other = store.createAgent({ name: "Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Fix bug", workspaceId: "local" });
    const codexTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Fix the bug" });
    store.createTask({ agentId: other.id, issueId: issue.id, prompt: "Should not claim" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", workspaceId: "local" });

    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(codexTask.id);
    expect(claimed?.status).toBe("dispatched");
    expect(claimed?.agent?.provider).toBe("codex");

    store.startTask(codexTask.id);
    store.appendTaskMessages(codexTask.id, [
      { type: "assistant", content: "done" },
      { type: "usage", content: "{}" },
    ]);
    store.reportTaskUsage(codexTask.id, [{
      provider: "codex",
      model: "test",
      inputTokens: 10,
      outputTokens: 4,
    }]);
    const completed = store.completeTask(codexTask.id, { output: "done", sessionId: "sess_1", workDir: "/tmp/work" });

    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("done");
    expect(completed.sessionId).toBe("sess_1");
    expect(store.listTaskMessages(codexTask.id)).toHaveLength(2);
    expect(store.getTask(codexTask.id)?.usage[0].inputTokens).toBe(10);
  });

  it("honors runtime max concurrency and derives stale liveness", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const first = store.createTask({ agentId: agent.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, prompt: "Second" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", maxConcurrency: 1 });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();

    store.completeTask(first.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);

    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db!.run("UPDATE multica_runtimes SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?", [stale, stale, runtime.id]);
    expect(store.listRuntimes()[0]?.status).toBe("offline");
  });

  it("updates and archives agents from scheduling surfaces", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", allowedTools: ["Read"] });
    const updated = store.updateAgent(agent.id, { name: "Codex Pro", allowedTools: ["Read", "Bash"] });
    expect(updated.name).toBe("Codex Pro");
    expect(updated.allowedTools).toHaveLength(2);

    const task = store.createTask({ agentId: agent.id, prompt: "Before archive" });
    expect(task.id).toStartWith("tsk_");
    expect(store.archiveAgent(agent.id).archivedAt).toBeString();
    expect(store.listAgents()).toHaveLength(0);
    expect(() => store.createTask({ agentId: agent.id, prompt: "After archive" })).toThrow("Agent is archived");

    const runtime = store.registerRuntime({ name: "codex-runtime", provider: "codex" });
    expect(store.claimTask(runtime.id)).toBeNull();

    const defaultAgent = store.ensureDefaultAgent("codex");
    store.archiveAgent(defaultAgent.id);
    expect(store.listAgents()).toHaveLength(0);
    expect(store.ensureDefaultAgent("codex").archivedAt).toBeNull();
  });

  it("skips archived agents when resolving squad autopilots", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "codex" });
    const backup = store.createAgent({ name: "Backup", provider: "codex" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [leader.id, backup.id] });
    const autopilot = store.createAutopilot({
      title: "Resolve squad",
      assigneeType: "squad",
      assigneeId: squad.id,
      issueTitleTemplate: "Use active member",
    });

    store.archiveAgent(leader.id);
    const run = store.runAutopilot(autopilot.id);
    expect(run.status).toBe("running");
    expect(store.getTask(run.taskId!)?.agentId).toBe(backup.id);

    store.archiveAgent(backup.id);
    const skipped = store.runAutopilot(autopilot.id);
    expect(skipped.status).toBe("skipped");
    expect(skipped.failureReason).toBe("No runnable agent");
    expect(() => store.addSquadMember(squad.id, { memberType: "agent", memberId: backup.id })).toThrow("Agent is archived");
  });

  it("recovers dispatched and running tasks for a runtime", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Run" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    expect(store.recoverOrphans(runtime.id)).toBe(1);

    const recovered = store.getTask(task.id);
    expect(recovered?.status).toBe("queued");
    expect(recovered?.runtimeId).toBeNull();
  });

  it("creates projects, squads, and autopilot runs", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Launch", priority: "high" });
    const squad = store.createSquad({
      name: "Core squad",
      leaderId: agent.id,
      memberIds: [agent.id],
    });
    const autopilot = store.createAutopilot({
      title: "Triage regressions",
      projectId: project.id,
      assigneeType: "squad",
      assigneeId: squad.id,
      issueTitleTemplate: "Investigate nightly regression",
    });

    const run = store.runAutopilot(autopilot.id);
    expect(run.status).toBe("running");
    expect(run.issueId).toBeString();
    expect(run.taskId).toBeString();

    const task = store.getTask(run.taskId!);
    expect(task?.agentId).toBe(agent.id);
    expect(task?.prompt).toBe("Investigate nightly regression");

    const updatedProject = store.getProject(project.id);
    expect(updatedProject?.issueCount).toBe(1);
    expect(store.listSquadMembers(squad.id)).toHaveLength(1);
    expect(store.listAutopilotRuns(autopilot.id)[0]?.id).toBe(run.id);
  });

  it("syncs issue and autopilot run state when tasks finish", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Core" });
    const autopilot = store.createAutopilot({
      title: "Regression sweep",
      projectId: project.id,
      assigneeId: agent.id,
      issueTitleTemplate: "Sweep regressions",
    });
    const run = store.runAutopilot(autopilot.id);

    const comment = store.createIssueComment(run.issueId!, { body: "Looks important" });
    expect(comment.body).toBe("Looks important");
    expect(store.listIssueActivity(run.issueId!)).toHaveLength(2);

    store.updateIssue(run.issueId!, { status: "in_progress" });
    store.startTask(run.taskId!);
    store.completeTask(run.taskId!, { output: "fixed" });

    expect(store.getIssue(run.issueId!)?.status).toBe("done");
    expect(store.getProject(project.id)?.doneCount).toBe(1);
    expect(store.listAutopilotRuns(autopilot.id)[0]?.status).toBe("completed");
    expect(store.listIssueActivity(run.issueId!).at(-1)?.type).toBe("task_completed");
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
    const scheduler = new MulticaScheduler({ store, pollIntervalMs: 60_000 });

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
});

describe("Bun Multica API", () => {
  it("serves daemon claim/start/complete endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "hello" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const app = createMulticaApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    expect((await claim.json()).task.id).toBe(task.id);

    const start = await app.request(`/api/daemon/tasks/${task.id}/start`, { method: "POST" });
    expect(start.status).toBe(200);

    const complete = await app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "ok" }),
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).task.status).toBe("completed");

    const status = await app.request(`/api/daemon/tasks/${task.id}/status`);
    expect((await status.json()).status).toBe("completed");
  });

  it("serves issues as first-class records with linked tasks", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/multica/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First class issue", agentId: agent.id, prompt: "Do it" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const listed = await app.request("/api/multica/issues");
    const listBody = await listed.json();
    expect(listBody.issues[0].taskCount).toBe(1);
    expect(listBody.issues[0].latestTaskId).toBe(createdBody.task.id);

    const detail = await app.request(`/api/multica/issues/${createdBody.issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.tasks).toHaveLength(1);
    expect(detailBody.issue.tasks[0].prompt).toBe("Do it");
  });

  it("updates and archives workspace objects", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Ops" });
    const squad = store.createSquad({ name: "Ops squad", leaderId: agent.id });
    const autopilot = store.createAutopilot({
      title: "Ops auto",
      projectId: project.id,
      assigneeType: "squad",
      assigneeId: squad.id,
    });

    expect(store.updateSquad(squad.id, { name: "Ops team" }).name).toBe("Ops team");
    store.removeSquadMember(squad.id, { memberType: "agent", memberId: agent.id });
    expect(store.listSquadMembers(squad.id)).toHaveLength(0);
    expect(store.getSquad(squad.id)?.leaderId).toBeNull();

    expect(store.updateAutopilot(autopilot.id, { status: "paused" }).status).toBe("paused");
    expect(store.archiveAutopilot(autopilot.id).status).toBe("archived");
    expect(store.listAutopilots()).toHaveLength(0);

    expect(store.archiveProject(project.id).status).toBe("cancelled");
    expect(store.archiveSquad(squad.id).archivedAt).toBeString();
    expect(store.listSquads()).toHaveLength(0);
  });

  it("triggers autopilots through API and webhook endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Webhook triage",
      assigneeId: agent.id,
      triggerKind: "webhook",
    });
    const app = createMulticaApp({ store });

    const apiTrigger = await app.request(`/api/multica/autopilots/${autopilot.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "API prompt", payload: { source: "suite" } }),
    });
    expect(apiTrigger.status).toBe(201);
    const apiBody = await apiTrigger.json();
    expect(apiBody.run.source).toBe("api");
    expect(store.getTask(apiBody.run.taskId)?.prompt).toBe("API prompt");

    const webhookTrigger = await app.request(`/api/multica/autopilots/${autopilot.id}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Webhook prompt", event: "opened" }),
    });
    expect(webhookTrigger.status).toBe(201);
    const webhookBody = await webhookTrigger.json();
    expect(webhookBody.run.source).toBe("webhook");
    expect(webhookBody.run.payload.event).toBe("opened");
    expect(store.getIssue(webhookBody.run.issueId)?.title).toBe("Webhook prompt");
  });

  it("syncs scheduler state through autopilot API updates", async () => {
    const store = createStore();
    const scheduler = new MulticaScheduler({ store });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const app = createMulticaApp({ store, scheduler });

    const created = await app.request("/api/multica/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API scheduled",
        assigneeId: agent.id,
        triggerKind: "schedule",
        cronExpression: "*/10 * * * * *",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(scheduler.scheduledIds()).toContain(createdBody.autopilot.id);

    const scheduled = await app.request(`/api/multica/autopilots/${createdBody.autopilot.id}/run-scheduled`, {
      method: "POST",
    });
    expect(scheduled.status).toBe(201);
    expect((await scheduled.json()).run.source).toBe("schedule");

    const paused = await app.request(`/api/multica/autopilots/${createdBody.autopilot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);
    expect(scheduler.scheduledIds()).not.toContain(createdBody.autopilot.id);
    scheduler.stop();
  });
});
