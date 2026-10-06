import { describe, expect, it } from "bun:test";
import { convertCodexNativeTrace, CodexNativeTraceConversionError } from "../../../scripts/lib/native-trace-codex.js";

const sessionId = "provider-session";
const turnId = "turn-a";
const base = Date.parse("2026-10-04T00:00:00.000Z");
const options = { providerSessionId: sessionId, turnIds: [turnId] };
const start = { type: "event_msg", timestamp: new Date(base).toISOString(), payload: { type: "task_started", turn_id: turnId } };
function completed(item: Record<string, unknown>, startMs = base + 1000, endMs = base + 6000, turn = turnId) {
  return { type: "event_msg", timestamp: new Date(endMs).toISOString(), payload: {
    type: "item_completed", thread_id: sessionId, turn_id: turn, item, started_at_ms: startMs, completed_at_ms: endMs,
  } };
}
const command = { type: "CommandExecution", id: "call-a", command: "pwd", cwd: "/fixture", status: "completed", aggregated_output: "/fixture\n", exit_code: 0 };

describe("Codex native history trace projection", () => {
  it("preserves historical timestamps, paired tools, phase and original command output", () => {
    const result = convertCodexNativeTrace([start,
      completed({ type: "Reasoning", id: "reason", summary: [{ type: "summary_text", text: "inspect" }] }, base, base + 500),
      completed({ ...command, formatted_output: "model-facing shorter output" }),
      completed({ type: "AgentMessage", id: "reply", content: "done", phase: "final_answer" }, base + 7000, base + 8000),
    ], options);
    expect(result.coverage.unsupported).toEqual([]);
    expect(result.events.map(event => event.type)).toEqual(["thinking", "tool_use", "tool_result", "text"]);
    expect(result.events[1]).toMatchObject({ ts: "2026-10-04T00:00:01.000Z", tool: "Bash", tool_call_id: "call-a", input: { command: "pwd", cwd: "/fixture" } });
    expect(result.events[2]).toMatchObject({ ts: "2026-10-04T00:00:06.000Z", status: "completed", meta: { duration_ms: 5000 } });
    expect(JSON.parse(result.events[2]!.output!)).toEqual({ formatted_output: "/fixture\n", exit_code: 0 });
    expect(result.events[3]).toMatchObject({ content: "done", meta: { phase: "final", native_trace: { provider_session_id: sessionId, turn_id: turnId } } });
    expect(result.events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("suppresses response mirrors and repeated snapshots while preserving repeated real prose", () => {
    const response = { type: "response_item", payload: { type: "custom_tool_call", name: "functions.exec", call_id: "wrapper", input: "tools.exec_command(...)" } };
    const repeated = completed(command);
    const result = convertCodexNativeTrace([start, response, repeated, repeated,
      completed({ type: "AgentMessage", id: "text-1", content: "same" }),
      completed({ type: "AgentMessage", id: "text-2", content: "same" }),
    ], options);
    expect(result.events.filter(event => event.type === "tool_use")).toHaveLength(1);
    expect(result.events.filter(event => event.type === "text")).toHaveLength(2);
    expect(result.coverage.duplicateItems).toBe(1);
    expect(result.coverage.mirroredRecords).toEqual({ "response_item/custom_tool_call": 1 });
  });

  it("keeps overlapping tool durations and chronology without replay wall clock", () => {
    const result = convertCodexNativeTrace([completed(command, base, base + 10000),
      completed({ ...command, id: "call-b", status: "failed", exit_code: 1 }, base + 1000, base + 2000),
    ], options);
    expect(result.events.map(event => `${event.type}:${event.tool_call_id}`)).toEqual([
      "tool_use:call-a", "tool_use:call-b", "tool_result:call-b", "tool_result:call-a",
    ]);
    expect(result.events[2]).toMatchObject({ status: "failed", meta: { duration_ms: 1000 } });
    expect(result.events[3]?.meta?.duration_ms).toBe(10000);
  });

  it("does not invent duration when the native snapshot has no start time", () => {
    const record = completed(command);
    delete (record.payload as Record<string, unknown>).started_at_ms;
    const result = convertCodexNativeTrace([record], options);
    expect(result.events[1]?.meta).not.toHaveProperty("duration_ms");
    expect(result.coverage.missingToolDurations).toBe(1);
  });

  it("retains recorded file diffs, web results, image path and compaction without filesystem reads", () => {
    const changes = { "/not-on-disk/example.ts": { type: "update", unified_diff: "-before\n+after" } };
    const result = convertCodexNativeTrace([
      completed({ type: "FileChange", id: "patch", status: "completed", changes, stdout: "applied" }),
      completed({ type: "Extension", id: "web", kind: "web.search", query: "q", action: "search", results: ["r"] }),
      completed({ type: "ImageView", id: "image", path: "/image.png" }),
      completed({ type: "ContextCompaction", id: "compact" }),
    ], options);
    expect(result.coverage.convertedItems).toBe(4);
    expect(result.events.find(event => event.tool_call_id === "patch")?.input).toMatchObject({ changes });
    expect(JSON.parse(result.events.find(event => event.tool_call_id === "web" && event.type === "tool_result")!.output!)).toEqual({ results: ["r"] });
    expect(result.events.find(event => event.tool_call_id === "image")?.input).toMatchObject({ path: "/image.png" });
    expect(result.events.filter(event => event.type === "tool_use")).toHaveLength(4);
  });

  it("handles native 0.157 reasoning fields and accounts for auxiliary snapshots explicitly", () => {
    const result = convertCodexNativeTrace([start,
      completed({ type: "Reasoning", id: "reason", summary_text: ["historical thought"], raw_content: [] }),
      { type: "token_usage_record", payload: { thread_id: sessionId, turn_id: turnId, usage: {} } },
      { type: "world_state", payload: { full: true, state: {} } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_id: sessionId, thread_settings: {} } },
    ], options);
    expect(result.events[0]).toMatchObject({ type: "thinking", content: "\n\nhistorical thought" });
    expect(result.coverage.metadataRecords).toMatchObject({ token_usage_record: 1, world_state: 1, thread_settings_applied: 1 });
    expect(() => convertCodexNativeTrace([completed({ type: "Reasoning", id: "unknown-reasoning", new_field: "unhandled" })], options))
      .toThrow(CodexNativeTraceConversionError);
  });

  it("preserves native command action classification and argv without treating every command as Bash", () => {
    const result = convertCodexNativeTrace([
      completed({ ...command, id: "read", command: ["bash", "-lc", "cat file"], cwd: "file:///fixture", parsed_cmd: [{ type: "read", cmd: "cat file", path: "file:///file" }] }),
      completed({ ...command, id: "grep", parsed_cmd: [{ type: "search", cmd: "rg word", query: "word", path: "/src" }] }),
      completed({ ...command, id: "shell", command: ["bash", "-lc", "pwd"], parsed_cmd: [{ type: "unknown", cmd: "pwd" }] }),
      completed({ type: "Extension", kind: "clock.sleep", id: "sleep", durationMs: 5000 }),
    ], options);
    expect(result.events.filter(event => event.type === "tool_use").map(event => event.tool)).toEqual(["Read", "Grep", "Bash"]);
    expect(result.events.find(event => event.tool_call_id === "read")?.input).toMatchObject({ command: "cat file", argv: ["bash", "-lc", "cat file"], file_path: "/file", cwd: "/fixture" });
    expect(result.coverage.metadataRecords["item/clock.sleep"]).toBe(1);
  });

  it("recovers question tool evidence without adding fallback question-card text to the model answer", () => {
    const result = convertCodexNativeTrace([start,
      { type: "response_item", payload: { type: "function_call", call_id: "question", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ question: "Proceed?" }] }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "question", output: "queued" } },
      completed({ type: "AgentMessage", id: "question", content: "Question card fallback prose", phase: "final_answer" }),
      completed({ type: "AgentMessage", id: "answer", content: "actual model reply", phase: "final_answer" }),
    ], options);
    expect(result.events.filter(event => event.type === "text").map(event => event.content)).toEqual(["actual model reply"]);
    expect(result.events.find(event => event.type === "tool_use")).toMatchObject({ tool: "AskUserQuestion", tool_call_id: "question", input: { questions: [{ question: "Proceed?" }] } });
    expect(result.events.find(event => event.type === "tool_result")).toMatchObject({ output: JSON.stringify("queued") });
    expect(result.coverage.metadataRecords["item/question_card_from_function_call"]).toBe(1);
    expect(() => convertCodexNativeTrace([start,
      { type: "response_item", payload: { type: "function_call", call_id: "question", name: "request_user_input_async", arguments: "{}" } },
      completed({ type: "AgentMessage", id: "question", content: "fallback" }),
    ], options)).toThrow(CodexNativeTraceConversionError);
  });

  it("rejects other native turns, provider sessions and missing explicit item identity", () => {
    expect(() => convertCodexNativeTrace([completed(command, base, base + 1, "other")], options)).toThrow(CodexNativeTraceConversionError);
    const other = completed(command);
    other.payload.thread_id = "other-provider";
    expect(() => convertCodexNativeTrace([other], options)).toThrow(CodexNativeTraceConversionError);
    const missing = completed(command);
    delete (missing.payload as Record<string, unknown>).turn_id;
    expect(() => convertCodexNativeTrace([start, missing], options)).toThrow(CodexNativeTraceConversionError);
  });

  it("reports unknown nontrivial data and conflicting snapshots rather than silently dropping it", () => {
    const unknown = completed({ type: "NewToolType", id: "new", content: "important" });
    expect(() => convertCodexNativeTrace([unknown], options)).toThrow(CodexNativeTraceConversionError);
    const inventory = convertCodexNativeTrace([unknown, completed(command), completed({ ...command, aggregated_output: "changed" })], { ...options, strict: false });
    expect(inventory.coverage.unsupported.map(issue => issue.reason)).toEqual([
      "unsupported completed item type", "conflicting completed snapshots for one item",
    ]);
    expect(() => convertCodexNativeTrace([start, { type: "response_item", payload: { type: "function_call", call_id: "unrecovered" } }], options)).toThrow(CodexNativeTraceConversionError);
  });

  it("accepts explicitly verified multi-turn tasks and deterministically reconstructs the same events", () => {
    const records = [completed(command), completed({ type: "AgentMessage", id: "next", content: "after steer" }, base + 9000, base + 10000, "turn-b")];
    const multi = { providerSessionId: sessionId, turnIds: [turnId, "turn-b"] };
    expect(convertCodexNativeTrace(records, multi)).toEqual(convertCodexNativeTrace(records, multi));
    expect(convertCodexNativeTrace(records, multi).events.at(-1)?.meta?.native_trace).toMatchObject({ turn_id: "turn-b" });
  });
});
