import { describe, expect, it } from "vitest";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { appendTimelineItem, buildEntries, buildTimeline, buildTraceTimeline, coalesceTimelineItems, extractContextUsage, extractUsageFromMessages, nestEntries, type TimelineItem, type TranscriptEntry } from "./build-timeline";

function trace(seq: number, type: string, fields: Partial<TraceEvent> = {}): TraceEvent {
  return { seq, type, ts: "2026-10-04T00:00:00Z", ...fields };
}

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
  it("keeps steer messages as distinct timeline events with audit metadata", () => {
    const steer = message(1, "steer", "Switch to Chinese");
    steer.meta = { steer_kind: "steer", author_type: "user" };

    expect(buildTimeline([steer])).toEqual([
      expect.objectContaining({
        seq: 1,
        type: "steer",
        content: "Switch to Chinese",
        meta: expect.objectContaining({ steer_kind: "steer" }),
      }),
    ]);
  });

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

  it("keeps execution metadata out of prose and usage totals", () => {
    const messages = [
      message(1, "text", "hello"),
      { task_id: "t", issue_id: "i", seq: 2, type: "execution", meta: { agentName: "Remi", provider: "claude", model: "opus5" } },
      { task_id: "t", issue_id: "i", seq: 3, type: "usage", meta: { used: 82000, size: 200000 } },
      { task_id: "t", issue_id: "i", seq: 4, type: "execution", meta: { model: "opus5" } },
      message(5, "text", " world"),
    ];
    expect(buildTimeline(messages).map(item => item.content)).toEqual(["hello world"]);
    expect(extractUsageFromMessages(messages)?.totalTokens).toBe(82000);
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

describe("trace timeline display", () => {
  it("renders the QA F0 fixture as five events with its complete final reply", () => {
    const fixture = [
      trace(1, "execution"),
      trace(2, "thinking", { content: "检查" }),
      trace(3, "usage", { content: "", meta: { used: 300000, size: 1000000 } }),
      trace(4, "thinking", { content: "完成。" }),
      trace(5, "text", { content: "开始" }),
      trace(6, "usage", { content: "", meta: { used: 400000, size: 1000000 } }),
      trace(7, "text", { content: "检查。" }),
      trace(8, "tool_use", { tool: "Bash", tool_call_id: "T1" }),
      trace(9, "tool_result", { tool: "Bash", tool_call_id: "T1", status: "completed", meta: { duration_ms: 1000 } }),
      trace(10, "text", { content: "已通过 " }),
      trace(11, "usage", { content: "", meta: { used: 350000, size: 1000000 } }),
      trace(12, "text", { content: "tests and " }),
      trace(13, "text", { content: "is now building the Web image." }),
      trace(14, "usage", { content: "", meta: { used: 210908, size: 1000000 } }),
    ];
    const items = buildTraceTimeline(fixture);
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.type)).toEqual(["thinking", "text", "tool_use", "tool_result", "text"]);
    expect(items.filter((item) => item.content).map((item) => item.content)).toEqual([
      "检查完成。", "开始检查。", "已通过 tests and is now building the Web image.",
    ]);
    expect(extractContextUsage(fixture)).toEqual({ used: 210908, size: 1000000 });
    expect(buildEntries(items).find((entry) => entry.kind === "step"))
      .toMatchObject({ toolCallId: "T1", status: "completed", durationMs: 1000 });
  });

  const events = [
    trace(1, "thinking", { content: "Inspect" }),
    trace(2, "usage", { content: "", meta: { used: 210908, size: 1000000 } }),
    trace(3, "thinking", { content: "ing." }),
    trace(4, "text", { content: "Starting " }),
    trace(5, "text", { content: "audit." }),
    trace(6, "tool_use", { tool: "Agent", tool_call_id: "agent-1", input: { description: "audit" } }),
    trace(7, "text", { content: "Child ", meta: { parent_tool_call_id: "agent-1" } }),
    trace(8, "text", { content: "report.", meta: { parent_tool_call_id: "agent-1" } }),
    trace(9, "tool_result", { tool: "Agent", tool_call_id: "agent-1", status: "completed", output: "done" }),
    trace(10, "text", { content: "Fixed " }),
    trace(11, "usage", { content: "", meta: { used: 82000, size: 1000000 } }),
    trace(12, "execution", { meta: { model: "model-x" } }),
    trace(13, "text", { content: "the bug " }),
    trace(14, "text", { content: "and added tests." }),
    trace(15, "text", { content: "Child tail.", meta: { parent_tool_call_id: "agent-2" } }),
  ];

  it("filters metadata before coalescing and preserves tools and subagent boundaries", () => {
    const input = [...events].reverse();
    const items = buildTraceTimeline(input);
    expect(items).toHaveLength(7);
    expect(items.map((item) => item.type)).toEqual([
      "thinking", "text", "tool_use", "text", "tool_result", "text", "text",
    ]);
    expect(items.map((item) => item.content)).toEqual([
      "Inspecting.", "Starting audit.", undefined, "Child report.", undefined,
      "Fixed the bug and added tests.", "Child tail.",
    ]);
    expect(items.filter((item) => item.type === "text" && !item.meta?.parent_tool_call_id).at(-1)?.content)
      .toBe("Fixed the bug and added tests.");
    expect(buildEntries(items).find((entry) => entry.kind === "step"))
      .toMatchObject({ toolCallId: "agent-1", status: "completed", output: "done" });
    expect(input).toEqual([...events].reverse());
  });

  it("produces identical timelines for equivalent task messages and trace events", () => {
    const messages: TaskMessagePayload[] = events.map((event) => ({
      task_id: "task-1", issue_id: "issue-1", seq: event.seq, type: event.type,
      created_at: event.ts, content: event.content ?? undefined, tool: event.tool ?? undefined,
      input: event.input ?? undefined, output: event.output ?? undefined,
      tool_call_id: event.tool_call_id ?? undefined, status: event.status ?? undefined,
      meta: event.meta ?? undefined,
    }));
    expect(buildTraceTimeline(events)).toEqual(buildTimeline(messages));
  });

  it.each(["text", "thinking"])("does not combine %s from different parents", (type) => {
    const items = buildTraceTimeline([
      trace(1, type, { content: "Main." }),
      trace(2, type, { content: "Child A.", meta: { parent_tool_call_id: "a" } }),
      trace(3, type, { content: "Child B.", meta: { parent_tool_call_id: "b" } }),
      trace(4, type, { content: "Main again." }),
    ]);
    expect(items.map((item) => item.content)).toEqual(["Main.", "Child A.", "Child B.", "Main again."]);
  });

  it("redacts credentials split across fragments and metadata rows", () => {
    const items = buildTraceTimeline([
      trace(1, "text", { content: "Authorization: Bearer abc123xyz." }),
      trace(2, "usage", { meta: { used: 500 } }),
      trace(3, "text", { content: "def456" }),
      trace(4, "tool_use", { input: { api_key: "raw-secret-value" }, meta: { path: "/home/alice/repo" } }),
    ]);
    expect(items[0]?.content).toBe("Authorization: Bearer [REDACTED]");
    expect(items[1]?.input).toEqual({ api_key: "[REDACTED CREDENTIAL]" });
    expect(items[1]?.meta).toEqual({ path: "/home/<user>/repo" });
  });

  it("normalizes nullable trace fields without rendering metadata rows", () => {
    expect(buildTraceTimeline([
      trace(1, "usage", { content: null, meta: { used: 1 } }),
      trace(2, "execution", { content: null }),
      trace(3, "text", { content: "Done", tool: null, input: null, output: null, tool_call_id: null, status: null, meta: null }),
    ])).toEqual([{
      seq: 3, type: "text", content: "Done", createdAt: "2026-10-04T00:00:00Z",
      tool: undefined, input: undefined, output: undefined, toolCallId: undefined, status: undefined, meta: undefined,
    }]);
  });
});

