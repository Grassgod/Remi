export interface CodexRequestUsage {
  id: string;
  providerSessionId: string;
  providerRequestId: string;
  turnId?: string;
  scope: "request_snapshot";
  source: "codex_response_usage";
  accuracy: "exact";
  model: null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Normalize the exact per-response counters shared by native rollout records
 * and app-server rawResponse/completed. Keep this function self-contained:
 * its JavaScript body is also embedded in the managed ACP bridge patch.
 */
export function normalizeCodexRequestUsage(input: {
  threadId: string;
  responseId: string;
  turnId?: string;
  usage: unknown;
  format: "native" | "protocol";
}): CodexRequestUsage | null {
  if (typeof input.threadId !== "string" || !input.threadId || typeof input.responseId !== "string" || !input.responseId
    || !input.usage || typeof input.usage !== "object" || Array.isArray(input.usage)) return null;
  const usage = input.usage as Record<string, unknown>;
  const native = input.format === "native";
  const total = usage[native ? "total_tokens" : "totalTokens"];
  const tokensIn = usage[native ? "input_tokens" : "inputTokens"];
  const output = usage[native ? "output_tokens" : "outputTokens"];
  const read = usage[native ? "cached_input_tokens" : "cachedInputTokens"];
  const writeValue = usage[native ? "cache_write_input_tokens" : "cacheWriteInputTokens"];
  // Native older records omit only cache write (serde default = zero).
  // Explicit null or a missing required cache-read count is unknown.
  const write = native && writeValue === undefined ? 0 : writeValue;
  if (![tokensIn, output, read, write, total].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
  const inputTotal = tokensIn as number, outputTokens = output as number;
  const cachedInputTokens = read as number, cacheWriteTokens = write as number, totalTokens = total as number;
  // Native input includes cache hits (and cache creation where reported).
  // Reasoning is already included in output and is never added again.
  if (cachedInputTokens + cacheWriteTokens > inputTotal || inputTotal + outputTokens !== totalTokens) return null;
  return {
    id: input.responseId, providerSessionId: input.threadId, providerRequestId: input.responseId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    scope: "request_snapshot", source: "codex_response_usage", accuracy: "exact", model: null,
    inputTokens: inputTotal - cachedInputTokens - cacheWriteTokens,
    cachedInputTokens, cacheWriteTokens, outputTokens, totalTokens,
  };
}
