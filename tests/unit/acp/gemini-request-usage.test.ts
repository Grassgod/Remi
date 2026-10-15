// PR 4 §4.4: Antigravity usage comes from the gateway shim's per-response
// `usageMetadata`. On our gateway `promptTokenCount` includes the cached
// prompt, thinking is billed as output, and the server's own `used` is never
// billed. The probe numbers are the 2026-10-15 live run (ARCH-PLAN Appendix B).
import { describe, expect, it } from "bun:test";
import { accumulateUsage, createPromptUsageState } from "@acp/provider.js";
import { GEMINI_USAGE_SOURCE, geminiObservationUsage, normalizeGeminiRequestUsage } from "@acp/gemini-request-usage.js";
import type { GatewayShimRequestObservation } from "@acp/access/gateway-shim-types.js";
import type { UsageUpdate } from "@shared/contracts/acp-protocol.js";

const PROBE = { promptTokenCount: 138_617, cachedContentTokenCount: 101_304, candidatesTokenCount: 1_361, totalTokenCount: 139_978 };

function normalize(usageMetadata: unknown, responseId: string | null = "resp-1") {
  return normalizeGeminiRequestUsage({
    sessionId: "acp-session", responseId, modelVersion: "gemini-2.5-flash-001", requestedModel: "gemini-2.5-flash",
    usageMetadata, fallbackId: () => "fixed",
  });
}

function observation(overrides: Partial<GatewayShimRequestObservation> = {}): GatewayShimRequestObservation {
  return { seq: 1, requestedModel: "gemini-2.5-flash", status: 200, aborted: false, responseId: "resp-1",
    modelVersion: "gemini-2.5-flash-001", usageMetadata: PROBE, ...overrides };
}

describe("normalizeGeminiRequestUsage", () => {
  it("splits the probe's cached prompt out of the input and sums to the reported total", () => {
    expect(normalize(PROBE)).toEqual({
      id: "resp-1", providerSessionId: "acp-session", providerRequestId: "resp-1",
      scope: "request_snapshot", source: GEMINI_USAGE_SOURCE, accuracy: "exact",
      model: "gemini-2.5-flash-001", requestedModel: "gemini-2.5-flash",
      inputTokens: 37_313, cachedInputTokens: 101_304, cacheWriteTokens: 0, outputTokens: 1_361, totalTokens: 139_978,
    });
  });

  it("counts thinking as output exactly once", () => {
    expect(normalize({ promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 300, totalTokenCount: 1_500 }))
      .toMatchObject({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500, totalTokens: 1_500, accuracy: "exact" });
  });

  it("treats the tool-use prompt as input", () => {
    expect(normalize({ promptTokenCount: 1_000, toolUsePromptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 1_060 }))
      .toMatchObject({ inputTokens: 1_050, outputTokens: 10, accuracy: "exact" });
  });

  it("keeps the reported total but marks a mismatch partial", () => {
    expect(normalize({ ...PROBE, totalTokenCount: 140_000 })).toMatchObject({ totalTokens: 140_000, accuracy: "partial" });
    expect(normalize({ promptTokenCount: 10, candidatesTokenCount: 5 })).toMatchObject({ totalTokens: 15, accuracy: "partial" });
  });

  it("cannot split more cached than prompt tokens, or a response without a prompt count", () => {
    expect(normalize({ promptTokenCount: 10, cachedContentTokenCount: 11, totalTokenCount: 30 })).toBeNull();
    expect(normalize({ candidatesTokenCount: 5, totalTokenCount: 5 })).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize([1, 2])).toBeNull();
    expect(normalize({ promptTokenCount: -1 })).toBeNull();
  });

  it("gives a response without an id no request identity and partial accuracy", () => {
    const usage = normalize(PROBE, null)!;
    expect(usage.id).toBe("antigravity:shim:fixed");
    expect(usage).not.toHaveProperty("providerSessionId");
    expect(usage).not.toHaveProperty("providerRequestId");
    expect(usage.accuracy).toBe("partial");
  });
});

