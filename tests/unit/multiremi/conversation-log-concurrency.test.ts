import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

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
  expect(() => store.updateIssue(child.id, { status: "done" })).toThrow("write rejected");
  expect(store.getIssue(child.id)?.status).not.toBe("done");
  expect(store.listIssueComments(issue.id)).toEqual([]);
  expect(store.listSessionEvents(session.id)).toHaveLength(beforeEvents);
  expect(Number((db.query("SELECT COUNT(*) AS n FROM multiremi_tasks WHERE issue_id = ?")
    .get(issue.id) as { n: number | string }).n)).toBe(beforeTasks);
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
  });
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
  it.skipIf(!pgAdminUrl)("Postgres: a caught bare SQL failure aborts the outer transaction", async () => {
    await withPostgres(async (db) => {
      db.exec("CREATE TABLE bare_failure_case (n INTEGER PRIMARY KEY)");
      expect(() => db.transaction(() => {
        db.run("INSERT INTO bare_failure_case (n) VALUES (1)");
        try { db.run("INSERT INTO bare_failure_case (n) VALUES (1)"); } catch { /* deliberately swallowed */ }
      })()).toThrow();
      expect(db.query("SELECT n FROM bare_failure_case").all()).toEqual([]);
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
  });
  it("SQLite: four processes append without duplicate or missing seq", async () => {
    await withSqlite(async (db, path) => {
      await runFour("sqlite", path, "append");
      assertContiguous(db);
    });
  });
  it.skipIf(!pgAdminUrl)("Postgres: four processes cold-start the migration", async () => {
    await withPostgres(async (db, url) => {
      resetMigration(db);
      await runFour("pg", url, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    });
  });
  it.skipIf(!pgAdminUrl)("Postgres: four processes append without duplicate or missing seq", async () => {
    await withPostgres(async (db, url) => {
      await runFour("pg", url, "append");
      assertContiguous(db);
    });
  });
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
