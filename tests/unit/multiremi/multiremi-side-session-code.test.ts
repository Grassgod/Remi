import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = { Authorization: "Bearer MASTER", "Content-Type": "application/json" };

function fixture() {
  const store = createLocalStore();
  const repositoryUrl = "git@github.com:example/side-code.git";
  store.updateWorkspace("local", { repos: [
    { id: "repo_side_code", name: "side-code", url: repositoryUrl, defaultBranch: "main" },
  ] });
  const project = store.createProject({ title: "Code discussion", workspaceId: "local" });
  store.createProjectResource(project.id, { resourceType: "github_repo", resourceRef: { url: repositoryUrl } });
  const issue = store.createIssue({ title: "Read current code", workspaceId: "local", projectId: project.id });
  const parent = store.getOrCreateDefaultIssueSession(issue.id);
  const agent = store.createAgent({ name: "Code reader", provider: "codex", workspaceId: "local" });
  const runtime = store.registerRuntime({
    id: "rt_code_source", name: "Source", provider: "codex", workspaceId: "local", daemonId: "daemon_code_source",
  });
  const other = store.registerRuntime({
    id: "rt_code_other", name: "Other", provider: "codex", workspaceId: "local", daemonId: "daemon_code_other",
  });
  store.getOrCreateSessionAgentLane(parent.id, agent.id);
  db!.run("UPDATE multiremi_session_agent_lanes SET runtime_id = ? WHERE session_id = ? AND agent_id = ?",
    [runtime.id, parent.id, agent.id]);
  return { store, issue, parent, agent, runtime, other, repositoryUrl };
}

