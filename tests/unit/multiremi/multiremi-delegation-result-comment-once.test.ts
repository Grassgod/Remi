/**
 * MUL-456 fix round 1, blocker 2: the terminal transaction resolves the result
 * comment exactly once.
 *
 * QA round 1 injected a later task comment between the bridge-metadata read
 * (`tasks-repo.ts` result_comment_id) and the prompt read and observed two
 * different ids committed in the same transaction. The fix resolves the value
 * once and hands it to the drain; this suite counts the SELECTs on the real
 * terminal path and asserts that bridge metadata and prompt agree.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";
import { reportFrame } from "../../fixtures/report-session.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

/** The PG fixture creates and drops a database per case; see the sibling suite. */
const PG_TEST_TIMEOUT = 30_000;

const RESULT_COMMENT_SELECT = "SELECT id FROM multiremi_issue_comments";

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = new Database(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      await run(store);
    } finally {
      db.close();
    }
    return;
  }
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `mul456f1r_${process.pid}_${++sequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let db: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await run(store);
  } finally {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function fixture(store: MultiremiStore, daemonId?: string) {
  const runtimeIdentity = daemonId
    ? { daemonId, ownerId: "local", metadata: { parallel_agent_execution: 1 } }
    : {};
  const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local",
    ...runtimeIdentity });
  const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "claude", workspaceId: "local",
    ...runtimeIdentity });
  const leader = store.createAgent({ name: "Leader", provider: "claude", runtimeId: leaderRuntime.id });
  const worker = store.createAgent({ name: "Worker", provider: "claude", runtimeId: workerRuntime.id });
  const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [worker.id] });
  const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress",
    assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "result-comment-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request("/api/multiremi/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, issueId: issue.id, prompt: "Execute delegated work." }),
  });
  expect(response.status).toBe(201);
  return store.getTask(((await response.json()) as { task: { id: string } }).task.id)!;
}

function finishLeaderRound(store: MultiremiStore, f: ReturnType<typeof fixture>): void {
  expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
  store.buildTaskSessionProjection(f.leaderTask.id);
  store.startTask(f.leaderTask.id);
  store.completeTask(f.leaderTask.id, { output: "Task completed." });
}

/**
 * Wrap the store's db handle so the terminal path's comment SELECTs are counted
 * and a later comment is injected the moment the first one has resolved.
 *
 * Injecting *after* the first read returns is what makes the mismatch visible:
 * the bridge metadata has already captured comment A, and a second read (the
 * shape QA measured) would see the newly written comment B. With the fix the
 * second read never happens, so bridge and prompt both stay on A.
 */
function instrumentDb(store: MultiremiStore, onFirstResultCommentSelect: () => void) {
  const db = (store as unknown as {
    ctx: { db: { query: (sql: string) => Record<string, unknown> } };
  }).ctx.db;
  const original = db.query.bind(db);
  let selects = 0;
  db.query = (sql: string) => {
    const statement = original(sql);
    if (!sql.includes(RESULT_COMMENT_SELECT)) return statement;
    selects += 1;
    if (selects !== 1) return statement;
    // Call through the original statement object: bun:sqlite's `get` reads
    // `this` internally.
    const boundGet = (...params: unknown[]) => (statement.get as (...params: unknown[]) => unknown)(...params);
    return {
      ...statement,
      get: (...params: unknown[]) => {
        const row = boundGet(...params);
        onFirstResultCommentSelect();
        return row;
      },
    };
  };
  return { count: () => selects };
}

/** A single raw comment INSERT, so the injection adds no nested transaction. */
function insertRawComment(db: { run: (sql: string, ...p: unknown[]) => unknown }, input: {
  id: string; issueId: string; issueSessionId: string; taskId: string; authorType: string;
  authorId: string; body: string; createdAt: string;
}): void {
  db.run(
    `INSERT INTO multiremi_issue_comments (
       id, issue_id, issue_session_id, author_type, author_id, task_id, parent_id, body, type, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'comment', ?, ?)`,
    [input.id, input.issueId, input.issueSessionId, input.authorType, input.authorId, input.taskId,
      input.body, input.createdAt, input.createdAt],
  );
}

/** The store's raw db handle, reached the same way the injector reaches it. */
function rawDb(store: MultiremiStore) {
  return (store as unknown as { ctx: { db: { run: (sql: string, ...p: unknown[]) => unknown } } }).ctx.db;
}

function countResultCommentSelectsForTask(store: MultiremiStore, taskId: string) {
  const db = (store as unknown as {
    ctx: { db: { query: (sql: string) => Record<string, unknown> } };
  }).ctx.db;
  const original = db.query.bind(db);
  let selects = 0;
  db.query = (sql: string) => {
    const statement = original(sql);
    if (!sql.includes(RESULT_COMMENT_SELECT)) return statement;
    const get = (statement.get as (...params: unknown[]) => unknown).bind(statement);
    return {
      ...statement,
      get: (...params: unknown[]) => {
        if (params.includes(taskId)) selects += 1;
        return get(...params);
      },
    };
  };
  return { count: () => selects };
}

async function requestJson(
  base: string,
  path: string,
  token: string,
  body: Record<string, unknown> = {},
  expected = 200,
  method = "POST",
): Promise<Record<string, any>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status).toBe(expected);
  return text ? JSON.parse(text) as Record<string, any> : {};
}

async function withHttpApi(
  store: MultiremiStore,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = createMultiremiApp({ store, authToken: "result-comment-http-root" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

async function httpCredentials(store: MultiremiStore, daemonId: string) {
  const user = store.getOrCreateUser({ email: `${daemonId}@example.test`, name: "Snapshot member" });
  store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, role: "member" });
  const member = await store.createAccessToken({ workspaceId: "local", userId: user.id,
    name: "Snapshot member", type: "pat", purpose: "cli" });
  const daemon = await store.createAccessToken({ workspaceId: "local", userId: "local",
    name: "Snapshot daemon", type: "daemon", purpose: "daemon", daemonId });
  return { member: member.token, daemon: daemon.token };
}

async function startThroughDaemon(
  base: string,
  store: MultiremiStore,
  daemonToken: string,
  task: MultiremiTask,
  runtimeId: string,
): Promise<void> {
  const claimed = await requestJson(base, `/api/daemon/runtimes/${runtimeId}/tasks/claim`, daemonToken);
  expect(claimed.task.id).toBe(task.id);
  await reportThroughDaemon(store, daemonToken, task.id, "start");
}

async function reportThroughDaemon(store: MultiremiStore, token: string, taskId: string,
  type: "start" | "complete", body: Record<string, unknown> = {}): Promise<void> {
  const reply = await reportFrame(store, `task.${type}`, { task_id: taskId, ...body }, {
    headers: { Authorization: `Bearer ${token}` }, authToken: "result-comment-http-root",
  });
  expect(reply.ok).toBe(true);
}

async function dispatchThroughHttp(
  base: string,
  store: MultiremiStore,
  source: MultiremiTask,
  issue: MultiremiIssue,
  agentId: string,
): Promise<MultiremiTask> {
  const token = await store.createTaskAccessToken(source, "local");
  const created = await requestJson(base, "/api/multiremi/tasks", token.token, {
    agentId,
    issueId: issue.id,
    prompt: "Execute delegated work over HTTP.",
  }, 201);
  return store.getTask(created.task.id)!;
}

async function runCancelledReturnSnapshotCase(
  store: MultiremiStore,
  withInRunComment: boolean,
): Promise<void> {
  const daemonId = `mul456-f2-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const childTask = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched the work." });
    await startThroughDaemon(base, store, credentials.daemon, childTask, f.workerRuntime.id);

    let inRunCommentId: string | null = null;
    if (withInRunComment) {
      const taskToken = await store.createTaskAccessToken(childTask, "local");
      const posted = await requestJson(base, `/api/multiremi/issues/${f.child.id}/comments`, taskToken.token,
        { body: "In-run result A", issue_session_id: childTask.issueSessionId }, 201);
      inRunCommentId = posted.comment.id;
      // Keep A as a real HTTP-created task comment while placing it before the
      // dispatch boundary. This makes the normal post-commit auto reply C run,
      // reproducing QA's A -> C ordering without inserting a synthetic comment.
      const dispatchedAt = store.getTask(childTask.id)!.dispatchedAt!;
      const beforeDispatch = new Date(Date.parse(dispatchedAt) - 1_000).toISOString();
      rawDb(store).run(
        "UPDATE multiremi_issue_comments SET created_at = ?, updated_at = ? WHERE id = ?",
        [beforeDispatch, beforeDispatch, inRunCommentId],
      );
    }

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });

    const sourceAfterCompletion = store.getTask(childTask.id)!;
    const firstReturn = store.getTask(sourceAfterCompletion.delegationReturnTaskId!)!;
    const bridge = () => store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
    const bridgeBeforeCancel = JSON.stringify(bridge());
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id && comment.id !== inRunCommentId);
    expect(automaticComment).toBeDefined();
    expect(selects.count()).toBe(1);
    expect((bridge().metadata as Record<string, unknown>).result_comment_id).toBe(inRunCommentId);
    expect(firstReturn.prompt).toContain(inRunCommentId
      ? `Result comment: ${inRunCommentId}`
      : "Result comment: none at completion");

    await requestJson(base, `/api/tasks/${firstReturn.id}/cancel`, credentials.member);
    const sourceAfterCancel = store.getTask(childTask.id)!;
    const replacement = store.getTask(sourceAfterCancel.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(firstReturn.id);
    expect(replacement.prompt).toContain(inRunCommentId
      ? `Result comment: ${inRunCommentId}`
      : "Result comment: none at completion");
    expect(replacement.prompt).not.toContain(`Result comment: ${automaticComment!.id}`);
    expect((bridge().metadata as Record<string, unknown>).result_comment_id).toBe(inRunCommentId);
    expect(JSON.stringify(bridge())).toBe(bridgeBeforeCancel);
    expect(selects.count()).toBe(1);
  });
}

