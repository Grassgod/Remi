import { describe, expect, it } from "bun:test";
import { claudeUsagePatch, CLAUDE_USAGE_PATCH_VERSION } from "@acp/usage-bridge-patches.js";
import { UsageCollector } from "@acp/usage-collector.js";

const boundary = "                if (session.emitRawSDKMessages && false) {}";
const initial = { input_tokens: 2, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 1 };
const start = (id = "request", parent: string | null = null, model = "opus") => ({
  type: "stream_event", session_id: "native", parent_tool_use_id: parent,
  event: { type: "message_start", message: { id, model, usage: { ...initial } } },
});
const assistant = (id = "request", output = 1, parent: string | null = null, stop: string | null = null) => ({
  type: "assistant", session_id: "native", parent_tool_use_id: parent,
  message: { id, model: parent ? "haiku" : "opus", usage: { ...initial, output_tokens: output }, stop_reason: stop },
});
const delta = (output: number, parent: string | null = null) => ({
  type: "stream_event", session_id: "native", parent_tool_use_id: parent,
  event: { type: "message_delta", usage: { output_tokens: output, input_tokens: null }, delta: { stop_reason: "end_turn" } },
});
const stop = (parent: string | null = null) => ({
  type: "stream_event", session_id: "native", parent_tool_use_id: parent, event: { type: "message_stop" },
});
function harness(source = boundary) {
  const consume = new Function("session", "message", "params", `return (async () => { ${claudeUsagePatch(source)!} })();`);
  const collector = new UsageCollector();
  const session = {};
  const updates: any[] = [];
  const receiver = { client: { sessionUpdate: async (event: any) => {
    const usage = event.update._meta.remiTokenUsage;
    if (usage) { updates.push(usage); collector.update(usage); }
  } } };
  return {
    updates, collector,
    consume: (message: any) => consume.call(receiver, session, message, { sessionId: "acp" }),
    units: () => collector.units("claude"),
  };
}

describe("Claude final request usage", () => {
  it("captures final delta after early assistant blocks without relying on their later mutation", async () => {
    const h = harness();
    const early = assistant();
    for (const message of [start(), early, assistant(), delta(100)]) await h.consume(message);
    expect(h.units()).toEqual([expect.objectContaining({ outputTokens: 100, accuracy: "partial" })]);
    // Native Claude mutates the already-yielded block, but never yields it again.
    early.message.usage.output_tokens = 100;
    early.message.stop_reason = "end_turn";
    await h.consume(stop());
    const settled = h.collector.units("claude", null, {
      inputTokens: 2, cachedReadTokens: 80, cachedWriteTokens: 10, outputTokens: 100, totalTokens: 192,
    }, "turn");
    expect(settled).toEqual([expect.objectContaining({ inputTokens: 2, cacheReadTokens: 80,
      cacheWriteTokens: 10, outputTokens: 100, accuracy: "exact", actualUnsplitTokens: 0 })]);
  });

  it("keeps counters and revisions stable across older blocks and repeated deltas/stops", async () => {
    const h = harness();
    for (const message of [start(), delta(100), stop()]) await h.consume(message);
    const final = h.units();
    for (const message of [assistant(), delta(2), delta(100), stop(), assistant("request", 100, null, "end_turn")]) await h.consume(message);
    expect(h.units()).toEqual(final);
  });

  it("isolates parent lanes and does not let an old assistant replay redirect a new request delta", async () => {
    const h = harness();
    for (const message of [start(), start("child", "tool", "haiku"), assistant(), assistant("child", 1, "tool"),
      delta(100), delta(20, "tool"), stop(), stop("tool"), start("next"), assistant(), delta(50), stop()]) await h.consume(message);
    expect(h.units().map(unit => [unit.providerRequestId, unit.outputTokens, unit.accuracy])).toEqual([
      ["request", 100, "exact"], ["child", 20, "exact"], ["next", 50, "exact"],
    ]);
    expect(h.units()[1].model).toBe("haiku");
  });

  it.each(["error", "result"])("preserves interrupted snapshots as partial on %s", async type => {
    const h = harness();
    for (const message of [start(), assistant(), delta(30), { type, subtype: "error_during_execution" }]) await h.consume(message);
    expect(h.units()).toEqual([expect.objectContaining({ outputTokens: 30, accuracy: "partial" })]);
  });

  it("accepts nonstream final assistants only as exact when stop_reason proves completion", async () => {
    const h = harness();
    await h.consume(assistant("nonstream", 30));
    expect(h.units()[0].accuracy).toBe("partial");
    await h.consume(assistant("nonstream", 30, null, "end_turn"));
    expect(h.units()[0]).toMatchObject({ outputTokens: 30, accuracy: "exact" });
    await h.consume(assistant("other", 20, null, "tool_use"));
    expect(h.units()[1]).toMatchObject({ outputTokens: 20, accuracy: "exact" });
  });

  it("does not attach synthetic stream deltas to the previous real request", async () => {
    const h = harness();
    for (const message of [start(), assistant(), start("synthetic", null, "<synthetic>"), delta(100), stop()]) await h.consume(message);
    expect(h.units()).toEqual([expect.objectContaining({ outputTokens: 1, accuracy: "partial" })]);
  });

  it("keeps message_stop without a final usage delta partial", async () => {
    const h = harness();
    for (const message of [start(), assistant(), stop()]) await h.consume(message);
    expect(h.units()).toEqual([expect.objectContaining({ outputTokens: 1, accuracy: "partial" })]);
  });

  it("does not label missing final assistant counters exact", async () => {
    const h = harness();
    await h.consume(start());
    const final = assistant("request", 10, null, "end_turn");
    (final.message as any).usage = undefined;
    await h.consume(final);
    expect(h.units()[0]).toMatchObject({ outputTokens: 1, accuracy: "partial" });
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("keeps malformed input %s partial after final delta and stop", async input => {
    const h = harness();
    const first = start();
    (first.event.message.usage as any).input_tokens = input;
    for (const message of [first, delta(100), stop()]) await h.consume(message);
    expect(h.updates.at(-1).accuracy).toBe("partial");
  });

  it("replaces the old hook at the raw-message boundary and is idempotent", async () => {
    const old = `prefix\n                const CLAUDE_USAGE_PATCH = "claude-usage-v3";\n                throw new Error("old hook executed");\n${boundary}\nsuffix`;
    const upgraded = claudeUsagePatch(old)!;
    expect(upgraded.startsWith("prefix\n")).toBe(true);
    expect(upgraded.endsWith("\nsuffix")).toBe(true);
    expect(upgraded).not.toContain("old hook executed");
    expect(upgraded.match(/const CLAUDE_USAGE_PATCH =/g)).toHaveLength(1);
    expect(upgraded).toContain(CLAUDE_USAGE_PATCH_VERSION);
    expect(claudeUsagePatch(upgraded)).toBe(upgraded);
    expect(claudeUsagePatch("no compatible boundary")).toBeNull();
  });
});
