import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { writeUsageSnapshot } from "@multiremi/store/usage-accounting.js";
import { actualUnit, requestUnitId } from "@acp/usage-collector.js";
import { assertUsageReconciliationSchema, applyModernUsageRepairs, buildModernUsageRepairs, readModernRepairState, verifyModernUsageRepairs } from "../../../scripts/modern-usage-repair.js";
import { unifiedModelBackendTests } from "../multiremi/unified-model-test-backends.js";

unifiedModelBackendTests("modern repair schema support after real historical migration", fixture => {
  it("rejects unmigrated schemas and repairs a terminal run after the current startup migrates them", () => {
    const { db, store: historical } = fixture();
    const agent = historical.createAgent({ name: "Historical repair", provider: "claude" });
    const task = historical.createTask({ agentId: agent.id, prompt: "Historical execution", status: "completed" });
    db.run("UPDATE multiremi_tasks SET provider='claude',session_id='migrated-session',started_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T02:00:00Z',usage='[]' WHERE id=?", [task.id]);
    expect(() => assertUsageReconciliationSchema(db)).toThrow("Unsupported usage reconciliation schema");
    const current = new MultiremiStore(db);
    current.ensureUsageAccountingStartup();
    expect(() => assertUsageReconciliationSchema(db)).not.toThrow();
    const early = { ...actualUnit({ unitId: requestUnitId("response", "migrated-session"), provider: "claude", providerSessionId: "migrated-session", providerRequestId: "response", scope: "request", source: "provider_request", inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 }), occurredAt: "2026-10-01T01:00:00.000Z" };
    writeUsageSnapshot(db, task.id, { version: 2, runId: "original-run", revision: 1, complete: true, units: [early] }, { historical: true });
    const repairs = buildModernUsageRepairs(readModernRepairState(db, task.id), [{ ...early, outputTokens: 11, reportedTotalTokens: 41, accuracy: "exact", actualUnsplitTokens: 0 }], []);
    expect(repairs).toHaveLength(1);
    expect(applyModernUsageRepairs(db, repairs, "migrated-schema")).toEqual({ applied: 1, resumed: 0 });
    expect(verifyModernUsageRepairs(db, repairs, "migrated-schema")).toBe(1);
    expect(current.getUsageReport({ workspaceId: "local", days: null }).summary.actual_total_tokens).toBe(41);
  }, 30_000);
});
