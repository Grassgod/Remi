import { describe, expect, it } from "bun:test";
import { buildAgentInstructions as buildTaskPrompt, buildTaskPromptArtifact } from "@daemon/agent-runtime/prompts/ephemeral.js";
import type { AgentTask } from "@daemon/contracts/types.js";

function chatTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task_chat", workspaceId: "local", prompt: "Continue our conversation.",
    issueId: null, issue: null, chatSessionId: "chat_project", autopilotRunId: null,
    createdAt: "2026-09-17T00:00:00.000Z", completedAt: null,
    workDir: null, runtimeId: null, sessionId: null,
    project: null, projectResources: [], repos: [], agent: null,
    triggerCommentId: null, triggerSummary: null,
    ...overrides,
  };
}

describe("Chat Project prompts", () => {
  it("writes the same AGENTS.md notes for a fresh and a resumed provider session", () => {
    const fresh = buildTaskPrompt(chatTask({ sessionProjection: { mode: "bootstrap", jsonl: '{"type":"session_event","body":"Earlier conversation"}' } }));
    const resumed = buildTaskPrompt(chatTask({ sessionProjection: { mode: "delta", jsonl: '{"type":"session_event","body":"Earlier conversation"}' } }));
    expect(resumed).toBe(fresh);
    expect(fresh).not.toContain("Earlier conversation");
    expect(fresh).toMatchSnapshot();
  });

  const project = {
    id: "project_bound", title: "Bound Project", description: "Project description",
    instructions: "Follow the selected Project rules.", deltaInstructions: "Continue selected Project work.",
  };
  const projectContext = {
    project,
    projectResources: [{
      id: "resource_repo", resourceType: "github_repo", label: null,
      resourceRef: { url: "https://github.com/example/bound-project", default_branch: "main" },
    }],
    repos: [{ url: "https://github.com/example/bound-project", description: "Project repository" }],
  };

  for (const binding of [{ chatProjectId: project.id }, { chat_project_id: project.id }]) {
    it(`includes the explicitly bound Project via ${Object.keys(binding)[0]} while stripping Issue context`, () => {
      const task = chatTask({
        ...projectContext, ...binding,
        issueId: "old_issue",
        issue: { id: "old_issue", key: "OLD-1", title: "Stale Issue", description: null, metadata: {} },
        issueSessionResults: [{ id: "old_result", body: "Stale Issue result" }],
        triggerCommentId: "old_comment", triggerCommentContent: "Stale Issue trigger",
        knowledgeWarnings: ["Selected Project Wiki warning"],
        holdsWorkspace: true,
      });
      const prompt = buildTaskPrompt(task, { wikiMaterialized: true });
      expect(prompt).toContain("Current Chat project: Bound Project (project_bound).");
      expect(prompt).toContain("This Chat is bound to project: Bound Project");
      expect(prompt).toContain("Project description");
      expect(prompt).toContain("## Project Instructions\nFollow the selected Project rules.");
      expect(prompt).toContain("## Available Repositories");
      expect(prompt).toContain("https://github.com/example/bound-project");
      expect(prompt).toContain("remi memory search");
      expect(prompt).toContain("remi memory get");
      expect(prompt).toContain("Project Wiki is materialized in `$MULTIREMI_WORKSPACE_ROOT/wiki`");
      expect(prompt).not.toContain("`./wiki`");
      // ADR 0023: what this turn could not provide is turn input; AGENTS.md stays the same for the session.
      expect(prompt).not.toContain("Selected Project Wiki warning");
      expect(buildTaskPromptArtifact(task, { wikiMaterialized: true }).prompt).toContain("(Knowledge warnings: Selected Project Wiki warning)");
      expect(prompt).not.toContain("This issue belongs to project");
      expect(prompt).not.toContain("## Issue");
      expect(prompt).not.toContain("Stale Issue");
      expect(prompt).not.toContain("## Shared Workspace Coordination");
    });
  }

  for (const chatProjectId of [undefined, null, "different_project"]) {
    it(`does not trust Project payload without a matching binding (${String(chatProjectId)})`, () => {
      const prompt = buildTaskPrompt(chatTask({ ...projectContext, chatProjectId }));
      expect(prompt).not.toContain("Bound Project");
      expect(prompt).not.toContain("## Project");
      expect(prompt).not.toContain("## Available Repositories");
      expect(prompt).not.toContain("https://github.com/example/bound-project");
    });
  }

  it("does not expose checkout paths or warnings for an unbound Chat", () => {
    const task = chatTask();
    const prompt = buildTaskPrompt(task, {
      chatRepoAutoCheckout: true,
      repoCheckouts: [{ repoUrl: "https://example.test/unrelated", path: "/tmp/unrelated", branch: "chat/other" }],
      repoWarnings: [{ repoUrl: "https://example.test/unrelated", kind: "unavailable", message: "Unrelated failure" }],
    });
    expect(prompt).toBe(buildTaskPrompt(task));
  });

  for (const workspaceField of ["workspaceId", "workspace_id"] as const) {
    it(`strips cross-workspace Project and checkout diagnostics through ${workspaceField}`, () => {
      const prompt = buildTaskPrompt(chatTask({
        ...projectContext,
        chatProjectId: project.id,
        project: { ...project, [workspaceField]: "other_workspace" },
      }), {
        chatRepoAutoCheckout: true,
        repoCheckouts: [{ repoUrl: projectContext.repos[0]!.url, path: "/tmp/other-workspace", branch: "chat/other" }],
        repoWarnings: [{ repoUrl: projectContext.repos[0]!.url, kind: "unavailable", message: "Other workspace failure" }],
      });
      expect(prompt).toBe(buildTaskPrompt(chatTask()));
    });
  }

  it("describes prepared repositories on the stable Chat session branch", () => {
    const prompt = buildTaskPrompt(chatTask({ ...projectContext, chatProjectId: project.id }), {
      chatRepoAutoCheckout: true,
      repoCheckouts: [{
        repoUrl: projectContext.repos[0]!.url,
        path: "/tmp/chats/chat_project/bound-project",
        branch: "chat/chat_project",
      }],
    });
    expect(prompt).toContain("automatic checkout only for repositories explicitly declared by this Project, including referenced Projects");
    expect(prompt).toContain("New worktrees use the Chat session branch `chat/chat_project`");
    expect(prompt).toContain("Existing checkouts are reused without fetching on later turns");
    expect(prompt).toContain("already checked out on the Chat session branch");
    expect(prompt).toContain("at `/tmp/chats/chat_project/bound-project` on branch `chat/chat_project`");
    expect(prompt).not.toContain("Repositories are not fetched for Chat startup");
    expect(prompt).not.toContain("already checked out on the Issue branch");
    expect(prompt).not.toContain("chat/task_chat");
  });

  it("does not claim that catalog repositories without a checkout were fetched", () => {
    const prompt = buildTaskPrompt(chatTask({
      ...projectContext, chatProjectId: project.id,
      repos: [...projectContext.repos, { url: "https://example.test/catalog-only" }],
    }), {
      chatRepoAutoCheckout: true,
      repoCheckouts: [{ repoUrl: projectContext.repos[0]!.url, path: "/tmp/project-repo", branch: "chat/chat_project" }],
    });
    expect(prompt).toContain("- https://example.test/catalog-only\n");
    expect(prompt).not.toContain("https://example.test/catalog-only — at");
    expect(prompt).toContain("For repositories without a path above, use `remi repo checkout");
  });

  for (const mode of ["bootstrap", "delta"] as const) {
    it(`reports preparation failures and explicit checkout fallback in Project Chat ${mode}`, () => {
      const task = chatTask({
        ...projectContext, chatProjectId: project.id,
        sessionProjection: { mode, jsonl: '{"type":"session_event"}' },
      });
      const options = {
        chatRepoAutoCheckout: true,
        repoWarnings: [
          { repoUrl: "https://example.test/timeout", kind: "unavailable" as const, message: "git clone timed out after 30000ms" },
          { repoUrl: "https://example.test/auth", kind: "unavailable" as const, message: "Authentication failed\nfor remote" },
          { repoUrl: "https://example.test/network", kind: "stale_cache" as const, message: "Could not resolve host" },
        ],
      };
      // ADR 0023: one line of this turn's input; AGENTS.md is the same with or without the failures.
      expect(buildTaskPrompt(task, options)).toBe(buildTaskPrompt(task, { chatRepoAutoCheckout: true }));
      const prompt = buildTaskPromptArtifact(task, options).prompt;
      expect(prompt).toContain("(Repository warnings, diagnostic only: `https://example.test/timeout` is unavailable, preparation failed: `git clone timed out after 30000ms`");
      expect(prompt).toContain("`Authentication failed for remote`");
      expect(prompt).toContain("`https://example.test/network` may be stale, remote refresh failed: `Could not resolve host`");
      expect(prompt).toContain("`remi repo checkout <repo-id>` retries a failed checkout");
      expect(prompt).toContain("Don't claim to have inspected code that isn't available");
    });
  }

  it("reports checkout path collisions and preserves existing user edits", () => {
    const prompt = buildTaskPromptArtifact(chatTask({ ...projectContext, chatProjectId: project.id }), {
      chatRepoAutoCheckout: true,
      repoWarnings: [{
        repoUrl: "https://example.test/bound-project", kind: "unavailable",
        message: "Automatic checkout skipped: /tmp/chats/chat_project/repo is reserved for another repository. Resolve the directory collision without overwriting existing files.",
      }],
    }).prompt;
    expect(prompt).toContain("/tmp/chats/chat_project/repo is reserved for another repository");
    expect(prompt).toContain("`remi repo checkout <repo-id>` retries a failed checkout");
    expect(prompt).toContain("an existing worktree with uncommitted changes must be preserved");
  });

  it("uses actual preparation mode to avoid promising automatic writes in a user directory", () => {
    const prompt = buildTaskPrompt(chatTask({ ...projectContext, chatProjectId: project.id }), {
      chatRepoAutoCheckout: false,
      wikiMaterialized: false,
    });
    expect(prompt).toContain("Automatic repository checkout is disabled for this working directory");
    expect(prompt).toContain("Chat startup does not clone, fetch, or replace repository files");
    expect(prompt).toContain("Inspect existing files directly");
    expect(prompt).not.toContain("New worktrees use the Chat session branch");
    expect(prompt).not.toContain("already checked out");
    expect(prompt).not.toContain("Wiki is materialized in");
  });

  it("merges the delta half an older server still sends into the Project instructions", () => {
    const prompt = buildTaskPrompt(chatTask({
      ...projectContext, chatProjectId: project.id,
      sessionProjection: { mode: "delta", jsonl: '{"type":"session_event"}' },
    }));
    expect(prompt).toContain("## Project Instructions\nFollow the selected Project rules.\n\nContinue selected Project work.");
    expect(prompt).not.toContain("Delta");
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("## Available Repositories");
  });

  it("addresses the materialized Wiki through the workspace root, with its absolute path when the workspace is known", () => {
    const task = chatTask({ ...projectContext, chatProjectId: project.id });
    const known = buildTaskPrompt(task, { wikiMaterialized: true, workspacePath: "/data/work/chat_project" });
    expect(known).toContain("Project Wiki is materialized in `$MULTIREMI_WORKSPACE_ROOT/wiki` (absolute path `/data/work/chat_project/wiki`)");
    expect(known).toContain("`$MULTIREMI_WORKSPACE_ROOT/wiki/repositories/<repository>/`");
    expect(known).toContain("`$MULTIREMI_WORKSPACE_ROOT/.multiremi/wiki-base` is a read-only merge baseline");
    expect(known).toContain("resolve any reported conflicts in `$MULTIREMI_WORKSPACE_ROOT/wiki`");
    const unknown = buildTaskPrompt(task, { wikiMaterialized: true });
    expect(unknown).toContain("Project Wiki is materialized in `$MULTIREMI_WORKSPACE_ROOT/wiki`.");
    expect(unknown).not.toContain("absolute path");
    for (const prompt of [known, unknown]) expect(prompt).not.toContain("./wiki");
  });

  it("uses Wiki CLI guidance when workspace preparation did not materialize Wiki", () => {
    const prompt = buildTaskPrompt(chatTask({ ...projectContext, chatProjectId: project.id }), { wikiMaterialized: false });
    expect(prompt).toContain("Project Wiki has not been materialized in this working directory");
    expect(prompt).toContain("`remi wiki search` and `remi wiki get`");
    expect(prompt).not.toContain("Wiki is materialized in");
    expect(prompt).not.toContain("`remi wiki status` and `remi wiki push`");
  });
});
