import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations, bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import { MultiremiStore } from "@multiremi/store.js";
import { seedLegacyChatIssueFixture } from "./chat-issue-migration-fixture.js";
import { createHistoricalDatabase, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("drained Chat migration cannot restore private Issue lineage", () => {
  for (const tableForeignKey of [false, true]) {
    for (const status of ["running", "awaiting_human", "waiting_local_directory"] as const) {
      it(`${tableForeignKey ? "table" : "inline"} FK ${status}: cuts over after drain and starts private work cold`, () => {
        createHistoricalDatabase();
        seedLegacyChatIssueFixture(db!, tableForeignKey);
        db!.run("UPDATE multiremi_tasks SET status='cancelled'");
        db!.run("UPDATE multiremi_tasks SET status=? WHERE id='tsk_chat_migration_running'", [status]);
        if (status !== "waiting_local_directory") {
          const before = db!.query("SELECT * FROM multiremi_tasks").all();
          expect(() => runMigrations(db!)).toThrow("Unified model migration refused");
          expect(db!.query("SELECT * FROM multiremi_tasks").all()).toEqual(before);
          expect(db!.query("SELECT name FROM sqlite_master WHERE name='multiremi_turns'").get()).toBeNull();
        }
        // MUL-493 requires draining before cutover; no legacy worker survives it.
        db!.run("UPDATE multiremi_tasks SET status='cancelled'");
        bootstrapPreUnifiedSchema(db!);
        const store = new MultiremiStore(db!);
        expect(store.getTask("tsk_chat_migration_running")?.status).toBe("cancelled");
        expect(store.getChatSession("chat_web_migration")?.sessionId).toBeNull();
        expect(() => store.completeTask("tsk_chat_migration_running", { output: "stale", sessionId: "old_issue_provider" })).toThrow();
        expect(store.getChatSession("chat_web_migration")?.sessionId).toBeNull();
        const runtime = store.registerRuntime({ id: "rt_legacy", name: "Machine", provider: "codex", workspaceId: "local" });
        const next = store.sendChatMessage("chat_web_migration", { content: "Next private question" }).task;
        const claim = store.claimTask(runtime.id)!;
        expect(claim.id).toBe(next.id);
        expect(claim.issueId).toBeNull();
        expect(claim.sessionId).toBeNull();
        store.buildTaskSessionProjection(claim.id);
        store.startTask(claim.id);
        store.completeTask(claim.id, { output: "Fresh reply", sessionId: "fresh_private_provider" });
        expect(store.getChatSession("chat_web_migration")?.sessionId).toBe("fresh_private_provider");
      });
    }
  }
});
