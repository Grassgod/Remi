import { expect, it } from "bun:test";
import { migrateTaskExecutionScope, runMigrations } from "@multiremi/store/migrations.js";
import { executionScopeSql, TASK_EXECUTION_SCOPE_MIGRATION } from "@multiremi/store/pending-turns.js";
import { installPendingTurnTestConstraints, pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("one pending turn migration", (fixture) => {
  function legacyFixture() {
    const { db, store } = fixture();
    db.exec(`DROP INDEX IF EXISTS idx_multiremi_tasks_one_pending_turn_session;
      DROP INDEX IF EXISTS idx_multiremi_tasks_one_pending_turn_chat;`);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [TASK_EXECUTION_SCOPE_MIGRATION]);
    const agent = store.createAgent({ name: "Migration owner", provider: "codex" });
    const other = store.createAgent({ name: "Delegator", provider: "codex" });
    const issue = store.createIssue({ title: "Migration lane" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const chat = store.createChatSession({ agentId: agent.id });
    let ordinal = 0;
    const add = (prompt: string, input: Record<string, unknown> = {}) => {
      const task = fixture().store.createTask({ agentId: agent.id, issueId: issue.id, prompt, ...input });
      fixture().db.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?",
        [`2026-09-29T00:00:0${ordinal++}.000Z`, task.id]);
      return task;
    };
    return { get db() { return fixture().db; }, get store() { return fixture().store; }, agent, other, issue, session, chat, add };
  }

  function migrate() {
    migrateTaskExecutionScope(fixture().db);
    installPendingTurnTestConstraints(fixture());
    // A server upgrade opens a fresh connection after changing SELECT * shapes.
    fixture().reopen();
  }

  it("keeps the oldest issue/chat queued rows and every newer prompt in order, with durable cancellation audits", () => {
    const f = legacyFixture();
    const issueTasks = ["issue first", "issue second\n" + "x".repeat(20_000), "issue third"].map(body => f.add(body));
    const chatTasks = ["chat first", "chat second"].map(body => f.add(body, { issueId: null, chatSessionId: f.chat.id }));
    const running = f.add("running unchanged");
    const completed = f.add("completed unchanged");
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);
    f.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [completed.id]);
    const beforeUnqueued = f.db.query("SELECT id, status, prompt, updated_at FROM multiremi_tasks WHERE status <> 'queued' ORDER BY id").all();
    migrate();
    for (const tasks of [issueTasks, chatTasks]) {
      const kept = f.store.getTask(tasks[0]!.id)!;
      expect(kept.status).toBe("queued");
      let previousPosition = -1;
      for (const source of tasks) {
        const position = kept.prompt.indexOf(source.prompt);
        expect(position).toBeGreaterThan(previousPosition);
        previousPosition = position;
      }
      for (const task of tasks.slice(1)) {
        expect(f.store.getTask(task.id)!.status).toBe("cancelled");
        const row = task.issueId
          ? f.db.query("SELECT data AS payload FROM multiremi_issue_activity WHERE type = 'pending_turn_collapsed' AND data LIKE ?").get(`%${task.id}%`)
          : f.db.query("SELECT payload FROM multiremi_system_events WHERE event = 'pending_turn_collapsed' AND resource_id = ? AND status = 'processed'").get(task.id);
        expect(JSON.parse((row as { payload: string }).payload)).toEqual({ task_id: task.id, kept_task_id: kept.id });
      }
    }
    expect(f.db.query("SELECT id, status, prompt, updated_at FROM multiremi_tasks WHERE id IN (?, ?) ORDER BY id")
      .all(running.id, completed.id)).toEqual(beforeUnqueued);
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_tasks WHERE status = 'queued'").get())
      .toEqual({ count: 2 });
    const snapshot = f.db.query("SELECT id, status, prompt, updated_at, execution_scope FROM multiremi_tasks ORDER BY id").all();
    migrateTaskExecutionScope(f.db);
    installPendingTurnTestConstraints(fixture());
    expect(f.db.query("SELECT id, status, prompt, updated_at, execution_scope FROM multiremi_tasks ORDER BY id").all()).toEqual(snapshot);
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_schema_migrations WHERE id = ?").get(TASK_EXECUTION_SCOPE_MIGRATION))
      .toEqual({ count: 1 });
  });

  it("backfills exactly the historical expression and keeps independent delegations and agents separate", () => {
    const f = legacyFixture();
    f.add("main");
    f.add("delegation A", { delegationId: "dlg_a", delegatedByAgentId: f.other.id });
    f.add("delegation B", { delegationId: "dlg_b", delegatedByAgentId: f.other.id });
    f.add("delegator return", { delegationId: "dlg_a", delegatedByAgentId: f.agent.id, agentId: f.other.id });
    f.add("nonqueued", { delegationId: "dlg_c", delegatedByAgentId: f.other.id });
    f.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE prompt = 'nonqueued'");
    const expected = f.db.query(`SELECT id, ${executionScopeSql("multiremi_tasks")} AS scope FROM multiremi_tasks ORDER BY id`).all();
    migrate();
    expect(f.db.query("SELECT id, execution_scope AS scope FROM multiremi_tasks ORDER BY id").all()).toEqual(expected);
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_tasks WHERE status = 'queued'").get()).toEqual({ count: 4 });
  });

  it("upgrades a schema missing both columns and backfills queued and completed tasks before indexing", () => {
    const f = legacyFixture();
    f.add("main first");
    f.add("main second");
    const delegated = f.add("delegated", { delegationId: "legacy_scope", delegatedByAgentId: f.other.id });
    const completed = f.add("completed", { delegationId: "completed_scope", delegatedByAgentId: f.other.id });
    f.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [completed.id]);
    const scopes = f.db.query(`SELECT id, ${executionScopeSql("multiremi_tasks")} AS scope FROM multiremi_tasks ORDER BY id`).all();
    f.db.exec("ALTER TABLE multiremi_tasks DROP COLUMN execution_scope; ALTER TABLE multiremi_tasks DROP COLUMN wake_seq;");
    migrate();
    expect(f.db.query("SELECT id, execution_scope AS scope FROM multiremi_tasks ORDER BY id").all()).toEqual(scopes);
    expect(f.store.getTask(delegated.id)!.execution_scope).toBe("legacy_scope");
    expect(f.store.getTask(completed.id)!.status).toBe("completed");
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_tasks WHERE status = 'queued'").get()).toEqual({ count: 2 });
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_tasks WHERE wake_seq <> 0").get()).toEqual({ count: 0 });
  });

  it("stores ordinary task lane keys and ignores a caller-supplied stored scope", () => {
    const f = legacyFixture();
    const task = f.add("delegate", { delegationId: "stored_scope", delegatedByAgentId: f.other.id, execution_scope: "forged" });
    expect(f.store.getTask(task.id)!.execution_scope).toBe("stored_scope");
    expect(f.db.query("SELECT execution_scope FROM multiremi_tasks WHERE id = ?").get(task.id))
      .toEqual({ execution_scope: "stored_scope" });
  });

  it("runs only the column migration at startup and preserves existing multiple queued turns", () => {
    const f = legacyFixture();
    f.add("first");
    f.add("second");
    f.add("third");
    const before = f.db.query("SELECT id, status, prompt, updated_at FROM multiremi_tasks ORDER BY id").all();
    runMigrations(f.db);
    fixture().reopen();
    expect(f.db.query("SELECT id, status, prompt, updated_at FROM multiremi_tasks ORDER BY id").all()).toEqual(before);
    const objects = f.db.query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string; type: string }>;
    expect(objects.filter(row => row.type === "index" && [
      "idx_multiremi_tasks_one_pending_turn_session", "idx_multiremi_tasks_one_pending_turn_chat",
    ].includes(row.name))).toEqual([]);
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_schema_migrations WHERE id = ?")
      .get(TASK_EXECUTION_SCOPE_MIGRATION)).toEqual({ count: 1 });
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_schema_migrations WHERE id = ?")
      .get("20260929_tasks_one_pending_turn")).toEqual({ count: 0 });
    expect(f.add("fourth").status).toBe("queued");
  });

  it("rejects a second queued issue lane, including continuations, then admits one after the first is running", () => {
    const f = legacyFixture();
    const first = f.add("first");
    migrate();
    expect(() => f.add("second")).toThrow();
    expect(() => f.add("continuation", { continuedFromTaskId: first.id })).toThrow();
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.id]);
    expect(f.add("allowed").status).toBe("queued");
  });

  it("enforces the chat lane and excludes rows that carry an issue_session_id from the chat index", () => {
    const f = legacyFixture();
    const first = f.add("chat first", { issueId: null, chatSessionId: f.chat.id });
    migrate();
    expect(() => f.add("chat duplicate", { issueId: null, chatSessionId: f.chat.id })).toThrow();
    f.db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [first.id]);
    expect(f.add("chat allowed", { issueId: null, chatSessionId: f.chat.id }).status).toBe("queued");
    // Raw insert tests the exact partial-index predicate, independently of
    // the public transport-binding validation.
    const at = "2026-09-29T00:00:00.000Z";
    for (const id of ["mixed_a", "mixed_b"]) {
      f.db.run(`INSERT INTO multiremi_tasks
        (id, agent_id, issue_id, issue_session_id, chat_session_id, execution_scope, status, prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 'mixed', ?, ?)`,
      [id, f.agent.id, f.issue.id, f.session.id, f.chat.id, id, at, at]);
    }
    expect(f.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_tasks WHERE id IN ('mixed_a', 'mixed_b')").get()).toEqual({ count: 2 });
  });
});