async function runCancelledE2SnapshotCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f2-e2-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const childTask = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched the work." });
    await startThroughDaemon(base, store, credentials.daemon, childTask, f.workerRuntime.id);

    const taskToken = await store.createTaskAccessToken(childTask, "local");
    await requestJson(base, `/api/multiremi/issues/${f.child.id}`, taskToken.token,
      { status: "done" }, 200, "PATCH");
    const e2Round = store.listTasksForIssue(f.parent.id)
      .find((task) => task.status === "queued" && task.wakeSource === "child_status")!;
    expect(e2Round).toBeDefined();

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });
    expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(e2Round.id);
    const bridge = () => store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
    const bridgeBeforeCancel = JSON.stringify(bridge());
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id)!;
    expect(automaticComment).toBeDefined();
    expect((bridge().metadata as Record<string, unknown>).result_comment_id).toBeNull();
    expect(selects.count()).toBe(1);

    await requestJson(base, `/api/tasks/${e2Round.id}/cancel`, credentials.member);
    const replacement = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(e2Round.id);
    expect(replacement.prompt).toContain("Result comment: none at completion");
    expect(replacement.prompt).not.toContain(`Result comment: ${automaticComment.id}`);
    expect(JSON.stringify(bridge())).toBe(bridgeBeforeCancel);
    expect(selects.count()).toBe(1);
  });
}

async function runMissingSnapshotCompatibilityCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f2-legacy-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const childTask = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched the work." });
    await startThroughDaemon(base, store, credentials.daemon, childTask, f.workerRuntime.id);

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });
    const source = store.getTask(childTask.id)!;
    const firstReturn = store.getTask(source.delegationReturnTaskId!)!;
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id)!;
    const bridge = store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
    expect(selects.count()).toBe(1);

    // Simulate a pre-contract bridge that has no snapshot key at all. This is
    // deliberately different from the current event's explicit null.
    rawDb(store).run("UPDATE multiremi_session_events SET metadata = ? WHERE id = ?", [
      JSON.stringify({ source_task_id: childTask.id }), bridge.id,
    ]);
    await requestJson(base, `/api/tasks/${firstReturn.id}/cancel`, credentials.member);
    const replacement = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(replacement.prompt).toContain(`Result comment: ${automaticComment.id}`);
    expect(selects.count()).toBe(2);
  });
}

async function runRedispatchThenDrainSnapshotCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f2-redispatch-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const first = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    const second = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched both tasks." });

    await startThroughDaemon(base, store, credentials.daemon, first, f.workerRuntime.id);
    const firstSelects = countResultCommentSelectsForTask(store, first.id);
    await reportThroughDaemon(store, credentials.daemon, first.id, "complete",
      { output: "First automatic result C1" });
    const originalReturn = store.getTask(store.getTask(first.id)!.delegationReturnTaskId!)!;
    const firstAutomaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === first.id)!;
    expect(firstSelects.count()).toBe(1);

    store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
    const supervisor = store.createAgent({ name: "Snapshot supervisor", provider: "claude", role: "supervisor" });
    store.setAgentSupervisor(supervisor.id, true);
    const patrol = store.createIssue({ title: "Snapshot patrol", status: "in_progress" });
    const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "Supervise." });
    const supervisorToken = await store.createTaskAccessToken(supervisorTask, "local");
    const redispatched = await requestJson(base, `/api/tasks/${originalReturn.id}/redispatch`,
      supervisorToken.token, { reason: "Rebuild the unclaimed return." }, 202);
    const replacement = store.getTask(redispatched.replacement_task.id)!;
    expect(replacement.id).not.toBe(originalReturn.id);
    expect(store.getTask(first.id)?.delegationReturnTaskId).toBeNull();

    await startThroughDaemon(base, store, credentials.daemon, second, f.workerRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, second.id, "complete",
      { output: "Second automatic result C2" });
    expect(store.getTask(first.id)?.delegationReturnTaskId).toBe(replacement.id);
    expect(replacement.prompt).not.toContain(`Result comment: ${firstAutomaticComment.id}`);
    expect(store.getTask(replacement.id)!.prompt).not.toContain(`Result comment: ${firstAutomaticComment.id}`);
    expect(store.getTask(replacement.id)!.prompt).toContain("Result comment: none at completion");
    expect(firstSelects.count()).toBe(1);
  });
}

