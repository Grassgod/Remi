// Projects/squads/autopilot runs, project resources and how they reach the daemon
// workdir and the task prompt.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentSkillContext, writeProjectResourceContext } from "@multiremi/daemon.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — projects, resources, and prompt context", () => {
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
    const issue = store.createIssue({ title: "Use resources", projectId: project.id });
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
    expect(taskWithContext.repos).toEqual([{ url: "https://github.com/example/repo-updated" }]);
    const prompt = buildTaskPrompt(taskWithContext);
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("## Available Repositories");
    expect(prompt).toContain("remi repo checkout <url>");
    expect(prompt).toContain("https://github.com/example/repo-updated");
    expect(prompt).not.toContain("Local directory:");
    expect(prompt).not.toContain("https://github.com/example/workspace");

    store.deleteProjectResource(project.id, updatedRepoResource.id);
    store.deleteProjectResource(project.id, legacyLocal.id);
    expect(store.getProject(project.id)?.resourceCount).toBe(0);
  });

  it("falls back to workspace repos when a task has no project repos", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ url: "https://github.com/example/workspace", description: "workspace repo" }],
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Use workspace repo" });
    const taskWithContext = store.getTaskWithAgent(task.id)!;

    expect(taskWithContext.repos).toEqual([{ url: "https://github.com/example/workspace", description: "workspace repo" }]);
    expect(buildTaskPrompt(taskWithContext)).toContain("https://github.com/example/workspace - workspace repo");
  });

  it("writes project resources into the daemon workdir", () => {
    const store = createStore();
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
    const issue = store.createIssue({ title: "Run with context", projectId: project.id });
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

  it("renders Go-style comment trigger context in daemon prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const reviewer = store.createAgent({ name: "Reviewer", provider: "codex" });
    const squad = store.createSquad({ name: "Review squad", leaderId: reviewer.id, memberIds: [agent.id] });
    const issue = store.createIssue({ title: "Reply with context", assigneeType: "squad", assigneeId: squad.id });
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
    const metadata = store.getTaskTriggerMetadata(task)!;
    const prompt = buildTaskPrompt({
      ...store.getTaskWithAgent(task.id)!,
      trigger_comment_id: comment.id,
      trigger_thread_id: metadata.triggerThreadId,
      trigger_comment_content: metadata.triggerCommentContent,
      trigger_author_type: metadata.triggerAuthorType,
      trigger_author_name: metadata.triggerAuthorName,
      new_comment_count: 3,
      new_comments_since: "2025-01-01T00:00:00.000Z",
    } as any);

    expect(prompt).toContain("## Triggering Comment");
    expect(prompt).toContain("Another agent (Reviewer) just left a new comment");
    expect(prompt).toContain("> Please inspect `$PATH` handling.");
    expect(prompt).toContain("> Second line");
    expect(prompt).toContain("do not reply");
    expect(prompt).toContain(`remi comment list ${issue.id} --thread ${root.id} --since 2025-01-01T00:00:00.000Z --output json`);
    expect(prompt).toContain(`remi comment add ${issue.id} --parent ${comment.id} --content-stdin`);
    expect(prompt).toContain("<<'COMMENT'");
    expect(prompt).not.toContain("multimira");
  });

  it("renders daemon claim execution context in provider prompts", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Context Worker", provider: "claude" });
    const task = store.getTaskWithAgent(store.createTask({ agentId: agent.id, prompt: "Fallback prompt" }).id)!;
    const prompt = buildTaskPrompt({
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

    expect(prompt).toContain("## Workspace Context");
    expect(prompt).toContain("Use the shared release checklist.");
    expect(prompt).toContain("## Requesting User");
    expect(prompt).toContain("Name: Alice");
    expect(prompt).toContain("Likes concrete dates and verification output.");
    expect(prompt).toContain("## Chat Message");
    expect(prompt).toContain("Check Shanghai weather\n\nand Qingdao too");
    expect(prompt).toContain("att_1 - forecast.txt (text/plain)");
    expect(prompt).toContain("## Autopilot Context");
    expect(prompt).toContain("Title: Webhook triage");
    expect(prompt).toContain("Source: webhook");
    expect(prompt).toContain('"repository": "remi"');
    expect(prompt).toContain("## Quick Create Request");
    expect(prompt).toContain("Create onboarding screenshot follow-up");
  });
});
