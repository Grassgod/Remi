import { afterEach, describe, expect, it } from "bun:test";
import { buildTaskPrompt, buildTaskPromptArtifact } from "@multiremi/prompt.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function createProjectTask(store: MultiremiStore) {
  store.ensureLocalWorkspace();
  store.updateWorkspace("local", {
    repos: [{
      id: "repo_knowledge_prompt",
      name: "knowledge",
      url: "https://github.com/example/knowledge",
      source: "github",
    }],
  });
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
  it("bootstraps homepage Chat from product history and CLI directory instructions only", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_chat_prompt",
        name: "chat-prompt",
        url: "https://github.com/example/chat-prompt",
        source: "github",
      }],
    });
    const agent = store.createAgent({ name: "Chat Agent", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Home Chat" });
    const sent = store.sendChatMessage(chat.id, { body: "latest question" });
    const task = store.getTaskWithAgent(sent.task.id)!;
    expect(task.repos).toEqual([]);

    const prompt = buildTaskPrompt({
      ...task,
      chatBootstrapTranscript: "[user]\nolder question\n\n[assistant]\nolder answer\n\n[user]\nlatest question",
    } as any);
    expect(prompt).toContain("## Current Request\nContinue this Chat from the canonical product history below.");
    expect(prompt).toContain("## Product Chat History");
    expect(prompt).toContain("[assistant]\nolder answer");
    expect(prompt).toContain("## Remi Context");
    expect(prompt).toContain("`remi context`");
    expect(prompt).toContain("`remi project list|get|search`");
    expect(prompt).toContain("`remi repo list|get|search`");
    expect(prompt).toContain("`remi repo checkout <repo-id>`");
    expect(prompt).not.toContain("## Available Repositories");
    expect(prompt).not.toContain("https://github.com/example/chat-prompt");
  });

  it("builds a bootstrap prompt with stable execution context", () => {
    const store = createStore();
    const { project, issue, task } = createProjectTask(store);

    const artifact = buildTaskPromptArtifact({
      ...task,
      workspaceContext: "Use the shared release checklist.",
      workspaceBootstrapPrompt: "Create a pull request before completion.",
      workspaceDeltaPrompt: "DO_NOT_INCLUDE_DELTA_ON_BOOTSTRAP",
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
    expect(artifact.prompt).toContain("## Workspace Bootstrap Instructions\nCreate a pull request before completion.");
    expect(artifact.prompt).not.toContain("DO_NOT_INCLUDE_DELTA_ON_BOOTSTRAP");
    expect(artifact.prompt).toContain(`Key: ${issue.key}`);
    expect(artifact.prompt).toContain("Implement the requested behavior.");
    expect(artifact.prompt).toContain("## Project Context");
    expect(artifact.prompt).toContain("## Available Repositories");
    expect(artifact.prompt).toContain("## Agent Instructions");
    expect(artifact.prompt).toContain("## Output");
    expect(artifact.prompt).toContain('remi memory search "<query>"');
    expect(artifact.prompt).toContain("remi memory get <slug-or-id>");
    expect(artifact.prompt).not.toMatch(/remi (?:issue (?:comment|session)|memory (?:recall|read|remember|forget)|wiki (?:read|history))\b/);
    expect(artifact.prompt).toContain("Wiki is materialized in `./wiki`");
    expect(artifact.prompt).toContain("`./.multiremi/sessions/`");
    expect(artifact.prompt).toContain("`remi wiki status`");
    expect(artifact.prompt).toContain("`remi wiki push`");
    expect(artifact.prompt).toContain("`overview.md`");
    expect(artifact.prompt).toContain("no deeper than five levels");
  });

  it("does not claim repositories are mounted for a discussion Session", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      holdsWorkspace: false,
      holds_workspace: false,
    } as any, {
      repoCheckouts: [{
        repoUrl: "https://github.com/example/knowledge",
        path: "/tmp/knowledge",
        branch: "agent/MUL-136",
      }],
    });

    expect(prompt).not.toContain("## Available Repositories");
    expect(prompt).not.toContain("already checked out into the working directory");
  });

  it("tells issue tasks how to pick a project before creating an issue", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt(task as any);

    expect(prompt).toContain("## Creating Follow-up Issues");
    expect(prompt).toContain("`remi project list`");
    expect(prompt).toContain("`remi project defaults <project>`");
    expect(prompt).toContain("--use-project-defaults");

    const deltaPrompt = buildTaskPrompt({
      ...task,
      sessionProjection: { mode: "delta", jsonl: '{"type":"noop"}' },
    } as any);
    expect(deltaPrompt).not.toContain("## Creating Follow-up Issues");
  });

  it("injects Project Instructions exactly once after Project Context in bootstrap", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const instructions = "Run the focused tests before handing off.";
    const prompt = buildTaskPrompt({
      ...task,
      project: { ...task.project!, instructions },
    } as any);

    expect(prompt.match(/## Project Instructions/g)).toHaveLength(1);
    expect(prompt).toContain(`## Project Instructions\n${instructions}`);
    expect(prompt.indexOf("## Project Context")).toBeLessThan(prompt.indexOf("## Project Instructions"));
    expect(prompt.indexOf("## Project Instructions")).toBeLessThan(prompt.indexOf("## Project Knowledge"));
  });

  it("omits blank Project Instructions from bootstrap", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      project: { ...task.project!, instructions: "  \n\t" },
    } as any);

    expect(prompt).toContain("## Project Context");
    expect(prompt).not.toContain("## Project Instructions");
    expect(prompt).toContain("## Project Knowledge");
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
    expect(prompt).toContain("Use the `remi memory` CLI only");
    expect(prompt).toContain("Do not use an MCP server for Project Memory");
    expect(prompt).not.toContain("## Project Memory");
    expect(prompt).not.toContain("## Project Wiki");
    expect(prompt).not.toContain("MEMORY_BODY_MUST_NOT_SHIP");
    expect(prompt).not.toContain("WIKI_SUMMARY_MUST_NOT_SHIP");
    expect(prompt).not.toContain("SCHEMA_BODY_MUST_NOT_SHIP");
  });

  it("builds a compact delta without replaying stable context", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const instructions = "DO_NOT_REPEAT_PROJECT_INSTRUCTIONS";
    const deltaInstructions = "Re-read the newest review comment.";
    const prompt = buildTaskPrompt({
      ...task,
      project: { ...task.project!, instructions, deltaInstructions },
      prompt: "Apply the review feedback.",
      workspaceContext: "DO_NOT_REPEAT_WORKSPACE",
      workspaceBootstrapPrompt: "DO_NOT_REPEAT_WORKSPACE_BOOTSTRAP",
      workspaceDeltaPrompt: "Keep the follow-up concise.",
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
    expect(prompt).toContain("## Workspace Delta Instructions\nKeep the follow-up concise.");
    expect(prompt).toContain(`## Project Delta Instructions\n${deltaInstructions}`);
    expect(prompt).toContain("## Issue");
    expect(prompt).not.toContain("DO_NOT_REPEAT_WORKSPACE");
    expect(prompt).not.toContain("DO_NOT_REPEAT_WORKSPACE_BOOTSTRAP");
    expect(prompt).not.toContain("Implement the requested behavior.");
    expect(prompt).not.toContain("## Project Context");
    expect(prompt).not.toContain("## Project Instructions");
    expect(prompt).not.toContain(instructions);
    expect(prompt).not.toContain("## Project Knowledge");
    expect(prompt).not.toContain("## Available Repositories");
    expect(prompt).not.toContain("## Agent Instructions");
    expect(prompt).not.toContain("## Output");
    expect(prompt).not.toContain("Issue Workspace Session History");
  });

  it("does not duplicate an Autopilot Runbook already used as Current Request", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const runbook = "Review the merged Issue and update its Wiki.";
    const prompt = buildTaskPrompt({
      ...task,
      prompt: runbook,
      autopilotTitle: "Wiki Maintainer",
      autopilotSource: "trigger_issue",
      autopilotDescription: runbook,
    } as any);

    expect(prompt).toContain(`## Current Request\n${runbook}`);
    expect(prompt.match(new RegExp(runbook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(prompt).toContain("## Autopilot Context");
  });

  it("does not advertise provider history without an Issue Session workspace", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Direct", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Direct task" });
    const prompt = buildTaskPrompt(store.getTaskWithAgent(task.id)! as any);

    expect(prompt).not.toContain("Issue Workspace Session History");
    expect(prompt).not.toContain(".multiremi/sessions/");
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
        instructions: "Open a draft PR early and summarize only after the current round is complete.",
        members: [
          { agentId: agent.id, name: agent.name, role: "leader" },
          { agentId: "agt_reviewer", name: "Reviewer", role: "reviewer", description: "Owns security reviews" },
        ],
      },
    } as any);

    expect(prompt).toContain("## Squad Coordination");
    expect(prompt).toContain("## Squad Instructions");
    expect(prompt).toContain("Open a draft PR early and summarize only after the current round is complete.");
    expect(prompt).toContain("Reviewer (agent: agt_reviewer) - reviewer - Owns security reviews");
    expect(prompt).toContain("`[@Reviewer](mention://agent/agt_reviewer)`");
    expect(prompt).toContain("independent workstreams");
    expect(prompt).toContain(`remi comment add ${issue.id} --content-stdin`);
    expect(prompt).toContain("cat <<'MULTIREMI_COMMENT'");
    // Delegation happens via comments inside this issue; the squad block must
    // never teach issue creation (the follow-up-issue guidance lives elsewhere).
    const squadSection = prompt.slice(prompt.indexOf("## Squad Coordination"), prompt.indexOf("## Agent Instructions"));
    expect(squadSection).not.toContain("remi issue create");
  });

  it("does not teach squad mention syntax to a non-leader agent", () => {
    const store = createStore();
    const { agent, task } = createProjectTask(store);
    const prompt = buildTaskPrompt({
      ...task,
      squadContext: {
        id: "sqd_core",
        name: "Core squad",
        leaderAgentId: "agt_leader",
        instructions: "This must only reach the leader.",
        members: [
          { agentId: "agt_leader", name: "Leader", role: "leader" },
          { agentId: agent.id, name: agent.name, role: "member" },
        ],
      },
    } as any);

    expect(prompt).not.toContain("## Squad Coordination");
    expect(prompt).not.toContain("This must only reach the leader.");
    expect(prompt).not.toContain("mention://agent/");
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

  it("injects bounded repository failure diagnostics into the agent prompt", () => {
    const store = createStore();
    const { task } = createProjectTask(store);
    const prompt = buildTaskPrompt(task, {
      repoWarnings: [
        {
          repoUrl: "git@github.com:example/stale.git",
          kind: "stale_cache",
          message: "git fetch timed out\nafter retries",
        },
        {
          repoUrl: "git@github.com:example/missing.git",
          kind: "unavailable",
          message: `clone failed ${"x".repeat(600)}`,
        },
      ],
    });

    expect(prompt).toContain("## Repository Availability Warnings");
    expect(prompt).toContain("may use stale cached data");
    expect(prompt).toContain("Do not assume it contains the latest remote changes");
    expect(prompt).toContain("checkout is unavailable");
    expect(prompt).toContain("Do not claim that you inspected its source code");
    expect(prompt).toContain("git fetch timed out after retries");
    expect(prompt).not.toContain("\nafter retries");
    expect(prompt).not.toContain("x".repeat(501));
  });

  it("does not add a repository warning section to healthy prompts", () => {
    const store = createStore();
    const { task } = createProjectTask(store);

    expect(buildTaskPrompt(task)).not.toContain("Repository Availability Warnings");
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
