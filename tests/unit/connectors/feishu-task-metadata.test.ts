import { expect, it } from "bun:test";
import { FeishuTaskMetadata } from "@connectors/feishu/task-metadata.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";

const event = (seq: number, type: string, patch: Partial<TraceEvent> = {}): TraceEvent =>
  ({ seq, type, ts: "2026-10-04T00:00:00Z", ...patch });

it("deduplicates tool deltas and keeps child usage and billing tokens out of main context occupancy", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  for (const row of [
    event(1, "execution", { meta: { provider: "claude", model: "claude-test-5" } }),
    event(2, "tool_use", { tool_call_id: "read" }),
    event(3, "tool_use", { tool_call_id: "read", input: { file: "file.ts" } }),
    event(4, "tool_result", { tool_call_id: "read" }),
    event(5, "tool_use", { tool_call_id: "child-read", meta: { parent_tool_call_id: "agent" } }),
    event(6, "usage", { meta: { used: 82000, size: 1000000 } }),
    event(7, "usage", { meta: { used: 5, size: 10, parent_tool_call_id: "agent" } }),
    event(8, "execution", { meta: { model: "child-model", parent_tool_call_id: "agent" } }),
    event(9, "usage", { meta: { inputTokens: 999999, outputTokens: 9999 } }),
  ]) metadata.accept(row);
  expect(metadata.render(268)).toEqual({ agentName: "Remi", subtitle: "Remi Claude test5", stats: "268s · 82k/1M · 2 tools" });
});

it("counts a tool result after a resume checkpoint without counting repeated result deltas twice", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  metadata.accept(event(5, "tool_result", { tool_call_id: "checkpoint-tool" }));
  metadata.accept(event(6, "tool_result", { tool_call_id: "checkpoint-tool" }));
  metadata.accept(event(7, "tool_use", { tool_call_id: "next-tool" }));
  metadata.accept(event(8, "tool_result", { tool_call_id: "next-tool" }));
  expect(metadata.render(5).stats).toBe("5s · 2 tools");
});

it("clears a stale context snapshot on a model change and adopts the next ACP snapshot", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  metadata.accept(event(1, "execution", { meta: { model: "first" } }));
  metadata.accept(event(2, "usage", { meta: { used: 123, size: 1000 } }));
  metadata.accept(event(3, "execution", { meta: { model: "second" } }));
  expect(metadata.render(5).stats).toBe("5s");
  metadata.accept(event(4, "usage", { meta: { usage: { used: 456, size: 2000 } } }));
  expect(metadata.render(5).stats).toBe("5s · 456/2k");
});
