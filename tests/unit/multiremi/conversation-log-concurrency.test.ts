import { createResponsibleTestIssue, replayHistoricalTestChildDone } from './helpers.js';
import { mutateExecutionFixture } from "./unified-test-paths.js";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { Hono } from "hono";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresReplyTooLargeError, PostgresSyncDatabase, resetDbReplyLimitForTest, type SqlDatabase, postgresReplyMaxBytes } from "@multiremi/store/db/postgres.js";
import { resetLockOrderSentinelEnabledCache } from "@multiremi/store/lock-order-sentinel.js";
import { DB_REPLY_TRANSITION_EXCEPTIONS, createRequestMetricsMiddleware, currentDbReplyPolicy } from "@multiremi/observability/request-metrics.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { AgentIssueUpdatesRepo } from "@multiremi/store/repos/agent-issue-updates-repo.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

const worker = new URL("./fixtures/conversation-log-process.ts", import.meta.url).pathname;
const migrationId = "20260927_conversation_log";
const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

async function runFour(backend: "sqlite" | "pg", target: string, operation: "migrate" | "append", sessionId = "ises_concurrent"): Promise<void> {
  const children = Array.from({ length: 4 }, () => Bun.spawn({
    cmd: [process.execPath, worker, backend, target, operation, sessionId, "25"],
    env: { ...process.env, MULTIREMI_DATABASE_URL: backend === "pg" ? target : "" },
    stdout: "pipe", stderr: "pipe",
  }));
  const results = await Promise.all(children.map(async (child) => ({
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
  })));
  for (const result of results) expect(result.code, result.stderr).toBe(0);
}

async function runFirstComments(backend: "sqlite" | "pg", target: string, sessionId: string): Promise<void> {
  const children = Array.from({ length: 2 }, () => Bun.spawn({
    cmd: [process.execPath, worker, backend, target, "first-comment", sessionId],
    env: { ...process.env, MULTIREMI_DATABASE_URL: backend === "pg" ? target : "" },
    stdout: "pipe", stderr: "pipe",
  }));
  const results = await Promise.all(children.map(async (child) => ({
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
  })));
  for (const result of results) expect(result.code, result.stderr).toBe(0);
}

