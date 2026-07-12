import { describe, expect, it } from "vitest";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import { appendTimelineItem, buildEntries, buildTimeline, coalesceTimelineItems, extractUsageFromMessages, type TimelineItem } from "./build-timeline";

function message(seq: number, type: TaskMessagePayload["type"], content?: string): TaskMessagePayload {
  return {
    task_id: "task-1",
    issue_id: "issue-1",
    seq,
    type,
    content,
  };
}

describe("task transcript timeline", () => {
  it("merges adjacent text and thinking fragments split by streaming flushes", () => {
    const items = buildTimeline([
      message(2, "text", "world"),
      message(1, "text", "hello "),
      message(3, "thinking", "step "),
      message(4, "thinking", "one"),
    ]);

    expect(items).toEqual([
      expect.objectContaining({ seq: 1, type: "text", content: "hello world" }),
      expect.objectContaining({ seq: 3, type: "thinking", content: "step one" }),
    ]);
  });

  it("does not merge across tool or error boundaries", () => {
    const items = coalesceTimelineItems([
      { seq: 1, type: "text", content: "before" },
      { seq: 2, type: "tool_use", tool: "bash" },
      { seq: 3, type: "text", content: "after" },
      { seq: 4, type: "error", content: "failed" },
      { seq: 5, type: "text", content: "done" },
    ]);

    expect(items.map((item) => item.content ?? item.tool)).toEqual([
      "before",
      "bash",
      "after",
      "failed",
      "done",
    ]);
  });

  it("coalesces newly appended live text with the previous text item", () => {
    const existing: TimelineItem[] = [{ seq: 1, type: "text", content: "hello" }];
    const items = appendTimelineItem(existing, { seq: 2, type: "text", content: " world" });

    expect(items).toEqual([
      expect.objectContaining({ seq: 1, type: "text", content: "hello world" }),
    ]);
  });

  it("coalesces out-of-order raw text by sequence", () => {
    const existing: TimelineItem[] = [
      { seq: 1, type: "text", content: "A" },
      { seq: 3, type: "text", content: "C" },
    ];
    const items = appendTimelineItem(existing, { seq: 2, type: "text", content: "B" });

    expect(items).toEqual([
      expect.objectContaining({ seq: 1, type: "text", content: "ABC" }),
    ]);
  });

  it("redacts secrets after adjacent chunks are coalesced", () => {
    const items = buildTimeline([
      message(1, "text", "Authorization: Bearer abc123xyz."),
      message(2, "text", "def456"),
    ]);

    expect(items[0]?.content).toBe("Authorization: Bearer [REDACTED]");
    expect(items[0]?.content).not.toContain("abc123xyz");
    expect(items[0]?.content).not.toContain("def456");
  });

  it("drops usage rows from the timeline (they became the (empty) rows)", () => {
    const items = buildTimeline([
      message(1, "text", "hi"),
      { task_id: "t", issue_id: "i", seq: 2, type: "usage", meta: { totalTokens: 40477 } },
      { task_id: "t", issue_id: "i", seq: 3, type: "tool_use", tool: "Bash", input: { command: "ls" } },
    ]);
    expect(items.map((i) => i.type)).toEqual(["text", "tool_use"]);
  });

  it("carries createdAt / tool_call_id / status / meta through to items", () => {
    const items = buildTimeline([
      { task_id: "t", issue_id: "i", seq: 1, type: "tool_use", tool: "Read", input: { file_path: "/a.ts" }, tool_call_id: "tc_1", status: "completed", created_at: "2026-07-12T00:00:00Z", meta: { kind: "read" } },
    ]);
    expect(items[0]).toMatchObject({ toolCallId: "tc_1", status: "completed", createdAt: "2026-07-12T00:00:00Z" });
    expect(items[0]?.meta).toEqual({ kind: "read" });
  });

  it("recursively redacts secrets in structured tool input", () => {
    const items = buildTimeline([
      { task_id: "t", issue_id: "i", seq: 1, type: "tool_use", tool: "Bash", input: { api_key: "raw-secret-value", note: "ok" } },
    ]);
    expect(items[0]?.input).toEqual({ api_key: "[REDACTED CREDENTIAL]", note: "ok" });
  });

  it("privatizes home paths in output", () => {
    const items = buildTimeline([
      message(1, "tool_result", undefined),
    ].map((m) => ({ ...m, type: "tool_result" as const, output: "/home/alice/project/a.ts" })));
    expect(items[0]?.output).toBe("/home/<user>/project/a.ts");
  });

  it("extractUsageFromMessages takes the LAST snapshot, never a sum", () => {
    // ACP usage is a running total that can even go down — accumulating double-counts.
    const usage = extractUsageFromMessages([
      { task_id: "t", issue_id: "i", seq: 1, type: "usage", meta: { totalTokens: 14445 } },
      { task_id: "t", issue_id: "i", seq: 2, type: "usage", meta: { totalTokens: 14321, model: "claude-x" } },
    ]);
    expect(usage?.totalTokens).toBe(14321);
    expect(usage?.model).toBe("claude-x");
  });

  it("extractUsageFromMessages parses the legacy JSON-in-content form", () => {
    const usage = extractUsageFromMessages([
      { task_id: "t", issue_id: "i", seq: 1, type: "usage", content: JSON.stringify({ sessionUpdate: "usage_update", used: 60000, size: 1000000 }) },
    ]);
    expect(usage?.totalTokens).toBe(60000);
  });
});

