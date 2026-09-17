import { describe, expect, it } from "bun:test";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
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
  for (const mode of ["bootstrap", "delta"] as const) {
    it(`preserves the unbound Chat ${mode} prompt byte for byte`, () => {
      const task = chatTask({ sessionProjection: { mode, jsonl: '{"type":"session_event","body":"Earlier conversation"}' } });
      expect(buildTaskPrompt(task)).toMatchSnapshot();
    });
  }

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
      expect(prompt).toContain("Project Wiki is materialized in `./wiki`");
      expect(prompt).toContain("Selected Project Wiki warning");
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
      const prompt = buildTaskPrompt(chatTask({
        ...projectContext, chatProjectId: project.id,
        sessionProjection: { mode, jsonl: '{"type":"session_event"}' },
      }), {
        chatRepoAutoCheckout: true,
        repoWarnings: [
          { repoUrl: "https://example.test/timeout", kind: "unavailable", message: "git clone timed out after 30000ms" },
          { repoUrl: "https://example.test/auth", kind: "unavailable", message: "Authentication failed\nfor remote" },
          { repoUrl: "https://example.test/network", kind: "stale_cache", message: "Could not resolve host" },
        ],
      });
      expect(prompt).toContain("## Repository Availability Warnings");
      expect(prompt).toContain("git clone timed out after 30000ms");
      expect(prompt).toContain("Authentication failed for remote");
      expect(prompt).toContain("Could not resolve host");
      expect(prompt).toContain("Chat can continue without these repositories");
      expect(prompt).toContain("run `remi repo checkout <repo-id>` explicitly");
      expect(prompt).toContain("Do not claim that you inspected its source code");
    });
  }

  it("reports checkout path collisions and preserves existing user edits", () => {
    const prompt = buildTaskPrompt(chatTask({ ...projectContext, chatProjectId: project.id }), {
      chatRepoAutoCheckout: true,
      repoWarnings: [{
        repoUrl: "https://example.test/bound-project", kind: "unavailable",
        message: "Automatic checkout skipped: /tmp/chats/chat_project/repo is reserved for another repository. Resolve the directory collision without overwriting existing files.",
      }],
    });
    expect(prompt).toContain("/tmp/chats/chat_project/repo is reserved for another repository");
    expect(prompt).toContain("run `remi repo checkout <repo-id>` explicitly");
    expect(prompt).toContain("Preserve any existing worktree with uncommitted changes");
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
    expect(prompt).not.toContain("Wiki is materialized in `./wiki`");
  });

  it("keeps bound Project delta instructions without repeating bootstrap context", () => {
    const prompt = buildTaskPrompt(chatTask({
      ...projectContext, chatProjectId: project.id,
      sessionProjection: { mode: "delta", jsonl: '{"type":"session_event"}' },
    }));
    expect(prompt).toContain("## Project Delta Instructions\nContinue selected Project work.");
    expect(prompt).not.toContain("## Project Context");
    expect(prompt).not.toContain("## Available Repositories");
  });

  it("uses Wiki CLI guidance when workspace preparation did not materialize Wiki", () => {
    const prompt = buildTaskPrompt(chatTask({ ...projectContext, chatProjectId: project.id }), { wikiMaterialized: false });
    expect(prompt).toContain("Project Wiki has not been materialized in this working directory");
    expect(prompt).toContain("`remi wiki search` and `remi wiki get`");
    expect(prompt).not.toContain("Wiki is materialized in `./wiki`");
    expect(prompt).not.toContain("`remi wiki status` and `remi wiki push`");
  });
});
