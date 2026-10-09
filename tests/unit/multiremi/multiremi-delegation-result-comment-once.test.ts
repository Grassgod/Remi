import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody, taskRequestPath, sentTask, issueMessagesPath, turnApiPath } from "./unified-test-paths.js";
/**
 * MUL-456 fix round 1, blocker 2: the terminal transaction resolves the result
 * comment exactly once.
 *
 * QA round 1 injected a later task comment between the bridge-metadata read
 * (`tasks-repo.ts` result_comment_id) and the prompt read and observed two
 * different ids committed in the same transaction. The fix resolves the value
 * once and hands it to the drain; this suite counts the SELECTs on the real
 * terminal path and asserts that bridge metadata and the inbox report agree.
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { inboxReportBody } from "./inbox-test-assertions.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

/** The PG fixture creates and drops a database per case; see the sibling suite. */
const PG_TEST_TIMEOUT = 30_000;

const RESULT_COMMENT_SELECT = "SELECT records.id FROM multiremi_issue_message_records records";

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
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
  const parent = createResponsibleTestIssue(store, { title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = createResponsibleTestIssue(store, { title: "Child", parentIssueId: parent.id, status: "in_progress",
    assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "result-comment-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request(taskRequestPath(store, { issueId: issue.id }), {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestMessageBody(store, { agentId, issueId: issue.id, prompt: "Execute delegated work." })),
  });
  expect(response.status).toBe(200);
  return store.getTask(sentTask(store, await response.json()).id)!;
}

function claimReturn(store:MultiremiStore,runtimeId:string,attemptId:string){
  for(let i=0;i<3;i++){const task=store.claimTask(runtimeId);if(!task||task.id===attemptId)return task;
    store.startTask(task.id);store.completeTask(task.id,{output:"Reviewed owner status"});}
  throw new Error("Return attempt was not offered");
}
function reportSnapshot(event:ReturnType<MultiremiStore["listSessionEvents"]>[number]) {
  return {id:event.id,sessionId:event.sessionId,seq:event.seq,body:event.body,createdAt:event.createdAt,
    source:event.metadata.message_source,address:event.metadata.address_context};
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
  db.run(`INSERT INTO multiremi_conversation_log(session_id,seq,id,kind,visibility,sender_type,sender_id,task_id,body_md,created_at,updated_at,message_kind,wake_requested,wake_applied)
    VALUES(?,(SELECT head_seq+1 FROM multiremi_conversation_heads WHERE session_id=?),?,'message','shown',?,?,?, ?,?,?,'final','inbox_only','inbox_only')`,
    [input.issueSessionId,input.issueSessionId,input.id,input.authorType,input.authorId,input.taskId,input.body,input.createdAt,input.createdAt]);
  db.run("UPDATE multiremi_conversation_heads SET head_seq=head_seq+1,log_version=log_version+1 WHERE session_id=?",[input.issueSessionId]);
}

/** The store's raw db handle, reached the same way the injector reaches it. */
function rawDb(store: MultiremiStore) {
  return (store as unknown as { ctx: { db: { run: (sql: string, ...p: unknown[]) => unknown } } }).ctx.db;
}

/**
 * MUL-427 moved the reads these fixtures steer onto `multiremi_conversation_log`
 * (`agentCommentedSince` reads the log row's `created_at`; the delegation drain
 * reads the bridge's metadata from the log row at its seq). A fixture that
 * rewrites history only on the legacy table no longer reaches the code under
 * test, so each rewrite is mirrored onto the log row. The mirror must change
 * exactly one row, so a mirror that misses fails here rather than silently
 * leaving the fixture's timing unsimulated (ruling cmt_ffadwzab6cnb).
 */
function mirrorOntoConversationLog(store: MultiremiStore, sql: string, params: unknown[]): void {
  expect((rawDb(store).run(sql, params) as { changes: number }).changes).toBe(1);
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
  const deniedMember = await store.createAccessToken({ workspaceId: "local", userId: user.id,
    name: "Snapshot member", type: "pat", purpose: "cli" });
  const owner = await store.createAccessToken({ workspaceId: "local", userId: "local",
    name: "Snapshot owner", type: "pat", purpose: "cli" });
  const daemon = await store.createAccessToken({ workspaceId: "local", userId: "local",
    name: "Snapshot daemon", type: "daemon", purpose: "daemon", daemonId });
  return { owner: owner.token, deniedMember: deniedMember.token, daemon: daemon.token };
}

async function startThroughDaemon(
  base: string,
  store: MultiremiStore,
  daemonToken: string,
  task: MultiremiTask,
  runtimeId: string,
): Promise<void> {
  // The v2 offer pump claims through this same Store operation; this suite's
  // subject is the result-comment lifecycle, not the removed HTTP claim route.
  const claimed = store.claimTask(runtimeId);
  expect(claimed?.id).toBe(task.id);
  await reportThroughDaemon(store, daemonToken, task.id, "start");
}

async function reportThroughDaemon(store: MultiremiStore, token: string, taskId: string,
  type: "start" | "complete", body: Record<string, unknown> = {}): Promise<void> {
  const turn=store.getTurnForAttempt(taskId)!;
  const reply = type === "start"
    ? await reportFrame(store,"task.start",{task_id:taskId},{headers:{Authorization:`Bearer ${token}`},authToken:"result-comment-http-root"})
    : await reportFrame(store,"turn.complete",{turn_id:turn.id,attempt_id:taskId,input_to_seq:0,reply:{message_kind:"final",body_md:String(body.output??"")},...(body.sessionId?{session_id:body.sessionId}:{})},
        {runtimeId:store.getTask(taskId)!.runtimeId!,headers:{Authorization:`Bearer ${token}`},authToken:"result-comment-http-root",turns:store.getDaemonTurnBridge()});
  expect(reply.ok,JSON.stringify(reply)).toBe(true);
}

async function dispatchThroughHttp(
  base: string,
  store: MultiremiStore,
  source: MultiremiTask,
  issue: MultiremiIssue,
  agentId: string,
  sessionId?:string,
): Promise<MultiremiTask> {
  const token = await store.createTaskAccessToken(source, "local");
  const created = await requestJson(base, sessionId ? `/api/sessions/${sessionId}/messages` : issueMessagesPath(store, issue.id), token.token, requestMessageBody(store, {
    agentId,
    issueId: issue.id,
    prompt: "Execute delegated work over HTTP.",
  }), 200);
  return sentTask(store, created);
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
      const posted = await requestJson(base, issueMessagesPath(store, f.child.id), taskToken.token,
        { body_md: "In-run result A", message_kind: "final" }, 200);
      inRunCommentId = posted.message.id;
      // Keep A as a real HTTP-created task comment while placing it before the
      // dispatch boundary. This makes the normal post-commit auto reply C run,
      // reproducing QA's A -> C ordering without inserting a synthetic comment.
      const dispatchedAt = store.getTask(childTask.id)!.dispatchedAt!;
      const beforeDispatch = new Date(Date.parse(dispatchedAt) - 1_000).toISOString();
      mirrorOntoConversationLog(store,
        "UPDATE multiremi_conversation_log SET created_at = ?, updated_at = ? WHERE id = ?",
        [beforeDispatch, beforeDispatch, inRunCommentId]);
    }

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });

    const sourceAfterCompletion = store.getTask(childTask.id)!;
    const firstReturn = store.getTask(sourceAfterCompletion.delegationReturnTaskId!)!;
    const bridge = () => store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id)!;
    const bridgeBeforeCancel = JSON.stringify(reportSnapshot(bridge()));
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id && comment.id !== inRunCommentId);
    expect(automaticComment).toBeDefined();
    const resultCommentId = inRunCommentId ?? automaticComment!.id;
    expect(selects.count()).toBe(1);
    expect((bridge().metadata.message_source as any).commentId).toBe(resultCommentId);
    expect(inboxReportBody(store, firstReturn, childTask.id)).toContain(`结论评论：${resultCommentId}`);

    await requestJson(base, turnApiPath(store, firstReturn.id, "/cancel"), credentials.deniedMember, {}, 404);
    expect(store.getTask(firstReturn.id)?.status).toBe(firstReturn.status);
    expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(firstReturn.id);
    expect(JSON.stringify(reportSnapshot(bridge()))).toBe(bridgeBeforeCancel);
    expect(selects.count()).toBe(1);
    await requestJson(base, turnApiPath(store, firstReturn.id, "/cancel"), credentials.owner);
    const sourceAfterCancel = store.getTask(childTask.id)!;
    const replacement = store.getTask(sourceAfterCancel.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(firstReturn.id);
    expect(inboxReportBody(store, replacement, childTask.id)).toContain(`结论评论：${resultCommentId}`);
    if (inRunCommentId) expect(inboxReportBody(store, replacement, childTask.id)).not.toContain(`结论评论：${automaticComment!.id}`);
    expect((bridge().metadata.message_source as any).commentId).toBe(resultCommentId);
    expect(JSON.stringify(reportSnapshot(bridge()))).toBe(bridgeBeforeCancel);
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
    const e2Round=store.listTasksForIssue(f.parent.id).find(task=>task.status==="queued"&&task.issueSessionId===store.getOrCreateDefaultIssueSession(f.parent.id).id)!;
    expect(e2Round).toBeDefined();

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });
    expect(store.getTask(childTask.id)?.delegationReturnTaskId).not.toBe(e2Round.id);
    const bridge = () => store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id)!;
    const bridgeBeforeCancel = JSON.stringify(reportSnapshot(bridge()));
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id)!;
    expect(automaticComment).toBeDefined();
    expect((bridge().metadata.message_source as any).commentId).toBe(automaticComment.id);
    expect(selects.count()).toBe(1);

    await requestJson(base, turnApiPath(store, e2Round.id, "/cancel"), credentials.owner);
    const replacement = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(e2Round.id);
    expect(inboxReportBody(store, replacement, childTask.id)).toContain(`结论评论：${automaticComment.id}`);
    expect(JSON.stringify(reportSnapshot(bridge()))).toBe(bridgeBeforeCancel);
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
      .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id)!;
    expect(selects.count()).toBe(1);

    // The optional old envelope is display metadata. Canonical source and
    // delivery bindings remain authoritative when it is absent.
    const canonical=store.getMessage(bridge.id)!;
    const {envelope,...metadata}=canonical.metadata;
    mirrorOntoConversationLog(store,"UPDATE multiremi_conversation_log SET metadata=? WHERE id=?",[JSON.stringify(metadata),bridge.id]);
    await requestJson(base,turnApiPath(store,firstReturn.id,"/cancel"),credentials.owner);
    const replacement=store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(inboxReportBody(store,replacement,childTask.id)).toContain(`结论评论：${automaticComment.id}`);
    expect(selects.count()).toBe(1);
  });
}

async function runRedispatchThenDrainSnapshotCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f2-redispatch-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const first = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    const second = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id,store.createIssueSession(f.child.id,{title:"Second execution lane"}).id);
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
    const patrol = createResponsibleTestIssue(store, { title: "Snapshot patrol", status: "in_progress" });
    const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "Supervise." });
    const supervisorToken = await store.createTaskAccessToken(supervisorTask, "local");
    const redispatched = await requestJson(base, turnApiPath(store, originalReturn.id, "/retry"),
      supervisorToken.token, { cold: true }, 200);
    const replacement = store.getTask(redispatched.turn.current_attempt_id)!;
    expect(replacement.id).not.toBe(originalReturn.id);
    expect(store.getTask(first.id)?.delegationReturnTaskId).toBe(store.getTurnForAttempt(replacement.id)!.id);

    await startThroughDaemon(base, store, credentials.daemon, second, f.workerRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, second.id, "complete",
      { output: "Second automatic result C2" });
    expect(store.getTask(first.id)?.delegationReturnTaskId).toBe(store.getTurnForAttempt(replacement.id)!.id);
    expect(inboxReportBody(store, replacement, first.id)).toContain(`结论评论：${firstAutomaticComment.id}`);
    expect(inboxReportBody(store, store.getTask(replacement.id)!, first.id)).toContain(`结论评论：${firstAutomaticComment.id}`);
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
      const posted = await requestJson(base, issueMessagesPath(store, f.child.id), childToken.token,
        { body_md: "In-run result A", message_kind: "final" }, 200);
      inRunCommentId = posted.message.id;
      const beforeDispatch = new Date(Date.parse(store.getTask(childTask.id)!.dispatchedAt!) - 1_000).toISOString();
      mirrorOntoConversationLog(store,
        "UPDATE multiremi_conversation_log SET created_at = ?, updated_at = ? WHERE id = ?",
        [beforeDispatch, beforeDispatch, inRunCommentId]);
    }
    const manualResponse = await requestJson(base, `/api/sessions/${f.leaderSession.id}/messages`, childToken.token, requestMessageBody(store, {
      agentId: f.leader.id,
      issueId: f.parent.id,
      issueSessionId: f.leaderSession.id,
      prompt: "Manual wake through the generic task endpoint.",
    }), 200);
    const manual = sentTask(store, manualResponse);
    expect(manual.parentTaskId).toBeNull();
    expect(store.getMessage(store.getTurnForAttempt(manual.id)!.trigger_message_id!)?.task_id).toBe(childTask.id);
    expect(manual.delegationSkipReason).toBeNull();
    expect(manual.delegationId).toBeTruthy();
    expect(manual.delegatedByAgentId).toBe(f.worker.id);
    expect(manual.delegatedFromIssueSessionId).toBe(childTask.issueSessionId);

    const selects = countResultCommentSelectsForTask(store, childTask.id);
    await reportThroughDaemon(store, credentials.daemon, childTask.id, "complete",
      { output: "Automatic result comment C" });
    const firstReturn = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(firstReturn.id).not.toBe(manual.id);
    expect(firstReturn.agentId).toBe(f.leader.id);
    const bridge = () => store.listSessionEvents(f.leaderSession.id)
      .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id)!;
    const bridgeBeforeCancel = JSON.stringify(reportSnapshot(bridge()));
    const automaticComment = store.listIssueComments(f.child.id)
      .find((comment) => comment.taskId === childTask.id && comment.id !== inRunCommentId)!;
    const resultCommentId = inRunCommentId ?? automaticComment.id;
    expect(selects.count()).toBe(1);
    expect((bridge().metadata.message_source as any).commentId).toBe(resultCommentId);

    await requestJson(base, turnApiPath(store, firstReturn.id, "/cancel"), credentials.owner);
    const replacement = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(firstReturn.id);
    expect(replacement.id).not.toBe(manual.id);
    expect(inboxReportBody(store, replacement, childTask.id)).toContain(`结论评论：${resultCommentId}`);
    if (inRunCommentId) expect(inboxReportBody(store, replacement, childTask.id)).not.toContain(`结论评论：${automaticComment.id}`);
    expect(JSON.stringify(reportSnapshot(bridge()))).toBe(bridgeBeforeCancel);
    expect(selects.count()).toBe(1);
    expect(store.listIssueActivity(f.parent.id).some((activity) =>
      activity.type === "delegation_return_skipped"
      && (activity.data as Record<string, unknown>).sourceTaskId === manual.id
      && (activity.data as Record<string, unknown>).reason === "source_not_squad_leader"
    )).toBe(false);
  });
}

async function runSameIssueResultCommentParityCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f3-same-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const delegated = await dispatchThroughHttp(base, store, f.leaderTask, f.parent, f.worker.id,f.leaderSession.id);
    expect(delegated.issueSessionId).toBe(f.leaderSession.id);
    await startThroughDaemon(base, store, credentials.daemon, f.leaderTask, f.leaderRuntime.id);
    await reportThroughDaemon(store, credentials.daemon, f.leaderTask.id, "complete",
      { output: "Leader dispatched the work." });
    await startThroughDaemon(base, store, credentials.daemon, delegated, f.workerRuntime.id);

    const selects = countResultCommentSelectsForTask(store, delegated.id);
    await reportThroughDaemon(store, credentials.daemon, delegated.id, "complete",
      { output: "Same-issue terminal result." });
    const firstReturn = store.getTask(store.getTask(delegated.id)!.delegationReturnTaskId!)!;
    const expectedBody = inboxReportBody(store, firstReturn, delegated.id);
    const automatic = store.listIssueComments(f.parent.id).find(comment => comment.taskId === delegated.id)!;
    expect(expectedBody).toContain("Worker completed a task you delegated.\nStatus: completed\n");
    expect(expectedBody).toContain(`结论评论：${automatic.id}`);
    expect(expectedBody).toContain("摘要：Same-issue terminal result.");
    expect(Buffer.byteLength(expectedBody)).toBeLessThan(2_048);
    expect(inboxReportBody(store, firstReturn, delegated.id)).not.toContain("Issue:");
    expect(firstReturn.prompt).not.toContain("Same-issue terminal result.");
    expect(selects.count()).toBe(1);
    expect(store.listSessionEvents(f.leaderSession.id)
      .filter((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === delegated.id)).toHaveLength(1);

    await requestJson(base, turnApiPath(store, firstReturn.id, "/cancel"), credentials.owner);
    const replacement = store.getTask(store.getTask(delegated.id)!.delegationReturnTaskId!)!;
    expect(replacement.id).not.toBe(firstReturn.id);
    expect(inboxReportBody(store, replacement, delegated.id)).toBe(expectedBody);
    expect(inboxReportBody(store, replacement, delegated.id)).toContain(`结论评论：${automatic.id}`);
    expect(selects.count()).toBe(1);
  });
}

