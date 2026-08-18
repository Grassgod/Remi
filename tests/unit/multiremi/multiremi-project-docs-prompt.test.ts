import { afterEach, describe, expect, it } from "bun:test";
import { buildTaskPrompt, buildTaskPromptArtifact } from "@multiremi/prompt.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function createProjectTask(store: MultiremiStore) {
  const agent = store.createAgent({
    name: "Codex",
    provider: "codex",
    instructions: "Keep changes focused.",
  });
  const project = store.createProject({
    title: "Knowledge Project",
    description: "Shared project description.",
    resources: [{
      resourceType: "github_repo",
      resourceRef: { url: "https://github.com/example/knowledge" },
    }],
  });
  const issue = store.createIssue({
    title: "Use project knowledge",
    description: "Implement the requested behavior.",
    projectId: project.id,
  });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Do the work" });
  return { agent, project, issue, task: store.getTaskWithAgent(task.id)! };
}

describe("bootstrap and delta task prompts", () => {
  it("builds a bootstrap prompt with stable execution context", () => {
    const store = createStore();
    const { project, issue, task } = createProjectTask(store);

    const artifact = buildTaskPromptArtifact({
      ...task,
      workspaceContext: "Use the shared release checklist.",
      sessionProjection: {
        mode: "bootstrap",
        jsonl: '{"type":"session_projection","mode":"bootstrap"}',
      },
    } as any);

    expect(artifact.mode).toBe("bootstrap");
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.prompt).toContain("# Bootstrap Prompt");
    expect(artifact.prompt).toContain("## Current Request\nDo the work");
    expect(artifact.prompt).toContain("## Workspace Context");
    expect(artifact.prompt).toContain(`Key: ${issue.key}`);
    expect(artifact.prompt).toContain("Implement the requested behavior.");
    expect(artifact.prompt).toContain("## Project Context");
    expect(artifact.prompt).toContain("## Available Repositories");
    expect(artifact.prompt).toContain("## Agent Instructions");
    expect(artifact.prompt).toContain("## Output");
    expect(artifact.prompt).toContain(`remi memory recall "<query>" --project ${project.id}`);
  });

  it("does not embed Memory, Wiki, or schema bodies in a bootstrap prompt", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      projectDocs: {
        memory: [{ id: "mem", slug: "secret-memory", title: "Memory title", body: "MEMORY_BODY_MUST_NOT_SHIP", kind: "memory" }],
        wiki: [{ id: "wiki", slug: "architecture", title: "Architecture", body: null, summary: "WIKI_SUMMARY_MUST_NOT_SHIP", kind: "wiki" }],
        schema: "SCHEMA_BODY_MUST_NOT_SHIP",
      },
    } as any);

    expect(prompt).toContain("## Project Knowledge");
    expect(prompt).toContain("`multiremi-project-knowledge` MCP");
    expect(prompt).toContain("call `recall`");
    expect(prompt).toContain("call `read`");
    expect(prompt).not.toContain("## Project Memory");
    expect(prompt).not.toContain("## Project Wiki");
    expect(prompt).not.toContain("MEMORY_BODY_MUST_NOT_SHIP");
    expect(prompt).not.toContain("WIKI_SUMMARY_MUST_NOT_SHIP");
    expect(prompt).not.toContain("SCHEMA_BODY_MUST_NOT_SHIP");
  });

  it("builds a compact delta without replaying stable context", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      prompt: "Apply the review feedback.",
      workspaceContext: "DO_NOT_REPEAT_WORKSPACE",
      sessionProjection: {
        mode: "delta",
        jsonl: [
          '{"type":"session_projection","mode":"delta"}',
          '{"type":"session_event","body":"New review feedback"}',
        ].join("\n"),
      },
    } as any);

    expect(prompt).toContain("# Delta Prompt");
    expect(prompt).toContain("## Current Request\nApply the review feedback.");
    expect(prompt).toContain("New review feedback");
    expect(prompt).toContain("## Issue");
    expect(prompt).not.toContain("DO_NOT_REPEAT_WORKSPACE");
    expect(prompt).not.toContain("Implement the requested behavior.");
    expect(prompt).not.toContain("## Project Context");
    expect(prompt).not.toContain("## Project Knowledge");
    expect(prompt).not.toContain("## Available Repositories");
    expect(prompt).not.toContain("## Agent Instructions");
    expect(prompt).not.toContain("## Output");
  });

  it("renders one canonical triggering comment and strips legacy duplication", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const triggerBody = "Please fix the `$PATH` handling.";
    const prompt = buildTaskPrompt({
      ...task,
      prompt: `A teammate mentioned you.\n\n## Triggering Comment\n${triggerBody}`,
      triggerCommentId: "cmt_trigger",
      triggerCommentContent: triggerBody,
      triggerAuthorType: "member",
      sessionProjection: {
        mode: "delta",
        jsonl: [
          '{"type":"session_projection","mode":"delta"}',
          JSON.stringify({ type: "session_event", source_comment_id: "cmt_trigger", body: triggerBody }),
        ].join("\n"),
      },
    } as any);

    expect(prompt.match(/## Triggering Comment/g)).toHaveLength(1);
    expect(prompt.split(triggerBody)).toHaveLength(2);
    expect(prompt).toContain("## Current Request\nA teammate mentioned you.");
  });

  it("quotes a trigger once when no canonical Session projection is available", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const triggerBody = "One standalone trigger.";
    const prompt = buildTaskPrompt({
      ...task,
      triggerCommentId: "cmt_trigger",
      triggerCommentContent: triggerBody,
    } as any);
    expect(prompt.match(/## Triggering Comment/g)).toHaveLength(1);
    expect(prompt.split(triggerBody)).toHaveLength(2);
    expect(prompt).toContain(`> ${triggerBody}`);
  });

  it("injects squad roster and bounded delegation guidance for the leader", () => {
    const store = createStore();
    const { agent, issue, task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      squadContext: {
        id: "sqd_core",
        name: "Core squad",
        leaderAgentId: agent.id,
        members: [
          { agentId: agent.id, name: agent.name, role: "leader" },
          { agentId: "agt_reviewer", name: "Reviewer", role: "reviewer", description: "Owns security reviews" },
        ],
      },
    } as any);

    expect(prompt).toContain("## Squad Coordination");
    expect(prompt).toContain("Reviewer (agent: agt_reviewer) - reviewer - Owns security reviews");
    expect(prompt).toContain("independent workstreams");
    expect(prompt).toContain(`--parent ${issue.id} --assignee-id <agent-id> --assignee-type agent`);
  });

  it("marks pre-checked-out repositories in bootstrap prompts", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt(task, {
      repoCheckouts: [{
        repoUrl: "https://github.com/example/knowledge",
        path: "/tmp/work/knowledge",
        branch: "agent/codex/REMI-1",
      }],
    });

    expect(prompt).toContain("already checked out into the working directory");
    expect(prompt).toContain("at `./knowledge` on branch `agent/codex/REMI-1`");
  });

  it("keeps a checkout command for repositories the daemon did not materialize", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      repos: [
        { url: "https://github.com/example/knowledge" },
        { url: "https://github.com/example/unreachable" },
      ],
    }, {
      repoCheckouts: [{
        repoUrl: "https://github.com/example/knowledge",
        path: "/tmp/work/knowledge",
        branch: "agent/codex/REMI-1",
      }],
    });

    expect(prompt).toContain("- https://github.com/example/unreachable");
    expect(prompt).toContain("For repositories without a path above, use `remi repo checkout");
  });
});
