import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { runMigrations } from "@multiremi/store/migrations.js";
import { CHAT_ISSUE_DECOUPLED_FINGERPRINT } from "@multiremi/store/helpers.js";
import { seedLegacyChatIssueFixture } from "./chat-issue-migration-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("migration invalidates already-running detached private provider lineage", () => {
  for (const tableForeignKey of [false, true]) {
    for (const status of ["running", "awaiting_human", "waiting_local_directory"] as const) {
      for (const terminal of ["complete", "retry"] as const) {
        it(`${tableForeignKey ? "table" : "inline"} FK ${status}: late ${terminal} cannot restore old no-push lineage`, () => {
          const store = createLocalStore();
          seedLegacyChatIssueFixture(db!, tableForeignKey);
          const fingerprint = createHash("sha256").update("[]").digest("hex");
          store.registerRuntime({ id: "rt_legacy", name: "Old machine", provider: "codex", workspaceId: "local" });
          // The explicit unbind left NO Issue columns or proactive push record,
          // but a usable provider pointer still refers to the old Issue session.
          db!.run(`UPDATE multiremi_chat_sessions SET issue_id = NULL, session_execution_fingerprint = ?
            WHERE id = 'chat_web_migration'`, [fingerprint]);
          db!.run(`UPDATE multiremi_tasks SET issue_id = NULL, issue_session_id = NULL, issue_session_generation = NULL
            WHERE chat_session_id = 'chat_web_migration'`);
          db!.run(`UPDATE multiremi_tasks SET status = ?, runtime_id = 'rt_legacy', provider = 'codex', execution_fingerprint = ?
            WHERE id = 'tsk_chat_migration_running'`, [status, fingerprint]);
          db!.run("DELETE FROM multiremi_tasks WHERE id <> 'tsk_chat_migration_running'");
          expect(db!.query("SELECT id FROM multiremi_feishu_bot_round_pushes").all()).toEqual([]);
          expect(db!.query("SELECT id FROM multiremi_feishu_bot_human_request_pushes").all()).toEqual([]);
          runMigrations(db!);
          expect(store.getTask("tsk_chat_migration_running")?.executionFingerprint).toBe(CHAT_ISSUE_DECOUPLED_FINGERPRINT);
          expect(store.getTask("tsk_chat_migration_running")?.workDir).toBe("/work/keep");
          if (terminal === "complete") {
            store.completeTask("tsk_chat_migration_running", { output: "User work finished", sessionId: "old_issue_provider" });
            expect(store.getChatSession("chat_web_migration")?.sessionId).toBeNull();
            const next = store.sendChatMessage("chat_web_migration", { content: "Next private question" }).task;
            expect(next.sessionId).toBeNull();
            const claim = store.claimTask("rt_legacy")!;
            expect(claim.id).toBe(next.id);
            expect(claim.sessionId).toBeNull();
            expect(claim.issueId).toBeNull();
            expect(claim.executionFingerprint).toBe(fingerprint);
            store.completeTask(claim.id, { output: "Fresh reply", sessionId: "fresh_private_provider" });
            expect(store.getChatSession("chat_web_migration")?.sessionId).toBe("fresh_private_provider");
          } else {
            store.failTask("tsk_chat_migration_running", { error: "temporary timeout", failureReason: "timeout", sessionId: "old_issue_provider" });
            expect(store.getChatSession("chat_web_migration")?.sessionId).toBeNull();
            const retry = store.listTasks().find((task) => task.parentTaskId === "tsk_chat_migration_running")!;
            expect(retry.sessionId).toBeNull();
            expect(retry.issueId).toBeNull();
            expect(retry.executionFingerprint).not.toBe(CHAT_ISSUE_DECOUPLED_FINGERPRINT);
            const claim = store.claimTask("rt_legacy")!;
            expect(claim.id).toBe(retry.id);
            expect(claim.sessionId).toBeNull();
            expect(claim.executionFingerprint).toBe(fingerprint);
          }
        });
      }
    }
  }
  it("a retained B topic with stale A work cannot restore A lineage when matching B work finishes", () => {
    const store = createLocalStore();
    seedLegacyChatIssueFixture(db!);
    const fingerprint = createHash("sha256").update("[]").digest("hex");
    store.registerRuntime({ id: "rt_legacy", name: "Old machine", provider: "codex", workspaceId: "local" });
    db!.run("DELETE FROM multiremi_tasks WHERE id <> 'tsk_topic_migration_queued'");
    db!.run(`UPDATE multiremi_tasks SET status = 'running', runtime_id = 'rt_legacy',
      provider = 'codex', execution_fingerprint = ?, session_id = 'old_A_provider'
      WHERE id = 'tsk_topic_migration_queued'`, [fingerprint]);
    db!.run(`UPDATE multiremi_chat_sessions SET session_execution_fingerprint = ?
      WHERE id = 'chat_group_migration'`, [fingerprint]);
    db!.run(`INSERT INTO multiremi_issues (id, title, status, created_at, updated_at)
      VALUES ('issue_old_A', 'Prior Issue A', 'todo', '2026-09-01', '2026-09-01')`);
    db!.run(`INSERT INTO multiremi_tasks
      (id, workspace_id, agent_id, issue_id, chat_session_id, prompt, status, created_at, updated_at)
      VALUES ('old_A_wake', 'local', 'agt_chat_migration', 'issue_old_A', 'chat_group_migration',
        'Old A wake', 'queued', '2026-09-01', '2026-09-01')`);
    db!.run(`INSERT INTO multiremi_feishu_bot_round_pushes
      (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
      VALUES ('old_A_push', 'local', 'fcb_chat_group_migration', 'issue_old_A', 'old_A_source',
        'old_A_wake', 'proactive', '2026-09-01', '2026-09-01')`);
    runMigrations(db!);
    expect(store.getFeishuIssueIdForChatSession("chat_group_migration")).toBe("iss_chat_migration");
    expect(store.getTask("old_A_wake")?.status).toBe("cancelled");
    expect(store.getTask("tsk_topic_migration_queued")?.executionFingerprint).toBe(CHAT_ISSUE_DECOUPLED_FINGERPRINT);
    store.completeTask("tsk_topic_migration_queued", { output: "B work finished", sessionId: "old_A_provider" });
    expect(store.getChatSession("chat_group_migration")?.sessionId).toBeNull();
    const next = store.sendChatMessage("chat_group_migration", { content: "Continue B" }).task;
    expect(next.issueId).toBe("iss_chat_migration");
    const claim = store.claimTask("rt_legacy")!;
    expect(claim.id).toBe(next.id);
    expect(claim.sessionId).toBeNull();
    expect(claim.executionFingerprint).toBe(fingerprint);
    store.completeTask(claim.id, { output: "Fresh B reply", sessionId: "fresh_B_provider" });
    expect(store.getChatSession("chat_group_migration")?.sessionId).toBe("fresh_B_provider");
  });

});
