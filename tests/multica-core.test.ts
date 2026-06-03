import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detectMulticaProviders } from "../src/cli/multica.js";
import { createMulticaApp, startMulticaServer } from "../src/multica/api.js";
import { renderMulticaDashboardHtml } from "../src/multica/dashboard.js";
import { writeAgentSkillContext, writeProjectResourceContext } from "../src/multica/daemon.js";
import { buildTaskPrompt } from "../src/multica/prompt.js";
import { MulticaScheduler } from "../src/multica/scheduler.js";
import { MulticaStore } from "../src/multica/store.js";

let db: Database | null = null;
let previousUploadDir: string | undefined;
let uploadDir: string | null = null;
let previousFetch: typeof globalThis.fetch | null = null;

function createStore(): MulticaStore {
  db = new Database(":memory:");
  return new MulticaStore(db);
}

afterEach(() => {
  db?.close();
  db = null;
  if (uploadDir) {
    rmSync(uploadDir, { recursive: true, force: true });
    uploadDir = null;
  }
  if (previousUploadDir === undefined) delete process.env.MULTICA_UPLOAD_DIR;
  else process.env.MULTICA_UPLOAD_DIR = previousUploadDir;
  previousUploadDir = undefined;
  if (previousFetch) {
    globalThis.fetch = previousFetch;
    previousFetch = null;
  }
});

