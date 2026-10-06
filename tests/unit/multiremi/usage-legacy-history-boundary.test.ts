import { afterEach, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { assertLegacyHistoryBoundary, assertNonconsumingHistoryBoundary, assertRecordedV2RetryChain } from "./usage-legacy-history-boundaries.js";
afterEach(resetMultiremiTestEnv);
it("rejects overlapping late legacy ingestion and stops source refresh durably on SQLite", () => {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "late old writer", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "late legacy boundary" });
  assertLegacyHistoryBoundary(store, db!, task.id);
});
it("protects ordinary v2 consumption from overlapping deprecated aggregates and ready-startup rollback", () => {
  const store = createLocalStore(), agent = store.createAgent({ name: "ordinary v2", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "ordinary native facts" });
  assertLegacyHistoryBoundary(store, db!, task.id, "ordinary-v2-run");
});
it.each([false, true])("keeps the actual Store retry chain complete across startup (startup while queued=%s)", async startupWhileQueued => {
  await assertRecordedV2RetryChain(createLocalStore(), db!, startupWhileQueued);
});
it.each(["empty_modern", "empty_history", "context_history"] as const)("normalizes proven legacy consumption beside %s without guessing consumption from its run shell", kind => {
  const store = createLocalStore(), agent = store.createAgent({ name: kind, provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "nonconsuming history" });
  assertNonconsumingHistoryBoundary(store, db!, task.id, kind);
});
