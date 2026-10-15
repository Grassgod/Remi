/**
 * Per-request usage of Gemini responses observed by the Antigravity gateway
 * shim (PR 4 §4.4), mirroring `codex-request-usage.ts`.
 *
 * On our gateway `promptTokenCount` includes the cached prompt tokens and
 * `totalTokenCount` is prompt + candidates + thoughts (+ tool-use prompt).
 * Thinking is billed as output and is never added again. The server's own
 * `usage_update.used` is `total + cached` (server 1.4.0, and the probe) and must
 * never be billed: it double-counts the cache.
 */

import { randomUUID } from "node:crypto";
import type { GatewayShimRequestObservation } from "./access/gateway-shim-types.js";

export const GEMINI_USAGE_SOURCE = "antigravity_shim_usage";

export interface GeminiRequestUsage {
  id: string;
  /** The server-minted ACP session id; absent without a `responseId`. */
  providerSessionId?: string;
  providerRequestId?: string;
  scope: "request_snapshot";
  source: typeof GEMINI_USAGE_SOURCE;
  accuracy: "exact" | "partial";
  /** `modelVersion`, provider-reported. */
  model: string | null;
  /** The URL model segment the harness asked for. */
  requestedModel: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: 0;
  outputTokens: number;
  totalTokens: number;
}

/** A request whose counters cannot be split: billed as `unknown`, with only what was reported. */
export interface GeminiMissingRequestUsage {
  id: string;
  providerSessionId?: string;
  providerRequestId?: string;
  scope: "request_snapshot";
  source: typeof GEMINI_USAGE_SOURCE;
  accuracy: "unknown";
  model: string | null;
  requestedModel: string | null;
  totalTokens?: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function identity(sessionId: string | null | undefined, responseId: string | null | undefined, fallbackId: () => string) {
  return sessionId && responseId
    ? { id: responseId, providerSessionId: sessionId, providerRequestId: responseId }
    : { id: `antigravity:shim:${fallbackId()}` };
}

/**
 * Split one response's `usageMetadata`. Null when it cannot be split (no
 * prompt count, or more cached than prompt tokens); the caller then records an
 * `unknown` unit with the reported total only.
 */
export function normalizeGeminiRequestUsage(input: {
  sessionId: string | null;
  responseId: string | null;
  modelVersion: string | null;
  requestedModel: string | null;
  usageMetadata: unknown;
  fallbackId?: () => string;
}): GeminiRequestUsage | null {
  const usage = input.usageMetadata;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const raw = usage as Record<string, unknown>;
  const prompt = count(raw.promptTokenCount);
  if (prompt === null) return null;
  const cached = count(raw.cachedContentTokenCount) ?? 0;
  const toolUse = count(raw.toolUsePromptTokenCount) ?? 0;
  const candidates = count(raw.candidatesTokenCount) ?? 0;
  const thoughts = count(raw.thoughtsTokenCount) ?? 0;
  if (cached > prompt) return null;
  const inputTokens = prompt + toolUse - cached;
  const outputTokens = candidates + thoughts;
  const reported = count(raw.totalTokenCount);
  const totalTokens = reported ?? inputTokens + cached + outputTokens;
  const ids = identity(input.sessionId, input.responseId, input.fallbackId ?? randomUUID);
  return {
    ...ids, scope: "request_snapshot", source: GEMINI_USAGE_SOURCE,
    // Without a response id nothing proves this is one distinct request.
    accuracy: "providerRequestId" in ids && reported !== null && inputTokens + cached + outputTokens === reported ? "exact" : "partial",
    model: input.modelVersion || null, requestedModel: input.requestedModel || null,
    inputTokens, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens, totalTokens,
  };
}

/** Usage update `_meta` for one shim observation, or null when the request consumed nothing. */
export function geminiObservationUsage(obs: GatewayShimRequestObservation, sessionId: string | null, fallbackId: () => string = randomUUID):
  { remiTokenUsage: GeminiRequestUsage; contextTokens: number } | { remiMissingRequestUsage: GeminiMissingRequestUsage; contextTokens: null } | null {
  const usage = normalizeGeminiRequestUsage({
    sessionId, responseId: obs.responseId, modelVersion: obs.modelVersion, requestedModel: obs.requestedModel,
    usageMetadata: obs.usageMetadata, fallbackId,
  });
  // A cut-short stream's last counters are a lower bound (R8): never claim them exact.
  if (usage) return { remiTokenUsage: obs.aborted ? { ...usage, accuracy: "partial" } : usage, contextTokens: usage.totalTokens };
  // A rejected request without counters consumed nothing billable.
  if (!obs.usageMetadata && !obs.aborted && (obs.status < 200 || obs.status >= 300)) return null;
  const total = count(obs.usageMetadata?.totalTokenCount);
  return {
    remiMissingRequestUsage: {
      ...identity(sessionId, obs.responseId, fallbackId), scope: "request_snapshot", source: GEMINI_USAGE_SOURCE,
      accuracy: "unknown", model: obs.modelVersion || null, requestedModel: obs.requestedModel || null,
      ...(total !== null ? { totalTokens: total } : {}),
    },
    contextTokens: null,
  };
}
