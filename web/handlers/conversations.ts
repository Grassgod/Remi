import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb } from "../../src/db/index.js";
import { getSessionName } from "../../src/connectors/feishu/session-name.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────

interface ConversationSummary {
  id: string;
  chatId: string;
  threadId: string | null;
  topic: string;
  messageCount: number;
  tokenCount: number;
  totalCost: number;
  updatedAt: string;
  status: "active" | "completed";
}

interface StepItem {
  type: "thinking" | "tool";
  content: string;
  name?: string;
}

interface ChatMessage {
  id: string;
  type: "text" | "assistant";
  content: string;
  senderType: "user" | "app";
  senderId: string;
  createTime: string;
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

interface ConvPair {
  userText: string;
  remiText: string;
  steps: StepItem[];
  timestamp: number;
  sessionId: string;
}

// ── Helpers ────────────────────────────────────────────

function stripContextTags(text: string): string {
  let t = text;
  // Remove XML context/system blocks
  t = t.replace(/<context>[\s\S]*?<\/context>/g, "");
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  // Remove [Replying to: "..."]
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

// ── Handler Registration ──────────────────────────────

export function registerConversationsHandlers(app: Hono, _data: RemiData) {
  // ── GET /api/v1/conversations — List all conversations grouped by chat_id ──
  app.get("/api/v1/conversations", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 500);
    const db = getDb();

    const rows = db.query(`
      SELECT
        chat_id,
        COUNT(*) as msg_count,
        SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
        SUM(COALESCE(cost_usd, 0)) as total_cost,
        MAX(created_at) as latest,
        MAX(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as has_active
      FROM conversations
      GROUP BY chat_id
      ORDER BY latest DESC
      LIMIT ?
    `).all(limit) as {
      chat_id: string;
      msg_count: number;
      total_tokens: number;
      total_cost: number;
      latest: string;
      has_active: number;
    }[];

    const conversations: ConversationSummary[] = rows.map((row) => ({
      id: row.chat_id,
      chatId: row.chat_id,
      threadId: null,
      topic: row.chat_id.slice(0, 8),
      messageCount: row.msg_count,
      tokenCount: row.total_tokens ?? 0,
      totalCost: row.total_cost ?? 0,
      updatedAt: row.latest,
      status: row.has_active ? "active" as const : "completed" as const,
    }));

    return c.json(conversations);
  });

  // ── GET /api/v1/conversations/:chatId/messages — Reconstruct from JSONL ──
  app.get("/api/v1/conversations/:chatId/messages", (c) => {
    const chatId = c.req.param("chatId");
    const threadId = c.req.query("threadId") ?? null;
    const db = getDb();
    const claudeProjectsDir = join(homedir(), ".claude", "projects");

    try {
      // Step 1: Get session IDs for this chat
      const sessionSql = threadId
        ? "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC"
        : "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC";

      const sessionRows = threadId
        ? db.query(sessionSql).all(chatId, threadId) as any[]
        : db.query(sessionSql).all(chatId) as any[];

      const sessionIds = sessionRows.map((r: any) => r.cli_session_id as string);

      // Step 2: Get conversation metadata
      const metaSql = threadId
        ? "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
        : "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";

      const metaRows = threadId
        ? db.query(metaSql).all(chatId, threadId) as any[]
        : db.query(metaSql).all(chatId) as any[];

      // Step 3: Read JSONL files, extract enqueue → assistant pairs
      const allPairs: ConvPair[] = [];

      for (const sessionId of sessionIds) {
        // Find JSONL file across all project dirs
        let jsonlPath: string | null = null;
        try {
          for (const dir of readdirSync(claudeProjectsDir)) {
            const p = join(claudeProjectsDir, dir, sessionId + ".jsonl");
            if (existsSync(p)) { jsonlPath = p; break; }
          }
        } catch { /* projects dir may not exist */ }
        if (!jsonlPath) continue;

        const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");

        let currentEnqueue: { content: string; timestamp: number } | null = null;
        let currentText = "";
        let currentSteps: StepItem[] = [];

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);

            // User message = queue-operation enqueue
            if (obj.type === "queue-operation" && obj.operation === "enqueue" && obj.content) {
              // Flush previous pair
              if (currentEnqueue && (currentText || currentSteps.length > 0)) {
                allPairs.push({
                  userText: stripContextTags(currentEnqueue.content),
                  remiText: stripContextTags(currentText),
                  steps: currentSteps,
                  timestamp: currentEnqueue.timestamp,
                  sessionId,
                });
              }
              currentEnqueue = { content: obj.content, timestamp: obj.timestamp ?? 0 };
              currentText = "";
              currentSteps = [];
            }

            // Remi response = assistant entries with content blocks
            if (obj.type === "assistant" && currentEnqueue) {
              for (const b of (obj.message?.content ?? [])) {
                if (b.type === "text" && b.text) {
                  currentText = b.text; // last text wins
                } else if (b.type === "thinking" && b.thinking) {
                  currentSteps.push({ type: "thinking", content: b.thinking.trim() });
                } else if (b.type === "tool_use") {
                  currentSteps.push({
                    type: "tool",
                    name: b.name ?? "unknown",
                    content: b.input?.description ?? b.input?.command?.slice(0, 80) ?? b.input?.file_path ?? "",
                  });
                }
              }
            }
          } catch { /* skip malformed lines */ }
        }

        // Flush last pair
        if (currentEnqueue && (currentText || currentSteps.length > 0)) {
          allPairs.push({
            userText: stripContextTags(currentEnqueue.content),
            remiText: stripContextTags(currentText),
            steps: currentSteps,
            timestamp: currentEnqueue.timestamp,
            sessionId,
          });
        }
      }

      // Sort by timestamp
      allPairs.sort((a, b) => a.timestamp - b.timestamp);

      // Step 4: Filter to complete pairs (user text + remi text)
      const completePairs = allPairs.filter((p) => p.remiText);

      // Step 5: Build ChatMessage array
      const messages: ChatMessage[] = [];

      for (let i = 0; i < completePairs.length; i++) {
        const pair = completePairs[i];
        const meta = metaRows[i]; // sequential match: Nth pair ↔ Nth conversation row
        const createTimeMs = String(pair.timestamp);

        // User message
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

        // Remi response
        const toolSteps = pair.steps.filter((s) => s.type === "tool");
        let toolCount = toolSteps.length;
        if (meta?.spans) {
          try {
            const spans = JSON.parse(meta.spans);
            const ps = spans.find((s: any) => s.op === "provider.chat");
            if (ps?.tool_count > toolCount) toolCount = ps.tool_count;
          } catch { /* ignore malformed spans */ }
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

      return c.json(messages);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
