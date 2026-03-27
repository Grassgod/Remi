import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb } from "../../src/db/index.js";
import { buildChatMessages } from "../../src/conversation/parser.js";
import type { MetaRow } from "../../src/conversation/parser.js";

// ── Handler Registration ──────────────────────────────

export function registerConversationsHandlers(app: Hono, _data: RemiData) {
  // ── GET /api/v1/conversations — List conversations grouped by chat_id + thread_id ──
  app.get("/api/v1/conversations", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 500);
    const db = getDb();

    const rows = db.query(`
      SELECT
        chat_id,
        thread_id,
        COUNT(*) as msg_count,
        SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
        SUM(COALESCE(cost_usd, 0)) as total_cost,
        MAX(created_at) as latest,
        MAX(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as has_active,
        MIN(user_message) as first_message
      FROM conversations
      GROUP BY chat_id, COALESCE(thread_id, '')
      ORDER BY latest DESC
      LIMIT ?
    `).all(limit) as {
      chat_id: string;
      thread_id: string | null;
      msg_count: number;
      total_tokens: number;
      total_cost: number;
      latest: string;
      has_active: number;
      first_message: string | null;
    }[];

    const conversations = rows.map((row) => ({
      id: row.thread_id ? `${row.chat_id}:${row.thread_id}` : row.chat_id,
      chatId: row.chat_id,
      threadId: row.thread_id ?? null,
      topic: row.first_message?.slice(0, 60) || row.chat_id.slice(0, 12),
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

    try {
      // Step 1: Get session IDs
      const sessionSql = threadId
        ? "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC"
        : "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC";

      const sessionRows = (threadId
        ? db.query(sessionSql).all(chatId, threadId)
        : db.query(sessionSql).all(chatId)) as { cli_session_id: string }[];

      const sessionIds = sessionRows.map(r => r.cli_session_id);

      // Step 2: Get conversation metadata
      const metaSql = threadId
        ? "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
        : "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";

      const metaRows = (threadId
        ? db.query(metaSql).all(chatId, threadId)
        : db.query(metaSql).all(chatId)) as MetaRow[];

      // Step 3: Use shared parser
      const messages = buildChatMessages(sessionIds, metaRows);

      return c.json(messages);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