async function runSkippedManualWakeCancellationSnapshotCase(
  store: MultiremiStore,
  withInRunComment: boolean,
): Promise<void> {
  const daemonId = `mul456-f3-skip-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const childTask = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched the work." });
    await startThroughDaemon(base, store, credentials.daemon, childTask, f.workerRuntime.id);

    let inRunCommentId: string | null = null;
    const childToken = await store.createTaskAccessToken(childTask, "local");
    if (withInRunComment) {
      const posted = await requestJson(base, `/api/multiremi/issues/${f.child.id}/comments`, childToken.token,
        { body: "In-run result A", issue_session_id: childTask.issueSessionId }, 201);
      inRunCommentId = posted.comment.id;
      const beforeDispatch = new Date(Date.parse(store.getTask(childTask.id)!.dispatchedAt!) - 1_000).toISOString();
      rawDb(store).run(
        "UPDATE multiremi_issue_comments SET created_at = ?, updated_at = ? WHERE id = ?",
        [beforeDispatch, beforeDispatch, inRunCommentId],
      );
    }
    const manualResponse = await requestJson(base, "/api/multiremi/tasks", childToken.token, {
      agentId: f.leader.id,
      issueId: f.parent.id,
      issueSessionId: f.leaderSession.id,
      prompt: "Manual wake through the generic task endpoint.",
    }, 201);
    const manual = store.getTask(manualResponse.task.id)!;
    expect(manual.parentTaskId).toBe(childTask.id);
    expect(manual.delegationSkipReason).toBe("source_not_squad_leader");

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });
    expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(manual.id);
    const bridge = () => store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
    const bridgeBeforeCancel = JSON.stringify(bridge());
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id && comment.id !== inRunCommentId)!;
    expect(selects.count()).toBe(1);
    expect((bridge().metadata as Record<string, unknown>).result_comment_id).toBe(inRunCommentId);

    await requestJson(base, `/api/tasks/${manual.id}/cancel`, credentials.member);
    const replacement = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(manual.id);
    expect(replacement.prompt).toContain(inRunCommentId
      ? `Result comment: ${inRunCommentId}`
      : "Result comment: none at completion");
    expect(replacement.prompt).not.toContain(`Result comment: ${automaticComment.id}`);
    expect(JSON.stringify(bridge())).toBe(bridgeBeforeCancel);
    expect(selects.count()).toBe(1);
    expect(store.listIssueActivity(f.parent.id).some((activity) =>
      activity.type === "delegation_return_skipped"
      && (activity.data as Record<string, unknown>).sourceTaskId === manual.id
      && (activity.data as Record<string, unknown>).reason === "source_not_squad_leader"
    )).toBe(true);
  });
}

async function runSameIssueResultCommentParityCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f3-same-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const delegated = await dispatchThroughHttp(base, store, f.leaderTask, f.parent, f.worker.id);
    expect(delegated.issueSessionId).toBe(f.leaderSession.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched the work." });
    await startThroughDaemon(base, store, credentials.daemon, delegated, f.workerRuntime.id);

    const selects = countResultCommentSelectsForTask(store, delegated.id);
    await reportThroughDaemon(store, credentials.daemon, delegated.id, "complete",
      { output: "Same-issue terminal result." });
    const firstReturn = store.getTask(store.getTask(delegated.id)!.delegationReturnTaskId!)!;
    const expectedPrompt = [
      "Worker completed a task you delegated.",
      "Read the latest Session Updates and terminal reports, then continue owning the parent task.",
      "Treat this as one result in the current round. Check the latest Session Updates or `remi context` for other delegated tasks that are still queued or running.",
      "If delegated tasks remain active, continue coordinating and report only meaningful progress, blockers, or decisions needed from the user; do not publish the round delivery summary yet.",
      "Once every delegated task in the current round is completed, failed, or cancelled, validate the combined result and publish one round delivery summary. A later user follow-up starts a new round and may have its own summary.",
      "Do not repeat work that the teammate already completed.",
      "",
      "## Terminal Report: Worker",
      `Source task: ${delegated.id}`,
      "Status: completed",
      `Delegation: ${delegated.delegationId}`,
      "",
      "Same-issue terminal result.",
    ].join("\n");
    expect(firstReturn.prompt).toBe(expectedPrompt);
    expect(firstReturn.prompt).not.toContain("Result comment:");
    expect(firstReturn.prompt).not.toContain("Issue:");
    expect(selects.count()).toBe(0);
    expect(store.listSessionEvents(f.leaderSession.id)
      .filter((event) => event.kind === "delegation_report" && event.taskId === delegated.id)).toHaveLength(0);

    await requestJson(base, `/api/tasks/${firstReturn.id}/cancel`, credentials.member);
    const replacement = store.getTask(store.getTask(delegated.id)!.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(firstReturn.id);
    expect(replacement.prompt).toBe(expectedPrompt);
    expect(replacement.prompt).not.toContain("Result comment:");
    expect(selects.count()).toBe(0);
  });
}

async function runDelegateWakeupCoverageStillDrainsHistoryCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f3-covered-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const historical = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    const trigger = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched two tasks." });
    await startThroughDaemon(base, store, credentials.daemon, historical, f.workerRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, historical.id, "complete",
      { output: "Historical report." });
    const firstReturn = store.getTask(store.getTask(historical.id)!.delegationReturnTaskId!)!;

    store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
    const supervisor = store.createAgent({ name: "Drain supervisor", provider: "claude", role: "supervisor" });
    store.setAgentSupervisor(supervisor.id, true);
    const patrol = store.createIssue({ title: "Drain patrol", status: "in_progress" });
    const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "Supervise." });
    const supervisorToken = await store.createTaskAccessToken(supervisorTask, "local");
    const redispatched = await requestJson(base, `/api/tasks/${firstReturn.id}/redispatch`,
      supervisorToken.token, { reason: "Leave the historical report for the next common drain." }, 202);
    const replacement = store.getTask(redispatched.replacement_task.id)!;
    expect(store.getTask(historical.id)?.delegationReturnTaskId).toBeNull();

    await startThroughDaemon(base, store, credentials.daemon, trigger, f.workerRuntime.id);
    const triggerToken = await store.createTaskAccessToken(trigger, "local");
    const response = await requestJson(base, "/api/multiremi/tasks", triggerToken.token, {
      agentId: f.leader.id,
      issueId: f.parent.id,
      issueSessionId: f.leaderSession.id,
      prompt: "Manual wake for the current delegated task.",
    }, 201);
    const coveringTask = store.getTask(response.task.id)!;

    await reportThroughDaemon(store, credentials.daemon, trigger.id, "complete",
      { output: "Trigger report." });
    expect(store.getTask(trigger.id)?.delegationReturnTaskId).toBe(coveringTask.id);
    expect(store.getTask(historical.id)?.delegationReturnTaskId).toBe(replacement.id);
    expect(store.listIssueActivity(f.child.id).some((activity) =>
      activity.type === "delegation_return_skipped"
      && (activity.data as Record<string, unknown>).sourceTaskId === trigger.id
      && (activity.data as Record<string, unknown>).reason === "covered_by_delegate_wakeup"
    )).toBe(true);
  });
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-456 result comment resolved once (${backend})`, () => {
    it("uses one id for the bridge metadata and the prompt even when a later comment lands mid-transaction", async () => {
      await withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        finishLeaderRound(store, f);
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        const first = store.createIssueComment(f.child.id, {
          authorType: "agent", authorId: f.worker.id, taskId: childTask.id,
          issueSessionId: childTask.issueSessionId, body: "First result",
        });
        // Two comments exist before the terminal transaction — the second is the
        // newest. Comments do not take the workspace lifecycle lock, so the
        // mid-transaction write installed below is a real concurrent
        // interleaving, not a test-only state.
        const later = store.createIssueComment(f.child.id, {
          authorType: "agent", authorId: f.worker.id, taskId: childTask.id,
          issueSessionId: childTask.issueSessionId, body: "Later result",
        });
        const injectedAt = new Date(Date.now() + 1000).toISOString();
        const injector = instrumentDb(store, () => {
          insertRawComment(rawDb(store), {
            id: "cmt_injected_mid_transaction",
            issueId: f.child.id,
            issueSessionId: childTask.issueSessionId!,
            taskId: childTask.id,
            authorType: "agent",
            authorId: f.worker.id,
            body: "Injected mid-transaction",
            createdAt: injectedAt,
          });
        });
        store.completeTask(childTask.id, { output: "Final result" });
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id)!;
        expect(returnTask).toBeDefined();
        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
        const bridgeCommentId = (bridge.metadata as Record<string, unknown>).result_comment_id as string;
        // Bridge and prompt name the same comment, and it is the one the single
        // resolution saw — the newest comment that existed when the terminal
        // transaction began. A second read would have picked up the comment
        // injected mid-transaction and the prompt would then disagree with the
        // already-committed metadata, which is exactly QA's finding.
        expect(bridgeCommentId).not.toBe(first.id);
        expect(bridgeCommentId).toBe(later.id);
        expect(returnTask.prompt).toContain(`Result comment: ${bridgeCommentId}`);
        // The prompt's Result comment line is the bridge's id, so the injected
        // comment id never appears on that line.
        const promptLine = returnTask.prompt.split("\n").find((line) => line.startsWith("Result comment: "));
        expect(promptLine).toBe(`Result comment: ${bridgeCommentId}`);
        // One resolution on the terminal path: the fix threads the first value
        // through the drain instead of issuing a second SELECT.
        expect(injector.count()).toBe(1);
      });
    }, PG_TEST_TIMEOUT);

    it("records null and the ruling's fallback line when the run never commented", async () => {
      await withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        finishLeaderRound(store, f);
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        const injector = instrumentDb(store, () => {});
        store.cancelTask(childTask.id);
        expect(injector.count()).toBe(1);
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id)!;
        expect(returnTask.prompt).toContain("Result comment: none at completion");
        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
        expect((bridge.metadata as Record<string, unknown>).result_comment_id).toBeNull();
      });
    }, PG_TEST_TIMEOUT);

    for (const withInRunComment of [false, true]) {
      it(`reuses the terminal ${withInRunComment ? "comment A" : "null"} snapshot after an unclaimed return is cancelled`, async () => {
        await withStore(backend, async (store) => {
          await runCancelledReturnSnapshotCase(store, withInRunComment);
        });
      }, PG_TEST_TIMEOUT);

      it(`drains the terminal ${withInRunComment ? "comment A" : "null"} snapshot after a skipped generic wake is cancelled`, async () => {
        await withStore(backend, async (store) => {
          await runSkippedManualWakeCancellationSnapshotCase(store, withInRunComment);
        });
      }, PG_TEST_TIMEOUT);
    }

    it("keeps same-issue report assembly on the main behavior without result-comment reads", async () => {
      await withStore(backend, async (store) => {
        await runSameIssueResultCommentParityCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("drains historical sources when the terminal trigger is covered by a delegate wake-up", async () => {
      await withStore(backend, async (store) => {
        await runDelegateWakeupCoverageStillDrainsHistoryCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("reuses the null snapshot after a queued E2 coverage round is cancelled", async () => {
      await withStore(backend, async (store) => {
        await runCancelledE2SnapshotCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("keeps the legacy latest-comment fallback when the bridge has no snapshot key", async () => {
      await withStore(backend, async (store) => {
        await runMissingSnapshotCompatibilityCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("reuses the historical snapshot when redispatch is followed by another terminal drain", async () => {
      await withStore(backend, async (store) => {
        await runRedispatchThenDrainSnapshotCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("still delivers a bridge and a claimable return into an archived dispatch Session", async () => {
      // Ruling: the archived state is a list filter, not an end of life. The
      // return must keep landing in the Session the leader dispatched from, and
      // the daemon must still be able to claim it.
      await withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        // Finish the leader's round, then archive the Session it dispatched
        // from — the state QA reproduced before ending the delegated task.
        finishLeaderRound(store, f);
        store.updateIssueSession(f.leaderSession.id, { status: "archived" });
        expect(store.getIssueSession(f.leaderSession.id)?.status).toBe("archived");
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        store.completeTask(childTask.id, { output: "Report from the archived round." });

        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id);
        expect(bridge).toBeDefined();
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id);
        expect(returnTask).toBeDefined();
        expect(returnTask!.status).toBe("queued");
        expect(returnTask!.issueSessionId).toBe(f.leaderSession.id);
        expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(returnTask!.id);
        // The queued return is really claimable — the daemon is not left with a
        // task it can never pick up because its Session is archived.
        expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(returnTask!.id);
        store.buildTaskSessionProjection(returnTask!.id);
        expect(store.startTask(returnTask!.id).status).toBe("running");
        expect(store.completeTask(returnTask!.id, { output: "Reviewed." }).status).toBe("completed");
      });
    }, PG_TEST_TIMEOUT);
  });
}
