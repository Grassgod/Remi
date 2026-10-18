import { createResponsibleTestAutopilot } from './helpers.js';
import { createResponsibleTestIssue } from './helpers.js';
// Projects/squads/autopilot runs, project resources and how they reach the daemon
// workdir, the session instructions (AGENTS.md) and the turn input.
import { beforeAll, afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentSkillContext, writeProjectResourceContext } from "@multiremi/daemon.js";
import { buildTaskPromptArtifact } from "@multiremi/prompt.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { normalizeDaemonClaimTask } from "@multiremi/worker/client.js";
import { snapshotStatsForFile, createSnapshotStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — projects, resources, and prompt context", () => {
  it("creates projects, squads, and autopilot runs", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Launch", priority: "high" });
    const squad = store.createSquad({
      name: "Core squad",
      leaderId: agent.id,
      memberIds: [agent.id],
    });
    const autopilot = createResponsibleTestAutopilot(store, {
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

  it("manages project resources and includes them in task instructions", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [
        { url: "https://github.com/example/workspace", description: "workspace repo" },
        { url: "https://github.com/example/repo" },
        { url: "https://github.com/example/repo-updated" },
      ],
    });
    const project = store.createProject({
      title: "Repo scoped work",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/repo", defaultBranchHint: "main" },
        label: "primary repo",
      }],
    });
    const issue = createResponsibleTestIssue(store, { title: "Use resources", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Inspect the repo" });

    expect(store.getProject(project.id)?.resourceCount).toBe(1);
    const repoResource = store.listProjectResources(project.id).find((resource) => resource.resourceType === "github_repo")!;
    expect(repoResource.resourceRef.url).toBe("https://github.com/example/repo");
    const updatedRepoResource = store.updateProjectResource(project.id, repoResource.id, {
      resource_ref: { url: "https://github.com/example/repo-updated", default_branch_hint: "develop" },
      label: "",
      position: 5,
    });
    expect(updatedRepoResource.resourceRef).toEqual({
      url: "https://github.com/example/repo-updated",
      defaultBranchHint: "develop",
      default_branch_hint: "develop",
    });
    expect(updatedRepoResource.label).toBeNull();
    expect(updatedRepoResource.position).toBe(5);
    const legacyLocal = store.createProjectResource(project.id, {
      resourceType: "local_directory",
      resourceRef: { localPath: "/tmp/multiremi-local-project-duplicate", daemonId: "daemon-local" },
    });
    expect(legacyLocal.resourceType).toBe("local_directory");

    const taskWithContext = store.getTaskWithAgent(task.id)!;
    expect(taskWithContext.repos).toEqual([{ url: "https://github.com/example/repo-updated", defaultBranch: "develop" }]);
    const { prompt, instructions } = buildTaskPromptArtifact(taskWithContext);
    expect(instructions).toContain("## Project Context");
    expect(instructions).toContain("## Available Repositories");
    expect(instructions).toContain("remi repo checkout <url>");
    expect(instructions).toContain("https://github.com/example/repo-updated");
    expect(instructions).not.toContain("Local directory:");
    expect(instructions).not.toContain("https://github.com/example/workspace");
    expect(prompt).not.toContain("https://github.com/example/repo-updated");

    store.deleteProjectResource(project.id, updatedRepoResource.id);
    store.deleteProjectResource(project.id, legacyLocal.id);
    expect(store.getProject(project.id)?.resourceCount).toBe(0);
  });

  it("falls back to workspace repos when a task has no project repos", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ url: "https://github.com/example/workspace", description: "workspace repo" }],
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Use workspace repo" });
    const taskWithContext = store.getTaskWithAgent(task.id)!;

    expect(taskWithContext.repos).toEqual([{ url: "https://github.com/example/workspace", description: "workspace repo" }]);
    expect(buildTaskPromptArtifact(taskWithContext).instructions).toContain("https://github.com/example/workspace - workspace repo");
  });

  it("writes project resources into the daemon workdir", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ url: "https://github.com/example/runtime" }],
    });
    const project = store.createProject({
      title: "Runtime resources",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/runtime", defaultBranchHint: "main" },
        label: "runtime repo",
      }],
    });
    const issue = createResponsibleTestIssue(store, { title: "Run with context", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use runtime context" });
    const dir = mkdtempSync(join(tmpdir(), "multiremi-context-"));

    try {
      writeProjectResourceContext(dir, store.getTaskWithAgent(task.id)!);
      const payload = JSON.parse(readFileSync(join(dir, ".multiremi", "project", "resources.json"), "utf8"));

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
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const skill = store.createSkill({
      name: "Review Helper",
      description: "Review pull requests",
      content: "# Body",
      files: [{ path: "templates/check.md", content: "Check list" }],
    });
    store.setAgentSkills(agent.id, { skillIds: [skill.id!] });
    const task = store.getTaskWithAgent(store.createTask({ agentId: agent.id, prompt: "Review" }).id)!;
    const dir = mkdtempSync(join(tmpdir(), "multiremi-skill-"));

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

  it("stores issue metadata as a bounded primitive map and includes it in task instructions", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const issue = createResponsibleTestIssue(store, { title: "Remember PR state" });

    expect(issue.metadata).toEqual({});
    expect(store.setIssueMetadataKey(issue.id, "pr_url", "https://github.com/example/repo/pull/1")).toEqual({
      pr_url: "https://github.com/example/repo/pull/1",
    });
    store.setIssueMetadataKey(issue.id, "ready", true);
    store.setIssueMetadataKey(issue.id, "attempts", 2);
    expect(() => store.setIssueMetadataKey(issue.id, "bad key", "x")).toThrow("key must match");
    expect(() => store.setIssueMetadataKey(issue.id, "nested", { value: "x" })).toThrow("value must be a primitive");

    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use pinned facts" });
    const { instructions } = buildTaskPromptArtifact(store.getTaskWithAgent(task.id)!);
    expect(instructions).toContain("## Issue Metadata");
    expect(instructions).toContain(`Key: ${issue.key}`);
    expect(instructions).toContain("pr_url: https://github.com/example/repo/pull/1");

    expect(store.deleteIssueMetadataKey(issue.id, "ready")).toEqual({
      attempts: 2,
      pr_url: "https://github.com/example/repo/pull/1",
    });
  });

  it("renders a comment trigger with its author and reply target in the offered turn input", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const reviewer = store.createAgent({ name: "Reviewer", provider: "codex" });
    const squad = store.createSquad({ name: "Review squad", leaderId: reviewer.id, memberIds: [agent.id] });
    const issue = createResponsibleTestIssue(store, { title: "Reply with context", assigneeType: "squad", assigneeId: squad.id });
    const reviewerTask = store.createTask({ agentId: reviewer.id, issueId: issue.id, prompt: "Coordinate review." });
    const root = store.createIssueComment(issue.id, { body: "Root context." });
    const comment = store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: reviewer.id,
      taskId: reviewerTask.id,
      parentId: root.id,
      body: `Please inspect \`$PATH\` handling.\nSecond line [@Worker](mention://agent/${agent.id}).`,
    });
    const task = store.listTasks().find((item) => item.triggerCommentId === comment.id)!;
    // The production offer path: the trigger travels as a range record plus triggering message, not as quoted text.
    const withAgent = store.getTaskWithAgent(task.id)!;
    const response = daemonTaskClaimResponse(store, withAgent, store.getTaskTriggerMetadata(withAgent));
    useTaskSessionInput(store, withAgent, response);
    const { prompt, instructions } = buildTaskPromptArtifact(normalizeDaemonClaimTask(response)!);

    expect(prompt.startsWith(`[Agent Reviewer] Please inspect \`$PATH\` handling.\nSecond line [@Worker](mention://agent/${agent.id}).`)).toBe(true);
    // The rest of the thread (the root comment) is unread context the agent is told how to read, not inlined.
    expect(prompt).not.toContain("Root context.");
    expect(prompt).toContain(`Read them before you answer: \`remi message list ${task.issueSessionId} --from 0 --to `);
    expect(prompt).toContain(`(Reply to comment ${comment.id}: \`remi message send ${task.issueSessionId} --kind reply --reply-to ${comment.id}\`.)`);
    expect(prompt).not.toContain("## Triggering Comment");
    // The reply recipe and the agent-acknowledgment rule are session instructions; the comment id comes per turn.
    expect(instructions).toContain("When the comment comes from another agent and is only an acknowledgment");
    expect(instructions).toContain("do not reply");
    expect(instructions).toContain(`cat <<'COMMENT' | remi message send ${task.issueSessionId} --kind reply --reply-to <comment-id> --content-stdin`);
    expect(instructions).not.toContain(comment.id);
    expect(`${prompt}\n${instructions}`).not.toContain("multimira");
  });

  it("renders daemon claim execution context in the instructions and the turn input", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Context Worker", provider: "claude" });
    const task = store.getTaskWithAgent(store.createTask({ agentId: agent.id, prompt: "Fallback prompt" }).id)!;
    const { prompt, instructions } = buildTaskPromptArtifact({
      ...task,
      workspaceContext: "Use the shared release checklist.",
      requestingUserName: "Alice",
      requestingUserProfileDescription: "Likes concrete dates and verification output.",
      chatMessage: "Check Shanghai weather\n\nand Qingdao too",
      chatMessageAttachments: [{ id: "att_1", filename: "forecast.txt", content_type: "text/plain" }],
      autopilotTitle: "Webhook triage",
      autopilotSource: "webhook",
      autopilotDescription: "Investigate the incoming push.",
      autopilotTriggerPayload: { repository: "remi", action: "push" },
      quickCreatePrompt: "Create onboarding screenshot follow-up",
    });

    // Session context goes to the instructions.
    expect(instructions).toContain("## Workspace Context\nUse the shared release checklist.");
    // With no session owner from the server (an older one), the requester is who the notes name.
    expect(instructions).toContain("## Session Owner\nName: Alice\nLikes concrete dates and verification output.");
    expect(instructions).toContain("## Autopilot Context\nTitle: Webhook triage\nSource: webhook\nInvestigate the incoming push.");
    expect(instructions).toContain("## Quick Create Request\nCreate onboarding screenshot follow-up");
    // This turn's input: an older server's chat_message, the trigger payload and one line per attachment.
    expect(prompt).toBe([
      "Check Shanghai weather\n\nand Qingdao too",
      'Trigger payload:\n```json\n{\n  "repository": "remi",\n  "action": "push"\n}\n```',
      "Attachments:\n- forecast.txt: run `remi attachment download att_1 --output-dir <dir>`",
    ].join("\n\n"));
    expect(prompt).not.toContain("Fallback prompt");
    expect(prompt).not.toContain("## Chat Message");
    expect(instructions).not.toContain("Check Shanghai weather");
  });
});

// Register hooks in this file; shared modules only load once per test process.
let reportSnapshotStats: (() => void) | undefined;
beforeAll(() => { reportSnapshotStats = snapshotStatsForFile(import.meta.path); });
afterAll(() => { reportSnapshotStats?.(); });
