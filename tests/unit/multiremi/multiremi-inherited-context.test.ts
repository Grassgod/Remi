import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(() => {
  setSystemTime();
  resetMultiremiTestEnv();
});

const headers = { Authorization: "Bearer MASTER", "Content-Type": "application/json" };
const diagnosticColumns = [
  "inherited_projection_truncated",
  "inherited_projection_omitted_events",
  "inherited_projection_estimated_tokens",
  "inherited_projection_to_seq",
  "inherited_projection_token_budget",
  "inherited_projection_recorded_at",
] as const;

function fixture(largeParent = false) {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Inherited diagnostics", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Reader", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const issue = store.createIssue({ title: "Inherited diagnostics", workspaceId: "local" });
  const parent = store.getOrCreateDefaultIssueSession(issue.id);
  for (let index = 0; index < (largeParent ? 24 : 2); index++) {
    store.appendSessionEvent(parent.id, {
      authorType: "agent", authorId: agent.id,
      body: `Parent ${index}: ${largeParent ? "历史".repeat(4_000) : "Reference decision"}`,
    });
  }
  const side = store.createIssueSession(issue.id, { title: "Side", parentSessionId: parent.id });
  const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Explain the decision" });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  return { store, runtime, agent, issue, parent, side, task, app };
}

function persistedDiagnostics(taskId: string) {
  return db!.query(`SELECT ${diagnosticColumns.join(", ")} FROM multiremi_tasks WHERE id = ?`).get(taskId);
}

function expectNullDiagnostics(store: ReturnType<typeof createLocalStore>, taskId: string) {
  expect(persistedDiagnostics(taskId)).toEqual(Object.fromEntries(diagnosticColumns.map((column) => [column, null])));
  expect(store.getTask(taskId)).toMatchObject({
    inheritedProjectionTruncated: null, inherited_projection_truncated: null,
    inheritedProjectionOmittedEvents: null, inherited_projection_omitted_events: null,
    inheritedProjectionEstimatedTokens: null, inherited_projection_estimated_tokens: null,
    inheritedProjectionToSeq: null, inherited_projection_to_seq: null,
    inheritedProjectionTokenBudget: null, inherited_projection_token_budget: null,
    inheritedProjectionRecordedAt: null, inherited_projection_recorded_at: null,
  });
}

