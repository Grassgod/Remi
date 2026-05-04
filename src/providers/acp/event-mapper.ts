/**
 * Maps ACP session update notifications to Remi StreamEvent.
 * Agent-specific logic (tool name resolution, meta parsing) is delegated to the adapter.
 */

import type { StreamEvent } from "../base.js";
import type {
  SessionUpdate,
  ToolCallUpdate,
  ToolCallProgressUpdate,
  ContentBlock,
  UsageUpdate,
} from "./protocol.js";
import type { AgentAdapter } from "./adapters/base.js";

/** Accumulated state needed for mapping tool events. */
export interface MapperState {
  /** Map toolCallId → tool name. */
  toolNames: Map<string, string>;
  /** Map toolCallId → start timestamp for duration calculation. */
  toolStartTimes: Map<string, number>;
  /** Map toolCallId → resolved input (from later tool_call_update when rawInput arrives). */
  toolInputs: Map<string, Record<string, unknown>>;
  /** Completed tool calls for AgentResponse.toolCalls. */
  completedTools: Array<{ name: string; durationMs?: number }>;
  /** Prompt start time for overall duration. */
  promptStartTime: number;
  /** Accumulated usage from usage_update notifications. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    model: string | null;
    contextWindowSize: number | null;
  };
}

export function createMapperState(): MapperState {
  return {
    toolNames: new Map(),
    toolStartTimes: new Map(),
    toolInputs: new Map(),
    completedTools: [],
    promptStartTime: Date.now(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      model: null,
      contextWindowSize: null,
    },
  };
}

/**
 * Convert a single ACP session update into zero or more StreamEvents.
 * Agent-specific behavior is provided by the adapter.
 */
export function mapSessionUpdate(
  update: SessionUpdate,
  state: MapperState,
  adapter: AgentAdapter,
): StreamEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return mapContentChunk(update.content);

    case "agent_thought_chunk":
      return mapThoughtChunk(update.content);

    case "user_message_chunk":
      return [];

    case "tool_call":
      if (process.env.REMI_DEBUG) {
        const tc = update as any;
        console.error(`[event-mapper] tool_call: title=${tc.title} rawInput=${JSON.stringify(tc.rawInput)?.slice(0, 100)} keys=${Object.keys(tc)}`);
      }
      return mapToolCall(update as ToolCallUpdate, state, adapter);

    case "tool_call_update":
      return mapToolCallUpdate(update as ToolCallProgressUpdate, state, adapter);

    case "usage_update":
      return mapUsageUpdate(update as UsageUpdate, state);

    case "plan":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "available_commands_update":
      return [];

    default:
      return [];
  }
}

// ── Content mapping ──────────────────────────────────────────────

function mapContentChunk(content: ContentBlock[] | ContentBlock): StreamEvent[] {
  const blocks = Array.isArray(content) ? content : [content];
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      events.push({ kind: "content_delta", text: block.text });
    }
  }
  return events;
}

function mapThoughtChunk(content: ContentBlock[] | ContentBlock): StreamEvent[] {
  const blocks = Array.isArray(content) ? content : [content];
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      events.push({ kind: "thinking_delta", text: block.text });
    }
  }
  return events;
}

// ── Tool mapping (delegates to adapter) ──────────────────────────

function mapToolCall(update: ToolCallUpdate, state: MapperState, adapter: AgentAdapter): StreamEvent[] {
  const toolName = adapter.resolveToolName(update);
  state.toolNames.set(update.toolCallId, toolName);
  state.toolStartTimes.set(update.toolCallId, Date.now());

  const input = adapter.extractToolInput(update);

  return [{
    kind: "tool_use",
    name: toolName,
    toolUseId: update.toolCallId,
    input,
  }];
}

function mapToolCallUpdate(update: ToolCallProgressUpdate, state: MapperState, adapter: AgentAdapter): StreamEvent[] {
  if (!update.status || (update.status !== "completed" && update.status !== "failed")) {
    // In-progress update — extract and store input if this is the first one with real data
    if (!state.toolInputs.has(update.toolCallId)) {
      const input = adapter.extractToolInput(update);
      if (input && Object.keys(input).length > 0) {
        state.toolInputs.set(update.toolCallId, input);
      }
    }
    return [];
  }

  const toolName = state.toolNames.get(update.toolCallId) ?? update.title ?? "unknown";
  const startTime = state.toolStartTimes.get(update.toolCallId);
  const durationMs = startTime ? Date.now() - startTime : undefined;

  state.toolNames.delete(update.toolCallId);
  state.toolStartTimes.delete(update.toolCallId);
  const storedInput = state.toolInputs.get(update.toolCallId);
  state.toolInputs.delete(update.toolCallId);
  state.completedTools.push({ name: toolName, durationMs });

  const resultPreview = adapter.extractResultPreview(update);

  return [{
    kind: "tool_result",
    toolUseId: update.toolCallId,
    name: toolName,
    resultPreview,
    durationMs,
    input: storedInput,
  }];
}

// ── Usage mapping (agent-agnostic) ───────────────────────────────

function mapUsageUpdate(update: Record<string, any>, state: MapperState): StreamEvent[] {
  // ACP usage_update: { used, size, cost?: { amount, currency } }
  // SDK/normalized: { inputTokens, outputTokens, cacheReadTokens, ... }
  const u = update.usage ?? update;

  // Normalized format (from SDK direct)
  if (u.inputTokens != null) state.usage.inputTokens = u.inputTokens;
  if (u.outputTokens != null) state.usage.outputTokens = u.outputTokens;
  if (u.cacheReadTokens != null) state.usage.cacheReadTokens = u.cacheReadTokens;
  if (u.cacheWriteTokens != null) state.usage.cacheWriteTokens = u.cacheWriteTokens;
  if (u.model) state.usage.model = u.model;
  if (u.costUsd != null) state.usage.costUsd = u.costUsd;
  if (u.contextWindowSize != null) state.usage.contextWindowSize = u.contextWindowSize;

  // ACP format: `used` is total tokens consumed (not split into in/out)
  if (u.used != null) {
    // Store in inputTokens as "total used", set outputTokens to 0
    // so stats bar shows "238157" instead of "238157→?"
    state.usage.inputTokens = u.used;
    state.usage.outputTokens = 0;
  }
  if (u.size != null) state.usage.contextWindowSize = u.size;
  if (u.cost?.amount != null) state.usage.costUsd = u.cost.amount;
  return [];
}
