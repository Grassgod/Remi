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