describe("buildEntries pairing", () => {
  const item = (over: Partial<TimelineItem> & { seq: number; type: TimelineItem["type"] }): TimelineItem => over;

  it("pairs tool_use + tool_result on tool_call_id into one step", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Bash", toolCallId: "tc_1", input: { command: "ls" }, status: "pending" }),
      item({ seq: 2, type: "tool_result", tool: "Bash", toolCallId: "tc_1", output: "ok", status: "completed", meta: { duration_ms: 42 } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "step", toolCallId: "tc_1", tool: "Bash", status: "completed", output: "ok", durationMs: 42 });
    expect((entries[0] as { input?: unknown }).input).toEqual({ command: "ls" });
  });

  it("falls back to createdAt delta when meta.duration_ms is absent", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", toolCallId: "tc", createdAt: "2026-07-12T00:00:00.000Z" }),
      item({ seq: 2, type: "tool_result", toolCallId: "tc", output: "x", status: "completed", createdAt: "2026-07-12T00:00:01.500Z" }),
    ]);
    expect((entries[0] as { durationMs?: number }).durationMs).toBe(1500);
  });

  it("keeps messages without a tool_call_id as plain events (legacy degrade)", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Bash" }),
      item({ seq: 2, type: "text", content: "hi" }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["event", "event"]);
  });

  it("handles a tool_result arriving before its tool_use (out of order)", () => {
    const entries = buildEntries([
      item({ seq: 2, type: "tool_result", toolCallId: "tc", output: "done", status: "completed" }),
      item({ seq: 1, type: "tool_use", toolCallId: "tc", tool: "Read", input: { file_path: "/a" } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "step", tool: "Read", output: "done", status: "completed" });
  });

  it("keeps the terminal status when items arrive newest-first (pending must not overwrite completed)", () => {
    // Reproduces the spinner bug: a newest-first list feeds the completed
    // tool_result before the pending tool_use; without a chronological sort the
    // pending status wins and the step spins forever.
    const entries = buildEntries([
      item({ seq: 2, type: "tool_result", toolCallId: "tc", output: "ok", status: "completed", meta: { duration_ms: 30 } }),
      item({ seq: 1, type: "tool_use", toolCallId: "tc", tool: "Bash", status: "pending" }),
    ]);
    expect(entries[0]).toMatchObject({ kind: "step", status: "completed", durationMs: 30 });
  });
});
