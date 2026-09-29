import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresReplyTooLargeError, PostgresSyncDatabase, resetDbReplyLimitForTest, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { resetLockOrderSentinelEnabledCache } from "@multiremi/store/lock-order-sentinel.js";

const worker = new URL("./fixtures/conversation-log-process.ts", import.meta.url).pathname;
const migrationId = "20260927_conversation_log";
const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

async function runFour(backend: "sqlite" | "pg", target: string, operation: "migrate" | "append"): Promise<void> {
  const children = Array.from({ length: 4 }, () => Bun.spawn({
    cmd: [process.execPath, worker, backend, target, operation, "ises_concurrent", "25"],
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

function resetMigration(db: SqlDatabase): void {
  db.exec("DROP TABLE multiremi_conversation_log; DROP TABLE multiremi_conversation_heads;");
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
}

function assertContiguous(db: SqlDatabase): void {
  const rows = db.query("SELECT seq FROM multiremi_conversation_log WHERE session_id = ? ORDER BY seq ASC")
    .all("ises_concurrent") as Array<{ seq: number }>;
  expect(rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  const head = db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?")
    .get("ises_concurrent") as { head_seq: number };
  expect(Number(head.head_seq)).toBe(100);
}

async function withSqlite(run: (db: Database, path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mul426-sqlite-"));
  const path = join(dir, "test.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000");
  new MultiremiStore(db);
  try { await run(db, path); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function withPostgres(run: (db: PostgresSyncDatabase, url: string) => Promise<void>): Promise<void> {
  const name = `mul426_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try {
    new MultiremiStore(db);
    await run(db, url.toString());
  } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

async function verifyLegacyFirstWrites(db: SqlDatabase, backend: "sqlite" | "pg", target: string): Promise<void> {
  const store = new MultiremiStore(db);
  const issue = store.createIssue({ title: "Legacy issue", workspaceId: "local" });
  const direct = store.getOrCreateDefaultIssueSession(issue.id);
  const renamed = store.createIssueSession(issue.id, { title: "Other session" });
  const concurrent = store.createIssueSession(issue.id, { title: "Concurrent session" });
  const agent = store.createAgent({ name: "Legacy chat agent", provider: "codex", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const now = new Date().toISOString();
  for (const session of [direct, renamed, concurrent]) {
    db.run("DELETE FROM multiremi_session_events WHERE session_id = ?", [session.id]);
    for (let seq = 1; seq <= 3; seq++) {
      db.run(
        "INSERT INTO multiremi_session_events (id, session_id, seq, author_type, kind, body, created_at) VALUES (?, ?, ?, 'system', 'system', ?, ?)",
        [`sevt_legacy_${session.id}_${seq}`, session.id, seq, `legacy ${seq}`, now],
      );
    }
  }
  for (let seq = 1; seq <= 3; seq++) {
    db.run("INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, sequence, created_at) VALUES (?, ?, 'system', ?, ?, ?)",
      [`msg_legacy_${seq}`, chat.id, `old ${seq}`, seq, now]);
  }
  db.run("UPDATE multiremi_chat_sessions SET message_sequence = 3 WHERE id = ?", [chat.id]);
  resetMigration(db);
  const migrated = new MultiremiStore(db);
  const comment = migrated.createIssueComment(issue.id, { issueSessionId: direct.id, body: "new" });
  expect(migrated.getConversationLogEntryById(comment.id)?.seq).toBe(4);
  migrated.updateIssue(issue.id, { title: "Renamed legacy issue" });
  const afterRename = migrated.createIssueComment(issue.id, { issueSessionId: renamed.id, body: "after title" });
  expect(migrated.getConversationLogEntryById(afterRename.id)?.seq).toBe(4);
  expect(migrated.getConversationLogHead(renamed.id)?.headSeq).toBe(4);
  const chatMessage = migrated.sendChatMessage(chat.id, { content: "continued chat" }).message;
  expect(migrated.getConversationLogEntryById(chatMessage.id)?.seq).toBe(4);
  migrated.resolveIssueComment(comment.id);
  expect(migrated.listSessionEvents(direct.id, { sinceSeq: 2 }).map((event) => event.seq)).toEqual([3, 4, 5]);
  expect(migrated.listSessionEvents(direct.id, { sinceSeq: 2, toSeq: 4 }).map((event) => event.seq)).toEqual([3, 4]);
  expect(migrated.listSessionEvents(direct.id, { sinceSeq: 4, toSeq: 5 })[0]?.kind).toBe("thread_resolved");
  const app = createMultiremiApp({ store: migrated });
  const response = await app.request(`/api/issues/${issue.id}/sessions/${direct.id}/events?since_seq=2&to_seq=5`);
  expect(response.status).toBe(200);
  const wire = await response.json() as Array<{ seq: number; kind: string }>;
  expect(wire.map((event) => event.seq)).toEqual([3, 4, 5]);
  expect(wire[2]?.kind).toBe("thread_resolved");
  await runFirstComments(backend, target, concurrent.id);
  expect(migrated.listSessionEvents(concurrent.id).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
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

function verifyCaughtLocalReplyFailure(db: SqlDatabase, nested: boolean): void {
  db.exec("CREATE TABLE local_reply_case (n INTEGER PRIMARY KEY)");
  const previousLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "200";
  resetDbReplyLimitForTest();
  try {
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
  } finally {
    if (previousLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
    else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousLimit;
    resetDbReplyLimitForTest();
  }
}

/**
 * Senior ruling cmt_96e1yqxgifms §2: the agent-issue-update queue is a
 * best-effort side effect, so it rides `afterCommit` instead of a savepoint
 * around the caller's transaction. The queue write therefore runs *after* the
 * COMMIT — it cannot be rolled back into the comment's atomic unit, and a
 * failure there must leave the comment, its Session event, its log row and its
 * activity row durable while only the queue row is missing.
 */
function verifyBestEffortQueueAfterCommit(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const issue = store.createIssue({ title: "Best effort queue", workspaceId: "local" });
  db.exec("CREATE TABLE best_effort_queue_case (n INTEGER PRIMARY KEY)");
  const queueRun: { inTransaction: boolean | null } = { inTransaction: null };
  store.queueAgentIssueUpdate = () => {
    queueRun.inTransaction = db.inTransaction ?? null;
    // One statement, so a failure leaves no partial queue row either way.
    db.run("INSERT INTO best_effort_queue_case (n) VALUES (1),(1)");
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    const comment = store.createIssueComment(issue.id, { body: "comment survives queue error" });
    expect(store.getIssueComment(comment.id)?.body).toBe("comment survives queue error");
    expect(store.getConversationLogEntryById(comment.id)?.body_md).toBe("comment survives queue error");
    expect(warnings.some((line) => line.includes("agent issue update queue skipped"))).toBe(true);
  } finally {
    console.warn = originalWarn;
  }
  // The queue call itself ran after the commit, with no transaction left to
  // poison; its own SQL failure left no queue row and reached nobody.
  expect(queueRun.inTransaction).toBe(false);
  expect(db.query("SELECT n FROM best_effort_queue_case").all()).toEqual([]);
}

/**
 * Senior ruling cmt_96e1yqxgifms §2: the workspace lookup behind the two
 * best-effort broadcasts is a plain read now, with no savepoint around it. On
 * PostgreSQL that means a *real* SQL error poisons the caller's transaction and
 * the write must fail (see the outer-transaction case below); what still has to
 * be survived is the failure the database classifies as non-aborting —
 * `PgBridgeFailure(abortsTransaction: false)` from an oversized bridge reply.
 * The SQLite handle does not abort on a statement error, so it keeps exercising
 * the plain-error path unchanged.
 */
function verifyBestEffortWorkspaceLookups(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const store = new MultiremiStore(db);
  const issue = store.createIssue({ title: "Best effort lookups", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const context = (store as unknown as { ctx: { issueWorkspaceId: (id: string) => string | null } }).ctx;
  const previousReplyLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  if (backend === "pg") {
    context.issueWorkspaceId = (id) => {
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
    context.issueWorkspaceId = (id) => db.query("SELECT missing_workspace_column FROM multiremi_issues WHERE id = ?").get(id);
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
      resetDbReplyLimitForTest();
    }
    expect(store.getIssueComment(comment.id)?.body).toBe("system survives query error");
    expect(store.getConversationLogEntryById(comment.id)?.body_md).toBe("system survives query error");
    expect(warnings.some((line) => line.includes("activity:created broadcast skipped"))).toBe(true);
    expect(warnings.some((line) => line.includes("comment:created broadcast skipped"))).toBe(true);
  } finally {
    console.warn = originalWarn;
  }
}

function rejectWrite(db: SqlDatabase, backend: "sqlite" | "pg", table: string, operation: "INSERT" | "UPDATE", condition: string): void {
  if (backend === "pg") {
    db.run("CREATE FUNCTION reject_conversation_write() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'write rejected'; END; $$ LANGUAGE plpgsql");
    db.run(`CREATE TRIGGER reject_conversation_write BEFORE ${operation} ON ${table}
      FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION reject_conversation_write()`);
  } else {
    db.exec(`CREATE TRIGGER reject_conversation_write BEFORE ${operation} ON ${table}
      FOR EACH ROW WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'write rejected'); END`);
  }
}

function verifySystemCommentRollback(db: SqlDatabase, backend: "sqlite" | "pg"): void {
  const store = new MultiremiStore(db);
  const issue = store.createIssue({ title: "System rollback", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  rejectWrite(db, backend, "multiremi_conversation_log", "INSERT", "NEW.kind = 'system'");
  expect(() => store.createTaskFailureSystemComment(issue.id, session.id, "tsk_failure", "blocked"))
    .toThrow("write rejected");
  expect(store.listIssueComments(issue.id)).toEqual([]);
  expect(store.listSessionEvents(session.id)).toEqual([]);
  expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind === "system")).toEqual([]);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'")
    .get(issue.id) as { n: number | string }).n)).toBe(0);

  const agent = store.createAgent({ name: "Parent assignee", provider: "codex", workspaceId: "local" });
  store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: agent.id });
  const child = store.createIssue({ title: "Child", parentIssueId: issue.id, workspaceId: "local" });
  const beforeTasks = Number((db.query("SELECT COUNT(*) AS n FROM multiremi_tasks WHERE issue_id = ?")
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
  // MUL-406 S1 (ADR 0003): child status commits; the notification hook transaction rolls back in full.
  expect(() => store.updateIssue(child.id, { status: "done" })).toThrow("write rejected");
  expect(store.getIssue(child.id)?.status).toBe("done");
  expect(store.listIssueComments(issue.id)).toEqual(beforeComments);
  expect(store.listSessionEvents(session.id)).toHaveLength(beforeEvents);
  expect(parentLog()).toEqual(beforeLog);
  expect(store.getConversationLogHead(session.id)?.headSeq).toBe(beforeHeadSeq);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n)).toBe(beforeActivity);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_tasks WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n)).toBe(beforeTasks);
  expect(store.getIssue(issue.id)?.status).toBe(beforeStatus);
}

function verifyHeadRollback(db: SqlDatabase, backend: "sqlite" | "pg", rejectedIndex: 0 | 1): void {
  const store = new MultiremiStore(db);
  const issue = store.createIssue({ title: "Old title", workspaceId: "local" });
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
  const issue = store.createIssue({ title: "Reply reference", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "reply", workspaceId: "local" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  store.completeTask(task.id, { output: "Final answer" });
  const comment = store.listIssueComments(issue.id)[0]!;
  expect(store.findTurnEntry(task.id)?.metadata.final_entry_id).toBe(comment.id);

  const failed = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retry", workspaceId: "local" });
  expect(store.claimTask(runtime.id)?.id).toBe(failed.id);
  store.startTask(failed.id);
  rejectWrite(db, backend, "multiremi_issue_comments", "INSERT", "NEW.body = 'Blocked answer'");
  store.completeTask(failed.id, { output: "Blocked answer" });
  expect(store.findTurnEntry(failed.id)?.metadata).toMatchObject({ status: "completed", final_entry_id: null });
  expect(store.listIssueComments(issue.id)).toHaveLength(1);
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
  const issue = store.createIssue({ title: "Reply commit", workspaceId: "local", assigneeType: "squad", assigneeId: squad.id });
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
  const issue = store.createIssue({ title: "Final entry", workspaceId: "local" });
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

  // Reject only the reply's own card update; the terminal transaction writes
  // `final_entry_id: null` and must still go through.
  rejectWrite(db, backend, "multiremi_conversation_log", "UPDATE", backend === "pg"
    ? "NEW.kind = 'turn' AND (NEW.metadata::jsonb ->> 'final_entry_id') IS NOT NULL"
    : "NEW.kind = 'turn' AND json_extract(NEW.metadata, '$.final_entry_id') IS NOT NULL");
  const emitted: string[] = [];
  const unsubscribe = store.onWorkspaceEvent((event) => emitted.push(event.type));
  try {
    const rejected = completeRound("Rolled back answer");
    expect(store.getTask(rejected.id)?.status).toBe("completed");
    expect(store.listIssueComments(issue.id).map((comment) => comment.id)).toEqual([reply.id]);
    // Comment log rows carry no task_id, so count the session's message rows.
    expect(store.listConversationLogEntries(session.id).filter((entry) => entry.kind === "message")
      .map((entry) => entry.id)).toEqual([reply.id]);
    expect(store.findTurnEntry(rejected.id)?.metadata.final_entry_id).toBeNull();
    expect(db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'").all(issue.id)
      .map((row) => JSON.parse((row as { data: string }).data).commentId)).toEqual([reply.id]);
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
    rejectWrite(db, backend, "multiremi_tasks", "INSERT", `NEW.agent_id = '${teammate.id}'`);
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
  expect(db.query("SELECT pending_agent_delivery, agent_delivery_task_id FROM multiremi_chat_messages WHERE id = ?")
    .get(message.id)).toEqual({ pending_agent_delivery: 0, agent_delivery_task_id: null });

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
  expect(db.query("SELECT pending_agent_delivery, agent_delivery_task_id FROM multiremi_chat_messages WHERE id = ?")
    .get(discardedMessage.id)).toEqual({ pending_agent_delivery: 0, agent_delivery_task_id: null });
}

function verifySteerTarget(db: SqlDatabase): void {
  const store = new MultiremiStore(db);
  const agent = store.createAgent({ name: "Steer agent", provider: "codex", workspaceId: "local" });
  const issue = store.createIssue({ title: "Steer target", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work", workspaceId: "local" });
  store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "change" });
  const turn = store.findTurnEntry(task.id)!;
  const steer = store.listConversationLogEntries(turn.session_id).find((entry) => entry.kind === "task_steer");
  expect(steer?.metadata.target_seq).toBe(turn.seq);
}

function verifyChatTurnTiming(db: SqlDatabase): void {
  const messageSequence = (id: string): number => Number((db.query(
    "SELECT sequence FROM multiremi_chat_messages WHERE id = ?",
  ).get(id) as { sequence: number | string }).sequence);
  const store = new MultiremiStore(db);
  const runtime = store.registerRuntime({ name: "Chat timing runtime", provider: "codex", workspaceId: "local" });
  const agent = store.createAgent({ name: "Chat timing agent", provider: "codex", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const sent = store.sendChatMessage(chat.id, { content: "Complete me" });
  expect(store.findTurnEntry(sent.task.id)).toBeNull();
  expect(store.claimTask(runtime.id)?.id).toBe(sent.task.id);
  store.startTask(sent.task.id);
  expect(store.findTurnEntry(sent.task.id)).toBeNull();
  store.createPendingAgentIssueUpdateWithinTransaction(chat.id, "W10 system update");
  store.completeTask(sent.task.id, { output: "Completed answer" });
  const completedMessages = store.listChatMessages(chat.id);
  expect(completedMessages.map((message) => message.body)).toEqual(["Complete me", "W10 system update", "Completed answer"]);
  const assistant = completedMessages[2]!;
  const completedTurn = store.findTurnEntry(sent.task.id)!;
  expect(completedTurn.id).toBe(assistant.id);
  expect(completedTurn.seq).toBe(messageSequence(assistant.id));
  expect(completedTurn.metadata).toMatchObject({ status: "completed", final_reply_md: "Completed answer", elapsed_ms: expect.any(Number) });

  const failedChat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const failing = store.sendChatMessage(failedChat.id, { content: "Fail once" });
  db.run("UPDATE multiremi_tasks SET max_attempts = 1 WHERE id = ?", [failing.task.id]);
  expect(store.claimTask(runtime.id)?.id).toBe(failing.task.id);
  store.startTask(failing.task.id);
  store.failTask(failing.task.id, { error: "terminal failure", failureReason: "terminal_failure" });
  const failedTurn = store.findTurnEntry(failing.task.id)!;
  const failedAssistant = store.listChatMessages(failedChat.id).find((message) => message.role === "assistant")!;
  expect(failedTurn.metadata.status).toBe("failed");
  expect(failedTurn.id).toBe(failedAssistant.id);
  expect(failedTurn.seq).toBe(messageSequence(failedAssistant.id));

  const cancelledChat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const cancelled = store.sendChatMessage(cancelledChat.id, { content: "Cancel me" });
  store.cancelTask(cancelled.task.id);
  expect(store.findTurnEntry(cancelled.task.id)).toBeNull();
  expect(store.listChatMessages(cancelledChat.id).map((message) => message.body)).toEqual(["Cancel me"]);

  const retryChat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
  const initial = store.sendChatMessage(retryChat.id, { content: "Retry me" });
  expect(store.claimTask(runtime.id)?.id).toBe(initial.task.id);
  store.startTask(initial.task.id);
  store.failTask(initial.task.id, { error: "context overflow", failureReason: "agent_error.context_overflow" });
  const retry = store.listTasks().find((task) => task.parentTaskId === initial.task.id)!;
  expect(retry).toBeDefined();
  expect(store.findTurnEntry(initial.task.id)).toBeNull();
  expect(store.findTurnEntry(retry.id)).toBeNull();
  expect(store.claimTask(runtime.id)?.id).toBe(retry.id);
  store.startTask(retry.id);
  store.completeTask(retry.id, { output: "Retry answer" });
  const retryTurns = store.listConversationLogEntries(retryChat.id).filter((entry) => entry.kind === "turn");
  expect(retryTurns).toHaveLength(1);
  expect(retryTurns[0]?.task_id).toBe(retry.id);
  const retryAssistant = store.listChatMessages(retryChat.id).find((message) => message.role === "assistant")!;
  expect(retryTurns[0]?.id).toBe(retryAssistant.id);
  expect(retryTurns[0]?.seq).toBe(messageSequence(retryAssistant.id));
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
  for (const nested of [false, true]) {
    const label = nested ? "inside a savepoint" : "in the outer transaction";
    it(`SQLite: a caught local reply failure ${label} still commits`, async () => {
      await withSqlite(async (db) => verifyCaughtLocalReplyFailure(db, nested));
    });
    it.skipIf(!pgAdminUrl)(`Postgres: a caught local reply failure ${label} still commits`, async () => {
      await withPostgres(async (db) => verifyCaughtLocalReplyFailure(db, nested));
    });
  }
  it("SQLite: a best-effort queue failure after COMMIT keeps the comment and leaves no queue row", async () => {
    await withSqlite(async (db) => verifyBestEffortQueueAfterCommit(db));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a best-effort queue failure after COMMIT keeps the comment and leaves no queue row", async () => {
    await withPostgres(async (db) => verifyBestEffortQueueAfterCommit(db));
  });
  it("SQLite: failed best-effort workspace queries keep a system comment", async () => {
    await withSqlite(async (db) => verifyBestEffortWorkspaceLookups(db, "sqlite"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: failed best-effort workspace queries keep a system comment", async () => {
    await withPostgres(async (db) => verifyBestEffortWorkspaceLookups(db, "pg"));
  });
  it.skipIf(!pgAdminUrl)("Postgres: a real workspace SQL error inside an outer transaction fails the write", async () => {
    await withPostgres(async (db) => {
      const store = new MultiremiStore(db);
      const issue = store.createIssue({ title: "Outer transaction lookup", workspaceId: "local" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      const context = (store as unknown as { ctx: { issueWorkspaceId: (id: string) => string | null } }).ctx;
      let failedQueries = 0;
      context.issueWorkspaceId = (id) => {
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
  it("SQLite: cold migration continues legacy issue and chat sequences, including concurrent first writes", async () => {
    await withSqlite((db, path) => verifyLegacyFirstWrites(db, "sqlite", path));
  }, 30_000);
  it.skipIf(!pgAdminUrl)("Postgres: cold migration continues legacy issue and chat sequences, including concurrent first writes", async () => {
    await withPostgres((db, url) => verifyLegacyFirstWrites(db, "pg", url));
  }, 30_000);
  it("SQLite: four processes cold-start the migration", async () => {
    await withSqlite(async (db, path) => {
      resetMigration(db);
      await runFour("sqlite", path, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    });
  }, 30_000);
  it("SQLite: four processes append without duplicate or missing seq", async () => {
    await withSqlite(async (db, path) => {
      await runFour("sqlite", path, "append");
      assertContiguous(db);
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
      resetMigration(db);
      await runFour("pg", url, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    });
  }, 30_000);
  it.skipIf(!pgAdminUrl)("Postgres: four processes append without duplicate or missing seq", async () => {
    await withPostgres(async (db, url) => {
      await runFour("pg", url, "append");
      assertContiguous(db);
    });
  }, 30_000); // same migration-advisory-lock serialization; see the note above
  it.skipIf(!pgAdminUrl)("Postgres: rolls back a comment and its mirrored log row together", async () => {
    await withPostgres(async (db) => {
      const store = new MultiremiStore(db);
      const issue = store.createIssue({ title: "PG comment rollback", workspaceId: "local" });
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
