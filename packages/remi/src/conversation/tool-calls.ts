// src/conversation/tool-calls.ts
import { readFileSync } from "node:fs";
import { findSessionJsonl } from "./parser.js";

export interface ToolCallData {
  name: string;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
  status: "ok" | "error";
}

/**
 * Extract tool_use → tool_result pairs from a JSONL file within a time window.
 * Returns them in chronological order with computed duration.
 */
export function extractToolCalls(
  sessionId: string,
  roundStart: string | null,
  roundEnd: string | null,
): { toolCalls: ToolCallData[]; jsonlAvailable: boolean } {
  const jsonlPath = findSessionJsonl(sessionId);
  if (!jsonlPath) return { toolCalls: [], jsonlAvailable: false };

  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");

  const startMs = roundStart ? new Date(roundStart).getTime() : 0;
  const endMs = roundEnd ? new Date(roundEnd).getTime() : Infinity;

  // Collect tool_use events and their timestamps
  const pendingTools = new Map<string, { name: string; input: Record<string, unknown>; timestamp: number }>();
  const toolCalls: ToolCallData[] = [];

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;

    // Skip events outside this round's time window
    if (ts < startMs - 5000 || ts > endMs + 5000) continue;

    if (obj.type === "assistant" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "tool_use" && block.id) {
          pendingTools.set(block.id, {
            name: block.name ?? "unknown",
            input: block.input ?? {},
            timestamp: ts,
          });
        }
      }
    }

    if (obj.type === "user" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const pending = pendingTools.get(block.tool_use_id);
          if (!pending) continue;

          const outputRaw = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");

          toolCalls.push({
            name: pending.name,
            input: truncateObj(pending.input, 500),
            output: outputRaw.slice(0, 1000),
            durationMs: Math.max(0, ts - pending.timestamp),
            status: block.is_error ? "error" : "ok",
          });
          pendingTools.delete(block.tool_use_id);
        }
      }
    }
  }

  return { toolCalls, jsonlAvailable: true };
}

function truncateObj(obj: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const str = JSON.stringify(obj);
  if (str.length <= maxChars) return obj;
  try { return JSON.parse(str.slice(0, maxChars) + '..."}}'); } catch {
    return { _truncated: str.slice(0, maxChars) };
  }
}
