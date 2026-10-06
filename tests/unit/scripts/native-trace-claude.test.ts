import { describe, expect, it } from "bun:test";
import { convertClaudeNativeTrace, ClaudeNativeTraceConversionError, type ClaudeAcpNotificationMapper } from "../../../scripts/lib/native-trace-claude.js";

const sessionId = "native-session";
const base = Date.parse("2026-10-04T00:00:00.000Z");
function record(uuid: string, type: "assistant" | "user", content: unknown, ms: number, fields: Record<string, unknown> = {}) {
  return { uuid, sessionId, timestamp: new Date(base + ms).toISOString(), type, cwd: "/fixture", message: { role: type, content }, ...fields };
}
const call = (id: string, name = "Bash", input: Record<string, unknown> = { command: "pwd" }) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: unknown = "/fixture\n", is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });
const bridge: ClaudeAcpNotificationMapper = (content, role, session, cache, _client, _logger, options) => {
  expect(options.registerHooks).toBe(false);
  const notifications: { sessionId: string; update: Record<string, unknown> }[] = [];
  for (const block of content) {
    let update: Record<string, unknown>;
    if (block.type === "text" || block.type === "thinking") {
      update = { sessionUpdate: block.type === "thinking" ? "agent_thought_chunk" : role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
        content: { type: "text", text: block.text ?? block.thinking } };
    } else if (block.type === "tool_use") {
      cache[block.id] = block;
      update = block.name === "TodoWrite" ? { sessionUpdate: "plan", entries: block.input.todos }
        : { sessionUpdate: "tool_call", toolCallId: block.id, title: block.name, rawInput: block.input, status: "pending", _meta: { claudeCode: { toolName: block.name } } };
    } else {
      const original = cache[block.tool_use_id];
      delete cache[block.tool_use_id];
      if (original.name === "TodoWrite") continue;
      update = { sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, rawOutput: block.content,
        status: block.is_error ? "failed" : "completed", _meta: { claudeCode: { toolName: original.name } } };
    }
    if (options.parentToolUseId) {
      const meta = update._meta as any;
      update._meta = { ...meta, claudeCode: { ...meta?.claudeCode, parentToolUseId: options.parentToolUseId } };
    }
    notifications.push({ sessionId: session, update });
  }
  return notifications;
};
const options = { providerSessionId: sessionId, mapperVersion: "test-bridge@1", toAcpNotifications: bridge };

