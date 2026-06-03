import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detectMulticaProviders } from "../src/cli/multica.js";
import { createMulticaApp } from "../src/multica/api.js";
import { renderMulticaDashboardHtml } from "../src/multica/dashboard.js";
import { writeAgentSkillContext, writeProjectResourceContext } from "../src/multica/daemon.js";
import { buildTaskPrompt } from "../src/multica/prompt.js";
import { MulticaScheduler } from "../src/multica/scheduler.js";
import { MulticaStore } from "../src/multica/store.js";

let db: Database | null = null;
let previousUploadDir: string | undefined;
let uploadDir: string | null = null;

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
});

function useUploadDir(): string {
  previousUploadDir = process.env.MULTICA_UPLOAD_DIR;
  uploadDir = mkdtempSync(join(tmpdir(), "multica-upload-"));
  process.env.MULTICA_UPLOAD_DIR = uploadDir;
  return uploadDir;
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

  it("assigns human-readable issue keys per workspace", () => {
    const store = createStore();
    const first = store.createIssue({ title: "First issue" });
    const second = store.createIssue({ title: "Second issue" });

    expect(first.key).toBe("MUL-1");
    expect(first.number).toBe(1);
    expect(second.key).toBe("MUL-2");
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
    expect(html).toContain("updateSelectedAgentSkills");
  });

  it("renders a real settings page with token controls", () => {
    const html = renderMulticaDashboardHtml();
    expect(html).toContain('id="settingsPage"');
    expect(html).toContain('id="tokenList"');
    expect(html).toContain("function renderSettings()");
    expect(html).toContain("/api/multica/tokens");
    expect(html).toContain("function revokeToken");
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
    expect(html).toContain("/api/multica/autopilots/");
    expect(html).toContain("updateSelectedAutopilot");
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
    expect((await issueAttachment.json()).attachment.issueId).toBe(issue.id);

    const root = await app.request(`/api/multica/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Root API comment" }),
    });
    const rootBody = await root.json();

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

    const commentReaction = await app.request(`/api/multica/comments/${replyBody.comment.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👀", actorType: "agent", actorId: "agt-api" }),
    });
    expect((await commentReaction.json()).reaction.emoji).toBe("👀");

    const detail = await app.request(`/api/multica/issues/${issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.reactions).toHaveLength(1);
    expect(detailBody.issue.attachments).toHaveLength(1);
    expect(detailBody.comments.find((comment: any) => comment.id === replyBody.comment.id).reactions).toHaveLength(1);

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
