import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import type { MultiremiStore } from "@multiremi/store.js";

/** Actual request consumption and context evidence must stay distinct on hot routes. */
export function seedFirstScreenTaskUsage(store: MultiremiStore, taskId: string): void {
  const request: TaskUsageUnit = {
    unitId: "request", revision: 1, provider: "claude", model: "opus",
    modelSource: "provider_reported", scope: "request", source: "provider_request", accuracy: "exact",
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
    actualUnsplitTokens: 5, reportedTotalTokens: 24, contextTokens: null, contextWindow: null,
    costAmount: null, costCurrency: null, occurredAt: "2026-10-01T03:00:00.000Z",
  };
  store.reportTaskUsageSnapshot(taskId, {
    version: 2, runId: "first-screen-usage", revision: 1, complete: true,
    units: [request, { ...request, unitId: "context", scope: "turn", source: "context_snapshot", accuracy: "unknown",
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualUnsplitTokens: null, reportedTotalTokens: null, contextTokens: 70_000 }],
  });
}

export const firstScreenTaskUsage = [{ provider: "claude", model: "opus",
  inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 24 }];