describe("extractContextUsage", () => {
  it("takes the latest sequence even when occupancy decreases and input arrives out of order", () => {
    expect(extractContextUsage([
      trace(4, "usage", { meta: { used: 82000, size: 1000000 } }),
      trace(1, "usage", { meta: { used: 210908, size: 1000000 } }),
      trace(5, "text", { content: "done" }),
    ])).toEqual({ used: 82000, size: 1000000 });
  });

  it("reads legacy JSON-in-content usage", () => {
    expect(extractContextUsage([
      trace(1, "usage", { content: JSON.stringify({ sessionUpdate: "usage_update", used: 60000, size: 1000000 }) }),
    ])).toEqual({ used: 60000, size: 1000000 });
  });

  it("prefers metadata and supports its nested usage form", () => {
    expect(extractContextUsage([
      trace(1, "usage", { meta: { usage: { used: 40, size: 100 } }, content: '{"used":999}' }),
    ])).toEqual({ used: 40, size: 100 });
  });

  it("keeps zero occupancy and allows missing capacity", () => {
    expect(extractContextUsage([trace(1, "usage", { meta: { used: 0 } })])).toEqual({ used: 0 });
  });

  it.each([0, -1, "100", Infinity, NaN])("omits an invalid capacity: %s", (size) => {
    expect(extractContextUsage([trace(1, "usage", { meta: { used: 40, size } })])).toEqual({ used: 40 });
  });

  it.each([undefined, -1, "40", Infinity, NaN])("rejects invalid occupancy: %s", (used) => {
    expect(extractContextUsage([trace(1, "usage", { meta: { used } })])).toBeNull();
  });

  it("returns null without usage or when the latest usage cannot be read", () => {
    expect(extractContextUsage([])).toBeNull();
    expect(extractContextUsage([trace(1, "text")])).toBeNull();
    expect(extractContextUsage([
      trace(1, "usage", { meta: { used: 40 } }),
      trace(2, "usage", { content: "invalid json" }),
    ])).toBeNull();
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

  it("keeps the concrete tool name when a legacy result says unknown", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Bash", toolCallId: "tc_1", status: "in_progress" }),
      item({ seq: 2, type: "tool_result", tool: "unknown", toolCallId: "tc_1", status: "completed" }),
    ]);

    expect(entries[0]).toMatchObject({ kind: "step", tool: "Bash", status: "completed" });
  });

  it("takes the input from the result when the use had none (claude terminal calls)", () => {
    // The claude bridge's initial tool_call only resolves to a terminal id, so
    // the daemon emits the use without input and lets the result carry the
    // merged args — the step card must still show the command.
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Bash", toolCallId: "tc_1", status: "pending", meta: { terminal_id: "term_42" } }),
      item({ seq: 2, type: "tool_result", tool: "Bash", toolCallId: "tc_1", status: "completed", input: { command: "echo hi", terminal_id: "term_42" }, output: "hi" }),
    ]);
    expect(entries).toHaveLength(1);
    expect((entries[0] as { input?: Record<string, unknown> }).input?.command).toBe("echo hi");
  });

  it("merges an enriched result input over the one the use carried (codex collab)", () => {
    // The wait call's answer only exists on the terminal frame; taking the
    // result's input as a fallback would pin the card to the initial snapshot.
    const entries = buildEntries([
      item({
        seq: 1,
        type: "tool_use",
        tool: "wait",
        toolCallId: "call_w",
        status: "in_progress",
        input: { prompt: null, senderThreadId: "s1", receiverThreadIds: ["a", "b"], agentsStates: {} },
      }),
      item({
        seq: 2,
        type: "tool_result",
        tool: "wait",
        toolCallId: "call_w",
        status: "completed",
        input: {
          prompt: null,
          senderThreadId: "s1",
          receiverThreadIds: ["b"],
          agentsStates: { b: { status: "completed", message: "Salt winds comb the waves" } },
        },
      }),
    ]);

    const input = (entries[0] as { input?: Record<string, unknown> }).input!;
    expect(input.agentsStates).toEqual({ b: { status: "completed", message: "Salt winds comb the waves" } });
    expect(input.receiverThreadIds).toEqual(["b"]);
    expect(input.senderThreadId).toBe("s1");
  });

  it("keeps keys only the use carried when the result repeats a subset", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Bash", toolCallId: "tc", input: { command: "ls", cwd: "/repo" } }),
      item({ seq: 2, type: "tool_result", tool: "Bash", toolCallId: "tc", status: "completed", input: { command: "ls -la" } }),
    ]);

    expect((entries[0] as { input?: Record<string, unknown> }).input).toEqual({ command: "ls -la", cwd: "/repo" });
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

  it("nests steps the daemon attributed to an Agent call", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Agent", toolCallId: "agent_1", input: { description: "count files" } }),
      item({ seq: 2, type: "tool_use", tool: "Glob", toolCallId: "glob_1", input: { pattern: "*.ts" }, meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 3, type: "tool_result", tool: "Glob", toolCallId: "glob_1", status: "completed", output: "3", meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 4, type: "tool_result", tool: "Agent", toolCallId: "agent_1", status: "completed", output: "# report" }),
    ]);
    const nested = nestEntries(entries);

    expect(nested).toHaveLength(1);
    const agent = nested[0] as Extract<TranscriptEntry, { kind: "step" }>;
    expect(agent).toMatchObject({ toolCallId: "agent_1", status: "completed", output: "# report" });
    expect(agent.children?.map((c) => (c as { toolCallId: string }).toolCallId)).toEqual(["glob_1"]);
  });

  it("keeps children in chronological order under their parent", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Agent", toolCallId: "agent_1" }),
      item({ seq: 2, type: "tool_use", tool: "Read", toolCallId: "read_1", meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 3, type: "tool_use", tool: "Glob", toolCallId: "glob_1", meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 4, type: "tool_use", tool: "Bash", toolCallId: "bash_1", meta: { parent_tool_call_id: "agent_1" } }),
    ]);
    const agent = nestEntries(entries)[0] as Extract<TranscriptEntry, { kind: "step" }>;

    expect(agent.children?.map((c) => c.seq)).toEqual([2, 3, 4]);
  });

  it("survives meta redaction — the parent id must still match the parent's tool_call_id", () => {
    // `meta` is recursively redacted while `tool_call_id` is not; if a future
    // redaction rule masked parent_tool_call_id, nesting would silently stop.
    const items = buildTimeline([
      { task_id: "t", issue_id: "i", seq: 1, type: "tool_use", tool: "Agent", tool_call_id: "toolu_015zmm7GBgjJXXn8DQAGS5G4" },
      { task_id: "t", issue_id: "i", seq: 2, type: "tool_use", tool: "Glob", tool_call_id: "toolu_01YZrpUvPqmyKMwwwouj2WZd", meta: { parent_tool_call_id: "toolu_015zmm7GBgjJXXn8DQAGS5G4" } },
    ]);
    const nested = nestEntries(buildEntries(items));

    expect(nested).toHaveLength(1);
    expect((nested[0] as { children?: unknown[] }).children).toHaveLength(1);
  });

  it("nests the subagent's own prose alongside its tool steps", () => {
    // claude-agent-acp >= 0.66 forwards subagent text/thinking with the parent
    // id, so the narrative belongs inside the Agent group, in order.
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Agent", toolCallId: "agent_1", input: { description: "audit" } }),
      item({ seq: 2, type: "thinking", content: "let me read the loader", meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 3, type: "tool_use", tool: "Read", toolCallId: "read_1", meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 4, type: "text", content: "env vars win", meta: { parent_tool_call_id: "agent_1" } }),
      item({ seq: 5, type: "text", content: "main agent reply" }),
    ]);
    const nested = nestEntries(entries);

    expect(nested.map((e) => e.kind)).toEqual(["step", "event"]);
    const agent = nested[0] as Extract<TranscriptEntry, { kind: "step" }>;
    expect(agent.children?.map((c) => [c.kind, c.seq])).toEqual([
      ["event", 2],
      ["step", 3],
      ["event", 4],
    ]);
  });

  it("keeps prose top-level when its parent id matches no step (fail open)", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "text", content: "orphan prose", meta: { parent_tool_call_id: "agent_gone" } }),
    ]);
    const nested = nestEntries(entries);

    expect(nested).toHaveLength(1);
    expect(nested[0]?.kind).toBe("event");
  });

  it("keeps a step top-level when its parent id is not in the list (fail open)", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Glob", toolCallId: "glob_1", meta: { parent_tool_call_id: "agent_gone" } }),
    ]);
    const nested = nestEntries(entries);

    expect(nested).toHaveLength(1);
    expect((nested[0] as { children?: unknown }).children).toBeUndefined();
  });

  it("leaves unattributed events top-level, even between a parent and its children", () => {
    // Only the parent id nests an event; a main-agent line that happens to fall
    // between the Agent call and its children keeps its place in the timeline.
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Agent", toolCallId: "agent_1" }),
      item({ seq: 2, type: "text", content: "main agent thinking out loud" }),
      item({ seq: 3, type: "tool_use", tool: "Glob", toolCallId: "glob_1", meta: { parent_tool_call_id: "agent_1" } }),
    ]);
    const nested = nestEntries(entries);

    expect(nested.map((e) => e.kind)).toEqual(["step", "event"]);
    expect((nested[0] as { children?: unknown[] }).children).toHaveLength(1);
  });

  it("leaves entries untouched when nothing carries a parent id (old rows)", () => {
    const entries = buildEntries([
      item({ seq: 1, type: "tool_use", tool: "Bash", toolCallId: "tc_1", input: { command: "ls" } }),
      item({ seq: 2, type: "text", content: "done" }),
    ]);
    expect(nestEntries(entries)).toEqual(entries);
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