function assertContiguous(db: SqlDatabase, sessionId: string): void {
  const rows = db.query("SELECT seq FROM multiremi_conversation_log WHERE session_id = ? AND seq>0 ORDER BY seq ASC")
    .all(sessionId) as Array<{ seq: number }>;
  expect(rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  const head = db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?")
    .get(sessionId) as { head_seq: number };
  expect(Number(head.head_seq)).toBe(100);
}

async function withSqlite(run: (db: Database, path: string) => Promise<void>, fresh = false): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mul426-sqlite-"));
  const path = join(dir, "test.sqlite");
  const db = openSqliteDatabase(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000");
  if (!fresh) new MultiremiStore(db).ensureLocalWorkspace();
  try { await run(db, path); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function withPostgres(run: (db: PostgresSyncDatabase, url: string) => Promise<void>, fresh = false): Promise<void> {
  const name = `mul426_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try {
    if (!fresh) new MultiremiStore(db).ensureLocalWorkspace();
    await run(db, url.toString());
  } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

async function verifyLegacyFirstWrites(db: SqlDatabase, backend: "sqlite" | "pg", target: string): Promise<void> {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "Legacy issue", workspaceId: "local" });
  const direct = store.getOrCreateDefaultIssueSession(issue.id);
  const renamed = store.createIssueSession(issue.id, { title: "Other session" });
  const concurrent = store.createIssueSession(issue.id, { title: "Concurrent session" });
  const agent = store.createAgent({ name: "Legacy chat agent", provider: "codex", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  for (const session of [direct,renamed,concurrent]) {
    for (let seq=1;seq<=3;seq++) store.createIssueComment(issue.id,{issueSessionId:session.id,body:`legacy ${seq}`,authorType:"system"});
  }
  for(let seq=1;seq<=3;seq++) db.transaction(()=>store.appendChatMessageWithinTransaction({chatSessionId:chat.id,role:"system",body:`old ${seq}`}))();
  const migrated = new MultiremiStore(db);
  const comment = migrated.createIssueComment(issue.id, { issueSessionId: direct.id, body: "new" });
  expect(migrated.getConversationLogEntryById(comment.id)?.seq).toBe(4);
  migrated.updateIssue(issue.id, { title: "Renamed legacy issue" });
  const afterRename = migrated.createIssueComment(issue.id, { issueSessionId: renamed.id, body: "after title" });
  expect(migrated.getConversationLogEntryById(afterRename.id)?.seq).toBe(5);
  expect(migrated.getConversationLogHead(renamed.id)?.headSeq).toBe(5);
  const chatMessage = migrated.sendChatMessage(chat.id, { content: "continued chat" }).message;
  expect(migrated.getConversationLogEntryById(chatMessage.id)?.seq).toBe(4);
  migrated.resolveIssueComment(comment.id);
  expect(migrated.listSessionEvents(direct.id, { sinceSeq: 2 }).map((event) => event.seq)).toEqual([3, 4, 5]);
  expect(migrated.listSessionEvents(direct.id, { sinceSeq: 2, toSeq: 4 }).map((event) => event.seq)).toEqual([3, 4]);
  expect(migrated.listSessionEvents(direct.id, { sinceSeq: 4, toSeq: 5 })[0]?.kind).toBe("thread_resolved");
  const app = createMultiremiApp({ store: migrated });
  const response = await app.request(`/api/sessions/${direct.id}/messages`+`?cursor=2`);
  expect(response.status).toBe(200);
  const wire = (await response.json()).messages as Array<{ seq: number; kind: string }>;
  expect(wire.map((event) => event.seq)).toEqual([3, 4]);
  await runFirstComments(backend, target, concurrent.id);
  expect(migrated.listSessionEvents(concurrent.id).map((event) => event.seq)).toEqual([1,2,3,4,5,6]);
}

function verifyNestedTransactions(db: SqlDatabase): void {
  db.exec("CREATE TABLE nested_tx_case (n INTEGER PRIMARY KEY)");
  db.transaction(() => {
    db.run("INSERT INTO nested_tx_case (n) VALUES (1)");
    try {
      db.transaction(() => {
        db.run("INSERT INTO nested_tx_case (n) VALUES (2)");
        db.run("INSERT INTO nested_tx_case (n) VALUES (1)");
      })();
    } catch { /* the outer transaction continues */ }
    db.run("INSERT INTO nested_tx_case (n) VALUES (3)");
  })();
  expect(db.query("SELECT n FROM nested_tx_case ORDER BY n").all().map((row: any) => Number(row.n))).toEqual([1, 3]);

  db.transaction(() => {
    db.run("INSERT INTO nested_tx_case (n) VALUES (4)");
    try {
      db.transaction(() => {
        db.transaction(() => db.run("INSERT INTO nested_tx_case (n) VALUES (5)"))();
        db.run("INSERT INTO nested_tx_case (n) VALUES (4)");
      })();
    } catch { /* the middle savepoint includes the successful inner one */ }
    db.run("INSERT INTO nested_tx_case (n) VALUES (6)");
  })();
  expect(db.query("SELECT n FROM nested_tx_case ORDER BY n").all().map((row: any) => Number(row.n))).toEqual([1, 3, 4, 6]);

  db.transaction(() => {
    db.transaction(() => {
      try {
        db.transaction(() => db.run("INSERT INTO nested_tx_case (n) VALUES (4)"))();
      } catch { /* middle transaction continues after the inner rollback */ }
      db.run("INSERT INTO nested_tx_case (n) VALUES (7)");
    })();
  })();
  expect(db.query("SELECT n FROM nested_tx_case ORDER BY n").all().map((row: any) => Number(row.n))).toEqual([1, 3, 4, 6, 7]);
}

async function verifyCaughtLocalReplyFailure(db: SqlDatabase, nested: boolean): Promise<void> {
  db.exec("CREATE TABLE local_reply_case (n INTEGER PRIMARY KEY)");
  const previousLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
  const replyExceptions = DB_REPLY_TRANSITION_EXCEPTIONS as Set<string>;
  const wasBackgroundExempt = replyExceptions.delete("<background> <background>");
  process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "200";
  process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
  resetDbReplyLimitForTest();
  try {
    const app = new Hono();
    let handlerError: unknown;
    app.use("*", createRequestMetricsMiddleware({ enabled: false, slowRequestMs: 500,
      summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 256, role: "all" }));
    app.onError((error, c) => { handlerError = error; return c.text("failed", 500); });
    app.get("/api/local-reply-limit-fixture", (c) => {
      expect(postgresReplyMaxBytes()).toBe(200);
      expect(currentDbReplyPolicy()).toMatchObject({ enforced: true, exempt: false });
      db.transaction(() => {
        db.run("INSERT INTO local_reply_case (n) VALUES (1)");
        const caughtQuery = () => {
          let caught = false;
          try {
            if (db instanceof PostgresSyncDatabase) {
              db.query("SELECT repeat('x', 1000) AS payload").get();
            } else {
              db.query("SELECT 1 AS payload").get();
              throw new PostgresReplyTooLargeError(1000, 200);
            }
          } catch (error) {
            expect(error).toBeInstanceOf(PostgresReplyTooLargeError);
            caught = true;
          }
          expect(caught).toBe(true);
        };
        if (nested) db.transaction(caughtQuery)();
        else caughtQuery();
        db.run("INSERT INTO local_reply_case (n) VALUES (2)");
      })();
      expect(db.query("SELECT n FROM local_reply_case ORDER BY n").all().map((row: any) => Number(row.n))).toEqual([1, 2]);
      return c.body(null, 204);
    });
    const response = await app.request("/api/local-reply-limit-fixture");
    if (handlerError) throw handlerError;
    expect(response.status).toBe(204);
  } finally {
    if (previousLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
    else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousLimit;
    if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
    else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
    if (wasBackgroundExempt) replyExceptions.add("<background> <background>");
    resetDbReplyLimitForTest();
  }
}

function verifyLegacyIssueUpdateQueueIsUnused(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "No legacy update queue", workspaceId: "local" });
  store.queueAgentIssueUpdate = () => {
    throw new Error("Legacy Issue update queue must not be called");
  };
  const comment = store.createIssueComment(issue.id, { body: "comment survives without legacy queue" });
  expect(store.getIssueComment(comment.id)?.body).toBe("comment survives without legacy queue");
  expect(store.getConversationLogEntryById(comment.id)?.body_md).toBe("comment survives without legacy queue");
  const count = db.query("SELECT COUNT(*) AS count FROM multiremi_agent_issue_update_state").get() as { count: number | string };
  expect(Number(count.count)).toBe(0);
}

function verifyQueueBeforeFlush(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "Queue before flush", workspaceId: "local" });
  const agent = store.createAgent({ name: "Flush recipient", provider: "codex" });
  const chat = store.createChatSession({ agentId: agent.id });
  bindFeishuTopicFixture(store, db, chat.id, issue.id);
  const context = (store as unknown as { ctx: StoreContext }).ctx;
  const events = createCommitEventQueue();
  context.db.transaction(() => {
    store.queueAgentIssueUpdate({
      activityId: "leader-round:flush-once", issueId: issue.id,
      actorType: "agent", type: "leader_round_completed", body: "Flush this round once",
      createdAt: new Date().toISOString(),
    });
    expect(store.flushAgentIssueUpdatesForIssueWithinTransaction(issue.id, events)).toEqual({
      delivered: 1, dropped: 0,
    });
  })();
  expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toEqual({ delivered: 0, dropped: 0 });
  const messages = store.listChatMessages(chat.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.body).toContain("Flush this round once");
}

/**
 * Senior ruling cmt_96e1yqxgifms §2: the comment broadcast's workspace lookup
 * is a plain read, with no savepoint around it. Activity publication reuses the
 * mandatory origin read and survives a failing realtime listener. On
 * PostgreSQL that means a *real* SQL error poisons the caller's transaction and
 * the write must fail (see the outer-transaction case below); what still has to
 * be survived is the failure the database classifies as non-aborting —
 * `PgBridgeFailure(abortsTransaction: false)` from an oversized bridge reply.
 * The SQLite handle does not abort on a statement error, so it keeps exercising
 * the plain-error path unchanged.
 */
function verifyBestEffortWorkspaceLookups(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "Best effort lookups", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const context = (store as unknown as { ctx: { issueWorkspaceId: (id: string) => string | null } }).ctx;
  const originalLookup = context.issueWorkspaceId.bind(context);
  let lookups = 0;
  const publicationAttempts: Array<{ workspaceId: string; inTransaction: boolean }> = [];
  const healthyDeliveries: string[] = [];
  const stopFailingListener = store.onWorkspaceEvent((event) => {
    if (event.type !== "activity:created") return;
    publicationAttempts.push({ workspaceId: event.workspaceId, inTransaction: db.inTransaction === true });
    throw new Error("realtime listener unavailable");
  });
  const stopHealthyListener = store.onWorkspaceEvent((event) => {
    if (event.type === "activity:created") healthyDeliveries.push(event.workspaceId);
  });
  const previousReplyLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
  const replyExceptions = DB_REPLY_TRANSITION_EXCEPTIONS as Set<string>;
  const wasBackgroundExempt = backend === "pg" && replyExceptions.delete("<background> <background>");
  if (backend === "pg") {
    process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
    resetDbReplyLimitForTest();
    context.issueWorkspaceId = (id) => {
      if (++lookups === 1) return originalLookup(id);
      // The limit is narrowed for this one statement and restored in `finally`,
      // so only the lookup overflows the bridge — the rest of the transaction
      // keeps the default and the failure stays a single reply-level one.
      process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "64";
      resetDbReplyLimitForTest();
      try {
        return db.query("SELECT id, repeat('x', 4000) AS payload FROM multiremi_issues WHERE id = ?").get(id);
      } finally {
        if (previousReplyLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
        else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousReplyLimit;
        resetDbReplyLimitForTest();
      }
    };
  } else {
    context.issueWorkspaceId = (id) => ++lookups === 1 ? originalLookup(id)
      : db.query("SELECT missing_workspace_column FROM multiremi_issues WHERE id = ?").get(id);
  }
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  let comment: { id: string };
  try {
    try {
      comment = store.createTaskFailureSystemComment(issue.id, session.id, "tsk_lookup", "system survives query error");
    } finally {
      if (previousReplyLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousReplyLimit;
      if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
      else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
      if (wasBackgroundExempt) replyExceptions.add("<background> <background>");
      resetDbReplyLimitForTest();
    }
    expect(store.getIssueComment(comment.id)?.body).toBe("system survives query error");
    expect(store.getConversationLogEntryById(comment.id)?.body_md).toBe("system survives query error");
    expect(lookups).toBe(2);
    expect(publicationAttempts).toEqual([{ workspaceId: issue.workspaceId, inTransaction: false }]);
    expect(healthyDeliveries).toEqual([issue.workspaceId]);
    expect(db.query("SELECT workspace_id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'").all(issue.id))
      .toEqual([{ workspace_id: issue.workspaceId }]);
    expect(warnings.some((line) => line.includes("comment:created broadcast skipped"))).toBe(true);
  } finally {
    console.warn = originalWarn;
    context.issueWorkspaceId = originalLookup;
    stopFailingListener();
    stopHealthyListener();
  }
}

function verifyMandatoryActivityOriginFailure(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "Mandatory activity origin", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const context = (store as unknown as { ctx: { issueWorkspaceId: (id: string) => string | null } }).ctx;
  const originalLookup = context.issueWorkspaceId;
  const emitted: string[] = [];
  const stop = store.onWorkspaceEvent((event) => emitted.push(event.type));
  let failedQueries = 0;
  context.issueWorkspaceId = (id) => {
    failedQueries += 1;
    return db.query("SELECT missing_workspace_column FROM multiremi_issues WHERE id = ?").get(id);
  };
  try {
    expect(() => store.createTaskFailureSystemComment(issue.id, session.id, "tsk_origin_failure", "must roll back"))
      .toThrow(/missing_workspace_column/);
    expect(failedQueries).toBe(1);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT id FROM multiremi_issue_comments WHERE issue_id = ?").all(issue.id)).toEqual([]);
    expect(db.query("SELECT id FROM multiremi_conversation_log WHERE session_id = ? AND id NOT LIKE 'head_%'").all(session.id)).toEqual([]);
    expect(db.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'").all(issue.id)).toEqual([]);
    expect(emitted).toEqual([]);
  } finally {
    context.issueWorkspaceId = originalLookup;
    stop();
  }
}

function rejectWrite(db: SqlDatabase, backend: "sqlite" | "pg", table: string, operation: "INSERT" | "UPDATE", condition: string): void {
  if (backend === "pg") {
    db.run(`CREATE FUNCTION reject_conversation_write() RETURNS trigger AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'write rejected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    db.run(`CREATE TRIGGER reject_conversation_write BEFORE ${operation} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_conversation_write()`);
  } else {
    db.exec(`CREATE TRIGGER reject_conversation_write BEFORE ${operation} ON ${table}
      FOR EACH ROW WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'write rejected'); END`);
  }
}

function verifySystemCommentRollback(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "System rollback", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  rejectWrite(db, backend, "multiremi_conversation_log", "INSERT", "NEW.kind = 'message' AND NEW.sender_type = 'platform' AND (NEW.body_md = 'blocked' OR NEW.body_md LIKE '%Child%')");
  expect(() => store.createTaskFailureSystemComment(issue.id, session.id, "tsk_failure", "blocked"))
    .toThrow("write rejected");
  expect(store.listIssueComments(issue.id)).toEqual([]);
  expect(store.listSessionEvents(session.id)).toEqual([]);
  expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind === "message" && store.getMessage(entry.id)?.sender_type === "platform")).toEqual([]);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'")
    .get(issue.id) as { n: number | string }).n)).toBe(0);

  const agent = store.createAgent({ name: "Parent assignee", provider: "codex", workspaceId: "local" });
  store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: agent.id });
  const child = createResponsibleTestIssue(store, { title: "Child", parentIssueId: issue.id, workspaceId: "local" });
  const beforeTasks = Number((db.query("SELECT COUNT(*) AS n FROM multiremi_turn_execution_records WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n);
  const beforeEvents = store.listSessionEvents(session.id).length;
  const beforeComments = store.listIssueComments(issue.id);
  const parentLog = () => db.query("SELECT * FROM multiremi_conversation_log WHERE session_id = ? ORDER BY seq ASC")
    .all(session.id);
  const beforeLog = parentLog();
  const beforeHeadSeq = store.getConversationLogHead(session.id)?.headSeq;
  const beforeActivity = Number((db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n);
  const beforeStatus = store.getIssue(issue.id)?.status;
  // ADR 0012: consuming a persisted historical terminal fact, its status,
  // system notification and pending turn roll back together.
  expect(() => replayHistoricalTestChildDone(store,child.id)).toThrow("write rejected");
  expect(store.getIssue(child.id)?.status).toBe(child.status);
  expect(store.listIssueComments(issue.id)).toEqual(beforeComments);
  expect(store.listSessionEvents(session.id)).toHaveLength(beforeEvents);
  expect(parentLog()).toEqual(beforeLog);
  expect(store.getConversationLogHead(session.id)?.headSeq).toBe(beforeHeadSeq);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n)).toBe(beforeActivity);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_turn_execution_records WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n)).toBe(beforeTasks);
  expect(store.getIssue(issue.id)?.status).toBe(beforeStatus);
}

