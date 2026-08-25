// MUL-92: the input/output token split only exists on the ACP prompt settle
// result — the streamed `usage_update` notifications carry `{used, size,
// cost}` (context occupancy) and nothing else. These tests lock the merge
// precedence in the provider and the daemon-side conversion to TaskUsageEntry.
import { describe, expect, it } from "bun:test";
import { resolvePromptUsage } from "@acp/provider.js";
import { responseToUsage } from "@multiremi/worker/acp-event-mapper.js";

const streamedOnly = {
  // What accumulateUsage produces from usage_update events: total only.
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 78048,
};

describe("resolvePromptUsage", () => {
  it("prefers the claude-agent-acp settle split over streamed context occupancy", () => {
    const resolved = resolvePromptUsage(streamedOnly, {
      inputTokens: 1200,
      outputTokens: 340,
      cachedReadTokens: 56000,
      cachedWriteTokens: 7800,
      totalTokens: 65340,
    });
    expect(resolved).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 56000,
      cacheWriteTokens: 7800,
      totalTokens: 65340,
    });
  });

  it("falls back per-field for the codex-acp settle shape (no cachedWriteTokens)", () => {
    const resolved = resolvePromptUsage(streamedOnly, {
      inputTokens: 900,
      outputTokens: 210,
      cachedReadTokens: 4000,
      totalTokens: 5110,
    });
    expect(resolved.inputTokens).toBe(900);
    expect(resolved.cacheWriteTokens).toBe(0);
    expect(resolved.totalTokens).toBe(5110);
  });

  it("keeps the streamed numbers when the bridge settles without usage", () => {
    expect(resolvePromptUsage(streamedOnly, undefined)).toEqual(streamedOnly);
    expect(resolvePromptUsage(streamedOnly, null)).toEqual(streamedOnly);
  });

  it("ignores non-finite and negative settle values", () => {
    const resolved = resolvePromptUsage(streamedOnly, {
      inputTokens: Number.NaN,
      outputTokens: -5,
      totalTokens: 100,
    });
    expect(resolved.inputTokens).toBe(0);
    expect(resolved.outputTokens).toBe(0);
    expect(resolved.totalTokens).toBe(100);
  });
});

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