async function runDelegateWakeupCoverageStillDrainsHistoryCase(store: MultiremiStore): Promise<void> {
  const daemonId = `mul456-f3-covered-${process.pid}-${++sequence}`;
  const f = fixture(store, daemonId);
  const credentials = await httpCredentials(store, daemonId);
  await withHttpApi(store, async (base) => {
    const historical = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id);
    const trigger = await dispatchThroughHttp(base, store, f.leaderTask, f.child, f.worker.id,store.createIssueSession(f.child.id,{title:"Another execution lane"}).id);
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
    const patrol = createResponsibleTestIssue(store, { title: "Drain patrol", status: "in_progress" });
    const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "Supervise." });
    const supervisorToken = await store.createTaskAccessToken(supervisorTask, "local");
    const redispatched = await requestJson(base, turnApiPath(store, firstReturn.id, "/retry"),
      supervisorToken.token, { cold: true }, 200);
    const replacement = store.getTask(redispatched.turn.current_attempt_id)!;
    expect(store.getTask(historical.id)?.delegationReturnTaskId).toBe(store.getTurnForAttempt(replacement.id)!.id);

    await startThroughDaemon(base, store, credentials.daemon, trigger, f.workerRuntime.id);
    const triggerToken = await store.createTaskAccessToken(trigger, "local");
    const response = await requestJson(base, `/api/sessions/${f.leaderSession.id}/messages`, triggerToken.token, requestMessageBody(store, {
      agentId: f.leader.id,
      issueId: f.parent.id,
      issueSessionId: f.leaderSession.id,
      prompt: "Manual wake for the current delegated task.",
    }), 200);
    const coveringTask = sentTask(store, response);

    await reportThroughDaemon(store, credentials.daemon, trigger.id, "complete",
      { output: "Trigger report." });
    expect(store.getTask(trigger.id)?.delegationReturnTaskId).toBe(store.getTurnForAttempt(replacement.id)!.id);
    expect(store.getTask(historical.id)?.delegationReturnTaskId).toBe(store.getTurnForAttempt(replacement.id)!.id);
    expect(store.getTask(coveringTask.id)!.prompt).toBe("Manual wake for the current delegated task.");
    expect(inboxReportBody(store, replacement, trigger.id)).toContain("Trigger report.");
    expect(inboxReportBody(store, replacement, historical.id)).toContain("Historical report.");
    expect(store.listIssueActivity(f.parent.id).some((activity) =>
      activity.type === "turn_merged"
      && (activity.data as Record<string, unknown>).message_id != null
    )).toBe(true);
  });
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-456 result comment resolved once (${backend})`, () => {
    it("uses one id for the bridge metadata and inbox even when a later comment lands mid-transaction", async () => {
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
          .find((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(childTask.id)?.delegationReturnTaskId)!;
        expect(returnTask).toBeDefined();
        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id)!;
        const bridgeCommentId = (bridge.metadata.message_source as any).commentId as string;
        // Bridge and inbox name the same comment, and it is the one the single
        // resolution saw — the newest comment that existed when the terminal
        // transaction began. A second read would have picked up the comment
        // injected mid-transaction and the prompt would then disagree with the
        // already-committed metadata, which is exactly QA's finding.
        expect(bridgeCommentId).not.toBe(first.id);
        expect(bridgeCommentId).toBe(later.id);
        const report = inboxReportBody(store, returnTask, childTask.id);
        expect(report).toContain(`结论评论：${bridgeCommentId}`);
        // The inbox Result comment line is the bridge's id, so the injected
        // comment id never appears on that line.
        const promptLine = report.split("\n").find((line) => line.startsWith("结论评论："));
        expect(promptLine).toBe(`结论评论：${bridgeCommentId}（remi comment list ${f.child.id} --thread ${bridgeCommentId}）`);
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
          .find((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(childTask.id)?.delegationReturnTaskId)!;
        expect(inboxReportBody(store, returnTask, childTask.id)).toContain("结论评论：无");
        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id)!;
        expect((bridge.metadata.message_source as any).commentId).toBeUndefined();
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

    it("includes the same-issue automatic reply id and reuses it after cancellation", async () => {
      await withStore(backend, async (store) => {
        await runSameIssueResultCommentParityCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("drains historical sources when the terminal trigger is covered by a delegate wake-up", async () => {
      await withStore(backend, async (store) => {
        await runDelegateWakeupCoverageStillDrainsHistoryCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("reuses the automatic reply snapshot after a queued E2 coverage round is cancelled", async () => {
      await withStore(backend, async (store) => {
        await runCancelledE2SnapshotCase(store);
      });
    }, PG_TEST_TIMEOUT);

    it("retains the canonical result snapshot when optional envelope metadata is absent", async () => {
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
          .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === childTask.id);
        expect(bridge).toBeDefined();
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(childTask.id)?.delegationReturnTaskId);
        expect(returnTask).toBeDefined();
        expect(returnTask!.status).toBe("queued");
        expect(returnTask!.issueSessionId).toBe(f.leaderSession.id);
        expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(returnTask!.id);
        // The queued return is really claimable — the daemon is not left with a
        // task it can never pick up because its Session is archived.
        expect(claimReturn(store,f.leaderRuntime.id,returnTask!.id)?.id).toBe(returnTask!.id);
        store.buildTaskSessionProjection(returnTask!.id);
        expect(store.startTask(returnTask!.id).status).toBe("running");
        expect(store.completeTask(returnTask!.id, { output: "Reviewed." }).status).toBe("completed");
      });
    }, PG_TEST_TIMEOUT);
  });
}
