import type { TaskUsageEntry } from "@multiremi/contracts/types.js";
import type { TaskUsageSnapshot } from "@multiremi/contracts/usage-accounting.js";

/** Seed already-normalized historical facts without the retired ingestion path. */
export function taskUsageSnapshot(entries: Array<TaskUsageEntry & { modelSource?: string }>, revision = 1, occurredAt = new Date().toISOString()): TaskUsageSnapshot {
  return { version: 2, runId: "legacy", revision, complete: false, units: entries.map((entry, index) => {
    const split = [entry.inputTokens, entry.outputTokens, entry.cacheReadTokens ?? 0, entry.cacheWriteTokens ?? 0];
    const hasSplit = split.some(value => value > 0);
    return { unitId: `fixture:${index}`, revision, provider: entry.provider ?? "unknown",
      model: entry.modelSource === "upstream" ? entry.model : null, requestedModel: entry.model,
      modelSource: entry.modelSource === "upstream" ? "provider_reported" : "configured",
      scope: "task", source: "legacy_task", accuracy: hasSplit ? "partial" : "unknown", timeProvenance: "task_attributed",
      inputTokens: hasSplit ? split[0]! : null, outputTokens: hasSplit ? split[1]! : null,
      cacheReadTokens: hasSplit ? split[2]! : null, cacheWriteTokens: hasSplit ? split[3]! : null,
      actualUnsplitTokens: null, reportedTotalTokens: entry.totalTokens ?? split.reduce((total, value) => total + value, 0),
      contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt };
  }) };
}
