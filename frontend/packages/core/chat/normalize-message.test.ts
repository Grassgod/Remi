import { describe, expect, it } from "vitest";
import { normalizeTaskMessage, normalizeTaskMessages } from "./normalize-message";

describe("normalizeTaskMessage", () => {
  it("normalizes the camelCase GET store shape to snake canonical", () => {
    const out = normalizeTaskMessage({
      id: "msg_1",
      taskId: "tsk_1",
      seq: 3,
      type: "tool_use",
      tool: "Bash",
      input: { command: "ls" },
      output: null,
      createdAt: "2026-07-12T00:00:00Z",
      toolCallId: "tc_9",
      status: "completed",
    });
    expect(out).toMatchObject({
      task_id: "tsk_1",
      seq: 3,
      type: "tool_use",
      tool_call_id: "tc_9",
      status: "completed",
      created_at: "2026-07-12T00:00:00Z",
    });
  });

  it("passes the snake_case WS frame through unchanged", () => {
    const out = normalizeTaskMessage({
      task_id: "tsk_1",
      issue_id: "iss_1",
      seq: 4,
      type: "tool_result",
      tool_call_id: "tc_9",
      created_at: "2026-07-12T00:00:01Z",
    });
    expect(out.task_id).toBe("tsk_1");
    expect(out.tool_call_id).toBe("tc_9");
    expect(out.created_at).toBe("2026-07-12T00:00:01Z");
  });

  it("produces one shape from both casings so cache entries reconcile", () => {
    const fromGet = normalizeTaskMessage({ taskId: "t", seq: 1, type: "text", createdAt: "z", toolCallId: "tc" });
    const fromWs = normalizeTaskMessage({ task_id: "t", seq: 1, type: "text", created_at: "z", tool_call_id: "tc" });
    expect(fromGet).toEqual(fromWs);
  });

  it("normalizes arrays and tolerates junk", () => {
    expect(normalizeTaskMessages("nope")).toEqual([]);
    expect(normalizeTaskMessages([{ taskId: "t", seq: 1, type: "text" }])).toHaveLength(1);
  });
});
