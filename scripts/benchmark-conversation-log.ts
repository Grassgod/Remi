import { MultiremiStore } from "../packages/server/src/store.js";
import type { SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { parseArgs } from "node:util";
import { backfillConversationLogWithinTransaction, CONVERSATION_LOG_BACKFILL_MIGRATION } from "../packages/server/src/store/conversation-log-backfill.js";
import { withHistoricalConversationStore as withConversationLogStore } from "../tests/unit/multiremi/fixtures/conversation-log-store.js";
import { prepareConversationBackfillFixture } from "../tests/unit/multiremi/fixtures/conversation-log-backfill.js";
import { readOnlyConversationReconciliation, writeConversationMigrationEvidence, type ConversationMigrationEvidence } from "./reconcile-conversation-log.js";

function insertRows(db: SqlDatabase, table: string, columns: string[], rows: unknown[][]): void {
  for (let offset = 0; offset < rows.length; offset += 32) {
    const batch = rows.slice(offset, offset + 32);
    db.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`, batch.flat());
  }
}

function seedScale(db: SqlDatabase): void {
  const at = "2026-08-01T00:00:00.000Z";
  const body = (index: number) => `Synthetic row ${index}: ${"x".repeat(2048)}`;
  const sessions = Array.from({ length: 128 }, (_, index) => ({ id: `ises_bench_${index}`, issue: `iss_bench_${index}` }));
  db.transaction(() => {
    insertRows(db, "multiremi_issues", ["id", "workspace_id", "title", "description", "created_at", "updated_at"],
      sessions.map((session) => [session.issue, "local", "Synthetic historical issue", "Synthetic description", at, at]));
    insertRows(db, "multiremi_issue_sessions", ["id", "issue_id", "workspace_id", "title", "is_default", "created_at", "updated_at"],
      sessions.map((session) => [session.id, session.issue, "local", "Main", 1, at, at]));
    const seq = new Array<number>(128).fill(0);
    const events: unknown[][] = [];
    const event = (index: number, kind: string, text: string, comment: string | null, metadata: unknown = {}, task: string | null = null) => {
      const session = sessions[index % sessions.length]!;
      events.push([`sevt_bench_${events.length}`, session.id, ++seq[index % sessions.length]!, kind === "message" ? "agent" : "system",
        kind === "message" ? "agt_bench" : null, kind, text, comment, JSON.stringify(metadata), task, at]);
    };
    const comments: unknown[][] = [];
    for (let index = 0; index < 5350; index++) {
      const system = index % 17 === 0;
      event(index, system ? "system" : "message", body(index), `cmt_bench_${index}`, { parent_comment_id: null });
      if (index < 5100) comments.push([`cmt_bench_${index}`, sessions[index % 128]!.issue, sessions[index % 128]!.id,
        system ? "system" : "agent", system ? null : "agt_bench", `tsk_comment_${index}`,
        index < 128 ? `Edited ${body(index)}` : body(index), system ? "system" : "comment", at, at]);
    }
    for (let index = 0; index < 128; index++) event(index, "message_edited", `Edited ${body(index)}`, null,
      { comment_id: `cmt_bench_${index}`, previous_body: body(index) });
    for (let index = 5100; index < 5350; index++) event(index, "message_deleted", "Deleted historical comment", null, { comment_id: `cmt_bench_${index}` });
    for (let index = 0; index < 128; index++) event(index, "task_assigned", "Historical prompt", null, {}, `tsk_lifecycle_${index}`);
    for (let index = 0; index < 128; index++) {
      event(index, "thread_resolved", "Resolved", null, { comment_id: `cmt_bench_${index}` });
      event(index, "thread_unresolved", "Unresolved", null, { comment_id: `cmt_bench_${index}` });
    }
    const kinds = ["system", "result_published", "task_steer", "follow_frozen", "task_completed"];
    while (events.length < 15000) {
      const index = events.length;
      const kind = kinds[index % kinds.length]!;
      event(index, kind, body(index), null, kind === "follow_frozen" ? { follow_frozen_seq: 1 } : {},
        kind === "task_steer" || kind === "task_completed" ? `tsk_lifecycle_${index % 128}` : null);
    }
    for (let index = 0; index < 6; index++) comments.push([`cmt_orphan_bench_${index}`, "iss_missing_bench", null, "agent", "agt_bench", null,
      "Historical orphan", "comment", at, at]);
    insertRows(db, "multiremi_issue_comments", ["id", "issue_id", "issue_session_id", "author_type", "author_id", "task_id", "body", "type", "created_at", "updated_at"], comments);
    insertRows(db, "multiremi_session_events", ["id", "session_id", "seq", "author_type", "author_id", "kind", "body", "source_comment_id", "metadata", "task_id", "created_at"], events);
    const chatSeq = new Array<number>(191).fill(0);
    const messages: unknown[][] = [];
    for (let index = 0; index < 4500; index++) {
      const role = ["user", "assistant", "system"][index % 3]!;
      messages.push([`msg_bench_${index}`, `chat_bench_${index % 191}`, index === 0 ? "tsk_bench_topic" : `tsk_chat_${index}`,
        role, body(index), ++chatSeq[index % 191]!, role === "system" ? 1 : 0, at]);
    }
    insertRows(db, "multiremi_chat_sessions", ["id", "workspace_id", "agent_id", "creator_id", "title", "message_sequence", "created_at", "updated_at"],
      chatSeq.map((count, index) => [`chat_bench_${index}`, "local", "agt_bench", "local", "Synthetic chat", count, at, at]));
    insertRows(db, "multiremi_chat_messages", ["id", "chat_session_id", "task_id", "role", "body", "sequence", "pending_agent_delivery", "created_at"], messages);
    db.run(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, chat_session_id, status, prompt, created_at, updated_at)
      VALUES ('tsk_bench_topic', 'local', 'agt_bench', 'iss_bench_0', 'chat_bench_0', 'completed', 'Synthetic topic transport', ?, ?)`, [at, at]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [CONVERSATION_LOG_BACKFILL_MIGRATION]);
  })();
}