function useUploadDir(): string {
  previousUploadDir = process.env.MULTICA_UPLOAD_DIR;
  uploadDir = mkdtempSync(join(tmpdir(), "multica-upload-"));
  process.env.MULTICA_UPLOAD_DIR = uploadDir;
  return uploadDir;
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => handler(String(input))) as typeof globalThis.fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nextWebSocketMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 2000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    }, { once: true });
  });
}

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

  it("tracks runtime ownership, visibility, and usage rollups", () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ name: "Runtime owner", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({
      name: "local-codex",
      provider: "codex",
      workspace_id: "local",
      owner_id: member.id,
      visibility: "public",
      max_concurrency: 2,
      models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true }],
    });
    const first = store.createTask({ agentId: agent.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, prompt: "Second" });

    expect(runtime.ownerId).toBe(member.id);
    expect(runtime.visibility).toBe("public");
    expect(runtime.maxConcurrency).toBe(2);
    expect(runtime.models[0].id).toBe("gpt-5.5");
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
    store.startTask(first.id);
    store.reportTaskUsage(first.id, [
      { provider: "codex", model: "gpt-5", inputTokens: 100, outputTokens: 25, cacheReadTokens: 5 },
      { provider: "codex", model: "gpt-5", inputTokens: 40, outputTokens: 10, cacheWriteTokens: 3 },
    ]);
    store.reportTaskUsage(second.id, [
      { provider: "codex", model: "gpt-5-mini", inputTokens: 7, outputTokens: 2 },
    ]);
    store.completeTask(first.id, { output: "done" });

    const detailed = store.getRuntime(runtime.id)!;
    expect(detailed.taskCount).toBe(2);
    expect(detailed.activeTaskCount).toBe(1);
    expect(detailed.completedTaskCount).toBe(1);
    expect(detailed.inputTokens).toBe(147);
    expect(detailed.outputTokens).toBe(37);
    expect(detailed.cacheReadTokens).toBe(5);
    expect(detailed.cacheWriteTokens).toBe(3);

    const usage = store.listRuntimeUsage(runtime.id);
    expect(usage).toHaveLength(2);
    expect(usage.find((row) => row.model === "gpt-5")?.taskCount).toBe(1);
    expect(usage.find((row) => row.model === "gpt-5")?.inputTokens).toBe(140);

    const daily = store.listUsageDaily({ runtimeId: runtime.id });
    expect(daily.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(147);
    expect(store.listUsageByAgent({ runtimeId: runtime.id })[0]?.agentId).toBe(agent.id);
    expect(store.listUsageByHour({ runtimeId: runtime.id })[0]?.hour).toBeNumber();
    expect(store.listTaskActivityByHour({ runtimeId: runtime.id })).not.toHaveLength(0);
    expect(store.listRuntimeDaily({ runtimeId: runtime.id }).reduce((sum, row) => sum + row.taskCount, 0)).toBe(2);

    const updated = store.updateRuntime(runtime.id, {
      name: "codex-shared",
      ownerId: null,
      visibility: "private",
      maxConcurrency: 3,
    });
    expect(updated.name).toBe("codex-shared");
    expect(updated.ownerId).toBeNull();
    expect(updated.visibility).toBe("private");
    expect(updated.maxConcurrency).toBe(3);

    const models = store.updateRuntimeModels(runtime.id, [{
      id: "gpt-5.4",
      label: "GPT-5.4",
      provider: "openai",
      default: false,
      thinking: { supportedLevels: [{ value: "high", label: "High" }], defaultLevel: "high" },
    }]);
    expect(models[0].thinking?.supportedLevels[0].value).toBe("high");
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

  it("manages workspace skills, attaches them to agents, and includes files in claims", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Reviewer", provider: "claude" });
    const skill = store.createSkill({
      id: "skl_review",
      workspaceId: "local",
      name: "Review Helper",
      description: "Review pull requests",
      content: "# Review Helper",
      config: { origin: { type: "local" } },
      files: [{ path: "templates/check.md", content: "Check list" }],
    });

    expect(store.listSkills("local")[0].content).toBe("# Review Helper");
    expect(store.listSkills("local", { includeFiles: true })[0].files?.[0].path).toBe("templates/check.md");

    const attached = store.setAgentSkills(agent.id, { skill_ids: [skill.id!] });
    expect(attached[0].name).toBe("Review Helper");
    expect(store.getAgent(agent.id)?.skills[0].files?.[0].content).toBe("Check list");

    const task = store.createTask({ agentId: agent.id, prompt: "Review this" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.agent?.skills[0].name).toBe("Review Helper");
    expect(claimed?.agent?.skills[0].files?.[0].path).toBe("templates/check.md");

    const updated = store.updateSkill(skill.id!, { name: "Review Helper", files: [{ path: "rules.md", content: "Rules" }] });
    expect(updated.files?.[0].path).toBe("rules.md");
    expect(() => store.updateSkill(skill.id!, { files: [{ path: "../escape.md", content: "" }] })).toThrow();

    store.archiveSkill(skill.id!);
    expect(store.listAgentSkills(agent.id)).toHaveLength(0);
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

  it("aggregates assignee frequency from created issues and assignment activity", () => {
    const store = createStore();
    const alice = store.createWorkspaceMember({ name: "Alice", role: "member" });
    const bob = store.createWorkspaceMember({ name: "Bob", role: "member" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const created = store.createIssue({
      title: "Created with assignee",
      createdBy: alice.id,
      assigneeType: "member",
      assigneeId: bob.id,
    });
    const reassigned = store.createIssue({ title: "Reassigned later", createdBy: alice.id });

    store.assignIssue(reassigned.id, {
      assignee_type: "member",
      assignee_id: bob.id,
      actorType: "member",
      actorId: alice.id,
    });
    store.assignIssue(created.id, {
      assigneeType: "agent",
      assigneeId: agent.id,
      actor_type: "member",
      actor_id: alice.id,
    });

    const frequency = store.listAssigneeFrequency({ memberId: alice.id });

    expect(frequency.find((entry) => entry.assigneeId === bob.id)).toMatchObject({
      assigneeType: "member",
      assignee_type: "member",
      assigneeId: bob.id,
      assignee_id: bob.id,
      frequency: 2,
    });
    expect(frequency.find((entry) => entry.assigneeId === agent.id)?.frequency).toBe(2);
  });

  it("assigns human-readable issue keys per workspace", () => {
    const store = createStore();
    const first = store.createIssue({ title: "First issue" });
    const second = store.createIssue({ title: "Second issue" });

    expect(first.key).toBe("MUL-1");
    expect(first.number).toBe(1);
    expect(second.key).toBe("MUL-2");
  });

  it("links GitHub pull requests by issue key and closes merged issues", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Implement GitHub linking" });

    const pullRequest = store.upsertGitHubPullRequest({
      repoOwner: "example",
      repoName: "remi",
      number: 17,
      title: `${issue.key} add linked pull request sidebar`,
      branch: `feature/${issue.key}-github-links`,
      state: "open",
      checksConclusion: "pending",
      checksPending: 1,
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });

    expect(pullRequest.issueId).toBe(issue.id);
    expect(pullRequest.htmlUrl).toBe("https://github.com/example/remi/pull/17");
    expect(store.listGitHubPullRequests({ issueId: issue.id })[0]?.number).toBe(17);

    const merged = store.upsertGitHubPullRequest({
      repoOwner: "example",
      repoName: "remi",
      number: 17,
      title: `${issue.key} add linked pull request sidebar`,
      branch: `feature/${issue.key}-github-links`,
      state: "merged",
      checksConclusion: "passed",
      checksPassed: 4,
      mergedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(merged.id).toBe(pullRequest.id);
    expect(store.getIssue(issue.id)?.status).toBe("done");

    store.updateGitHubSettings({ enabled: false });
    const ignoredIssue = store.createIssue({ title: "Disabled GitHub linking" });
    const ignored = store.upsertGitHubPullRequest({
      repoOwner: "example",
      repoName: "remi",
      number: 18,
      title: `${ignoredIssue.key} should not auto-link`,
    });
    expect(ignored.issueId).toBeNull();
  });

  it("manages issue hierarchy, priority, scheduling, and planning fields", () => {
    const store = createStore();
    const project = store.createProject({ title: "Hierarchy project" });
    const parent = store.createIssue({
      title: "Parent issue",
      projectId: project.id,
      priority: "high",
      dueDate: "2026-06-10T12:00:00+08:00",
      acceptanceCriteria: ["parent done"],
      contextRefs: [{ type: "doc", url: "https://example.com/spec" }],
    });
    const child = store.createIssue({
      title: "Child issue",
      parent_issue_id: parent.id,
      position: 2.5,
      start_date: "2026-06-04T09:00:00+08:00",
    });

    expect(parent.priority).toBe("high");
    expect(parent.dueDate).toBe("2026-06-10T04:00:00.000Z");
    expect(parent.acceptanceCriteria).toEqual(["parent done"]);
    expect(parent.contextRefs[0]).toEqual({ type: "doc", url: "https://example.com/spec" });
    expect(child.parentIssueId).toBe(parent.id);
    expect(child.projectId).toBe(project.id);
    expect(child.position).toBe(2.5);
    expect(store.listChildIssues(parent.id).map((item) => item.id)).toEqual([child.id]);
    expect(store.getIssueWithTasks(parent.id)?.children[0]?.id).toBe(child.id);

    store.updateIssue(child.id, { status: "done" });
    expect(store.getChildIssueProgress(parent.id)).toEqual({ parentIssueId: parent.id, total: 1, done: 1 });
    expect(store.listChildIssueProgress("local")).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);

    const sibling = store.createIssue({ title: "Sibling", parentIssueId: parent.id, priority: "urgent", position: 1 });
    expect(store.listChildIssues(parent.id).map((item) => item.id)).toEqual([sibling.id, child.id]);

    expect(() => store.updateIssue(parent.id, { parentIssueId: child.id })).toThrow("Circular parent");
    expect(() => store.updateIssue(parent.id, { parentIssueId: parent.id })).toThrow("own parent");
    expect(() => store.createIssue({ title: "Bad priority", priority: "must" })).toThrow("priority");

    const remoteParent = store.createIssue({ title: "Remote parent", workspaceId: "remote" });
    expect(() => store.createIssue({ title: "Cross workspace", parentIssueId: remoteParent.id, workspaceId: "local" })).toThrow("another workspace");
  });

  it("manages issue dependencies with workspace and duplicate guards", () => {
    const store = createStore();
    const blocker = store.createIssue({ title: "Blocker" });
    const blocked = store.createIssue({ title: "Blocked" });

    const dependency = store.createIssueDependency(blocked.id, {
      depends_on_issue_id: blocker.id,
      type: "blocked_by",
    });
    expect(dependency.issueId).toBe(blocked.id);
    expect(dependency.dependsOnIssueId).toBe(blocker.id);
    expect(dependency.type).toBe("blocked_by");
    expect(dependency.issue?.title).toBe("Blocked");
    expect(dependency.dependsOnIssue?.title).toBe("Blocker");
    expect(store.listIssueDependencies(blocked.id)).toHaveLength(1);
    expect(store.listIssueDependencies(blocker.id)).toHaveLength(1);

    const duplicate = store.createIssueDependency(blocked.id, {
      dependsOnIssueId: blocker.id,
      type: "blocked_by",
    });
    expect(duplicate.id).toBe(dependency.id);
    expect(store.listIssueDependencies(blocked.id)).toHaveLength(1);

    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: blocked.id })).toThrow("itself");
    const remote = store.createIssue({ title: "Remote", workspaceId: "remote" });
    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: remote.id })).toThrow("within a workspace");
    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: blocker.id, type: "must" })).toThrow("dependency type");

    store.deleteIssueDependency(blocked.id, dependency.id);
    expect(store.listIssueDependencies(blocked.id)).toEqual([]);
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

  it("notifies subscribed members through inbox items", () => {
    const store = createStore();
    const alice = store.createWorkspaceMember({ name: "Alice Reviewer" });
    const bob = store.createWorkspaceMember({ name: "Bob Approver" });
    const carol = store.createWorkspaceMember({ name: "Carol Owner" });
    const issue = store.createIssue({ title: "Notify people", createdBy: alice.id });

    expect(store.listIssueSubscribers(issue.id).map((subscriber) => subscriber.memberId)).toEqual([alice.id]);

    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: bob.id });
    expect(store.listInboxItems(bob.id).some((item) => item.type === "issue_assigned")).toBe(true);

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: carol.id,
      body: `Please review [@Bob Approver](mention://member/${bob.id}) and @Alice Reviewer`,
    });

    expect(store.listIssueSubscribers(issue.id).map((subscriber) => subscriber.memberId).sort()).toEqual([
      alice.id,
      bob.id,
      carol.id,
    ].sort());
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "comment_mention")).toHaveLength(1);
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "comment_created")).toHaveLength(0);
    expect(store.listInboxItems(alice.id).some((item) => item.type === "comment_mention")).toBe(true);

    const item = store.listInboxItems(bob.id)[0]!;
    expect(store.markInboxItemRead(item.id).read).toBe(true);
    expect(store.archiveInboxItem(item.id).archived).toBe(true);
    expect(store.listInboxItems(bob.id).some((inboxItem) => inboxItem.id === item.id)).toBe(false);
  });

  it("honors notification preferences when creating inbox items", () => {
    const store = createStore();
    const bob = store.createWorkspaceMember({ name: "Bob Approver" });
    const issue = store.createIssue({ title: "Quiet assignment" });

    store.updateNotificationPreferences({
      preferences: { assignments: "muted" },
    });
    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: bob.id });

    expect(store.getNotificationPreferences().preferences.assignments).toBe("muted");
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "issue_assigned")).toHaveLength(0);
  });

  it("tracks comment threads, reactions, and attachments", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Collaborate with context" });
    const issueAttachment = store.createAttachment({
      issueId: issue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "spec.md",
      url: "https://example.com/spec.md",
      contentType: "text/markdown",
      sizeBytes: 42,
    });
    const root = store.createIssueComment(issue.id, { body: "Root question" });
    const replyAttachment = store.createAttachment({
      uploaderType: "member",
      uploaderId: "local",
      filename: "reply.txt",
      url: "https://example.com/reply.txt",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const reply = store.createIssueComment(issue.id, {
      body: "Thread reply",
      parentId: root.id,
      attachmentIds: [replyAttachment.id],
    });

    expect(reply.parentId).toBe(root.id);
    expect(store.listAttachmentsForIssue(issue.id)[0]?.id).toBe(issueAttachment.id);
    expect(store.listAttachmentsForComment(reply.id)[0]?.id).toBe(replyAttachment.id);

    expect(store.addIssueReaction(issue.id, { actorType: "member", actorId: "local", emoji: "👍" }).emoji).toBe("👍");
    store.addIssueReaction(issue.id, { actorType: "member", actorId: "local", emoji: "👍" });
    expect(store.listIssueReactions(issue.id)).toHaveLength(1);

    expect(store.addCommentReaction(reply.id, { actorType: "agent", actorId: "agt-test", emoji: "👀" }).emoji).toBe("👀");
    expect(store.getIssueWithTasks(issue.id)?.reactions).toHaveLength(1);
    expect(store.listIssueComments(issue.id).find((comment) => comment.id === reply.id)?.attachments).toHaveLength(1);
    expect(store.listIssueComments(issue.id).find((comment) => comment.id === reply.id)?.reactions).toHaveLength(1);
  });

  it("updates, deletes, resolves, and reopens comment threads", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Comment lifecycle" });
    const root = store.createIssueComment(issue.id, { body: "Root thread" });
    const reply = store.createIssueComment(issue.id, { body: "Reply", parentId: root.id });

    const updated = store.updateIssueComment(reply.id, { content: "Edited reply" });
    expect(updated.body).toBe("Edited reply");
    expect(store.listIssueActivity(issue.id).some((item) => item.type === "comment_updated")).toBe(true);

    const resolved = store.resolveIssueComment(root.id, { actorType: "member", actorId: "local" });
    expect(resolved.resolvedAt).toBeString();
    expect(resolved.resolvedByType).toBe("member");
    expect(() => store.resolveIssueComment(reply.id)).toThrow("Only root comments");

    const reopenedReply = store.createIssueComment(issue.id, { body: "Reopen thread", parentId: root.id });
    expect(reopenedReply.parentId).toBe(root.id);
    expect(store.getIssueComment(root.id)?.resolvedAt).toBeNull();

    const resolvedAgain = store.resolveIssueComment(root.id);
    expect(resolvedAgain.resolvedAt).toBeString();
    expect(store.unresolveIssueComment(root.id).resolvedAt).toBeNull();

    store.deleteIssueComment(root.id);
    expect(store.getIssueComment(root.id)).toBeNull();
    expect(store.getIssueComment(reply.id)).toBeNull();
    expect(store.getIssueComment(reopenedReply.id)).toBeNull();
    expect(store.listIssueActivity(issue.id).some((item) => item.type === "comment_deleted")).toBe(true);
  });

  it("manages issue labels with workspace scoping", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Needs labels", workspaceId: "local" });
    const label = store.createLabel({ name: "Bug", color: "FF3333", workspaceId: "local" });

    expect(label.color).toBe("#ff3333");
    expect(store.listLabels("local").map((item) => item.name)).toEqual(["Bug"]);
    expect(() => store.createLabel({ name: "bug", color: "#00ff00", workspaceId: "local" })).toThrow("Label already exists");
    expect(() => store.createLabel({ name: "bad-color", color: "red", workspaceId: "local" })).toThrow("6-digit hex");

    expect(store.attachLabelToIssue(issue.id, label.id).map((item) => item.id)).toEqual([label.id]);
    store.attachLabelToIssue(issue.id, label.id);
    expect(store.listLabelsForIssue(issue.id)).toHaveLength(1);
    expect(store.getIssue(issue.id)?.labels[0]?.name).toBe("Bug");
    expect(store.listIssues()[0]?.labels[0]?.color).toBe("#ff3333");

    const updated = store.updateLabel(label.id, { name: "Regression", color: "#22AA66" });
    expect(updated.color).toBe("#22aa66");
    expect(store.getIssueWithTasks(issue.id)?.labels[0]?.name).toBe("Regression");

    const otherWorkspaceLabel = store.createLabel({ name: "Remote", color: "#111111", workspaceId: "remote" });
    expect(() => store.attachLabelToIssue(issue.id, otherWorkspaceLabel.id)).toThrow("another workspace");

    expect(store.detachLabelFromIssue(issue.id, label.id)).toEqual([]);
    store.deleteLabel(label.id);
    expect(store.listLabelsForIssue(issue.id)).toEqual([]);
  });

  it("manages pinned issue and project shortcuts", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Pinned issue", workspaceId: "local" });
    const project = store.createProject({ title: "Pinned project", workspaceId: "local" });

    const issuePin = store.createPinnedItem({ itemType: "issue", itemId: issue.id, workspaceId: "local", userId: "local" });
    const projectPin = store.createPinnedItem({ item_type: "project", item_id: project.id, workspace_id: "local", user_id: "local" });

    expect(issuePin.position).toBe(1);
    expect(projectPin.position).toBe(2);
    expect(store.listPinnedItems("local", "local").map((pin) => pin.itemType)).toEqual(["issue", "project"]);
    expect(() => store.createPinnedItem({ itemType: "issue", itemId: issue.id })).toThrow("already pinned");
    expect(() => store.createPinnedItem({ itemType: "issue", itemId: issue.id, workspaceId: "remote" })).toThrow("Issue not found");
    expect(() => store.createPinnedItem({ itemType: "agent", itemId: issue.id })).toThrow("item_type");

    const reordered = store.reorderPinnedItems("local", "local", [
      { id: issuePin.id, position: 20 },
      { id: projectPin.id, position: 10 },
    ]);
    expect(reordered.map((pin) => pin.id)).toEqual([projectPin.id, issuePin.id]);

    store.deletePinnedItem("local", "local", "project", project.id);
    expect(store.listPinnedItems("local", "local").map((pin) => pin.id)).toEqual([issuePin.id]);
  });

  it("searches issues and projects with ranking and snippets", () => {
    const store = createStore();
    store.createIssue({ title: "Alpha title", description: "No special details", workspaceId: "local" });
    const descIssue = store.createIssue({ title: "Other title", description: "Contains needle phrase inside a longer issue description", workspaceId: "local" });
    store.updateIssue(descIssue.id, { status: "done" });
    store.createProject({ title: "Project Alpha", description: "No details", workspaceId: "local" });
    store.createProject({ title: "Project Other", description: "Contains project needle phrase", workspaceId: "local" });

    const issues = store.searchIssues({ q: "alpha", workspaceId: "local" });
    expect(issues.total).toBe(1);
    expect(issues.issues[0]?.matchSource).toBe("title");

    const withoutClosed = store.searchIssues({ q: "needle", workspaceId: "local" });
    expect(withoutClosed.total).toBe(0);
    const withClosed = store.searchIssues({ q: "needle", workspaceId: "local", includeClosed: true });
    expect(withClosed.issues[0]?.matchSource).toBe("description");
    expect(withClosed.issues[0]?.matchedDescriptionSnippet).toContain("needle");

    const projects = store.searchProjects({ q: "needle", workspaceId: "local" });
    expect(projects.projects[0]?.matchSource).toBe("description");
    expect(projects.projects[0]?.matchedSnippet).toContain("needle");
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

  it("writes agent skills into the daemon workdir", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const skill = store.createSkill({
      name: "Review Helper",
      description: "Review pull requests",
      content: "# Body",
      files: [{ path: "templates/check.md", content: "Check list" }],
    });
    store.setAgentSkills(agent.id, { skillIds: [skill.id!] });
    const task = store.getTaskWithAgent(store.createTask({ agentId: agent.id, prompt: "Review" }).id)!;
    const dir = mkdtempSync(join(tmpdir(), "multica-skill-"));

    try {
      writeAgentSkillContext(dir, task);
      const skillDir = join(dir, ".claude", "skills", "review-helper");

      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("name: \"Review Helper\"");
      expect(readFileSync(join(skillDir, "templates", "check.md"), "utf8")).toBe("Check list");
      expect(existsSync(join(dir, ".claude", "skills", "..", "escape.md"))).toBeFalse();
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
    expect(prompt).toContain(`Key: ${issue.key}`);
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
    expect(first.run?.source).toBe("webhook");
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

describe("Bun Multica dashboard", () => {
  it("renders a real usage page instead of the placeholder", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain('id="usagePage"');
    expect(html).toContain('id="usageSummaryGrid"');
    expect(html).toContain("function renderUsage()");
    expect(html).toContain("function renderRuntimeModels(runtime)");
    expect(html).toContain("/api/dashboard/usage/daily");
  });

  it("renders a real skills page with agent skill controls", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain('id="skillsPage"');
    expect(html).toContain('id="skillsGrid"');
    expect(html).toContain("function renderSkills()");
    expect(html).toContain("/api/multica/skills");
    expect(html).toContain("/api/multica/skills/import");
    expect(html).toContain("entitySourceUrl");
    expect(html).toContain("updateSelectedAgentSkills");
  });

  it("renders a real settings page with token controls", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain('id="settingsPage"');
    expect(html).toContain('id="tokenList"');
    expect(html).toContain("function renderSettings()");
    expect(html).toContain("/api/multica/tokens");
    expect(html).toContain("function revokeToken");
    expect(html).toContain("function renderNotificationPreferences");
    expect(html).toContain("/api/multica/notification-preferences");
    expect(html).toContain("function renderGitHubSettings");
    expect(html).toContain("/api/multica/github/settings");
    expect(html).toContain("updateGitHubSettings");
  });

  it("renders GitHub pull requests in issue and task detail", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain("function renderGitHubPullRequests");
    expect(html).toContain("function githubPullRequestStatus");
    expect(html).toContain("/api/multica/github/pull-requests?issueId=");
    expect(html).toContain("Pull requests");
  });

  it("renders a real my issues page with member filtering", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain('id="myIssuesPage"');
    expect(html).toContain('id="myIssueList"');
    expect(html).toContain("function renderMyIssues()");
    expect(html).toContain("function visibleMyIssues()");
    expect(html).toContain("myIssueMemberId");
  });

  it("renders autopilot detail controls and run history", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain("function openAutopilot");
    expect(html).toContain("function renderAutopilotDrawer");
    expect(html).toContain("function renderAutopilotRuns");
    expect(html).toContain("function renderWebhookDeliveries");
    expect(html).toContain("replayWebhookDelivery");
    expect(html).toContain("/api/multica/autopilots/");
    expect(html).toContain("updateSelectedAutopilot");
  });

  it("renders a workspace members page with edit controls", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain('id="membersPage"');
    expect(html).toContain('id="membersGrid"');
    expect(html).toContain("function renderMembers()");
    expect(html).toContain("function renderMemberDrawer");
    expect(html).toContain("/api/multica/members/");
    expect(html).toContain("updateSelectedMember");
  });
});

