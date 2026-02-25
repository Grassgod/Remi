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
}

export type ParsedMessage =
  | SystemMessage
  | ContentDelta
  | ToolUseRequest
  | ResultMessage
  | Record<string, unknown>;

// ── Parsing (stdout line -> typed message) ─────────────────────

export function parseLine(line: string): ParsedMessage {
  const data = JSON.parse(line) as Record<string, unknown>;
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
    return data;
  }

  // Assistant message with complete tool_use blocks (non-streaming path)
  if (msgType === "assistant") {
    const message = (data.message as Record<string, unknown>) ?? {};
    const content = (message.content as Array<Record<string, unknown>>) ?? [];
    const toolBlocks = content.filter((b) => b.type === "tool_use");
    if (toolBlocks.length > 0) {
      const block = toolBlocks[0];
      return {
        kind: "tool_use",
        toolUseId: (block.id as string) ?? "",
        name: (block.name as string) ?? "",
        input: (block.input as Record<string, unknown>) ?? {},
      };
    }
    return data;
  }

  // Result (end of turn)
  if (msgType === "result") {
    return {
      kind: "result",
      result: (data.result as string) ?? "",
      sessionId: (data.session_id as string) ?? "",
      costUsd: (data.cost_usd as number) ?? null,
      model: (data.model as string) ?? "",
      isError: (data.is_error as boolean) ?? false,
      durationMs: (data.duration_ms as number) ?? null,
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
