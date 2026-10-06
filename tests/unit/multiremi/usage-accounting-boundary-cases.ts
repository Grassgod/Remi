import { expect } from "bun:test";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export function assertUsageIdentityBoundaries(store: MultiremiStore, db: SqlDatabase, taskId: string, otherTaskId: string, runtimeId: string, namespace: string, reload: () => MultiremiStore): void {
  const base: TaskUsageUnit = { unitId: "request", revision: 1, provider: "claude", model: namespace, modelSource: "provider_reported",
    scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 10, outputTokens: 2,
    cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12,
    contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T00:00:00Z" };
  const write = (task: string, runId: string, units: TaskUsageUnit[], revision = 1) => store.reportTaskUsageSnapshot(task, { version: 2, runId, revision, complete: true, units });
  const total = () => store.getUsageReport({ workspaceId: "local", runtimeId, days: null }).summary;
  const strong = { ...base, providerSessionId: `${namespace}-session`, providerRequestId: "message" };
  write(taskId, "owner", [strong]);
  write(otherTaskId, "duplicate", [base]);
  expect(total().actual_total_tokens).toBe(24);
  write(otherTaskId, "duplicate", [{ ...strong, revision: 2 }], 2);
  expect(total().actual_total_tokens).toBe(12);
  store = reload();
  write(otherTaskId, "duplicate", [base]);
  write(otherTaskId, "duplicate", [{ ...strong, revision: 2 }], 2);
  expect(total().actual_total_tokens).toBe(12);
  expect(() => write(otherTaskId, "duplicate", [{ ...strong, revision: 2, inputTokens: 11 }], 2)).toThrow("same revision");
  expect(db.query("SELECT revision,disposition FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id='duplicate'").get(otherTaskId)).toEqual({ revision: 2, disposition: "parked" });
  // Simulate upgrading a DB whose previous version had only conflict audit.
  db.run("DELETE FROM multiremi_usage_unit_receipts WHERE task_id=? AND run_id='duplicate'", [otherTaskId]);
  write(otherTaskId, "duplicate", [base]);
  expect(total().actual_total_tokens).toBe(12);

  const vector = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: n });
  const meter = (id: string, before: number, after: number, revision = 1): TaskUsageUnit => ({ ...base, unitId: id, revision,
    provider: "codex", inputTokens: after - before, outputTokens: 0, reportedTotalTokens: after - before,
    providerSessionId: `${namespace}-meter`, providerObservationId: `${id}-${after}`, identityKind: "cumulative_meter",
    meterEvidence: { epochId: "initial", before: vector(before), after: vector(after) } });
  write(taskId, "meter", [meter("first", 0, 100), meter("next", 100, 200)]);
  write(taskId, "meter", [meter("first", 0, 150, 2)], 2);
  expect(total().actual_total_tokens).toBe(212);
  store = reload();
  write(taskId, "meter", [meter("first", 0, 100)]);
  write(taskId, "meter", [meter("first", 0, 150, 2)], 2);
  expect(total().actual_total_tokens).toBe(212);
  expect(db.query("SELECT revision,input_tokens FROM multiremi_usage_units WHERE task_id=? AND run_id='meter' AND unit_id='first'").get(taskId)).toEqual(db.dialect === "postgres" ? { revision: 1, input_tokens: "100" } : { revision: 1, input_tokens: 100 });

  const money = { ...strong, unitId: "charge", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown" as const, costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported" as const, coveredUnitIds: [strong.unitId] };
  write(taskId, "owner", [money]);
  write(taskId, "owner", [{ ...strong, revision: 2, costAmount: 0.5, costCurrency: "USD", costSource: "provider_reported" }], 2);
  expect(total()).toMatchObject({ actual_total_tokens: 212, known_cost_by_currency: { USD: 0.25 }, complete: false });
  store = reload();
  write(taskId, "owner", [strong]);
  expect(total().actual_total_tokens).toBe(212);
}

export function assertRequestChargeIdentity(store: MultiremiStore, taskId: string, runtimeId: string, namespace: string, order: "money-first" | "tokens-first" | "identity-later", reload: () => MultiremiStore): void {
  const a: TaskUsageUnit = { unitId: "a", revision: 1, provider: "claude", model: namespace, modelSource: "provider_reported",
    providerSessionId: `${namespace}-session`, providerRequestId: "a", scope: "request", source: "provider_request", accuracy: "exact",
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 1_000_000,
    contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T00:00:00Z" };
  const b = { ...a, unitId: "b", providerRequestId: "b" };
  const money: TaskUsageUnit = { ...a, unitId: "money", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    actualUnsplitTokens: null, reportedTotalTokens: null, accuracy: "unknown", costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported", coveredUnitIds: [b.unitId] };
  store.setUsagePrice("local", { provider: "claude", model: namespace, connection_id: null, requested_model_alias: false, currency: "USD",
    input_per_million: 2, output_per_million: 0, cache_read_per_million: 0, cache_write_per_million: 0, unsplit_per_million: null,
    source: "configured", source_url: null, effective_from: "2026-09-01T00:00:00Z", effective_to: null });
  const write = (units: TaskUsageUnit[], revision = 1) => store.reportTaskUsageSnapshot(taskId, { version: 2, runId: "pricing", revision, complete: true, units });
  if (order === "money-first") { write([money]); write([a, b]); }
  else if (order === "tokens-first") { write([a, b]); write([money]); }
  else {
    write([a, { ...b, providerSessionId: undefined, providerRequestId: undefined }, money]);
    expect(store.getUsageReport({ workspaceId: "local", runtimeId, days: null }).summary.known_cost_by_currency).toEqual({ USD: 2.25 });
    write([{ ...b, revision: 2 }], 2);
  }
  store = reload();
  write([money]);
  const report = () => store.getUsageReport({ workspaceId: "local", runtimeId, days: null });
  expect(report().summary).toMatchObject({ actual_total_tokens: 2_000_000, known_cost_by_currency: { USD: 2 }, priced_tokens: 1_000_000, unpriced_tokens: 1_000_000, complete: false });
  // Contradictory session evidence is equally invalid, even if request ID agrees.
  write([{ ...money, revision: 2, providerSessionId: `${namespace}-different-session`, providerRequestId: "b" }], 2);
  expect(report().summary).toMatchObject({ known_cost_by_currency: { USD: 2 }, complete: false });
  // The same strong request can cover its own token unit without double counting.
  write([{ ...money, revision: 3, coveredUnitIds: [a.unitId] }], 3);
  store = reload();
  write([{ ...money, revision: 3, coveredUnitIds: [a.unitId] }], 3);
  expect(report().summary).toMatchObject({ known_cost_by_currency: { USD: 2.25 }, priced_tokens: 2_000_000, unpriced_tokens: 0, complete: true });
}
