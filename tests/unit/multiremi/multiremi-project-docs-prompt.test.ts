import { createResponsibleTestIssue } from './helpers.js';
import { beforeAll, afterAll, afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { buildTaskPromptArtifact } from "@multiremi/prompt.js";
import { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { normalizeDaemonClaimTask } from "@multiremi/worker/client.js";
import { LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT } from "@multiremi/contracts/remi-rules.js";
import { snapshotStatsForFile, createSnapshotStore, resetMultiremiTestEnv } from "./helpers.js";

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
  const issue = createResponsibleTestIssue(store, {
    title: "Use project knowledge",
    description: "Implement the requested behavior.",
    projectId: project.id,
  });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Do the work" });
  return { agent, project, issue, task: store.getTaskWithAgent(task.id)! };
}

/** The task as the daemon receives it from the production offer path (ADR 0023: range records, no history). */
function offeredTask(store: MultiremiStore, taskId: string) {
  const task = store.getTaskWithAgent(taskId)!;
  const response = daemonTaskClaimResponse(store, task, store.getTaskTriggerMetadata(task));
  useTaskSessionInput(store, task, response);
  return normalizeDaemonClaimTask(response)!;
}

/** A session projection in the offer's shape: the unread range record, then the triggering messages. */
function rangeProjection(mode: "bootstrap" | "delta", sessionId: string, fromSeq: number, toSeq: number,
  triggers: Record<string, unknown>[], complete = true) {
  return { mode, jsonl: [
    JSON.stringify({ type: "unread_range", session_id: sessionId, from_seq: fromSeq, to_seq: toSeq,
      unread_count: toSeq - fromSeq, instruction: "read the range", ...(complete ? { complete: true } : {}) }),
    ...triggers.map(trigger => JSON.stringify({ type: "triggering_message", ...trigger })),
  ].join("\n") };
}

/** Both parts of an attempt; instructions are rendered the same way for a new and a resumed provider session. */
function bothParts(task: any, opts: Parameters<typeof buildTaskPromptArtifact>[1] = {}) {
  const fresh = buildTaskPromptArtifact({ ...task, sessionProjection: { ...task.sessionProjection, mode: "bootstrap" } }, opts);
  const resumed = buildTaskPromptArtifact({ ...task, sessionProjection: { ...task.sessionProjection, mode: "delta" } }, opts);
  expect(resumed.instructions).toBe(fresh.instructions);
  expect(resumed.prompt).toBe(fresh.prompt);
  return fresh;
}

describe("task instructions and turn input", () => {
  it("gives homepage Chat only the new message and keeps CLI directory notes in the instructions", () => {
    const store = createSnapshotStore();
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
    expect(store.getTaskWithAgent(sent.task.id)!.repos).toEqual([]);

    const task = offeredTask(store, sent.task.id);
    expect(task.sessionProjection?.jsonl.split("\n", 1)[0]).toContain('"type":"unread_range"');
    const { prompt, instructions } = buildTaskPromptArtifact(task);
    // A one-to-one Chat turn is the user's text as written: no headings, labels or history replay.
    expect(prompt).toBe("latest question");
    expect(instructions).toContain("## Remi CLI");
    expect(instructions).toContain("`remi context`");
    expect(instructions).toContain(`\`remi message list ${chat.id}\``);
    expect(instructions).toContain("`remi project list|get|search`");
    expect(instructions).toContain("`remi repo list|get|search`");
    expect(instructions).toContain("`remi repo checkout <repo-id>`");
    expect(instructions).not.toContain("## Available Repositories");
    expect(instructions).not.toContain("https://github.com/example/chat-prompt");
    expect(instructions).not.toContain("## Finishing");
  });

  it("keeps a private Chat free of stale Issue context and broadcasts for new and resumed sessions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { prompt, instructions } = bothParts({
      ...task,
      chatSessionId: "chat_private",
      prompt: "Keep this conversation independent.",
      boundIssueUpdates: ["ISSUE_BROADCAST_MUST_NOT_SHIP"],
      boundIssueUpdatesOmittedCount: 3,
      issueSessionResults: [{ id: "result", title: "Unrelated result", body: "ISSUE_RESULT_MUST_NOT_SHIP" }],
      project: { ...task.project!, deltaInstructions: "PROJECT_DELTA_MUST_NOT_SHIP" },
      sessionProjection: { mode: "bootstrap", jsonl: "" },
    });

    expect(prompt).toBe("Keep this conversation independent.");
    expect(instructions).toContain("## Remi CLI");
    expect(instructions).toContain("This Chat has no project");
    for (const text of [prompt, instructions]) {
      expect(text).not.toContain("## Issue");
      expect(text).not.toContain("## Bound Issue");
      expect(text).not.toContain("## Project");
      expect(text).not.toContain("## Available Repositories");
      expect(text).not.toContain("## Shared Workspace Coordination");
      expect(text).not.toContain("## Sharing Results Across Sessions");
      expect(text).not.toContain("ISSUE_BROADCAST_MUST_NOT_SHIP");
      expect(text).not.toContain("ISSUE_RESULT_MUST_NOT_SHIP");
      expect(text).not.toContain("PROJECT_DELTA_MUST_NOT_SHIP");
    }
  });

  it("preserves Feishu Issue topic context and new log entries for new and resumed sessions", () => {
    const store = createSnapshotStore();
    const { issue, task } = createProjectTask(store);
    const { prompt, instructions } = bothParts({
      ...task,
      chatSessionId: "chat_issue_topic",
      holdsWorkspace: false,
      boundIssue: { id: issue.id, key: issue.key, title: issue.title, status: issue.status },
      boundIssueLog: {
        session_id: "session_issue", from_seq: 0, to_seq: 1, next_seq: 1, has_more: false,
        content_jsonl: JSON.stringify({ type: "unread_range", session_id: "session_issue", from_seq: 0, to_seq: 1,
          unread_count: 1, instruction: "read the range" }),
      },
      sessionProjection: { mode: "bootstrap", jsonl: "" },
    });

    expect(instructions).toContain(`Key: ${issue.key}`);
    // The status moves between turns: the turn input's log line carries it, not AGENTS.md.
    expect(instructions).toContain(`## Bound Issue\nThis Feishu topic is bound to ${issue.key} — ${issue.title}.\n`);
    expect(instructions).not.toContain(`(${issue.status})`);
    expect(instructions).toContain("## Bound Issue Follow-up");
    expect(instructions).toContain("## Project Context");
    expect(instructions).not.toContain("## Bound Issue Log");
    expect(instructions).not.toContain("Write the summary from the log");
    expect(instructions).not.toContain("`remi project list|get|search`");
    expect(instructions).not.toContain("## Available Repositories");
    // The log itself is not inlined; the turn input names the new entries and the read.
    expect(prompt).toContain(`(Issue ${issue.key} (${issue.status}) has 1 new log entry since you last read it: \`remi message list session_issue --from 0 --to 1\`)`);
  });

  it("builds session instructions with stable execution context", () => {
    const store = createSnapshotStore();
    const { issue, task } = createProjectTask(store);

    const artifact = buildTaskPromptArtifact({
      ...task,
      workspaceContext: "Use the shared release checklist.",
      workspacePrompt: "Create a pull request before completion.",
      // A server that sends `workspace_prompt` also sends the old halves for old daemons; they are ignored.
      workspaceBootstrapPrompt: "OLD_BOOTSTRAP_HALF_IGNORED",
      workspaceDeltaPrompt: "OLD_DELTA_HALF_IGNORED",
      sessionProjection: { mode: "bootstrap", jsonl: "" },
    } as any);
    const { instructions } = artifact;

    expect(artifact.mode).toBe("bootstrap");
    // No projection input: the task's own prompt, then the comment this turn answers.
    expect(artifact.prompt).toBe(`Do the work\n\n(Reply to comment ${task.triggerCommentId}: \`remi message send ${task.issueSessionId} --kind reply --reply-to ${task.triggerCommentId}\`.)`);
    expect(artifact.sha256).toBe(createHash("sha256").update(artifact.prompt).digest("hex"));
    expect(instructions.startsWith("# Codex\n\nKeep changes focused.\n\n# Remi")).toBe(true);
    expect(instructions).toContain("## Workspace Context\nUse the shared release checklist.");
    expect(instructions).toContain("## Workspace Instructions\nCreate a pull request before completion.");
    expect(instructions).not.toContain("OLD_BOOTSTRAP_HALF_IGNORED");
    expect(instructions).not.toContain("OLD_DELTA_HALF_IGNORED");
    expect(instructions).toContain(`Key: ${issue.key}`);
    expect(instructions).toContain("Implement the requested behavior.");
    expect(instructions).toContain("## Project Context");
    expect(instructions).toContain("## Available Repositories");
    expect(instructions).toContain("## Finishing\nWhen finished, summarize what changed, how it was verified, and any remaining risks.");
    for (const removed of ["# Bootstrap Prompt", "## Current Request", "## Current Turn", "## Agent Instructions", "## Output", "## Skills"]) {
      expect(instructions).not.toContain(removed);
      expect(artifact.prompt).not.toContain(removed);
    }
    expect(instructions).toContain('remi memory search "<query>"');
    expect(instructions).toContain("remi memory get <slug-or-id>");
    expect(instructions).not.toMatch(/remi (?:issue (?:comment|session)|memory (?:recall|read|remember|forget)|wiki (?:read|history))\b/);
    expect(instructions).toContain("Wiki is materialized in `$MULTIREMI_WORKSPACE_ROOT/wiki`");
    expect(instructions).toContain("`./.multiremi/sessions/`");
    expect(instructions).toContain("`remi wiki status`");
    expect(instructions).toContain("`remi wiki push`");
    expect(instructions).toContain("non-empty root `index.md`");
    expect(instructions).toContain("non-empty root `log.md`");
    expect(instructions).toContain("let project and repository semantics choose the directory names");
    // Names stay free, but the size baseline has to travel with them: without it
    // the agent satisfies "organize by semantics" with one 100-page directory.
    expect(instructions).toContain("at most 20 body pages directly inside any one directory");
    expect(instructions).toContain("at most 5 non-index body pages at the root");
    expect(instructions).not.toContain("no deeper than five levels");
    expect(instructions).not.toContain("`overview.md` index for every functional directory");
  });

  it("does not claim repositories are mounted for a discussion Session", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { instructions } = buildTaskPromptArtifact({
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

    expect(instructions).not.toContain("## Available Repositories");
    expect(instructions).not.toContain("already checked out");
    expect(instructions).not.toContain("## Shared Workspace Coordination");
  });

  it("tells issue tasks how to pick a project before creating an issue", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    // A resumed provider session keeps the same notes: they live in AGENTS.md, not in a first-turn prompt.
    const { instructions } = bothParts({ ...task, sessionProjection: { mode: "bootstrap", jsonl: "" } });

    expect(instructions).toContain("## Creating Follow-up Issues");
    expect(instructions).toContain("`remi project list`");
    expect(instructions).toContain("`remi project defaults <project>`");
    expect(instructions).toContain("--use-project-defaults");
  });

  it("injects Project Instructions exactly once after Project Context in the instructions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const projectInstructions = "Run the focused tests before handing off.";
    const { prompt, instructions } = buildTaskPromptArtifact({
      ...task,
      project: { ...task.project!, instructions: projectInstructions },
    } as any);

    expect(instructions.match(/## Project Instructions/g)).toHaveLength(1);
    expect(instructions).toContain(`## Project Instructions\n${projectInstructions}`);
    expect(instructions.indexOf("## Project Context")).toBeLessThan(instructions.indexOf("## Project Instructions"));
    expect(instructions.indexOf("## Project Instructions")).toBeLessThan(instructions.indexOf("## Project Knowledge"));
    expect(prompt).not.toContain(projectInstructions);
  });

  it("omits blank Project Instructions from the instructions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { instructions } = buildTaskPromptArtifact({
      ...task,
      project: { ...task.project!, instructions: "  \n\t" },
    } as any);

    expect(instructions).toContain("## Project Context");
    expect(instructions).not.toContain("## Project Instructions");
    expect(instructions).toContain("## Project Knowledge");
  });

  it("does not embed Memory, Wiki, or schema bodies in the instructions or the turn input", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { prompt, instructions } = buildTaskPromptArtifact({
      ...task,
      projectDocs: {
        memory: [{ id: "mem", slug: "secret-memory", title: "Memory title", body: "MEMORY_BODY_MUST_NOT_SHIP", kind: "memory" }],
        wiki: [{ id: "wiki", slug: "architecture", title: "Architecture", body: null, summary: "WIKI_SUMMARY_MUST_NOT_SHIP", kind: "wiki" }],
        schema: "SCHEMA_BODY_MUST_NOT_SHIP",
      },
    } as any);

    expect(instructions).toContain("## Project Knowledge");
    expect(instructions).toContain("Use the `remi memory` CLI only");
    expect(instructions).toContain("Do not use an MCP server for Project Memory");
    for (const text of [prompt, instructions]) {
      expect(text).not.toContain("## Project Memory");
      expect(text).not.toContain("## Project Wiki");
      expect(text).not.toContain("MEMORY_BODY_MUST_NOT_SHIP");
      expect(text).not.toContain("WIKI_SUMMARY_MUST_NOT_SHIP");
      expect(text).not.toContain("SCHEMA_BODY_MUST_NOT_SHIP");
    }
  });

  it("gives a resumed session only the new messages, with stable context left to the instructions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const sessionId = task.issueSessionId!;
    const resumed = {
      ...task,
      project: { ...task.project!, instructions: "STABLE_PROJECT_INSTRUCTIONS" },
      prompt: "LEGACY_TASK_PROMPT_NOT_SENT",
      triggerCommentId: "cmt_new",
      workspaceContext: "STABLE_WORKSPACE_CONTEXT",
      workspacePrompt: "STABLE_WORKSPACE_PROMPT",
      sessionProjection: rangeProjection("delta", sessionId, 3, 4,
        [{ seq: 4, id: "cmt_new", author_type: "member", author_id: "mem_1", body: "New review feedback" }]),
    } as any;
    const { prompt, instructions } = bothParts(resumed);

    const reply = `(Reply to comment cmt_new: \`remi message send ${sessionId} --kind reply --reply-to cmt_new\`.)`;
    expect(prompt).toBe(`[Member mem_1] New review feedback\n\n${reply}`);
    for (const stable of ["STABLE_PROJECT_INSTRUCTIONS", "STABLE_WORKSPACE_CONTEXT", "STABLE_WORKSPACE_PROMPT", "Implement the requested behavior."]) {
      expect(prompt).not.toContain(stable);
      expect(instructions).toContain(stable);
    }
    expect(prompt).not.toContain("LEGACY_TASK_PROMPT_NOT_SENT");
    expect(prompt).not.toContain("## ");
    expect(instructions).not.toContain("New review feedback");

    // An incomplete range adds one sentence naming the read, never the history itself.
    const partial = buildTaskPromptArtifact({ ...resumed, sessionProjection: rangeProjection("delta", sessionId, 1, 4,
      [{ seq: 4, id: "cmt_new", author_type: "member", author_id: "mem_1", body: "New review feedback" }], false) });
    expect(partial.prompt).toBe(`[Member mem_1] New review feedback\n\n(Some unread messages aren't shown here. Read them before you answer: \`remi message list ${sessionId} --from 1 --to 4\`)\n\n${reply}`);
  });

  it("merges an older server's bootstrap and delta halves into one Workspace and Project section", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { instructions } = bothParts({
      ...task,
      project: { ...task.project!, instructions: "Project rules.", deltaInstructions: "Re-read the newest review comment." },
      workspaceBootstrapPrompt: `${LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nCustom bootstrap rule.`,
      workspaceDeltaPrompt: "Keep the follow-up concise.",
      sessionProjection: { mode: "bootstrap", jsonl: "" },
    });

    expect(instructions).toContain("## Workspace Instructions\nCustom bootstrap rule.\n\nKeep the follow-up concise.");
    expect(instructions.match(/## Workspace Instructions/g)).toHaveLength(1);
    expect(instructions).toContain("## Project Instructions\nProject rules.\n\nRe-read the newest review comment.");
    expect(instructions).not.toContain("## Workspace Bootstrap Instructions");
    expect(instructions).not.toContain("## Workspace Delta Instructions");
    expect(instructions).not.toContain("## Project Delta Instructions");
    // The former default is Remi's own Delivery section now, not a copy inside the workspace prompt.
    expect(instructions).not.toContain("## Code Delivery Contract");
  });

  it("keeps an Autopilot Runbook once in the turn input and once in the Autopilot Context", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const runbook = "Review the merged Issue and update its Wiki.";
    const { prompt, instructions } = buildTaskPromptArtifact({
      ...task,
      prompt: runbook,
      autopilotTitle: "Wiki Maintainer",
      autopilotSource: "trigger_issue",
      autopilotDescription: runbook,
    } as any);
    const pattern = new RegExp(runbook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

    expect(prompt.startsWith(runbook)).toBe(true);
    expect(prompt.match(pattern)).toHaveLength(1);
    expect(instructions).toContain(`## Autopilot Context\nTitle: Wiki Maintainer\nSource: trigger_issue\n${runbook}`);
    expect(instructions.match(pattern)).toHaveLength(1);
  });

  it("tells an automation run's agent how to stay quiet only when the run has a Chat", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const run = { ...task, autopilotRunId: "run_1", autopilotTitle: "Nightly", autopilotSource: "schedule" } as any;

    expect(buildTaskPromptArtifact({ ...run, chatSessionId: "chat_1" }).instructions).toContain("remi automation quiet");
    expect(buildTaskPromptArtifact({ ...run, chatSessionId: null }).instructions).not.toContain("remi automation quiet");
  });

  it("does not advertise provider history without an Issue Session workspace", () => {
    const store = createSnapshotStore();
    const agent = store.createAgent({ name: "Direct", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Direct task" });
    const { prompt, instructions } = buildTaskPromptArtifact(store.getTaskWithAgent(task.id)! as any);

    expect(prompt).toBe("Direct task");
    for (const text of [prompt, instructions]) {
      expect(text).not.toContain("Issue Workspace Session History");
      expect(text).not.toContain(".multiremi/sessions/");
    }
  });

  it("renders the triggering comment once with its author and the comment to reply to", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const sessionId = task.issueSessionId!;
    const triggerBody = "Please fix the `$PATH` handling.";
    const { prompt, instructions } = buildTaskPromptArtifact({
      ...task,
      // A legacy prompt that quoted the trigger is not sent once the projection carries it.
      prompt: `A teammate mentioned you.\n\n## Triggering Comment\n${triggerBody}`,
      triggerCommentId: "cmt_trigger",
      triggerCommentContent: triggerBody,
      triggerAuthorType: "member",
      triggerAuthorName: "Alice",
      sessionProjection: rangeProjection("delta", sessionId, 6, 7,
        [{ seq: 7, id: "cmt_trigger", author_type: "member", author_id: "mem_alice", body: triggerBody }]),
    } as any);

    expect(prompt).toBe(`[Alice] ${triggerBody}\n\n(Reply to comment cmt_trigger: \`remi message send ${sessionId} --kind reply --reply-to cmt_trigger\`.)`);
    expect(prompt).not.toContain("## Triggering Comment");
    expect(prompt).not.toContain("A teammate mentioned you.");
    expect(instructions).not.toContain(triggerBody);
    expect(instructions).toContain(`remi message send ${sessionId} --kind reply --reply-to <comment-id> --content-stdin`);
  });

  it("shows a trigger once from the task prompt when no Session projection is available", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const triggerBody = "One standalone trigger.";
    const { prompt } = buildTaskPromptArtifact({
      ...task,
      // A comment-triggered task's prompt is the comment body.
      prompt: triggerBody,
      triggerCommentId: "cmt_trigger",
      triggerCommentContent: triggerBody,
    } as any);

    expect(prompt.split(triggerBody)).toHaveLength(2);
    expect(prompt).toBe(`${triggerBody}\n\n(Reply to comment cmt_trigger: \`remi message send ${task.issueSessionId} --kind reply --reply-to cmt_trigger\`.)`);
    expect(prompt).not.toContain("## Triggering Comment");
  });

  it("injects squad roster and bounded delegation guidance for the leader", () => {
    const store = createSnapshotStore();
    const { agent, task } = createProjectTask(store);
    const { prompt, instructions } = buildTaskPromptArtifact({
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

    expect(prompt).not.toContain("## Squad Coordination");
    expect(instructions).toContain("## Squad Coordination");
    expect(instructions).toContain("## Squad Instructions");
    expect(instructions).toContain("Open a draft PR early and summarize only after the current round is complete.");
    expect(instructions).toContain("Reviewer (agent: agt_reviewer) - reviewer - Owns security reviews");
    expect(instructions).toContain("--to agt_reviewer --kind request --wake now --content-stdin");
    expect(instructions).toContain("independent workstreams");
    expect(instructions).toContain("Read the target's inbox and turns before sending to avoid duplicate work");
    expect(instructions).toContain("Running turns receive an interruption; otherwise the inbox schedules the next turn");
    expect(instructions).toContain("Select the correct Session before sending a request");
    expect(instructions).toContain(`remi message send ${task.issueSessionId}`);
    expect(instructions).toContain("cat <<'MULTIREMI_MESSAGE'");
    // Delegation happens via comments inside this issue; the squad block must
    // never teach issue creation (the follow-up-issue guidance lives elsewhere).
    const squadSection = instructions.slice(instructions.indexOf("## Squad Coordination"), instructions.indexOf("## Project Context"));
    expect(squadSection).toContain("MULTIREMI_MESSAGE");
    expect(squadSection).not.toContain("remi issue create");
  });

  it("does not teach squad mention syntax to a non-leader agent", () => {
    const store = createSnapshotStore();
    const { agent, task } = createProjectTask(store);
    const { prompt, instructions } = buildTaskPromptArtifact({
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

    for (const text of [prompt, instructions]) {
      expect(text).not.toContain("## Squad Coordination");
      expect(text).not.toContain("This must only reach the leader.");
      expect(text).not.toContain("mention://agent/");
    }
  });

  it("marks pre-checked-out repositories in the instructions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { instructions } = buildTaskPromptArtifact(task, {
      repoCheckouts: [{
        repoUrl: "https://github.com/example/knowledge",
        path: "/tmp/work/knowledge",
        branch: "agent/codex/REMI-1",
      }],
    });

    expect(instructions).toContain("already checked out on the Issue branch");
    expect(instructions).toContain("at `/tmp/work/knowledge` on branch `agent/codex/REMI-1`");
  });

  it("puts bounded repository failure diagnostics in the turn input, not the instructions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { prompt, instructions } = buildTaskPromptArtifact(task, {
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

    // ADR 0023: they change between turns, so AGENTS.md stays the same and the turn says them in one line.
    expect(instructions).toBe(buildTaskPromptArtifact(task).instructions);
    expect(instructions).not.toContain("git@github.com:example/stale.git");
    expect(prompt).toContain("(Repository warnings, diagnostic only: `git@github.com:example/stale.git` may be stale, remote refresh failed");
    expect(prompt).toContain("or that a stale checkout has the latest remote changes");
    expect(prompt).toContain("`git@github.com:example/missing.git` is unavailable, preparation failed");
    expect(prompt).toContain("Don't claim to have inspected code that isn't available");
    expect(prompt).toContain("`git fetch timed out after retries`");
    expect(prompt).not.toContain("\nafter retries");
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("does not add a repository warning section to healthy instructions", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);

    expect(buildTaskPromptArtifact(task).instructions).not.toContain("Repository Availability Warnings");
  });

  it("reports default branch fallback without claiming checkout or fetch failed", () => {
    const { task } = createProjectTask(createSnapshotStore());
    const { prompt } = buildTaskPromptArtifact(task, { repoWarnings: [{
      repoUrl: "https://example.test/repo.git", kind: "default_branch_fallback",
      message: "workflow-dev could not be resolved; fell back to refs/remotes/origin/main",
    }] });
    expect(prompt).toContain("`https://example.test/repo.git` is on a fallback base, the default branch could not be resolved");
    expect(prompt).toContain("workflow-dev");
    expect(prompt).toContain("refs/remotes/origin/main");
    expect(prompt).not.toContain("is unavailable");
    expect(prompt).not.toContain("remote refresh failed");
  });

  it("keeps a checkout command for repositories the daemon did not materialize", () => {
    const store = createSnapshotStore();
    const { task } = createProjectTask(store);
    const { instructions } = buildTaskPromptArtifact({
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

    expect(instructions).toContain("- https://github.com/example/unreachable");
    expect(instructions).toContain("For repositories without a path above, use `remi repo checkout");
  });
});

// Register hooks in this file; shared modules only load once per test process.
let reportSnapshotStats: (() => void) | undefined;
beforeAll(() => { reportSnapshotStats = snapshotStatsForFile(import.meta.path); });
afterAll(() => { reportSnapshotStats?.(); });
