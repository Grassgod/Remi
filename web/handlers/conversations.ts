import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb } from "../../src/db/index.js";
import { buildChatMessages, stripContextTags, findSessionJsonl, parseSessionPairs } from "../../src/conversation/parser.js";
import type { MetaRow } from "../../src/conversation/parser.js";

// ── Handler Registration ──────────────────────────────

/** Clean topic text: strip noise from raw user_message to get a readable title */
function cleanTopic(raw: string): string {
  let t = stripContextTags(raw);
  // Remove AskUserQuestion reply prefix
  t = t.replace(/^用户回答了之前的问题:\s*[\s\S]*?:\s*/m, "");
  // Remove <media:image> tags and their JSON payload (either order)
  t = t.replace(/<media:image>\s*(\{[^}]*\})?/g, "");
  t = t.replace(/\{"image_key":[^}]*\}/g, "");
  // Remove skill activation prefix
  t = t.replace(/^Base directory for this skill:\s*\S+\.?\s*/m, "");
  // Remove "Continue from where you left off." (auto-resume)
  t = t.replace(/^Continue from where you left off\.?\s*/m, "");
  return t.trim().slice(0, 80) || "Untitled";
}

/** Get a readable name for a chat_id */
function getChatName(db: any, chatId: string, isP2P: boolean): string {
  if (isP2P) {
    // For P2P, show the sender name (who the user is chatting with)
    const sender = db.query(
      "SELECT sender_id FROM conversations WHERE chat_id = ? AND sender_id IS NOT NULL AND sender_id != '' ORDER BY created_at ASC LIMIT 1"
    ).get(chatId) as { sender_id: string } | null;
    if (sender?.sender_id) return sender.sender_id;
  }
  // For groups, use the first user_message as a short label
  const row = db.query(
    "SELECT user_message FROM conversations WHERE chat_id = ? AND user_message IS NOT NULL AND user_message != '' ORDER BY created_at ASC LIMIT 1"
  ).get(chatId) as { user_message: string } | null;
  if (row) {
    let name = cleanTopic(row.user_message);
    name = name.replace(/^#+\s*/gm, "").replace(/!\[.*?\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
    if (name && name !== "Untitled") return name.slice(0, 30);
  }
  return chatId.slice(0, 16);
}

export function registerConversationsHandlers(app: Hono, _data: RemiData) {

  // ── GET /api/v1/chats — List distinct chats with stats ──
  app.get("/api/v1/chats", (c) => {
    const db = getDb();
    const rows = db.query(`
      SELECT
        chat_id,
        COUNT(*) as msg_count,
        COUNT(DISTINCT CASE WHEN thread_id IS NOT NULL AND thread_id != '' THEN chat_id || ':' || thread_id ELSE chat_id END) as conv_count,
        MAX(CASE WHEN thread_id IS NULL OR thread_id = '' THEN 1 ELSE 0 END) as has_no_thread
      FROM conversations
      GROUP BY chat_id
      ORDER BY msg_count DESC
    `).all() as { chat_id: string; msg_count: number; conv_count: number; has_no_thread: number }[];

    const chats = rows.map(r => ({
      chatId: r.chat_id,
      name: getChatName(db, r.chat_id, r.has_no_thread === 1 && r.conv_count <= 1),
      conversationCount: r.conv_count,
      messageCount: r.msg_count,
      isP2P: r.has_no_thread === 1 && r.conv_count <= 1,
    }));

    return c.json(chats);
  });

  // ── GET /api/v1/conversations — List conversations grouped by chat_id + thread_id ──
  app.get("/api/v1/conversations", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 500);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10), 0);
    const filterChatId = c.req.query("chatId") ?? null;
    const db = getDb();

    const chatFilter = filterChatId ? "WHERE c.chat_id = ?" : "";
    const params = filterChatId ? [filterChatId, limit, offset] : [limit, offset];

    const rows = db.query(`
      SELECT
        c.chat_id,
        c.thread_id,
        COUNT(*) as msg_count,
        SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)) as total_tokens,
        SUM(COALESCE(c.cost_usd, 0)) as total_cost,
        MAX(c.created_at) as latest,
        MAX(CASE WHEN c.status = 'processing' THEN 1 ELSE 0 END) as has_active,
        (SELECT c2.user_message FROM conversations c2
         WHERE c2.chat_id = c.chat_id
           AND COALESCE(c2.thread_id, '') = COALESCE(c.thread_id, '')
           AND c2.user_message IS NOT NULL AND c2.user_message != ''
         ORDER BY c2.created_at ASC LIMIT 1
        ) as first_message
      FROM conversations c
      ${chatFilter}
      GROUP BY c.chat_id, COALESCE(c.thread_id, '')
      ORDER BY latest DESC
      LIMIT ? OFFSET ?
    `).all(...params) as {
      chat_id: string;
      thread_id: string | null;
      msg_count: number;
      total_tokens: number;
      total_cost: number;
      latest: string;
      has_active: number;
      first_message: string | null;
    }[];

    const conversations = rows.map((row) => {
      let topic = row.first_message ? cleanTopic(row.first_message) : "Untitled";

      // Fallback: when DB has no user_message, peek at JSONL for the first enqueue
      if (topic === "Untitled") {
        try {
          const sessionSql = row.thread_id
            ? "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC LIMIT 1"
            : "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND (thread_id IS NULL OR thread_id = '') AND cli_session_id IS NOT NULL ORDER BY created_at ASC LIMIT 1";
          const sessionRow = (row.thread_id
            ? db.query(sessionSql).get(row.chat_id, row.thread_id)
            : db.query(sessionSql).get(row.chat_id)) as { cli_session_id: string } | null;

          if (sessionRow) {
            const jsonlPath = findSessionJsonl(sessionRow.cli_session_id);
            if (jsonlPath) {
              const pairs = parseSessionPairs(jsonlPath, sessionRow.cli_session_id);
              const firstUser = pairs.find(p => p.userText);
              if (firstUser) topic = cleanTopic(firstUser.userText);
            }
          }
        } catch {}
      }

      return {
        id: row.thread_id ? `${row.chat_id}:${row.thread_id}` : row.chat_id,
        chatId: row.chat_id,
        threadId: row.thread_id ?? null,
        topic,
        messageCount: row.msg_count,
        tokenCount: row.total_tokens ?? 0,
        totalCost: row.total_cost ?? 0,
        updatedAt: row.latest,
        status: row.has_active ? "active" as const : "completed" as const,
      };
    });

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
