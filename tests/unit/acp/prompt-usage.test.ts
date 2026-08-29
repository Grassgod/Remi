// MUL-92/MUL-196: Claude settles whole-turn usage, while Codex settles only its
// last model request. Remi's patched Codex stream carries each request's split;
// the unpatched fallback sums `used` and stays totals-only.
import { describe, expect, it } from "bun:test";
import { accumulateUsage, createPromptUsageState, resolvePromptUsage } from "@acp/provider.js";
import { responseToUsage } from "@multiremi/worker/acp-event-mapper.js";

function streamedOnly() {
  const usage = createPromptUsageState();
  usage.totalTokens = 78048;
  return usage;
}

describe("resolvePromptUsage", () => {
  it("prefers the claude-agent-acp settle split over streamed context occupancy", () => {
    const resolved = resolvePromptUsage(streamedOnly(), {
      inputTokens: 1200,
      outputTokens: 340,
      cachedReadTokens: 56000,
      cachedWriteTokens: 7800,
      totalTokens: 65340,
    }, "turn");
    expect(resolved).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 56000,
      cacheWriteTokens: 7800,
      totalTokens: 65340,
    });
  });

  it("falls back per-field when a turn-scoped settle omits cachedWriteTokens", () => {
    const resolved = resolvePromptUsage(streamedOnly(), {
      inputTokens: 900,
      outputTokens: 210,
      cachedReadTokens: 4000,
      totalTokens: 5110,
    }, "turn");
    expect(resolved.inputTokens).toBe(900);
    expect(resolved.cacheWriteTokens).toBe(0);
    expect(resolved.totalTokens).toBe(5110);
  });

  it("keeps the streamed numbers when the bridge settles without usage", () => {
    const streamed = streamedOnly();
    expect(resolvePromptUsage(streamed, undefined, "turn")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 78048,
    });
    expect(resolvePromptUsage(streamed, null, "turn")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 78048,
    });
  });

  it("treats an explicit settle 0 as authoritative instead of falling back to streamed values", () => {
    // A cancelled turn settles with all-zero sessionUsage; the streamed
    // context occupancy must not be misreported as this turn's tokens.
    const resolved = resolvePromptUsage(streamedOnly(), {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      totalTokens: 0,
    }, "turn");
    expect(resolved).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  it("ignores non-finite and negative settle values", () => {
    const resolved = resolvePromptUsage(streamedOnly(), {
      inputTokens: Number.NaN,
      outputTokens: -5,
      totalTokens: 100,
    }, "turn");
    expect(resolved.inputTokens).toBe(0);
    expect(resolved.outputTokens).toBe(0);
    expect(resolved.totalTokens).toBe(100);
  });

  it("accumulates patched codex request splits and ignores the last-request settle", () => {
    const usage = createPromptUsageState();
    accumulateUsage(usage, codexUsageUpdate(100, 15, 70, 8, 7));
    accumulateUsage(usage, codexUsageUpdate(240, 25, 180, 20, 15));

    expect(usage.totalTokens).toBe(240); // latest context-occupancy snapshot
    expect(resolvePromptUsage(usage, {
      inputTokens: 25,
      outputTokens: 20,
      cachedReadTokens: 180,
      totalTokens: 240,
    }, "last-request")).toEqual({
      inputTokens: 40,
      outputTokens: 28,
      cacheReadTokens: 250,
      cacheWriteTokens: 0,
      totalTokens: 340,
    });
  });

  it("sums unpatched codex used snapshots into a totals-only result", () => {
    const usage = createPromptUsageState();
    accumulateUsage(usage, { sessionUpdate: "usage_update", used: 100, size: 200000 });
    accumulateUsage(usage, { sessionUpdate: "usage_update", used: 240, size: 200000 });

    expect(resolvePromptUsage(usage, {
      inputTokens: 25,
      outputTokens: 20,
      cachedReadTokens: 180,
      totalTokens: 240,
    }, "last-request")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 340,
    });
  });

  it("keeps streamed codex usage when a cancelled turn settles with zeros", () => {
    const usage = createPromptUsageState();
    accumulateUsage(usage, codexUsageUpdate(100, 15, 70, 8, 7));

    expect(resolvePromptUsage(usage, {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      totalTokens: 0,
    }, "last-request")).toEqual({
      inputTokens: 15,
      outputTokens: 8,
      cacheReadTokens: 70,
      cacheWriteTokens: 0,
      totalTokens: 100,
    });
  });

  it("uses codex settle only when no usable stream update arrived", () => {
    expect(resolvePromptUsage(createPromptUsageState(), {
      inputTokens: 25,
      outputTokens: 20,
      cachedReadTokens: 180,
      totalTokens: 225,
    }, "last-request")).toEqual({
      inputTokens: 25,
      outputTokens: 20,
      cacheReadTokens: 180,
      cacheWriteTokens: 0,
      totalTokens: 225,
    });
  });
});

function codexUsageUpdate(
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
) {
  return {
    sessionUpdate: "usage_update" as const,
    used: totalTokens,
    size: 200000,
    _meta: {
      remiUsagePatch: "codex-usage-v1",
      remiTokenUsage: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens },
    },
  };
}

describe("responseToUsage (daemon side of the same pipeline)", () => {
  it("converts a settle-backed AgentResponse into a full TaskUsageEntry", () => {
    const entries = responseToUsage("claude", {
      model: "claude-opus-5",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 56000,
      cacheCreateInputTokens: 7800,
      totalTokens: 65340,
    });
    expect(entries).toEqual([{
      provider: "claude",
      model: "claude-opus-5",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 56000,
      cacheWriteTokens: 7800,
      totalTokens: 65340,
    }]);
  });

  it("still reports a totals-only response (pre-settle bridges) instead of dropping it", () => {
    const entries = responseToUsage("claude", { totalTokens: 78048 }, "claude-opus-5");
    expect(entries).toEqual([{
      provider: "claude",
      model: "claude-opus-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 78048,
    }]);
  });

  it("returns no entries when nothing was used", () => {
    expect(responseToUsage("claude", null)).toEqual([]);
    expect(responseToUsage("claude", {})).toEqual([]);
  });
});
