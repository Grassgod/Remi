import { describe, expect, it } from "bun:test";
import type { AgentTask } from "@daemon/contracts/types.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";

function sideTask(mode: "bootstrap" | "delta"): AgentTask {
  return {
    id: "task", workspaceId: "local", prompt: "Explain the parser",
    issueId: "issue", issueSessionId: "side", holdsWorkspace: false,
    issue: { id: "issue", key: "MUL-324", title: "Side", description: null, metadata: {} },
    issueSession: { id: "side", title: "Side", parentSessionId: "parent", inheritMode: "follow", withCode: true },
    sessionProjection: { mode, jsonl: '{"type":"session_event","body":"Side history"}' },
    repos: [{ url: "https://example.test/repo.git" }], projectResources: [], project: null,
    agent: null, chatSessionId: null,
    autopilotRunId: null, completedAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    workDir: null, runtimeId: null, triggerCommentId: null, triggerSummary: null, sessionId: null,
  };
}

const snapshot = { repoUrl: "https://example.test/repo.git", path: "/discussions/MUL-324/side/repo", commit: "a".repeat(40) };

describe("read-only code snapshot prompts", () => {
  it.each(["bootstrap", "delta"] as const)("reports the frozen path and commit in a %s turn", (mode) => {
    const prompt = buildTaskPrompt(sideTask(mode), { repoSnapshots: [snapshot] });
    expect(prompt).toContain(snapshot.path);
    expect(prompt).toContain(snapshot.commit);
    expect(prompt).toContain("uncommitted parent changes are not included");
    expect(prompt).toContain("git log, blame, diff, show, and status");
    expect(prompt).toContain("even if a later request asks for edits");
    expect(prompt).toContain("git tag can affect the parent");
    expect(prompt).toContain("HEAD and index live in the bare repository's worktrees/<id> directory");
    expect(prompt).toContain("corrupt this snapshot view even when file writes fail");
    expect(prompt).toContain("without moving the parent's HEAD");
    expect(prompt).toContain("pinned commit OID below as authoritative");
    expect(prompt).toContain("No push credentials are provided");
    expect(prompt).toContain("Sub-agents are off-limits");
    expect(prompt).not.toContain("## Available Repositories");
    expect(prompt).not.toContain("## Shared Workspace Coordination");
    expect(prompt).not.toContain("Use `remi repo checkout");
  });

  it("supports snake-case Session fields", () => {
    const task = sideTask("bootstrap");
    task.issueSession = undefined;
    task.issue_session = { id: "side", title: "Side", parent_session_id: "parent", inherit_mode: "snapshot", with_code: true };
    expect(buildTaskPrompt(task, { repoSnapshots: [snapshot] })).toContain(snapshot.path);
  });

  it("ignores snapshots without opt-in, valid parent lineage, or an Issue Session", () => {
    const task = sideTask("bootstrap");
    for (const candidate of [
      { ...task, issueSession: { ...task.issueSession!, withCode: false } },
      { ...task, issueSession: { ...task.issueSession!, parentSessionId: null } },
      { ...task, chatSessionId: "private-chat" },
    ]) {
      expect(buildTaskPrompt(candidate, { repoSnapshots: [snapshot] })).not.toContain(snapshot.path);
    }
  });
});
