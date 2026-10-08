import { expect } from "bun:test";
import type { TaskUsageUnit, UsageReport } from "@multiremi/contracts/usage-accounting.js";
import type { MultiremiStore } from "@multiremi/store.js";

export function assertDefaultDetailPage(store: MultiremiStore, prefix: string): void {
  const runtime = store.registerRuntime({ name: prefix, provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: prefix, provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: "Bounded default page fixture", workspaceId: "local" });
  store.claimTask(runtime.id); store.startTask(task.id);
  const units: TaskUsageUnit[] = Array.from({ length: 400 }, (_, index) => ({ unitId: `request-${index}`, revision: 1, provider: "claude", model: `model-${index % 20}`, modelSource: "provider_reported",
    scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 1,
    contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: `2026-10-${String(Math.floor(index / 20) + 1).padStart(2, "0")}T12:00:00.000Z` }));
  store.reportTaskUsageSnapshot(task.id, { version: 2, runId: prefix, revision: 1, complete: true, units });
  const input = { workspaceId: "local", runtimeId: runtime.id, days: null, include: "day_model" as const, tz: "UTC" };
  const first = store.getUsageReport(input), second = store.getUsageReport({ ...input, detailCursor: first.day_model!.next_cursor });
  expect(first.summary.actual_total_tokens).toBe(400);
  expect(first.by_model).toHaveLength(20);
  expect(first.day_model!.rows).toHaveLength(200);
  expect(second.day_model!.rows).toHaveLength(200);
  expect(second.day_model!.next_cursor).toBeNull();
  expect([...first.day_model!.rows, ...second.day_model!.rows].reduce((sum, row) => sum + row.actual_total_tokens, 0)).toBe(400);
  expect(store.getUsageReport({ ...input, detailLimit: 500 }).day_model!.rows).toHaveLength(400);
}

