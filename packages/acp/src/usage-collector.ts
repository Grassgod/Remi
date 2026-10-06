import { randomUUID } from "node:crypto";
import type { PromptResult } from "@shared/contracts/acp-protocol.js";
import type { TaskUsageUnit } from "@shared/contracts/usage-accounting.js";

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function actualUnit(input: {
  unitId: string; provider: string; model?: string | null; requestedModel?: string | null;
  scope: TaskUsageUnit["scope"]; source: TaskUsageUnit["source"]; accuracy?: TaskUsageUnit["accuracy"];
  modelSource?: TaskUsageUnit["modelSource"];
  inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown;
  totalTokens?: unknown; costAmount?: unknown; costCurrency?: string | null; evidenceRef?: string;
  costSource?: TaskUsageUnit["costSource"];
  allowActualTotal?: boolean;
}): TaskUsageUnit {
  let inputTokens = tokenCount(input.inputTokens);
  let outputTokens = tokenCount(input.outputTokens);
  let cacheReadTokens = tokenCount(input.cacheReadTokens);
  let cacheWriteTokens = tokenCount(input.cacheWriteTokens);
  const reportedTotalTokens = tokenCount(input.totalTokens);
  const splitTotal = (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const ambiguousTotal = reportedTotalTokens !== null && reportedTotalTokens > splitTotal && !input.allowActualTotal;
  const unsplit = reportedTotalTokens == null || ambiguousTotal ? null : Math.max(0, reportedTotalTokens - splitTotal);
  if (ambiguousTotal && splitTotal === 0) inputTokens = outputTokens = cacheReadTokens = cacheWriteTokens = null;
  const costAmount = tokenCount(input.costAmount);
  return {
    unitId: input.unitId, revision: 1, provider: input.provider, model: input.model || null,
    requestedModel: input.requestedModel ?? null, scope: input.scope, source: input.source,
    modelSource: input.modelSource ?? (input.model ? "provider_reported" : input.requestedModel ? "configured" : "unknown"),
    accuracy: ambiguousTotal ? "unknown" : unsplit && !splitTotal ? "unknown" : unsplit || (reportedTotalTokens != null && reportedTotalTokens < splitTotal)
      ? "partial" : input.accuracy ?? "exact",
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, actualUnsplitTokens: unsplit,
    reportedTotalTokens, contextTokens: null, contextWindow: null,
    costAmount: costAmount != null && input.costCurrency ? costAmount : null,
    costCurrency: costAmount != null ? input.costCurrency ?? null : null,
    costSource: input.costSource ?? "unknown",
    occurredAt: new Date().toISOString(), evidenceRef: input.evidenceRef ?? null,
  };
}

export function unitActualTotal(unit: TaskUsageUnit): number {
  return (unit.inputTokens ?? 0) + (unit.outputTokens ?? 0) + (unit.cacheReadTokens ?? 0)
    + (unit.cacheWriteTokens ?? 0) + (unit.actualUnsplitTokens ?? 0);
}

/** Upstream request snapshots replace earlier revisions; context is diagnostic. */
export class UsageCollector {
  readonly promptId = randomUUID();
  private observed = new Map<string, TaskUsageUnit>();
  private changed = new Set<string>();
  private monetaryTurns = new Set<string>();

  update(raw: unknown, requestedModel?: string | null, modelSource?: TaskUsageUnit["modelSource"]): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    const snapshot = value.scope === "request_snapshot";
    const stableId = typeof value.id === "string" ? value.id : `${this.promptId}:legacy:${this.observed.size}`;
    const entry = actualUnit({
      unitId: `request:${stableId}`, provider: "", model: typeof value.model === "string" ? value.model : null,
      requestedModel: typeof value.requestedModel === "string" ? value.requestedModel : requestedModel,
      modelSource: value.model ? "provider_reported" : value.modelSource === "session_acknowledged" ? "session_acknowledged" : modelSource,
      scope: "request", source: "provider_request",
      accuracy: typeof value.id !== "string" || value.accuracy === "partial" ? "partial" : "exact",
      inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheReadTokens: value.cachedInputTokens,
      cacheWriteTokens: value.cacheWriteTokens ?? 0, totalTokens: value.totalTokens,
      evidenceRef: typeof value.source === "string" ? value.source : "acp_request_usage",
    });
    const previous = this.observed.get(entry.unitId);
    if (previous) {
      if (!snapshot) return;
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "actualUnsplitTokens", "reportedTotalTokens"] as const) {
        if (previous[key] != null) entry[key] = Math.max(previous[key]!, entry[key] ?? 0);
      }
      if (!entry.model) entry.model = previous.model;
      if (!entry.requestedModel) entry.requestedModel = previous.requestedModel;
      if (entry.actualUnsplitTokens !== null) entry.actualUnsplitTokens = entry.reportedTotalTokens == null ? null : Math.max(0, entry.reportedTotalTokens
        - (entry.inputTokens ?? 0) - (entry.outputTokens ?? 0) - (entry.cacheReadTokens ?? 0) - (entry.cacheWriteTokens ?? 0));
      if (previous.accuracy === "exact" && entry.accuracy === "partial") entry.accuracy = "exact";
      entry.occurredAt = previous.occurredAt;
      entry.revision = previous.revision;
      if (JSON.stringify(entry) === JSON.stringify(previous)) return;
      entry.revision++;
    }
    this.observed.set(entry.unitId, entry);
    this.changed.add(entry.unitId);
  }

  context(used: unknown, size: unknown): void {
    const contextTokens = tokenCount(used);
    const contextWindow = tokenCount(size);
    if (contextTokens == null || contextWindow == null || contextWindow <= 0) return;
    const unitId = `context:${this.promptId}`;
    const previous = this.observed.get(unitId);
    if (previous && previous.contextTokens! >= contextTokens && previous.contextWindow === contextWindow) return;
    const entry = actualUnit({ unitId, provider: "", scope: "turn", source: "context_snapshot", accuracy: "unknown" });
    entry.contextTokens = Math.max(previous?.contextTokens ?? 0, contextTokens);
    entry.contextWindow = contextWindow;
    entry.occurredAt = previous?.occurredAt ?? entry.occurredAt;
    entry.revision = (previous?.revision ?? 0) + 1;
    this.observed.set(unitId, entry);
    this.changed.add(unitId);
  }

  private refreshMonetaryCoverage(units?: TaskUsageUnit[]): void {
    if (!this.monetaryTurns.size) return;
    const tokenIds = (units ?? [...this.observed.values()]).filter(unit => unit.source !== "context_snapshot" && unit.costAmount === null
      && [unit.inputTokens, unit.outputTokens, unit.cacheReadTokens, unit.cacheWriteTokens, unit.actualUnsplitTokens].some(value => value !== null))
        .map(unit => unit.unitId).sort();
    for (const unitId of this.monetaryTurns) {
      const unit = this.observed.get(unitId)!;
      const coveredUnitIds = tokenIds;
      if (JSON.stringify(unit.coveredUnitIds ?? []) === JSON.stringify(coveredUnitIds)) continue;
      this.observed.set(unitId, { ...unit, coveredUnitIds, revision: unit.revision + 1 });
      this.changed.add(unitId);
    }
  }

  cost(amount: unknown, currency: unknown, scope: TaskUsageUnit["scope"], source: TaskUsageUnit["costSource"], requestId?: string): void {
    const value = tokenCount(amount);
    if (value === null || typeof currency !== "string" || !currency) return;
    const unitId = `cost:${requestId ?? this.promptId}:${scope}:${source}:${currency}`;
    const previous = this.observed.get(unitId);
    if (previous?.costAmount === value) return;
    const entry = actualUnit({ unitId, provider: "", scope, source: scope === "request" ? "provider_request" : "provider_turn",
      accuracy: source === "provider_reported" ? "exact" : "unknown", costAmount: value, costCurrency: currency,
      costSource: source, evidenceRef: source === "sdk_estimate" ? "claude_sdk_prompt_cost_estimate" : "acp_monetary_evidence" });
    entry.occurredAt = previous?.occurredAt ?? entry.occurredAt;
    entry.revision = (previous?.revision ?? 0) + 1;
    if (source === "provider_reported" && scope === "request" && requestId) entry.coveredUnitIds = [`request:${requestId}`];
    this.observed.set(unitId, entry);
    this.changed.add(unitId);
    if (source === "provider_reported" && scope === "turn") {
      this.monetaryTurns.add(unitId);
      this.refreshMonetaryCoverage();
    }
  }

  uncertainTotal(value: unknown): void {
    const total = tokenCount(value);
    if (total === null) return;
    const unitId = `uncertain-total:${this.promptId}`;
    const previous = this.observed.get(unitId);
    if (previous && previous.reportedTotalTokens! >= total) return;
    const entry = actualUnit({ unitId, provider: "", scope: "turn", source: "context_snapshot", totalTokens: total,
      accuracy: "unknown", evidenceRef: "codex_ambiguous_compaction_total" });
    entry.revision = (previous?.revision ?? 0) + 1;
    entry.occurredAt = previous?.occurredAt ?? entry.occurredAt;
    this.observed.set(unitId, entry);
    this.changed.add(unitId);
  }

  takeChangedUnits(provider: string, requestedModel?: string | null): TaskUsageUnit[] {
    const units = [...this.changed].map(id => {
      const unit = this.observed.get(id)!;
      return { ...unit, provider };
    });
    this.changed.clear();
    return units;
  }

  units(provider: string, requestedModel?: string | null, settle?: PromptResult["usage"], scope?: "turn" | "last-request", modelSource?: TaskUsageUnit["modelSource"]): TaskUsageUnit[] {
    const units: TaskUsageUnit[] = [...this.observed.values()].map(unit => ({ ...unit, provider }));
    const settled = actualUnit({
      unitId: `settle:${this.promptId}`, provider, requestedModel, scope: "turn", source: "provider_turn",
      modelSource,
      accuracy: scope === "last-request" ? "partial" : "exact",
      inputTokens: settle?.inputTokens, outputTokens: settle?.outputTokens,
      cacheReadTokens: settle?.cachedReadTokens, cacheWriteTokens: settle?.cachedWriteTokens,
      totalTokens: settle?.totalTokens, evidenceRef: "acp_prompt_settle",
    });
    const actual = units.filter(unit => unit.source !== "context_snapshot" && (unit.reportedTotalTokens !== null || unitActualTotal(unit) > 0));
    if (!actual.length && settle != null) units.push(settled);
    else if (scope === "turn" && unitActualTotal(settled) > actual.reduce((sum, unit) => sum + unitActualTotal(unit), 0)) {
      const remainder = unitActualTotal(settled) - actual.reduce((sum, unit) => sum + unitActualTotal(unit), 0);
      units.push({ ...settled, inputTokens: null, outputTokens: null, cacheReadTokens: null,
        cacheWriteTokens: null, actualUnsplitTokens: remainder, accuracy: "unknown",
        evidenceRef: "acp_prompt_unattributed_remainder" });
    }
    // Link final turn coverage once at settlement; emitting a growing list on
    // every request would turn durable reporting into quadratic traffic.
    this.refreshMonetaryCoverage(units);
    return units.map(unit => this.monetaryTurns.has(unit.unitId) ? { ...this.observed.get(unit.unitId)!, provider } : unit);
  }
}
