// ADR 0018: the `gc.*` RPCs a daemon calls while it reclaims workspaces.
import { afterEach, describe, expect, it } from "bun:test";
import type { SubjectSnapshot } from "@multiremi/contracts/storage.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { createResponsibleTestAutopilot, createResponsibleTestIssue, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const snapshot: SubjectSnapshot = {
  created_at: "2026-10-13T00:00:00.000Z",
  wiki_files: 2,
  git: [{ repo_url: "https://git.example/acme/repo.git", ref: "refs/remi/snapshots/iss_x/1", commit: "a".repeat(40), head: "b".repeat(40), branch: "agent/MUL-1", dir: "repo" }],
};

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_gc_a1", name: "A claude", provider: "claude", daemonId: "dmn_gc_a", workspaceId: "local" });
  const sibling = store.registerRuntime({ id: "rt_gc_a2", name: "A codex", provider: "codex", daemonId: "dmn_gc_a", workspaceId: "local" });
  const foreign = store.registerRuntime({ id: "rt_gc_b", name: "B", provider: "claude", daemonId: "dmn_gc_b", workspaceId: "local" });
  const agent = store.createAgent({ name: "GC agent", provider: "claude", workspaceId: "local" });
  const call = (type: string, payload: Record<string, unknown>, runtimeId = runtime.id) =>
    reportFrame(store, type, { runtime_id: runtimeId, ...payload }, { runtimeId });
  return { store, runtime, sibling, foreign, agent, call };
}

