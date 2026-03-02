/**
 * JSONL streaming protocol — message types + parse/format (no I/O).
 *
 * Handles the Claude CLI stream-json protocol:
 * - Parse: stdout JSONL lines -> typed objects
 * - Format: typed data -> stdin JSONL strings
 */

// ── Parsed message types (CLI stdout -> Remi) ─────────────────

export interface SystemMessage {
  kind: "system";
  sessionId: string;
  tools: Array<Record<string, unknown>>;
  model: string;
  mcpServers: Array<Record<string, unknown>>;
}

export interface ContentDelta {
  kind: "content_delta";
  text: string;
  index: number;
}

export interface ThinkingDelta {
  kind: "thinking_delta";
  thinking: string;
  index: number;
}

export interface ToolUseRequest {
  kind: "tool_use";
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ResultMessage {
  kind: "result";
  result: string;
  sessionId: string;
  costUsd: number | null;
  model: string;
  isError: boolean;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ToolResultMessage {
  kind: "tool_result";
  toolUseId: string;
  name: string;
  result: string;       // truncated preview (first 1500 chars)
  durationMs: number;
}

export interface ParseError {
  kind: "parse_error";
  rawLine: string;
  error: string;
}

export interface RateLimitEvent {
  kind: "rate_limit";
  retryAfterMs: number;
}

export interface ErrorEvent {
  kind: "error";
  error: string;
  code: string;
}

export interface AssistantBlocks {
  kind: "assistant_blocks";
  blocks: ParsedMessage[];
}

export type ParsedMessage =
  | SystemMessage
  | ContentDelta
  | ThinkingDelta
  | ToolUseRequest
  | ToolResultMessage
  | ResultMessage
  | ParseError
  | RateLimitEvent
  | ErrorEvent
  | AssistantBlocks
  | Record<string, unknown>;

// ── Parsing (stdout line -> typed message) ─────────────────────

export function parseLine(line: string): ParsedMessage {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch (e) {
    return {
      kind: "parse_error",
      rawLine: line.slice(0, 500),
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const msgType = (data.type as string) ?? "";

  // System init
  if (msgType === "system" && data.subtype === "init") {
    return {
      kind: "system",
      sessionId: (data.session_id as string) ?? "",
      tools: (data.tools as Array<Record<string, unknown>>) ?? [],
      model: (data.model as string) ?? "",
      mcpServers: (data.mcp_servers as Array<Record<string, unknown>>) ?? [],
    };
  }

  // Streaming text delta (only text_delta, not input_json_delta)
  if (msgType === "content_block_delta") {
    const delta = (data.delta as Record<string, unknown>) ?? {};
    if (delta.type === "text_delta") {
      return {
        kind: "content_delta",
        text: (delta.text as string) ?? "",
        index: (data.index as number) ?? 0,
      };
    }
    if (delta.type === "thinking_delta") {
      return {
        kind: "thinking_delta",
        thinking: (delta.thinking as string) ?? "",
        index: (data.index as number) ?? 0,
      };
    }
    // input_json_delta and others: return raw dict for accumulation
    return data;
  }

  // Tool use start (streaming content_block_start)
  if (msgType === "content_block_start") {
    const block = (data.content_block as Record<string, unknown>) ?? {};
    if (block.type === "tool_use") {
      return {
        kind: "tool_use",
        toolUseId: (block.id as string) ?? "",
        name: (block.name as string) ?? "",
        input: (block.input as Record<string, unknown>) ?? {},
      };
    }
    // thinking block start — return raw dict (like text block)
    return data;
  }

  // Assistant message with complete content blocks (non-streaming path)
  if (msgType === "assistant") {
    const message = (data.message as Record<string, unknown>) ?? {};
    const content = (message.content as Array<Record<string, unknown>>) ?? [];

    // Parse all blocks into typed messages
    const parsed: ParsedMessage[] = [];
    for (const block of content) {
      if (block.type === "thinking") {
        parsed.push({
          kind: "thinking_delta",
          thinking: (block.thinking as string) ?? "",
          index: 0,
        });
      } else if (block.type === "tool_use") {
        parsed.push({
          kind: "tool_use",
          toolUseId: (block.id as string) ?? "",
          name: (block.name as string) ?? "",
          input: (block.input as Record<string, unknown>) ?? {},
        });
      } else if (block.type === "text" && (block.text as string)) {
        parsed.push({
          kind: "content_delta",
          text: (block.text as string),
          index: 0,
        });
      }
    }

    if (parsed.length === 0) return data;
    if (parsed.length === 1) return parsed[0];
    return { kind: "assistant_blocks", blocks: parsed };
  }

  // Rate limit event
  if (msgType === "rate_limit_event" || msgType === "rate_limit") {
    return {
      kind: "rate_limit",
      retryAfterMs: (data.retry_after_ms as number) ?? ((data.retry_after as number) ?? 0) * 1000,
    };
  }

  // Error event
  if (msgType === "error") {
    return {
      kind: "error",
      error: (data.error as string) ?? JSON.stringify(data),
      code: (data.code as string) ?? "unknown",
    };
  }

  // Result (end of turn)
  if (msgType === "result") {
    const usage = (data.usage as Record<string, unknown>) ?? {};
    return {
      kind: "result",
      result: (data.result as string) ?? "",
      sessionId: (data.session_id as string) ?? "",
      costUsd: (data.cost_usd as number) ?? null,
      model: (data.model as string) ?? "",
      isError: (data.is_error as boolean) ?? false,
      durationMs: (data.duration_ms as number) ?? null,
      inputTokens: (usage.input_tokens as number) ?? null,
      outputTokens: (usage.output_tokens as number) ?? null,
    };
  }

  return data;
}

// ── Formatting (Remi -> CLI stdin) ─────────────────────────────

export function formatUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}

export function formatToolResult(
  toolUseId: string,
  result: string,
  isError: boolean = false,
): string {
  return JSON.stringify({
    type: "tool_result",
    tool_use_id: toolUseId,
    content: result,
    is_error: isError,
  });
}
