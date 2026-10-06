import { randomUUID } from "node:crypto";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { actualUnit, tokenCount } from "@acp/usage-collector.js";

export type SummaryUsageCallback = (units: TaskUsageUnit[]) => void;
type Payload = Record<string, any>;

/** One identity per actual transport attempt, including fallbacks and failures. */
export function beginSummaryUsage(provider: "claude" | "openai", requestedModel: string, onUsage?: SummaryUsageCallback) {
  const unitId = `progress-summary:${randomUUID()}`;
  const occurredAt = new Date().toISOString();
  const emit = (units: TaskUsageUnit[]) => {
    // Accounting failures must not change the summary result or task outcome.
    try { onUsage?.(units.map(unit => ({ ...unit, purpose: "progress_summary", connectionId: null, occurredAt }))); } catch { /* durable caller logs errors */ }
  };
  const initial = actualUnit({ unitId, provider, requestedModel, scope: "request", source: "provider_request", accuracy: "unknown",
    evidenceRef: "progress_summary_transport_attempt" });
  emit([initial]);
  return (payload: Payload | null, cli = false): void => {
    if (!payload || typeof payload !== "object") return;
    const units: TaskUsageUnit[] = [];
    const modelEntries = cli && payload.modelUsage && typeof payload.modelUsage === "object" ? Object.entries(payload.modelUsage) : [];
    if (modelEntries.length) {
      for (const [model, raw] of modelEntries) {
        if (!raw || typeof raw !== "object") continue;
        const u = raw as Payload;
        const input = tokenCount(u.inputTokens), output = tokenCount(u.outputTokens);
        const read = tokenCount(u.cacheReadInputTokens ?? 0), write = tokenCount(u.cacheCreationInputTokens ?? 0);
        units.push({ ...actualUnit({ unitId: `${unitId}:model:${model}`, provider, model, requestedModel, scope: "turn", source: "provider_turn",
          accuracy: [input, output, read, write].every(value => value !== null) ? "exact" : "partial",
          inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
          totalTokens: input !== null && output !== null ? input + output + (read ?? 0) + (write ?? 0) : null,
          evidenceRef: "claude_cli_result_model_usage" }), revision: 2 });
      }
      // This marker retains attempt identity without creating another copy of
      // the same turn aggregate or suggesting a missing second request.
      units.push({ ...initial, revision: 2, source: "context_snapshot" });
    } else {
      const u: Payload = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
      let input = tokenCount(provider === "openai" ? u.prompt_tokens ?? u.input_tokens : u.input_tokens);
      const output = tokenCount(provider === "openai" ? u.completion_tokens ?? u.output_tokens : u.output_tokens);
      const cached = tokenCount(provider === "openai" ? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0 : u.cache_read_input_tokens ?? 0);
      if (provider === "openai" && input !== null && cached !== null) input = cached <= input ? input - cached : null;
      const write = tokenCount(provider === "claude" ? u.cache_creation_input_tokens ?? 0 : 0);
      const hasUsage = input !== null || output !== null;
      units.push({ ...actualUnit({ unitId, provider, model: typeof payload.model === "string" ? payload.model : null, requestedModel,
        scope: cli ? "turn" : "request", source: cli ? "provider_turn" : "provider_request", accuracy: hasUsage && input !== null && output !== null ? "exact" : "unknown",
        inputTokens: input, outputTokens: output, cacheReadTokens: hasUsage ? cached : null, cacheWriteTokens: hasUsage ? write : null,
        totalTokens: provider === "openai" ? u.total_tokens : hasUsage ? (input ?? 0) + (output ?? 0) + (cached ?? 0) + (write ?? 0) : null,
        evidenceRef: cli ? "claude_cli_result_usage" : `${provider}_progress_summary_response` }), revision: 2 });
    }
    if (cli && tokenCount(payload.total_cost_usd) !== null) units.push({ ...actualUnit({ unitId: `${unitId}:sdk-cost`, provider,
      requestedModel, scope: "turn", source: "provider_turn", accuracy: "unknown", costAmount: payload.total_cost_usd, costCurrency: "USD",
      costSource: "sdk_estimate", evidenceRef: "claude_cli_prompt_cost_estimate" }), revision: 2 });
    emit(units);
  };
}