function liveLane(sessionId: string, agentId: string, runtimeId: string, generation = 1, scope = "") {
  db!.run(
    `INSERT INTO multiremi_session_lanes (session_id, reader_type, reader_id, execution_scope, provider_session_id, runtime_id, provider,
       work_dir, execution_fingerprint, provider_cursor_seq, parent_cursor_seq, generation, last_attempt_id, created_at, updated_at)
     VALUES (?, 'agent', ?, ?, 'native-session', ?, 'claude', '/work', 'fp', 9, 4, ?, 'tsk_last', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    [sessionId, agentId, scope, runtimeId, generation],
  );
}

const laneOf = (sessionId: string, agentId: string, scope = "") => db!.query(
  `SELECT provider_session_id, runtime_id, provider, work_dir, execution_fingerprint, provider_cursor_seq, parent_cursor_seq, generation, last_attempt_id
   FROM multiremi_session_lanes WHERE session_id = ? AND reader_type = 'agent' AND reader_id = ? AND execution_scope = ?`,
).get(sessionId, agentId, scope) as Record<string, unknown>;

const RESET_LANE = {
  provider_session_id: null, runtime_id: null, provider: null, work_dir: null, execution_fingerprint: null,
  provider_cursor_seq: 0, parent_cursor_seq: 0, last_attempt_id: null,
};

describe("gc checks", () => {
  it("reports an Issue as active while a task runs and as its status afterwards", async () => {
    const { store, agent, call } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "GC check", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(await call("gc.check_issue", { issue_id: issue.id })).toMatchObject({ ok: true, status: "active" });
    store.cancelTask(task.id);
    expect(await call("gc.check_issue", { issue_id: issue.id })).toMatchObject({ ok: true, status: issue.status, updated_at: expect.any(String) });
    expect(await call("gc.check_issue", { issue_id: "iss_missing" })).toMatchObject({ ok: false, code: "task_not_found" });
  });

  it("answers moved for an Issue this daemon held that now lives in another workspace, and 404 for any other", async () => {
    const { store, runtime, foreign, agent, call } = fixture();
    const held = createResponsibleTestIssue(store, { title: "Moved", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: held.id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.cancelTask(task.id);
    const stranger = createResponsibleTestIssue(store, { title: "Not ours", workspaceId: "local" });
    db!.run("UPDATE multiremi_issues SET workspace_id = 'other' WHERE id IN (?, ?)", [held.id, stranger.id]);
    expect(await call("gc.check_issue", { issue_id: held.id })).toEqual({ ok: true, status: "moved" });
    expect(await call("gc.check_issue", { issue_id: held.key })).toMatchObject({ ok: false, code: "task_not_found" });
    expect(await call("gc.check_issue", { issue_id: stranger.id })).toMatchObject({ ok: false, code: "task_not_found" });
    expect(await call("gc.check_issue", { issue_id: held.id }, foreign.id)).toMatchObject({ ok: false, code: "task_not_found" });
  });

  it("reports a Chat's pin, origin and last activity", async () => {
    const { store, agent, call } = fixture();
    const chat = store.createChatSession({ agentId: agent.id, title: "Plain chat", workspaceId: "local" });
    expect(await call("gc.check_chat_session", { session_id: chat.id })).toEqual({
      ok: true, status: "active", updated_at: store.getChatSession(chat.id)!.updatedAt, pinned: false, origin: null, last_activity_at: null,
    });

    store.sendChatMessage(chat.id, { body: "Hello" });
    store.updateChatSession(chat.id, { pinned: true, status: "archived" });
    db!.run("UPDATE multiremi_chat_sessions SET origin_autopilot_id = 'ap_1', origin_run_id = 'run_1' WHERE id = ?", [chat.id]);
    expect(await call("gc.check_chat_session", { session_id: chat.id })).toMatchObject({
      ok: true, status: "archived", pinned: true, origin: { autopilot_id: "ap_1", run_id: "run_1" },
      last_activity_at: store.getChatSession(chat.id)!.lastMessage!.createdAt,
    });
    expect(await call("gc.check_chat_session", { session_id: "chat_missing" })).toMatchObject({ ok: false, code: "task_not_found" });
  });

  it("reports the automation run that opened a Chat as its origin", async () => {
    const { store, agent, call } = fixture();
    const autopilot = createResponsibleTestAutopilot(store, { title: "Digest", assigneeId: agent.id, executionMode: "run_only", workspaceId: "local" });
    const run = store.runAutopilot(autopilot.id);
    expect(await call("gc.check_chat_session", { session_id: run.chatSessionId })).toMatchObject({
      ok: true, status: "active", origin: { autopilot_id: autopilot.id, run_id: run.id },
    });
  });

  it("answers for a task of the reporting runtime only, and no longer knows autopilot runs or workspace_cleaned", async () => {
    const { store, agent, runtime, foreign, call } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "check" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(await call("gc.check_task", { task_id: task.id })).toMatchObject({ ok: true, status: expect.any(String) });
    expect(await call("gc.check_task", { task_id: task.id }, foreign.id)).toMatchObject({ ok: false, code: "task_not_found" });
    for (const type of ["gc.check_autopilot_run", "gc.workspace_cleaned"]) {
      await expect(call(type, { run_id: "run_1" })).rejects.toThrow();
    }
  });
});

describe("gc.subject_reclaimed", () => {
  it("marks the Issue workspace cleaned with its snapshot and resets this daemon's lanes of the Issue only", async () => {
    const { store, agent, runtime, sibling, foreign, call } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Reclaim me", workspaceId: "local" });
    const other = createResponsibleTestIssue(store, { title: "Keep me", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: "/work/issue", branchName: `agent/${issue.key}`, status: "ready",
      repos: [{ repoUrl: "u", repoName: "repo", worktreePath: "/work/issue/repo", branchName: `agent/${issue.key}`, baseRef: "main", baseCommit: null, status: "ready", dirty: true, error: null }] });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const discussion = store.createIssueSession(issue.id, { title: "Discussion" });
    const otherSession = store.getOrCreateDefaultIssueSession(other.id);
    liveLane(main.id, agent.id, runtime.id, 2);
    liveLane(discussion.id, agent.id, sibling.id, 5);
    liveLane(otherSession.id, agent.id, runtime.id, 3);
    const foreignAgent = store.createAgent({ name: "Foreign lane", provider: "claude", workspaceId: "local" });
    liveLane(main.id, foreignAgent.id, foreign.id, 4);
    liveLane(main.id, agent.id, runtime.id, 1, "dlg_scope");
    const memberLanes = db!.query("SELECT * FROM multiremi_session_lanes WHERE reader_type = 'member'").all();

    const reply = await call("gc.subject_reclaimed", { subject: { kind: "issue", id: issue.id }, snapshot, unsaved_work: true, freed_bytes: 4096 });
    expect(reply).toEqual({ ok: true });

    expect(store.getIssueWorkspace(issue.id)).toMatchObject({
      status: "cleaned", repos: [], cleanedAt: expect.any(String), snapshot, snapshotAt: expect.any(String), unsavedWork: true,
    });
    expect(laneOf(main.id, agent.id)).toMatchObject({ ...RESET_LANE, generation: 3 });
    expect(laneOf(main.id, agent.id, "dlg_scope")).toMatchObject({ ...RESET_LANE, generation: 2 });
    expect(laneOf(discussion.id, agent.id)).toMatchObject({ ...RESET_LANE, generation: 6 });
    expect(laneOf(otherSession.id, agent.id)).toMatchObject({ provider_session_id: "native-session", runtime_id: runtime.id, generation: 3 });
    expect(laneOf(main.id, foreignAgent.id)).toMatchObject({ provider_session_id: "native-session", runtime_id: foreign.id, generation: 4 });
    expect(db!.query("SELECT * FROM multiremi_session_lanes WHERE reader_type = 'member'").all()).toEqual(memberLanes);

    // A replay resets nothing twice: the lanes are already cold.
    await call("gc.subject_reclaimed", { subject: { kind: "issue", id: issue.id }, snapshot: null, unsaved_work: false, freed_bytes: 0 });
    expect(laneOf(main.id, agent.id)).toMatchObject({ generation: 3 });
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ status: "cleaned", snapshot: null, snapshotAt: null, unsavedWork: false });
  });

  it("keeps the place of a repository an agent made below the work directory, and refuses an entry with a malformed or missing place", async () => {
    const { store, runtime, call } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Nested repository", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: "/work/nested", branchName: `agent/${issue.key}`, status: "in_use" });
    const nested: SubjectSnapshot = { ...snapshot, git: [{ ...snapshot.git[0]!, dir: "tools/helper" }, { ...snapshot.git[0]!, ref: "refs/remi/snapshots/iss_x/2", dir: "." }] };

    expect(await call("gc.subject_reclaimed", { subject: { kind: "issue", id: issue.id }, snapshot: nested, unsaved_work: true, freed_bytes: 1 })).toEqual({ ok: true });
    expect(store.getIssueWorkspace(issue.id)?.snapshot).toEqual(nested);

    const malformed = { ...snapshot, git: [{ ...snapshot.git[0]!, dir: 7 }] };
    expect(await call("gc.subject_reclaimed", { subject: { kind: "issue", id: issue.id }, snapshot: malformed, unsaved_work: true, freed_bytes: 1 }))
      .toMatchObject({ ok: false, code: "invalid_report" });

    // Every entry says where its worktree stood: restore finds it by that alone.
    const { dir: _dir, ...withoutPlace } = snapshot.git[0]!;
    expect(await call("gc.subject_reclaimed", { subject: { kind: "issue", id: issue.id }, snapshot: { ...snapshot, git: [withoutPlace] }, unsaved_work: true, freed_bytes: 1 }))
      .toMatchObject({ ok: false, code: "invalid_report" });
  });

  it("answers ok for an Issue the control plane holds no workspace record of, and ignores a record of another daemon", async () => {
    const { store, runtime, foreign, call } = fixture();
    const bare = createResponsibleTestIssue(store, { title: "Never materialized", workspaceId: "local" });
    expect(await call("gc.subject_reclaimed", { subject: { kind: "issue", id: bare.id }, snapshot: null, unsaved_work: false, freed_bytes: 0 })).toEqual({ ok: true });
    expect(store.getIssueWorkspace(bare.id)).toBeNull();

    const issue = createResponsibleTestIssue(store, { title: "Elsewhere", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: foreign.id, rootPath: "/work/elsewhere", branchName: `agent/${issue.key}`, status: "in_use" });
    expect(await call("gc.subject_reclaimed", { subject: { kind: "issue", id: issue.id }, snapshot, unsaved_work: true, freed_bytes: 1 }, runtime.id))
      .toEqual({ ok: true });
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ status: "in_use", runtimeId: foreign.id, snapshot: null });
  });

  it("clears a Chat's native session on this daemon and resets its lanes", async () => {
    const { store, agent, runtime, sibling, foreign, call } = fixture();
    const chat = store.createChatSession({ agentId: agent.id, title: "Reclaimed chat", workspaceId: "local" });
    const kept = store.createChatSession({ agentId: agent.id, title: "Other daemon", workspaceId: "local" });
    const pin = (id: string, runtimeId: string) => db!.run(
      `UPDATE multiremi_chat_sessions SET session_id = 'native', work_dir = '/w', session_runtime_id = ?, session_provider = 'claude',
         session_execution_fingerprint = 'fp' WHERE id = ?`, [runtimeId, id]);
    pin(chat.id, sibling.id);
    pin(kept.id, foreign.id);
    liveLane(chat.id, agent.id, runtime.id, 2);
    liveLane(kept.id, agent.id, foreign.id, 2);

    expect(await call("gc.subject_reclaimed", { subject: { kind: "chat", id: chat.id }, snapshot, unsaved_work: false, freed_bytes: 10 })).toEqual({ ok: true });
    expect(db!.query("SELECT session_id, work_dir, session_runtime_id, session_provider, session_execution_fingerprint FROM multiremi_chat_sessions WHERE id = ?").get(chat.id))
      .toEqual({ session_id: null, work_dir: null, session_runtime_id: null, session_provider: null, session_execution_fingerprint: null });
    expect(laneOf(chat.id, agent.id)).toMatchObject({ ...RESET_LANE, generation: 3 });

    expect(await call("gc.subject_reclaimed", { subject: { kind: "chat", id: kept.id }, snapshot: null, unsaved_work: false, freed_bytes: 0 })).toEqual({ ok: true });
    expect(db!.query("SELECT session_id, session_runtime_id FROM multiremi_chat_sessions WHERE id = ?").get(kept.id))
      .toEqual({ session_id: "native", session_runtime_id: foreign.id });
    expect(laneOf(kept.id, agent.id)).toMatchObject({ provider_session_id: "native-session", generation: 2 });
  });

  it("accepts a fallback task subject without changing anything", async () => {
    const { store, agent, runtime, call } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "lone" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const before = db!.query("SELECT COUNT(*) AS count FROM multiremi_session_lanes").get();
    expect(await call("gc.subject_reclaimed", { subject: { kind: "task", id: task.id }, snapshot: null, unsaved_work: false, freed_bytes: 0 })).toEqual({ ok: true });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_session_lanes").get()).toEqual(before);
  });

  it("rejects a malformed report and a subject that is not in the runtime's workspace", async () => {
    const { store, call } = fixture();
    const outside = store.createWorkspace({ id: "wss_gc_outside", name: "Outside", slug: "gc-outside", issuePrefix: "GO" });
    const foreignIssue = createResponsibleTestIssue(store, { title: "Not yours", workspaceId: outside.id });
    const issue = createResponsibleTestIssue(store, { title: "Yours", workspaceId: "local" });
    const base = { snapshot: null, unsaved_work: false, freed_bytes: 0 };
    expect(await call("gc.subject_reclaimed", { subject: { kind: "issue", id: foreignIssue.id }, ...base }))
      .toMatchObject({ ok: false, code: "task_not_found", operation_error: { status: 404, code: "issue_not_found" } });
    expect(await call("gc.subject_reclaimed", { subject: { kind: "chat", id: "chat_missing" }, ...base })).toMatchObject({ ok: false, code: "task_not_found" });
    expect(await call("gc.subject_reclaimed", { subject: { kind: "task", id: "tsk_missing" }, ...base })).toMatchObject({ ok: false, code: "task_not_found" });
    for (const bad of [
      { subject: { kind: "workspace", id: issue.id } },
      { subject: { kind: "issue", id: "" } },
      { subject: null },
      { subject: { kind: "issue", id: issue.id }, snapshot: { created_at: 1, git: [], wiki_files: 0 } },
      { subject: { kind: "issue", id: issue.id }, snapshot: { created_at: "x", git: [{ repo_url: "u" }], wiki_files: 0 } },
      { subject: { kind: "issue", id: issue.id }, unsaved_work: "yes" },
    ]) {
      expect(await call("gc.subject_reclaimed", { ...base, ...bad })).toMatchObject({ ok: false, code: "invalid_report" });
    }
  });
});
