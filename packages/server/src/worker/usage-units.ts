// Provider response -> usage entries and units. Billing only: these feed the
// task usage ledger and never the trace (PR 2 moved them out of the retired ACP
// event mapper).
import type { TaskUsageEntry } from "@multiremi/contracts/types.js";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { actualUnit, unitActualTotal } from "@acp/usage-collector.js";

export function responseToUsage(provider: string, response: any, fallbackModel?: string | null): TaskUsageEntry[] {
  if (!response) return [];
  const collected = response.metadata?.usageUnits;
  if (Array.isArray(collected)) {
    return collected.filter((unit: TaskUsageUnit) => unit.source !== "context_snapshot" && unitActualTotal(unit) > 0)
      .map((unit: TaskUsageUnit) => ({ provider, model: unit.model ?? "", inputTokens: unit.inputTokens ?? 0,
        outputTokens: unit.outputTokens ?? 0, cacheReadTokens: unit.cacheReadTokens ?? 0,
        cacheWriteTokens: unit.cacheWriteTokens ?? 0, totalTokens: unitActualTotal(unit) }));
  }
  const inputTokens = Number(response.inputTokens ?? 0);
  const outputTokens = Number(response.outputTokens ?? 0);
  const cacheReadTokens = Number(response.cacheReadInputTokens ?? 0);
  const cacheWriteTokens = Number(response.cacheCreateInputTokens ?? 0);
  const totalTokens = Number(response.totalTokens ?? 0);
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens].every(value => Number.isFinite(value) && value >= 0)
    || (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !totalTokens)) return [];
  return [{
    provider,
    model: String(response.model ?? fallbackModel ?? ""),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  }];
}

/** Explicit units are authoritative, including an empty or context-only list. */
export function responseToUsageUnits(provider: string, response: any, requestedModel: string | null | undefined, unitId: string): TaskUsageUnit[] {
  if (!response) return [];
  if (Array.isArray(response.metadata?.usageUnits)) {
    return response.metadata.usageUnits.map((unit: TaskUsageUnit) => ({ ...unit, provider, requestedModel: unit.requestedModel ?? requestedModel ?? null,
      modelSource: unit.modelSource ?? (unit.model ? "provider_reported" : requestedModel ? "configured" : "unknown"),
    }));
  }
  return [actualUnit({
    unitId, provider, model: response.metadata?.actualModel ?? null, requestedModel,
    scope: "turn", source: "provider_turn", accuracy: "partial",
    inputTokens: response.inputTokens, outputTokens: response.outputTokens,
    cacheReadTokens: response.cacheReadInputTokens, cacheWriteTokens: response.cacheCreateInputTokens,
    totalTokens: response.totalTokens, costAmount: response.costUsd, costCurrency: response.costUsd != null ? "USD" : null,
    evidenceRef: "provider_response",
  })];
}
