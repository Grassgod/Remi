import { describe, it, expect } from "bun:test";
import {
  parseLine,
  formatUserMessage,
  formatToolResult,
  type SystemMessage,
  type ContentDelta,
  type ThinkingDelta,
  type ToolUseRequest,
  type ResultMessage,
  type ParseError,
  type RateLimitEvent,
  type ErrorEvent,
  type AssistantBlocks,
} from "../src/providers/claude-cli/protocol.js";

describe("parseLine", () => {
  it("parses system init", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-abc",
      tools: [{ name: "read_file" }],
      model: "claude-sonnet-4-5-20250929",
      mcp_servers: [],
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("system");
    const sys = msg as SystemMessage;
    expect(sys.sessionId).toBe("sess-abc");
    expect(sys.model).toBe("claude-sonnet-4-5-20250929");
    expect(sys.tools.length).toBe(1);
  });

  it("parses minimal system init", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    const msg = parseLine(line);
    expect(msg.kind).toBe("system");
    const sys = msg as SystemMessage;
    expect(sys.sessionId).toBe("");
    expect(sys.tools).toEqual([]);
  });

  it("parses content delta text", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("content_delta");
    const delta = msg as ContentDelta;
    expect(delta.text).toBe("Hello");
    expect(delta.index).toBe(0);
  });

  it("returns dict for input_json_delta", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"key":' },
    });
    const msg = parseLine(line);
    expect("kind" in msg).toBe(false);
    expect((msg as Record<string, unknown>).type).toBe("content_block_delta");
  });

  it("parses tool use from content_block_start", () => {
    const line = JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_123",
        name: "read_memory",
        input: {},
      },
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("tool_use");
    const tu = msg as ToolUseRequest;
    expect(tu.toolUseId).toBe("toolu_123");
    expect(tu.name).toBe("read_memory");
  });

  it("parses tool use from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_456",
            name: "write_memory",
            input: { content: "hello" },
          },
        ],
      },
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("tool_use");
    const tu = msg as ToolUseRequest;
    expect(tu.toolUseId).toBe("toolu_456");
    expect(tu.name).toBe("write_memory");
    expect(tu.input).toEqual({ content: "hello" });
  });

  it("parses text-only assistant message as content_delta", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Just text." }],
      },
    });
    const msg = parseLine(line) as { kind: string; text: string; index: number };
    expect(msg.kind).toBe("content_delta");
    expect(msg.text).toBe("Just text.");
    expect(msg.index).toBe(0);
  });

  it("returns dict for assistant message with empty text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "" }],
      },
    });
    const msg = parseLine(line);
    expect("kind" in msg).toBe(false);
  });

  it("parses result message", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello world",
      session_id: "sess-abc",
      cost_usd: 0.003,
      model: "claude-sonnet-4-5-20250929",
      is_error: false,
      duration_ms: 1234,
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("result");
    const res = msg as ResultMessage;
    expect(res.result).toBe("Hello world");
    expect(res.sessionId).toBe("sess-abc");
    expect(res.costUsd).toBe(0.003);
    expect(res.isError).toBe(false);
    expect(res.durationMs).toBe(1234);
  });

  it("parses result error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      result: "",
      is_error: true,
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("result");
    expect((msg as ResultMessage).isError).toBe(true);
  });

  it("returns dict for unknown type", () => {
    const line = JSON.stringify({ type: "unknown", data: 123 });
    const msg = parseLine(line);
    expect("kind" in msg).toBe(false);
    expect((msg as Record<string, unknown>).type).toBe("unknown");
  });

  it("returns dict for text content_block_start", () => {
    const line = JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const msg = parseLine(line);
    expect("kind" in msg).toBe(false);
  });

  it("returns dict for content_block_stop", () => {
    const line = JSON.stringify({ type: "content_block_stop", index: 0 });
    const msg = parseLine(line);
    expect("kind" in msg).toBe(false);
  });

  it("parses thinking_delta", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me think about this..." },
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("thinking_delta");
    const td = msg as ThinkingDelta;
    expect(td.thinking).toBe("Let me think about this...");
    expect(td.index).toBe(0);
  });

  it("returns dict for thinking content_block_start", () => {
    const line = JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    const msg = parseLine(line);
    expect("kind" in msg).toBe(false);
  });

  it("parses result with usage", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Hello",
      session_id: "sess-abc",
      cost_usd: 0.01,
      model: "claude-sonnet-4-5-20250929",
      is_error: false,
      duration_ms: 2500,
      usage: { input_tokens: 1234, output_tokens: 567 },
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("result");
    const res = msg as ResultMessage;
    expect(res.inputTokens).toBe(1234);
    expect(res.outputTokens).toBe(567);
    expect(res.durationMs).toBe(2500);
  });

  it("parses result without usage gracefully", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Hello",
      session_id: "sess-abc",
      is_error: false,
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("result");
    const res = msg as ResultMessage;
    expect(res.inputTokens).toBeNull();
    expect(res.outputTokens).toBeNull();
  });

  it("returns ParseError on invalid JSON", () => {
    const msg = parseLine("not valid json");
    expect(msg.kind).toBe("parse_error");
    const err = msg as ParseError;
    expect(err.rawLine).toBe("not valid json");
    expect(err.error).toBeTruthy();
  });

  it("parses rate_limit_event", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      retry_after_ms: 5000,
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("rate_limit");
    expect((msg as RateLimitEvent).retryAfterMs).toBe(5000);
  });

  it("parses error event", () => {
    const line = JSON.stringify({
      type: "error",
      error: "Permission denied",
      code: "permission_error",
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("error");
    const err = msg as ErrorEvent;
    expect(err.error).toBe("Permission denied");
    expect(err.code).toBe("permission_error");
  });

  it("parses multi-block assistant message as AssistantBlocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Here is the answer." },
          {
            type: "tool_use",
            id: "toolu_789",
            name: "Read",
            input: { file_path: "/foo.ts" },
          },
        ],
      },
    });
    const msg = parseLine(line);
    expect(msg.kind).toBe("assistant_blocks");
    const blocks = (msg as AssistantBlocks).blocks;
    expect(blocks.length).toBe(3);
    expect(blocks[0].kind).toBe("thinking_delta");
    expect(blocks[1].kind).toBe("content_delta");
    expect(blocks[2].kind).toBe("tool_use");
  });

  it("parses assistant message with text + tool_use (was previously losing text)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_456",
            name: "write_memory",
            input: { content: "hello" },
          },
        ],
      },
    });
    const msg = parseLine(line);
    // Now returns AssistantBlocks with both blocks instead of just the tool_use
    expect(msg.kind).toBe("assistant_blocks");
    const blocks = (msg as AssistantBlocks).blocks;
    expect(blocks.length).toBe(2);
    expect(blocks[0].kind).toBe("content_delta");
    expect(blocks[1].kind).toBe("tool_use");
  });
});