describe("side Session code snapshots", () => {
  it("migrates old Sessions with snapshots disabled and reruns without losing the pinned Runtime", () => {
    const f = fixture();
    db!.exec(`ALTER TABLE multiremi_issue_sessions DROP COLUMN with_code;
      ALTER TABLE multiremi_issue_sessions DROP COLUMN code_runtime_id;`);
    runMigrations(db!);
    expect(f.store.getIssueSession(f.parent.id)).toMatchObject({
      withCode: false, with_code: false, codeRuntimeId: null, code_runtime_id: null,
    });
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    runMigrations(db!);
    expect(f.store.getIssueSession(side.id)).toMatchObject({
      withCode: true, with_code: true, codeRuntimeId: f.runtime.id, code_runtime_id: f.runtime.id,
    });
  });

  it("defaults to no code or Runtime pin and keeps ordinary side tasks free of repository mounts", () => {
    const f = fixture();
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id });
    expect(side).toMatchObject({ withCode: false, codeRuntimeId: null, holdsWorkspace: false });
    const task = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Discuss" });
    expect(task).toMatchObject({ runtimeId: null, holdsWorkspace: false });
    expect(f.store.getTaskWithAgent(task.id)?.repos).toEqual([]);
  });

  it("accepts both with-code spellings, returns the binding on every Session read, and keeps it immutable", async () => {
    const f = fixture();
    const app = createMultiremiApp({ store: f.store, authToken: "MASTER" });
    for (const field of ["withCode", "with_code"]) {
      const response = await app.request(`/api/issues/${f.issue.id}/sessions`, {
        method: "POST", headers,
        body: JSON.stringify({ parent_session_id: f.parent.id, [field]: true, holds_workspace: true, inherit_mode: "follow" }),
      });
      expect(response.status).toBe(201);
      const side = await response.json();
      const expected = {
        with_code: true, code_runtime_id: f.runtime.id, holds_workspace: false,
        inherit_mode: "follow", parent_session_id: f.parent.id,
      };
      expect(side).toMatchObject(expected);
      for (const path of [`/api/sessions/${side.id}`, `/api/issues/${f.issue.id}/sessions/${side.id}`]) {
        const read = await app.request(path, { headers });
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject(expected);
      }
      const updated = await app.request(`/api/issues/${f.issue.id}/sessions/${side.id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ title: "Renamed", with_code: false, code_runtime_id: f.other.id, holds_workspace: true }),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ ...expected, title: "Renamed" });
      const listed = await app.request(`/api/issues/${f.issue.id}/sessions`, { headers });
      expect((await listed.json()).find((session: { id: string }) => session.id === side.id)).toMatchObject(expected);
    }
  });

  it("rejects nonboolean values, contradictory aliases, and code without a parent", async () => {
    const f = fixture();
    const app = createMultiremiApp({ store: f.store, authToken: "MASTER" });
    for (const body of [
      { parent_session_id: f.parent.id, with_code: "true" },
      { parentSessionId: f.parent.id, withCode: 1 },
      { parentSessionId: f.parent.id, with_code: null },
      { parent_session_id: f.parent.id, withCode: true, with_code: false },
      { parent_session_id: f.parent.id, withCode: false, with_code: true },
      { with_code: true },
      { withCode: true },
    ]) {
      const response = await app.request(`/api/issues/${f.issue.id}/sessions`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("with_code");
    }
    expect(f.store.listIssueSessions(f.issue.id)).toHaveLength(1);
  });

  it("rejects an unstarted parent clearly but permits a plain discussion", async () => {
    const f = fixture();
    db!.run("UPDATE multiremi_session_agent_lanes SET runtime_id = NULL WHERE session_id = ?", [f.parent.id]);
    expect(() => f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true }))
      .toThrow("with_code requires a parent session lane with a runtime");
    const app = createMultiremiApp({ store: f.store, authToken: "MASTER" });
    const denied = await app.request(`/api/issues/${f.issue.id}/sessions`, {
      method: "POST", headers, body: JSON.stringify({ parent_session_id: f.parent.id, with_code: true }),
    });
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toContain("with_code requires a parent session lane with a runtime");
    const plain = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, with_code: false });
    expect(plain).toMatchObject({ withCode: false, codeRuntimeId: null, holdsWorkspace: false });
  });

  it("pins code tasks to the original parent machine even after the parent lane moves", () => {
    const f = fixture();
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    db!.run("UPDATE multiremi_session_agent_lanes SET runtime_id = ? WHERE session_id = ?", [f.other.id, f.parent.id]);
    const task = f.store.createTask({
      agentId: f.agent.id, issueId: f.issue.id, issueSessionId: side.id, prompt: "Inspect code",
      runtimeId: f.other.id, holdsWorkspace: true,
    });
    expect(task).toMatchObject({ runtimeId: f.runtime.id, holdsWorkspace: false });
    expect(f.store.getTaskWithAgent(task.id)?.repos).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: f.repositoryUrl }),
    ]));
    expect(f.store.claimTask(f.other.id)).toBeNull();
    expect(f.store.claimTask(f.runtime.id)).toMatchObject({ id: task.id, runtimeId: f.runtime.id, holdsWorkspace: false });
  });

  it("captures the most recently updated parent lane's Runtime", () => {
    const f = fixture();
    const recentAgent = f.store.createAgent({ name: "Recent parent author", provider: "codex", workspaceId: "local" });
    f.store.getOrCreateSessionAgentLane(f.parent.id, recentAgent.id);
    db!.run("UPDATE multiremi_session_agent_lanes SET updated_at = ? WHERE session_id = ? AND agent_id = ?",
      ["2026-01-01T00:00:00.000Z", f.parent.id, f.agent.id]);
    db!.run("UPDATE multiremi_session_agent_lanes SET runtime_id = ?, updated_at = ? WHERE session_id = ? AND agent_id = ?",
      [f.other.id, "2026-01-02T00:00:00.000Z", f.parent.id, recentAgent.id]);
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    expect(side.codeRuntimeId).toBe(f.other.id);
    const task = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Read latest parent code" });
    expect(task.runtimeId).toBe(f.other.id);
  });

  it("enforces code machine affinity at claim even when the queued task pin was cleared", () => {
    const f = fixture();
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    const task = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Read code" });
    // Model a generic recovery path that re-pools a queued task.
    db!.run("UPDATE multiremi_tasks SET runtime_id = NULL WHERE id = ?", [task.id]);
    expect(f.store.claimTask(f.other.id)).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
  });

  it("repins a stale dispatch on the wrong machine without redelivering its provider session", () => {
    const f = fixture();
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    const task = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Read code" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
    db!.run(`UPDATE multiremi_tasks SET runtime_id = ?, session_id = 'wrong_machine_session',
      dispatched_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, [f.other.id, task.id]);
    expect(f.store.claimTask(f.other.id)).toBeNull();
    expect(f.store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: f.runtime.id, sessionId: null });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
  });

  it("resolves the reading Agent's provider on the same daemon instead of the parent's provider Runtime", () => {
    const f = fixture();
    const reader = f.store.createAgent({ name: "Claude code reader", provider: "claude", workspaceId: "local" });
    const sameMachine = f.store.registerRuntime({
      id: "rt_code_source_claude", name: "Source Claude", provider: "claude", workspaceId: "local", daemonId: "daemon_code_source",
    });
    const wrongMachine = f.store.registerRuntime({
      id: "rt_code_other_claude", name: "Other Claude", provider: "claude", workspaceId: "local", daemonId: "daemon_code_other",
    });
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    const task = f.store.createTask({
      agentId: reader.id, issueId: f.issue.id, issueSessionId: side.id,
      prompt: "Read", runtimeId: wrongMachine.id,
    });
    expect(task.runtimeId).toBe(sameMachine.id);
    expect(f.store.claimTask(wrongMachine.id)).toBeNull();
    expect(f.store.claimTask(sameMachine.id)?.id).toBe(task.id);
  });

  it("does not let a side lane's old provider lineage override code machine affinity", () => {
    const f = fixture();
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    const previous = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "First read" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(previous.id);
    f.store.startTask(previous.id);
    f.store.completeTask(previous.id, { output: "Read", sessionId: "provider_source", workDir: "/discussion/source" });
    const before = f.store.getSessionAgentLane(side.id, f.agent.id)!;
    expect(before.providerSessionId).toBe("provider_source");
    db!.run("UPDATE multiremi_session_agent_lanes SET runtime_id = ? WHERE session_id = ? AND agent_id = ?",
      [f.other.id, side.id, f.agent.id]);
    const next = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Read again" });
    expect(next).toMatchObject({ runtimeId: f.runtime.id, sessionId: null, workDir: null });
    expect(f.store.getSessionAgentLane(side.id, f.agent.id)!.generation).toBeGreaterThan(before.generation);
    expect(f.store.claimTask(f.other.id)).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(next.id);
  });

  it("keeps the code machine pin while a resume-unsafe retry clears provider lineage", () => {
    const f = fixture();
    const side = f.store.createIssueSession(f.issue.id, { parentSessionId: f.parent.id, withCode: true });
    const first = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Read code" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first.id);
    f.store.startTask(first.id);
    f.store.failTask(first.id, {
      error: "Provider context expired", failureReason: "agent_error.stale_session",
      sessionId: "unsafe_provider", workDir: "/discussion/unsafe",
    });
    const retry = f.store.listTasksForIssue(f.issue.id).find((task) => task.parentTaskId === first.id)!;
    expect(retry).toMatchObject({
      status: "queued", runtimeId: f.runtime.id, holdsWorkspace: false, sessionId: null, workDir: null,
    });
    expect(f.store.claimTask(f.other.id)).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(retry.id);
  });
});
