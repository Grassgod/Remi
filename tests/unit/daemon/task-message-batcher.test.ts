import { describe, expect, it } from "bun:test";
import type { TaskMessageInput } from "@multiremi/contracts/types.js";
import {
  coalesceTaskMessages,
  TaskMessageBatcher,
} from "@multiremi/worker/task-message-batcher.js";

describe("TaskMessageBatcher", () => {
  it("coalesces adjacent stream chunks and flushes immediately at a tool boundary", () => {
    const emitted: TaskMessageInput[][] = [];
    const batcher = new TaskMessageBatcher({
      emit: (messages) => emitted.push(messages),
      flushIntervalMs: 60_000,
    });

    batcher.push([
      { type: "text", content: "hello " },
      { type: "text", content: "world" },
      { type: "thinking", content: "inspect " },
      { type: "thinking", content: "code" },
    ]);
    expect(emitted).toEqual([]);

    batcher.push([
      { type: "tool_use", toolCallId: "call_1", tool: "Read", status: "pending" },
      { type: "tool_result", toolCallId: "call_1", tool: "Read", status: "completed", output: "ok" },
    ]);

    expect(emitted).toEqual([[
      { type: "text", content: "hello world" },
      { type: "thinking", content: "inspect code" },
      { type: "tool_use", toolCallId: "call_1", tool: "Read", status: "pending" },
      { type: "tool_result", toolCallId: "call_1", tool: "Read", status: "completed", output: "ok" },
    ]]);
    batcher.close();
  });

  it("flushes live text on the configured interval", async () => {
    const emitted: TaskMessageInput[][] = [];
    const batcher = new TaskMessageBatcher({
      emit: (messages) => emitted.push(messages),
      flushIntervalMs: 10,
    });
    batcher.push([{ type: "text", content: "a" }, { type: "text", content: "b" }]);

    await Bun.sleep(30);

    expect(emitted).toEqual([[{ type: "text", content: "ab" }]]);
    batcher.close();
  });

  it("does not merge across subagent metadata or the content-size bound", () => {
    expect(coalesceTaskMessages([
      { seq: 1, type: "text", content: "ab", meta: { parent_tool_call_id: "a" } },
      { seq: 2, type: "text", content: "cd", meta: { parent_tool_call_id: "a" } },
      { seq: 3, type: "text", content: "e", meta: { parent_tool_call_id: "b" } },
    ], 3)).toEqual([
      { seq: 1, type: "text", content: "ab", meta: { parent_tool_call_id: "a" } },
      { seq: 2, type: "text", content: "cd", meta: { parent_tool_call_id: "a" } },
      { seq: 3, type: "text", content: "e", meta: { parent_tool_call_id: "b" } },
    ]);
  });

  it("splits an oversized event before it exceeds the request message limit", () => {
    const emitted: TaskMessageInput[][] = [];
    const batcher = new TaskMessageBatcher({
      emit: (messages) => emitted.push(messages),
      flushIntervalMs: 60_000,
      maxBatchBytes: Number.MAX_SAFE_INTEGER,
      maxBatchCount: 2,
    });

    batcher.push([
      { type: "text", content: "a", meta: { chunk: 1 } },
      { type: "text", content: "b", meta: { chunk: 2 } },
      { type: "text", content: "c", meta: { chunk: 3 } },
    ]);
    batcher.close();

    expect(emitted.map((messages) => messages.length)).toEqual([2, 1]);
  });
});