describe("formatMessages", () => {
  it("formats user message", () => {
    const result = formatUserMessage("Hello Claude");
    const data = JSON.parse(result);
    expect(data.type).toBe("user");
    expect(data.message.role).toBe("user");
    expect(data.message.content).toBe("Hello Claude");
  });

  it("formats tool result", () => {
    const result = formatToolResult("toolu_123", "Memory content here");
    const data = JSON.parse(result);
    expect(data.type).toBe("tool_result");
    expect(data.tool_use_id).toBe("toolu_123");
    expect(data.content).toBe("Memory content here");
    expect(data.is_error).toBe(false);
  });

  it("formats tool result error", () => {
    const result = formatToolResult("toolu_123", "Something went wrong", true);
    const data = JSON.parse(result);
    expect(data.is_error).toBe(true);
  });

  it("roundtrip valid JSON", () => {
    const msgs = [
      formatUserMessage("test"),
      formatToolResult("id", "result"),
      formatToolResult("id", "err", true),
    ];
    for (const msg of msgs) {
      const data = JSON.parse(msg);
      expect(typeof data).toBe("object");
      expect(data.type).toBeDefined();
    }
  });

  it("handles special chars in user message", () => {
    const result = formatUserMessage('He said "hello" & <tag>');
    const data = JSON.parse(result);
    expect(data.message.content).toBe('He said "hello" & <tag>');
  });

  it("handles multiline user message", () => {
    const result = formatUserMessage("line1\nline2\nline3");
    const data = JSON.parse(result);
    expect(data.message.content).toContain("\n");
  });
});
