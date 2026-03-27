/**
 * Shared conversation parser — reconstructs chat messages from JSONL session files + DB metadata.
 * Used by both Dashboard API and Board API.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSessionName } from "../connectors/feishu/session-name.js";

// ── Types ──────────────────────────────────────────────

export interface StepItem {
  type: "thinking" | "tool";
  content: string;
  name?: string;
  thinking?: string;  // merged thinking before tool (if type=tool)
}

export interface ConvPair {
  userText: string;
  remiText: string;
  steps: StepItem[];
  timestamp: number;  // Unix ms
  sessionId: string;
}

export interface ChatMessage {
  id: string;
  type: "text" | "assistant";
  content: string;
  senderType: "user" | "app";
  senderId: string;
  createTime: string;  // Unix ms as string
  steps?: StepItem[];
  sessionName?: string;
  meta?: {
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    duration: number | null;
    toolCount: number;
    sessionId?: string;
  };
}

export interface MetaRow {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  spans: string | null;
  cli_session_id: string | null;
  sender_id: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Strip context/system tags and user name prefix from message text.
 */
export function stripContextTags(text: string): string {
  let t = text;
  t = t.replace(/<context>[\s\S]*?<\/context>/g, "");
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  const replyIdx = t.indexOf('[Replying to: "');
  if (replyIdx !== -1) {
    const closeIdx = t.indexOf('"]', replyIdx + 15);
    if (closeIdx !== -1) {
      t = t.slice(0, replyIdx) + t.slice(closeIdx + 2);
    }
  }
  t = t.replace(/^贺华杰:\s*/m, "");
  return t.trim();
}

/**
 * Find the JSONL file for a given CLI session ID across all project directories.
 */
export function findSessionJsonl(sessionId: string): string | null {
  try {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const p = join(CLAUDE_PROJECTS_DIR, dir, sessionId + ".jsonl");
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/**
 * Parse a JSONL session file into enqueue→assistant conversation pairs.
 */
export function parseSessionPairs(jsonlPath: string, sessionId: string): ConvPair[] {
  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
  const pairs: ConvPair[] = [];

  let currentEnqueue: { content: string; timestamp: number } | null = null;
  let currentText = "";
  let currentSteps: StepItem[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      // User message from BunQueue enqueue (may have empty content for image messages)
      if (obj.type === "queue-operation" && obj.operation === "enqueue") {
        // Flush previous pair
        if (currentEnqueue && currentEnqueue.content && (currentText || currentSteps.length > 0)) {
          pairs.push({
            userText: stripContextTags(currentEnqueue.content),
            remiText: stripContextTags(currentText),
            steps: currentSteps,
            timestamp: currentEnqueue.timestamp,
            sessionId,
          });
        }
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
        currentEnqueue = { content: obj.content ?? "", timestamp: ts };
        currentText = "";
        currentSteps = [];
      }

      // CLI native user entry — backfill content when enqueue had none (e.g. image messages)
      if (obj.type === "user" && currentEnqueue && !currentEnqueue.content) {
        const blocks = obj.message?.content ?? [];
        const textParts = blocks
          .filter((b: any) => b.type === "text" && b.text)
          .map((b: any) => b.text);
        if (textParts.length > 0) {
          currentEnqueue.content = textParts.join("\n");
        }
      }

      if (obj.type === "assistant" && currentEnqueue) {
        for (const b of (obj.message?.content ?? [])) {
          if (b.type === "text" && b.text) {
            currentText += (currentText ? "\n\n" : "") + b.text;
          } else if (b.type === "thinking" && b.thinking) {
            currentSteps.push({ type: "thinking", content: b.thinking.trim() });
          } else if (b.type === "tool_use") {
            const toolContent = b.input?.description
              ?? b.input?.query            // WebSearch
              ?? b.input?.url              // WebFetch
              ?? b.input?.command?.slice(0, 80)  // Bash
              ?? b.input?.file_path        // Read/Write/Edit
              ?? b.input?.pattern          // Glob/Grep
              ?? "";
            currentSteps.push({
              type: "tool",
              name: b.name ?? "unknown",
              content: toolContent,
            });
          }
        }
      }
    } catch {}
  }

  if (currentEnqueue && (currentText || currentSteps.length > 0)) {
    pairs.push({
      userText: stripContextTags(currentEnqueue.content),
      remiText: stripContextTags(currentText),
      steps: currentSteps,
      timestamp: currentEnqueue.timestamp,
      sessionId,
    });
  }

  return pairs;
}

/**
 * Find the closest metadata row by timestamp within ±30 second window.
 */
export function findClosestMeta(pairTs: number, metaByTime: Array<MetaRow & { _ts: number }>): (MetaRow & { _ts: number }) | null {
  let best: (MetaRow & { _ts: number }) | null = null;
  let bestDist = Infinity;
  for (const m of metaByTime) {
    const dist = Math.abs(m._ts - pairTs);
    if (dist < bestDist) { bestDist = dist; best = m; }
  }
  return best && bestDist < 30_000 ? best : null;
}

/**
 * Build ChatMessage[] from conversation pairs + database metadata.
 */
export function buildChatMessages(
  sessionIds: string[],
  metaRows: MetaRow[],
): ChatMessage[] {
  const allPairs: ConvPair[] = [];
  for (const sessionId of sessionIds) {
    const jsonlPath = findSessionJsonl(sessionId);
    if (!jsonlPath) continue;
    allPairs.push(...parseSessionPairs(jsonlPath, sessionId));
  }

  allPairs.sort((a, b) => a.timestamp - b.timestamp);

  const completePairs = allPairs.filter(p => p.remiText);

  const metaByTime = metaRows.map(m => ({
    ...m,
    _ts: new Date(m.created_at + "Z").getTime(),
  }));

  const messages: ChatMessage[] = [];

  for (let i = 0; i < completePairs.length; i++) {
    const pair = completePairs[i];
    const meta = findClosestMeta(pair.timestamp, metaByTime);
    const createTimeMs = String(pair.timestamp);

    if (pair.userText) {
      messages.push({
        id: `user_${i}`,
        type: "text",
        content: pair.userText,
        senderType: "user",
        senderId: meta?.sender_id ?? "",
        createTime: createTimeMs,
      });
    }

    const toolSteps = pair.steps.filter(s => s.type === "tool");
    let toolCount = toolSteps.length;
    if (meta?.spans) {
      try {
        const spans = JSON.parse(meta.spans);
        const ps = spans.find((s: any) => s.op === "provider.chat");
        if (ps?.tool_count > toolCount) toolCount = ps.tool_count;
      } catch {}
    }

    messages.push({
      id: `remi_${i}`,
      type: "assistant",
      content: pair.remiText,
      senderType: "app",
      senderId: "remi",
      createTime: String(pair.timestamp + 1),
      steps: pair.steps.length > 0 ? pair.steps : undefined,
      sessionName: getSessionName(pair.sessionId),
      meta: meta ? {
        model: meta.model,
        inputTokens: meta.input_tokens,
        outputTokens: meta.output_tokens,
        cost: meta.cost_usd,
        duration: meta.duration_ms,
        toolCount,
        sessionId: pair.sessionId,
      } : undefined,
    });
  }

  return messages;
}
