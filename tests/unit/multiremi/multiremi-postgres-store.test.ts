import { receiveRuntimeInputs } from '../../fixtures/runtime-downlinks.js';
/**
 * Coverage for the Postgres backend of the Multiremi store.
 *
 * `src/multiremi/store/db/postgres.ts` translates the sqlite-dialect SQL the
 * store emits into Postgres via regexes (translateSqliteToPg) and bridges the
 * store's synchronous bun:sqlite call surface to an async Postgres connection
 * (PostgresSyncDatabase, via a Worker + SharedArrayBuffer + Atomics). The risk
 * is that a query silently mis-translates. This file guards both layers:
 *
 *  1. Pure unit tests for translateSqliteToPg() — one per regex rule. These run
 *     everywhere and need no database.
 *  2. Integration tests that run the *real* MultiremiStore against Postgres in a
 *     throwaway database, exercising a broad slice of the query surface
 *     (issues incl. the SQL-pushdown listIssues, projects, agents, runtimes,
 *     tasks claim, workspace members, users, access tokens). A bad SQLite→PG
 *     translation surfaces as a thrown error or a wrong result here.
 *
 * The integration suite is skipped (not failed) when Postgres is unreachable, so
 * the file is safe on machines without the configured MULTIREMI_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { PostgresSyncDatabase, translateSqliteToPg } from "@multiremi/store/db/postgres.js";
import { daemonRuntimeId, MultiremiStore } from "@multiremi/store.js";
import { StoreContext, type CommitEventQueue } from "@multiremi/store/context.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
import type { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { ProjectInstructionsRevisionConflictError } from "@multiremi/store/repos/projects-repo.js";
import { TaskSteerConflictError, TaskSteerPendingError } from "@multiremi/store/repos/tasks-repo.js";
import { configureRepositoryWikiAutomation, readyArchiveBinding } from "./helpers.js";

import { CHAT_ISSUE_CLASSIFICATION_CASES, classificationChatId, seedLegacyChatIssueClassificationFixture, seedLegacyChatWakeFixture, assertLegacyChatWakeSettlement, assertCancelledLegacyWakesCannotRun, assertLegacyChatWakeRollback, mintLegacyWakeTokens, assertLegacyWakeTokens, seedWakeInvariantMatrix, assertWakeInvariantMatrix, seedLegacyProactiveRetryMatrix, assertLegacyProactiveRetryMatrix } from "./chat-issue-migration-fixture.js";

// ────────────────────────────── translateSqliteToPg ──────────────────────────────

describe("translateSqliteToPg", () => {
  it("numbers ? placeholders positionally, skipping ? inside string literals", () => {
    expect(translateSqliteToPg("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
    expect(translateSqliteToPg("SELECT * FROM t WHERE name = ? AND note = 'a ? b' AND c = ?")).toBe(
      "SELECT * FROM t WHERE name = $1 AND note = 'a ? b' AND c = $2",
    );
  });

  it("rewrites INSERT OR IGNORE to INSERT … ON CONFLICT DO NOTHING", () => {
    expect(translateSqliteToPg("INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)")).toBe(
      "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    );
  });

  it("keeps an existing ON CONFLICT clause on INSERT OR IGNORE (no double append)", () => {
    const out = translateSqliteToPg("INSERT OR IGNORE INTO t (a) VALUES (?) ON CONFLICT(a) DO NOTHING");
    expect(out).toBe("INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO NOTHING");
    expect(out.match(/ON CONFLICT/g)?.length).toBe(1);
  });

  it("normalizes ON CONFLICT(col) to ON CONFLICT (col)", () => {
    expect(translateSqliteToPg("INSERT INTO t (a) VALUES (?) ON CONFLICT(id) DO NOTHING")).toBe(
      "INSERT INTO t (a) VALUES ($1) ON CONFLICT (id) DO NOTHING",
    );
  });

  it("translates PRAGMA table_info(X) to an information_schema query", () => {
    expect(translateSqliteToPg("PRAGMA table_info(multiremi_issues)")).toBe(
      "SELECT column_name AS name, CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull, data_type AS type " +
        "FROM information_schema.columns WHERE table_schema='public' AND table_name='multiremi_issues'",
    );
  });

  it("translates the sqlite_master table+index listing to pg_tables/pg_indexes", () => {
    expect(
      translateSqliteToPg("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')"),
    ).toBe(
      "SELECT tablename AS name, 'table' AS type FROM pg_tables WHERE schemaname='public' " +
        "UNION ALL SELECT indexname AS name, 'index' AS type FROM pg_indexes WHERE schemaname='public'",
    );
  });

  it("turns the sqlite_master CREATE-text lookup into a NULL-returning probe", () => {
    expect(
      translateSqliteToPg("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_issues'"),
    ).toBe(
      "SELECT NULL::text AS sql FROM information_schema.tables WHERE table_schema='public' AND table_name='multiremi_issues'",
    );
  });

  it("makes ALTER TABLE … ADD COLUMN idempotent, without double-adding IF NOT EXISTS", () => {
    expect(translateSqliteToPg("ALTER TABLE multiremi_issues ADD COLUMN foo TEXT")).toBe(
      "ALTER TABLE multiremi_issues ADD COLUMN IF NOT EXISTS foo TEXT",
    );
    // Already guarded → left as-is (negative lookahead).
    expect(translateSqliteToPg('ALTER TABLE "multiremi_issues" ADD COLUMN IF NOT EXISTS bar TEXT')).toBe(
      'ALTER TABLE "multiremi_issues" ADD COLUMN IF NOT EXISTS bar TEXT',
    );
  });

  it("preserves partial unique indexes used for Feishu default routes", () => {
    const sql = `CREATE UNIQUE INDEX idx_routes_default
      ON multiremi_feishu_bot_agent_routes(workspace_id, scope)
      WHERE chat_id IS NULL`;
    expect(translateSqliteToPg(sql)).toBe(sql);
  });

  it("strips FOREIGN KEY clauses (unenforced in sqlite; rejected on forward refs in PG)", () => {
    expect(
      translateSqliteToPg(
        "CREATE TABLE t (id TEXT, x TEXT, FOREIGN KEY (x) REFERENCES other(id) ON DELETE CASCADE)",
      ),
    ).toBe("CREATE TABLE t (id TEXT, x TEXT)");
  });

  it("rewrites the sqlite rowid dedup DELETE to a Postgres ctid self-join", () => {
    expect(
      translateSqliteToPg("DELETE FROM t WHERE rowid NOT IN (SELECT MAX(rowid) FROM t GROUP BY a, b)"),
    ).toBe("DELETE FROM t a USING t b WHERE a.a = b.a AND a.b = b.b AND a.ctid < b.ctid");
  });
});

// ────────────────────────────── PostgresSyncDatabase + MultiremiStore ──────────────────────────────

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_pgtest_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

function waitForWorkerPhase(worker: Worker, expectedPhase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<{ phase?: string; error?: string }>) => {
      if (event.data.phase === "error") {
        cleanup();
        reject(new Error(event.data.error ?? "Postgres race worker failed"));
      } else if (event.data.phase === expectedPhase) {
        cleanup();
        resolve();
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

function waitForWorkerMessage<T extends Record<string, unknown>>(
  worker: Worker,
  expectedPhase: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<T & { phase?: string; error?: string }>) => {
      if (event.data.phase === "error") {
        cleanup();
        reject(new Error(event.data.error ?? "Postgres race worker failed"));
      } else if (event.data.phase === expectedPhase) {
        cleanup();
        resolve(event.data);
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

// Decide skip-vs-run at collection time (top-level await); the throwaway DB and
// store are built in beforeAll so a probe failure never leaves half-open state.
const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(
    `[multiremi-postgres-store] Postgres not reachable at ${PG_ADMIN_URL} — skipping PG-backed store integration tests.`,
  );
}

describe.skipIf(!pgAvailable)("MultiremiStore on Postgres (integration)", () => {
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;

  function drainSystemEvents(): void {
    const pending = db.query("SELECT 1 FROM multiremi_system_events WHERE status IN ('pending', 'processing') LIMIT 1");
    const at = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    for (let round = 0; round < 100 && pending.get(); round++) store.dispatchPendingSystemEvents(at);
    if (pending.get()) throw new Error("System event queue did not drain within 100 rounds");
  }

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    // Constructing the store runs migrate(): all CREATE TABLE / ALTER / index DDL
    // flows through translateSqliteToPg. A mis-translation would throw right here.
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    db?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  it.each(["redispatch", "retry", "continuation", "delegation_return", "parent_wakeup"] as const)(
    "writes the %s dependency exemption after commit (PG)",
    (source) => {
      const runtime = store.registerRuntime({
        id: `rt_pg_exemption_${++wsCounter}`, name: `PG exemption ${source}`, provider: "claude",
      });
      const agent = store.createAgent({ name: `PG exemption ${source} ${wsCounter}`, provider: "claude", runtimeId: runtime.id });
      const prerequisite = store.createIssue({ title: `PG prerequisite ${source}`, status: "in_progress" });
      const issue = store.createIssue({ title: `PG earlier work ${source}`, status: "in_progress" });
      const previous = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "earlier round" });
      if (source === "redispatch") store.cancelTask(previous.id);
      if (source === "retry") {
        expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
        store.startTask(previous.id);
        store.failTask(previous.id, { error: "failed", failureReason: "unknown" });
      }
      store.createIssueDependency(issue.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
      store.updateIssue(issue.id, { status: "backlog" });
      const eventStates: boolean[] = [];
      const stop = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created"
          && (event.payload.entry as { action?: string })?.action === "dependency_gate_exempted") {
          eventStates.push(db.inTransaction);
        }
      });
      db.resetTransactionDepthStats();
      const task = store.createTask({
        agentId: agent.id, issueId: issue.id, prompt: `continue ${source}`,
        ...(source === "redispatch" || source === "retry" ? { attempt: 2, parentTaskId: previous.id } : {}),
        ...(source === "continuation" ? { continuedFromTaskId: previous.id } : {}),
        ...(source === "delegation_return" ? {
          delegationId: `dlg_exemption_${wsCounter}`, delegatedByAgentId: agent.id, parentTaskId: previous.id,
        } : {}),
        ...(source === "parent_wakeup" ? { preserveIssueStatus: true, parentTaskId: previous.id } : {}),
      });
      stop();
      expect(db.maxTransactionDepth).toBe(1);
      expect(eventStates).toEqual([false]);
      expect(store.getTask(task.id)?.status).toBe("queued");
      const activities = store.listIssueActivity(issue.id).filter((row) => row.type === "dependency_gate_exempted");
      expect(activities).toHaveLength(1);
      expect(activities[0]!.data).toMatchObject({
        source, taskId: task.id, task_id: task.id,
        previousTaskId: previous.id, previous_task_id: previous.id,
        unmet: [{ key: prerequisite.key }],
      });
    },
  );

  it("does not auto-claim a backlog issue with an active exempt round (PG)", () => {
    const runtime = store.registerRuntime({ id: `rt_pg_active_${++wsCounter}`, name: "Active exemption", provider: "claude" });
    const agent = store.createAgent({ name: `Active exemption ${wsCounter}`, provider: "claude", runtimeId: runtime.id });
    const prerequisite = store.createIssue({ title: "Active prerequisite", status: "in_progress" });
    const issue = store.createIssue({
      title: "Active dependent", status: "backlog", blockedBy: [prerequisite.id],
      assigneeType: "agent", assigneeId: agent.id,
    });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, prompt: "existing continuation",
      attempt: 2, preserveIssueStatus: true,
    });
    db.resetTransactionDepthStats();
    store.updateIssue(prerequisite.id, { status: "done" });
    expect(db.maxTransactionDepth).toBe(1);
    expect(store.getIssue(issue.id)?.status).toBe("backlog");
    expect(store.listTasksForIssue(issue.id).map((row) => row.id)).toEqual([task.id]);
    expect(store.listIssueActivity(issue.id).filter((row) =>
      row.type === "dependency_auto_started" || row.type === "dependency_auto_start_skipped")).toEqual([]);
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");
  });

  it("maps a waiting session task request to 409 with unmet prerequisites (PG)", async () => {
    const agent = store.createAgent({ name: `Session gate ${++wsCounter}`, provider: "claude" });
    const prerequisite = store.createIssue({ title: "Session prerequisite", status: "in_progress" });
    const issue = store.createIssue({ title: "Session waiting", status: "backlog", blockedBy: [prerequisite.id] });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, prompt: "blocked" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "dependencies_unmet", unmet: [{ key: prerequisite.key }] });
    expect(store.listTasksForIssue(issue.id)).toEqual([]);
    expect(store.getIssue(issue.id)?.status).toBe("backlog");
    const unknownAgent = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agt_not_found", prompt: "blocked" }),
    });
    expect(unknownAgent.status).toBe(404);
  });

  // Real PostgreSQL performs repeated full startup migrations plus classification
  // fixtures and their cleanup; allow for database round trips.
  it("moves legacy Chat ownership into Feishu topics and is idempotent", async () => {
    seedLegacyChatIssueClassificationFixture(db);
    seedLegacyChatWakeFixture(db);
    seedWakeInvariantMatrix(db);
    seedLegacyProactiveRetryMatrix(db);
    const tokens = await mintLegacyWakeTokens(db);
    assertLegacyChatWakeRollback(db);
    await assertLegacyWakeTokens(db, tokens, true);
    runMigrations(db);
    assertLegacyChatWakeSettlement(db);
    runMigrations(db);
    assertLegacyChatWakeSettlement(db);
    expect((db.query("PRAGMA table_info(multiremi_chat_sessions)").all() as Array<{ name: string }>).map(column => column.name)).not.toContain("issue_id");
    expect(db.query(`SELECT chat_session_id, issue_id FROM multiremi_feishu_bot_chat_bindings
      WHERE app_id = 'cli_migration' AND chat_session_id NOT LIKE '%classification_%' ORDER BY chat_session_id`).all()).toEqual([
      { chat_session_id: "chat_group_migration", issue_id: "iss_chat_migration" },
      { chat_session_id: "chat_issue_topic_iss_chat_migration", issue_id: "iss_chat_migration" },
      { chat_session_id: "chat_private_migration", issue_id: null },
    ]);
    expect(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_chat_messages WHERE chat_session_id LIKE '%migration%' AND role IN ('user', 'assistant')").get().count)).toBe(8);
    expect(db.query("SELECT session_id, session_runtime_id, work_dir FROM multiremi_chat_sessions WHERE id = 'chat_web_migration'").get()).toEqual({ session_id: null, session_runtime_id: "rt_legacy", work_dir: "/work/keep" });
    for (const status of ["queued", "dispatched"]) {
      expect(db.query("SELECT issue_id, session_id, work_dir, issue_session_id, issue_session_generation FROM multiremi_tasks WHERE id = ?").get(`tsk_chat_migration_${status}`))
        .toEqual({ issue_id: null, session_id: null, work_dir: "/work/keep", issue_session_id: null, issue_session_generation: null });
    }
    expect(db.query("SELECT issue_id, issue_session_id, issue_session_generation FROM multiremi_tasks WHERE id = 'tsk_topic_migration_queued'").get())
      .toEqual({ issue_id: "iss_chat_migration", issue_session_id: null, issue_session_generation: null });
    for (const entry of CHAT_ISSUE_CLASSIFICATION_CASES) {
      const chatId = classificationChatId(entry);
      const issueId = `iss_classification_${entry.name}`;
      const recovery = db.query(`SELECT * FROM multiremi_feishu_bot_issue_link_audit
        WHERE binding_id = ?`).get(`fcb_${chatId}`) as Record<string, string> | null;
      const synced = entry.synced?.filter((value) => (value.workspace ?? "local") === "local"
        && (value.sourceWorkspace ?? "local") === "local") ?? [];
      const p2p = synced.some((value) => value.chatType === "p2p");
      expect(recovery).toMatchObject({ binding_id: `fcb_${chatId}`, workspace_id: "local", issue_id: issueId,
        disposition: entry.preserve ? "preserved" : "discarded",
        classification_version: 2, hit_canonical: Number(entry.canonical ?? false),
        hit_marker: Number(entry.provenance === "exact"),
        hit_synced_group: Number(synced.some((value) => value.chatType === "group")),
        hit_synced_p2p: Number(p2p),
      });
      expect(Number.isFinite(Date.parse(recovery!.audited_at))).toBe(true);
      expect(recovery!.reason).toBe(p2p ? "p2p_evidence"
        : entry.canonical ? "canonical_topic" : entry.provenance === "exact" ? "creation_provenance"
          : entry.preserve ? "synced_group" : "unproven_ownership");
      expect(JSON.parse(recovery!.binding_snapshot)).toMatchObject({
        id: `fcb_${chatId}`, workspace_id: "local", app_id: "cli_migration",
        agent_id: "agt_chat_migration", chat_session_id: chatId, issue_id: issueId,
        chat_id: `oc_${entry.name}`, thread_id: entry.thread || entry.key ? `om_${entry.name}` : null,
      });
      expect(recovery!.channel_snapshot ? JSON.parse(recovery!.channel_snapshot) : null).toEqual(entry.noChannel ? null : {
        id: `nch_agent_chat_${chatId}`, workspace_id: "local", member_id: null, kind: "agent_chat",
        name: "Legacy updates", enabled: entry.channelEnabled ?? 0, target: JSON.stringify({ chatId }),
        event_types: '["comment_created"]', min_severity: "warning", created_by: "legacy-owner",
        created_at: "2026-09-03T00:00:00.000Z", updated_at: "2026-09-03T00:00:00.000Z",
      });
      expect(db.query("SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ?").get(`fcb_${chatId}`))
        .toEqual({ issue_id: entry.preserve ? issueId : null });
      expect(db.query(`SELECT session_id, session_provider, session_execution_fingerprint, work_dir, session_runtime_id
        FROM multiremi_chat_sessions WHERE id = ?`).get(chatId)).toEqual({
        session_id: entry.preserve && !entry.sharedPrivateBinding && entry.name !== "group_without_thread" ? "provider-legacy" : null,
        session_provider: entry.preserve && !entry.sharedPrivateBinding && entry.name !== "group_without_thread" ? "codex" : null,
        session_execution_fingerprint: entry.preserve && !entry.sharedPrivateBinding && entry.name !== "group_without_thread" ? "legacy-fingerprint" : null,
        work_dir: "/work/keep", session_runtime_id: "rt_legacy",
      });
      expect(db.query("SELECT issue_id, session_id FROM multiremi_tasks WHERE id = ?").get(`tsk_${chatId}`))
        .toEqual({ issue_id: entry.preserve ? issueId : null, session_id: entry.preserve && !entry.sharedPrivateBinding && entry.name !== "group_without_thread" ? "provider-task-legacy" : null });
      expect(db.query("SELECT role, pending_agent_delivery FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY role").all(chatId))
        .toEqual(entry.preserve
          ? [{ role: "assistant", pending_agent_delivery: 0 }, { role: "system", pending_agent_delivery: 1 }, { role: "user", pending_agent_delivery: 0 }]
          : [{ role: "assistant", pending_agent_delivery: 0 }, { role: "user", pending_agent_delivery: 0 }]);
      expect(db.query("SELECT pending_count FROM multiremi_agent_issue_update_state WHERE chat_session_id = ?").get(chatId))
        .toEqual(entry.preserve ? { pending_count: 1 } : null);
      expect(db.query("SELECT enabled FROM multiremi_notification_channels WHERE id = ?").get(`nch_agent_chat_${chatId}`))
        .toEqual(entry.preserve ? { enabled: 0 } : null);
    }
    await assertLegacyWakeTokens(db, tokens);
    assertLegacyProactiveRetryMatrix(db);
    assertWakeInvariantMatrix(db);
    assertCancelledLegacyWakesCannotRun(db, store);
    // The private destination must not reuse the retained group's machine/files.
    store.registerRuntime({ id: "rt_legacy", name: "Original machine", provider: "codex", workspaceId: "local" });
    const mixedChatId = "chat_classification_mixed_bindings";
    const privateTask = store.createTask({ agentId: "agt_chat_migration", chatSessionId: mixedChatId,
      runtimeId: "rt_legacy", prompt: "Private continuation" });
    expect(privateTask).toMatchObject({ issueId: null, sessionId: null, runtimeId: null, workDir: null });
    const privateWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(privateTask.id)!);
    expect(privateWire.issue).toBeUndefined();
    expect(privateWire.session_id).toBeUndefined();
    expect(privateWire.prior_session_id).toBeUndefined();
    expect(privateWire.runtime_id).toBe("");
    expect(privateWire.work_dir).toBeUndefined();
    expect(privateWire.prior_work_dir).toBeUndefined();
    const groupTask = store.createTask({ agentId: "agt_chat_migration", chatSessionId: mixedChatId,
      issueId: "iss_classification_mixed_bindings", prompt: "Group continuation" });
    expect(groupTask).toMatchObject({ runtimeId: "rt_legacy", workDir: "/work/keep" });
    store.cancelTask(privateTask.id);
    store.cancelTask(groupTask.id);
    // The table is bootstrap schema, even after the one-time migration ledger exists.
    db.exec("DROP TABLE multiremi_feishu_bot_issue_link_audit");
    runMigrations(db);
    expect(Number(db.query("SELECT COUNT(*) AS count FROM multiremi_feishu_bot_issue_link_audit").get().count)).toBe(0);
    db.run("DELETE FROM multiremi_feishu_messages WHERE message_id LIKE 'sync_%'");
    db.run("DELETE FROM multiremi_feishu_sources WHERE id LIKE 'fsrc_%'");
    // Keep the shared integration store empty for the remaining test cases.
    for (const chat of store.listChatSessions("local")) store.deleteChatSession(chat.id);
    store.deleteRuntime("rt_legacy");
    store.deleteIssue("iss_chat_migration");
    for (const entry of CHAT_ISSUE_CLASSIFICATION_CASES) store.deleteIssue(`iss_classification_${entry.name}`);
    db.run("DELETE FROM multiremi_agents WHERE id = ?", ["agt_chat_migration"]);
  }, 30_000);

  it("fences Wiki cleanup leases and persists per-path progress across connections", () => {
    const otherDb = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    const other = new MultiremiStore(otherDb);
    const jobId = "rwjob_pg_cleanup";
    // Install a legacy cleanup fixture to exercise the newly added lease columns.
    db.run(`INSERT INTO multiremi_repository_wiki_storage_jobs
      (id,workspace_id,repository_id,batch_id,state,manifest,attempt_count,created_at,updated_at)
      VALUES (?, 'local', 'repo_pg_cleanup', 'batch_pg_cleanup', 'cleanup', ?, 0, ?, ?)
      ON CONFLICT(id) DO NOTHING`, [jobId, JSON.stringify({ promotions: [], cleanupUris: ["first.md", "second.md"] }),
      new Date().toISOString(), new Date().toISOString()]);
    const now = new Date().toISOString();
    const until = new Date(Date.now() + 120_000).toISOString();
    try {
      expect(store.claimRepositoryWikiStorageJob(jobId, "first", until, now)).toBe(true);
      expect(other.claimRepositoryWikiStorageJob(jobId, "second", until, now)).toBe(false);
      store.recordRepositoryWikiCleanupProgress(jobId, "first", "first.md");
      expect(other.listRepositoryWikiStorageJobs("local", "repo_pg_cleanup")[0]?.manifest.completedCleanupUris).toEqual(["first.md"]);
      db.run("UPDATE multiremi_repository_wiki_storage_jobs SET lease_until = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", jobId]);
      expect(other.claimRepositoryWikiStorageJob(jobId, "second", until, now)).toBe(true);
      expect(store.renewRepositoryWikiStorageJob(jobId, "first", until)).toBe(false);
      expect(() => store.recordRepositoryWikiCleanupProgress(jobId, "first", "second.md")).toThrow("lease lost");
      other.recordRepositoryWikiCleanupProgress(jobId, "second", "second.md");
      store.releaseRepositoryWikiStorageJob(jobId, "first");
      expect(store.claimRepositoryWikiStorageJob(jobId, "third", until, now)).toBe(false);
      other.releaseRepositoryWikiStorageJob(jobId, "second");
      expect(store.claimRepositoryWikiStorageJob(jobId, "third", until, now)).toBe(true);
    } finally {
      store.completeRepositoryWikiStorageJob(jobId);
      otherDb.close();
    }
  });

  it("checks repository Wiki publication without untyped nullable parameters", () => {
    const { autopilot } = configureRepositoryWikiAutomation(store);

    const taskRun = store.runAutopilot(autopilot.id, {
      source: "api",
      repositoryId: "repo_publication_task",
      dedupeKey: "repo_publication_task:bootstrap_repository:head",
    });
    expect(store.isRepositoryWikiRunPublished(taskRun.id)).toBe(false);
    store.createRepositoryWikiDoc("local", "repo_publication_task", {
      path: "task.md",
      title: "Task publication",
      sourceTaskId: taskRun.taskId,
    });
    expect(store.isRepositoryWikiRunPublished(taskRun.id)).toBe(true);

    store.createRepositoryWikiDoc("local", "repo_publication_revision", {
      path: "revision.md",
      title: "Revision publication",
      sourceRevision: "abc123",
    });
    const revisionRun = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      repositoryId: "repo_publication_revision",
      dedupeKey: "repo_publication_revision:incremental_update:abc123",
    });
    expect(store.isRepositoryWikiRunPublished(revisionRun.id)).toBe(true);
  });

  it("resumes target schedules on Postgres without duplicate tasks", () => {
    const agent = store.createAgent({ name: "PG schedule worker", provider: "claude" });
    const firstProject = store.createProject({ title: "PG schedule A" });
    const secondProject = store.createProject({ title: "PG schedule B" });
    const rule = store.createAutopilot({ title: "PG target schedule", assigneeId: agent.id, executionMode: "run_only" });
    const trigger = store.createAutopilotTrigger(rule.id, { kind: "schedule", cronExpression: "0 3 * * *", scheduleTargets: { projects: { all: false, ids: [firstProject.id, secondProject.id] }, repositories: { all: false, ids: [] } } });
    const first = store.runAutopilot(rule.id, { triggerId: trigger.id });
    expect(first.taskId).toBeTruthy();
    expect(store.getTaskWithAgent(first.taskId!)?.project?.id).toBe(firstProject.id);
    store.runAutopilot(rule.id, { triggerId: trigger.id });
    expect(store.listAutopilotRuns(rule.id)).toHaveLength(2);
    db.run("UPDATE multiremi_autopilot_runs SET status = 'failed' WHERE id = ?", [first.id]);
    store.advanceScheduledTargetRuns();
    const next = store.listAutopilotRuns(rule.id).find((run) => run.status === "running")!;
    expect(next.scheduleTarget?.id).toBe(secondProject.id);
    store.advanceScheduledTargetRuns();
    expect(store.listAutopilotRuns(rule.id).filter((run) => run.taskId)).toHaveLength(2);
  });

  // Each test provisions its own workspace so shared state (issue numbering,
  // list results) stays isolated without per-test databases.
  let wsCounter = 0;
  const freshWorkspace = (): string => {
    wsCounter += 1;
    const slug = `pgtest-${process.pid}-${wsCounter}`;
    return store.createWorkspace({ name: `PG Test ${wsCounter}`, slug }).id;
  };

  it("persists queued capability waits through escalation, recovery and dispatch on Postgres", () => {
    const workspaceId = freshWorkspace();
    const healthy: MultiremiRuntimeModel[] = [{
      id: "claude-opus-5", label: "Opus", provider: "anthropic", default: true,
      thinking: { status: "supported", supportedLevels: [{ value: "high", label: "high" }] },
    }];
    const unavailable: MultiremiRuntimeModel[] = [{
      ...healthy[0]!, thinking: { status: "error", supportedLevels: [], error: "catalog unavailable (fixture)" },
    }];
    const runtime = store.registerRuntime({ name: "PG capability candidate", provider: "claude", workspaceId, models: healthy });
    const agent = store.createAgent({
      name: "PG capability waiter", provider: "claude", workspaceId, runtimeId: runtime.id,
      model: "claude-opus-5", thinkingLevel: "high",
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Wait for the configured capability" });
    const now = Date.now();
    db.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 120_000).toISOString(), task.id]);
    const events: Array<string | null> = [];
    const unsubscribe = store.onTaskEvent(({ type, task: updated }) => {
      if (type === "task:queued" && updated.id === task.id) events.push(updated.waitReason);
    });
    try {
      store.updateRuntimeModels(runtime.id, unavailable);
      expect(store.getTask(task.id)?.waitReason).toBeNull();
      store.refreshQueuedCapabilityWaitReasons(now);
      const waiting = store.getTask(task.id)!;
      expect(waiting).toMatchObject({ status: "queued", waitReason: expect.stringContaining("claude-opus-5") });
      expect(events).toEqual([waiting.waitReason]);

      const alertAt = now + 13 * 60_000;
      store.refreshQueuedCapabilityWaitReasons(alertAt);
      const alerted = store.getTask(task.id)!;
      expect(alerted.waitReason).not.toBe(waiting.waitReason);
      expect(alerted.waitReason).toContain("15");
      store.refreshQueuedCapabilityWaitReasons(alertAt + 60_000);
      expect(store.getTask(task.id)?.updatedAt).toBe(alerted.updatedAt);
      expect(events).toEqual([waiting.waitReason, alerted.waitReason]);
      expect(store.listAnalyticsEvents({ name: "task_queued_capability_timeout" })
        .filter(event => event.properties.task_id === task.id)).toHaveLength(1);

      store.updateRuntimeModels(runtime.id, healthy);
      store.refreshQueuedCapabilityWaitReasons(alertAt + 120_000);
      expect(store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: null });
      expect(events.at(-1)).toBeNull();

      store.updateRuntimeModels(runtime.id, unavailable);
      store.refreshQueuedCapabilityWaitReasons(alertAt + 180_000);
      expect(store.getTask(task.id)?.waitReason).toContain("claude-opus-5");
      store.updateRuntimeModels(runtime.id, healthy);
      expect(store.claimTask(runtime.id)).toMatchObject({ id: task.id, status: "dispatched", waitReason: null });
      expect(store.startTask(task.id)).toMatchObject({ status: "running", waitReason: null });
      store.completeTask(task.id, { output: "Capability recovered" });
    } finally {
      unsubscribe();
    }
  });

  it("lists an agent task snapshot through the batched autopilot lookup", () => {
    const workspaceId = freshWorkspace();
    const agent = store.createAgent({ name: `PG snapshot agent ${wsCounter}`, provider: "codex", workspaceId });
    const active = store.createTask({ agentId: agent.id, prompt: "active snapshot task" });
    const terminal = store.createTask({ agentId: agent.id, prompt: "terminal snapshot task" });
    db.run(
      `UPDATE multiremi_tasks
       SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE id = ?`,
      ["2026-09-10T09:00:00.000Z", "2026-09-10T09:00:00.000Z", terminal.id],
    );
    db.run("UPDATE multiremi_tasks SET updated_at = ? WHERE id = ?", ["2026-09-10T10:00:00.000Z", active.id]);

    expect(store.listWorkspaceAgentTaskSnapshot(workspaceId).map((task) => task.id)).toEqual([
      active.id,
      terminal.id,
    ]);
  });

  it("builds Chat task projections and pending updates without SQLite rowid", () => {
    const workspaceId = freshWorkspace();
    const runtime = store.registerRuntime({
      name: `PG Chat runtime ${wsCounter}`,
      provider: "claude",
      workspaceId,
    });
    const agent = store.createAgent({
      name: `PG Chat agent ${wsCounter}`,
      provider: "claude",
      runtimeId: runtime.id,
      workspaceId,
    });
    const chat = store.createChatSession({
      agentId: agent.id,
      title: "PG portable Chat ordering",
      workspaceId,
    });
    const sent = store.sendChatMessage(chat.id, { body: "Build the PostgreSQL projection." });

    expect(store.claimTask(runtime.id)?.id).toBe(sent.task.id);
    expect(() => store.buildTaskSessionProjection(sent.task.id)).not.toThrow();
    expect(store.listChatMessages(chat.id).map((message) => message.body)).toEqual([
      "Build the PostgreSQL projection.",
    ]);

    store.createPendingAgentIssueUpdateWithinTransaction(chat.id, "First pending update.");
    store.createPendingAgentIssueUpdateWithinTransaction(chat.id, "Second pending update.");
    const pending = store.preparePendingAgentIssueUpdatesForTask(chat.id, sent.task.id);
    expect(pending.omittedCount).toBe(0);
    expect(pending.messages.map((message) => message.body).sort()).toEqual([
      "First pending update.",
      "Second pending update.",
    ]);
  });

  it("migrates legacy Chat sequence columns before creating the index", () => {
    const workspaceId = freshWorkspace();
    const agent = store.createAgent({ name: "PG legacy Chat", provider: "claude", workspaceId });
    const chat = store.createChatSession({ agentId: agent.id, title: "Legacy sequences", workspaceId });
    const timestamp = "2026-09-01T00:00:00.000Z";
    for (const [id, createdAt] of [["legacy_seq_b", timestamp], ["legacy_seq_a", timestamp], ["legacy_seq_c", "2026-09-02T00:00:00.000Z"]]) {
      db.run(
        "INSERT INTO multiremi_chat_messages (id, chat_session_id, role, body, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, chat.id, "user", id, createdAt],
      );
    }
    db.exec(`
      DROP INDEX idx_multiremi_chat_messages_session_sequence;
      ALTER TABLE multiremi_chat_messages DROP COLUMN sequence;
      ALTER TABLE multiremi_chat_sessions DROP COLUMN message_sequence;
      DELETE FROM multiremi_schema_migrations WHERE id = '20260905_chat_message_sequence';
    `);

    // Upgrades boot a new process; do not reuse pre-DDL prepared statements.
    db.close();
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    expect(store.listChatMessages(chat.id).map(message => message.id)).toEqual([
      "legacy_seq_a", "legacy_seq_b", "legacy_seq_c",
    ]);
    expect(db.query("SELECT message_sequence FROM multiremi_chat_sessions WHERE id = ?").get(chat.id))
      .toEqual({ message_sequence: 3 });
    expect(db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'multiremi_chat_messages' AND indexname = ?")
      .get("idx_multiremi_chat_messages_session_sequence")).not.toBeNull();

    store.sendChatMessage(chat.id, { body: "After migration" });
    runMigrations(db);
    expect(db.query("SELECT body, sequence FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY sequence, id")
      .all(chat.id)).toEqual([
        { body: "legacy_seq_a", sequence: 1 },
        { body: "legacy_seq_b", sequence: 2 },
        { body: "legacy_seq_c", sequence: 3 },
        { body: "After migration", sequence: 4 },
      ]);
  });

  it("discovers Feishu senders and checks their live allowlist across Chat and task ancestry", async () => {
    const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const workspaceId = freshWorkspace();
      const agent = store.createAgent({ name: "PG Feishu bot", provider: "codex", workspaceId });
      const runtimeId = `rt_feishu_allowlist_${wsCounter}`;
      store.registerRuntime({ id: runtimeId, name: "PG bot", provider: "codex", workspaceId, daemonId: `pg_bot_${wsCounter}` });
      store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
      (await receiveRuntimeInputs(store, runtimeId));
      const config = store.upsertFeishuBotConfig(workspaceId, {
        agentId: agent.id, runtimeId, appId: "cli_pg_allowlist", domain: "feishu", enabled: true,
        senderAccessPolicy: "allowlist",
        appSecretOp: "set", appSecret: "fixture-secret-not-a-real-credential",
      });
      const input = { revision: config.revision, externalSessionKey: "oc_pg_allowlist", externalMessageId: "om_pg_1", senderOpenId: "ou_pg_sender", senderName: "PG Sender", text: "Create an Issue" };
      const inbound = store.submitFeishuBotMessage(workspaceId, runtimeId, input);
      store.submitFeishuBotMessage(workspaceId, runtimeId, { ...input, externalMessageId: "om_pg_2", senderUnionId: "on_pg_sender" });
      const senders = store.listFeishuBotSenders(workspaceId);
      expect(senders).toHaveLength(1);
      expect(senders[0]).toMatchObject({ open_id: "ou_pg_sender", union_id: "on_pg_sender", allowed: false });
      expect(store.listFeishuBotTaskReceiptMessageIds(workspaceId, inbound.taskId)).toEqual(["om_pg_1", "om_pg_2"]);
      expect(store.listFeishuBotTaskReceiptMessageIds("local", inbound.taskId)).toEqual([]);
      const child = store.createTask({ agentId: agent.id, workspaceId, prompt: "Delegated request", parentTaskId: inbound.taskId });
      expect(store.isFeishuBotTaskIssueCreationRestricted(child.id)).toBe(true);
      store.setFeishuBotSenderAllowed(workspaceId, senders[0]!.id, true, "local");
      expect(store.isFeishuBotTaskIssueCreationRestricted(child.id)).toBe(false);
      const beforeRefresh = new Date().toISOString();
      expect(store.listFeishuBotSenderProfileSources(workspaceId, beforeRefresh)).toEqual([{
        id: senders[0]!.id, appId: config.appId, openId: "ou_pg_sender", messageId: "om_pg_2",
      }]);
      store.updateFeishuBotSenderProfile(workspaceId, config.appId, senders[0]!.id,
        { name: "陈测试", nameEn: "Test Chen" }, beforeRefresh);
      expect(store.listFeishuBotSenders(workspaceId)[0]).toMatchObject({ ...senders[0],
        allowed: true, display_name: "陈测试", name_en: "Test Chen" });
      expect(store.listFeishuBotSenderProfileSources(workspaceId, beforeRefresh)).toEqual([]);
      store.setFeishuBotSenderAllowed(workspaceId, senders[0]!.id, false, "local");
      expect(store.isFeishuBotTaskIssueCreationRestricted(inbound.taskId)).toBe(true);
      store.upsertFeishuBotConfig(workspaceId, { ...config, appSecretOp: "keep", senderAccessPolicy: "agent" });
      expect(store.isFeishuBotTaskIssueCreationRestricted(inbound.taskId)).toBe(false);
      expect(store.isFeishuBotTaskIssueCreationRestricted(child.id)).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
    }
  });

  it("migrates knowledge control-plane tables and nullable provenance columns", () => {
    for (const table of [
      "multiremi_knowledge_submissions",
      "multiremi_knowledge_compilation_runs",
      "multiremi_knowledge_compilation_run_sources",
      "multiremi_knowledge_compilation_outputs",
    ]) {
      const count = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | string }).n;
      expect(Number(count)).toBeGreaterThanOrEqual(0);
    }
    for (const table of [
      "multiremi_project_docs",
      "multiremi_project_doc_revisions",
      "multiremi_repository_wiki_docs",
      "multiremi_repository_wiki_doc_revisions",
    ]) {
      const columns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toContain("compilation_run_id");
    }

    const workspaceId = freshWorkspace();
    const project = store.createProject({ title: "PG knowledge", workspaceId });
    const doc = store.createProjectDoc(project.id, { kind: "wiki", title: "Traceable", body: "formal" });
    expect(doc.compilationRunId).toBeNull();
    const submission = store.createKnowledgeSubmission({
      workspaceId,
      projectId: project.id,
      scope: "project_wiki",
      sourceType: "legacy_wiki",
      body: "raw",
    }).submission;
    const run = store.createKnowledgeCompilationRun({
      workspaceId,
      projectId: project.id,
      mode: "legacy_migration",
      dedupeKey: "pg-knowledge-run",
    }).run;
    store.addKnowledgeRunSubmissionSource(run.id, submission.id);
    store.linkKnowledgeFormalVersion({
      runId: run.id,
      artifactScope: "project_wiki",
      docId: doc.id,
      version: doc.version,
      action: "create",
    });
    expect(store.getProjectDoc(doc.id)?.compilationRunId).toBe(run.id);
    expect(store.listProjectDocRevisions(doc.id)[0]?.compilationRunId).toBe(run.id);
    expect(store.listKnowledgeRunSources(run.id)).toHaveLength(1);
    expect(store.listKnowledgeRunOutputs(run.id)).toHaveLength(1);

    const submissions = [
      submission,
      ...Array.from({ length: 2 }, (_, index) => store.createKnowledgeSubmission({
        workspaceId,
        projectId: project.id,
        scope: "project_wiki",
        sourceType: "external",
        body: `pg-raw-${index}`,
      }).submission),
    ];
    const firstSubmissions = store.listKnowledgeSubmissionsPage({ workspaceId, projectId: project.id, limit: 2 });
    const remainingSubmissions = store.listKnowledgeSubmissionsPage({
      workspaceId,
      projectId: project.id,
      cursor: firstSubmissions.nextCursor,
      limit: 2,
    });
    expect(firstSubmissions.nextCursor).not.toBeNull();
    expect(remainingSubmissions.nextCursor).toBeNull();
    expect([...firstSubmissions.items, ...remainingSubmissions.items].map(({ id }) => id).sort()).toEqual(
      submissions.map(({ id }) => id).sort(),
    );

    const runs = [
      run,
      ...Array.from({ length: 2 }, () => store.createKnowledgeCompilationRun({
        workspaceId,
        projectId: project.id,
        mode: "manual_edit",
      }).run),
    ];
    const firstRuns = store.listKnowledgeCompilationRunsPage({ workspaceId, projectId: project.id, limit: 2 });
    const remainingRuns = store.listKnowledgeCompilationRunsPage({
      workspaceId,
      projectId: project.id,
      cursor: firstRuns.nextCursor,
      limit: 2,
    });
    expect(firstRuns.nextCursor).not.toBeNull();
    expect(remainingRuns.nextCursor).toBeNull();
    expect([...firstRuns.items, ...remainingRuns.items].map(({ id }) => id).sort()).toEqual(
      runs.map(({ id }) => id).sort(),
    );
  });

  const createDelegationFixture = () => {
    const workspaceId = freshWorkspace();
    const leaderRuntime = store.registerRuntime({
      name: `PG delegation leader runtime ${wsCounter}`,
      provider: "claude",
      workspaceId,
    });
    const qaRuntime = store.registerRuntime({
      name: `PG delegation QA runtime ${wsCounter}`,
      provider: "claude",
      workspaceId,
    });
    const leader = store.createAgent({
      name: `PG Leader ${wsCounter}`,
      provider: "claude",
      runtimeId: leaderRuntime.id,
      workspaceId,
    });
    const qa = store.createAgent({
      name: `PG QA ${wsCounter}`,
      provider: "claude",
      runtimeId: qaRuntime.id,
      workspaceId,
    });
    const squad = store.createSquad({
      name: `PG delegation squad ${wsCounter}`,
      leaderId: leader.id,
      memberIds: [qa.id],
      workspaceId,
    });
    const issue = store.createIssue({
      title: `PG delegation ${wsCounter}`,
      assigneeType: "squad",
      assigneeId: squad.id,
      workspaceId,
    });
    const leaderTask = store.createTask({
      agentId: leader.id,
      issueId: issue.id,
      prompt: "Lead the PG delegation test.",
      workspaceId,
    });
    expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
    store.buildTaskSessionProjection(leaderTask.id);
    store.startTask(leaderTask.id);
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please verify [@QA](mention://agent/${qa.id})`,
    });
    const childTask = store.listTasksForIssue(issue.id).find((task) => task.agentId === qa.id)!;
    store.completeTask(leaderTask.id, { output: "Delegated to QA." });
    expect(store.claimTask(qaRuntime.id)?.id).toBe(childTask.id);
    store.buildTaskSessionProjection(childTask.id);
    store.startTask(childTask.id);
    const report = store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: qa.id,
      taskId: childTask.id,
      body: "Intermediate PG report.",
    });
    const explicitReturn = store.ensureDelegationWakeup({
      sourceTaskId: childTask.id,
      requiredEventSeq: 1_000_000,
      triggerCommentId: report.id,
    }).task!;
    return { workspaceId, leader, qa, issue, childTask, report, explicitReturn };
  };

  it("migrate() created the core tables in Postgres", () => {
    const tables = db
      .query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')")
      .all()
      .map((r: { name: string }) => r.name);
    for (const t of [
      "multiremi_issues",
      "multiremi_projects",
      "multiremi_agents",
      "multiremi_runtimes",
      "multiremi_tasks",
      "multiremi_issue_sessions",
      "multiremi_session_participants",
      "multiremi_session_events",
      "multiremi_session_agent_lanes",
      "multiremi_session_results",
      "multiremi_workspace_members",
      "multiremi_access_tokens",
      "multiremi_users",
      "multiremi_daemon_ssh_mesh_states",
      "multiremi_scm_change_requests",
      "multiremi_scm_issue_links",
      "multiremi_scm_effects",
    ]) {
      expect(tables).toContain(t);
    }
    const sshMeshStateColumns = db.query(
      "PRAGMA table_info(multiremi_daemon_ssh_mesh_states)",
    ).all().map((row: { name: string }) => row.name);
    expect(sshMeshStateColumns).toEqual(expect.arrayContaining(["node_kind", "name"]));
  });

  it("enforces one Feishu bot default route per scope on Postgres", () => {
    const first = store.createAgent({ name: "PG Feishu route A", provider: "codex", workspaceId: "local" });
    const second = store.createAgent({ name: "PG Feishu route B", provider: "codex", workspaceId: "local" });
    const now = new Date().toISOString();
    const insert = (id: string, agentId: string) => db.run(
      `INSERT INTO multiremi_feishu_bot_agent_routes (
         id, workspace_id, scope, chat_id, chat_name, agent_id,
         created_at, updated_at, updated_by
       ) VALUES (?, 'local', 'p2p_default', NULL, NULL, ?, ?, ?, NULL)`,
      [id, agentId, now, now],
    );

    insert("fbr_pg_default_first", first.id);
    expect(() => insert("fbr_pg_default_second", second.id)).toThrow();
    db.run("DELETE FROM multiremi_feishu_bot_agent_routes WHERE id = ?", ["fbr_pg_default_first"]);
  });

  it("does not replay the one-time SCM default backfill on Postgres restart", () => {
    const workspaceId = freshWorkspace();
    const connection = store.createScmConnection({
      workspaceId,
      name: "Explicit selected GitHub",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
    });
    expect(connection).toMatchObject({ repositoryScope: "selected", isDefault: false });

    runMigrations(db);

    expect(store.getScmConnection(connection.id)).toMatchObject({
      repositoryScope: "selected",
      isDefault: false,
    });
  });

  it("backfills session archive retry budgets on Postgres", () => {
    const archiveId = `sar_pg_retry_budget_${process.pid}`;
    db.run(
      "DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260826_session_archive_retry_budget"],
    );
    db.run(
      `INSERT INTO multiremi_session_archives (
        id, issue_id, runtime_id, daemon_id, source_revision, sha256,
        size_bytes, status, relative_path, attempt_count, last_error,
        created_at, updated_at
       ) VALUES (?, ?, 'rt_pg', 'dmn_pg', 'rev-pg', ?, 1, 'failed', ?, 6,
         'network failed', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      [archiveId, `iss_pg_retry_budget_${process.pid}`, "4".repeat(64), `${archiveId}/sessions.tar.gz`],
    );

    runMigrations(db);

    expect(db.query(
      `SELECT status, next_retry_at, retry_exhausted_at
       FROM multiremi_session_archives WHERE id = ?`,
    ).get(archiveId)).toEqual({
      status: "failed",
      next_retry_at: expect.any(String),
      retry_exhausted_at: expect.any(String),
    });
  });

  it("normalizes legacy SCM base URL paths and keeps one default per origin on Postgres", () => {
    const workspaceId = freshWorkspace();
    db.run(
      "DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260822_scm_connection_origins"],
    );
    for (const [id, name, baseUrl, createdAt] of [
      [`scm_pg_origin_first_${wsCounter}`, "First origin", "https://github.com/acme/first", "2026-08-20T00:00:00.000Z"],
      [`scm_pg_origin_second_${wsCounter}`, "Second origin", "https://github.com/acme/second/", "2026-08-21T00:00:00.000Z"],
    ] as const) {
      db.run(
        `INSERT INTO multiremi_scm_connections (
          id, workspace_id, name, provider, mode, base_url, api_base_url,
          repository_scope, is_default, created_at, updated_at
         ) VALUES (?, ?, ?, 'github', 'poll', ?, 'https://api.github.com', 'all', 1, ?, ?)`,
        [id, workspaceId, name, baseUrl, createdAt, createdAt],
      );
    }

    runMigrations(db);

    expect(db.query(
      `SELECT base_url, repository_scope, is_default
       FROM multiremi_scm_connections
       WHERE workspace_id = ? AND provider = 'github'
       ORDER BY created_at, id`,
    ).all(workspaceId)).toEqual([
      { base_url: "https://github.com", repository_scope: "all", is_default: 1 },
      { base_url: "https://github.com", repository_scope: "selected", is_default: 0 },
    ]);

    db.run(
      `UPDATE multiremi_scm_connections
       SET repository_scope = 'selected', is_default = 0
       WHERE workspace_id = ? AND provider = 'github' AND is_default = 1`,
      [workspaceId],
    );
    runMigrations(db);
    const remainingDefaults = db.query(
      `SELECT COUNT(*) AS count FROM multiremi_scm_connections
       WHERE workspace_id = ? AND provider = 'github' AND is_default = 1`,
    ).get(workspaceId) as { count: number | string };
    expect(Number(remainingDefaults.count)).toBe(0);
  });

  it("registers daemon runtimes with models under one lifecycle transaction (PG)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      id: `rt_pg_models_${wsCounter}`,
      name: "PG daemon models",
      provider: "claude",
      daemonId: `daemon-pg-models-${wsCounter}`,
      workspaceId: ws,
      metadata: { agent_plugin_protocol: 1 },
      models: [
        { id: "claude-pg-default", label: "Claude PG", provider: "anthropic", default: true },
        { id: "claude-pg-fast", label: "Claude PG Fast", provider: "anthropic", default: false },
      ],
    });

    expect(runtime.models.map((model) => model.id)).toEqual([
      "claude-pg-default",
      "claude-pg-fast",
    ]);
    expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(1);
  });

  it("serializes competing daemon owner claims while allowing same-owner tokens (PG)", async () => {
    const ws = freshWorkspace();
    const daemonId = `daemon-pg-owner-race-${wsCounter}`;
    const results = await Promise.allSettled([
      store.createAccessToken({
        name: "PG daemon owner A",
        type: "daemon",
        workspaceId: ws,
        daemonId,
        userId: "pg-owner-a",
      }),
      store.createAccessToken({
        name: "PG daemon owner B",
        type: "daemon",
        workspaceId: ws,
        daemonId,
        userId: "pg-owner-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const ownerUserId = store.getDaemonIdentityOwnerUserId(ws, daemonId);
    expect(ownerUserId).not.toBeNull();
    expect(["pg-owner-a", "pg-owner-b"]).toContain(ownerUserId!);
    expect(store.listAccessTokens(ws).filter((token) => token.daemonId === daemonId)).toHaveLength(1);

    const sameOwner = await store.createAccessToken({
      name: "PG same owner second token",
      type: "daemon",
      workspaceId: ws,
      daemonId,
      userId: ownerUserId!,
    });
    expect(sameOwner.daemonId).toBe(daemonId);
    expect(store.registerRuntime({
      id: `rt-pg-owner-race-${wsCounter}`,
      name: "PG same owner runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId,
      ownerId: ownerUserId,
    }).ownerId).toBe(ownerUserId);
    expect(() => store.registerRuntime({
      id: `rt-pg-owner-race-conflict-${wsCounter}`,
      name: "PG conflicting owner runtime",
      provider: "codex",
      workspaceId: ws,
      daemonId,
      ownerId: ownerUserId === "pg-owner-a" ? "pg-owner-b" : "pg-owner-a",
    })).toThrow("already owned by another user");
  });

  it("reports Agent Plugin Runtime state without untyped nullable parameters (PG)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      name: "rt-plugin-state-pg",
      provider: "claude",
      workspaceId: ws,
    });
    const agent = store.createAgent({ name: "Plugin PG", provider: "claude", workspaceId: ws });
    const plugin = store.importAgentPlugin({
      workspaceId: ws,
      provider: "claude",
      manifest: { name: "plugin-state-pg", version: "1.0.0" },
      files: [{ path: "skills/plugin-state/SKILL.md", content: "# Plugin state\n" }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });

    // The omitted attempts value used to become `$3 IS NOT NULL`. Postgres
    // cannot infer a type for that independent placeholder and rejected the
    // whole report even though SQLite accepted it.
    const setup = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "setup_required",
      lastErrorCode: "dependency_missing",
      lastError: "dependency missing",
      nextRetryAt: "2026-08-14T12:00:00.000Z",
    });
    expect(setup).toMatchObject({ status: "setup_required", retryCount: 1 });

    const [retried] = store.retryAgentPluginRuntime(plugin.id, runtime.id);
    const ready = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      attempts: 2,
      retryGeneration: retried!.retryGeneration,
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    expect(ready).toMatchObject({ status: "ready", retryCount: 2 });

    // Import, binding and desired-state reconciliation all take the same
    // workspace lock. Claiming must consume the frozen snapshot without
    // attempting to open a nested transaction on Postgres.
    const task = store.createTask({ agentId: agent.id, prompt: "Use the PG Plugin" });
    const claimed = store.claimTask(runtime.id);
    expect(claimed).toMatchObject({ id: task.id, pluginSnapshot: [{ pluginId: plugin.id }] });
  });

  it("creates and lists projects scoped to a workspace", () => {
    const ws = freshWorkspace();
    const a = store.createProject({ title: "Alpha", workspaceId: ws });
    const b = store.createProject({ title: "Beta", workspaceId: ws });
    const ids = store.listProjects(ws).map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(store.getProject(a.id)?.title).toBe("Alpha");
  });

  it("persists project instruction revisions and rejects stale Postgres writes", () => {
    const ws = freshWorkspace();
    const project = store.createProject(
      { title: "PG instructions", workspaceId: ws, instructions: "Initial" },
      { instructionsUpdatedBy: "usr_pg_creator" },
    );
    expect(project).toMatchObject({
      instructions: "Initial",
      instructionsRevision: 1,
      instructionsUpdatedBy: "usr_pg_creator",
    });

    const updated = store.updateProject(
      project.id,
      { instructions: "Updated", expectedInstructionsRevision: 1 },
      { instructionsUpdatedBy: "usr_pg_editor" },
    );
    expect(updated).toMatchObject({
      instructions: "Updated",
      instructionsRevision: 2,
      instructionsUpdatedBy: "usr_pg_editor",
    });
    expect(() => store.updateProject(
      project.id,
      { instructions: "Stale", expectedInstructionsRevision: 1 },
      { instructionsUpdatedBy: "usr_pg_stale" },
    )).toThrow(ProjectInstructionsRevisionConflictError);
    expect(store.getProject(project.id)).toMatchObject({
      instructions: "Updated",
      instructionsRevision: 2,
      instructionsUpdatedBy: "usr_pg_editor",
    });
  });

  it("persists OpenViking control metadata without project knowledge bodies", () => {
    const ws = freshWorkspace();
    const project = store.createProject({ title: "PG OpenViking", workspaceId: ws });
    const uri = `viking://resources/multiremi/workspaces/${ws}/projects/${project.id}/knowledge/wiki/runbook.md`;
    const created = store.createProjectDocMetadata(project.id, {
      kind: "wiki",
      slug: "runbook",
      title: "Runbook",
      body: "must not enter SQL",
    }, {
      contentUri: uri,
      contentSha256: "hash-v1",
      snapshotOid: "oid-v1",
      syncStatus: "ready",
    });

    expect(created).toMatchObject({
      body: "",
      storageBackend: "openviking",
      contentUri: uri,
      contentSha256: "hash-v1",
      syncStatus: "ready",
      snapshotOid: "oid-v1",
    });
    const v2 = store.replaceProjectDocMetadataExact({
      ...created,
      title: "Runbook v2",
      version: 2,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    }, {
      contentUri: uri,
      contentSha256: "hash-v2",
      snapshotOid: "oid-v2",
      syncStatus: "ready",
    });
    expect(v2).toMatchObject({ body: "", version: 2, contentSha256: "hash-v2", snapshotOid: "oid-v2" });
    expect(store.listProjectDocRevisions(created.id).map((revision) => ({
      version: revision.version,
      body: revision.body,
      contentSha256: revision.contentSha256,
      snapshotOid: revision.snapshotOid,
    }))).toEqual([
      { version: 2, body: "", contentSha256: "hash-v2", snapshotOid: "oid-v2" },
      { version: 1, body: "", contentSha256: "hash-v1", snapshotOid: "oid-v1" },
    ]);
  });

  it("escapes LIKE metacharacters in project doc search the same way sqlite does", () => {
    // searchProjectDocs pins `ESCAPE '\'` into the SQL text. Postgres already
    // treats backslash as the default LIKE escape while sqlite has none, so the
    // clause is what makes the two dialects agree — and it has to survive
    // translateSqliteToPg's string-aware placeholder numbering to get here.
    const ws = freshWorkspace();
    const project = store.createProject({ title: "PG escaping", workspaceId: ws });
    const percent = store.createProjectDoc(project.id, { kind: "memory", title: "Cache hit 90% on warm runs" });
    const underscore = store.createProjectDoc(project.id, { kind: "memory", title: "Set MAX_WORKERS before the run" });
    const backslash = store.createProjectDoc(project.id, { kind: "memory", title: "Windows path C:\\Users\\ci" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Unrelated page" });

    expect(store.searchProjectDocs(project.id, "90%").map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.searchProjectDocs(project.id, "MAX_WORKERS").map((doc) => doc.id)).toEqual([underscore.id]);
    expect(store.searchProjectDocs(project.id, "MAXaWORKERS")).toHaveLength(0);
    expect(store.searchProjectDocs(project.id, "C:\\Users").map((doc) => doc.id)).toEqual([backslash.id]);
    expect(store.searchProjectDocs(project.id, "%").map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.searchProjectDocs(project.id, "_").map((doc) => doc.id)).toEqual([underscore.id]);
    expect(store.searchProjectDocs(project.id, "%unrelated%")).toEqual([]);
  });

  it("lists workspace docs with the project JOIN and literal LIKE on Postgres", () => {
    // listWorkspaceDocs adds a JOIN with an aliased column plus the same
    // ESCAPE'd LIKE block — both must survive translateSqliteToPg.
    const ws = freshWorkspace();
    const alpha = store.createProject({ title: "Alpha PG", workspaceId: ws });
    const beta = store.createProject({ title: "Beta PG", workspaceId: ws });
    const percent = store.createProjectDoc(alpha.id, { kind: "memory", title: "Cache hit 90% on warm runs" });
    store.createProjectDoc(beta.id, { kind: "wiki", title: "Unrelated page" });

    const all = store.listWorkspaceDocs(ws).filter((doc) => doc.slug !== "_schema");
    expect(all.map((doc) => [doc.title, doc.projectTitle]).sort()).toEqual([
      ["Cache hit 90% on warm runs", "Alpha PG"],
      ["Unrelated page", "Beta PG"],
    ]);

    expect(store.listWorkspaceDocs(ws, { q: "90%" }).map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.listWorkspaceDocs(ws, { q: "90a" })).toHaveLength(0);
    expect(store.listWorkspaceDocs(ws, { kind: "memory" }).map((doc) => doc.id)).toEqual([percent.id]);
  });

  it("registers runtimes and upserts them via ON CONFLICT (id) DO UPDATE", () => {
    const ws = freshWorkspace();
    const first = store.registerRuntime({ name: "rt-a", provider: "claude", workspaceId: ws, maxConcurrency: 3 });
    expect(first.status).toBe("online");
    expect(first.maxConcurrency).toBe(3);
    // Re-register same id → UPDATE path (ON CONFLICT), not a duplicate row.
    const again = store.registerRuntime({ id: first.id, name: "rt-a2", provider: "claude", workspaceId: ws, maxConcurrency: 5 });
    expect(again.id).toBe(first.id);
    expect(again.maxConcurrency).toBe(5);
    expect(store.listRuntimes().filter((r) => r.id === first.id).length).toBe(1);
  });

  it("creates and lists agents (non-archived only)", () => {
    const ws = freshWorkspace();
    const agent = store.createAgent({ name: "Ag", provider: "claude", workspaceId: ws });
    const listed = store.listAgents().find((a) => a.id === agent.id);
    expect(listed?.name).toBe("Ag");
  });

  it("creates issues with auto-incrementing per-workspace keys", () => {
    const ws = freshWorkspace();
    const i1 = store.createIssue({ title: "One", workspaceId: ws });
    const i2 = store.createIssue({ title: "Two", workspaceId: ws });
    expect(i1.number).toBe(1);
    expect(i2.number).toBe(2);
    expect(store.getIssue(i1.id)?.title).toBe("One");
  });

  it("persists notification channels and delivery state on Postgres", () => {
    const ws = freshWorkspace();
    const member = store.listWorkspaceMembers(ws)[0]!;
    const issue = store.createIssue({ title: "PG notification", workspaceId: ws });
    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: member.id });
    const item = store.listInboxItems(member.id).find((entry) => entry.issueId === issue.id)!;
    const channel = store.createNotificationChannel({
      workspaceId: ws,
      kind: "feishu_group",
      name: "PG team group",
      target: { chatId: "oc_pg_team" },
      eventTypes: ["issue_assigned"],
      minSeverity: "info",
      createdBy: member.id,
    });

    const delivery = store.recordPendingNotificationDelivery(item, channel);
    expect(store.listNotificationChannels(ws)).toEqual([
      expect.objectContaining({ id: channel.id, target: { chatId: "oc_pg_team" } }),
    ]);
    expect(store.listNotificationDeliveries({ workspaceId: ws })).toEqual([
      expect.objectContaining({ id: delivery.id, status: "pending", attempts: 0 }),
    ]);
    const claimedAt = new Date().toISOString();
    const claimed = store.claimNotificationDeliveryAttempt(
      delivery.id,
      0,
      delivery.claimSeq,
      3,
      claimedAt,
      new Date(Date.now() + 30_000).toISOString(),
    );
    expect(claimed?.attempts).toBe(1);
    expect(store.markNotificationDeliverySent(delivery.id, claimed!.claimSeq)?.status).toBe("sent");
  });

  it("projects and links provider-neutral change requests on Postgres", () => {
    const ws = freshWorkspace();
    const repositoryId = `repo_pg_scm_${wsCounter}`;
    store.updateWorkspace(ws, {
      repos: [{
        id: repositoryId,
        name: "widgets",
        url: "git@github.com:acme/widgets.git",
        source: "github",
        default_branch: "main",
      }],
    });
    const connection = store.createScmConnection({
      workspaceId: ws,
      name: "PG GitHub",
      provider: "github",
      mode: "poll",
      repositoryIds: [repositoryId],
    });
    const issue = store.createIssue({ title: "PG change request", workspaceId: ws });

    expect(store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId,
      entityType: "change_request",
      externalId: "9001",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "open-v1",
      payload: {
        number: 42,
        title: "PG projection",
        body: `Resolves ${issue.key}`,
        state: "open",
        source_branch: "feature/pg",
        target_branch: "main",
      },
    }).applied).toBe(true);

    expect(store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId,
      entityType: "change_request",
      externalId: "without-number",
      revisionAt: "2026-08-21T10:01:00.000Z",
      revision: "v1",
      contentHash: "without-number-v1",
      payload: { title: "Projection without a numeric identifier", state: "open" },
    }).applied).toBe(true);

    const projected = store.listScmChangeRequestsForIssue(issue.id)!;
    expect(projected).toEqual([
      expect.objectContaining({
        externalId: "9001",
        number: 42,
        body: `Resolves ${issue.key}`,
        sourceBranch: "feature/pg",
      }),
    ]);
    expect(store.unlinkScmChangeRequestFromIssue(issue.id, projected[0]!.id)).toBe(true);
    expect(store.listScmChangeRequestsForIssue(issue.id)).toEqual([]);
    expect(store.linkScmChangeRequestToIssue(issue.id, projected[0]!.id).link.source).toBe("manual");
  });

  it("atomically reconciles workspace repositories and selected bindings on Postgres", () => {
    const ws = freshWorkspace();
    const firstId = `repo_pg_atomic_first_${wsCounter}`;
    const secondId = `repo_pg_atomic_second_${wsCounter}`;
    const repositories = [
      { id: firstId, name: "first", url: "git@github.com:acme/first.git", source: "github", default_branch: "main" },
      { id: secondId, name: "second", url: "git@github.com:acme/second.git", source: "github", default_branch: "main" },
    ];
    store.updateWorkspaceRepositories(ws, repositories);
    const connection = store.createScmConnection({
      workspaceId: ws,
      name: "PG selected",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
      repositoryIds: [firstId],
    });

    const replaced = store.updateScmConnection(connection.id, {
      repositoryIds: [secondId],
    });
    expect(replaced.repositories.map((binding) => binding.repositoryId)).toEqual([secondId]);

    expect(() => store.updateScmConnection(connection.id, {
      name: "Must roll back",
      repositoryIds: [secondId, "repo_missing"],
    })).toThrow("Repository not found in workspace");
    expect(store.getScmConnection(connection.id)?.name).toBe("PG selected");
    expect(store.listScmRepositoryBindings({ connectionId: connection.id }).map((binding) => binding.repositoryId))
      .toEqual([secondId]);

    expect(() => store.updateWorkspaceRepositories(ws, [
      repositories[0]!,
      { ...repositories[1]!, url: "git@gitlab.example.test:acme/second.git" },
    ])).toThrow();
    expect(store.getWorkspace(ws)?.repos).toContainEqual(
      expect.objectContaining({ id: secondId, url: "git@github.com:acme/second.git" }),
    );
    expect(store.getScmRepositoryBinding(connection.id, secondId)?.repositoryUrl)
      .toBe("git@github.com:acme/second.git");
  });

  it("persists Issue Sessions, agent lanes, projections, and explicit results", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      name: "rt-session-pg",
      provider: "claude",
      workspaceId: ws,
    });
    const agent = store.createAgent({
      name: "Session PG",
      provider: "claude",
      workspaceId: ws,
      runtimeId: runtime.id,
    });
    const issue = store.createIssue({ title: "Session PG issue", workspaceId: ws });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const sibling = store.createIssueSession(issue.id, { title: "Sibling" });

    store.createIssueComment(issue.id, {
      issueSessionId: main.id,
      body: "Canonical main context",
    });
    store.createIssueComment(issue.id, {
      issueSessionId: sibling.id,
      body: "Private sibling transcript",
    });

    const task = store.createSessionTask(main.id, {
      agentId: agent.id,
      prompt: "Use the main context",
    });
    expect(store.buildTaskSessionProjection(task.id)).toMatchObject({
      mode: "bootstrap",
      sessionId: main.id,
      targetAgentId: agent.id,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const prompt = "# Bootstrap Prompt\n\n## Current Request\nUse the main context";
    const recordedPrompt = store.recordTaskPrompt(task.id, {
      mode: "bootstrap",
      prompt,
      sha256: createHash("sha256").update(prompt).digest("hex"),
    });
    expect(store.getTaskPrompt(task.id)).toEqual(recordedPrompt);
    store.startTask(task.id);
    store.completeTask(task.id, {
      output: "Main answer",
      sessionId: "pg_acp_session",
      workDir: "/tmp/pg-issue-session",
    });

    expect(store.getSessionAgentLane(main.id, agent.id)).toMatchObject({
      providerSessionId: "pg_acp_session",
      runtimeId: runtime.id,
      provider: "claude",
      lastTaskId: task.id,
    });
    expect(store.listSessionEvents(main.id).some((event) => event.body === "Private sibling transcript")).toBe(false);

    const result = store.publishSessionResult(main.id, {
      title: "Reusable decision",
      body: "Only this bounded result crosses Sessions.",
    });
    expect(store.listIssueSessionResults(issue.id)).toEqual([result]);
  });

  it("listIssues pushes status/priority/project/assignee filters + pagination into SQL", () => {
    const ws = freshWorkspace();
    const project = store.createProject({ title: "P", workspaceId: ws });
    const todoHigh = store.createIssue({ title: "todo-high", workspaceId: ws, status: "todo", priority: "high", projectId: project.id });
    const progLow = store.createIssue({ title: "prog-low", workspaceId: ws, status: "in_progress", priority: "low" });
    const done = store.createIssue({ title: "done", workspaceId: ws, status: "done", priority: "none" });

    const keyset = (issues: { id: string }[]) => new Set(issues.map((i) => i.id));

    expect(keyset(store.listIssues({ workspaceId: ws }))).toEqual(keyset([todoHigh, progLow, done]));
    expect(store.listIssues({ workspaceId: ws, statuses: ["todo"] }).map((i) => i.id)).toEqual([todoHigh.id]);
    expect(store.listIssues({ workspaceId: ws, statuses: ["todo", "in_progress"] }).length).toBe(2);
    expect(store.listIssues({ workspaceId: ws, priorities: ["high"] }).map((i) => i.id)).toEqual([todoHigh.id]);
    expect(store.listIssues({ workspaceId: ws, projectId: project.id }).map((i) => i.id)).toEqual([todoHigh.id]);
    expect(store.listIssues({ workspaceId: ws, includeNoProject: true }).length).toBe(2);
    // LIMIT/OFFSET pushdown: ordered by updated_at DESC (last created first).
    expect(store.listIssues({ workspaceId: ws, limit: 1 }).length).toBe(1);
    expect(store.listIssues({ workspaceId: ws, limit: 2, offset: 2 }).length).toBe(1);
  });

  it("keeps backlog out of active child progress and projects parent inbox fields (PG)", () => {
    const ws = freshWorkspace();
    const member = store.createWorkspaceMember({ name: "Parent owner", workspaceId: ws, role: "member" });
    const parent = store.createIssue({ title: "Parent", workspaceId: ws, status: "in_progress", assigneeType: "member", assigneeId: member.id });
    store.createIssue({ title: "Unscheduled", workspaceId: ws, parentIssueId: parent.id, status: "backlog" });
    store.createIssue({ title: "Active", workspaceId: ws, parentIssueId: parent.id, status: "todo" });
    const terminal = store.createIssue({ title: "Terminal", workspaceId: ws, parentIssueId: parent.id, status: "in_progress" });
    store.updateIssue(terminal.id, { status: "done" });

    expect(store.getChildIssueProgress(parent.id)).toMatchObject({ total: 3, active: 1, done: 1, waiting: 0 });
    const notification = store.listInboxItems(member.id, ws).find((item) => item.type === "child_issue_terminal");
    expect(notification).toMatchObject({
      issueId: parent.id,
      issue_parent_id: parent.id,
      issue_parent_key: parent.key,
      issue_parent_title: parent.title,
    });
  });

  it("scopes parent projections and progress to the child's workspace (PG)", () => {
    const workspaceA = freshWorkspace();
    const workspaceB = freshWorkspace();
    const reviewer = store.createWorkspaceMember({ name: "Scoped parent reviewer", workspaceId: workspaceA, role: "member" });
    const author = store.createWorkspaceMember({ name: "Scoped parent author", workspaceId: workspaceA, role: "member" });
    const parent = store.createIssue({ title: "Parent moved to B", workspaceId: workspaceA });
    const child = store.createIssue({
      title: "Child staying in A",
      workspaceId: workspaceA,
      parentIssueId: parent.id,
      createdBy: reviewer.id,
      status: "todo",
    });
    store.createIssueComment(child.id, {
      authorType: "member",
      authorId: author.id,
      body: "Notify before moving the parent",
    });

    // MUL-476 refuses moving an Issue that still has a child, so the parent can
    // only be in B as a legacy row from before that rule, which is not migrated.
    expect(() => store.updateIssue(parent.id, { workspaceId: workspaceB }))
      .toThrow("Detach parent, child and dependency relationships, cancel or finish its tasks, and clean or abandon its Issue workspace before moving an issue to another workspace");
    expect(store.getIssue(parent.id)?.workspaceId).toBe(workspaceA);
    db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [workspaceB, parent.id]);
    expect(store.getIssue(parent.id)?.workspaceId).toBe(workspaceB);

    expect(store.listInboxItems(reviewer.id, workspaceA).find((item) => item.issueId === child.id)).toMatchObject({
      issue_parent_id: null,
      issue_parent_key: null,
      issue_parent_title: null,
    });
    expect(store.getChildIssueProgress(parent.id)).toMatchObject({ total: 0, active: 0 });
    expect(store.listChildIssueProgress(workspaceA).some((progress) => progress.parentIssueId === parent.id)).toBe(false);
    expect(store.listChildIssueProgress(workspaceB).some((progress) => progress.parentIssueId === parent.id)).toBe(false);
    expect(store.listIssues({ workspaceId: workspaceA, topLevelOnly: true }).map((issue) => issue.id)).toContain(child.id);
    expect(store.listIssues({ workspaceId: workspaceA, parentId: parent.id })).toHaveLength(0);

    const deletedParent = store.createIssue({ title: "Parent deleted in A", workspaceId: workspaceA });
    const orphan = store.createIssue({
      title: "Child orphaned in A",
      workspaceId: workspaceA,
      parentIssueId: deletedParent.id,
      createdBy: reviewer.id,
    });
    store.createIssueComment(orphan.id, {
      authorType: "member",
      authorId: author.id,
      body: "Notify before deleting the parent",
    });
    expect(store.deleteIssue(deletedParent.id)).toBe(true);
    expect(store.listInboxItems(reviewer.id, workspaceA).find((item) => item.issueId === orphan.id)).toMatchObject({
      issue_parent_id: null,
      issue_parent_key: null,
      issue_parent_title: null,
    });
  });

  it("filters issues by assignee via the IN (…) pushdown", () => {
    const ws = freshWorkspace();
    const member = store.createWorkspaceMember({ name: "Assignee", workspaceId: ws, role: "member" });
    const assigned = store.createIssue({ title: "assigned", workspaceId: ws, assigneeType: "member", assigneeId: member.id });
    store.createIssue({ title: "unassigned", workspaceId: ws });
    expect(store.listIssues({ workspaceId: ws, assigneeIds: [member.id] }).map((i) => i.id)).toEqual([assigned.id]);
    expect(store.listIssues({ workspaceId: ws, assigneeTypes: ["member"] }).map((i) => i.id)).toEqual([assigned.id]);
    expect(store.listIssues({ workspaceId: ws, includeNoAssignee: true }).map((i) => i.title)).toEqual(["unassigned"]);
  });

  it("claims a queued task for a runtime via the UPDATE … RETURNING pushdown", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-claim", provider: "claude", workspaceId: ws, maxConcurrency: 2 });
    const agent = store.createAgent({ name: "Claimer", provider: "claude", workspaceId: ws, runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "go", workspaceId: ws });
    expect(task.status).toBe("queued");

    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("dispatched");
    expect(claimed?.agent?.id).toBe(agent.id);
    // Nothing left queued → second claim yields null.
    expect(store.claimTask(runtime.id)).toBeNull();
  });

  it("skips identical task-message retries but persists changed seqs on Postgres", () => {
    const ws = freshWorkspace();
    const agent = store.createAgent({ name: "Replay", provider: "claude", workspaceId: ws });
    const task = store.createTask({ agentId: agent.id, prompt: "go", workspaceId: ws });
    const events: number[][] = [];
    const unsub = store.onTaskMessages(({ task: notified, messages }) => {
      if (notified.id === task.id) events.push(messages.map((message) => message.seq));
    });

    const first = store.appendTaskMessages(task.id, [{ seq: 1, type: "tool_use", status: "in_progress" }]);
    db.run("UPDATE multiremi_tasks SET updated_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    expect(store.appendTaskMessages(task.id, [{ seq: 1, type: "tool_use", status: "in_progress" }])).toEqual([]);
    expect(store.getTask(task.id)?.updatedAt).toBe("2000-01-01T00:00:00.000Z");

    const changed = store.appendTaskMessages(task.id, [{ seq: 1, type: "tool_result", status: "completed" }]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: first[0]!.id, createdAt: first[0]!.createdAt, type: "tool_result" });
    expect(events).toEqual([[1], [1]]);
    unsub();
  });

  it.each([false, true])("claims contexts atomically across connections (independent Agents: %s)", async (independent) => {
    const ws = freshWorkspace();
    const firstRuntime = store.registerRuntime({
      name: "rt-workspace-lease-a",
      provider: "claude",
      workspaceId: ws,
      maxConcurrency: 2,
    });
    const secondRuntime = store.registerRuntime({
      name: "rt-workspace-lease-b",
      provider: "claude",
      workspaceId: ws,
      maxConcurrency: 2,
    });
    const firstAgent = store.createAgent({
      name: "Workspace lease A",
      provider: "claude",
      workspaceId: ws,
      maxConcurrentTasks: 2,
    });
    const issue = store.createIssue({ title: "Concurrent workspace lease", workspaceId: ws });
    const firstSession = store.createIssueSession(issue.id, { title: "Work A" });
    const secondAgent = independent
      ? store.createAgent({ name: "Independent worker", provider: "claude", workspaceId: ws, maxConcurrentTasks: 2 })
      : firstAgent;
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: firstSession.id,
      priority: 10,
      prompt: "claim A",
    });
    const second = store.createTask({
      agentId: secondAgent.id,
      issueId: issue.id,
      issueSessionId: firstSession.id,
      prompt: "claim B",
    });

    const workerUrl = new URL("./fixtures/postgres-workspace-lease-claim-worker.ts", import.meta.url).href;
    const firstWorker = new Worker(workerUrl);
    const secondWorker = new Worker(workerUrl);
    const firstReady = waitForWorkerPhase(firstWorker, "ready");
    const secondReady = waitForWorkerPhase(secondWorker, "ready");
    const databaseUrl = pgDatabaseUrl(TEST_DB);
    firstWorker.postMessage({ type: "init", databaseUrl });
    secondWorker.postMessage({ type: "init", databaseUrl });
    await Promise.all([firstReady, secondReady]);

    const firstClaim = waitForWorkerMessage<{ taskId: string | null }>(firstWorker, "claimed");
    const secondClaim = waitForWorkerMessage<{ taskId: string | null }>(secondWorker, "claimed");
    firstWorker.postMessage({ type: "claim", runtimeId: firstRuntime.id });
    secondWorker.postMessage({ type: "claim", runtimeId: secondRuntime.id });
    const claimedIds = (await Promise.all([firstClaim, secondClaim]))
      .map((result) => result.taskId)
      .filter((taskId): taskId is string => Boolean(taskId));

    expect(claimedIds).toHaveLength(independent ? 2 : 1);
    expect([first.id, second.id]).toContain(claimedIds[0]);
    expect([store.getTask(first.id)?.status, store.getTask(second.id)?.status].sort())
      .toEqual(independent ? ["dispatched", "dispatched"] : ["dispatched", "queued"]);

    const firstClosed = waitForWorkerPhase(firstWorker, "closed");
    const secondClosed = waitForWorkerPhase(secondWorker, "closed");
    firstWorker.postMessage({ type: "close" });
    secondWorker.postMessage({ type: "close" });
    await Promise.all([firstClosed, secondClosed]);
    firstWorker.terminate();
    secondWorker.terminate();
  });

  it("preserves Chat queue order, resumes at claim, and projects sequenced messages", () => {
    const workspace = store.createWorkspace({ name: "PG chat queue", slug: "pg-chat-queue" });
    const agent = store.createAgent({ name: "PG chat", provider: "codex", workspaceId: workspace.id, maxConcurrentTasks: 4 });
    const runtime = store.registerRuntime({ name: "PG chat runtime", provider: "codex", workspaceId: workspace.id, maxConcurrency: 4 });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id });
    const first = store.sendChatMessage(chat.id, { content: "first" });
    const second = store.sendChatMessage(chat.id, { content: "second" });
    expect(store.getPendingChatTask(chat.id)?.id).toBe(first.task.id);
    expect(JSON.stringify(store.buildTaskSessionProjection(first.task.id))).not.toContain("second");
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "answer", sessionId: "pg-chat-session", workDir: "/tmp/pg-chat-queue" });
    expect(store.listChatMessages(chat.id).map((message) => message.body)).toEqual(["first", "second", "answer"]);
    expect(store.getChatSession(chat.id)?.lastMessage?.content).toBe("answer");
    expect(store.claimTask(runtime.id)?.sessionId).toBe("pg-chat-session");
    expect(store.buildTaskSessionProjection(second.task.id)?.mode).toBe("delta");
    store.updateChatSession(chat.id, { pinned: true, status: "archived" });
    expect(store.getChatSession(chat.id)?.pinned).toBe(true);
    expect(store.getTask(second.task.id)?.status).toBe("cancelled");
  });

  it("pool-claims unbound agents' tasks and stamps affinity (chat session + local directory)", () => {
    const ws = freshWorkspace();
    const codex = store.registerRuntime({ name: "rt-pool-codex", provider: "codex", workspaceId: ws, daemonId: "daemon-pg-pool" });
    const claude = store.registerRuntime({ name: "rt-pool-claude", provider: "claude", workspaceId: ws });
    const agent = store.createAgent({ name: "PG Pool", provider: "codex", workspaceId: ws });
    expect(agent.runtimeId).toBeNull();

    // Unbound task: claude can't claim it, codex can, and the claim stamps it.
    const task = store.createTask({ agentId: agent.id, prompt: "pooled", workspaceId: ws });
    expect(task.runtimeId).toBeNull();
    expect(store.claimTask(claude.id)).toBeNull();
    expect(store.claimTask(codex.id)?.id).toBe(task.id);
    expect(store.getTask(task.id)?.runtimeId).toBe(codex.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });

    // Chat affinity: a promoted provider session pins follow-ups to its machine.
    const session = store.createChatSession({ agentId: agent.id, title: "pg chat", workspaceId: ws });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi", workspaceId: ws });
    expect(first.runtimeId).toBeNull();
    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "done", sessionId: "sess_pg_chat", workDir: "/tmp/pg-chat" });
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again", workspaceId: ws });
    expect(followUp.runtimeId).toBe(codex.id);

    // local_directory affinity resolves the daemon's provider-matching runtime.
    const project = store.createProject({
      title: "PG local dir",
      workspaceId: ws,
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/pg-project", daemon_id: "daemon-pg-pool" } }],
    });
    const issue = store.createIssue({ title: "pg dir issue", workspaceId: ws, projectId: project.id });
    const dirTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work in dir", workspaceId: ws });
    expect(dirTask.runtimeId).toBe(codex.id);

    // Ownership predicate: another member's private runtime can't claim the
    // pool task; a public one can. (Same SQL path as SQLite — this guards the
    // translated Postgres form.)
    const privateRt = store.registerRuntime({
      name: "rt-pool-private",
      provider: "codex",
      workspaceId: ws,
      ownerId: "someone-else",
      visibility: "private",
    });
    const publicRt = store.registerRuntime({
      name: "rt-pool-public",
      provider: "codex",
      workspaceId: ws,
      ownerId: "someone-else",
      visibility: "public",
    });
    const ownedIssue = store.createIssue({ title: "pg owned", workspaceId: ws });
    const ownedTask = store.createTask({ agentId: agent.id, issueId: ownedIssue.id, prompt: "owned", workspaceId: ws });
    expect(store.claimTask(privateRt.id)).toBeNull();
    expect(store.claimTask(publicRt.id)?.id).toBe(ownedTask.id);
  });

  it("serializes Runtime-affine project, token, and Issue workspace writes with daemon retirement", async () => {
    const ws = freshWorkspace();
    const daemonId = `daemon-pg-retire-${wsCounter}`;
    const runtime = store.registerRuntime({
      id: daemonRuntimeId(daemonId, "claude"),
      name: "PG retiring runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId,
    });
    const unboundDaemonToken = await store.createAccessToken({
      name: "PG unbound daemon",
      type: "daemon",
      workspaceId: ws,
    });
    const project = store.createProject({
      title: "PG lifecycle lock",
      workspaceId: ws,
      resources: [{
        resourceType: "local_directory",
        resourceRef: { localPath: "/abs/pg-other-machine", daemonId: "daemon-pg-other" },
      }],
    });
    const localDirectory = store.listProjectResources(project.id)[0]!;
    const issue = store.createIssue({ title: "PG clean workspace", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/abs/pg-issue",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });
    const deletedIssue = store.createIssue({ title: "PG deleted workspace", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: deletedIssue.id,
      runtimeId: runtime.id,
      rootPath: "/abs/pg-deleted-issue",
      branchName: `agent/${deletedIssue.key}`,
      status: "in_use",
    });
    expect(store.deleteIssue(deletedIssue.id)).toBeFalse();
    store.markIssueWorkspaceCleaned({
      issueId: deletedIssue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, deletedIssue.id, runtime.id),
    });
    expect(store.deleteIssue(deletedIssue.id)).toBeTrue();
    expect(store.getIssueWorkspace(deletedIssue.id)).toBeNull();
    expect(Number((db.query(
      "SELECT COUNT(*) AS count FROM multiremi_issue_workspaces WHERE issue_id = ?",
    ).get(deletedIssue.id) as { count: number }).count)).toBe(0);
    const completedSkillImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "pg-completed-skill" });
    const completedSkill = store.reportRuntimeLocalSkillImportResult(runtime.id, completedSkillImport.id, {
      status: "completed",
      skill: { name: "PG imported skill", content: "# PG imported skill" },
    });
    expect(completedSkill.status).toBe("completed");
    expect(completedSkill.skill?.name).toBe("PG imported skill");
    const localSkillImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "pg-retired-skill" });
    const skillCountBeforeRetirement = store.listSkills(ws).length;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO multiremi_daemon_ssh_mesh_states (
         workspace_id, daemon_id, runtime_id, protocol_version, status, key_version,
         config_revision, ssh_user, hostname, addresses, host_keys,
         public_key_installed, config_installed, peer_tests,
         probe_revision, desired_probe_revision, probe_target_daemon_ids,
         last_error_code, last_error, last_reported_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'ready', 7, ?, 'pg-user', 'pg-host', ?, ?, 1, 1, ?, 3, 4, ?,
                 'old-error', 'old detail', ?, ?, ?)`,
      [
        ws,
        daemonId,
        runtime.id,
        "pg-config-revision",
        JSON.stringify(["10.0.0.8"]),
        JSON.stringify(["ssh-ed25519 AAAAPG"]),
        JSON.stringify([{ daemon_id: "peer", status: "ready" }]),
        JSON.stringify(["peer"]),
        now,
        now,
        now,
      ],
    );

    const plan = store.getDaemonRetirementPlan(ws, daemonId);
    expect(plan.canRetire).toBeTrue();
    expect(store.retireDaemon(ws, daemonId, plan.snapshot, null).status).toBe("retired");
    expect(db.query(
      `SELECT runtime_id, protocol_version, status, key_version, config_revision,
              ssh_user, hostname, addresses, host_keys, public_key_installed,
              config_installed, peer_tests, probe_revision, desired_probe_revision,
              probe_target_daemon_ids, last_error_code, last_error
       FROM multiremi_daemon_ssh_mesh_states
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get(ws, daemonId)).toMatchObject({
      runtime_id: null,
      protocol_version: 0,
      status: "cleaned",
      key_version: null,
      config_revision: null,
      ssh_user: null,
      hostname: null,
      addresses: "[]",
      host_keys: "[]",
      public_key_installed: 0,
      config_installed: 0,
      peer_tests: "[]",
      probe_revision: 0,
      desired_probe_revision: 0,
      probe_target_daemon_ids: "[]",
      last_error_code: null,
      last_error: null,
    });
    expect(() => store.updateProjectResource(project.id, localDirectory.id, {
      resourceRef: { localPath: "/abs/pg-retired-machine", daemonId },
    })).toThrow("has been retired");
    expect(() => store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/abs/pg-resurrected",
      branchName: `agent/${issue.key}`,
      status: "ready",
    })).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.updateRuntimeModels(runtime.id, [{ id: "late-pg-model", label: "Late PG", provider: "anthropic", default: false }]))
      .toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeDirectoryScanRequest(runtime.id)).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeModelListRequest(runtime.id)).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9" }))
      .toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeLocalSkillListRequest(runtime.id)).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "late-pg-skill" }))
      .toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.reportRuntimeLocalSkillImportResult(runtime.id, localSkillImport.id, {
      status: "completed",
      skill: { name: "Dangling PG skill", content: "Never persisted" },
    })).toThrow("request not found");
    expect(store.listSkills(ws)).toHaveLength(skillCountBeforeRetirement);
    expect(() => store.bindDaemonAccessToken(unboundDaemonToken.id, daemonId)).toThrow("has been retired");
    expect(store.getAccessToken(unboundDaemonToken.id)?.daemonId).toBeNull();
    await expect(store.createAccessToken({
      name: "PG rejected retired daemon",
      type: "daemon",
      workspaceId: ws,
      daemonId,
    })).rejects.toThrow("has been retired");
  });

  it("rejects ordinary disable and explicitly invalidates an SSH Mesh rollout on Postgres", () => {
    const previousKey = process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
    process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const ws = freshWorkspace();
      const daemonId = `daemon-pg-ssh-emergency-${wsCounter}`;
      store.registerRuntime({
        id: `rt-pg-ssh-emergency-${wsCounter}`,
        name: "PG SSH emergency daemon",
        provider: "claude",
        workspaceId: ws,
        daemonId,
      });
      store.setSshMeshEnabled(ws, true, {
        privateKey: "test-private-key-v1",
        publicKey: "ssh-ed25519 test-v1",
        fingerprint: "SHA256:test-v1",
      }, null);
      expect(store.rotateSshMeshKey(ws, {
        privateKey: "test-private-key-v2",
        publicKey: "ssh-ed25519 test-v2",
        fingerprint: "SHA256:test-v2",
      })).toMatchObject({ key_version: 2, rotation_state: "rolling_out" });

      const rollingRow = db.query(
        `SELECT active_key_version, active_operation_id, active_private_key_encrypted,
                active_public_key, active_fingerprint, previous_private_key_encrypted,
                previous_public_key, previous_fingerprint, enabled, rotation_state
         FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
      ).get(ws);
      expect(() => store.setSshMeshEnabled(ws, false, null, null))
        .toThrow("SSH Mesh key rotation is in progress; confirm key invalidation to disable");
      expect(db.query(
        `SELECT active_key_version, active_operation_id, active_private_key_encrypted,
                active_public_key, active_fingerprint, previous_private_key_encrypted,
                previous_public_key, previous_fingerprint, enabled, rotation_state
         FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
      ).get(ws)).toEqual(rollingRow);

      expect(store.invalidateSshMeshKey(ws)).toMatchObject({
        enabled: false,
        key_version: 3,
        fingerprint: null,
        rotation_state: "rekey_required",
      });
      const row = db.query(
        `SELECT active_operation_id, active_private_key_encrypted, active_public_key, active_fingerprint,
                previous_private_key_encrypted, previous_public_key, previous_fingerprint
         FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
      ).get(ws) as Record<string, unknown>;
      expect(String(row.active_operation_id)).toStartWith("sshinvalidate_");
      expect(Object.entries(row)
        .filter(([column]) => column !== "active_operation_id")
        .every(([, value]) => value === null)).toBeTrue();

      const plan = store.getDaemonRetirementPlan(ws, daemonId);
      expect(store.retireDaemon(ws, daemonId, plan.snapshot, null)).toMatchObject({ status: "retired" });
      expect(store.deleteWorkspace(ws)).toBeTrue();
    } finally {
      if (previousKey === undefined) delete process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
      else process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = previousKey;
    }
  });

  it("records an idempotent explicit SSH key invalidation on Postgres", () => {
    const ws = freshWorkspace();
    const first = store.invalidateSshMeshKey(ws);
    expect(first).toMatchObject({
      enabled: false,
      key_version: 1,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    expect(store.invalidateSshMeshKey(ws)).toMatchObject({
      enabled: false,
      key_version: 1,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    expect(store.deleteWorkspace(ws)).toBeTrue();
  });

  it("persists custom execution groups and enforces membership claims on Postgres", () => {
    const ws = freshWorkspace();
    const first = store.registerRuntime({ name: "Group A", provider: "codex", workspaceId: ws, executionGroupId: "shared", models: [
      { id: "group-model", label: "Model", provider: "openai", default: true },
    ] });
    const second = store.registerRuntime({ name: "Group B", provider: "codex", workspaceId: ws, executionGroupId: "shared", models: [
      { id: "group-model", label: "Model", provider: "openai", default: true },
    ] });
    const agent = store.createAgent({ name: "Grouped worker", provider: "codex", workspaceId: ws, executionGroupId: "shared", model: "group-model" });
    const task = store.createTask({ agentId: agent.id, prompt: "Only group members" });
    store.updateRuntime(first.id, { executionGroupId: "departed" });
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.claimTask(second.id)?.id).toBe(task.id);
    store.cancelTask(task.id);
    expect(store.deleteRuntime(second.id)).toBeTrue();
    expect(store.getExecutionGroup("shared", ws)?.runtimeIds).toEqual([]);
    expect(store.getAgent(agent.id)?.executionGroupId).toBe("shared");
    expect(Number((db.query("SELECT COUNT(*) AS count FROM multiremi_execution_group_members WHERE runtime_id = ?").get(second.id) as { count: number }).count)).toBe(0);
  });

  it("migrates and cleans complete Runtime auxiliary state on Postgres", () => {
    const ws = freshWorkspace();
    const oldRuntime = store.registerRuntime({
      id: `rt-pg-merge-old-${wsCounter}`,
      name: "PG old Runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId: `daemon-pg-old-${wsCounter}`,
      models: [
        { id: "old-only", label: "Old only", provider: "claude", default: false },
        { id: "shared", label: "Old shared", provider: "claude", default: true },
      ],
    });
    const newRuntime = store.registerRuntime({
      id: `rt-pg-merge-new-${wsCounter}`,
      name: "PG new Runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId: `daemon-pg-new-${wsCounter}`,
      models: [
        { id: "shared", label: "New shared", provider: "claude", default: true },
        { id: "new-only", label: "New only", provider: "claude", default: false },
      ],
    });
    const agent = store.createAgent({
      name: "PG merged agent",
      provider: "claude",
      workspaceId: ws,
      runtimeId: oldRuntime.id,
    });
    const issue = store.createIssue({ title: "PG merged workspace", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: oldRuntime.id,
      rootPath: "/tmp/pg-merged",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const requests = [
      ["multiremi_runtime_model_list_requests", store.createRuntimeModelListRequest(oldRuntime.id).id],
      ["multiremi_runtime_update_requests", store.createRuntimeUpdateRequest(oldRuntime.id, { targetVersion: "2.0.0" }).id],
      ["multiremi_runtime_local_skill_list_requests", store.createRuntimeLocalSkillListRequest(oldRuntime.id).id],
      ["multiremi_runtime_local_skill_import_requests", store.createRuntimeLocalSkillImportRequest(oldRuntime.id, { skillKey: "pg-merge" }).id],
      ["multiremi_runtime_directory_scan_requests", store.createRuntimeDirectoryScanRequest(oldRuntime.id, { root: "/tmp" }).id],
    ] as const;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO multiremi_agent_plugin_runtime_states (
        id, workspace_id, runtime_id, plugin_id, plugin_version_id,
        desired, desired_reason, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'active_binding', 'pending', ?, ?)`,
      [`aprs-pg-merge-${wsCounter}`, ws, oldRuntime.id, `apl-pg-${wsCounter}`, `apv-pg-${wsCounter}`, now, now],
    );

    expect(store.mergeRuntimeInto(oldRuntime.id, newRuntime.id).deleted).toBeTrue();
    expect(store.getAgent(agent.id)?.runtimeId).toBe(newRuntime.id);
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: newRuntime.id, status: "ready" });
    expect(store.listRuntimeModels(newRuntime.id).map((model) => model.id).sort())
      .toEqual(["new-only", "old-only", "shared"]);
    expect(store.listRuntimeModels(newRuntime.id).find((model) => model.id === "shared")?.label).toBe("New shared");
    for (const [table, requestId] of requests) {
      expect(Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ? AND id = ?`).get(
        newRuntime.id,
        requestId,
      ) as { count: number }).count)).toBe(1);
      expect(Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`).get(
        oldRuntime.id,
      ) as { count: number }).count)).toBe(0);
    }
    expect(Number((db.query(
      "SELECT COUNT(*) AS count FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ?",
    ).get(oldRuntime.id) as { count: number }).count)).toBe(0);

    // Runtime cleanup is still exercised directly, but keep one sibling for
    // this managed daemon so the last-Runtime guard correctly reserves whole
    // machine removal for the daemon retirement flow.
    store.registerRuntime({
      id: `rt-pg-merge-sibling-${wsCounter}`,
      name: "PG sibling Runtime",
      provider: "codex",
      workspaceId: ws,
      daemonId: newRuntime.daemonId,
    });
    expect(store.deleteRuntime(newRuntime.id)).toBeFalse();
    store.updateAgent(agent.id, { runtimeId: null });
    expect(store.deleteRuntime(newRuntime.id)).toBeFalse();
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: newRuntime.id, status: "ready" });
    expect(store.deleteRuntimeWithArchivedAgentCleanup(newRuntime.id, { abandonIssueWorkspaces: true })).toEqual({
      status: "deleted", issueWorkspacesAbandoned: 1,
    });
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: null, status: "cleaned" });
    for (const table of [
      "multiremi_agent_plugin_runtime_states",
      "multiremi_runtime_models",
      ...requests.map(([table]) => table),
    ]) {
      expect(Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`).get(
        newRuntime.id,
      ) as { count: number }).count)).toBe(0);
    }
  });

  it("re-pins a local_directory task when its runtime re-registers under a new engine", () => {
    const ws = freshWorkspace();
    store.registerRuntime({ id: "rt-pg-repin", name: "rt-pg-repin", provider: "codex", workspaceId: ws, daemonId: "daemon-pg-repin" });
    const agent = store.createAgent({ name: "PG Repin", provider: "codex", workspaceId: ws });
    const project = store.createProject({
      title: "PG repin dir",
      workspaceId: ws,
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/pg-repin", daemon_id: "daemon-pg-repin" } }],
    });
    const issue = store.createIssue({ title: "pg repin issue", workspaceId: ws, projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work", workspaceId: ws });
    expect(task.runtimeId).toBe("rt-pg-repin");
    // Same-id re-registration flips the engine → the codex directory task re-pins
    // to the daemon's codex runtime id (exercises the repool UPDATE on Postgres).
    store.registerRuntime({ id: "rt-pg-repin", name: "rt-pg-repin", provider: "claude", workspaceId: ws, daemonId: "daemon-pg-repin" });
    expect(store.getTask(task.id)?.runtimeId).toBe(daemonRuntimeId("daemon-pg-repin", "codex"));
  });

  it("creates and lists workspace members", () => {
    const ws = freshWorkspace();
    const before = store.listWorkspaceMembers(ws).length; // owner seeded by createWorkspace
    const bob = store.createWorkspaceMember({ name: "Bob", workspaceId: ws, role: "member", email: "bob@e.com" });
    const members = store.listWorkspaceMembers(ws);
    expect(members.length).toBe(before + 1);
    expect(members.find((m) => m.id === bob.id)?.email).toBe("bob@e.com");
  });

  it("resolves users by external id and email (getOrCreateUser)", () => {
    const created = store.getOrCreateUser({ externalId: "ou_pgtest", email: "pg@e.com", name: "PG User" });
    expect(store.getOrCreateUser({ externalId: "ou_pgtest", email: "pg@e.com" }).id).toBe(created.id);
    expect(store.getUserByExternalId("ou_pgtest")?.id).toBe(created.id);
    expect(store.getUserByEmail("PG@E.com")?.id).toBe(created.id);
  });

  it("mints, lists, verifies, and revokes access tokens", async () => {
    const ws = freshWorkspace();
    const created = await store.createAccessToken({ workspaceId: ws, userId: "local", name: "PAT", type: "pat", expiresInDays: 30 });
    expect(created.token).toBeTruthy();

    const listed = store.listAccessTokens(ws);
    expect(listed.map((t) => t.id)).toContain(created.id);

    const verified = await store.verifyAccessToken(created.token);
    expect(verified?.id).toBe(created.id);
    expect(verified?.lastUsedAt).toBeTruthy(); // UPDATE … SET last_used_at ran

    store.revokeAccessToken(created.id);
    expect(await store.verifyAccessToken(created.token)).toBeNull();
  });

  it("runs transactions (createProject with nested resource) atomically", () => {
    const ws = freshWorkspace();
    store.updateWorkspaceRepositories(ws, [{
      id: `repo_pg_nested_${wsCounter}`,
      name: "repo",
      url: "https://github.com/owner/repo",
      source: "github",
    }]);
    const project = store.createProject({
      title: "With resources",
      workspaceId: ws,
      resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/owner/repo" } }],
    });
    expect(store.getProject(project.id)?.title).toBe("With resources");
    expect(store.listProjectResources(project.id).length).toBe(1);
  });

  it("upserts Issue session preparation failures on Postgres", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      name: "archive-failure-pg",
      provider: "codex",
      workspaceId: ws,
      daemonId: `dmn_archive_failure_${wsCounter}`,
    });
    const issue = store.createIssue({ title: "Archive failure PG", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const input = {
      workspaceId: ws,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      stage: "prepare" as const,
      error: "first pack failure",
    };

    const first = store.reportSessionArchiveFailure(
      input,
      `sar_failure_${wsCounter}`,
      `failures/sar_failure_${wsCounter}/sessions.tar.gz`,
    );
    expect(first).toMatchObject({
      created: true,
      archive: { status: "failed", lastError: "first pack failure" },
    });
    expect(store.retrySessionArchive(first.archive.id)).toMatchObject({ status: "pending" });

    const repeated = store.reportSessionArchiveFailure(
      { ...input, error: "second pack failure" },
      `sar_failure_replacement_${wsCounter}`,
      `failures/sar_failure_replacement_${wsCounter}/sessions.tar.gz`,
    );
    expect(repeated).toMatchObject({
      created: false,
      archive: {
        id: first.archive.id,
        status: "failed",
        lastError: "second pack failure",
      },
    });
    expect(store.listSessionArchives(issue.id)).toHaveLength(1);

    const actualInput = {
      workspaceId: ws,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "sessions-v1",
      sha256: createHash("sha256").update("").digest("hex"),
      sizeBytes: 0,
    };
    const actual = store.initSessionArchive(
      actualInput,
      `sar_actual_${wsCounter}`,
      `archives/sar_actual_${wsCounter}/sessions.tar.gz`,
    );
    expect(actual.created).toBe(true);
    expect(store.getSessionArchive(first.archive.id)).toBeNull();

    const newFailure = store.reportSessionArchiveFailure(
      { ...input, error: "third pack failure" },
      `sar_failure_third_${wsCounter}`,
      `failures/sar_failure_third_${wsCounter}/sessions.tar.gz`,
    );
    expect(newFailure.created).toBe(true);
    expect(store.listSessionArchives(issue.id)).toHaveLength(2);
    expect(store.initSessionArchive(
      actualInput,
      `sar_actual_duplicate_${wsCounter}`,
      `archives/sar_actual_duplicate_${wsCounter}/sessions.tar.gz`,
    )).toMatchObject({ created: false, archive: { id: actual.archive.id } });
    expect(store.getSessionArchive(newFailure.archive.id)).toBeNull();
    expect(store.listSessionArchives(issue.id)).toHaveLength(1);
  });

  it("drives the runtime directory scan queue (create → claim → report)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-dirscan", provider: "claude", workspaceId: ws });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "~/code", maxDepth: 2 });
    expect(request.status).toBe("pending");
    expect(request.params).toEqual({ root: "~/code", maxDepth: 2 });

    const claimed = store.claimRuntimeDirectoryScanRequest(runtime.id);
    expect(claimed?.id).toBe(request.id);
    expect(claimed?.status).toBe("running");
    expect(store.claimRuntimeDirectoryScanRequest(runtime.id)).toBeNull();

    const reported = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, {
      status: "completed",
      candidates: [{ path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null }],
    });
    expect(reported.status).toBe("completed");
    expect(reported.candidates).toEqual([
      { path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null },
    ]);
  });

  // MUL-389: the merged heartbeat probe and the rewritten claim/expire statements only ever ran on
  // SQLite before this test. Postgres is stricter in two ways that matter here: `UNION ALL`
  // requires every branch to agree on a column type (the `housekeeping` column used to be integer
  // `0` in six branches and boolean `EXISTS` in the command branch), and `UPDATE ... RETURNING`
  // plus `IN (SELECT ... LIMIT n)` have to be accepted by the real planner.
  it("runs the merged heartbeat probe and the rewritten request-queue statements on Postgres", async () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-pg-probe", provider: "claude", workspaceId: ws, daemonId: `pg_probe_${wsCounter}` });
    const capabilities = { supportsBatchImport: true, supportsDirectoryScan: true, supportsSkillDirectory: true, supportsBotMenu: true };

    // Idle: one probe row per family, nothing to claim.
    const idle = (await receiveRuntimeInputs(store, runtime.id));
    expect(idle.status).toBe("ok");
    expect(idle.pending_update).toBeUndefined();

    // One row in every family, and ten in the batch family. The batch claim is the
    // `IN (SELECT ... LIMIT ?)` form, the rest are the single-row `WHERE id = (...)` form.
    const update = store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9" });
    const modelList = store.createRuntimeModelListRequest(runtime.id);
    const command = store.createRuntimeCommandRequest(runtime.id, { command: "printf pg", args: ["a"] });
    store.createRuntimeLocalSkillListRequest(runtime.id, {});
    const batch = Array.from({ length: 10 }, (_v, index) =>
      store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: `pg-${index}` }));
    const scan = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "/tmp", maxDepth: 2 });

    const claimed = (await receiveRuntimeInputs(store, runtime.id));
    expect(claimed.status).toBe("ok");
    expect(claimed.pending_update).toMatchObject({ id: update.id, target_version: "9.9.9" });
    expect(claimed.pending_model_list).toMatchObject({ id: modelList.id });
    expect(claimed.pending_command).toMatchObject({ id: command.id, command: "printf pg" });
    expect(claimed.pending_directory_scan).toMatchObject({ id: scan.id, root: "/tmp", max_depth: 2 });
    const claimedBatch = claimed.pending_local_skill_imports ?? [];
    expect(claimedBatch).toHaveLength(10);
    // Oldest first, and exactly the ten rows that were queued.
    expect(claimedBatch.map((entry) => entry.skill_key)).toEqual(batch.map((entry) => entry.skillKey));

    // The single-statement expire has to write each row's OWN timeout copy on PG too.
    const toRun = store.createRuntimeCommandRequest(runtime.id, { command: "slow", args: [] });
    expect(store.claimRuntimeCommandRequest(runtime.id)?.id).toBe(toRun.id);
    const toStayPending = store.createRuntimeCommandRequest(runtime.id, { command: "wait", args: [] });
    const staleRun = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stalePending = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.run("UPDATE multiremi_runtime_command_requests SET run_started_at = ? WHERE id = ?", [staleRun, toRun.id]);
    db.run("UPDATE multiremi_runtime_command_requests SET created_at = ? WHERE id = ?", [stalePending, toStayPending.id]);
    store.getRuntimeCommandRequest(runtime.id, toStayPending.id);
    expect(db.query("SELECT status, error FROM multiremi_runtime_command_requests WHERE id = ?").get(toRun.id))
      .toMatchObject({ status: "timeout", error: "daemon did not finish the command within 20 minutes" });
    expect(db.query("SELECT status, error FROM multiremi_runtime_command_requests WHERE id = ?").get(toStayPending.id))
      .toMatchObject({ status: "timeout", error: "daemon did not respond within 3 minutes" });
  });

  it("resolves project_ref expansion and rejects duplicate refs via the UNIQUE index", () => {
    const ws = freshWorkspace();
    store.updateWorkspaceRepositories(ws, [
      { id: `repo_pg_ref_lib_${wsCounter}`, name: "lib", url: "https://github.com/acme/lib", source: "github" },
      { id: `repo_pg_ref_main_${wsCounter}`, name: "main", url: "https://github.com/acme/main", source: "github" },
    ]);
    const lib = store.createProject({ title: "Lib", workspaceId: ws, resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/lib" } }] });
    const main = store.createProject({
      title: "Main",
      workspaceId: ws,
      resources: [
        { resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/main" } },
        { resourceType: "project_ref", resourceRef: { project_id: lib.id } },
      ],
    });

    const agent = store.createAgent({ name: "dirscan-agent", provider: "claude", workspaceId: ws });
    const issue = store.createIssue({ title: "Ref work", workspaceId: ws, projectId: main.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work", workspaceId: ws });
    expect(store.getTaskWithAgent(task.id)!.repos.map((repo) => repo.url)).toEqual([
      "https://github.com/acme/main",
      "https://github.com/acme/lib",
    ]);

    // Re-attaching the same reference collides on UNIQUE(project_id, resource_type, resource_ref).
    expect(() => store.createProjectResource(main.id, { resourceType: "project_ref", resourceRef: { projectId: lib.id } }))
      .toThrow("duplicate key value violates unique constraint");
  });

  // Regression: agentCommentedSince used `(? IS NULL OR created_at >= ?)`,
  // which Postgres rejects ("could not determine data type of parameter") —
  // the throw escaped postAgentReplyComment's try, so completing an issue task
  // never posted the agent's reply comment in production.
  it("posts the agent's final reply as an issue comment on completion (PG)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-reply-pg", provider: "claude", workspaceId: ws });
    const agent = store.createAgent({ name: "Reply PG", provider: "claude", workspaceId: ws, runtimeId: runtime.id });
    const issue = store.createIssue({ title: "统计后端文件", workspaceId: ws });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "统计后端文件", workspaceId: ws });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "后端共 119 个文件。" });

    const comments = store.listIssueComments(issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "agent", authorId: agent.id, body: "后端共 119 个文件。" });

    // Self-replied run: completion must not double-post.
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "再来一次", workspaceId: ws });
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
    store.startTask(second.id);
    store.createIssueComment(issue.id, { taskId: second.id, authorType: "agent", authorId: agent.id, body: "自己发的回复" });
    const before = store.listIssueComments(issue.id).length;
    store.completeTask(second.id, { output: "narration text" });
    expect(store.listIssueComments(issue.id)).toHaveLength(before);
  });

  it("dispatches trigger_issue system events atomically on Postgres", () => {
    // Earlier tests share this queue; drain their events before testing one atomic dispatch.
    const drainAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const pendingEvents = db.query(
      "SELECT 1 FROM multiremi_system_events WHERE status IN ('pending', 'processing') LIMIT 1",
    );
    for (let round = 0; round < 100 && pendingEvents.get(); round++) {
      store.dispatchPendingSystemEvents(drainAt);
    }
    if (pendingEvents.get()) throw new Error("System event queue did not drain within 100 rounds");

    const ws = freshWorkspace();
    const agent = store.createAgent({ name: "Wiki PG", provider: "codex", workspaceId: ws });
    const issue = store.createIssue({ title: "Wiki PG evidence", workspaceId: ws, status: "in_review" });
    const autopilot = store.createAutopilot({
      title: "Wiki PG maintainer",
      workspaceId: ws,
      assigneeId: agent.id,
      executionMode: "trigger_issue",
      sessionPolicy: "new",
    });
    store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
      },
    });

    store.updateIssue(issue.id, { status: "done" });
    const [run] = store.dispatchPendingSystemEvents();
    expect(run).toMatchObject({ issueId: issue.id, source: "system_event", status: "running" });
    expect(run.issueSessionId).toBeString();
    expect(store.getTask(run.taskId!)?.issueSessionId).toBe(run.issueSessionId);
  });

  it("archives eligible terminal issues and counts archived lists on Postgres", () => {
    const ws = freshWorkspace();
    store.updateWorkspace(ws, {
      settings: {
        issue_archive: {
          ttl_ms: 60 * 60 * 1000,
          sweep_interval_ms: 60 * 1000,
        },
      },
    });
    const archived = store.createIssue({ title: "Archive PG", workspaceId: ws, status: "done" });
    const active = store.createIssue({ title: "Active PG", workspaceId: ws });
    db.run(
      "UPDATE multiremi_issues SET completed_at = ? WHERE id = ?",
      ["2026-08-22T06:00:00.000Z", archived.id],
    );

    expect(store.archiveEligibleIssues(new Date("2026-08-22T08:00:00.000Z")))
      .toContainEqual(expect.objectContaining({ id: archived.id }));
    expect(store.listIssues({ workspaceId: ws }).map((issue) => issue.id)).toEqual([active.id]);
    expect(store.countIssues({ workspaceId: ws, archivedOnly: true })).toBe(1);

    expect(store.restoreIssue(archived.id)).toMatchObject({
      status: "done",
      completedAt: null,
      archivedAt: null,
    });
    runMigrations(db);
    expect(store.getIssue(archived.id)).toMatchObject({ completedAt: null, archivedAt: null });
    expect(store.archiveEligibleIssues(new Date("2026-08-22T08:00:00.000Z")).map((issue) => issue.id))
      .not.toContain(archived.id);
  });

  it("keeps a user terminal Issue committed while a worker status write waits on its row lock (PG)", async () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "terminal-race-runtime", provider: "codex", workspaceId: ws });
    const agent = store.createAgent({ name: "Terminal Race", provider: "codex", workspaceId: ws });
    const issue = store.createIssue({ title: "Do not reopen", workspaceId: ws, status: "backlog" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Start after acceptance" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    db.run("DELETE FROM multiremi_system_events WHERE resource_id = ?", [issue.id]);

    const worker = new Worker(
      new URL("./fixtures/postgres-terminal-issue-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    worker.postMessage({
      databaseUrl: pgDatabaseUrl(TEST_DB),
      issueId: issue.id,
      eventId: `sev_pg_terminal_${wsCounter}`,
      holdMs: 200,
    });

    await locked;
    // This call reaches the Issue row while the user transaction still owns
    // it. The store's own bridge runs in another worker, so the test process can
    // genuinely exercise the two-connection lock ordering.
    expect(store.startTask(task.id).status).toBe("running");
    await committed;
    worker.terminate();

    expect(store.getIssue(issue.id)?.status).toBe("done");
    const outbox = db.query(
      "SELECT payload FROM multiremi_system_events WHERE resource_id = ? ORDER BY created_at ASC",
    ).all(issue.id) as Array<{ payload: string }>;
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({
      previous_status: "todo",
      status: "done",
    });
  });

  it("orders terminal writes after Session projection locks without deadlocking (PG)", async () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "projection-race-runtime", provider: "codex", workspaceId: ws });
    const agent = store.createAgent({ name: "Projection Race", provider: "codex", workspaceId: ws });
    const issue = store.createIssue({ title: "Projection race", workspaceId: ws });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Freeze this prompt" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(task.issueSessionId).toBeString();

    const worker = new Worker(
      new URL("./fixtures/postgres-session-projection-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    worker.postMessage({
      databaseUrl: pgDatabaseUrl(TEST_DB),
      sessionId: task.issueSessionId!,
      taskId: task.id,
      holdMs: 150,
    });

    await locked;
    // The fixed terminal path waits on Session before touching Task. The old
    // Task -> Session order deadlocked here when the projection worker woke
    // and tried to write the same Task while still owning Session.
    expect(store.completeTask(task.id, { output: "Completed after projection." }).status).toBe("completed");
    await committed;
    worker.terminate();

    expect(store.getTask(task.id)).toMatchObject({
      status: "completed",
      projectionToSeq: 1,
      projectionMode: "bootstrap",
    });
  });

  it("does not cancel a terminal return detached while comment editing waits on the workspace lock (PG)", async () => {
    const fixture = createDelegationFixture();
    const worker = new Worker(
      new URL("./fixtures/postgres-comment-edit-worker.ts", import.meta.url).href,
    );
    const ready = waitForWorkerPhase(worker, "ready");
    worker.postMessage({ type: "init", databaseUrl: pgDatabaseUrl(TEST_DB) });
    await ready;

    const blocker = new Bun.SQL(pgDatabaseUrl(TEST_DB), { max: 1 });
    const observer = new Bun.SQL(pgDatabaseUrl(TEST_DB), { max: 1 });
    await blocker`BEGIN`;
    await blocker`
      UPDATE multiremi_workspaces
      SET updated_at = updated_at
      WHERE id = ${fixture.workspaceId}
    `;

    const completed = waitForWorkerPhase(worker, "completed");
    worker.postMessage({
      type: "edit",
      commentId: fixture.report.id,
      body: "Intermediate PG report without a mention.",
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [comment] = await observer`
        SELECT body FROM multiremi_issue_comments WHERE id = ${fixture.report.id}
      `;
      if (comment?.body === "Intermediate PG report without a mention.") break;
      await Bun.sleep(10);
    }
    const [edited] = await observer`
      SELECT body FROM multiremi_issue_comments WHERE id = ${fixture.report.id}
    `;
    expect(edited?.body).toBe("Intermediate PG report without a mention.");

    await blocker`
      UPDATE multiremi_tasks
      SET prompt = ${"Terminal PG report."}, trigger_comment_id = NULL, trigger_summary = NULL
      WHERE id = ${fixture.explicitReturn.id}
    `;
    await blocker`COMMIT`;
    await completed;
    worker.terminate();
    await blocker.end();
    await observer.end();

    expect(store.getTask(fixture.explicitReturn.id)).toMatchObject({
      status: "queued",
      triggerCommentId: null,
      prompt: "Terminal PG report.",
    });
  });

  const createRunningSteerTask = () => {
    const workspaceId = freshWorkspace();
    const runtime = store.registerRuntime({ name: `steer-race-runtime-${wsCounter}`, provider: "claude", workspaceId });
    const agent = store.createAgent({ name: `Steer Race ${wsCounter}`, provider: "claude", workspaceId });
    const task = store.createTask({ agentId: agent.id, prompt: "steer race" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    return { workspaceId, task };
  };

  it("steer insert committed by a second connection blocks completion (PG steer barrier)", async () => {
    const { workspaceId, task } = createRunningSteerTask();
    const worker = new Worker(
      new URL("./fixtures/postgres-steer-race-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    const steerId = `steer_pg_race_${wsCounter}`;
    worker.postMessage({
      databaseUrl: pgDatabaseUrl(TEST_DB),
      mode: "steer",
      workspaceId,
      taskId: task.id,
      steerId,
      holdMs: 200,
    });

    await locked;
    // completeTask contends on the same workspace lifecycle lock; once the
    // steer transaction commits, its post-lock re-read must see the pending
    // steer and refuse.
    expect(() => store.completeTask(task.id, { output: "old answer" })).toThrow(TaskSteerPendingError);
    await committed;
    worker.terminate();

    expect(store.getTaskStatus(task.id)).toBe("running");
    expect(store.listPendingTaskSteerMessages(task.id).map((m) => m.id)).toEqual([steerId]);

    // Consuming lifts the barrier.
    store.consumeTaskSteerMessages(task.id, [steerId]);
    expect(store.completeTask(task.id, { output: "steered answer" }).status).toBe("completed");
  });

  it("completion committed by a second connection makes steer insert conflict (PG)", async () => {
    const { workspaceId, task } = createRunningSteerTask();
    const worker = new Worker(
      new URL("./fixtures/postgres-steer-race-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    worker.postMessage({
      databaseUrl: pgDatabaseUrl(TEST_DB),
      mode: "complete",
      workspaceId,
      taskId: task.id,
      steerId: `steer_pg_unused_${wsCounter}`,
      holdMs: 200,
    });

    await locked;
    expect(() => store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "too late" }))
      .toThrow(TaskSteerConflictError);
    await committed;
    worker.terminate();

    expect(store.getTaskStatus(task.id)).toBe("completed");
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
  });

  /**
   * MUL-409 fix round, blocking 2: issue creation is one transaction on this
   * bridge. Postgres has no savepoint here, so a nested `BEGIN` would commit the
   * issue row early and let it survive the rollback — exactly the orphan the QA
   * pass found. The depth counter is asserted alongside the data, so a future
   * refactor that reintroduces nesting fails here rather than in production.
   */
  it("rolls a rejected blocked_by creation back and stays a single transaction (PG)", () => {
    const parent = store.createIssue({ title: "PG rollback parent", status: "in_progress" });
    const issuesBefore = store.listIssues({ workspaceId: "local" }).length;
    const childrenBefore = store.listChildIssues(parent.id).length;
    const dependenciesBefore = (db.query("SELECT COUNT(*) AS n FROM multiremi_issue_dependencies").get() as { n: number }).n;
    // The next number is the workspace maximum, not the row count: earlier tests
    // in this file archive rows, and `listIssues` hides those.
    const nextNumberBefore = Number((db.query(
      "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multiremi_issues WHERE workspace_id = ?",
    ).get("local") as { next: number }).next);

    db.resetTransactionDepthStats();
    let failure: Error & { code?: string } | null = null;
    try {
      store.createIssue({
        title: "PG rejected child",
        status: "todo",
        parentIssueId: parent.id,
        blockedBy: [parent.id],
      });
    } catch (err) {
      failure = err as Error & { code?: string };
    }

    expect(failure?.code).toBe("dependency_on_ancestor");
    expect(db.maxTransactionDepth).toBe(1);
    expect(store.listIssues({ workspaceId: "local" }).length).toBe(issuesBefore);
    expect(store.listChildIssues(parent.id).length).toBe(childrenBefore);
    expect((db.query("SELECT COUNT(*) AS n FROM multiremi_issue_dependencies").get() as { n: number }).n)
      .toBe(dependenciesBefore);
    // The consumed number is rolled back with everything else.
    expect(store.createIssue({ title: "PG after the rejection" }).key)
      .toBe(`MUL-${nextNumberBefore}`);
  });

  /**
   * MUL-409 fix round 2, blocking 4: the automatic-start chain must not nest a
   * transaction on this bridge. `transaction()` is a bare BEGIN/COMMIT with no
   * savepoint, so a nested BEGIN lets the inner COMMIT end the outer unit and a
   * later ROLLBACK cannot undo it. S1 moved the E1/E2 hook post-commit; these
   * three scenarios pin that the S2 dependency logic (auto-start on `done`, the
   * two-prerequisite case, and the member forced start) now runs at depth 1.
   */
  it("keeps the automatic-start chain at one transaction (PG)", () => {
    const runtime = store.registerRuntime({ id: "rt_dep_depth", name: "Depth worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Depth owner", provider: "claude", runtimeId: runtime.id });

    // (a) prerequisite done -> dependent auto-starts
    const prereq = store.createIssue({ title: "Depth prerequisite", status: "in_progress", assigneeType: "agent", assigneeId: owner.id });
    const dependent = store.createIssue({
      title: "Depth dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    const prereqTask = store.createTask({ agentId: owner.id, issueId: prereq.id, prompt: "finish the prerequisite" });
    let claimed = store.claimTask(runtime.id);
    while (claimed && claimed.id !== prereqTask.id) claimed = store.claimTask(runtime.id);
    store.startTask(prereqTask.id);
    store.completeTask(prereqTask.id, { output: "prerequisite finished" });

    db.resetTransactionDepthStats();
    store.updateIssue(prereq.id, { status: "done" });
    expect(db.maxTransactionDepth).toBe(1);
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);

    // (b) two prerequisites finishing: one dispatch, still depth 1
    const first = store.createIssue({ title: "Depth first", status: "in_progress" });
    const second = store.createIssue({ title: "Depth second", status: "in_progress" });
    const bothWaiting = store.createIssue({
      title: "Depth both",
      status: "backlog",
      blockedBy: [first.id, second.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    db.resetTransactionDepthStats();
    store.updateIssue(first.id, { status: "done" });
    store.updateIssue(second.id, { status: "done" });
    expect(db.maxTransactionDepth).toBe(1);
    expect(store.getIssue(bothWaiting.id)?.status).toBe("todo");
    expect(store.listTasksForIssue(bothWaiting.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);

    // (c) member forced start: the override dispatches after its own commit
    const forcedPrereq = store.createIssue({ title: "Depth forced prerequisite", status: "in_progress" });
    const forced = store.createIssue({
      title: "Depth forced",
      status: "backlog",
      blockedBy: [forcedPrereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    db.resetTransactionDepthStats();
    store.updateIssue(forced.id, { status: "todo", force: true, actorType: "member", actorId: "local" });
    expect(db.maxTransactionDepth).toBe(1);
    expect(store.getIssue(forced.id)?.status).toBe("todo");
    expect(store.listTasksForIssue(forced.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
  });

  /**
   * MUL-409 fix round 2, blocking 4, failure half: when the dispatch itself
   * fails the prerequisite's `done` must not roll back, and the dependent must
   * stay in a state a human can retry from. An unavailable owner is a business
   * skip, recorded under the same locks as the start decision.
   */
  it("keeps the prerequisite done and the dependent retryable when auto-start dispatch fails (PG)", () => {
    const runtime = store.registerRuntime({ id: "rt_dep_fail", name: "Depth worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Doomed owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    // The dependent's owner is unavailable when the hook makes its decision.
    db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), owner.id]);

    db.resetTransactionDepthStats();
    store.updateIssue(prereq.id, { status: "done" });

    expect(db.maxTransactionDepth).toBe(1);
    expect(store.getIssue(prereq.id)?.status).toBe("done");
    // Still waiting, so the automatic path can pick it up again once a human
    // fixes the owner: backlog + unmet prerequisite is the retryable state.
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    const skipped = store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped");
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0]?.body ?? "")).toContain("No runnable agent");
    // An unavailable owner is decided under the lock before the claim, so the
    // dependent stays in backlog and the business skip is the durable trace.
    expect(skipped[0]?.data).toMatchObject({ reason: "dispatch_failed" });
    expect(skipped[0]?.data ?? {}).not.toHaveProperty("claimReleased");
    // And the retry really works once the owner is fixed.
    db.run("UPDATE multiremi_agents SET archived_at = NULL WHERE id = ?", [owner.id]);
    const restored = store.createAgent({ name: "Replacement owner", provider: "claude", runtimeId: runtime.id });
    const assigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: restored.id });
    expect(assigned.task?.id).toBeDefined();
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
  });

  /**
   * MUL-409 fix round 3 (QA round-2 blockers) on Postgres: the gate refuses a
   * forged structural exemption, a member override queues exactly one row, a
   * rejected `blocked_by` keeps its HTTP contract, and batch is not a second
   * override.
   */
  it("holds the dependency gate against forged exemptions and batch force (PG)", async () => {
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ id: "rt_gate_pg", name: "Gate worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Gate owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Gate prerequisite", status: "in_progress" });
    const waiting = store.createIssue({
      title: "Gate waiting",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    const taskRows = () => db.query("SELECT id, status FROM multiremi_tasks WHERE issue_id = ?").all(waiting.id) as Array<{ id: string; status: string }>;
    const forceActivities = () => db.query(
      "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_force_started'",
    ).all(waiting.id) as Array<{ id: string }>;
    const post = (path: string, body: unknown) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    // (a) forged exemptions are ignored on the public task route
    for (const extra of [{ attempt: 2 }, { preserve_issue_status: true }]) {
      const response = await post("/api/multiremi/tasks", {
        agentId: owner.id,
        issueId: waiting.id,
        prompt: "forged",
        ...extra,
      });
      expect(response.status).toBe(409);
      expect((await response.json() as { code?: string }).code).toBe("dependencies_unmet");
    }
    expect(taskRows()).toHaveLength(0);
    expect(store.getIssue(waiting.id)?.status).toBe("backlog");

    // (b) batch force is ignored by the dependency gate
    const batched = await post("/api/issues/batch-update", {
      issue_ids: [waiting.id],
      updates: { status: "todo", force: true },
    });
    expect(batched.status).toBe(200);
    expect(store.getIssue(waiting.id)?.status).toBe("backlog");
    expect(taskRows()).toHaveLength(0);
    expect(forceActivities()).toHaveLength(0);

    // (c) the member PATCH override queues exactly one row
    const forced = await app.request(`/api/issues/${waiting.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo", force: true }),
    });
    expect(forced.status).toBe(200);
    expect(store.getIssue(waiting.id)?.status).toBe("todo");
    expect(taskRows().map((row) => row.status)).toEqual(["queued"]);
    expect(forceActivities()).toHaveLength(1);

    // (d) a rejected blocked_by keeps its HTTP contract and rolls back
    const parent = store.createIssue({ title: "PG parent" });
    const issuesBefore = (db.query("SELECT COUNT(*) AS n FROM multiremi_issues").get() as { n: number }).n;
    for (const [blockedBy, expected] of [
      [[parent.id], 409],
      [["iss_missing_pg"], 400],
    ] as const) {
      const response = await post("/api/issues", { title: "PG rejected", parent_issue_id: parent.id, blocked_by: blockedBy });
      expect(response.status).toBe(expected);
      expect((db.query("SELECT COUNT(*) AS n FROM multiremi_issues").get() as { n: number }).n).toBe(issuesBefore);
      expect(store.listChildIssues(parent.id)).toHaveLength(0);
    }
  });

  /**
   * MUL-409 fix round 3, blocker 3 on Postgres. Two prerequisites reaching
   * `done` concurrently on independent connections used to leave two queued
   * rounds and two `dependency_auto_started` rows, because both readers saw the
   * dependent as `backlog`. The atomic claim fixes it; this test spawns two
   * workers so the race is real, and repeats to catch flakiness. Sequential
   * calls cannot prove this property.
   */
  it("lets only one of two concurrent prerequisites auto-start the dependent (PG)", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const runtime = store.registerRuntime({ id: "rt_conc_pg", name: "Conc worker", provider: "claude", maxConcurrency: 8 });
    const owner = store.createAgent({ name: "Conc owner", provider: "claude", runtimeId: runtime.id });
    const workerUrl = new URL("./fixtures/postgres-complete-issue-worker.ts", import.meta.url).href;
    const waitFor = (worker: Worker, phase: string) => new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<{ phase?: string; error?: string }>) => {
        if (event.data.phase === "error") { cleanup(); reject(new Error(event.data.error ?? "worker failed")); }
        else if (event.data.phase === phase) { cleanup(); resolve(); }
      };
      const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message)); };
      const cleanup = () => { worker.removeEventListener("message", onMessage as never); worker.removeEventListener("error", onError as never); };
      worker.addEventListener("message", onMessage as never);
      worker.addEventListener("error", onError as never);
    });

    const ROUNDS = Number(process.env.MUL409_CONCURRENCY_ROUNDS ?? 12);
    let doubleDispatched = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const first = store.createIssue({ title: `Conc first ${round}`, status: "in_progress" });
      const second = store.createIssue({ title: `Conc second ${round}`, status: "in_progress" });
      const dependent = store.createIssue({
        title: `Conc dependent ${round}`,
        status: "backlog",
        blockedBy: [first.id, second.id],
        assigneeType: "agent",
        assigneeId: owner.id,
      });
      // The workers need the live database URL; the store holds the bridge.
      const databaseUrl = pgDatabaseUrl(TEST_DB);
      const barrierDir = mkdtempSync(join(tmpdir(), "mul409-conc-"));
      const barrier = join(barrierDir, "go");
      const workers = [first, second].map((issue) => {
        const worker = new Worker(workerUrl, { type: "module" });
        worker.postMessage({ type: "init", databaseUrl, issueId: issue.id, barrierPath: barrier });
        return worker;
      });
      await Promise.all(workers.map((worker) => waitFor(worker, "ready")));
      writeFileSync(barrier, "go");
      await Promise.all(workers.map((worker) => waitFor(worker, "done")));
      workers.forEach((worker) => worker.terminate());
      rmSync(barrierDir, { recursive: true, force: true });

      const rows = db.query("SELECT id, status FROM multiremi_tasks WHERE issue_id = ?").all(dependent.id) as Array<{ status: string }>;
      const autoStarted = db.query(
        "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_auto_started'",
      ).all(dependent.id) as Array<{ id: string }>;
      if (rows.length !== 1 || autoStarted.length !== 1) doubleDispatched++;
    }
    expect(doubleDispatched).toBe(0);
  }, 120_000);

  /**
   * MUL-409 fix round 3, blocker 3 (second half): a member's forced start and the
   * automatic start that the last prerequisite triggers must not both queue a
   * round either. Both paths arbitrate on the same conditional
   * `backlog -> todo` claim, so exactly one wins.
   */
  it("lets only one of a forced start and an automatic start dispatch (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_force_race", name: "Race worker", provider: "claude", maxConcurrency: 8 });
    const owner = store.createAgent({ name: "Race owner", provider: "claude", runtimeId: runtime.id });
    const ROUNDS = Number(process.env.MUL409_FORCE_RACE_ROUNDS ?? 8);
    let doubleDispatched = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const prereq = store.createIssue({ title: `Race prereq ${round}`, status: "in_progress" });
      const dependent = store.createIssue({
        title: `Race dependent ${round}`,
        status: "backlog",
        blockedBy: [prereq.id],
        assigneeType: "agent",
        assigneeId: owner.id,
      });
      // Kick off both contenders in the same tick. They run on one connection
      // here, so this exercises the claim ordering rather than true network
      // concurrency; the two-process test above covers the cross-connection
      // race.
      const forced = Promise.resolve().then(() => {
        try {
          store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "local" });
        } catch { /* the losing contender may legitimately refuse */ }
      });
      const automatic = Promise.resolve().then(() => {
        try {
          store.updateIssue(prereq.id, { status: "done" });
        } catch { /* the losing contender may legitimately refuse */ }
      });
      await Promise.all([forced, automatic]);

      const rows = db.query("SELECT id, status FROM multiremi_tasks WHERE issue_id = ?").all(dependent.id) as Array<{ status: string }>;
      const started = db.query(
        "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type IN ('dependency_force_started', 'dependency_auto_started')",
      ).all(dependent.id) as Array<{ id: string }>;
      if (rows.length !== 1 || started.length !== 1) doubleDispatched++;
    }
    expect(doubleDispatched).toBe(0);
  }, 60_000);

  it("creates a fresh terminal return when comment editing cancels the explicit return first (PG)", () => {
    const fixture = createDelegationFixture();
    store.updateIssueComment(fixture.report.id, { body: "Intermediate report withdrawn." });
    expect(store.getTask(fixture.explicitReturn.id)?.status).toBe("cancelled");

    store.completeTask(fixture.childTask.id, {
      output: "Final PG QA result after the explicit report was withdrawn.",
    });

    const leaderReturns = store.listTasksForIssue(fixture.issue.id).filter((task) => (
      task.agentId === fixture.leader.id && task.delegationId === fixture.childTask.delegationId
    ));
    expect(leaderReturns).toHaveLength(2);
    const terminalReturn = leaderReturns.find((task) => task.id !== fixture.explicitReturn.id)!;
    expect(terminalReturn.status).toBe("queued");
    expect(terminalReturn.prompt).toContain("Final PG QA result after the explicit report was withdrawn.");
  });

  /**
   * MUL-409 fix round 4 (QA round 3, blocker 3) on Postgres: the native PATCH
   * route must answer the dependency hold with 409 + `dependencies_unmet`
   * instead of letting `IssueDependencyError` become a bare 500.
   */
  it("answers 409 dependencies_unmet from both PATCH routes on a waiting issue (PG)", async () => {
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ id: "rt_patch_pg", name: "Patch worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Patch owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Patch prerequisite", status: "in_progress" });
    const waiting = store.createIssue({
      title: "Patch waiting",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    // QA's four spellings, on both routes.
    const forms: Array<Record<string, unknown>> = [
      { status: "todo" },
      { status: "todo", parentStatusForce: true },
      { status: "todo", parent_status_force: true },
      { status: "todo", options: { parentStatusForce: true } },
    ];
    for (const path of ["/api/multiremi/issues", "/api/issues"]) {
      for (const body of forms) {
        const response = await app.request(`${path}/${waiting.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json() as { code?: string; error?: string };
        expect({ path, body: JSON.stringify(body), status: response.status })
          .toEqual({ path, body: JSON.stringify(body), status: 409 });
        expect(payload.code).toBe("dependencies_unmet");
        expect(String(payload.error ?? "")).toContain(waiting.key);
      }
    }

    // Nothing half-written on any of the eight attempts.
    expect(store.getIssue(waiting.id)?.status).toBe("backlog");
    const taskRows = db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(waiting.id) as Array<{ status: string }>;
    expect(taskRows).toEqual([]);
    const forced = db.query(
      "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_force_started'",
    ).all(waiting.id) as Array<{ id: string }>;
    expect(forced).toEqual([]);
  });

  /**
   * MUL-409 fix round 4 (QA round 3, blockers 1+2) on Postgres.
   *
   * The automatic start is one transaction: the claim, the status write, the
   * round and both activities commit together or not at all. These cases assert
   * that on the real bridge, where a nested BEGIN would silently end the outer
   * transaction early.
   */
  it("rolls the whole automatic start back when a step fails (PG)", () => {
    drainSystemEvents();
    const runtime = store.registerRuntime({ id: "rt_atomic_pg", name: "Atomic worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Atomic owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Atomic prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Atomic dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    // QA's injection point: the activity write that happens AFTER the round was
    // inserted. Pre-fix this left `backlog` + a queued round.
    type Ctx = {
      appendIssueActivity(issueId: string, input: { type: string }, ...rest: unknown[]): void;
    };
    const ctx = (store as unknown as { ctx: Ctx }).ctx;
    const original = ctx.appendIssueActivity.bind(ctx);
    let fired = false;
    ctx.appendIssueActivity = (issueId: string, input: { type: string }, ...rest: unknown[]) => {
      if (!fired && input.type === "issue_assigned") {
        fired = true;
        throw new Error("injected activity failure");
      }
      original(issueId, input, ...rest);
    };

    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    db.resetTransactionDepthStats();
    try {
      store.updateIssue(prereq.id, { status: "done" });
    } finally {
      ctx.appendIssueActivity = original;
    }
    expect(warnings.mock.calls).toHaveLength(1);
    warnings.mockRestore();

    // Whole row sets, not counts of a filtered subset.
    const taskRows = db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id) as Array<{ status: string }>;
    expect(taskRows).toEqual([]);
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    // The prerequisite's `done` committed while the dependent's attempt rolled
    // back. The surviving backlog with no round is recovered by the check below.
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(0);
    const auto = db.query(
      "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_auto_started'",
    ).all(dependent.id) as Array<{ id: string }>;
    expect(auto).toEqual([]);
    const skipped = db.query(
      "SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_auto_start_skipped'",
    ).all(dependent.id) as Array<{ data: string }>;
    expect(skipped).toEqual([]);
    // The prerequisite's own transition is untouched, and the depth stayed 1.
    expect(store.getIssue(prereq.id)?.status).toBe("done");
    expect(db.maxTransactionDepth).toBe(1);

    const checkRow = db.query("SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'")
      .get(prereq.id) as { id: string };
    const check = store.getSystemEvent(checkRow.id)!;
    store.dispatchPendingSystemEvents(new Date(check.availableAt));
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_started"))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ replayed: true }) })]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
    expect(store.getSystemEvent(check.id)?.status).toBe("processed");
    expect(db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id)).toEqual([{ status: "queued" }]);
  });

  it("U8 ignores a stale backlog issue after its round was already queued (PG)", () => {
    const runtime = store.registerRuntime({ name: "Stale PG runtime", provider: "claude" });
    const owner = store.createAgent({ name: "Stale PG owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Stale PG prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Stale PG dependent", status: "backlog", blockedBy: [prereq.id],
      assigneeType: "agent", assigneeId: owner.id });
    store.updateIssue(prereq.id, { status: "done" });
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    const before = store.listTasksForIssue(dependent.id);
    expect(before).toHaveLength(1);
    const issues = (store as unknown as { issues: { autoStartDependent(...args: unknown[]): unknown } }).issues;
    const checkId = (db.query("SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'")
      .get(prereq.id) as { id: string }).id;
    issues.autoStartDependent(dependent, store.getIssue(prereq.id)!, null, { dependencyCheckEventId: checkId });
    expect(store.listTasksForIssue(dependent.id)).toEqual(before);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_started")).toHaveLength(1);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
  });

  describe("MUL-452 check event identity (PG)", () => {
    const base = Date.parse("2028-01-01T00:00:00.000Z");

    function drainIdentityEvents() {
      const pending = db.query("SELECT 1 FROM multiremi_system_events WHERE status IN ('pending', 'processing') LIMIT 1");
      const at = new Date(Math.max(Date.now(), base + 60_000) + 24 * 60 * 60 * 1_000);
      for (let round = 0; round < 100 && pending.get(); round++) store.dispatchPendingSystemEvents(at);
      if (pending.get()) throw new Error("Identity test event queue did not drain within 100 rounds");
    }

    function chain() {
      const runtime = store.registerRuntime({ name: `Check identity ${++wsCounter}`, provider: "claude" });
      const agent = store.createAgent({ name: `Check identity ${wsCounter}`, provider: "claude", runtimeId: runtime.id });
      const prerequisite = store.createIssue({ title: `Check prerequisite ${wsCounter}`, status: "in_progress" });
      const dependent = store.createIssue({ title: `Check dependent ${wsCounter}`, status: "backlog",
        blockedBy: [prerequisite.id], assigneeType: "agent", assigneeId: agent.id });
      return { agent, prerequisite, dependent };
    }

    function checks(issueId: string) {
      const rows = db.query("SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'")
        .all(issueId) as Array<{ id: string }>;
      return rows.map(({ id }) => store.getSystemEvent(id)!);
    }

    function activities(issueId: string, type: string) {
      return store.listIssueActivity(issueId).filter((entry) => entry.type === type);
    }

    function withoutHooks(fn: () => void) {
      const issues = (store as unknown as { issues: IssuesRepo }).issues;
      const hook = spyOn(issues, "runIssueUpdatePostCommit").mockImplementation(() => {});
      try { fn(); } finally { hook.mockRestore(); }
    }

    it("passes the task-terminal check id to the normal post-commit start (PG)", () => {
      drainIdentityEvents();
      const runtime = store.registerRuntime({ name: `Terminal check PG ${++wsCounter}`, provider: "claude" });
      const owner = store.createAgent({ name: `Terminal check PG ${wsCounter}`, provider: "claude", runtimeId: runtime.id });
      const prerequisite = store.createIssue({ title: `Terminal check prerequisite PG ${wsCounter}`, status: "todo", issueKind: "intake" });
      store.createIssue({ title: `Terminal generated PG ${wsCounter}`, sourceIssueId: prerequisite.id });
      const dependent = store.createIssue({ title: `Terminal check dependent PG ${wsCounter}`, status: "backlog",
        blockedBy: [prerequisite.id], assigneeType: "agent", assigneeId: owner.id });
      const task = store.createTask({ agentId: owner.id, issueId: prerequisite.id, prompt: "Finish intake" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      store.completeTask(task.id, { output: "Generated work" });

      const check = checks(prerequisite.id)[0]!;
      expect(store.getIssue(prerequisite.id)?.status).toBe("done");
      expect(store.getIssue(dependent.id)?.status).toBe("todo");
      expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
      expect(activities(dependent.id, "dependency_auto_started")[0]?.data)
        .toMatchObject({ dependency_check_event_id: check.id });
      expect(activities(dependent.id, "dependency_auto_started")[0]?.data)
        .not.toHaveProperty("replayed");
    });

    it.each([
      ["reopened later", "later"],
      ["U11 same millisecond", "same millisecond"],
      ["U12 slower process", "slower process"],
    ] as const)(
      "starts again after an old skip (%s, PG)", (_case, timing) => {
        drainIdentityEvents();
        const { agent, prerequisite, dependent } = chain();
        try {
          setSystemTime(new Date(base + (timing === "slower process" ? 60_000 : 0)));
          db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);
          store.updateIssue(prerequisite.id, { status: "done" });
          const oldCheck = checks(prerequisite.id)[0]!;
          expect(activities(dependent.id, "dependency_auto_start_skipped")).toHaveLength(1);
          expect(activities(dependent.id, "dependency_auto_start_skipped")[0]?.data)
            .toMatchObject({ dependency_check_event_id: oldCheck.id });

          setSystemTime(new Date(base + (timing === "same millisecond" ? 0 : 1_000)));
          store.updateIssue(prerequisite.id, { status: "in_progress" });
          db.run("UPDATE multiremi_agents SET archived_at = NULL WHERE id = ?", [agent.id]);
          setSystemTime(new Date(base + (timing === "same millisecond" ? 0 : 2_000)));
          store.updateIssue(prerequisite.id, { status: "done" });
          const nextCheck = checks(prerequisite.id).find((event) => event.id !== oldCheck.id)!;
          expect(nextCheck.id).not.toBe(oldCheck.id);
          if (timing === "same millisecond") expect(nextCheck.createdAt).toBe(oldCheck.createdAt);
          if (timing === "slower process") expect(Date.parse(nextCheck.createdAt)).toBeLessThan(Date.parse(oldCheck.createdAt));

          setSystemTime(new Date(base + 7_000));
          store.dispatchPendingSystemEvents();
          expect(store.getSystemEvent(nextCheck.id)?.status).toBe("processed");
          expect(store.getIssue(dependent.id)?.status).toBe("todo");
          expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
          expect(activities(dependent.id, "dependency_auto_start_skipped")).toHaveLength(1);
          expect(activities(dependent.id, "dependency_auto_started")[0]?.data)
            .toMatchObject({ dependency_check_event_id: nextCheck.id });
        } finally {
          setSystemTime();
        }
      },
    );

    it.each(["archived-agent", "missing-agent", "archived-squad", "missing-squad", "no-runnable-squad"] as const)(
      "treats an unavailable owner as a business skip (%s, PG)", (kind) => {
        drainIdentityEvents();
        const { agent, prerequisite, dependent } = chain();
        if (kind === "archived-agent") {
          db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);
        } else if (kind === "missing-agent") {
          db.run("UPDATE multiremi_issues SET assignee_id = 'missing-agent' WHERE id = ?", [dependent.id]);
        } else {
          const squad = store.createSquad({ name: `Unavailable PG ${kind}`, leaderId: agent.id });
          db.run("UPDATE multiremi_issues SET assignee_type = 'squad', assignee_id = ? WHERE id = ?", [squad.id, dependent.id]);
          if (kind === "archived-squad") db.run("UPDATE multiremi_squads SET archived_at = ? WHERE id = ?", [new Date().toISOString(), squad.id]);
          if (kind === "missing-squad") db.run("UPDATE multiremi_issues SET assignee_id = 'missing-squad' WHERE id = ?", [dependent.id]);
          if (kind === "no-runnable-squad") db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);
        }
        withoutHooks(() => store.updateIssue(prerequisite.id, { status: "done" }));
        const check = checks(prerequisite.id)[0]!;
        store.dispatchPendingSystemEvents(new Date(check.availableAt));
        expect(store.getSystemEvent(check.id)?.status).toBe("processed");
        expect(activities(dependent.id, "dependency_auto_start_skipped")).toHaveLength(1);
        expect(activities(dependent.id, "dependency_auto_start_skipped")[0]?.data)
          .toMatchObject({ reason: "dispatch_failed", dependency_check_event_id: check.id });
        expect(store.getIssue(dependent.id)?.status).toBe("backlog");
        expect(store.listTasksForIssue(dependent.id)).toEqual([]);
        (store as unknown as { issues: IssuesRepo }).issues.replayDependencyAutoStart(check);
        expect(activities(dependent.id, "dependency_auto_start_skipped")).toHaveLength(1);
      },
    );

    it("a partial replay retry does not redo an earlier task or skip (PG)", () => {
      drainIdentityEvents();
      const { agent, prerequisite, dependent } = chain();
      const unavailable = store.createAgent({ name: `Unavailable PG ${++wsCounter}`, provider: "claude", runtimeId: agent.runtimeId! });
      const skipped = store.createIssue({ title: `Skipped PG ${wsCounter}`, status: "backlog", blockedBy: [prerequisite.id],
        assigneeType: "agent", assigneeId: unavailable.id });
      db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), unavailable.id]);
      const failed = store.createIssue({ title: `Failed PG ${wsCounter}`, status: "backlog", blockedBy: [prerequisite.id],
        assigneeType: "agent", assigneeId: agent.id });
      withoutHooks(() => store.updateIssue(prerequisite.id, { status: "done" }));
      const check = checks(prerequisite.id)[0]!;
      const issues = (store as unknown as { issues: IssuesRepo }).issues;
      const list = spyOn(issues as unknown as { listDependencyDependents(id: string): unknown[] }, "listDependencyDependents")
        .mockImplementation(() => [dependent, skipped, failed].map((issue) => store.getIssue(issue.id)!));
      const run = db.run.bind(db);
      let injected = false;
      const failure = spyOn(db, "run").mockImplementation((sql, ...args) => {
        if (!injected && sql.includes("SET status = 'todo'") && (args[0] as unknown[] | undefined)?.[1] === failed.id) {
          injected = true;
          throw new Error("third PG dependent failed");
        }
        return run(sql, ...args);
      });
      try {
        store.dispatchPendingSystemEvents(new Date(check.availableAt));
        expect(injected).toBe(true);
        expect(store.getSystemEvent(check.id)).toMatchObject({ status: "pending", attemptCount: 1 });
        expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
        expect(activities(skipped.id, "dependency_auto_start_skipped")).toHaveLength(1);
        expect(store.listTasksForIssue(failed.id)).toEqual([]);
        failure.mockRestore();
        store.dispatchPendingSystemEvents(new Date(Date.parse(check.availableAt) + 2_000));
        expect(store.getSystemEvent(check.id)).toMatchObject({ status: "processed", attemptCount: 2 });
        expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
        expect(activities(skipped.id, "dependency_auto_start_skipped")).toHaveLength(1);
        expect(store.listTasksForIssue(failed.id)).toHaveLength(1);
      } finally {
        failure.mockRestore();
        list.mockRestore();
      }
    });
  });

  it("U9 retries a transaction write failure without a business skip (PG 40001)", () => {
    drainSystemEvents();
    const runtime = store.registerRuntime({ name: "Replay write PG", provider: "claude" });
    const owner = store.createAgent({ name: "Replay write PG", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Replay write PG prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Replay write PG dependent", status: "backlog", blockedBy: [prereq.id],
      assigneeType: "agent", assigneeId: owner.id });
    const issues = (store as unknown as { issues: { runIssueUpdatePostCommit(...args: unknown[]): void } }).issues;
    const hook = spyOn(issues, "runIssueUpdatePostCommit").mockImplementation(() => {});
    try { store.updateIssue(prereq.id, { status: "done" }); } finally { hook.mockRestore(); }
    const row = db.query("SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'")
      .get(prereq.id) as { id: string };
    const check = store.getSystemEvent(row.id)!;
    const run = db.run.bind(db);
    let injected = false;
    const failure = spyOn(db, "run").mockImplementation((sql, ...args) => {
      if (!injected && sql.includes("SET status = 'todo'")) {
        injected = true;
        return run("DO $$ BEGIN RAISE EXCEPTION 'injected replay PG write failure' USING ERRCODE = '40001'; END $$", []);
      }
      return run(sql, ...args);
    });
    try { store.dispatchPendingSystemEvents(new Date(check.availableAt)); } finally { failure.mockRestore(); }
    expect(injected).toBe(true);
    const first = store.getSystemEvent(check.id)!;
    expect(first.status).toBe("pending");
    expect(first.attemptCount).toBe(1);
    expect(first.lastError).toContain("injected replay PG write failure");
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
    store.dispatchPendingSystemEvents(new Date(Date.parse(check.availableAt) + 10_000));
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).map((task) => task.status)).toEqual(["queued"]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_started"))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ replayed: true }) })]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
    expect(store.getSystemEvent(check.id)).toMatchObject({ status: "processed", attemptCount: 2 });
  });

  it("U10 contains a PATCH auto-start write failure and replays it (PG)", async () => {
    drainSystemEvents();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ name: "Patch write PG", provider: "claude" });
    const owner = store.createAgent({ name: "Patch write PG", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Patch write PG prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Patch write PG dependent", status: "backlog", blockedBy: [prereq.id],
      assigneeType: "agent", assigneeId: owner.id });
    const run = db.run.bind(db);
    let injected = false;
    const failure = spyOn(db, "run").mockImplementation((sql, ...args) => {
      if (!injected && sql.includes("SET status = 'todo'")) {
        injected = true;
        return run("DO $$ BEGIN RAISE EXCEPTION 'injected normal PG write failure' USING ERRCODE = '40001'; END $$", []);
      }
      return run(sql, ...args);
    });
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await app.request(`/api/issues/${prereq.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }),
      });
      expect(response.status).toBe(200);
      expect(injected).toBe(true);
      expect(warnings.mock.calls).toHaveLength(1);
    } finally {
      failure.mockRestore();
      warnings.mockRestore();
    }
    expect(store.getIssue(prereq.id)?.status).toBe("done");
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
    const row = db.query("SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'")
      .get(prereq.id) as { id: string };
    const check = store.getSystemEvent(row.id)!;
    store.dispatchPendingSystemEvents(new Date(check.availableAt));
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).map((task) => task.status)).toEqual(["queued"]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_started"))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ replayed: true }) })]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
    expect(store.getSystemEvent(check.id)?.status).toBe("processed");
  });

  it("U10b rolls back a failed business skip and records one on replay (PG)", async () => {
    drainSystemEvents();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ name: "Patch skip PG", provider: "claude" });
    const owner = store.createAgent({ name: "Patch skip PG", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Patch skip PG prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Patch skip PG dependent", status: "backlog", blockedBy: [prereq.id],
      assigneeType: "agent", assigneeId: owner.id });
    db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), owner.id]);
    const ctx = (store as unknown as { ctx: StoreContext }).ctx;
    const original = ctx.appendIssueActivity.bind(ctx);
    let injected = false;
    ctx.appendIssueActivity = (issueId, input, deferredEvents) => {
      if (!injected && input.type === "dependency_auto_start_skipped") {
        injected = true;
        throw new Error("injected PG skip activity failure");
      }
      original(issueId, input, deferredEvents);
    };
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await app.request(`/api/issues/${prereq.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }),
      });
      expect(response.status).toBe(200);
      expect(injected).toBe(true);
      expect(warnings.mock.calls).toHaveLength(1);
    } finally {
      ctx.appendIssueActivity = original;
      warnings.mockRestore();
    }
    expect(store.getIssue(prereq.id)?.status).toBe("done");
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped")).toEqual([]);
    const row = db.query("SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'")
      .get(prereq.id) as { id: string };
    const check = store.getSystemEvent(row.id)!;
    store.dispatchPendingSystemEvents(new Date(check.availableAt));
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_auto_start_skipped"))
      .toHaveLength(1);
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
    expect(store.getSystemEvent(check.id)?.status).toBe("processed");
  });

  it("leaves no todo-without-round and no backlog-with-round when the process dies at the claim (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_crash_pg", name: "Crash worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Crash owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Crash prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Crash dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    // QA's seam, run as a real OS process: it exits the first time the dependent
    // is visible as `todo`. Pre-fix that was the standalone claim commit, so the
    // process died with `todo` and no round — the permanent hole in the report.
    const probe = Bun.spawn([
      "bun", "run", new URL("./fixtures/postgres-autostart-crash-probe.ts", import.meta.url).pathname,
      pgDatabaseUrl(TEST_DB), prereq.id, dependent.id, "after-claim-commit",
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: process.env.HOME } });
    const stdout = await killProbeOnPhase(probe, "after-claim-commit");
    expect(stdout).toContain("after-claim-commit");

    // Whole row sets, as the plan requires.
    const taskRows = db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id) as Array<{ status: string }>;
    const status = store.getIssue(dependent.id)?.status;
    const activeRows = taskRows.filter((row) => !["completed", "failed", "cancelled"].includes(row.status));
    const activities = db.query(
      "SELECT type FROM multiremi_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id) as Array<{ type: string }>;
    const autoStarted = activities.filter((row) => row.type === "dependency_auto_started").length;

    // The two invariants the fix exists for, asserted as a pair so exactly one
    // shape is accepted: the durable state is either the untouched waiting row or
    // the complete start. The pre-fix "todo with no round" fails both.
    expect({ status: status === "todo" && activeRows.length === 0 }).toEqual({ status: false });
    expect({ status: status === "backlog" && activeRows.length > 0 }).toEqual({ status: false });
    if (status === "todo") {
      // Committed start: the round and the activity are there with it.
      expect(activeRows).toHaveLength(1);
      expect(autoStarted).toBe(1);
    } else {
      // Rolled back: still waiting, nothing of the attempt survived.
      expect(status).toBe("backlog");
      expect(taskRows).toEqual([]);
      expect(autoStarted).toBe(0);
    }
    // The prerequisite's own `done` is not part of the attempt: it is the trigger
    // and stays committed either way.
    expect(store.getIssue(prereq.id)?.status).toBe("done");

    // Whatever the crash left, the issue is startable through a public path —
    // this is the recovery the ADR documents for the crash window.
    if (status === "backlog") {
      const assigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: owner.id });
      expect(assigned.task?.id).toBeDefined();
      expect(store.getIssue(dependent.id)?.status).toBe("todo");
    }
    expect(db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id)).toEqual([{ status: "queued" }]);
  }, 60_000);

  /**
   * MUL-409 fix round 5 (QA round 4, blocker 1) on Postgres: the member's forced
   * start is one transaction.
   *
   * QA's round-4 probe exited after the status transaction committed and before
   * the dispatch ran, and found `A=todo` with no task rows while
   * `dependency_force_started` was already durable. Both seams run the real
   * store against a real Postgres connection.
   */
  it("rolls the forced start back when the process dies before COMMIT (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_force_before", name: "Force before worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Force before owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Force before prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Force before dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    const probe = Bun.spawn([
      "bun", "run", new URL("./fixtures/postgres-force-start-crash-probe.ts", import.meta.url).pathname,
      pgDatabaseUrl(TEST_DB), dependent.id, "before-commit",
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: process.env.HOME } });
    const stdout = await killProbeOnPhase(probe, "after-status-update");
    expect(stdout).toContain("after-status-update");

    // The status UPDATE died with its transaction: the issue is still waiting
    // and nothing about the attempt survives.
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    expect(db.query("SELECT status FROM multiremi_tasks WHERE issue_id = ?").all(dependent.id)).toEqual([]);
    const types = (db.query("SELECT type FROM multiremi_issue_activity WHERE issue_id = ?").all(dependent.id) as Array<{ type: string }>)
      .map((row) => row.type);
    expect(types).not.toContain("dependency_force_started");
    expect(types).not.toContain("issue_assigned");
    expect(store.getIssue(prereq.id)?.status).toBe("in_progress");
  }, 60_000);

  it("keeps todo plus its round when the process dies after the forced start commits (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_force_after", name: "Force after worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Force after owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Force after prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Force after dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    const probe = Bun.spawn([
      "bun", "run", new URL("./fixtures/postgres-force-start-crash-probe.ts", import.meta.url).pathname,
      pgDatabaseUrl(TEST_DB), dependent.id, "after-status-commit", "19",
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: process.env.HOME } });
    const { stdout, exitCode } = await waitForProbeExit(probe, "after-status-commit");
    expect(stdout).toContain("after-status-commit");
    expect(exitCode).toBe(19);

    // The whole forced start committed: `todo` with exactly one queued round and
    // the override already on record. Only the live notification was lost.
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id)).toEqual([{ status: "queued" }]);
    const types = (db.query("SELECT type FROM multiremi_issue_activity WHERE issue_id = ?").all(dependent.id) as Array<{ type: string }>)
      .map((row) => row.type);
    expect(types).toContain("dependency_force_started");
    expect(types).toContain("issue_assigned");
    // The prerequisite is untouched: the member overrode the hold, it did not
    // satisfy it.
    expect(store.getIssue(prereq.id)?.status).toBe("in_progress");
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
  }, 60_000);

  it("keeps the gate-open member start record when the process dies after COMMIT (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_gate_open_after", name: "Gate-open worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Gate-open owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Gate-open prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Gate-open dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    // Open the gate without running the automatic-start hook. The child then
    // exits immediately after the member update's owner transaction commits,
    // before `runIssueUpdatePostCommit` can publish the queued events.
    db.run("UPDATE multiremi_issues SET status = 'done' WHERE id = ?", [prereq.id]);
    expect(store.listUnmetPrerequisites(dependent.id)).toEqual([]);
    const probe = Bun.spawn([
      "bun", "run", new URL("./fixtures/postgres-force-start-crash-probe.ts", import.meta.url).pathname,
      pgDatabaseUrl(TEST_DB), dependent.id, "after-gate-open-commit", "19",
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: process.env.HOME } });
    const { stdout, exitCode } = await waitForProbeExit(probe, "after-gate-open-commit");
    expect(stdout).toContain("after-gate-open-commit");
    expect(exitCode).toBe(19);

    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id)).toEqual([{ status: "queued" }]);
    const activities = store.listIssueActivity(dependent.id);
    expect(activities.filter((entry) => entry.type === "issue_assigned")).toHaveLength(1);
    expect(activities.filter((entry) => entry.type === "dependency_auto_started")).toEqual([]);
    expect(activities.filter((entry) => entry.type === "dependency_force_started")).toEqual([]);
    const memberUpdates = activities.filter((entry) => entry.type === "issue_updated"
      && (entry.data as Record<string, unknown> | null)?.status === "todo"
      && (entry.data as Record<string, unknown> | null)?.force === true);
    expect(memberUpdates).toHaveLength(1);
    expect(memberUpdates[0]!.data).toMatchObject({
      actorType: "member",
      actorId: "mem_local",
    });
  }, 60_000);

  it.each(["status update", "task insert", "issue_assigned", "dependency_force_started"] as const)(
    "rolls the forced start back when %s fails (PG)",
    (step) => {
      const runtime = store.registerRuntime({ id: `rt_force_inj_${step.replace(/ /g, "_")}`, name: "Force injection worker", provider: "claude", maxConcurrency: 4 });
      const owner = store.createAgent({ name: `Force injection ${step}`, provider: "claude", runtimeId: runtime.id });
      const prereq = store.createIssue({ title: "Injection prerequisite", status: "in_progress" });
      const dependent = store.createIssue({
        title: `Injection dependent ${step}`,
        status: "backlog",
        blockedBy: [prereq.id],
        assigneeType: "agent",
        assigneeId: owner.id,
      });

      let injected = false;
      const fail = (): never => { injected = true; throw new Error(`injected PG failure at ${step}`); };
      const restore: Array<() => void> = [];
      const handle = (store as unknown as { ctx: { db: Record<string, unknown> } }).ctx.db;
      if (step === "status update") {
        const original = handle.run as (...args: unknown[]) => unknown;
        handle.run = (...args: unknown[]) => {
          const sql = String(args[0] ?? "");
          if (!injected && sql.includes("UPDATE multiremi_issues") && sql.includes("title = ?")) fail();
          return original.apply(handle, args);
        };
        restore.push(() => { handle.run = original; });
      } else if (step === "task insert") {
        const original = TasksRepo.prototype.createTaskWithinTransaction;
        TasksRepo.prototype.createTaskWithinTransaction = function patched(this: TasksRepo, ...args: unknown[]) {
          if (!injected) fail();
          return (original as (...inner: unknown[]) => unknown).apply(this, args);
        } as typeof TasksRepo.prototype.createTaskWithinTransaction;
        restore.push(() => { TasksRepo.prototype.createTaskWithinTransaction = original; });
      } else {
        // Patch the INSTANCE, not the prototype: an earlier case in this file
        // already replaced `ctx.appendIssueActivity` on the shared store, so a
        // prototype patch would sit underneath it and never see the call.
        const ctx = (store as unknown as {
          ctx: { appendIssueActivity: (...args: unknown[]) => unknown };
        }).ctx;
        const original = ctx.appendIssueActivity;
        ctx.appendIssueActivity = (...args: unknown[]) => {
          const input = args[1] as { type?: string } | undefined;
          if (!injected && input?.type === step) fail();
          return original.apply(ctx, args);
        };
        restore.push(() => { ctx.appendIssueActivity = original; });
      }

      try {
        expect(() => store.updateIssue(dependent.id, {
          status: "todo", force: true, actorType: "member", actorId: "mem_local",
        })).toThrow(/injected PG failure/);
        expect(injected).toBe(true);
      } finally {
        for (const undo of restore.reverse()) undo();
      }

      // The whole attempt rolled back on the real bridge: back to `backlog`, no
      // round, no activity, and the prerequisite untouched.
      expect({
        step,
        status: store.getIssue(dependent.id)?.status,
        tasks: db.query("SELECT status FROM multiremi_tasks WHERE issue_id = ?").all(dependent.id),
        activities: (db.query(
          "SELECT type FROM multiremi_issue_activity WHERE issue_id = ? AND type IN ('dependency_force_started', 'issue_assigned')",
        ).all(dependent.id) as Array<{ type: string }>).map((row) => row.type),
      }).toEqual({ step, status: "backlog", tasks: [], activities: [] });
    },
  );

  it("keeps todo plus its round when the process dies after COMMIT (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_after_commit", name: "After commit worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "After commit owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "After commit prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "After commit dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    const probe = Bun.spawn([
      "bun", "run", new URL("./fixtures/postgres-autostart-crash-probe.ts", import.meta.url).pathname,
      pgDatabaseUrl(TEST_DB), prereq.id, dependent.id, "after-commit",
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: process.env.HOME } });
    const stdout = await killProbeOnPhase(probe, "after-commit");
    expect(stdout).toContain("after-commit");

    // The COMMIT is durable: the dependent is `todo` with exactly one queued
    // round and both activities. Only the live notification was lost, which a
    // client recovers by refreshing.
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    const taskRows = db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id) as Array<{ status: string }>;
    expect(taskRows).toEqual([{ status: "queued" }]);
    const activities = db.query(
      "SELECT type FROM multiremi_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id) as Array<{ type: string }>;
    const types = activities.map((row) => row.type);
    expect(types).toContain("issue_assigned");
    expect(types).toContain("dependency_auto_started");
    expect(types).not.toContain("dependency_auto_start_skipped");
  }, 60_000);

  it("runs an automatic start of a second owner in the reverse order of a forced start (PG)", async () => {
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ id: "rt_order_pg", name: "Order worker", provider: "claude", maxConcurrency: 4 });
    const owner = store.createAgent({ name: "Order owner", provider: "claude", runtimeId: runtime.id });
    const prereq = store.createIssue({ title: "Order prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Order dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });

    // Reverse of the covered order: the automatic start wins first, then a member
    // still sends a forced start. It answers 200 (the status write is an
    // ordinary no-op move) and queues nothing more.
    store.updateIssue(prereq.id, { status: "done" });
    const response = await app.request(`/api/issues/${dependent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo", force: true }),
    });
    expect(response.status).toBe(200);

    const taskRows = db.query(
      "SELECT status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(dependent.id) as Array<{ status: string }>;
    expect(taskRows).toEqual([{ status: "queued" }]);
    const auto = db.query(
      "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_auto_started'",
    ).all(dependent.id) as Array<{ id: string }>;
    expect(auto).toHaveLength(1);
    const forced = db.query(
      "SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'dependency_force_started'",
    ).all(dependent.id) as Array<{ id: string }>;
    expect(forced).toEqual([]);
  }, 60_000);

  /**
   * Await the probe's phase line on its stdout, then kill it. The probe holds
   * the transaction open until killed, so the phase line is the signal that the
   * process is parked exactly where the test wants it.
   */
  async function killProbeOnPhase(probe: Bun.Subprocess<"ignore", "pipe", "pipe">, phase: string): Promise<string> {
    const reader = probe.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    try {
      while (!seen.includes(phase)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`probe exited before announcing ${phase}; stdout=${seen}`);
        seen += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    probe.kill("SIGKILL");
    await probe.exited;
    return seen;
  }

  /**
   * Await a probe that exits on its own (a real crash), and return what it wrote
   * plus its exit code. Unlike `killProbeOnPhase` the process is expected to die
   * by itself; the phase line proves it reached the seam before dying.
   */
  async function waitForProbeExit(
    probe: Bun.Subprocess<"ignore", "pipe", "pipe">,
    phase: string,
  ): Promise<{ stdout: string; exitCode: number | null }> {
    const decoder = new TextDecoder();
    let stdout = "";
    const reader = probe.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const exitCode = await probe.exited;
    if (!stdout.includes(phase)) {
      throw new Error(`probe never announced ${phase}; stdout=${stdout}`);
    }
    return { stdout, exitCode };
  }

  /**
   * Await one named phase from a Worker; rejects on its error phase.
   *
   * The listener is attached BEFORE the caller posts the init message: a worker
   * that reports `ready` quickly would otherwise post into the void, and the test
   * would hang instead of running.
   */
  function armWorkerPhase(worker: Worker, phase: string, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`two-connection race worker did not reach ${phase} within ${timeoutMs}ms`));
      }, timeoutMs);
      const onMessage = (event: MessageEvent<{ phase?: string; error?: string }>) => {
        if (event.data.phase === "error") {
          cleanup();
          reject(new Error(event.data.error ?? "two-connection race worker failed"));
        } else if (event.data.phase === phase) {
          cleanup();
          resolve();
        }
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(event.error ?? new Error(event.message));
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  it("keeps exactly one start record when a forced and an automatic start race (PG)", async () => {
    const runtime = store.registerRuntime({ id: "rt_two_conn", name: "Two connection worker", provider: "claude", maxConcurrency: 8 });
    const owner = store.createAgent({ name: "Two connection owner", provider: "claude", runtimeId: runtime.id });
    const ROUNDS = Number(process.env.MUL409_TWO_CONN_ROUNDS ?? 30);
    const workerUrl = new URL("./fixtures/postgres-two-connection-race-worker.ts", import.meta.url);
    // Per-attempt invariant, from the QA round 4 ruling: exactly one task row
    // (every status, cancelled included) and exactly one of the three start
    // records. Zero and two are both failures.
    const distribution = { auto: 0, force: 0, member: 0, none: 0, both: 0 };
    const mismatches: Array<Record<string, unknown>> = [];
    for (let round = 0; round < ROUNDS; round++) {
      const prereq = store.createIssue({ title: `Two conn prereq ${round}`, status: "in_progress" });
      const dependent = store.createIssue({
        title: `Two conn dependent ${round}`,
        status: "backlog",
        blockedBy: [prereq.id],
        assigneeType: "agent",
        assigneeId: owner.id,
      });
      const barrierDir = mkdtempSync(join(tmpdir(), "mul409-two-conn-"));
      const barrier = join(barrierDir, "go");
      const databaseUrl = pgDatabaseUrl(TEST_DB);
      const workers: Array<{ worker: Worker; ready: Promise<void>; done: Promise<void> }> = ["force", "auto"].map((role) => {
        const worker = new Worker(workerUrl, { type: "module" });
        // Arm both phases before the init message, so a fast reply is never lost.
        const ready = armWorkerPhase(worker, "ready");
        const done = armWorkerPhase(worker, "done");
        worker.postMessage({ databaseUrl, issueId: dependent.id, prerequisiteId: prereq.id, barrierPath: barrier, role });
        return { worker, ready, done };
      });
      await Promise.all(workers.map((entry) => entry.ready));
      writeFileSync(barrier, "go");
      await Promise.all(workers.map((entry) => entry.done));
      workers.forEach((entry) => entry.worker.terminate());
      rmSync(barrierDir, { recursive: true, force: true });

      // All task rows, cancelled included: a round that was queued and then
      // cancelled is still evidence that the start ran once.
      const rows = db.query("SELECT id, status FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at ASC")
        .all(dependent.id) as Array<{ status: string }>;
      const activityTypes = db.query(
        "SELECT type, data FROM multiremi_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
      ).all(dependent.id) as Array<{ type: string; data: string | null }>;
      const auto = activityTypes.filter((row) => row.type === "dependency_auto_started").length;
      const force = activityTypes.filter((row) => row.type === "dependency_force_started").length;
      // The third kind: the member's own backlog -> todo write, with no
      // dependency start activity beside it. That is the ruling's "the gate was
      // already open when the lock was taken" outcome.
      const member = activityTypes.some((row) => {
        if (row.type !== "issue_updated") return false;
        try {
          const data = JSON.parse(row.data ?? "{}") as Record<string, unknown>;
          return data.status === "todo";
        } catch { return false; }
      });
      const kind = auto && force ? "both"
        : auto ? "auto"
        : force ? "force"
        : member ? "member"
        : "none";
      distribution[kind as keyof typeof distribution] += 1;
      const rowStatuses = rows.map((row) => row.status);
      if (rows.length !== 1 || (kind !== "auto" && kind !== "force" && kind !== "member")) {
        mismatches.push({
          round,
          kind,
          status: store.getIssue(dependent.id)?.status,
          rows: rowStatuses,
          auto,
          force,
          member,
        });
      }
    }
    // The per-kind split is a genuine race and is reported, not asserted. The
    // counts themselves are the deliverable: the QA round printed 4 rounds with
    // no start record at all, which this loop now fails on.
    console.log(`[mul409-two-conn] distribution=${JSON.stringify(distribution)} mismatches=${JSON.stringify(mismatches)}`);
    expect({ distribution: { ...distribution, none: 0, both: 0 }, mismatches }).toEqual({
      distribution: { auto: expect.any(Number), force: expect.any(Number), member: expect.any(Number), none: 0, both: 0 },
      mismatches: [],
    });
    // Every round produced a record: the three kinds must account for the run.
    expect(distribution.auto + distribution.force + distribution.member).toBe(ROUNDS);
  }, 180_000);

});
