/**
 * PR 2 (ADR 0019): `20261015_turn_attempt_trace_summary` adds the trace summary
 * columns to `multiremi_turn_attempts` on both migration chains. A fresh schema
 * already has them; an upgraded database gains them once, keeps NULL for the
 * attempts that predate them (no fold, no ring), and the card projects them.
 * On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { createResponsibleTestIssue } from "./helpers.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";

const MIGRATION = "20261015_turn_attempt_trace_summary";
const COLUMNS = ["context_usage", "process_item_count", "worked_ms"];
const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("tracesummary");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function columnTypes(db: SqlDatabase): Record<string, string> {
  if (db.dialect === "postgres") {
    const rows = db.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'multiremi_turn_attempts' AND column_name IN ('context_usage', 'worked_ms', 'process_item_count')`).all() as Array<{ column_name: string; data_type: string }>;
    return Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]));
  }
  const rows = db.query("PRAGMA table_info(multiremi_turn_attempts)").all() as Array<{ name: string; type: string }>;
  return Object.fromEntries(rows.filter((row) => COLUMNS.includes(row.name)).map((row) => [row.name, row.type.toLowerCase()]));
}

function migrationRows(db: SqlDatabase): number {
  return Number((db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_schema_migrations WHERE id = ?").get(MIGRATION) as { n: number }).n);
}

const SUMMARY: Pick<DaemonTaskCompletionFields, "context_usage" | "worked_ms" | "process_item_count"> = {
  context_usage: { used: 64_000, size: 200_000 }, worked_ms: Number.MAX_SAFE_INTEGER, process_item_count: 7,
};

for (const backend of backends) {
  describe.skipIf(!backend.available)(`turn attempt trace summary migration (${backend.name})`, () => {
    it("ships the columns in a fresh schema and records the migration once", async () => {
      const opened = await backend.open();
      try {
        // Postgres reports `bigint` / `text`; SQLite keeps the declared types.
        expect(columnTypes(opened.db)).toEqual({ context_usage: "text", worked_ms: "bigint", process_item_count: "bigint" });
        expect(migrationRows(opened.db)).toBe(1);
        new MultiremiStore(opened.db);
        expect(migrationRows(opened.db)).toBe(1);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("adds the columns to an upgraded database without touching older attempts", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Summary daemon", provider: "claude", workspaceId: "local" });
        const agent = store.createAgent({ name: "Summary agent", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
        const issue = createResponsibleTestIssue(store, { title: "Before PR 2", workspaceId: "local" });
        const old = store.createTask({ agentId: agent.id, workspaceId: "local", issueId: issue.id, prompt: "old" });
        // The database as a pre-PR 2 release left it: no columns, no migration row.
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
        expect(reopened.listTurnAttempts(turnId).find((row) => row.id === old.id))
          .toMatchObject({ context_usage: null, worked_ms: null, process_item_count: null });
        expect(reopened.findTurnEntry(old.id)!.metadata).toMatchObject({ context_usage: null, worked_ms: null, process_item_count: null });

        // A completion report after the upgrade writes and projects the summary.
        const fields: DaemonTaskCompletionFields = {
          trace: { head: 3, event_count: 3, closed: true, tool_call_count: 1, type_histogram: [{ type: "command", tool: "Bash", count: 1 }] },
          final_reply_md: "done", model: null, ...SUMMARY,
        };
        expect(db.transaction(() => reopened.recordTurnCardCompletionFieldsWithinTransaction(old.id, fields))()).toBe(true);
        expect(reopened.findTurnEntry(old.id)!.metadata).toMatchObject(SUMMARY);
        expect(reopened.listTurnAttempts(turnId).find((row) => row.id === old.id)).toMatchObject(SUMMARY);
      } finally { await opened.close(); }
    }, TIMEOUT);
  });
}
