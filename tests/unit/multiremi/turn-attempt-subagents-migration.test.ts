/**
 * PR 5: `20261017_turn_attempt_subagents` adds `running_subagents` and
 * `late_subagents` to `multiremi_turn_attempts` on both migration chains. A
 * fresh schema already has them (the full chain records the migration as a
 * no-op); an upgraded database gains them once on the unified-snapshot chain,
 * keeps NULL for the attempts that predate them, and the turn list, the
 * attempt list and the card project them. On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { createResponsibleTestIssue } from "./helpers.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";

const MIGRATION = "20261017_turn_attempt_subagents";
const COLUMNS = ["late_subagents", "running_subagents"];
const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("subagentcols");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function columnTypes(db: SqlDatabase): Record<string, string> {
  if (db.dialect === "postgres") {
    const rows = db.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'multiremi_turn_attempts' AND column_name IN ('running_subagents', 'late_subagents')`).all() as Array<{ column_name: string; data_type: string }>;
    return Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]));
  }
  const rows = db.query("PRAGMA table_info(multiremi_turn_attempts)").all() as Array<{ name: string; type: string }>;
  return Object.fromEntries(rows.filter((row) => COLUMNS.includes(row.name)).map((row) => [row.name, row.type.toLowerCase()]));
}

function migrationRows(db: SqlDatabase): number {
  return Number((db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_schema_migrations WHERE id = ?").get(MIGRATION) as { n: number }).n);
}

const LATE = [{ item_id: "sa:reviewer", name: "Reviewer", status: "completed" as const, duration_ms: 31_000 }];

for (const backend of backends) {
  describe.skipIf(!backend.available)(`turn attempt subagents migration (${backend.name})`, () => {
    it("ships the columns in a fresh schema and records the migration once", async () => {
      const opened = await backend.open();
      try {
        expect(columnTypes(opened.db)).toEqual({ running_subagents: "integer", late_subagents: "text" });
        expect(migrationRows(opened.db)).toBe(1);
        new MultiremiStore(opened.db);
        expect(migrationRows(opened.db)).toBe(1);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("adds the columns to an upgraded database without touching older attempts", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        const runtime = store.registerRuntime({ name: "Subagent daemon", provider: "claude", workspaceId: "local" });
        const agent = store.createAgent({ name: "Subagent agent", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
        const issue = createResponsibleTestIssue(store, { title: "Before PR 5", workspaceId: "local" });
        const old = store.createTask({ agentId: agent.id, workspaceId: "local", issueId: issue.id, prompt: "old" });
        // The database as a pre-PR 5 release left it: no columns, no migration row.
        db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [MIGRATION]);
        for (const column of COLUMNS) db.exec(`ALTER TABLE multiremi_turn_attempts DROP COLUMN ${column}`);
        expect(columnTypes(db)).toEqual({});

        // Two starts: the first adds the columns, the second finds the migration applied.
        new MultiremiStore(db);
        new MultiremiStore(db);
        const reopened = new MultiremiStore(db);
        expect(Object.keys(columnTypes(db)).sort()).toEqual(COLUMNS);
        expect(migrationRows(db)).toBe(1);
        const turnId = reopened.getTurnForAttempt(old.id)!.id;
        expect(reopened.listTurns({ workspace_id: "local", issue_id: issue.id }).find((row) => row.id === turnId))
          .toMatchObject({ running_subagents: null });
        expect(reopened.listTurnAttempts(turnId).find((row) => row.id === old.id))
          .toMatchObject({ running_subagents: null, late_subagents: null });
        expect(reopened.findTurnEntry(old.id)!.metadata).toMatchObject({ late_subagents: null });

        // After the upgrade the attempt takes a running count and the completion fact.
        expect(reopened.claimTask(runtime.id)?.id).toBe(old.id);
        reopened.startTask(old.id);
        expect(reopened.recordRunningSubagents(old.id, 2)).toBe(true);
        expect(reopened.listTurns({ workspace_id: "local", issue_id: issue.id }).find((row) => row.id === turnId))
          .toMatchObject({ running_subagents: 2 });
        const fields: DaemonTaskCompletionFields = {
          trace: { head: 3, event_count: 3, closed: true, tool_call_count: 1, type_histogram: [{ type: "subagent", tool: "Agent", count: 1 }] },
          final_reply_md: "done", model: null, context_usage: null, worked_ms: 1_000, process_item_count: 1, late_subagents: LATE,
        };
        expect(db.transaction(() => reopened.recordTurnCardCompletionFieldsWithinTransaction(old.id, fields))()).toBe(true);
        expect(reopened.findTurnEntry(old.id)!.metadata).toMatchObject({ late_subagents: LATE });
        expect(reopened.listTurnAttempts(turnId).find((row) => row.id === old.id)).toMatchObject({ running_subagents: 2, late_subagents: LATE });
      } finally { await opened.close(); }
    }, TIMEOUT);
  });
}