describe("geminiObservationUsage", () => {
  it("bills nothing for a rejected request without counters", () => {
    expect(geminiObservationUsage(observation({ status: 429, usageMetadata: null, responseId: null }), "acp-session")).toBeNull();
    expect(geminiObservationUsage(observation({ status: 0, usageMetadata: null, responseId: null }), "acp-session")).toBeNull();
  });

  it("records an aborted stream without counters as unknown, never invented", () => {
    expect(geminiObservationUsage(observation({ aborted: true, usageMetadata: null, responseId: null }), "acp-session", () => "u1")).toEqual({
      remiMissingRequestUsage: { id: "antigravity:shim:u1", scope: "request_snapshot", source: GEMINI_USAGE_SOURCE, accuracy: "unknown",
        model: "gemini-2.5-flash-001", requestedModel: "gemini-2.5-flash" },
      contextTokens: null,
    });
  });

  it("bills a cut-short stream's last counters as partial, never exact (R8)", () => {
    const counters = { promptTokenCount: 500, totalTokenCount: 500 };
    expect(geminiObservationUsage(observation({ usageMetadata: counters }), "acp-session")).toMatchObject({ remiTokenUsage: { accuracy: "exact" } });
    expect(geminiObservationUsage(observation({ aborted: true, usageMetadata: counters }), "acp-session")).toMatchObject({
      remiTokenUsage: { id: "resp-1", accuracy: "partial", inputTokens: 500, outputTokens: 0, totalTokens: 500 }, contextTokens: 500 });
  });

  it("keeps only the reported total of an unsplittable response", () => {
    const usage = geminiObservationUsage(observation({ usageMetadata: { promptTokenCount: 1, cachedContentTokenCount: 2, totalTokenCount: 9 } }), "acp-session");
    expect(usage).toMatchObject({ remiMissingRequestUsage: { id: "resp-1", providerSessionId: "acp-session", providerRequestId: "resp-1",
      accuracy: "unknown", totalTokens: 9 }, contextTokens: null });
  });

  it("reports the response total, cached included, as the context", () => {
    expect(geminiObservationUsage(observation(), "acp-session")).toMatchObject({ contextTokens: 139_978 });
  });
});

describe("collector integration", () => {
  function shimUpdate(meta: Record<string, unknown>, used = 0, size = 0): UsageUpdate {
    return { sessionUpdate: "usage_update", used, size, _meta: { remiUsageMode: "request", ...meta } };
  }

  it("produces request-identity units with the cache split, and ignores the settle", () => {
    const state = createPromptUsageState();
    const first = geminiObservationUsage(observation(), "acp-session")!;
    accumulateUsage(state, shimUpdate(first, 139_978, 1_048_576), "gemini-2.5-flash", "session_acknowledged", "antigravity");
    const second = geminiObservationUsage(observation({ responseId: "resp-2", usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 20,
      thoughtsTokenCount: 5, totalTokenCount: 225 } }), "acp-session")!;
    accumulateUsage(state, shimUpdate(second), "gemini-2.5-flash", "session_acknowledged", "antigravity");
    const units = state.collector.units("antigravity", "gemini-2.5-flash", { inputTokens: 999_999, outputTokens: 1 }, "last-request")
      .filter((unit) => unit.source !== "context_snapshot");
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      provider: "antigravity", identityKind: "request", providerSessionId: "acp-session", providerRequestId: "resp-1",
      accuracy: "exact", inputTokens: 37_313, cacheReadTokens: 101_304, cacheWriteTokens: 0, outputTokens: 1_361,
      actualUnsplitTokens: 0, model: "gemini-2.5-flash-001", requestedModel: "gemini-2.5-flash", modelSource: "provider_reported",
    });
    expect(units[1]).toMatchObject({ providerRequestId: "resp-2", inputTokens: 200, outputTokens: 25 });
    expect(units.some((unit) => unit.evidenceRef === "acp_prompt_settle")).toBe(false);
  });

  it("bills an unsplittable or aborted request as one unknown unit", () => {
    const state = createPromptUsageState();
    const aborted = geminiObservationUsage(observation({ aborted: true, usageMetadata: null, responseId: null }), "acp-session", () => "u2")!;
    accumulateUsage(state, shimUpdate(aborted), "gemini-2.5-flash", "session_acknowledged", "antigravity");
    const units = state.collector.units("antigravity", "gemini-2.5-flash", undefined, "last-request");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ accuracy: "unknown", inputTokens: null, outputTokens: null, reportedTotalTokens: null });
    expect(units[0]).not.toHaveProperty("identityKind");
  });

  it("never accepts an Antigravity missing-usage record for another provider", () => {
    const state = createPromptUsageState();
    const aborted = geminiObservationUsage(observation({ aborted: true, usageMetadata: null }), "acp-session")!;
    accumulateUsage(state, shimUpdate(aborted), "gpt-5.5", "session_acknowledged", "codex");
    expect(state.collector.units("codex", "gpt-5.5", undefined, "last-request")).toEqual([]);
  });
});
