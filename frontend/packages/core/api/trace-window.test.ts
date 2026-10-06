import { expect, it } from "vitest";
import { mergeTraceWindow } from "./trace-window";

it("retains name and latest arguments while evicting a call's initial frame", () => {
  const events = mergeTraceWindow([], [
    { seq: 1, ts: "", type: "tool_use", tool_call_id: "call", tool: "Bash", input: { command: "ls", cwd: "/tmp" } },
    { seq: 2, ts: "", type: "tool_use", tool_call_id: "call", tool: "unknown", input: { command: "pwd" } },
    { seq: 3, ts: "", type: "tool_result", tool_call_id: "call", tool: "unknown", status: "cancelled" },
  ], 1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ tool: "Bash", input: { command: "pwd", cwd: "/tmp" }, status: "cancelled" });
});

it("does not invent missing context for legacy tail-only results", () => {
  const result = { seq: 99, ts: "", type: "tool_result", tool_call_id: "old", status: "completed" };
  expect(mergeTraceWindow([], [result], 1)).toEqual([result]);
});

it("bounds serialized UTF-8 bytes independently of the number of events", () => {
  const events = [1, 2, 3].map(seq => ({ seq, ts: "", type: "tool_result", output: "大".repeat(400) }));
  expect(mergeTraceWindow([], events, 2000, 2000).map(event => event.seq)).toEqual([3]);
  expect(mergeTraceWindow([], events, 2000, 100).map(event => event.seq)).toEqual([3]);
});