if (import.meta.main) {
  if (!process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("MULTIREMI_TEST_POSTGRES_URL must name the isolated local PostgreSQL cluster");
  const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL);
  if (url.hostname !== "127.0.0.1") throw new Error("The synthetic benchmark only uses PostgreSQL on 127.0.0.1");
  const { values } = parseArgs({ args: process.argv.slice(2), options: { out: { type: "string" } } });
  const out = values.out ?? `reports/migrations/MUL-402-conversation-log-${new Date().toISOString().slice(0, 10)}`;
  const evidence: ConversationMigrationEvidence = { generatedAt: new Date().toISOString(),
    scope: "Synthetic fixtures and cold-start qualification on Bun 1.3.14. No production data or credentials. Scale: 15,000 events, 5,106 live comments (6 missing-Issue orphans), 250 tombstones, 4,500 messages in 191 chats; 2 KiB synthetic bodies. Timings include the full Store startup, not fixture generation or reconciliation.", runs: [] };
  for (const backend of ["sqlite", "pg"] as const) {
    await withConversationLogStore(backend, (store, db) => {
      prepareConversationBackfillFixture(store, db);
      const migration = db.transaction(() => backfillConversationLogWithinTransaction(db))();
      const reconciliation = readOnlyConversationReconciliation(db);
      evidence.runs.push({ label: `${backend} acceptance fixture`, migration, reconciliation });
    });
    await withConversationLogStore(backend, (_store, db) => {
      seedScale(db);
      const start = performance.now();
      new MultiremiStore(db);
      const startupMs = performance.now() - start;
      const second = performance.now();
      new MultiremiStore(db);
      const secondStartupMs = performance.now() - second;
      const reconciliation = readOnlyConversationReconciliation(db);
      if (reconciliation.counts.sessionEvents !== 15000 || reconciliation.counts.chatMessages !== 4500 || reconciliation.counts.chatSessions !== 191) {
        throw new Error("Synthetic benchmark source counts differ from the requested scale");
      }
      evidence.runs.push({ label: `${backend} cold startup`, startupMs, secondStartupMs, reconciliation });
    });
  }
  await writeConversationMigrationEvidence(out, evidence);
  console.log(JSON.stringify(evidence.runs.map((run) => ({ label: run.label, startupMs: run.startupMs,
    secondStartupMs: run.secondStartupMs, counts: run.reconciliation.counts, filled: run.migration?.counts.commentTaskIdsFilled,
    mismatches: run.reconciliation.mismatches.length })), null, 2));
  process.exitCode = evidence.runs.some((run) => run.reconciliation.mismatches.length) ? 1 : 0;
}
