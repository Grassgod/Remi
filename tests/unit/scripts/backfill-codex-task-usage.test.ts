import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applyCodexUsageBackfill,
  buildCodexUsageBackfillPlan,
  summarizeCodexUsageBackfill,
} from "../../../scripts/backfill-codex-task-usage.js";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE multiremi_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE multiremi_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL,
      usage TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE multiremi_task_messages (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      meta TEXT
    );
  `);
  db.run("INSERT INTO multiremi_agents (id, name) VALUES (?, ?), (?, ?)", ["agt_worker", "Worker", "agt_qa", "QA"]);
});

describe("Codex task usage backfill", () => {
  it("rebuilds one total-only codex row while preserving other provider rows", () => {
    insertTask("tsk_1", "agt_worker", "completed", [
      usage("claude", "opus", 10, 5, 20, 2, 37),
      usage("codex", "gpt-5.6-sol", 900, 210, 4000, 0, 5110),
    ]);
    insertUsage("tsk_1", 1, 100);
    insertUsage("tsk_1", 2, 240);

    const plan = buildCodexUsageBackfillPlan(db as never);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({
      taskId: "tsk_1",
      eventCount: 2,
      beforeTotalTokens: 5110,
      afterTotalTokens: 340,
      usage: [
        usage("claude", "opus", 10, 5, 20, 2, 37),
        usage("codex", "gpt-5.6-sol", 0, 0, 0, 0, 340),
      ],
    });
    expect(summarizeCodexUsageBackfill(plan, "dry-run")).toMatchObject({
      mode: "dry-run",
      affectedTasks: 1,
      beforeTotalTokens: 5110,
      afterTotalTokens: 340,
      byAgent: [{ agentId: "agt_worker", agentName: "Worker", affectedTasks: 1 }],
    });

    expect(applyCodexUsageBackfill(db as never, plan, "2026-08-29T00:00:00.000Z")).toBe(1);
    const stored = db.query("SELECT usage, updated_at FROM multiremi_tasks WHERE id = 'tsk_1'").get() as {
      usage: string;
      updated_at: string;
    };
    expect(JSON.parse(stored.usage)[1]).toEqual(usage("codex", "gpt-5.6-sol", 0, 0, 0, 0, 340));
    expect(stored.updated_at).toBe("2026-08-29T00:00:00.000Z");
  });

  it("is idempotent and skips unsafe or unrecoverable rows", () => {
    insertTask("tsk_correct", "agt_worker", "completed", [usage("codex", "gpt", 0, 0, 0, 0, 300)]);
    insertUsage("tsk_correct", 1, 100);
    insertUsage("tsk_correct", 2, 200);

    insertTask("tsk_running", "agt_worker", "running", [usage("codex", "gpt", 1, 2, 3, 0, 6)]);
    insertUsage("tsk_running", 1, 100);

    insertTask("tsk_ambiguous", "agt_qa", "completed", [
      usage("codex", "gpt-a", 1, 2, 3, 0, 6),
      usage("codex", "gpt-b", 4, 5, 6, 0, 15),
    ]);
    insertUsage("tsk_ambiguous", 1, 100);

    insertTask("tsk_no_events", "agt_qa", "failed", [usage("codex", "gpt", 1, 2, 3, 0, 6)]);
    insertTask("tsk_no_row", "agt_qa", "cancelled", [usage("claude", "opus", 1, 2, 3, 4, 10)]);
    db.run(
      "INSERT INTO multiremi_tasks (id, agent_id, provider, status, usage, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["tsk_claude", "agt_qa", "claude", "completed", JSON.stringify([usage("claude", "opus", 1, 2, 3, 4, 10)]), "old"],
    );

    const plan = buildCodexUsageBackfillPlan(db as never);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toEqual({
      nonTerminal: 1,
      missingCodexUsage: 1,
      ambiguousCodexModels: 1,
      missingUsageEvents: 1,
      alreadyCorrect: 1,
    });
  });

  it("ignores malformed usage messages instead of inventing totals", () => {
    insertTask("tsk_bad", "agt_worker", "completed", [usage("codex", "gpt", 1, 2, 3, 0, 6)]);
    db.run("INSERT INTO multiremi_task_messages (task_id, seq, type, meta) VALUES (?, ?, 'usage', ?)", ["tsk_bad", 1, "not-json"]);
    db.run("INSERT INTO multiremi_task_messages (task_id, seq, type, meta) VALUES (?, ?, 'usage', ?)", ["tsk_bad", 2, JSON.stringify({ used: -1 })]);

    const plan = buildCodexUsageBackfillPlan(db as never);
    expect(plan.updates).toEqual([]);
    expect(plan.skipped.missingUsageEvents).toBe(1);
  });
});

function insertTask(id: string, agentId: string, status: string, entries: ReturnType<typeof usage>[]): void {
  db.run(
    "INSERT INTO multiremi_tasks (id, agent_id, provider, status, usage, updated_at) VALUES (?, ?, 'codex', ?, ?, ?)",
    [id, agentId, status, JSON.stringify(entries), "old"],
  );
}

function insertUsage(taskId: string, seq: number, used: number): void {
  db.run(
    "INSERT INTO multiremi_task_messages (task_id, seq, type, meta) VALUES (?, ?, 'usage', ?)",
    [taskId, seq, JSON.stringify({ used, size: 200000 })],
  );
}

function usage(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  totalTokens: number,
) {
  return { provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}