export function assertDayModelPagination(store: MultiremiStore, prefix: string): void {
  const runtime = store.registerRuntime({ name: prefix, provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: prefix, provider: "claude", workspaceId: "local", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: "Joint aggregation fixture", workspaceId: "local" });
  store.claimTask(runtime.id); store.startTask(task.id);
  const unit = (overrides: Partial<TaskUsageUnit> = {}): TaskUsageUnit => ({ unitId: "a", revision: 1, provider: "claude", model: "reported-a", modelSource: "provider_reported",
    scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
    actualUnsplitTokens: 0, reportedTotalTokens: 12, contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: "2026-10-01T15:59:00.000Z", ...overrides });
  const units = [unit({ costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported" }),
    unit({ unitId: "b", model: null, requestedModel: "gateway-b", modelSource: "session_acknowledged", inputTokens: 0, outputTokens: 0, actualUnsplitTokens: 20, reportedTotalTokens: 20, occurredAt: "2026-10-01T16:01:00.000Z" }),
    unit({ unitId: "c", model: "reported-a", purpose: "progress_summary", costAmount: 0, costCurrency: "CNY", costSource: "provider_reported", occurredAt: "2026-10-01T16:01:00.000Z" }),
    ...[null, "", "模型😀", "模型é", "a|b"].map((connectionId, index) => unit({ unitId: `route-${index}`, connectionId, model: "same", occurredAt: "2026-10-03T00:00:00.000Z" })),
    unit({ unitId: "context", model: null, scope: "turn", source: "context_snapshot", accuracy: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null, reportedTotalTokens: null, contextTokens: 78048, occurredAt: "2026-10-04T00:00:00.000Z" })];
  store.reportTaskUsageSnapshot(task.id, { version: 2, runId: prefix, revision: 1, complete: true, units: units.filter(unit => unit.unitId !== "context") });
  store.reportTaskUsageSnapshot(task.id, { version: 2, runId: `${prefix}-unobserved`, revision: 1, complete: true, units: units.filter(unit => unit.unitId === "context") });
  const input = { workspaceId: "local", runtimeId: runtime.id, days: null, tz: "Asia/Shanghai", since: "2026-10-01T00:00:00.000Z", until: "2026-10-05T00:00:00.000Z" };
  const plain = store.getUsageReport(input);
  expect(plain.day_model).toBeUndefined();
  const page = store.getUsageReport({ ...input, include: "day_model", detailLimit: 2 });
  expect(page.summary).toEqual(plain.summary);
  expect(page.day_model!.rows).toHaveLength(2);
  expect(page.day_model!.next_cursor).not.toBeNull();
  expect(store.getUsageReport({ ...input, include: "day_model", detailLimit: 2 })).toEqual(expect.objectContaining({ day_model: page.day_model }));
  const rows: NonNullable<UsageReport["day_model"]>["rows"] = [];
  let cursor: string | null = null;
  do {
    const next: NonNullable<UsageReport["day_model"]> = store.getUsageReport({ ...input, include: "day_model", detailLimit: 2, detailCursor: cursor }).day_model!;
    expect(next.rows.length).toBeLessThanOrEqual(2);
    rows.push(...next.rows); cursor = next.next_cursor;
  } while (cursor !== null);
  expect(rows).toHaveLength(9);
  expect(new Set(rows.map(row => JSON.stringify([row.date, row.provider, row.model, row.requested_model, row.model_provenance, row.purpose, row.connection_id]))).size).toBe(9);
  expect(rows.reduce((sum, row) => sum + row.actual_total_tokens, 0)).toBe(plain.summary.actual_total_tokens);
  for (const bucket of ["known_cost_by_currency", "reference_cost_by_currency", "sdk_estimate_cost_by_currency"] as const) {
    const currencies = new Set(rows.flatMap(row => Object.keys(row[bucket] ?? {})));
    for (const currency of currencies) expect(rows.reduce((sum, row) => sum + (row[bucket]?.[currency] ?? 0), 0)).toBeCloseTo(plain.summary[bucket]?.[currency] ?? 0, 12);
  }
  expect(rows.find(row => row.model === "reported-a" && row.purpose === "agent")).toMatchObject({ date: "2026-10-01", known_cost_by_currency: { USD: 0.25 } });
  expect(rows.find(row => row.requested_model === "gateway-b")).toMatchObject({ date: "2026-10-02", model_source: "requested", actual_unsplit_tokens: 20 });
  expect(rows.find(row => row.context_peak_tokens === 78048)).toMatchObject({ actual_total_tokens: 0, unknown_task_count: 1, complete: false, known_cost_by_currency: {} });
  for (const row of rows) { expect(row).not.toHaveProperty("total_seconds"); expect(row).not.toHaveProperty("status_counts"); }
  const exact = store.getUsageReport({ ...input, include: "day_model", detailLimit: 9 }).day_model!;
  expect(exact.next_cursor).toBeNull();
  expect(exact.rows).toEqual(rows);
  const cursorValue = page.day_model!.next_cursor!;
  for (const overrides of [{ workspaceId: "other" }, { runtimeId: null }, { projectId: "different" }, { tz: "UTC" }, { since: "2026-10-02T00:00:00Z" }, { until: "2026-10-06T00:00:00Z" }])
    expect(() => store.getUsageReport({ ...input, ...overrides, include: "day_model", detailCursor: cursorValue })).toThrow("scope or price revision");
  expect(() => store.getUsageReport({ ...input, include: "day_model", detailCursor: `${cursorValue}x` })).toThrow("cursor");
  for (const detailLimit of [0, -1, 1.5, 501, NaN]) expect(() => store.getUsageReport({ ...input, include: "day_model", detailLimit })).toThrow("detail_limit");
  expect(() => store.getUsageReport({ ...input, detailLimit: 2 })).toThrow("require include");
  store.setUsagePrice("local", { provider: "claude", model: "reported-a", connection_id: null, requested_model_alias: false, currency: "USD",
    input_per_million: 2, output_per_million: 10, cache_read_per_million: 0, cache_write_per_million: 0, unsplit_per_million: null, source: "configured", source_url: null, effective_from: "2026-09-01T00:00:00Z", effective_to: null });
  expect(() => store.getUsageReport({ ...input, include: "day_model", detailCursor: cursorValue })).toThrow("scope or price revision");
}