describe("Claude native history trace projection", () => {
  it("uses native clocks and pairs parallel results while preserving exact input/output", () => {
    const result = convertClaudeNativeTrace([
      record("prompt", "user", [{ type: "text", text: "private system and task input" }], 0),
      record("a", "assistant", [{ type: "thinking", thinking: "inspect" }, call("one"), call("two", "Read", { file_path: "/fixture/a" })], 1000),
      record("b", "user", [{ type: "tool_result", tool_use_id: "two", content: "file", is_error: true }], 2000),
      record("c", "user", [{ type: "tool_result", tool_use_id: "one", content: "/fixture\n" }], 6000),
      record("d", "assistant", [{ type: "text", text: "done" }], 7000),
    ], options);
    expect(result.coverage.unsupported).toEqual([]);
    expect(result.coverage.toolCalls).toBe(2);
    expect(result.coverage.toolResults).toBe(2);
    expect(result.events.map(e => e.type)).toEqual(["thinking", "tool_use", "tool_use", "tool_result", "tool_result", "text"]);
    expect(result.events[1]).toMatchObject({ ts: "2026-10-04T00:00:01.000Z", tool_call_id: "one", input: { command: "pwd" } });
    expect(result.events[3]).toMatchObject({ status: "failed", meta: { duration_ms: 1000 } });
    expect(result.events[4]).toMatchObject({ status: "completed", meta: { duration_ms: 5000 } });
    expect(result.events[4]!.output).toBe("/fixture\n");
    expect(JSON.stringify(result.events)).not.toContain("private system and task input");
    expect(result.coverage.omissions).toContainEqual({ recordIndex: 0, type: "user/text", reason: "user/system input belongs to task input, not execution output" });
  });

  it("keeps explicit subagent attribution and does not infer it for foreground siblings", () => {
    const result = convertClaudeNativeTrace([
      record("a", "assistant", [call("agent", "Agent", { prompt: "review" })], 0),
      record("b", "assistant", [{ type: "text", text: "child thought" }, call("child")], 100, { isSidechain: true, parent_tool_use_id: "agent" }),
      record("c", "user", [{ type: "tool_result", tool_use_id: "child", content: "child output" }], 200, { isSidechain: true, parent_tool_use_id: "agent" }),
      record("d", "assistant", [call("sibling")], 300),
      record("e", "user", [{ type: "tool_result", tool_use_id: "sibling", content: "sibling output" }], 400),
      record("f", "user", [{ type: "tool_result", tool_use_id: "agent", content: "reviewed" }], 500),
    ], options);
    expect(result.events.find(e => e.content === "child thought")?.meta?.parent_tool_call_id).toBe("agent");
    expect(result.events.find(e => e.tool_call_id === "child")?.meta?.parent_tool_call_id).toBe("agent");
    expect(result.events.find(e => e.tool_call_id === "sibling")?.meta).not.toHaveProperty("parent_tool_call_id");
    expect(result.coverage.missingParentToolUseIds).toEqual([]);
  });

  it("preserves plain, newline and literal JSON-looking tool strings without a second encoding layer", () => {
    for (const output of ["plain", 'first\n"quoted"\nliteral \\n', '"literal quotes"', '{"json":"is still text"}']) {
      const converted = convertClaudeNativeTrace([
        record("call", "assistant", [call("tool")], 0),
        record("result", "user", [result("tool", output)], 100),
      ], options);
      expect(converted.events.find(e => e.type === "tool_result")!.output).toBe(output);
    }
    for (const output of [{ stdout: "first\nsecond", value: '"quote"' }, [{ type: "text", text: "answer" }]]) {
      const converted = convertClaudeNativeTrace([
        record("call", "assistant", [call("tool")], 0),
        record("result", "user", [result("tool", output)], 100),
      ], options);
      expect(converted.events.find(e => e.type === "tool_result")!.output).toBe(JSON.stringify(output));
    }
  });

  it("accounts for plan-tool projection and known context without exposing context content", () => {
    const result = convertClaudeNativeTrace([
      { type: "attachment", uuid: "context", sessionId, attachment: { type: "prompt_snapshot", systemPrompt: "hidden" } },
      record("a", "assistant", [call("plan", "TodoWrite", { todos: [{ content: "review", status: "completed", priority: "medium" }] })], 0),
      record("b", "user", [{ type: "tool_result", tool_use_id: "plan", content: "updated" }], 100),
      record("c", "assistant", [{ type: "redacted_thinking", data: "encrypted" }, { type: "text", text: "done" }], 200),
    ], options);
    expect(result.events.map(e => e.type)).toEqual(["plan", "text"]);
    expect(result.coverage.omissions.map(o => o.type)).toEqual(["attachment/prompt_snapshot", "tool_use/TodoWrite", "redacted_thinking"]);
    expect(JSON.stringify(result.events)).not.toContain("hidden");
  });

  it("rejects unknown blocks, unsupported assistant media, and unknown context records", () => {
    const inputs = [
      record("a", "assistant", [{ type: "new_execution", payload: "important" }], 0),
      record("b", "assistant", [{ type: "image", source: { type: "url", url: "image.png" } }], 0),
      { type: "attachment", sessionId, attachment: { type: "unknown_result", content: "important" } },
    ];
    for (const input of inputs) expect(() => convertClaudeNativeTrace([input], options)).toThrow(ClaudeNativeTraceConversionError);
    expect(convertClaudeNativeTrace(inputs, { ...options, strict: false }).coverage.unsupported).toHaveLength(3);
  });

  it("accounts for native prompt/context attachment kinds without replaying their contents", () => {
    const kinds = ["instructions", "batching_reminder_sent", "edited_text_file", "nested_memory", "queued_command", "read_truncation_notice", "compact_file_reference", "file"];
    const rows = kinds.map((kind, i) => ({ type: "attachment", uuid: `context-${i}`, sessionId, attachment: {
      type: kind, content: "private model context", text: "private model context", command: "private queued command",
    } }));
    const converted = convertClaudeNativeTrace([...rows, record("reply", "assistant", [{ type: "text", text: "answer" }], 0)], options);
    expect(converted.events.map(e => e.content)).toEqual(["answer"]);
    expect(converted.coverage.omissions.map(o => o.type)).toEqual(kinds.map(kind => `attachment/${kind}`));
    expect(Object.keys(converted.coverage.metadataRecords)).toEqual(kinds.map(kind => `attachment/${kind}`));
    expect(JSON.stringify(converted.events)).not.toContain("private");
    expect(() => convertClaudeNativeTrace([{ type: "system", subtype: "unknown_execution_failure", sessionId, error: "failure" }], options)).toThrow(ClaudeNativeTraceConversionError);
  });

  it("replays informational banners exactly and audits logger-only API retry diagnostics", () => {
    const converted = convertClaudeNativeTrace([
      { type: "system", subtype: "informational", uuid: "notice", sessionId, timestamp: new Date(base).toISOString(), level: "notice", content: "A recorded notice" },
      { type: "system", subtype: "informational", uuid: "info", sessionId, timestamp: new Date(base + 1).toISOString(), level: "info", content: "Plain info" },
      { type: "system", subtype: "api_error", uuid: "retry", sessionId, error: { message: "private diagnostic" }, retryAttempt: 1, retryInMs: 1000 },
    ], options);
    expect(converted.events.map(e => e.content)).toEqual(["**Notice:** A recorded notice", "Plain info"]);
    expect(converted.events[0]!.ts).toBe("2026-10-04T00:00:00.000Z");
    expect(converted.coverage.omissions).toContainEqual({ recordIndex: 2, type: "system/api_error", reason: "API retry diagnostic: installed live bridge logs/ignores it without a trace update" });
    expect(JSON.stringify(converted.events)).not.toContain("private diagnostic");
    expect(() => convertClaudeNativeTrace([{ type: "system", subtype: "informational", uuid: "bad", sessionId, timestamp: new Date(base).toISOString(), level: "", content: "bad" }], options)).toThrow(ClaudeNativeTraceConversionError);
  });

  it("rejects provider mismatch, conflicting UUIDs, reversed chronology and unpaired tool IDs", () => {
    const a = record("a", "assistant", [call("one")], 1000);
    expect(() => convertClaudeNativeTrace([{ ...a, sessionId: "other" }], options)).toThrow(ClaudeNativeTraceConversionError);
    expect(() => convertClaudeNativeTrace([a, { ...a, timestamp: new Date(base + 1001).toISOString() }], options)).toThrow(ClaudeNativeTraceConversionError);
    const unpaired = convertClaudeNativeTrace([a, record("b", "user", [result("missing")], 2000)], { ...options, strict: false });
    expect(unpaired.coverage.unpairedToolUseIds).toEqual(["one"]);
    expect(unpaired.coverage.unpairedToolResultIds).toEqual(["missing"]);
    expect(() => convertClaudeNativeTrace([a, record("c", "user", [result("one")], 0)], options)).toThrow(ClaudeNativeTraceConversionError);
  });

  it("refuses unattributed subagent messages and parent IDs outside the verified slice", () => {
    expect(() => convertClaudeNativeTrace([record("a", "assistant", [{ type: "text", text: "child" }], 0, { isSidechain: true })], options)).toThrow(ClaudeNativeTraceConversionError);
    const r = convertClaudeNativeTrace([record("b", "assistant", [{ type: "text", text: "child" }], 0, { parent_tool_use_id: "missing" })], { ...options, strict: false });
    expect(r.coverage.missingParentToolUseIds).toEqual(["missing"]);
  });

  it("deduplicates identical native records but preserves repeated real assistant messages", () => {
    const a = record("a", "assistant", [{ type: "text", text: "same" }], 0);
    const result = convertClaudeNativeTrace([a, a, record("b", "assistant", [{ type: "text", text: "same" }], 100)], options);
    expect(result.coverage.duplicateRecords).toBe(1);
    expect(result.events.map(e => e.content)).toEqual(["same", "same"]);
    expect(convertClaudeNativeTrace([a], options)).toEqual(convertClaudeNativeTrace([a], options));
  });

  it("blocks callbacks and attributes structured native results to the pinned offline bridge", () => {
    const rows = [record("a", "assistant", [call("one")], 0), record("b", "user", [result("one")], 100, { toolUseResult: { stdout: "structured" } })];
    let structured: unknown;
    const injected: ClaudeAcpNotificationMapper = (...args) => { if (args[1] === "user") structured = args[6].toolUseResult; return bridge(...args); };
    const converted = convertClaudeNativeTrace(rows, { ...options, toAcpNotifications: injected });
    expect(structured).toEqual({ stdout: "structured" });
    expect(converted.events[0]!.meta!.native_trace).toMatchObject({ provider_session_id: sessionId, mapper_version: "test-bridge@1", native_record_uuid: "a" });
    expect(() => convertClaudeNativeTrace(rows, { ...options, toAcpNotifications: (...args) => args[4].sessionUpdate({}) })).toThrow(ClaudeNativeTraceConversionError);
  });
});