describe("Bun Multica API", () => {
  it("serves daemon websocket upgrades and realtime health", async () => {
    const server = startMulticaServer({ store: createStore(), scheduler: null, port: 0, hostname: "127.0.0.1" });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_id=rt_ws`);
      const ready = await nextWebSocketMessage(ws);
      expect(ready).toMatchObject({ type: "ready", transport: "websocket", runtime_id: "rt_ws" });

      const connectedHealth = await fetch(`${baseUrl}/health/realtime`);
      expect(await connectedHealth.json()).toMatchObject({ enabled: true, connections: 1, transport: "websocket" });

      ws.send(JSON.stringify({ type: "ping", runtime_id: "rt_ws" }));
      const pong = await nextWebSocketMessage(ws);
      expect(pong).toMatchObject({ type: "pong", received_type: "ping", runtime_id: "rt_ws", ok: true });
      ws.close();
      await Bun.sleep(25);

      const closedHealth = await fetch(`${baseUrl}/health/realtime`);
      expect(await closedHealth.json()).toMatchObject({ enabled: true, connections: 0, transport: "websocket" });
    } finally {
      server.stop(true);
    }
  });

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

  it("serves agent task history and workspace task snapshots", async () => {
    const store = createStore();
    const agentA = store.createAgent({ name: "Snapshot A", provider: "codex" });
    const agentB = store.createAgent({ name: "Snapshot B", provider: "claude" });
    const agentC = store.createAgent({ name: "Snapshot C", provider: "codex" });
    const runtime = store.registerRuntime({ name: "snapshot-runtime", provider: "any" });
    const app = createMulticaApp({ store });

    const queued = store.createTask({ agentId: agentA.id, prompt: "A queued" });
    const running = store.createTask({ agentId: agentA.id, prompt: "A running" });
    db!.run("UPDATE multica_tasks SET status = 'running', runtime_id = ?, started_at = ?, updated_at = ? WHERE id = ?", [
      runtime.id,
      "2026-06-04T01:00:00.000Z",
      "2026-06-04T01:00:00.000Z",
      running.id,
    ]);
    const oldFailed = store.createTask({ agentId: agentA.id, prompt: "A old failed" });
    db!.run("UPDATE multica_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:01:00.000Z",
      "2026-06-04T01:01:00.000Z",
      oldFailed.id,
    ]);
    const latestCompleted = store.createTask({ agentId: agentA.id, prompt: "A latest completed" });
    db!.run("UPDATE multica_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:02:00.000Z",
      "2026-06-04T01:02:00.000Z",
      latestCompleted.id,
    ]);
    const staleFailure = store.createTask({ agentId: agentB.id, prompt: "B stale failed" });
    db!.run("UPDATE multica_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T00:50:00.000Z",
      "2026-06-04T00:50:00.000Z",
      staleFailure.id,
    ]);
    const failureBeforeCancel = store.createTask({ agentId: agentC.id, prompt: "C failure" });
    db!.run("UPDATE multica_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T00:55:00.000Z",
      "2026-06-04T00:55:00.000Z",
      failureBeforeCancel.id,
    ]);
    const cancelled = store.createTask({ agentId: agentC.id, prompt: "C cancelled" });
    db!.run("UPDATE multica_tasks SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:03:00.000Z",
      "2026-06-04T01:03:00.000Z",
      cancelled.id,
    ]);

    const snapshot = await app.request("/api/agent-task-snapshot?workspace_id=local");
    const snapshotBody = await snapshot.json();
    const ids = snapshotBody.map((task: any) => task.id).sort();
    expect(ids).toEqual([queued.id, running.id, latestCompleted.id, staleFailure.id, failureBeforeCancel.id].sort());
    expect(ids).not.toContain(oldFailed.id);
    expect(ids).not.toContain(cancelled.id);

    const multicaSnapshot = await app.request("/api/multica/agent-task-snapshot?workspace_id=local");
    const multicaSnapshotBody = await multicaSnapshot.json();
    expect(multicaSnapshotBody.total).toBe(5);
    expect(multicaSnapshotBody.tasks.map((task: any) => task.id).sort()).toEqual(ids);

    const agentTasks = await app.request(`/api/agents/${agentA.id}/tasks`);
    const agentTaskBody = await agentTasks.json();
    expect(agentTaskBody.map((task: any) => task.id)).toContain(queued.id);

    const multicaAgentTasks = await app.request(`/api/multica/agents/${agentA.id}/tasks`);
    const multicaAgentTaskBody = await multicaAgentTasks.json();
    expect(multicaAgentTaskBody.total).toBe(4);
  });

  it("serves workspace agent run counts and 30 day activity buckets", async () => {
    const store = createStore();
    const agentA = store.createAgent({ name: "Activity A", provider: "codex" });
    const agentB = store.createAgent({ name: "Activity B", provider: "claude" });
    const app = createMulticaApp({ store });

    const now = Date.now();
    const recentCreated = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldCreated = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recentCompletedA = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const recentCompletedB = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();

    const completed = store.createTask({ agentId: agentA.id, prompt: "completed" });
    db!.run("UPDATE multica_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedA,
      recentCompletedA,
      completed.id,
    ]);
    const failed = store.createTask({ agentId: agentA.id, prompt: "failed" });
    db!.run("UPDATE multica_tasks SET status = 'failed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedA,
      recentCompletedA,
      failed.id,
    ]);
    const inFlight = store.createTask({ agentId: agentA.id, prompt: "in flight" });
    db!.run("UPDATE multica_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [recentCreated, recentCreated, inFlight.id]);
    const old = store.createTask({ agentId: agentA.id, prompt: "old" });
    db!.run("UPDATE multica_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      oldCreated,
      oldCreated,
      oldCreated,
      old.id,
    ]);
    const otherAgent = store.createTask({ agentId: agentB.id, prompt: "other agent" });
    db!.run("UPDATE multica_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedB,
      recentCompletedB,
      otherAgent.id,
    ]);

    const runCounts = await app.request("/api/agent-run-counts?workspace_id=local");
    const runCountBody = await runCounts.json();
    expect(runCountBody.find((row: any) => row.agent_id === agentA.id)?.run_count).toBe(3);
    expect(runCountBody.find((row: any) => row.agent_id === agentB.id)?.run_count).toBe(1);

    const multicaRunCounts = await app.request("/api/multica/agent-run-counts?workspace_id=local");
    const multicaRunCountBody = await multicaRunCounts.json();
    expect(multicaRunCountBody.total).toBe(2);
    expect(multicaRunCountBody.counts.find((row: any) => row.agentId === agentA.id)?.runCount).toBe(3);

    const activity = await app.request("/api/agent-activity-30d?workspace_id=local");
    const activityBody = await activity.json();
    const agentABucket = activityBody.find((row: any) => row.agent_id === agentA.id);
    expect(agentABucket.task_count).toBe(2);
    expect(agentABucket.failed_count).toBe(1);
    expect(agentABucket.bucket_at).toEndWith("T00:00:00.000Z");
    expect(activityBody.find((row: any) => row.agent_id === agentB.id)?.task_count).toBe(1);

    const multicaActivity = await app.request("/api/multica/agent-activity-30d?workspace_id=local");
    const multicaActivityBody = await multicaActivity.json();
    expect(multicaActivityBody.total).toBe(2);
    expect(multicaActivityBody.activity.find((row: any) => row.agentId === agentA.id)?.failedCount).toBe(1);
  });

  it("protects APIs with bearer auth and accepts created local tokens", async () => {
    const store = createStore();
    const app = createMulticaApp({ store, authToken: "root-secret" });

    const unauthorized = await app.request("/api/multica/agents");
    expect(unauthorized.status).toBe(401);

    const created = await app.request("/api/multica/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Local daemon", type: "daemon", workspaceId: "local" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.token.token).toStartWith("mdt_");
    expect(createdBody.token.tokenPrefix).toBe(createdBody.token.token.slice(0, 12));

    const withLocalToken = await app.request("/api/multica/agents", {
      headers: { Authorization: `Bearer ${createdBody.token.token}` },
    });
    expect(withLocalToken.status).toBe(200);

    const listed = await app.request("/api/tokens", {
      headers: { Authorization: "Bearer root-secret" },
    });
    const listedBody = await listed.json();
    expect(listedBody[0].lastUsedAt).toBeString();

    const revoked = await app.request(`/api/tokens/${createdBody.token.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(revoked.status).toBe(204);

    const afterRevoke = await app.request("/api/multica/agents", {
      headers: { Authorization: `Bearer ${createdBody.token.token}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("serves workspace skills and agent skill assignment endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/multica/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "skl_api",
        workspace_id: "local",
        name: "API Skill",
        description: "API managed skill",
        content: "# API Skill",
        files: [{ path: "notes/guide.md", content: "Guide" }],
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).skill.files[0].path).toBe("notes/guide.md");

    const list = await app.request("/api/skills?workspace_id=local");
    const listBody = await list.json();
    expect(listBody[0].id).toBe("skl_api");
    expect(listBody[0].content).toBeUndefined();

    const multicaList = await app.request("/api/multica/skills?workspace_id=local");
    expect((await multicaList.json()).skills[0].content).toBeUndefined();

    const detail = await app.request("/api/skills/skl_api");
    const detailBody = await detail.json();
    expect(detailBody.content).toBe("# API Skill");
    expect(detailBody.files[0].content).toBe("Guide");

    const assign = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: ["skl_api"] }),
    });
    expect(assign.status).toBe(200);
    const assignBody = await assign.json();
    expect(assignBody[0].name).toBe("API Skill");
    expect(assignBody[0].content).toBeUndefined();

    const agentDetail = await app.request(`/api/multica/agents/${agent.id}`);
    const agentBody = await agentDetail.json();
    expect(agentBody.agent.skills[0].files[0].path).toBe("notes/guide.md");

    const deleted = await app.request("/api/skills/skl_api", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const afterDelete = await app.request(`/api/multica/agents/${agent.id}/skills`);
    expect((await afterDelete.json()).skills).toHaveLength(0);
  });

  it("serves agent templates and creates agents from templates", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const existingSkill = store.createSkill({
      workspaceId: "local",
      name: "root-cause-tracing",
      description: "Trace bugs",
      content: "# Root cause",
    });

    const templates = await app.request("/api/agent-templates");
    const templateBody = await templates.json();
    expect(templateBody.length).toBeGreaterThan(10);
    expect(templateBody.find((template: any) => template.slug === "bug-fixer")?.instructions).toBeUndefined();
    expect(templateBody.find((template: any) => template.slug === "bug-fixer")?.skills[0].cached_name).toBe("root-cause-tracing");

    const detail = await app.request("/api/agent-templates/bug-fixer");
    const detailBody = await detail.json();
    expect(detailBody.instructions).toContain("You debug systematically");

    const multicaTemplates = await app.request("/api/multica/agent-templates");
    const multicaTemplatesBody = await multicaTemplates.json();
    expect(multicaTemplatesBody.total).toBe(templateBody.length);

    const created = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "bug-fixer",
        name: "Bug Fixer Agent",
        provider: "codex",
        extra_skill_ids: [existingSkill.id],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.agent.name).toBe("Bug Fixer Agent");
    expect(createdBody.agent.provider).toBe("codex");
    expect(createdBody.agent.instructions).toContain("root cause");
    expect(createdBody.imported_skill_ids).toEqual([]);
    expect(createdBody.reused_skill_ids).toEqual([existingSkill.id]);
    expect(store.listAgentSkills(createdBody.agent.id).map((skill) => skill.id)).toEqual([existingSkill.id]);

    const multicaCreated = await app.request("/api/multica/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateSlug: "summarizer",
        name: "Summarizer Agent",
        provider: "claude",
      }),
    });
    expect(multicaCreated.status).toBe(201);
    const multicaCreatedBody = await multicaCreated.json();
    expect(multicaCreatedBody.agent.name).toBe("Summarizer Agent");
    expect(multicaCreatedBody.importedSkillIds).toEqual([]);
    expect(multicaCreatedBody.reusedSkillIds).toEqual([]);

    const missing = await app.request("/api/agent-templates/not-real");
    expect(missing.status).toBe(404);
  });

  it("reuses imported template skills by resolved skill name", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const existing = store.createSkill({
      workspaceId: "local",
      name: "vercel-react-best-practices",
      description: "Existing real frontmatter name",
      content: "# Existing",
    });
    mockFetch((url) => {
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills") {
        return jsonResponse({ default_branch: "main" });
      }
      if (url === "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md") {
        return new Response("---\nname: vercel-react-best-practices\ndescription: React best practices\n---\n# Body");
      }
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills/git/trees/main?recursive=1") {
        return jsonResponse({ tree: [{ path: "skills/react-best-practices/SKILL.md", type: "blob" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const response = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "code-reviewer",
        name: "Reviewer from Template",
        provider: "codex",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.imported_skill_ids).toEqual([]);
    expect(body.reused_skill_ids).toEqual([existing.id]);
    expect(store.listSkills("local")).toHaveLength(1);
    expect(store.listAgentSkills(body.agent.id).map((skill) => skill.id)).toEqual([existing.id]);
  });

  it("imports skills from GitHub and skills.sh URLs", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const skillMd = [
      "---",
      "name: review-helper",
      "description: Review imported pull requests",
      "---",
      "# Review Helper",
    ].join("\n");
    const requestedUrls: string[] = [];

    mockFetch((url) => {
      requestedUrls.push(url);
      if (url === "https://api.github.com/repos/example/skills/commits/main") return new Response("sha", { status: 200 });
      if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md") return new Response(skillMd);
      if (url === "https://api.github.com/repos/example/skills/contents/review-helper?ref=main") {
        return jsonResponse([
          { name: "SKILL.md", path: "review-helper/SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md" },
          { name: "templates", path: "review-helper/templates", type: "dir", url: "https://api.github.com/repos/example/skills/contents/review-helper/templates?ref=main" },
          { name: "logo.png", path: "review-helper/logo.png", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/logo.png" },
        ]);
      }
      if (url === "https://api.github.com/repos/example/skills/contents/review-helper/templates?ref=main") {
        return jsonResponse([
          { name: "check.md", path: "review-helper/templates/check.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/templates/check.md" },
        ]);
      }
      if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/templates/check.md") return new Response("Check list");

      if (url === "https://api.github.com/repos/example/skills") return jsonResponse({ default_branch: "main" });
      if (url === "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/SKILL.md") return new Response(skillMd);
      if (url === "https://api.github.com/repos/example/skills/contents/skills/review-helper?ref=main") {
        return jsonResponse([
          { name: "SKILL.md", path: "skills/review-helper/SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/SKILL.md" },
          { name: "notes.md", path: "skills/review-helper/notes.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/notes.md" },
        ]);
      }
      if (url === "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/notes.md") return new Response("Notes");
      return new Response("not found", { status: 404 });
    });

    const githubImport = await app.request("/api/multica/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/example/skills/tree/main/review-helper", workspaceId: "local" }),
    });
    expect(githubImport.status).toBe(201);
    const githubBody = await githubImport.json();
    expect(githubBody.source).toBe("github");
    expect(githubBody.skill.name).toBe("review-helper");
    expect(githubBody.skill.description).toBe("Review imported pull requests");
    expect(githubBody.skill.config.origin.type).toBe("github");
    expect(githubBody.skill.files).toHaveLength(1);
    expect(githubBody.skill.files[0].path).toBe("templates/check.md");
    expect(githubBody.skill.files[0].content).toBe("Check list");

    const skillsShImport = await app.request("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://skills.sh/example/skills/review-helper", workspaceId: "local", name: "Imported Review" }),
    });
    expect(skillsShImport.status).toBe(201);
    const skillsShBody = await skillsShImport.json();
    expect(skillsShBody.name).toBe("Imported Review");
    expect(skillsShBody.config.origin.type).toBe("skills_sh");
    expect(skillsShBody.files[0].path).toBe("notes.md");
    expect(requestedUrls).toContain("https://api.github.com/repos/example/skills/contents/skills/review-helper?ref=main");
  });

  it("serves runtime metadata updates and usage endpoints", async () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ name: "Ada", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "usage" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/multica/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "rt_api",
        name: "API runtime",
        provider: "codex",
        workspace_id: "local",
        owner_id: member.id,
        visibility: "public",
        max_concurrency: 2,
        models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.runtime.ownerId).toBe(member.id);
    expect(createdBody.runtime.visibility).toBe("public");
    expect(createdBody.runtime.maxConcurrency).toBe(2);
    expect(createdBody.runtime.models[0].default).toBeTrue();

    const models = await app.request("/api/runtimes/rt_api/models");
    expect((await models.json()).models[0].id).toBe("gpt-5.5");

    const updatedModels = await app.request("/api/multica/runtimes/rt_api/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "openai", default: true }] }),
    });
    expect((await updatedModels.json()).models[0].id).toBe("gpt-5.4");

    const claim = await app.request("/api/daemon/runtimes/rt_api/tasks/claim", { method: "POST" });
    expect((await claim.json()).task.id).toBe(task.id);
    await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usage: [{ provider: "codex", model: "gpt-5", inputTokens: 11, outputTokens: 5, cache_read_tokens: 2 }],
      }),
    });

    const detail = await app.request("/api/multica/runtimes/rt_api");
    const detailBody = await detail.json();
    expect(detailBody.runtime.taskCount).toBe(1);
    expect(detailBody.runtime.inputTokens).toBe(11);
    expect(detailBody.usage[0].model).toBe("gpt-5");

    const usage = await app.request("/api/runtimes/rt_api/usage");
    const usageBody = await usage.json();
    expect(usageBody[0].runtimeId).toBe("rt_api");
    expect(usageBody[0].cacheReadTokens).toBe(2);

    const byAgent = await app.request("/api/runtimes/rt_api/usage/by-agent");
    const byAgentBody = await byAgent.json();
    expect(byAgentBody[0].agentId).toBe(agent.id);

    const byHour = await app.request("/api/multica/runtimes/rt_api/usage/by-hour");
    const byHourBody = await byHour.json();
    expect(byHourBody.usage[0].model).toBe("gpt-5");

    const activity = await app.request("/api/runtimes/rt_api/task-activity");
    expect((await activity.json())[0].count).toBe(1);

    const dashboardUsage = await app.request("/api/dashboard/usage/daily");
    expect((await dashboardUsage.json())[0].model).toBe("gpt-5");

    const updated = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: null, visibility: "private", max_concurrency: 4 }),
    });
    const updatedBody = await updated.json();
    expect(updatedBody.runtime.ownerId).toBeNull();
    expect(updatedBody.runtime.visibility).toBe("private");
    expect(updatedBody.runtime.maxConcurrency).toBe(4);
  });

  it("serves runtime model list request flow", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_models_flow", name: "Models runtime", provider: "codex" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/runtimes/rt_models_flow/models", { method: "POST" });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("rml_");
    expect(createdBody.status).toBe("pending");

    const claimed = await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.request.id).toBe(createdBody.id);
    expect(claimedBody.request.status).toBe("running");

    const reported = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        supported: true,
        models: [{
          id: "gpt-5.1-codex",
          label: "GPT-5.1 Codex",
          provider: "openai",
          default: true,
          thinking: {
            supported_levels: [{ value: "high", label: "High", description: "More reasoning" }],
            default_level: "high",
          },
        }],
      }),
    });
    expect(reported.status).toBe(200);

    const detail = await app.request(`/api/runtimes/rt_models_flow/models/${createdBody.id}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("completed");
    expect(detailBody.models[0].default).toBe(true);
    expect(detailBody.models[0].thinking.supportedLevels[0].value).toBe("high");

    const models = await app.request("/api/runtimes/rt_models_flow/models");
    const modelsBody = await models.json();
    expect(modelsBody.models[0].id).toBe("gpt-5.1-codex");
    expect(modelsBody.models[0].thinking.supportedLevels[0].label).toBe("High");

    const failed = await app.request("/api/multica/runtimes/rt_models_flow/models", { method: "POST" });
    const failedBody = await failed.json();
    await app.request(`/api/daemon/runtimes/rt_models_flow/models/${failedBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "provider not available" }),
    });
    const failedDetail = await app.request(`/api/multica/runtimes/rt_models_flow/models/${failedBody.id}`);
    const failedDetailBody = await failedDetail.json();
    expect(failedDetailBody.status).toBe("failed");
    expect(failedDetailBody.error).toBe("provider not available");
  });

  it("serves runtime update request flow", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_update_flow", name: "Update runtime", provider: "codex" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_version: "v1.2.3" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("rup_");
    expect(createdBody.target_version).toBe("v1.2.3");
    expect(createdBody.status).toBe("pending");

    const duplicate = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_version: "v1.2.4" }),
    });
    expect(duplicate.status).toBe(409);

    const claimed = await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.request.id).toBe(createdBody.id);
    expect(claimedBody.request.status).toBe("running");

    const running = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    expect(running.status).toBe(200);

    const completed = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", output: "updated ok" }),
    });
    expect(completed.status).toBe(200);

    const detail = await app.request(`/api/runtimes/rt_update_flow/update/${createdBody.id}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("completed");
    expect(detailBody.output).toBe("updated ok");

    const next = await app.request("/api/multica/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "v1.2.4" }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    await app.request(`/api/daemon/runtimes/rt_update_flow/update/${nextBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "download failed" }),
    });
    const failedDetail = await app.request(`/api/multica/runtimes/rt_update_flow/update/${nextBody.id}`);
    const failedDetailBody = await failedDetail.json();
    expect(failedDetailBody.status).toBe("failed");
    expect(failedDetailBody.error).toBe("download failed");
  });

  it("serves runtime local skill list and import request flows", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "skill-runtime", provider: "claude", workspaceId: "local" });
    const app = createMulticaApp({ store });

    const listInit = await app.request(`/api/runtimes/${runtime.id}/local-skills`, { method: "POST" });
    expect(listInit.status).toBe(200);
    const listRequest = await listInit.json();
    expect(listRequest.status).toBe("pending");

    const listClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" });
    const listClaimBody = await listClaim.json();
    expect(listClaimBody.request.id).toBe(listRequest.id);
    expect(listClaimBody.request.status).toBe("running");

    const listReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${listRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skills: [{
          key: "review-helper",
          name: "Review Helper",
          description: "Review local files",
          source_path: "/home/me/.claude/skills/review-helper",
          provider: "claude",
          file_count: 2,
        }],
      }),
    });
    expect(listReport.status).toBe(200);

    const listPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${listRequest.id}`);
    const listPollBody = await listPoll.json();
    expect(listPollBody.status).toBe("completed");
    expect(listPollBody.skills[0].sourcePath).toBe("/home/me/.claude/skills/review-helper");

    const importInit = await app.request(`/api/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_key: "review-helper", name: "Imported Local Review" }),
    });
    expect(importInit.status).toBe(200);
    const importRequest = await importInit.json();
    expect(importRequest.status).toBe("pending");

    const importClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" });
    const importClaimBody = await importClaim.json();
    expect(importClaimBody.requests[0].id).toBe(importRequest.id);
    expect(importClaimBody.requests[0].skillKey).toBe("review-helper");

    const importReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${importRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Review Helper",
          description: "Daemon description",
          content: "# Review Helper",
          provider: "claude",
          source_path: "/home/me/.claude/skills/review-helper",
          files: [{ path: "notes/check.md", content: "Check" }],
        },
      }),
    });
    expect(importReport.status).toBe(200);

    const importPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${importRequest.id}`);
    const importPollBody = await importPoll.json();
    expect(importPollBody.status).toBe("completed");
    expect(importPollBody.skill.name).toBe("Imported Local Review");
    expect(importPollBody.skill.config.origin.type).toBe("runtime_local");
    expect(importPollBody.skill.files[0].path).toBe("notes/check.md");
  });

  it("serves original daemon heartbeat pending request protocol", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_heartbeat_flow", name: "Heartbeat runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const issue = store.createIssue({ title: "Do not steal heartbeat requests" });
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Claim task" });
    const app = createMulticaApp({ store });

    const modelRequest = store.createRuntimeModelListRequest(runtime.id);
    const updateRequest = store.createRuntimeUpdateRequest(runtime.id, { target_version: "v9.9.9" });
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    const importOne = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "review-helper" });
    const importTwo = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "test-helper" });

    const taskClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(taskClaim.status).toBe(200);
    expect(store.getRuntimeModelListRequest(runtime.id, modelRequest.id)?.status).toBe("pending");
    expect(store.getRuntimeUpdateRequest(runtime.id, updateRequest.id)?.status).toBe("pending");

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtime.id, supports_batch_import: true }),
    });
    const heartbeatBody = await heartbeat.json();

    expect(heartbeat.status).toBe(200);
    expect(heartbeatBody).toMatchObject({
      runtime_id: runtime.id,
      status: "ok",
      pending_update: { id: updateRequest.id, target_version: "v9.9.9" },
      pending_model_list: { id: modelRequest.id },
      pending_local_skills: { id: localSkillRequest.id },
      pending_local_skill_import: { id: importOne.id, skill_key: "review-helper" },
    });
    expect(heartbeatBody.pending_local_skill_imports.map((item: any) => item.id)).toEqual([importOne.id, importTwo.id]);
    expect(store.getRuntimeModelListRequest(runtime.id, modelRequest.id)?.status).toBe("running");
    expect(store.getRuntimeUpdateRequest(runtime.id, updateRequest.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, localSkillRequest.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, importOne.id)?.status).toBe("running");

    const emptyHeartbeat = await app.request(`/api/multica/runtimes/${runtime.id}/heartbeat`, { method: "POST" });
    const emptyHeartbeatBody = await emptyHeartbeat.json();
    expect(emptyHeartbeat.status).toBe(200);
    expect(emptyHeartbeatBody.pending_update).toBeUndefined();
  });

  it("serves original daemon register and deregister endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });

    const missing = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: "daemon-missing", runtimes: [{ type: "codex" }] }),
    });
    expect(missing.status).toBe(400);

    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-1",
        device_name: "Laptop",
        cli_version: "0.2.0",
        launched_by: "desktop",
        runtimes: [
          { name: "Codex local", type: "codex", version: "1.0.0", status: "online" },
          { type: "claude", version: "2.0.0", status: "offline" },
        ],
      }),
    });
    const registeredBody = await registered.json();

    expect(registered.status).toBe(200);
    expect(registeredBody.repos).toEqual([]);
    expect(registeredBody.repos_version).toBeString();
    expect(registeredBody.runtimes).toHaveLength(2);
    expect(registeredBody.runtimes[0]).toMatchObject({
      workspace_id: "local",
      daemon_id: "daemon-1",
      runtime_mode: "local",
      provider: "codex",
      launch_header: "Codex",
      device_info: "Laptop · 1.0.0",
      metadata: {
        version: "1.0.0",
        cli_version: "0.2.0",
        launched_by: "desktop",
      },
      visibility: "private",
    });
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("online");
    expect(store.getRuntime(registeredBody.runtimes[1].id)?.status).toBe("offline");

    const reconnected = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-1",
        runtimes: [{ type: "codex", version: "1.0.1" }],
      }),
    });
    const reconnectedBody = await reconnected.json();
    expect(reconnectedBody.runtimes[0].id).toBe(registeredBody.runtimes[0].id);
    expect(reconnectedBody.runtimes[0].metadata.version).toBe("1.0.1");

    const deregistered = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_ids: [registeredBody.runtimes[0].id] }),
    });
    expect(deregistered.status).toBe(200);
    expect((await deregistered.json()).status).toBe("ok");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("offline");

    const repos = await app.request("/api/daemon/workspaces/local/repos");
    const reposBody = await repos.json();
    expect(repos.status).toBe(200);
    expect(reposBody).toEqual({
      workspace_id: "local",
      repos: [],
      repos_version: registeredBody.repos_version,
      settings: {},
    });
  });

  it("serves local user and workspace compatibility endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });

    const me = await app.request("/api/me");
    const meBody = await me.json();
    expect(me.status).toBe(200);
    expect(meBody).toMatchObject({
      id: "local",
      email: "local@multica.local",
      onboarding_questionnaire: {},
      profile_description: "",
    });

    const invalidLanguage = await app.request("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "<script>" }),
    });
    expect(invalidLanguage.status).toBe(400);

    const updated = await app.request("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Local Operator",
        language: "zh-Hans",
        timezone: "Asia/Shanghai",
        profile_description: "Works locally",
      }),
    });
    const updatedBody = await updated.json();
    expect(updated.status).toBe(200);
    expect(updatedBody.name).toBe("Local Operator");
    expect(updatedBody.language).toBe("zh-Hans");
    expect(updatedBody.timezone).toBe("Asia/Shanghai");
    expect(updatedBody.profile_description).toBe("Works locally");

    const onboarding = await app.request("/api/me/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionnaire: { source: "codex", role: "builder" } }),
    });
    expect((await onboarding.json()).onboarding_questionnaire).toEqual({ source: "codex", role: "builder" });

    const completed = await app.request("/api/me/onboarding/complete", { method: "POST" });
    expect((await completed.json()).onboarded_at).toBeString();

    const initialWorkspaces = await app.request("/api/workspaces");
    const initialWorkspacesBody = await initialWorkspaces.json();
    expect(initialWorkspaces.status).toBe(200);
    expect(initialWorkspacesBody[0]).toMatchObject({
      id: "local",
      slug: "local",
      issue_prefix: "MUL",
    });

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Product Team", slug: "product-team", description: "Builds product" }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody.slug).toBe("product-team");
    expect(createdBody.issue_prefix).toBe("PRO");

    const duplicate = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Product Team", slug: "product-team" }),
    });
    expect(duplicate.status).toBe(409);

    const detail = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}`);
    expect((await detail.json()).name).toBe("Product Team");

    const members = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members`);
    const membersBody = await members.json();
    expect(membersBody[0]).toMatchObject({
      workspaceId: createdBody.id,
      role: "owner",
      email: "local@multica.local",
    });

    const updatedMember = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect((await updatedMember.json()).role).toBe("admin");

    const githubConnect = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/github/connect`);
    expect(await githubConnect.json()).toEqual({ configured: false });
    const githubInstallations = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/github/installations`);
    expect(await githubInstallations.json()).toEqual({
      installations: [],
      configured: false,
      can_manage: true,
    });

    const deletedMember = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "DELETE",
    });
    expect(deletedMember.status).toBe(204);

    const invitations = await app.request("/api/invitations");
    expect(await invitations.json()).toEqual([]);
  });

  it("serves workspace, runtime, auth, webhook, and setup compatibility fallbacks", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Fallback Team", slug: "fallback-team" });
    const runtime = store.registerRuntime({ name: "Fallback Runtime", provider: "codex", workspaceId: workspace.id });
    const app = createMulticaApp({ store });

    const updated = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fallback Renamed", issue_prefix: "FB" }),
    });
    expect((await updated.json()).issue_prefix).toBe("FB");

    const leave = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: `mem_${workspace.id}_local` }),
    });
    expect(leave.status).toBe(204);

    const sentCode = await app.request("/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Compat@Example.com", name: "Compat User" }),
    });
    const sentCodeBody = await sentCode.json();
    expect(sentCode.status).toBe(200);
    expect(sentCodeBody.email).toBe("compat@example.com");
    expect(sentCodeBody.code).toMatch(/^\d{6}$/);
    const verifiedCode = await app.request("/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "compat@example.com", code: sentCodeBody.code }),
    });
    const verifiedCodeBody = await verifiedCode.json();
    expect(verifiedCode.status).toBe(200);
    expect(verifiedCodeBody.access_token).toStartWith("mul_");
    expect(verifiedCodeBody.user.email).toBe("compat@example.com");
    const googleLogin = await app.request("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "google@example.com", name: "Google User" }),
    });
    const googleLoginBody = await googleLogin.json();
    expect(googleLogin.status).toBe(200);
    expect(googleLoginBody.user.name).toBe("Google User");
    const realtimeHealth = await app.request("/health/realtime");
    expect(await realtimeHealth.json()).toMatchObject({ enabled: true, connections: 0, transport: "websocket" });
    expect((await (await app.request("/api/github/setup")).json()).configured).toBe(false);
    expect((await app.request("/api/webhooks/github", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/webhooks/autopilots/missing", { method: "POST" })).status).toBe(404);
    const wsFallback = await app.request("/api/daemon/ws");
    expect(wsFallback.status).toBe(426);
    expect((await wsFallback.json()).upgrade_required).toBe(true);

    expect((await app.request(`/api/runtimes/${runtime.id}/activity`)).status).toBe(200);
    expect((await app.request(`/api/runtimes/${runtime.id}`, { method: "DELETE" })).status).toBe(204);

    const removable = store.createWorkspace({ name: "Removable Team", slug: "removable-team" });
    expect((await app.request(`/api/workspaces/${removable.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("serves local workspace invitation compatibility endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const workspace = store.createWorkspace({ name: "Invite Team", slug: "invite-team" });

    const invalid = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(invalid.status).toBe(400);

    const created = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com", role: "admin" }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody).toMatchObject({
      workspace_id: workspace.id,
      inviter_id: "local",
      invitee_email: "teammate@example.com",
      role: "admin",
      status: "pending",
      workspace_name: "Invite Team",
      inviter_email: "local@multica.local",
    });

    const duplicate = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com", role: "member" }),
    });
    expect(duplicate.status).toBe(409);

    const workspaceInvitations = await app.request(`/api/workspaces/${workspace.id}/invitations`);
    const workspaceInvitationsBody = await workspaceInvitations.json();
    expect(workspaceInvitationsBody[0].id).toBe(createdBody.id);

    const fetched = await app.request(`/api/invitations/${createdBody.id}`);
    expect((await fetched.json()).invitee_email).toBe("teammate@example.com");

    const revoked = await app.request(`/api/workspaces/${workspace.id}/invitations/${createdBody.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);

    db!.run(
      `INSERT INTO multica_workspaces (
        id, name, slug, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES ('ws_external_invite', 'External Invite', 'external-invite', '{}', '[]', 'EXT', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z')`,
    );
    const acceptInvite = await app.request("/api/workspaces/ws_external_invite/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "local@multica.local", role: "member" }),
    });
    const acceptInviteBody = await acceptInvite.json();
    const myInvites = await app.request("/api/invitations");
    expect((await myInvites.json())[0].id).toBe(acceptInviteBody.id);

    const accepted = await app.request(`/api/invitations/${acceptInviteBody.id}/accept`, { method: "POST" });
    expect((await accepted.json()).status).toBe("accepted");
    expect(store.listWorkspaceMembers("ws_external_invite").some((member) => member.email === "local@multica.local")).toBe(true);

    const declineInvite = await app.request("/api/workspaces/ws_external_invite/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "local@multica.local", role: "admin" }),
    });
    expect(declineInvite.status).toBe(409);
  });

  it("serves config, cli token, logout, and onboarding bootstrap compatibility endpoints", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Onboarding Team", slug: "onboarding-team" });
    const runtime = store.registerRuntime({ name: "Codex Runtime", provider: "codex", workspaceId: workspace.id });
    const app = createMulticaApp({ store });

    const config = await app.request("/api/config");
    const configBody = await config.json();
    expect(config.status).toBe(200);
    expect(configBody.allow_signup).toBe(true);
    expect(configBody.cdn_domain).toBe("");

    const cliToken = await app.request("/api/cli-token", { method: "POST" });
    const cliTokenBody = await cliToken.json();
    expect(cliToken.status).toBe(200);
    expect(cliTokenBody.token).toStartWith("mul_");

    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(await logout.json()).toEqual({ message: "logged out" });

    const badWaitlist = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-email" }),
    });
    expect(badWaitlist.status).toBe(400);

    const waitlist = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "local@example.com", reason: "cloud please" }),
    });
    expect((await waitlist.json()).onboarding_questionnaire.cloud_waitlist_email).toBe("local@example.com");

    const runtimeBootstrap = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id, runtime_id: runtime.id }),
    });
    const runtimeBootstrapBody = await runtimeBootstrap.json();
    expect(runtimeBootstrap.status).toBe(200);
    expect(runtimeBootstrapBody.workspace_id).toBe(workspace.id);
    expect(runtimeBootstrapBody.agent_id).toBe("agt_default_codex");
    expect(store.getIssue(runtimeBootstrapBody.issue_id)?.title).toBe("Connect your local runtime");
    expect(store.listTasks().some((task) => task.issueId === runtimeBootstrapBody.issue_id)).toBe(true);

    const noRuntimeBootstrap = await app.request("/api/me/onboarding/no-runtime-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    const noRuntimeBootstrapBody = await noRuntimeBootstrap.json();
    expect(noRuntimeBootstrap.status).toBe(200);
    expect(store.getIssue(noRuntimeBootstrapBody.issue_id)?.title).toBe("Install a local runtime");
    expect(store.getCurrentUser().onboardedAt).toBeString();
  });

  it("serves original health, cloud runtime, issue task, subscription, and daemon polling compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ id: "mem_compat", name: "Compat Member" });
    const issue = store.createIssue({
      title: "Compatibility task surface",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Run compatibility" });
    store.reportTaskUsage(task.id, [{
      provider: "codex",
      model: "gpt-5",
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    }]);
    const runtime = store.registerRuntime({ name: "Codex Runtime", provider: "codex", workspaceId: "local" });
    const app = createMulticaApp({ store });

    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
    const cloudHealth = await app.request("/api/cloud-runtime/healthz");
    expect(await cloudHealth.json()).toMatchObject({ ok: true, configured: true, mode: "local" });

    const createdCloudNode = await app.request("/api/cloud-runtime/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_type: "g5.xlarge", name: "Local GPU", tags: { env: "test" } }),
    });
    expect(createdCloudNode.status).toBe(201);
    const createdCloudNodeBody = await createdCloudNode.json();
    expect(createdCloudNodeBody.instance_type).toBe("g5.xlarge");
    expect(createdCloudNodeBody.name).toBe("Local GPU");
    expect(createdCloudNodeBody.status).toBe("launching");
    expect(createdCloudNodeBody.tags.env).toBe("test");

    const cloudRuntime = await app.request("/api/cloud-runtime/nodes?limit=10&offset=0");
    const cloudRuntimeBody = await cloudRuntime.json();
    expect(cloudRuntime.status).toBe(200);
    expect(cloudRuntimeBody[0].id).toBe(createdCloudNodeBody.id);

    const startedCloudNode = await app.request("/api/cloud-runtime/nodes/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id }),
    });
    expect((await startedCloudNode.json()).status).toBe("running");

    const execCloudNode = await app.request("/api/cloud-runtime/nodes/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id, command: "echo ok" }),
    });
    expect((await execCloudNode.json()).stdout).toContain("echo ok");

    const deletedCloudNode = await app.request("/api/cloud-runtime/nodes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id }),
    });
    expect(deletedCloudNode.status).toBe(204);

    const active = await app.request(`/api/issues/${issue.id}/active-task`);
    const activeBody = await active.json();
    expect(activeBody.tasks[0].id).toBe(task.id);
    expect(activeBody.tasks[0].issue_id).toBe(issue.id);

    const runs = await app.request(`/api/issues/${issue.id}/task-runs`);
    const runsBody = await runs.json();
    expect(runsBody[0].agent_id).toBe(agent.id);

    const usage = await app.request(`/api/issues/${issue.id}/usage`);
    expect(await usage.json()).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 8,
      total_cache_read_tokens: 3,
      total_cache_write_tokens: 2,
      task_count: 1,
    });

    const rerun = await app.request(`/api/issues/${issue.id}/rerun`, { method: "POST" });
    expect(rerun.status).toBe(202);
    expect((await rerun.json()).issue_id).toBe(issue.id);

    const subscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: member.id }),
    });
    expect(await subscribe.json()).toEqual({ subscribed: true });
    const subscribers = await app.request(`/api/issues/${issue.id}/subscribers`);
    expect((await subscribers.json()).some((item: any) => item.memberId === member.id)).toBe(true);
    const unsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: member.id }),
    });
    expect(await unsubscribe.json()).toEqual({ subscribed: false });

    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    expect((await pending.json()).some((item: any) => item.id === task.id && item.workspace_id === "local")).toBe(true);

    const claimed = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.task.id).toBe(task.id);
    await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ type: "assistant", content: "compat done" }] }),
    });
    expect((await (await app.request(`/api/tasks/${task.id}/messages`)).json())[0].content).toBe("compat done");

    const gc = await app.request(`/api/daemon/issues/${issue.id}/gc-check`);
    expect((await gc.json()).updated_at).toBeString();

    const cancelledByTaskId = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(cancelledByTaskId.status).toBe(200);
    expect((await cancelledByTaskId.json()).status).toBe("cancelled");
  });

  it("serves upstream client compatibility endpoints for env, billing, lark, chat, and batched children", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const agent = store.createAgent({
      name: "Compat Codex",
      provider: "codex",
      customEnv: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });
    const skill = store.createSkill({ name: "Deploy Helper", description: "Deployment skill", content: "ship it" });
    const parent = store.createIssue({ title: "Parent issue", workspaceId: "local" });
    const child = store.createIssue({ title: "Child issue", workspaceId: "local", parentIssueId: parent.id });
    const runtime = store.registerRuntime({ name: "Compat runtime", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "wait locally" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Compat chat" });
    const squad = store.createSquad({ name: "Compat squad", leaderId: agent.id });
    const squadIssue = store.createIssue({
      title: "Squad evaluation",
      workspaceId: "local",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const squadTask = store.createTask({ agentId: agent.id, issueId: squadIssue.id, prompt: "evaluate squad" });

    const env = await app.request(`/api/agents/${agent.id}/env`);
    expect(await env.json()).toMatchObject({ agent_id: agent.id, custom_env: { SECRET_TOKEN: "real-value" } });

    const updatedEnv = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ADDED: "new" } }),
    });
    expect((await updatedEnv.json()).custom_env).toEqual({ SECRET_TOKEN: "real-value", ADDED: "new" });

    const addedSkills = await app.request(`/api/agents/${agent.id}/skills/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: [skill.id, skill.id] }),
    });
    expect((await addedSkills.json()).map((item: any) => item.id)).toEqual([skill.id]);

    const skillSearch = await app.request("/api/skills/search?q=deploy");
    const skillSearchBody = await skillSearch.json();
    expect(Array.isArray(skillSearchBody)).toBe(true);
    expect(skillSearchBody[0].name).toBe("Deploy Helper");

    const batchedChildren = await app.request(`/api/issues/children?parent_ids=${encodeURIComponent(parent.id)}`);
    expect((await batchedChildren.json()).issues[0].id).toBe(child.id);

    const squadEvaluated = await app.request(`/api/issues/${squadIssue.id}/squad-evaluated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": agent.id,
        "X-Task-ID": squadTask.id,
      },
      body: JSON.stringify({ outcome: "no_action", reason: "nothing to delegate" }),
    });
    const squadEvaluatedBody = await squadEvaluated.json();
    expect(squadEvaluated.status).toBe(201);
    expect(squadEvaluatedBody.type).toBe("squad_leader_evaluated");
    expect(squadEvaluatedBody.data).toMatchObject({ outcome: "no_action", squad_id: squad.id, task_id: squadTask.id });

    await app.request(`/api/chat/sessions/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello page" }),
    });
    const chatPage = await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`);
    const chatPageBody = await chatPage.json();
    expect(chatPageBody.messages[0].chat_session_id).toBe(chat.id);
    expect(chatPageBody.limit).toBe(1);
    expect(chatPageBody.has_more).toBe(false);

    const waitLocalDirectory = await app.request(`/api/daemon/tasks/${task.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/repo" }),
    });
    expect((await waitLocalDirectory.json()).progress_summary).toContain("/tmp/repo");

    const renew = await app.request("/api/tokens/current/renew", { method: "POST" });
    const renewBody = await renew.json();
    expect(renew.status).toBe(201);
    expect(renewBody.access_token).toStartWith("mul_");

    expect(await (await app.request("/api/cloud-billing/balance")).json()).toMatchObject({
      owner_id: "local",
      balance_micro: 0,
      balance_credit: 0,
      configured: false,
    });
    expect((await (await app.request("/api/cloud-billing/transactions?page=2&page_size=5")).json()).page).toBe(2);
    expect((await (await app.request("/api/cloud-billing/price-tiers")).json())[0].configured).toBe(false);
    expect((await (await app.request("/api/cloud-billing/checkout-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier_id: "local-disabled" }),
    })).json()).session_id).toBe("local-disabled");
    expect((await (await app.request("/api/cloud-billing/portal-sessions", { method: "POST" })).json()).configured).toBe(false);

    const larkList = await app.request("/api/workspaces/local/lark/installations");
    expect(await larkList.json()).toMatchObject({ configured: false, install_supported: false, installations: [] });
    expect((await (await app.request("/api/workspaces/local/lark/install/begin?agent_id=agt", { method: "POST" })).json()).error_reason).toBe("not_configured");
    expect((await (await app.request("/api/workspaces/local/lark/install/session-1/status")).json()).status).toBe("error");
    expect((await app.request("/api/workspaces/local/lark/installations/lin_1", { method: "DELETE" })).status).toBe(204);
    expect((await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "lark-token" }),
    })).status).toBe(409);

    expect((await app.request("/api/webhooks/stripe", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/contact-sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com" }),
    })).status).toBe(201);

    const cascade = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id] }),
    });
    const cascadeBody = await cascade.json();
    expect(cascadeBody).toEqual({ status: "deleted", agents_archived: 1, tasks_cancelled: 3 });
    expect(store.getRuntime(runtime.id)).toBeNull();
    expect(store.getAgent(agent.id)?.archivedAt).toBeString();
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

    const updated = await app.request(`/api/issues/${createdBody.issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: "high" }),
    });
    expect((await updated.json()).priority).toBe("high");
  });

  it("serves issue compatibility list, grouped, and batch endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Issue owner" });
    const project = store.createProject({ title: "Batch project" });
    const app = createMulticaApp({ store });

    const first = store.createIssue({
      title: "Batch first",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
      status: "open",
      priority: "low",
      position: 2,
    });
    const second = store.createIssue({
      title: "Batch second",
      workspaceId: "local",
      assigneeType: "member",
      assigneeId: member.id,
      status: "open",
      priority: "medium",
      position: 1,
    });
    store.createIssue({ title: "Other workspace", workspaceId: "other", status: "open" });

    const listed = await app.request("/api/issues?workspace_id=local&status=open");
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(2);
    expect(listedBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());

    const grouped = await app.request("/api/issues/grouped?workspace_id=local&statuses=open&limit=10");
    const groupedBody = await grouped.json();
    expect(groupedBody.groups.map((group: any) => group.id)).toEqual([
      `member:${member.id}`,
      `agent:${agent.id}`,
    ]);
    expect(groupedBody.groups[0].total).toBe(1);
    expect(groupedBody.groups[1].issues[0].id).toBe(first.id);

    const noMutation = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id], updates: {} }),
    });
    expect(await noMutation.json()).toEqual({ updated: 0 });

    const updated = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issue_ids: [first.id, "missing", second.id],
        updates: { status: "done", priority: "urgent", project_id: project.id },
      }),
    });
    expect(await updated.json()).toEqual({ updated: 2 });
    expect(store.getIssue(first.id)?.status).toBe("done");
    expect(store.getIssue(second.id)?.priority).toBe("urgent");

    const deleted = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id, second.id, "missing"] }),
    });
    expect(await deleted.json()).toEqual({ deleted: 2 });
    expect(store.getIssue(first.id)).toBeNull();
    expect(store.getIssue(second.id)).toBeNull();
  });

  it("serves quick-create issue compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Quick Codex", provider: "codex" });
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Quick squad", leaderId: leader.id });
    const project = store.createProject({ title: "Quick project" });
    const app = createMulticaApp({ store });

    const created = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agent.id,
        prompt: "Create an issue for improving onboarding screenshots",
        project_id: project.id,
        workspace_id: "local",
      }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();
    expect(createdBody.task_id).toStartWith("tsk_");
    const task = store.getTask(createdBody.task_id)!;
    expect(task.agentId).toBe(agent.id);
    expect(task.issueId).toBeString();
    const issue = store.getIssue(task.issueId!)!;
    expect(issue.title).toBe("Create an issue for improving onboarding screenshots");
    expect(issue.projectId).toBe(project.id);
    expect(issue.assigneeType).toBe("agent");
    expect(issue.contextRefs[0]).toEqual({ type: "quick_create", prompt: "Create an issue for improving onboarding screenshots" });

    const squadCreated = await app.request("/api/multica/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad_id: squad.id, prompt: "Plan squad handoff" }),
    });
    expect(squadCreated.status).toBe(202);
    const squadBody = await squadCreated.json();
    expect(squadBody.task.agentId).toBe(leader.id);
    expect(squadBody.issue.assigneeType).toBe("squad");
    expect(squadBody.task_id).toBe(squadBody.task.id);

    const badPrompt = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, prompt: "   " }),
    });
    expect(badPrompt.status).toBe(400);
    expect((await badPrompt.json()).error).toBe("prompt is required");
  });

  it("serves issue hierarchy and planning fields through API endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const project = store.createProject({ title: "API hierarchy" });

    const parentRes = await app.request("/api/multica/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API parent",
        project_id: project.id,
        priority: "high",
        due_date: "2026-06-10T12:00:00+08:00",
        acceptance_criteria: ["works"],
        context_refs: [{ type: "repo", url: "git@example.com:repo.git" }],
      }),
    });
    expect(parentRes.status).toBe(201);
    const parent = (await parentRes.json()).issue;

    const childRes = await app.request("/api/multica/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API child", parent_issue_id: parent.id, position: 3 }),
    });
    expect(childRes.status).toBe(201);
    const child = (await childRes.json()).issue;
    expect(child.parentIssueId).toBe(parent.id);
    expect(child.projectId).toBe(project.id);

    const updated = await app.request(`/api/multica/issues/${child.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", priority: "urgent", start_date: "2026-06-04T09:00:00+08:00" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).issue.priority).toBe("urgent");

    const detail = await app.request(`/api/multica/issues/${parent.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.dueDate).toBe("2026-06-10T04:00:00.000Z");
    expect(detailBody.issue.acceptanceCriteria).toEqual(["works"]);
    expect(detailBody.children.map((item: any) => item.id)).toEqual([child.id]);
    expect(detailBody.childProgress).toEqual({ parentIssueId: parent.id, total: 1, done: 1 });

    const children = await app.request(`/api/issues/${parent.id}/children`);
    expect((await children.json()).total).toBe(1);

    const progress = await app.request("/api/issues/child-progress?workspaceId=local");
    expect((await progress.json()).progress).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);
  });

  it("serves issue dependency endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const blocker = store.createIssue({ title: "API blocker" });
    const blocked = store.createIssue({ title: "API blocked" });

    const created = await app.request(`/api/issues/${blocked.id}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depends_on_issue_id: blocker.id, type: "blocked_by" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.dependency.dependsOnIssueId).toBe(blocker.id);
    expect(createdBody.dependency.dependsOnIssue.title).toBe("API blocker");

    const listed = await app.request(`/api/multica/issues/${blocker.id}/dependencies`);
    expect((await listed.json()).total).toBe(1);

    const detail = await app.request(`/api/multica/issues/${blocked.id}`);
    expect((await detail.json()).dependencies[0].id).toBe(createdBody.dependency.id);

    const deleted = await app.request(`/api/issues/${blocked.id}/dependencies/${createdBody.dependency.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(store.listIssueDependencies(blocked.id)).toEqual([]);
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

  it("serves original project, squad, and autopilot compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Original Codex", provider: "codex" });
    const app = createMulticaApp({ store });

    const project = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original Project", priority: "high" }),
    });
    const projectBody = await project.json();
    expect(project.status).toBe(201);
    expect(projectBody.title).toBe("Original Project");
    expect((await (await app.request("/api/projects")).json())[0].id).toBe(projectBody.id);

    const resource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "github_repo", resource_ref: { url: "https://github.com/example/repo" } }),
    });
    const resourceBody = await resource.json();
    expect(resource.status).toBe(201);
    expect((await (await app.request(`/api/projects/${projectBody.id}/resources`)).json())[0].id).toBe(resourceBody.id);

    const squad = await app.request("/api/squads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Original Squad", leaderId: agent.id }),
    });
    const squadBody = await squad.json();
    expect(squad.status).toBe(201);
    expect((await (await app.request(`/api/squads/${squadBody.id}/members/status`)).json())[0].status).toBe("available");

    const autopilot = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Original Autopilot",
        projectId: projectBody.id,
        assigneeId: agent.id,
        triggerKind: "webhook",
      }),
    });
    const autopilotBody = await autopilot.json();
    expect(autopilot.status).toBe(201);
    expect(autopilotBody.title).toBe("Original Autopilot");

    const run = await app.request(`/api/autopilots/${autopilotBody.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Run original autopilot" }),
    });
    const runBody = await run.json();
    expect(run.status).toBe(201);
    expect(runBody.source).toBe("api");
    expect((await (await app.request(`/api/autopilots/${autopilotBody.id}/runs/${runBody.id}`)).json()).id).toBe(runBody.id);

    const trigger = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", label: "Original Webhook" }),
    });
    const triggerBody = await trigger.json();
    expect(trigger.status).toBe(201);
    expect(triggerBody.autopilot_id).toBe(autopilotBody.id);
    expect(triggerBody.webhook_token).toStartWith("awt_");
    expect(triggerBody.webhook_path).toBe(`/api/webhooks/autopilots/${triggerBody.webhook_token}`);

    const triggerDetail = await app.request(`/api/autopilots/${autopilotBody.id}`);
    expect((await triggerDetail.json()).triggers[0].id).toBe(triggerBody.id);

    expect((await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/squads/${squadBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/autopilots/${autopilotBody.id}`, { method: "DELETE" })).status).toBe(204);
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

  it("serves issue label endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "Label API", workspaceId: "local" });

    const created = await app.request("/api/multica/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Review", color: "3399FF", workspace_id: "local" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.label.color).toBe("#3399ff");

    const listed = await app.request("/api/multica/labels?workspaceId=local");
    expect((await listed.json()).total).toBe(1);

    const updated = await app.request(`/api/labels/${createdBody.label.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewed", color: "#22aa66" }),
    });
    expect((await updated.json()).label.name).toBe("Reviewed");

    const attached = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label_id: createdBody.label.id }),
    });
    expect(attached.status).toBe(201);
    expect((await attached.json()).labels[0].name).toBe("Reviewed");

    const detail = await app.request(`/api/multica/issues/${issue.id}`);
    expect((await detail.json()).issue.labels[0].color).toBe("#22aa66");

    const detached = await app.request(`/api/multica/issues/${issue.id}/labels/${createdBody.label.id}`, {
      method: "DELETE",
    });
    expect((await detached.json()).labels).toHaveLength(0);
  });

  it("serves direct skill PUT compatibility endpoint", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const skill = store.createSkill({ name: "api-skill", content: "# API Skill" });

    const updated = await app.request(`/api/skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated through direct PUT" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).description).toBe("Updated through direct PUT");
  });

  it("serves pinned item endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "Pinned API issue", workspaceId: "local" });
    const project = store.createProject({ title: "Pinned API project", workspaceId: "local" });

    const issuePin = await app.request("/api/multica/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemType: "issue", itemId: issue.id, workspaceId: "local", userId: "local" }),
    });
    expect(issuePin.status).toBe(201);
    const issuePinBody = await issuePin.json();
    expect(issuePinBody.pin.itemType).toBe("issue");

    const projectPin = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_type: "project", item_id: project.id, workspace_id: "local", user_id: "local" }),
    });
    expect(projectPin.status).toBe(201);
    const projectPinBody = await projectPin.json();

    const listed = await app.request("/api/multica/pins?workspaceId=local&userId=local");
    expect((await listed.json()).pins).toHaveLength(2);

    const reordered = await app.request("/api/pins/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "local",
        userId: "local",
        items: [
          { id: issuePinBody.pin.id, position: 2 },
          { id: projectPinBody.pin.id, position: 1 },
        ],
      }),
    });
    expect((await reordered.json()).pins.map((pin: any) => pin.id)).toEqual([projectPinBody.pin.id, issuePinBody.pin.id]);

    const deleted = await app.request(`/api/multica/pins/project/${project.id}?workspaceId=local&userId=local`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(store.listPinnedItems("local", "local")).toHaveLength(1);
  });

  it("serves issue and project search endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "Searchable API issue", description: "Has api needle context", workspaceId: "local" });
    const closedIssue = store.createIssue({ title: "Closed API issue", description: "closed needle", workspaceId: "local" });
    store.updateIssue(closedIssue.id, { status: "done" });
    store.createProject({ title: "Searchable API project", description: "No needle", workspaceId: "local" });
    store.createProject({ title: "Other project", description: "Project needle context", workspaceId: "local" });

    const byTitle = await app.request("/api/multica/issues/search?q=searchable%20api&workspaceId=local");
    expect(byTitle.status).toBe(200);
    const byTitleBody = await byTitle.json();
    expect(byTitleBody.issues[0].id).toBe(issue.id);
    expect(byTitleBody.issues[0].matchSource).toBe("title");

    const compatIssueSearch = await app.request("/api/issues/search?q=needle&workspaceId=local&include_closed=true&limit=1");
    const compatIssueBody = await compatIssueSearch.json();
    expect(compatIssueBody.issues).toHaveLength(1);
    expect(compatIssueBody.total).toBeGreaterThanOrEqual(1);

    const projectSearch = await app.request("/api/projects/search?q=project%20needle&workspaceId=local");
    const projectBody = await projectSearch.json();
    expect(projectBody.projects[0].matchSource).toBe("description");
    expect(projectBody.projects[0].matchedSnippet).toContain("needle");
  });

  it("serves issue subscribers and member inbox endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const alice = store.createWorkspaceMember({ name: "Alice API" });
    const bob = store.createWorkspaceMember({ name: "Bob API" });
    const issue = store.createIssue({ title: "Inbox API", createdBy: alice.id });

    const subscribed = await app.request(`/api/multica/issues/${issue.id}/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: bob.id, reason: "manual" }),
    });
    expect(subscribed.status).toBe(201);
    expect((await subscribed.json()).subscriber.memberId).toBe(bob.id);

    const subscribers = await app.request(`/api/multica/issues/${issue.id}/subscribers`);
    expect((await subscribers.json()).subscribers.map((subscriber: any) => subscriber.memberId).sort()).toEqual([
      alice.id,
      bob.id,
    ].sort());

    const commented = await app.request(`/api/multica/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorType: "member", authorId: alice.id, body: "Can you check this?" }),
    });
    expect(commented.status).toBe(201);

    const inbox = await app.request(`/api/multica/inbox?memberId=${encodeURIComponent(bob.id)}`);
    const inboxBody = await inbox.json();
    expect(inboxBody.unread).toBe(1);
    expect(inboxBody.items[0].issue.key).toBe(issue.key);

    const read = await app.request(`/api/multica/inbox/${inboxBody.items[0].id}/read`, { method: "POST" });
    expect((await read.json()).item.read).toBe(true);

    const archived = await app.request(`/api/multica/inbox/${inboxBody.items[0].id}/archive`, { method: "POST" });
    expect((await archived.json()).item.archived).toBe(true);

    const afterArchive = await app.request(`/api/multica/inbox?memberId=${encodeURIComponent(bob.id)}`);
    expect((await afterArchive.json()).items).toHaveLength(0);
  });

  it("serves original agent, skill file, chat, and inbox compatibility endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const alice = store.createWorkspaceMember({ name: "Original Alice" });
    const bob = store.createWorkspaceMember({ name: "Original Bob" });

    const createdAgent = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Original Codex", provider: "codex" }),
    });
    const agent = await createdAgent.json();
    expect(createdAgent.status).toBe(201);
    expect(agent.provider).toBe("codex");

    const archived = await app.request(`/api/agents/${agent.id}/archive`, { method: "POST" });
    expect((await archived.json()).archivedAt).toBeString();
    const restored = await app.request(`/api/agents/${agent.id}/restore`, { method: "POST" });
    expect((await restored.json()).archivedAt).toBeNull();

    const skill = store.createSkill({ name: "Original Skill", content: "# Skill" });
    const file = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/check.md", content: "Check" }),
    });
    const fileBody = await file.json();
    expect(fileBody.path).toBe("notes/check.md");
    const files = await app.request(`/api/skills/${skill.id}/files`);
    expect((await files.json())[0].content).toBe("Check");

    const chat = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, title: "Original chat" }),
    });
    const chatBody = await chat.json();
    expect(chatBody.agent_id).toBe(agent.id);
    const sent = await app.request(`/api/chat/sessions/${chatBody.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello original" }),
    });
    const sentBody = await sent.json();
    expect(sentBody.message.chat_session_id).toBe(chatBody.id);
    expect(sentBody.task.chat_session_id).toBe(chatBody.id);
    const pending = await app.request(`/api/chat/sessions/${chatBody.id}/pending-task`);
    expect((await pending.json()).task_id).toBe(sentBody.task.id);
    const pendingAll = await app.request("/api/chat/pending-tasks");
    expect((await pendingAll.json()).tasks[0].chat_session_id).toBe(chatBody.id);
    expect((await app.request(`/api/chat/sessions/${chatBody.id}/read`, { method: "POST" })).status).toBe(204);

    const issue = store.createIssue({ title: "Original inbox", createdBy: alice.id });
    store.addIssueSubscriber(issue.id, bob.id);
    store.createIssueComment(issue.id, { authorType: "member", authorId: alice.id, body: "Ping Bob" });
    const inbox = await app.request(`/api/inbox?member_id=${encodeURIComponent(bob.id)}`);
    const inboxBody = await inbox.json();
    expect(inboxBody[0].member_id).toBe(bob.id);
    expect((await (await app.request(`/api/inbox/unread-count?member_id=${encodeURIComponent(bob.id)}`)).json()).count).toBe(1);
    expect((await (await app.request(`/api/inbox/mark-all-read?member_id=${encodeURIComponent(bob.id)}`, { method: "POST" })).json()).count).toBe(1);
    expect((await (await app.request(`/api/inbox/archive-all-read?member_id=${encodeURIComponent(bob.id)}`, { method: "POST" })).json()).count).toBe(1);
    expect((await app.request(`/api/chat/sessions/${chatBody.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await app.request(`/api/skills/${skill.id}/files/${fileBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await app.request(`/api/agents/${agent.id}/cancel-tasks`, { method: "POST" })).json()).cancelled).toBe(0);
  });

  it("serves comment threads, reactions, and attachments through API", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "API collaboration" });

    const issueAttachment = await app.request(`/api/multica/issues/${issue.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "design.png",
        url: "https://example.com/design.png",
        contentType: "image/png",
        sizeBytes: 1024,
        uploaderType: "member",
        uploaderId: "local",
      }),
    });
    expect(issueAttachment.status).toBe(201);
    const issueAttachmentBody = await issueAttachment.json();
    expect(issueAttachmentBody.attachment.issueId).toBe(issue.id);

    const root = await app.request(`/api/multica/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Root API comment" }),
    });
    const rootBody = await root.json();
    const originalComment = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Original API comment" }),
    });
    expect((await originalComment.json()).body).toBe("Original API comment");

    const pendingAttachment = store.createAttachment({
      filename: "reply.md",
      url: "https://example.com/reply.md",
      uploaderType: "member",
      uploaderId: "local",
    });
    const reply = await app.request(`/api/multica/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Reply API comment", parentId: rootBody.comment.id, attachmentIds: [pendingAttachment.id] }),
    });
    const replyBody = await reply.json();
    expect(replyBody.comment.parentId).toBe(rootBody.comment.id);
    expect(replyBody.comment.attachments[0].id).toBe(pendingAttachment.id);

    const edited = await app.request(`/api/comments/${replyBody.comment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Edited API reply" }),
    });
    expect((await edited.json()).comment.body).toBe("Edited API reply");

    const resolved = await app.request(`/api/multica/comments/${rootBody.comment.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorType: "member", actorId: "local" }),
    });
    expect((await resolved.json()).comment.resolvedAt).toBeString();

    const unresolved = await app.request(`/api/comments/${rootBody.comment.id}/resolve`, { method: "DELETE" });
    expect((await unresolved.json()).comment.resolvedAt).toBeNull();

    const issueReaction = await app.request(`/api/multica/issues/${issue.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👍", actor_type: "member", actor_id: "local" }),
    });
    expect((await issueReaction.json()).reaction.emoji).toBe("👍");
    expect((await (await app.request(`/api/issues/${issue.id}/reactions`)).json())[0].emoji).toBe("👍");
    const metadata = await app.request(`/api/issues/${issue.id}/metadata/original_path`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect((await metadata.json()).original_path).toBe(true);
    expect((await (await app.request(`/api/issues/${issue.id}/metadata`)).json()).original_path).toBe(true);
    expect((await (await app.request(`/api/issues/${issue.id}/attachments`)).json())[0].id).toBe(issueAttachmentBody.attachment.id);

    const commentReaction = await app.request(`/api/multica/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👀", actorType: "agent", actorId: "agt-api" }),
    });
    expect((await commentReaction.json()).reaction.emoji).toBe("👀");
    const originalCommentReaction = await app.request(`/api/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "✅", actorType: "member", actorId: "local" }),
    });
    expect((await originalCommentReaction.json()).emoji).toBe("✅");

    const detail = await app.request(`/api/multica/issues/${issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.reactions).toHaveLength(1);
    expect(detailBody.issue.attachments).toHaveLength(1);
    expect(detailBody.comments.find((comment: any) => comment.id === replyBody.comment.id).reactions).toHaveLength(2);

    const timeline = await app.request(`/api/issues/${issue.id}/timeline`);
    const timelineBody = await timeline.json();
    const timelineIds = timelineBody.map((entry: any) => entry.id);
    expect(timelineIds).toContain(rootBody.comment.id);
    expect(timelineIds).toContain(replyBody.comment.id);
    expect(timelineBody.find((entry: any) => entry.id === replyBody.comment.id).attachments[0].id).toBe(pendingAttachment.id);
    for (let index = 1; index < timelineBody.length; index++) {
      expect(timelineBody[index - 1].created_at <= timelineBody[index].created_at).toBe(true);
    }

    const wrappedTimeline = await app.request(`/api/multica/issues/${issue.id}/timeline?limit=50&around=${encodeURIComponent(rootBody.comment.id)}`);
    const wrappedTimelineBody = await wrappedTimeline.json();
    expect(wrappedTimelineBody.next_cursor).toBeNull();
    expect(wrappedTimelineBody.prev_cursor).toBeNull();
    expect(wrappedTimelineBody.has_more_before).toBe(false);
    expect(wrappedTimelineBody.has_more_after).toBe(false);
    expect(wrappedTimelineBody.entries[wrappedTimelineBody.target_index].id).toBe(rootBody.comment.id);
    for (let index = 1; index < wrappedTimelineBody.entries.length; index++) {
      expect(wrappedTimelineBody.entries[index - 1].created_at >= wrappedTimelineBody.entries[index].created_at).toBe(true);
    }

    const deleted = await app.request(`/api/multica/comments/${replyBody.comment.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(store.getIssueComment(replyBody.comment.id)).toBeNull();
  });

  it("uploads, downloads, and deletes local attachment files", async () => {
    useUploadDir();
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "Upload API" });
    const form = new FormData();
    form.append("file", new File(["hello upload"], "note.txt", { type: "text/plain" }));
    form.append("issue_id", issue.id);
    form.append("workspace_id", "local");

    const uploaded = await app.request("/api/upload-file", {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const uploadedBody = await uploaded.json();
    expect(uploadedBody.attachment.issueId).toBe(issue.id);
    expect(uploadedBody.attachment.url).toStartWith("/api/attachments/");
    expect(store.listAttachmentsForIssue(issue.id)[0]?.filename).toBe("note.txt");

    const meta = await app.request(`/api/attachments/${uploadedBody.attachment.id}`);
    expect((await meta.json()).attachment.filename).toBe("note.txt");

    const content = await app.request(`/api/attachments/${uploadedBody.attachment.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toContain("text/plain");
    expect(await content.text()).toBe("hello upload");

    const deleted = await app.request(`/api/attachments/${uploadedBody.attachment.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(store.getAttachment(uploadedBody.attachment.id)).toBeNull();

    const missing = await app.request(`/api/attachments/${uploadedBody.attachment.id}/content`);
    expect(missing.status).toBe(404);
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
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-delivery-1" },
      body: JSON.stringify({ prompt: "Webhook prompt", event: "opened" }),
    });
    expect(webhookTrigger.status).toBe(201);
    const webhookBody = await webhookTrigger.json();
    expect(webhookBody.status).toBe("accepted");
    expect(webhookBody.delivery.status).toBe("dispatched");
    expect(webhookBody.delivery.dedupeKey).toBe("api-delivery-1");
    expect(webhookBody.run.source).toBe("webhook");
    expect(webhookBody.run.payload.event).toBe("opened");
    expect(store.getIssue(webhookBody.run.issueId)?.title).toBe("Webhook prompt");

    const duplicate = await app.request(`/api/multica/autopilots/${autopilot.id}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-delivery-1" },
      body: JSON.stringify({ prompt: "Webhook duplicate" }),
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.status).toBe("duplicate");
    expect(duplicateBody.deliveryId).toBe(webhookBody.deliveryId);

    const deliveries = await app.request(`/api/multica/autopilots/${autopilot.id}/deliveries`);
    const deliveriesBody = await deliveries.json();
    expect(deliveriesBody.total).toBe(1);
    expect(deliveriesBody.deliveries[0].attemptCount).toBe(2);

    const detail = await app.request(`/api/multica/autopilots/${autopilot.id}`);
    expect((await detail.json()).deliveries[0].id).toBe(webhookBody.deliveryId);

    const trigger = await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", label: "Token webhook" }),
    });
    const triggerBody = await trigger.json();
    expect(trigger.status).toBe(201);
    expect(triggerBody.webhook_token).toStartWith("awt_");

    const tokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-1" },
      body: JSON.stringify({ prompt: "Token webhook prompt", payload: { via: "token" } }),
    });
    const tokenWebhookBody = await tokenWebhook.json();
    expect(tokenWebhook.status).toBe(201);
    expect(tokenWebhookBody.status).toBe("accepted");
    expect(tokenWebhookBody.delivery.triggerId).toBe(triggerBody.id);
    expect(tokenWebhookBody.run.payload.via).toBe("token");

    const rotated = await app.request(`/api/autopilots/${autopilot.id}/triggers/${triggerBody.id}/rotate-webhook-token`, { method: "POST" });
    const rotatedBody = await rotated.json();
    expect(rotatedBody.webhook_token).not.toBe(triggerBody.webhook_token);
    expect((await app.request(triggerBody.webhook_path, { method: "POST" })).status).toBe(404);

    const disabled = await app.request(`/api/autopilots/${autopilot.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await disabled.json()).enabled).toBe(false);
    const ignored = await app.request(rotatedBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-2" },
      body: JSON.stringify({ prompt: "Ignored token" }),
    });
    const ignoredBody = await ignored.json();
    expect(ignored.status).toBe(200);
    expect(ignoredBody.status).toBe("ignored");
    expect(ignoredBody.delivery.error).toBe("trigger_disabled");

    const replay = await app.request(`/api/multica/autopilots/${autopilot.id}/deliveries/${webhookBody.deliveryId}/replay`, { method: "POST" });
    expect(replay.status).toBe(201);
    expect((await replay.json()).delivery.replayedFromDeliveryId).toBe(webhookBody.deliveryId);
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

  it("serves notification preference endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });

    const updated = await app.request("/api/multica/notification-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { assignments: "muted", comments: "all" } }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).preferences.assignments).toBe("muted");

    const listed = await app.request("/api/multica/notification-preferences");
    expect((await listed.json()).preferences.assignments).toBe("muted");
  });

  it("serves feedback endpoints with validation and rate limiting", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });

    const created = await app.request("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "remi-test",
        "x-multica-platform": "desktop",
        "x-multica-version": "1.2.3",
      },
      body: JSON.stringify({
        message: "  Love the product, dark mode flashes on startup  ",
        url: "http://localhost:6130/issues",
        workspace_id: "local",
        member_id: "mem_feedback",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("fdb_");
    expect(createdBody.created_at).toBeString();

    const feedback = store.listFeedback("local")[0];
    expect(feedback.message).toBe("Love the product, dark mode flashes on startup");
    expect(feedback.memberId).toBe("mem_feedback");
    expect(feedback.userId).toBe("mem_feedback");
    expect(feedback.metadata.url).toBe("http://localhost:6130/issues");
    expect(feedback.metadata.platform).toBe("desktop");
    expect(feedback.metadata.version).toBe("1.2.3");
    expect(feedback.metadata.user_agent).toBe("remi-test");

    const multicaFeedback = await app.request("/api/multica/feedback");
    const multicaFeedbackBody = await multicaFeedback.json();
    expect(multicaFeedbackBody.total).toBe(1);
    expect(multicaFeedbackBody.feedback[0].id).toBe(createdBody.id);

    const empty = await app.request("/api/multica/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(empty.status).toBe(400);

    for (let i = 0; i < 9; i++) {
      const response = await app.request("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `feedback #${i}`, member_id: "mem_feedback" }),
      });
      expect(response.status).toBe(201);
    }

    const overLimit = await app.request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "one too many", member_id: "mem_feedback" }),
    });
    expect(overLimit.status).toBe(429);
  });

  it("serves GitHub settings, pull request, and webhook endpoints", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const issue = store.createIssue({ title: "GitHub API issue" });

    const unavailableConnect = await app.request("/api/workspaces/local/github/connect");
    expect(await unavailableConnect.json()).toEqual({ configured: false });

    const settings = await app.request("/api/multica/github/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prSidebar: false, coAuthor: false }),
    });
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json();
    expect(settingsBody.settings.enabled).toBe(true);
    expect(settingsBody.settings.prSidebar).toBe(false);
    expect(settingsBody.settings.coAuthor).toBe(false);

    const created = await app.request("/api/multica/github/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_owner: "example",
        repo_name: "remi",
        number: 7,
        title: `${issue.key} API linked PR`,
        branch: `feature/${issue.key}-api-pr`,
        checksConclusion: "passed",
        checksPassed: 2,
        additions: 5,
        deletions: 1,
        changedFiles: 2,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.pullRequest.issueId).toBe(issue.id);
    expect(createdBody.pullRequest.checksPassed).toBe(2);

    const listed = await app.request(`/api/multica/github/pull-requests?issueId=${encodeURIComponent(issue.id)}`);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(1);
    expect(listedBody.pullRequests[0].number).toBe(7);

    const issuePullRequests = await app.request(`/api/issues/${encodeURIComponent(issue.id)}/pull-requests`);
    const issuePullRequestsBody = await issuePullRequests.json();
    expect(issuePullRequests.status).toBe(200);
    expect(issuePullRequestsBody.pull_requests[0].repo_owner).toBe("example");
    expect(issuePullRequestsBody.pull_requests[0].html_url).toBe("https://github.com/example/remi/pull/7");
    expect(issuePullRequestsBody.pull_requests[0].checks_passed).toBe(2);

    const merged = await app.request("/api/multica/github/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoOwner: "example",
        repoName: "remi",
        number: 7,
        title: `${issue.key} API linked PR`,
        state: "merged",
        mergedAt: "2026-06-03T00:00:00.000Z",
      }),
    });
    expect(merged.status).toBe(201);
    expect(store.getIssue(issue.id)?.status).toBe("done");

    const ping = await app.request("/api/multica/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zen: "Keep it logically awesome." }),
    });
    expect((await ping.json()).ok).toBe("pong");

    const webhookIssue = store.createIssue({ title: "GitHub webhook issue" });
    const webhook = await app.request("/api/multica/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: { name: "remi", owner: { login: "example" } },
        pull_request: {
          number: 8,
          title: `${webhookIssue.key} webhook linked PR`,
          state: "open",
          draft: false,
          merged: false,
          html_url: "https://github.com/example/remi/pull/8",
          head: { ref: `feature/${webhookIssue.key}-webhook` },
          user: { login: "octocat", avatar_url: "https://example.com/avatar.png" },
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T01:00:00.000Z",
          mergeable_state: "clean",
          additions: 3,
          deletions: 0,
          changed_files: 1,
        },
      }),
    });
    expect(webhook.status).toBe(202);
    expect((await webhook.json()).pullRequest.issueId).toBe(webhookIssue.id);

    const originalWebhookIssue = store.createIssue({ title: "GitHub original webhook issue" });
    const originalWebhook = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: { name: "remi", owner: { login: "example" } },
        pull_request: {
          number: 9,
          title: `${originalWebhookIssue.key} original webhook linked PR`,
          state: "closed",
          draft: false,
          merged: true,
          html_url: "https://github.com/example/remi/pull/9",
          head: { ref: `feature/${originalWebhookIssue.key}-original-webhook` },
          user: { login: "octocat" },
          merged_at: "2026-06-03T02:00:00.000Z",
          closed_at: "2026-06-03T02:00:00.000Z",
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T02:00:00.000Z",
        },
      }),
    });
    const originalWebhookBody = await originalWebhook.json();
    expect(originalWebhook.status).toBe(202);
    expect(originalWebhookBody.pullRequest.issueId).toBe(originalWebhookIssue.id);
    expect(originalWebhookBody.pullRequest.state).toBe("merged");
    expect(store.getIssue(originalWebhookIssue.id)?.status).toBe("done");
  });

  it("serves configured GitHub setup and connect compatibility responses", async () => {
    const previousSlug = process.env.GITHUB_APP_SLUG;
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    try {
      process.env.GITHUB_APP_SLUG = "multica-local";
      process.env.GITHUB_WEBHOOK_SECRET = "local-secret";
      const app = createMulticaApp({ store: createStore() });

      const connect = await app.request("/api/workspaces/local/github/connect");
      const connectBody = await connect.json();
      expect(connect.status).toBe(200);
      expect(connectBody.configured).toBe(true);
      expect(connectBody.url).toStartWith("https://github.com/apps/multica-local/installations/new?state=");

      const installations = await app.request("/api/workspaces/local/github/installations");
      expect(await installations.json()).toMatchObject({
        configured: true,
        installations: [],
        can_manage: true,
      });

      const setup = await app.request("/api/github/setup?installation_id=123&state=local.state.sig");
      expect(await setup.json()).toMatchObject({
        configured: true,
        installation_id: "123",
        state: "local.state.sig",
      });
    } finally {
      if (previousSlug === undefined) delete process.env.GITHUB_APP_SLUG;
      else process.env.GITHUB_APP_SLUG = previousSlug;
      if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("serves assignee frequency through original Multica route", async () => {
    const store = createStore();
    const app = createMulticaApp({ store });
    const alice = store.createWorkspaceMember({ name: "Alice API", role: "member" });
    const bob = store.createWorkspaceMember({ name: "Bob API", role: "member" });
    const issue = store.createIssue({
      title: "Assigned on create",
      createdBy: alice.id,
      assigneeType: "member",
      assigneeId: bob.id,
    });
    store.assignIssue(issue.id, {
      assigneeType: "member",
      assigneeId: bob.id,
      actorType: "member",
      actorId: alice.id,
    });

    const response = await app.request(`/api/assignee-frequency?memberId=${encodeURIComponent(alice.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0]).toMatchObject({
      assignee_type: "member",
      assignee_id: bob.id,
      frequency: 2,
    });
  });
});