function verifyHeadRollback(db: SqlDatabase, backend: "sqlite" | "pg", rejectedIndex: 0 | 1): void {
  const store = new MultiremiStore(db);
  const issue = createResponsibleTestIssue(store, { title: "Old title", workspaceId: "local" });
  const first = store.getOrCreateDefaultIssueSession(issue.id);
  const second = store.createIssueSession(issue.id, { title: "Second" });
  const before = [first, second].map((session) => store.getConversationLogEntry(session.id, 0));
  rejectWrite(db, backend, "multiremi_conversation_log", "UPDATE", `NEW.kind = 'head' AND NEW.session_id = '${[first, second][rejectedIndex]!.id}'`);
  expect(() => store.updateIssue(issue.id, { title: "New title" })).toThrow("write rejected");
  expect(store.getIssue(issue.id)?.title).toBe("Old title");
  for (const [index, session] of [first, second].entries()) {
    expect(store.getConversationLogEntry(session.id, 0)).toEqual(before[index]);
  }
}

function verifyFinalReplyReference(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const store = new MultiremiStore(db);
  const runtime = store.registerRuntime({ name: "reply runtime", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Reply agent", provider: "claude", runtimeId: runtime.id, workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Reply reference", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "reply", workspaceId: "local" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  store.completeTask(task.id, { output: "Final answer" });
  const comment = store.listIssueComments(issue.id).find(comment=>comment.taskId===task.id)!;
  expect(store.findTurnEntry(task.id)?.metadata.final_entry_id).toBe(comment.id);

  const failed = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retry", workspaceId: "local" });
  expect(store.claimTask(runtime.id)?.id).toBe(failed.id);
  store.startTask(failed.id);
  rejectWrite(db, backend, "multiremi_conversation_log", "INSERT", "NEW.kind = 'message' AND NEW.body_md = 'Blocked answer'");
  store.completeTask(failed.id, { output: "Blocked answer" });
  expect(store.findTurnEntry(failed.id)?.metadata).toMatchObject({ status: "completed", final_entry_id: null });
  expect(store.listIssueComments(issue.id).filter(comment=>comment.authorType==="agent")).toHaveLength(1);
}

// F1 (MUL-402 QA): `postAgentReplyComment` owns one transaction for the reply
// (comment, Session event, log row) and its turn card's `final_entry_id`; the
// reply's pushes, notifications and agent dispatch run after that COMMIT, in
// MUL-427's shape (95d9be9e).
function startLeaderRound(store: MultiremiStore, runtimeId: string) {
  const runtime = store.registerRuntime({ id: runtimeId, name: "Reply runtime", provider: "codex", workspaceId: "local" });
  const leader = store.createAgent({ name: "Reply leader", provider: "codex", workspaceId: "local" });
  const teammate = store.createAgent({ name: "Reply teammate", provider: "codex", workspaceId: "local" });
  const squad = store.createSquad({ name: "Reply squad", leaderId: leader.id, memberIds: [teammate.id], workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Reply commit", workspaceId: "local", assigneeType: "squad", assigneeId: squad.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const task = store.createSessionTask(session.id, { agentId: leader.id, prompt: "Lead the round" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  return { issue, task, teammate };
}

function verifyReplyDispatchAfterCommit(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const { issue, task, teammate } = startLeaderRound(store, "rt_reply_after_commit");
  const events: Array<{ type: string; inTransaction: boolean | undefined }> = [];
  const enqueued: Array<{ agentId: string; inTransaction: boolean | undefined }> = [];
  const unsubscribers = [
    store.onWorkspaceEvent((event) => events.push({ type: event.type, inTransaction: db.inTransaction })),
    store.onTaskEvent((event) => events.push({ type: event.type, inTransaction: db.inTransaction })),
    store.onTaskEnqueued((queued) => enqueued.push({ agentId: queued.agentId, inTransaction: db.inTransaction })),
  ];
  try {
    store.completeTask(task.id, { output: `[@Reply teammate](mention://agent/${teammate.id}) Please verify` });
    const reply = store.listIssueComments(issue.id).find((comment) => comment.taskId === task.id)!;
    expect(store.listTasksForIssue(issue.id).filter((candidate) => candidate.triggerCommentId === reply.id)
      .map((candidate) => candidate.agentId)).toEqual([teammate.id]);
    expect(enqueued).toEqual([{ agentId: teammate.id, inTransaction: false }]);
    expect(events.map((event) => event.type)).toContain("comment:created");
    expect(events.map((event) => event.inTransaction)).toEqual(events.map(() => false));
  } finally { for (const unsubscribe of unsubscribers) unsubscribe(); }
}

function verifyReplyCommitsWithFinalEntry(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const store = new MultiremiStore(db);
  const runtime = store.registerRuntime({ id: "rt_reply_final_entry", name: "Reply runtime", provider: "codex", workspaceId: "local" });
  const agent = store.createAgent({ name: "Reply author", provider: "codex", workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Final entry", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const completeRound = (output: string) => {
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Answer" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output });
    return task;
  };
  const committed = completeRound("Committed answer");
  const reply = store.listIssueComments(issue.id).find((comment) => comment.taskId === committed.id)!;
  expect(reply.body).toBe("Committed answer");
  expect(store.findTurnEntry(committed.id)?.metadata.final_entry_id).toBe(reply.id);

  // The canonical reply pointer replaces the old turn-card JSON field.
  rejectWrite(db, backend, "multiremi_turns", "UPDATE", "NEW.reply_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM multiremi_conversation_log WHERE id = NEW.reply_message_id AND body_md = 'Rolled back answer')");
  const before = store.listIssueComments(issue.id).map(comment=>comment.id);
  const emitted: string[] = [];
  const unsubscribe = store.onWorkspaceEvent((event) => emitted.push(event.type));
  try {
    const rejected = completeRound("Rolled back answer");
    expect(store.getTask(rejected.id)?.status).toBe("completed");
    expect(store.listIssueComments(issue.id).filter(comment=>comment.authorType==="agent").map(comment=>comment.id)).toEqual([reply.id]);
    // Count the session's message rows: a leaked reply shows up here whatever task_id its log row carries.
    expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind === "message" && store.getMessage(entry.id)?.sender_type === "agent")
      .map((entry) => entry.id)).toEqual([reply.id]);
    expect(store.findTurnEntry(rejected.id)?.metadata.final_entry_id).toBeNull();
    expect(db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'").all(issue.id)
      .map((row) => JSON.parse((row as { data: string }).data).commentId).filter(id=>!before.includes(id))).toEqual([]);
    expect(emitted).not.toContain("comment:created");
  } finally { unsubscribe(); }
}

// QA's F1 scenario: with the lock-order sentinel off, a real SQL failure in the
// reply's dispatch (the teammate task INSERT) arrives after the reply's COMMIT.
// The leader's task completes, the reply and its log row stay, and the failure
// is logged once.
function verifyLateReplyDispatchFailure(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const previousSentinel = process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL;
  process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL = "0";
  resetLockOrderSentinelEnabledCache();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    const store = new MultiremiStore(db);
    const { issue, task, teammate } = startLeaderRound(store, "rt_reply_late_dispatch");
    rejectWrite(db, backend, "multiremi_turns", "INSERT", `NEW.agent_id = '${teammate.id}'`);
    console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
    try {
      store.completeTask(task.id, { output: `[@Reply teammate](mention://agent/${teammate.id}) Please verify` });
    } finally {
      console.warn = originalWarn;
    }
    expect(store.getTask(task.id)?.status).toBe("completed");
    const reply = store.listIssueComments(issue.id).find((comment) => comment.taskId === task.id);
    expect(reply?.body).toBe(`[@Reply teammate](mention://agent/${teammate.id}) Please verify`);
    expect(store.getConversationLogEntryById(reply!.id)).toMatchObject({ kind: "message", body_md: reply!.body });
    expect(store.findTurnEntry(task.id)?.metadata.final_entry_id).toBe(reply!.id);
    expect(store.listTasksForIssue(issue.id).filter((candidate) => candidate.agentId === teammate.id)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`agent reply comment skipped for ${task.id}`);
    expect(warnings[0]).toContain("write rejected");
  } finally {
    if (previousSentinel === undefined) delete process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL;
    else process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL = previousSentinel;
    resetLockOrderSentinelEnabledCache();
  }
}

function verifyPendingDeliveryMetadata(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const agent = store.createAgent({ name: "Delivery agent", provider: "codex", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const message = db.transaction(() => store.appendChatMessageWithinTransaction({
    chatSessionId: chat.id, role: "system", body: "pending", pendingAgentDelivery: true,
  }))();
  const original = store.getConversationLogEntryById(message.id)!;
  expect(original.metadata.pending_agent_delivery).toBe(true);
  expect(original.metadata.agent_delivery_task_id ?? null).toBeNull();
  store.preparePendingAgentIssueUpdatesForTask(chat.id, "tsk_delivery");
  const prepared = store.getConversationLogEntryById(message.id)!;
  expect(prepared.metadata).toMatchObject({ pending_agent_delivery: true, agent_delivery_task_id: "tsk_delivery" });
  expect(prepared.revision).toBe(original.revision + 1);
  db.transaction(() => store.completePendingAgentIssueUpdatesForTaskWithinTransaction(chat.id, "tsk_delivery"))();
  const completed = store.getConversationLogEntryById(message.id)!;
  expect(completed.metadata).toMatchObject({ pending_agent_delivery: false, agent_delivery_task_id: null });
  expect(completed.revision).toBe(prepared.revision + 1);
  expect(store.getConversationLogEntryById(message.id)?.metadata).toMatchObject({pending_agent_delivery:false,agent_delivery_task_id:null});

  const discardedMessage = db.transaction(() => store.appendChatMessageWithinTransaction({
    chatSessionId: chat.id, role: "system", body: "discard me", pendingAgentDelivery: true,
  }))();
  const beforeDiscard = store.getConversationLogEntryById(discardedMessage.id)!;
  db.transaction(() => store.discardPendingAgentIssueUpdatesWithinTransaction(chat.id))();
  const discarded = store.getConversationLogEntryById(discardedMessage.id)!;
  expect(discarded.id).toBe(beforeDiscard.id);
  expect(discarded.seq).toBe(beforeDiscard.seq);
  expect(discarded.revision).toBe(beforeDiscard.revision + 1);
  expect(discarded.metadata).toMatchObject({ pending_agent_delivery: false, agent_delivery_task_id: null });
  expect(store.getConversationLogEntryById(discardedMessage.id)?.metadata).toMatchObject({pending_agent_delivery:false,agent_delivery_task_id:null});
}

function verifySteerTarget(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const agent = store.createAgent({ name: "Steer agent", provider: "codex", workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Steer target", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work", workspaceId: "local" });
  store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "change" });
  const turn = store.findTurnEntry(task.id)!;
  const steer = store.listConversationLogEntries(turn.session_id).find((entry) => entry.kind === "message" && entry.metadata.steer_target_turn_id === store.getTurnForAttempt(task.id)!.id);
  expect(steer?.body_md).toBe("change");
  expect(steer ? store.getMessage(steer.id)?.to_agent_id : null).toBe(agent.id);
}

function verifyChatTurnTiming(db: SqlDatabase): void {
  const messageSequence = (id: string): number => Number((db.query(
    "SELECT seq AS sequence FROM multiremi_conversation_log WHERE id = ?",
  ).get(id) as { sequence: number | string }).sequence);
  const store = new MultiremiStore(db);
  const runtime = store.registerRuntime({ name: "Chat timing runtime", provider: "codex", workspaceId: "local", daemonId: "chat-timing" });
  const agent = store.createAgent({ name: "Chat timing agent", provider: "codex", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const sent = store.sendChatMessage(chat.id, { content: "Complete me" });
  expect(store.getTurnForAttempt(sent.task.id)?.status).toBe("pending");
  expect(store.claimTask(runtime.id)?.id).toBe(sent.task.id);
  store.startTask(sent.task.id);
  expect(store.findTurnEntry(sent.task.id)?.metadata.status).toBe("running");
  db.transaction(()=>store.createPendingAgentIssueUpdateWithinTransaction(chat.id, "W10 system update"))();
  const bridge = store.getDaemonTurnBridge();
  const input = bridge.offerInput(store.getTaskWithAgent(sent.task.id)!);
  store.listMessages(chat.id, { from: 0, to: input.input_to_seq });
  store.recordSessionAgentRangeRead(chat.id, agent.id, { seq: 1, offset: 0 },
    { seq: input.input_to_seq + 1, offset: 0 }, sent.task.id);
  expect(bridge.rpc("turn.input", {
    turn_id: sent.task.turn_id, attempt_id: sent.task.id, input_to_seq: input.input_to_seq,
    message_ids: input.input_messages.map(message => message.id),
  }, { workspaceId: "local", runtimeId: runtime.id, daemonId: runtime.daemonId! }).ok).toBe(true);
  store.completeTask(sent.task.id, { output: "Completed answer" });
  const completedMessages = store.listChatMessages(chat.id);
  expect(completedMessages.map((message) => message.body)).toEqual(["Complete me", "W10 system update", "Completed answer"]);
  const assistant = completedMessages[2]!;
  const completedTurn = store.findTurnEntry(sent.task.id)!;
  expect(completedTurn.metadata.final_entry_id).toBe(assistant.id);
  expect(completedTurn.seq).toBeLessThan(messageSequence(assistant.id));
  expect(completedTurn.metadata).toMatchObject({ status: "completed", final_reply_md: "Completed answer", elapsed_ms: expect.any(Number) });

  const failedChat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const failing = store.sendChatMessage(failedChat.id, { content: "Fail once" });
  mutateExecutionFixture(db, "UPDATE multiremi_turn_execution_records SET max_attempts = 1 WHERE id = ?", [failing.task.id]);
  expect(store.claimTask(runtime.id)?.id).toBe(failing.task.id);
  store.startTask(failing.task.id);
  store.failTask(failing.task.id, { error: "terminal failure", failureReason: "terminal_failure" });
  const failedTurn = store.findTurnEntry(failing.task.id)!;
  const failedAssistant = store.listChatMessages(failedChat.id).find((message) => message.role === "assistant")!;
  expect(failedTurn.metadata.status).toBe("failed");
  expect(failedTurn.metadata.final_entry_id).toBe(failedAssistant.id);
  expect(failedTurn.seq).toBeLessThan(messageSequence(failedAssistant.id));

  const cancelledChat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const cancelled = store.sendChatMessage(cancelledChat.id, { content: "Cancel me" });
  store.cancelTask(cancelled.task.id);
  expect(store.findTurnEntry(cancelled.task.id)?.metadata.status).toBe("cancelled");
  expect(store.listChatMessages(cancelledChat.id).map((message) => message.body)).toEqual(["Cancel me"]);

  const retryChat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const initial = store.sendChatMessage(retryChat.id, { content: "Retry me" });
  expect(store.claimTask(runtime.id)?.id).toBe(initial.task.id);
  store.startTask(initial.task.id);
  store.failTask(initial.task.id, { error: "context overflow", failureReason: "agent_error.context_overflow" });
  const retry = store.getTask(store.getTurnForAttempt(initial.task.id)!.current_attempt_id!)!;
  expect(retry).toBeDefined();
  expect(retry.id).not.toBe(initial.task.id);
  expect(store.findTurnEntry(initial.task.id)?.id).toBe(store.findTurnEntry(retry.id)?.id);
  expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  store.startTask(retry.id);
  store.completeTask(retry.id, { output: "Retry answer" });
  const retryTurns = store.listConversationLogEntries(retryChat.id).filter((entry) => entry.kind === "turn");
  expect(retryTurns).toHaveLength(1);
  expect(retryTurns[0]?.id).toBe(store.getTurnForAttempt(initial.task.id)!.id);
  expect(retryTurns[0]?.task_id).toBe(retry.id);
  const retryAssistant = store.listChatMessages(retryChat.id).find((message) => message.role === "assistant")!;
  expect(retryTurns[0]?.metadata.final_entry_id).toBe(retryAssistant.id);
  expect(retryTurns[0]?.seq).toBeLessThan(messageSequence(retryAssistant.id));
}

describe("conversation log multi-process allocation (MUL-405)", () => {
  it("SQLite: chat turns appear with assistant messages and preserve message order", async () => {
    await withSqlite(async (db) => verifyChatTurnTiming(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: chat turns appear with assistant messages and preserve message order", async () => {
    await withPostgres(async (db) => verifyChatTurnTiming(db));
  }, 30_000);
  it("SQLite: system comment failure leaves no comment, event, log or activity", async () => {
    await withSqlite(async (db) => verifySystemCommentRollback(db, "sqlite"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: system comment failure leaves no comment, event, log or activity", async () => {
    await withPostgres(async (db) => verifySystemCommentRollback(db, "pg"));
  });
  it("SQLite: a second session head failure rolls back the issue and every head", async () => {
    await withSqlite(async (db) => verifyHeadRollback(db, "sqlite", 1));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a second session head failure rolls back the issue and every head", async () => {
    await withPostgres(async (db) => verifyHeadRollback(db, "pg", 1));
  });
  it("SQLite: a first session head failure rolls back the issue", async () => {
    await withSqlite(async (db) => verifyHeadRollback(db, "sqlite", 0));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a first session head failure rolls back the issue", async () => {
    await withPostgres(async (db) => verifyHeadRollback(db, "pg", 0));
  });
  it("SQLite: final reply card links to its comment and ignores a failed comment", async () => {
    await withSqlite(async (db) => verifyFinalReplyReference(db, "sqlite"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: final reply card links to its comment and ignores a failed comment", async () => {
    await withPostgres(async (db) => verifyFinalReplyReference(db, "pg"));
  });
  it("SQLite: an automatic reply pushes and dispatches only after its own COMMIT", async () => {
    await withSqlite(async (db) => verifyReplyDispatchAfterCommit(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: an automatic reply pushes and dispatches only after its own COMMIT", async () => {
    await withPostgres(async (db) => verifyReplyDispatchAfterCommit(db));
  }, 30_000);
  it("SQLite: an automatic reply commits with its turn card's final_entry_id or not at all", async () => {
    await withSqlite(async (db) => verifyReplyCommitsWithFinalEntry(db, "sqlite"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: an automatic reply commits with its turn card's final_entry_id or not at all", async () => {
    await withPostgres(async (db) => verifyReplyCommitsWithFinalEntry(db, "pg"));
  }, 30_000);
  it("SQLite: a late automatic-reply dispatch failure keeps the reply and completes the task", async () => {
    await withSqlite(async (db) => verifyLateReplyDispatchFailure(db, "sqlite"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a late automatic-reply dispatch failure keeps the reply and completes the task", async () => {
    await withPostgres(async (db) => verifyLateReplyDispatchFailure(db, "pg"));
  }, 30_000);
  it("SQLite: pending delivery changes patch the hidden log metadata", async () => {
    await withSqlite(async (db) => verifyPendingDeliveryMetadata(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: pending delivery changes patch the hidden log metadata", async () => {
    await withPostgres(async (db) => verifyPendingDeliveryMetadata(db));
  });
  it("SQLite: task steer points at its turn seq", async () => {
    await withSqlite(async (db) => verifySteerTarget(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: task steer points at its turn seq", async () => {
    await withPostgres(async (db) => verifySteerTarget(db));
  });
  it("SQLite: nested transactions roll back only failed savepoints", async () => {
    await withSqlite(async (db) => verifyNestedTransactions(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: nested transactions roll back only failed savepoints", async () => {
    await withPostgres(async (db) => verifyNestedTransactions(db));
  });
  // MUL-402 QA F3 (cmt_1khg3kqww3q5): the peak was raised only on the outer
  // BEGIN, so a helper that added a SAVEPOINT frame still read as depth 1 and
  // every PG `maxTransactionDepth` guard missed it. Main (01810898) raises the
  // peak on every frame; the depth-1 guards depend on that (ADR 0011).
  it.skipIf(!pgAdminUrl)("Postgres: maxTransactionDepth counts every nested frame, as on main", async () => {
    await withPostgres(async (db) => {
      const depthNow = () => (db as unknown as { transactionDepth: number }).transactionDepth;
      let observed = 0;
      db.resetTransactionDepthStats();
      db.transaction(() => db.transaction(() => { observed = depthNow(); })())();
      expect(observed).toBe(2);
      expect(db.maxTransactionDepth).toBe(2);

      db.resetTransactionDepthStats();
      db.transaction(() => {})();
      expect(db.maxTransactionDepth).toBe(1);

      // A nested frame that rolls back is still a frame.
      db.resetTransactionDepthStats();
      db.transaction(() => {
        try { db.transaction(() => db.transaction(() => { throw new Error("inner"); })())(); } catch { /* outer continues */ }
      })();
      expect(db.maxTransactionDepth).toBe(3);
    });
  });
  // Senior ruling cmt_96e1yqxgifms §3: main's rollback path, without the extra
  // RELEASE SAVEPOINT that B1 sent after ROLLBACK TO SAVEPOINT.
  it.skipIf(!pgAdminUrl)("Postgres: a failed savepoint rolls back to itself with no second RELEASE, as on main", async () => {
    await withPostgres(async (db) => {
      db.exec("CREATE TABLE savepoint_control_case (n INTEGER PRIMARY KEY)");
      const controls: string[] = [];
      const target = db as unknown as { execute(sql: string, params: unknown[]): unknown };
      const execute = target.execute.bind(db);
      target.execute = (sql, params) => {
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql.trim())) controls.push(sql.trim());
        return execute(sql, params);
      };
      db.transaction(() => {
        db.run("INSERT INTO savepoint_control_case (n) VALUES (1)");
        try {
          db.transaction(() => db.run("INSERT INTO savepoint_control_case (n) VALUES (1)"))();
        } catch { /* the outer transaction continues */ }
        db.transaction(() => db.run("INSERT INTO savepoint_control_case (n) VALUES (2)"))();
      })();
      expect(controls).toEqual([
        "BEGIN",
        "SAVEPOINT multiremi_sp_1",
        "ROLLBACK TO SAVEPOINT multiremi_sp_1",
        "SAVEPOINT multiremi_sp_1",
        "RELEASE SAVEPOINT multiremi_sp_1",
        "COMMIT",
      ]);
      expect(db.query("SELECT n FROM savepoint_control_case ORDER BY n").all().map((row: any) => Number(row.n))).toEqual([1, 2]);
    });
  });
  for (const nested of [false, true]) {
    const label = nested ? "inside a savepoint" : "in the outer transaction";
    it(`SQLite: a caught local reply failure ${label} still commits`, async () => {
      await withSqlite(async (db) => verifyCaughtLocalReplyFailure(db, nested));
    });
    it.skipIf(!pgAdminUrl)(`Postgres: a caught local reply failure ${label} still commits`, async () => {
      await withPostgres(async (db) => verifyCaughtLocalReplyFailure(db, nested));
    });
  }
  it("SQLite: Issue comments do not enter the legacy update queue", async () => {
    await withSqlite(async (db) => verifyLegacyIssueUpdateQueueIsUnused(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: Issue comments do not enter the legacy update queue", async () => {
    await withPostgres(async (db) => verifyLegacyIssueUpdateQueueIsUnused(db));
  });
  it("SQLite: round aggregation stays before an in-transaction flush", async () => {
    await withSqlite(async (db) => verifyQueueBeforeFlush(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: round aggregation stays before an in-transaction flush", async () => {
    await withPostgres(async (db) => verifyQueueBeforeFlush(db));
  }, 30_000);
  it("SQLite: failed best-effort workspace queries keep a system comment", async () => {
    await withSqlite(async (db) => verifyBestEffortWorkspaceLookups(db, "sqlite"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: failed best-effort workspace queries keep a system comment", async () => {
    await withPostgres(async (db) => verifyBestEffortWorkspaceLookups(db, "pg"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a real workspace SQL error inside an outer transaction fails the write", async () => {
    await withPostgres(async (db) => {
      const store = new MultiremiStore(db);
      const issue = createResponsibleTestIssue(store, { title: "Outer transaction lookup", workspaceId: "local" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      const context = (store as unknown as { ctx: { issueWorkspaceId: (id: string) => string | null } }).ctx;
      const originalLookup = context.issueWorkspaceId.bind(context);
      let lookups = 0;
      let failedQueries = 0;
      context.issueWorkspaceId = (id) => {
        if (++lookups === 1) return originalLookup(id);
        failedQueries += 1;
        return db.query("SELECT missing_workspace_column FROM multiremi_issues WHERE id = ?").get(id);
      };
      // Senior ruling cmt_96e1yqxgifms §2: with the savepoint gone, a real SQL
      // error is no longer a survivable best-effort miss — it aborts the
      // caller's transaction and `failedAtDepth` refuses the COMMIT, so the
      // system comment must not be written. Only the bridge-reply failure above
      // is classified as non-aborting.
      expect(() => db.transaction(() => {
        expect(db.inTransaction).toBe(true);
        store.createTaskFailureSystemComment(issue.id, session.id, "tsk_outer_lookup", "system must not survive");
      })()).toThrow(/unrecovered statement failure|current transaction is aborted/);
      expect(failedQueries).toBeGreaterThan(0);
      expect(db.inTransaction).toBe(false);
      expect(db.query("SELECT id FROM multiremi_issue_comments WHERE issue_id = ?").all(issue.id)).toEqual([]);
      // The session's head counter row (`head_…`) is written before the
      // transaction and is not part of the atomic unit; every mirrored entry
      // would carry the comment's `cmt_…` id.
      expect(db.query("SELECT id FROM multiremi_conversation_log WHERE session_id = ? AND id NOT LIKE 'head_%'").all(session.id)).toEqual([]);
      // `issue_created` predates the transaction; the comment's own activity is
      // the one that must not survive the rollback.
      expect(db.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'").all(issue.id)).toEqual([]);
    });
  });
  it("SQLite: a mandatory activity origin SQL error rolls back the entire system comment", async () => {
    await withSqlite(async (db) => verifyMandatoryActivityOriginFailure(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a mandatory activity origin SQL error rolls back the entire system comment", async () => {
    await withPostgres(async (db) => verifyMandatoryActivityOriginFailure(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a worker reply exceeding its shared buffer still commits", async () => {
    await withPostgres(async (db, url) => {
      const limited = new PostgresSyncDatabase(url, 2048);
      try {
        limited.exec("CREATE TABLE worker_reply_case (n INTEGER PRIMARY KEY)");
        limited.transaction(() => {
          limited.run("INSERT INTO worker_reply_case (n) VALUES (1)");
          let caught = false;
          try {
            limited.query("SELECT repeat('x', 4000) AS payload").get();
          } catch (error) {
            expect((error as Error).message).toContain("postgres bridge result too large");
            expect((limited as any).failedAtDepth).toBeNull();
            caught = true;
          }
          expect(caught).toBe(true);
          limited.run("INSERT INTO worker_reply_case (n) VALUES (2)");
        })();
        expect(db.query("SELECT n FROM worker_reply_case ORDER BY n").all().map((row: any) => Number(row.n))).toEqual([1, 2]);
      } finally {
        limited.close();
      }
    });
  });
  for (const nested of [false, true]) {
    it.skipIf(!pgAdminUrl)(`Postgres: an oversized server error caught ${nested ? "inside a savepoint" : "in the outer transaction"} rolls back`, async () => {
      await withPostgres(async (db, url) => {
        const limited = new PostgresSyncDatabase(url, 2048);
        try {
          limited.exec("CREATE TABLE worker_error_case (n INTEGER PRIMARY KEY)");
          const observed: { message: string | null; depth: number | null } = { message: null, depth: null };
          let transactionError: unknown = null;
          try {
            limited.transaction(() => {
              limited.run("INSERT INTO worker_error_case (n) VALUES (1)");
              limited.run("INSERT INTO worker_error_case (n) VALUES (2)");
              const caughtQuery = () => {
                try {
                  limited.query("DO $$ BEGIN RAISE EXCEPTION '%', repeat('x', 4000); END $$").run();
                } catch (error) {
                  observed.message = (error as Error).message;
                  observed.depth = (limited as any).failedAtDepth;
                }
              };
              if (nested) limited.transaction(caughtQuery)();
              else caughtQuery();
            })();
          } catch (error) {
            transactionError = error;
          }
          expect(observed.message).toContain("postgres: " + "x".repeat(128));
          expect(observed.message).toMatch(/…\(truncated, \d+ bytes\)/);
          expect(observed.depth).toBe(nested ? 2 : 1);
          expect(transactionError).toBeInstanceOf(Error);
          expect(db.query("SELECT n FROM worker_error_case").all()).toEqual([]);
        } finally {
          limited.close();
        }
      });
    });
  }
  it.skipIf(!pgAdminUrl)("Postgres: a caught bare SQL failure aborts the outer transaction", async () => {
    await withPostgres(async (db) => {
      db.exec("CREATE TABLE bare_failure_case (n INTEGER PRIMARY KEY)");
      // The message is the point: main used to hand the COMMIT to PostgreSQL and
      // treat its `ROLLBACK` label as success (silent data loss). B1's
      // `failedAtDepth` must surface the swallowed failure before that.
      expect(() => db.transaction(() => {
        db.run("INSERT INTO bare_failure_case (n) VALUES (1)");
        try { db.run("INSERT INTO bare_failure_case (n) VALUES (1)"); } catch { /* deliberately swallowed */ }
      })()).toThrow("unrecovered statement failure");
      expect(db.query("SELECT n FROM bare_failure_case").all()).toEqual([]);
    });
  });
  it.skipIf(!pgAdminUrl)("Postgres: a COMMIT whose reply says ROLLBACK is refused", async () => {
    await withPostgres(async (db) => {
      db.exec("CREATE TABLE commit_label_case (n INTEGER PRIMARY KEY)");
      expect(() => db.transaction(() => {
        db.run("INSERT INTO commit_label_case (n) VALUES (1)");
        try { db.run("INSERT INTO commit_label_case (n) VALUES (1)"); } catch { /* swallowed */ }
        // Second net under the one above: with failedAtDepth cleared, the
        // transaction is still aborted server-side and COMMIT answers
        // `ROLLBACK`. Treating that reply as success would report a committed
        // write that PostgreSQL threw away.
        (db as unknown as { failedAtDepth: number | null }).failedAtDepth = null;
      })()).toThrow("Postgres rolled back an aborted transaction at COMMIT");
      expect(db.query("SELECT n FROM commit_label_case").all()).toEqual([]);
    });
  });
  it("SQLite: restart continues canonical issue and chat sequences, including concurrent first writes", async () => {
    await withSqlite((db, path) => verifyLegacyFirstWrites(db, "sqlite", path));
  }, 30_000);
  it.skipIf(!pgAdminUrl)("Postgres: restart continues canonical issue and chat sequences, including concurrent first writes", async () => {
    await withPostgres((db, url) => verifyLegacyFirstWrites(db, "pg", url));
  }, 30_000);
  it("SQLite: four processes cold-start the migration", async () => {
    await withSqlite(async (db, path) => {
      await runFour("sqlite", path, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    }, true);
  }, 30_000);
  it("SQLite: four processes append without duplicate or missing seq", async () => {
    await withSqlite(async (db, path) => {
      const store = new MultiremiStore(db);
      const session = store.getOrCreateDefaultIssueSession(createResponsibleTestIssue(store, {title:"Concurrent",workspaceId:"local"}).id);
      await runFour("sqlite", path, "append", session.id);
      assertContiguous(db, session.id);
    });
  });
  // 30 s budget for the two cases below; their assertions are untouched.
  //
  // MUL-405 wraps the whole migration run in a session-level advisory lock
  // (`advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, …)` in `runMigrations`), so
  // four processes that each open the store serialize on it instead of
  // migrating in parallel. That is deliberate — the lock is what makes
  // concurrent startup safe — but it costs wall time here: measured against an
  // already-migrated database, four concurrent opens take 3666 / 2738 / 1778 /
  // 925 ms (wall 3.88 s) where the pre-merge tree ran the same four in parallel
  // at ~930 ms each (wall 1.15 s), and a single open is 976 ms. The two cases
  // below therefore go from 5.84 s wall together (2.9 s each, pre-merge tree)
  // to 11.43 s with the lock, 5.88 s and 6.03 s for the two of them on their
  // own — each one crosses the 5 s default budget. The whole file goes from
  // 61.5 s to 69-71 s; the file total is dominated by the other PG cases.
  //
  // The budget is not what the cases assert (one migration row, and a
  // contiguous seq per reader), and the lock is main's design, so the timeout
  // moves rather than the assertion. Parent ruling on the MUL-402 sync round,
  // overturnable: if ~950 ms per open on an already-migrated database is judged
  // a defect in MUL-405's lock, it gets its own issue and this budget reverts.
  it.skipIf(!pgAdminUrl)("Postgres: four processes cold-start the migration", async () => {
    await withPostgres(async (db, url) => {
      await runFour("pg", url, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    }, true);
  }, 30_000);
  it.skipIf(!pgAdminUrl)("Postgres: four processes append without duplicate or missing seq", async () => {
    await withPostgres(async (db, url) => {
      const store = new MultiremiStore(db);
      const session = store.getOrCreateDefaultIssueSession(createResponsibleTestIssue(store, {title:"Concurrent",workspaceId:"local"}).id);
      await runFour("pg", url, "append", session.id);
      assertContiguous(db, session.id);
    });
  }, 30_000); // same migration-advisory-lock serialization; see the note above
  it.skipIf(!pgAdminUrl)("Postgres: rolls back a comment and its mirrored log row together", async () => {
    await withPostgres(async (db) => {
      const store = new MultiremiStore(db);
      const issue = createResponsibleTestIssue(store, { title: "PG comment rollback", workspaceId: "local" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      let commentId = "";
      expect(() => db.transaction(() => {
        commentId = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "discard" }).id;
        throw new Error("rollback");
      })()).toThrow("rollback");
      expect(store.getIssueComment(commentId)).toBeNull();
      expect(store.getConversationLogEntryById(commentId)).toBeNull();
    });
  });
});