describe("persisted inherited context diagnostics", () => {
  it("upgrades existing tasks with six nullable columns and preserves null through the mapper", () => {
    const { store, task } = fixture();
    for (const column of diagnosticColumns) db!.exec(`ALTER TABLE multiremi_tasks DROP COLUMN ${column}`);
    runMigrations(db!);
    runMigrations(db!);
    const columns = db!.query("PRAGMA table_info(multiremi_tasks)").all();
    for (const column of diagnosticColumns) {
      const type = column === "inherited_projection_recorded_at" ? "TEXT" : "INTEGER";
      expect(columns).toContainEqual(expect.objectContaining({ name: column, type, notnull: 0, dflt_value: null }));
    }
    expectNullDiagnostics(store, task.id);
  });

  it("reports null before claim, then the actual inherited claim values rather than the untruncated own projection", async () => {
    const { store, runtime, agent, parent, side, task, app } = fixture(true);
    const path = `/api/sessions/${side.id}/inherited-context`;
    const before = await app.request(path, { headers });
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      session_id: side.id, parent_session_id: parent.id, parent_session_title: parent.title,
      inherit_mode: "snapshot", inherit_cutoff_seq: side.inheritCutoffSeq,
      inherited_event_count: 24, diagnostics: null,
    });
    expectNullDiagnostics(store, task.id);

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST", headers });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()).task;
    expect(claimed.id).toBe(task.id);
    const inherited = claimed.inherited_session_projection;
    const own = claimed.session_projection;
    expect(own.truncated).toBe(false);
    expect(own.omitted_events).toBe(0);
    expect(inherited.truncated).toBe(true);
    expect(inherited.omitted_events).toBeGreaterThan(0);
    expect(inherited.estimated_tokens).not.toBe(own.estimated_tokens);
    const budget = Math.floor(resolveProjectionTokenBudget({ provider: agent.provider, model: agent.model, degradeLevel: 0 }) * 0.4);
    expect(inherited.estimated_tokens).toBeLessThanOrEqual(budget);
    const stored = store.getTask(task.id)!;
    expect(stored.inheritedProjectionRecordedAt).toBe(stored.updatedAt);
    expect(persistedDiagnostics(task.id)).toEqual({
      inherited_projection_truncated: 1,
      inherited_projection_omitted_events: inherited.omitted_events,
      inherited_projection_estimated_tokens: inherited.estimated_tokens,
      inherited_projection_to_seq: inherited.to_seq,
      inherited_projection_token_budget: budget,
      inherited_projection_recorded_at: stored.updatedAt,
    });
    expect(stored).toMatchObject({
      projectionTruncated: false, projectionOmittedEvents: 0,
      inheritedProjectionTruncated: true, inherited_projection_truncated: true,
      inheritedProjectionOmittedEvents: inherited.omitted_events, inherited_projection_omitted_events: inherited.omitted_events,
      inheritedProjectionEstimatedTokens: inherited.estimated_tokens, inherited_projection_estimated_tokens: inherited.estimated_tokens,
      inheritedProjectionToSeq: inherited.to_seq, inherited_projection_to_seq: inherited.to_seq,
      inheritedProjectionTokenBudget: budget, inherited_projection_token_budget: budget,
      inheritedProjectionRecordedAt: stored.updatedAt, inherited_projection_recorded_at: stored.updatedAt,
    });
    const after = await app.request(path, { headers });
    expect(after.status).toBe(200);
    const context = await after.json();
    expect(context.inherited_event_count).toBe(24); // Raw parent events before projection truncation.
    expect(context.diagnostics).toEqual({
      task_id: task.id, agent_id: agent.id, to_seq: inherited.to_seq,
      truncated: inherited.truncated, omitted_events: inherited.omitted_events,
      estimated_tokens: inherited.estimated_tokens, token_budget: budget, recorded_at: stored.inheritedProjectionRecordedAt,
    });
  });

  it("persists the model and degradation dependent 40 percent budget with the returned projection", () => {
    const { store, agent, task } = fixture(true);
    store.updateAgent(agent.id, { model: "claude-sonnet-4" });
    db!.run("UPDATE multiremi_tasks SET projection_degrade_level = 2 WHERE id = ?", [task.id]);
    const inherited = store.buildTaskSessionProjection(task.id)!.inheritedSessionProjection!;
    const budget = Math.floor(resolveProjectionTokenBudget({ provider: agent.provider, model: "claude-sonnet-4", degradeLevel: 2 }) * 0.4);
    expect(persistedDiagnostics(task.id)).toEqual({
      inherited_projection_truncated: inherited.truncated ? 1 : 0,
      inherited_projection_omitted_events: inherited.omittedEvents,
      inherited_projection_estimated_tokens: inherited.estimatedTokens,
      inherited_projection_to_seq: inherited.toSeq,
      inherited_projection_token_budget: budget,
      inherited_projection_recorded_at: store.getTask(task.id)!.updatedAt,
    });
  });

  it("returns stored diagnostics without recalculation or adding diagnostics to ordinary Session responses", async () => {
    const { store, agent, issue, parent, side, task, app } = fixture();
    store.buildTaskSessionProjection(task.id);
    const first = await (await app.request(`/api/sessions/${side.id}/inherited-context`, { headers })).json();
    store.appendSessionEvent(parent.id, { authorType: "member", body: "Added after the frozen cutoff" });
    store.updateAgent(agent.id, { model: "gpt-5" });
    const build = spyOn(store, "buildTaskSessionProjection");
    try {
      const read = await app.request(`/api/sessions/${side.id}/inherited-context`, { headers });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(first);
      expect(build).not.toHaveBeenCalled();
      const direct = await (await app.request(`/api/sessions/${side.id}`, { headers })).json();
      const sessions = await (await app.request(`/api/issues/${issue.id}/sessions`, { headers })).json();
      expect(direct).not.toHaveProperty("diagnostics");
      expect(sessions.find((session: { id: string }) => session.id === side.id)).not.toHaveProperty("diagnostics");
    } finally {
      build.mockRestore();
    }
  });

  it("keeps all six fields null for an ordinary task and returns a successful none response", async () => {
    const { store, agent, parent, app } = fixture();
    const task = store.createSessionTask(parent.id, { agentId: agent.id, prompt: "Work without inherited context" });
    expectNullDiagnostics(store, task.id);
    const projection = store.buildTaskSessionProjection(task.id)!;
    expect(projection.inheritedSessionProjection).toBeUndefined();
    expectNullDiagnostics(store, task.id);
    const response = await app.request(`/api/sessions/${parent.id}/inherited-context`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session_id: parent.id, parent_session_id: null, parent_session_title: null,
      inherit_mode: "none", inherit_cutoff_seq: null, inherited_event_count: null, diagnostics: null,
    });
  });

  it("clears old inherited diagnostics when a rebuilt task no longer inherits", async () => {
    const { store, side, task, app } = fixture();
    store.buildTaskSessionProjection(task.id);
    expect(store.getTask(task.id)!.inheritedProjectionTruncated).toBe(false);
    // Inheritance is immutable through the public API; simulate an existing task's repaired Session row.
    db!.run("UPDATE multiremi_issue_sessions SET inherit_mode = 'none', parent_session_id = NULL, inherit_cutoff_seq = NULL WHERE id = ?", [side.id]);
    const response = await app.request(`/api/sessions/${side.id}/inherited-context`, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).diagnostics).toBeNull();
    expect(store.buildTaskSessionProjection(task.id)!.inheritedSessionProjection).toBeUndefined();
    expectNullDiagnostics(store, task.id);
  });

  it("distinguishes an empty inherited snapshot from a task that has no diagnostics", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Empty reader", provider: "claude", workspaceId: "local" });
    const issue = store.createIssue({ title: "Empty snapshot", workspaceId: "local" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: parent.id });
    const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Read" });
    expectNullDiagnostics(store, task.id);
    const projection = store.buildTaskSessionProjection(task.id)!.inheritedSessionProjection!;
    expect(projection.toSeq).toBe(0);
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const response = await app.request(`/api/sessions/${side.id}/inherited-context`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      inherit_mode: "snapshot", inherit_cutoff_seq: 0, inherited_event_count: 0,
      diagnostics: { task_id: task.id, truncated: false, omitted_events: 0, to_seq: 0, estimated_tokens: projection.estimatedTokens },
    });
    expect(store.getTask(task.id)).toMatchObject({ inheritedProjectionTruncated: false, inherited_projection_truncated: false });
  });

  it("selects the latest recorded inherited diagnostics in this Session, skipping newer unclaimed tasks", async () => {
    setSystemTime(new Date("2026-09-17T01:00:00.000Z"));
    const { store, agent, issue, parent, side, task, app } = fixture();
    const secondAgent = store.createAgent({ name: "Second reader", provider: "codex", workspaceId: "local" });
    const second = store.createSessionTask(side.id, { agentId: secondAgent.id, prompt: "Second reader" });
    setSystemTime(new Date("2026-09-17T02:00:00.000Z"));
    store.buildTaskSessionProjection(second.id);
    const recordedAt = "2026-09-17T03:00:00.000Z";
    setSystemTime(new Date(recordedAt));
    const selected = store.buildTaskSessionProjection(task.id)!.inheritedSessionProjection!;
    setSystemTime(new Date("2026-09-17T04:00:00.000Z"));
    const pending = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Not yet claimed" });
    const otherSide = store.createIssueSession(issue.id, { parentSessionId: parent.id });
    const otherTask = store.createSessionTask(otherSide.id, { agentId: agent.id, prompt: "Other Session" });
    store.buildTaskSessionProjection(otherTask.id);
    expectNullDiagnostics(store, pending.id);
    const response = await app.request(`/api/sessions/${side.id}/inherited-context`, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).diagnostics).toMatchObject({
      task_id: task.id, agent_id: agent.id, truncated: selected.truncated,
      estimated_tokens: selected.estimatedTokens, recorded_at: recordedAt,
    });
  });

  it("keeps the latest claim diagnostics when progress advances an earlier task's updated_at", async () => {
    const firstRecordedAt = "2026-09-17T01:00:00.000Z";
    const secondRecordedAt = "2026-09-17T02:00:00.000Z";
    const progressAt = "2026-09-17T03:00:00.000Z";
    setSystemTime(new Date(firstRecordedAt));
    const { store, runtime, side, task: firstTask, app } = fixture(true);
    const firstClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST", headers });
    expect(firstClaim.status).toBe(200);
    const first = (await firstClaim.json()).task;
    expect(first.id).toBe(firstTask.id);
    expect(store.getTask(firstTask.id)!.inheritedProjectionRecordedAt).toBe(firstRecordedAt);

    setSystemTime(new Date(secondRecordedAt));
    const secondRuntime = store.registerRuntime({ name: "Second runtime", provider: "codex", workspaceId: "local" });
    const secondAgent = store.createAgent({ name: "Second reader", provider: "codex", workspaceId: "local", runtimeId: secondRuntime.id });
    const secondTask = store.createSessionTask(side.id, { agentId: secondAgent.id, prompt: "Read with a larger context budget" });
    const secondClaim = await app.request(`/api/daemon/runtimes/${secondRuntime.id}/tasks/claim`, { method: "POST", headers });
    expect(secondClaim.status).toBe(200);
    const second = (await secondClaim.json()).task;
    expect(second.id).toBe(secondTask.id);
    const inherited = second.inherited_session_projection;
    expect(inherited.omitted_events).not.toBe(first.inherited_session_projection.omitted_events);
    expect(inherited.estimated_tokens).not.toBe(first.inherited_session_projection.estimated_tokens);
    const expected = {
      task_id: secondTask.id, agent_id: secondAgent.id, to_seq: inherited.to_seq,
      truncated: inherited.truncated, omitted_events: inherited.omitted_events,
      estimated_tokens: inherited.estimated_tokens,
      token_budget: Math.floor(resolveProjectionTokenBudget({ provider: secondAgent.provider, model: secondAgent.model, degradeLevel: 0 }) * 0.4),
      recorded_at: secondRecordedAt,
    };
    const path = `/api/sessions/${side.id}/inherited-context`;
    expect((await (await app.request(path, { headers })).json()).diagnostics).toEqual(expected);

    setSystemTime(new Date(progressAt));
    const progress = await app.request(`/api/daemon/tasks/${firstTask.id}/progress`, {
      method: "POST", headers, body: JSON.stringify({ summary: "Earlier task is still making progress", step: 1, total: 2 }),
    });
    expect(progress.status).toBe(200);
    const updatedFirst = store.getTask(firstTask.id)!;
    const storedSecond = store.getTask(secondTask.id)!;
    expect(updatedFirst.updatedAt).toBe(progressAt);
    expect(updatedFirst.updatedAt > storedSecond.updatedAt).toBe(true);
    expect(updatedFirst.inheritedProjectionRecordedAt).toBe(firstRecordedAt);
    expect(updatedFirst.inherited_projection_recorded_at).toBe(firstRecordedAt);
    expect(storedSecond.inheritedProjectionRecordedAt).toBe(secondRecordedAt);
    const response = await app.request(path, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).diagnostics).toEqual(expected);
  });

  it("requires authentication and hides other workspaces from both member and task tokens", async () => {
    const { store, issue, side, task, app } = fixture();
    const privateWorkspace = store.createWorkspace({ name: "Private", slug: "private", issuePrefix: "PRI" });
    const privateIssue = store.createIssue({ title: "Hidden issue", workspaceId: privateWorkspace.id });
    const privateParent = store.getOrCreateDefaultIssueSession(privateIssue.id);
    const privateSide = store.createIssueSession(privateIssue.id, { title: "Hidden side", parentSessionId: privateParent.id });
    store.createWorkspaceMember({ workspaceId: issue.workspaceId, userId: "reader", name: "Reader", role: "member" });
    const memberToken = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "reader", userId: "reader" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    expect((await app.request(`/api/sessions/${side.id}/inherited-context`)).status).toBe(401);
    for (const token of [memberToken.token, taskToken.token]) {
      const asReader = { Authorization: `Bearer ${token}` };
      expect((await app.request(`/api/sessions/${side.id}/inherited-context`, { headers: asReader })).status).toBe(200);
      const denied = await app.request(`/api/sessions/${privateSide.id}/inherited-context`, { headers: asReader });
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain("Hidden");
    }
    expect((await app.request("/api/sessions/ises_missing/inherited-context", { headers })).status).toBe(404);
  });
});
