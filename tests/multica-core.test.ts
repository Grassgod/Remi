import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detectMulticaProviders } from "../src/cli/multica.js";
import { createMulticaApp } from "../src/multica/api.js";
import { writeProjectResourceContext } from "../src/multica/daemon.js";
import { buildTaskPrompt } from "../src/multica/prompt.js";
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

  it("manages workspace members and squad membership", () => {
    const store = createStore();
    const squad = store.createSquad({ name: "Product squad" });
    const member = store.createWorkspaceMember({ name: "Ada Lovelace", email: "ada@example.com", role: "owner" });

    expect(store.listWorkspaceMembers()).toHaveLength(1);
    expect(store.updateWorkspaceMember(member.id, { role: "reviewer" }).role).toBe("reviewer");
    expect(store.addSquadMember(squad.id, { memberType: "member", memberId: member.id, role: "reviewer" }).memberType).toBe("member");
    expect(store.listSquadMembers(squad.id)[0]?.memberId).toBe(member.id);

    expect(store.archiveWorkspaceMember(member.id).archivedAt).toBeString();
    expect(store.listWorkspaceMembers()).toHaveLength(0);
    expect(() => store.addSquadMember(squad.id, { memberType: "member", memberId: member.id })).toThrow("Member is archived");
  });

  it("assigns issues to members, agents, and squads", () => {
    const store = createStore();
    const codex = store.createAgent({ name: "Codex", provider: "codex" });
    const leader = store.createAgent({ name: "Squad lead", provider: "claude" });
    const member = store.createWorkspaceMember({ name: "Human reviewer", role: "member" });
    const squad = store.createSquad({ name: "Feature squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Implement assignment" });

    const memberAssigned = store.assignIssue(issue.id, { assigneeType: "member", assigneeId: member.id });
    expect(memberAssigned.issue.assigneeType).toBe("member");
    expect(memberAssigned.task).toBeNull();

    const agentAssigned = store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: codex.id, prompt: "Run codex" });
    expect(agentAssigned.issue.assigneeType).toBe("agent");
    expect(agentAssigned.task?.agentId).toBe(codex.id);
    expect(agentAssigned.task?.prompt).toBe("Run codex");

    const squadAssigned = store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: squad.id });
    expect(squadAssigned.issue.assigneeId).toBe(squad.id);
    expect(squadAssigned.task?.agentId).toBe(leader.id);
    expect(store.getTask(agentAssigned.task!.id)?.status).toBe("cancelled");

    const unassigned = store.assignIssue(issue.id, {});
    expect(unassigned.issue.assigneeType).toBeNull();
    expect(unassigned.task).toBeNull();
    expect(store.getTask(squadAssigned.task!.id)?.status).toBe("cancelled");
  });

  it("queues comment mentions without changing issue assignee", () => {
    const store = createStore();
    const reviewer = store.createAgent({ name: "Review Bot", provider: "codex" });
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Frontend Squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Mention routing" });

    store.createIssueComment(issue.id, {
      body: `Please inspect this [@Review Bot](mention://agent/${reviewer.id}) and @Frontend Squad`,
    });

    const tasks = store.listTasks();
    expect(tasks.map((task) => task.agentId).sort()).toEqual([leader.id, reviewer.id].sort());
    expect(store.getIssue(issue.id)?.assigneeId).toBeNull();
    expect(store.getIssue(issue.id)?.status).toBe("open");
    expect(store.listIssueActivity(issue.id).filter((item) => item.type === "comment_mention_triggered")).toHaveLength(2);
  });

  it("skips agent self-mentions", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Loop Guard", provider: "codex" });
    const issue = store.createIssue({ title: "No recursion" });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: `I already handled this [@Loop Guard](mention://agent/${agent.id})`,
    });

    expect(store.listTasks()).toHaveLength(0);
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

  it("manages project resources and includes them in task prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const project = store.createProject({
      title: "Repo scoped work",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/repo", defaultBranchHint: "main" },
        label: "primary repo",
      }],
    });
    const issue = store.createIssue({ title: "Use resources", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Inspect the repo" });

    expect(store.getProject(project.id)?.resourceCount).toBe(1);
    expect(store.listProjectResources(project.id)[0]?.resourceRef.url).toBe("https://github.com/example/repo");

    const prompt = buildTaskPrompt(store.getTaskWithAgent(task.id)!);
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("https://github.com/example/repo");

    const resourceId = store.listProjectResources(project.id)[0]!.id;
    store.deleteProjectResource(project.id, resourceId);
    expect(store.getProject(project.id)?.resourceCount).toBe(0);
  });

  it("writes project resources into the daemon workdir", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const project = store.createProject({
      title: "Runtime resources",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/runtime", defaultBranchHint: "main" },
        label: "runtime repo",
      }],
    });
    const issue = store.createIssue({ title: "Run with context", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use runtime context" });
    const dir = mkdtempSync(join(tmpdir(), "multica-context-"));

    try {
      writeProjectResourceContext(dir, store.getTaskWithAgent(task.id)!);
      const payload = JSON.parse(readFileSync(join(dir, ".multica", "project", "resources.json"), "utf8"));

      expect(payload.project_id).toBe(project.id);
      expect(payload.project_title).toBe("Runtime resources");
      expect(payload.resources[0]).toEqual({
        id: store.listProjectResources(project.id)[0]!.id,
        resource_type: "github_repo",
        resource_ref: { url: "https://github.com/example/runtime", default_branch_hint: "main" },
        label: "runtime repo",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores issue metadata as a bounded primitive map and includes it in prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const issue = store.createIssue({ title: "Remember PR state" });

    expect(issue.metadata).toEqual({});
    expect(store.setIssueMetadataKey(issue.id, "pr_url", "https://github.com/example/repo/pull/1")).toEqual({
      pr_url: "https://github.com/example/repo/pull/1",
    });
    store.setIssueMetadataKey(issue.id, "ready", true);
    store.setIssueMetadataKey(issue.id, "attempts", 2);
    expect(() => store.setIssueMetadataKey(issue.id, "bad key", "x")).toThrow("key must match");
    expect(() => store.setIssueMetadataKey(issue.id, "nested", { value: "x" })).toThrow("value must be a primitive");

    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use pinned facts" });
    const prompt = buildTaskPrompt(store.getTaskWithAgent(task.id)!);
    expect(prompt).toContain("## Issue Metadata");
    expect(prompt).toContain("pr_url: https://github.com/example/repo/pull/1");

    expect(store.deleteIssueMetadataKey(issue.id, "ready")).toEqual({
      attempts: 2,
      pr_url: "https://github.com/example/repo/pull/1",
    });
  });

  it("persists chat sessions and resumes provider context across turns", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "Private plan" });

    const first = store.sendChatMessage(session.id, { body: "How should we approach this?" });
    expect(first.message.role).toBe("user");
    expect(first.task.chatSessionId).toBe(session.id);

    store.startTask(first.task.id);
    store.completeTask(first.task.id, {
      output: "Start with a small patch.",
      sessionId: "provider-session-1",
      workDir: "/tmp/multica-chat",
    });

    const messages = store.listChatMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.body).toBe("Start with a small patch.");
    expect(store.getChatSession(session.id)?.sessionId).toBe("provider-session-1");

    const second = store.sendChatMessage(session.id, { body: "Continue" });
    expect(second.task.sessionId).toBe("provider-session-1");
    expect(second.task.workDir).toBe("/tmp/multica-chat");
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

describe("Bun Multica CLI", () => {
  it("detects supported daemon providers from PATH", () => {
    const pathEnv = ["/mock/bin", "/other/bin"].join(delimiter);

    expect(detectMulticaProviders({
      pathEnv,
      canExecute: (path) => path === join("/mock/bin", "claude") || path === join("/other/bin", "codex"),
    })).toEqual(["claude", "codex"]);

    expect(detectMulticaProviders({
      pathEnv,
      canExecute: (path) => path === "/mock/bin/gemini",
    })).toEqual([]);
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

  it("assigns issues through API endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Grace Hopper" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/multica/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Assignable issue", assigneeType: "member", assigneeId: member.id }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.issue.assigneeType).toBe("member");
    expect(createdBody.task).toBeNull();

    const assigned = await app.request(`/api/multica/issues/${createdBody.issue.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeType: "agent", assigneeId: agent.id, prompt: "Please implement" }),
    });
    expect(assigned.status).toBe(200);
    const assignedBody = await assigned.json();
    expect(assignedBody.issue.assigneeId).toBe(agent.id);
    expect(assignedBody.task.agentId).toBe(agent.id);
    expect(assignedBody.task.prompt).toBe("Please implement");
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

  it("serves project resource endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const project = store.createProject({ title: "Resources" });

    const created = await app.request(`/api/multica/projects/${project.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_type: "github_repo",
        resource_ref: { url: "git@github.com:example/repo.git", default_branch_hint: "main" },
        label: "ssh repo",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.resource.resourceRef.url).toBe("git@github.com:example/repo.git");

    const listed = await app.request(`/api/multica/projects/${project.id}/resources`);
    expect((await listed.json()).total).toBe(1);

    const detail = await app.request(`/api/multica/projects/${project.id}`);
    expect((await detail.json()).resources).toHaveLength(1);

    const deleted = await app.request(`/api/multica/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(store.listProjectResources(project.id)).toHaveLength(0);
  });

  it("serves issue metadata endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "Metadata API" });

    const set = await app.request(`/api/multica/issues/${issue.id}/metadata/pipeline_status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "waiting_review" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).metadata.pipeline_status).toBe("waiting_review");

    const listed = await app.request(`/api/multica/issues/${issue.id}/metadata`);
    expect((await listed.json()).metadata).toEqual({ pipeline_status: "waiting_review" });

    const deleted = await app.request(`/api/multica/issues/${issue.id}/metadata/pipeline_status`, { method: "DELETE" });
    expect((await deleted.json()).metadata).toEqual({});
  });

  it("serves chat session and message endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/multica/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, title: "API chat" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const sent = await app.request(`/api/multica/chats/${createdBody.session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(sent.status).toBe(201);
    const sentBody = await sent.json();
    expect(sentBody.task.chatSessionId).toBe(createdBody.session.id);

    const detail = await app.request(`/api/multica/chats/${createdBody.session.id}`);
    const detailBody = await detail.json();
    expect(detailBody.messages[0].body).toBe("Hello");

    store.startTask(sentBody.task.id);
    store.completeTask(sentBody.task.id, { output: "Hi there", sessionId: "sess-chat" });
    const messages = await app.request(`/api/multica/chats/${createdBody.session.id}/messages`);
    expect((await messages.json()).messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
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

  it("serves workspace member endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });

    const created = await app.request("/api/multica/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Grace Hopper", email: "grace@example.com", role: "admin" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();

    const listed = await app.request("/api/multica/members");
    expect((await listed.json()).members[0].id).toBe(body.member.id);

    const updated = await app.request(`/api/multica/members/${body.member.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect((await updated.json()).member.role).toBe("reviewer");

    const archived = await app.request(`/api/multica/members/${body.member.id}`, { method: "DELETE" });
    expect((await archived.json()).member.archivedAt).toBeString();
  });
});
