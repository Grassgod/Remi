import { expect, it } from "bun:test";
import { FEISHU_COMMAND_PROVIDER, FeishuTaskMetadata } from "@connectors/feishu/task-metadata.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { command, completed, read, started, turnCompleted, turnStarted, turnUpdated, updated } from "./feishu-native-harness.js";

const feed = (metadata: FeishuTaskMetadata, rows: TaskStreamEvent[]) => {
  for (const row of rows) metadata.accept((row as { message: TraceEvent }).message);
};

it("takes identity, model and context from turn events and the tool count from turn.stats", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  const child = command("toolu_child", "cat a.ts", undefined, { parent_id: "toolu_agent" });
  const tool = read("toolu_read", "/file.ts");
  feed(metadata, [
    turnStarted(1, { provider: "claude" }),
    turnUpdated(2, { model: "claude-test-5" }),
    started(3, { ...tool, actions: [] }), updated(4, tool), completed(5, tool), completed(6, child),
    turnUpdated(7, { context_usage: { used: 82000, size: 1000000 } }),
  ]);
  expect(metadata.completed).toBe(false);
  // Before the turn closes, unique tool item IDs (any depth) stand in for the count.
  expect(metadata.render(268)).toEqual({ agentName: "Remi", subtitle: "Remi Claude test5", stats: "268s · 82k/1M · 2 tools" });
  feed(metadata, [turnCompleted(8, [tool, child], { provider: "claude", model: "claude-test-5", context_usage: { used: 90000, size: 1000000 } })]);
  expect(metadata.completed).toBe(true);
  expect(metadata.durationSeconds).toBe(46);
  expect(metadata.render(268)).toEqual({ agentName: "Remi", subtitle: "Remi Claude test5", stats: "268s · 90k/1M · 2 tools" });
});

it("counts tool items once however many events they have", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  const bash = command("toolu_bash", "bun test");
  feed(metadata, [started(1, bash), updated(2, bash), completed(3, bash), completed(4, { ...bash, status: "declined" })]);
  expect(metadata.render(5).stats).toBe("5s · 1 tools");
});

it("adopts the agent name and a later model, and hides placeholder models and an unset context", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  feed(metadata, [turnStarted(1, { agent_name: "小助手", provider: "codex", model: "default" })]);
  expect(metadata.render(0)).toEqual({ agentName: "小助手", subtitle: "小助手 Codex", stats: null });
  feed(metadata, [turnUpdated(2, { model: "gpt-5-codex" }), turnUpdated(3, { context_usage: { used: 456, size: 2000 } })]);
  expect(metadata.render(5)).toEqual({ agentName: "小助手", subtitle: "小助手 Codex gpt5codex", stats: "5s · 456/2k" });
  feed(metadata, [turnUpdated(4, { context_usage: null })]);
  expect(metadata.render(5).stats).toBe("5s");
});

it("names no engine for a host command reply and skips anything that is not a v2 trace event", () => {
  const metadata = new FeishuTaskMetadata("Remi");
  metadata.accept({ seq: 1, ts: "2026-10-15T00:00:00.000Z", type: "usage", meta: { used: 5, size: 10 } } as unknown as TraceEvent);
  metadata.accept({ seq: 2, ts: "2026-10-15T00:00:00.000Z", type: "execution", meta: { model: "legacy" } } as unknown as TraceEvent);
  expect(metadata.render(5)).toEqual({ agentName: "Remi", subtitle: "Remi", stats: "5s" });
  feed(metadata, [turnStarted(3, { provider: FEISHU_COMMAND_PROVIDER, agent_name: null })]);
  expect(metadata.render(0)).toEqual({ agentName: "Remi", subtitle: "Remi", stats: null });
});
