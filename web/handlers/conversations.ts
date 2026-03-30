import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { getDb } from "../../src/db/index.js";
import { GroupConfigStore } from "../../src/group/store.js";
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
  // Replace markdown images with [image] marker
  t = t.replace(/!\[image\]\([^)]*\)/g, "[image]");
  return t.trim().slice(0, 80) || "Untitled";
}

// Chat name cache: prioritizes group_configs DB, falls back to Feishu API
let _gcNameMap: Map<string, string> | null = null;

function getGroupNameMap(): Map<string, string> {
  if (!_gcNameMap) {
    try {
      _gcNameMap = new GroupConfigStore().getNameMap();
    } catch {
      _gcNameMap = new Map();
    }
  }
  return _gcNameMap;
}

/** Invalidate cache so next call re-reads from DB (call after name updates). */
export function invalidateGroupNameCache(): void {
  _gcNameMap = null;
}

/** Get a readable name for a chat_id */
function getChatName(db: any, chatId: string, isP2P: boolean): string {
  // 1. group_configs DB (populated by migration or Feishu API sync)
  const gcName = getGroupNameMap().get(chatId);
  if (gcName) return gcName;

  // 2. P2P: show sender name
  if (isP2P) {
    const sender = db.query(
      "SELECT sender_id FROM conversations WHERE chat_id = ? AND sender_id IS NOT NULL AND sender_id != '' ORDER BY created_at ASC LIMIT 1"
    ).get(chatId) as { sender_id: string } | null;
    if (sender?.sender_id) return sender.sender_id;
  }

  return chatId.slice(0, 16);
}

export function registerConversationsHandlers(app: Hono, _data: RemiData) {

  // ── GET /api/v1/chats — List distinct chats with stats ──
  app.get("/api/v1/chats", async (c) => {
    const db = getDb();
    const rows = db.query(`
      SELECT
        chat_id,
        COUNT(*) as msg_count,
        COUNT(DISTINCT CASE WHEN thread_id IS NOT NULL AND thread_id != '' THEN chat_id || ':' || thread_id ELSE chat_id END) as conv_count,
        COUNT(DISTINCT cli_session_id) as session_count,
        MAX(CASE WHEN thread_id IS NULL OR thread_id = '' THEN 1 ELSE 0 END) as has_no_thread
      FROM conversations
      GROUP BY chat_id
      ORDER BY msg_count DESC
    `).all() as { chat_id: string; msg_count: number; conv_count: number; session_count: number; has_no_thread: number }[];

    const chats = rows.map(r => {
      const isP2P = r.has_no_thread === 1 && r.conv_count <= 1;
      return {
        chatId: r.chat_id,
        name: getChatName(db, r.chat_id, isP2P),
        conversationCount: isP2P ? r.session_count : r.conv_count,
        messageCount: r.msg_count,
        isP2P,
      };
    });

    // Sort: Groups first (by msg count), then P2P (by msg count)
    chats.sort((a, b) => {
      if (a.isP2P !== b.isP2P) return a.isP2P ? 1 : -1;
      return b.messageCount - a.messageCount;
    });

    return c.json(chats);
  });

  // ── GET /api/v1/conversations — List conversations ──
  // Group chats: group by thread_id (each topic = one conversation)
  // P2P chats: group by cli_session_id (each session = one conversation)
  app.get("/api/v1/conversations", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 500);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10), 0);
    const filterChatId = c.req.query("chatId") ?? null;
    const db = getDb();

    // Identify P2P chat_ids (no thread_id in any row)
    const p2pChatIds = new Set(
      (db.query(
        "SELECT chat_id FROM conversations GROUP BY chat_id HAVING MAX(CASE WHEN thread_id IS NOT NULL AND thread_id != '' THEN 1 ELSE 0 END) = 0"
      ).all() as { chat_id: string }[]).map(r => r.chat_id)
    );

    const isFilterP2P = filterChatId ? p2pChatIds.has(filterChatId) : false;

    // For P2P: group by cli_session_id
    // For Group: group by thread_id (existing logic)
    let rows: { chat_id: string; thread_id: string | null; cli_session_id: string | null; msg_count: number; total_tokens: number; total_cost: number; latest: string; has_active: number; first_message: string | null }[];

    if (filterChatId && isFilterP2P) {
      // P2P: group by session
      rows = db.query(`
        SELECT
          c.chat_id,
          NULL as thread_id,
          c.cli_session_id,
          COUNT(*) as msg_count,
          SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)) as total_tokens,
          SUM(COALESCE(c.cost_usd, 0)) as total_cost,
          MAX(c.created_at) as latest,
          MAX(CASE WHEN c.status = 'processing' AND c.created_at > datetime('now', '-1 hour') THEN 1 ELSE 0 END) as has_active,
          (SELECT c2.user_message FROM conversations c2
           WHERE c2.cli_session_id = c.cli_session_id
             AND c2.user_message IS NOT NULL AND c2.user_message != ''
           ORDER BY c2.created_at ASC LIMIT 1
          ) as first_message
        FROM conversations c
        WHERE c.chat_id = ? AND c.cli_session_id IS NOT NULL
        GROUP BY c.cli_session_id
        ORDER BY latest DESC
        LIMIT ? OFFSET ?
      `).all(filterChatId, limit, offset) as any[];
    } else {
      // Group chats (or All): group by thread_id
      const chatFilter = filterChatId ? "WHERE c.chat_id = ?" : "";
      // Exclude P2P from "All" view or include them grouped by session
      const params = filterChatId ? [filterChatId, limit, offset] : [limit, offset];

      rows = db.query(`
        SELECT
          c.chat_id,
          c.thread_id,
          NULL as cli_session_id,
          COUNT(*) as msg_count,
          SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)) as total_tokens,
          SUM(COALESCE(c.cost_usd, 0)) as total_cost,
          MAX(c.created_at) as latest,
          MAX(CASE WHEN c.status = 'processing' AND c.created_at > datetime('now', '-1 hour') THEN 1 ELSE 0 END) as has_active,
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
      `).all(...params) as any[];
    }

    const conversations = rows.map((row) => {
      let topic = row.first_message ? cleanTopic(row.first_message) : "Untitled";

      // Fallback: when DB has no user_message, peek at JSONL for the first enqueue
      if (topic === "Untitled") {
        try {
          const sid = row.cli_session_id;
          const sessionSql = sid
            ? null // Already have session ID for P2P
            : row.thread_id
              ? "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC LIMIT 1"
              : "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND (thread_id IS NULL OR thread_id = '') AND cli_session_id IS NOT NULL ORDER BY created_at ASC LIMIT 1";
          const resolvedSid = sid ?? ((sessionSql
            ? (row.thread_id
              ? db.query(sessionSql).get(row.chat_id, row.thread_id)
              : db.query(sessionSql).get(row.chat_id)) as { cli_session_id: string } | null
            : null)?.cli_session_id ?? null);

          if (resolvedSid) {
            const jsonlPath = findSessionJsonl(resolvedSid);
            if (jsonlPath) {
              const pairs = parseSessionPairs(jsonlPath, resolvedSid);
              const firstUser = pairs.find(p => p.userText);
              if (firstUser) topic = cleanTopic(firstUser.userText);
            }
          }
        } catch {}
      }

      // For P2P sessions, use session ID in the composite key
      const id = row.cli_session_id
        ? `${row.chat_id}:session:${row.cli_session_id}`
        : row.thread_id
          ? `${row.chat_id}:${row.thread_id}`
          : row.chat_id;

      return {
        id,
        chatId: row.chat_id,
        threadId: row.thread_id ?? null,
        sessionId: row.cli_session_id ?? null,
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
    const sessionId = c.req.query("sessionId") ?? null;
    const db = getDb();

    try {
      let sessionIds: string[];
      let metaRows: MetaRow[];

      if (sessionId) {
        // P2P: single session
        sessionIds = [sessionId];
        metaRows = db.query(
          "SELECT id, model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE cli_session_id = ? AND status = 'completed' ORDER BY created_at ASC"
        ).all(sessionId) as MetaRow[];
      } else {
        // Group: by thread_id
        const sessionSql = threadId
          ? "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND thread_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC"
          : "SELECT DISTINCT cli_session_id FROM conversations WHERE chat_id = ? AND cli_session_id IS NOT NULL ORDER BY created_at ASC";
        const sessionRows = (threadId
          ? db.query(sessionSql).all(chatId, threadId)
          : db.query(sessionSql).all(chatId)) as { cli_session_id: string }[];
        sessionIds = sessionRows.map(r => r.cli_session_id);

        const metaSql = threadId
          ? "SELECT id, model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND thread_id = ? AND status = 'completed' ORDER BY created_at ASC"
          : "SELECT id, model, input_tokens, output_tokens, cost_usd, duration_ms, spans, cli_session_id, sender_id, created_at FROM conversations WHERE chat_id = ? AND status = 'completed' ORDER BY created_at ASC";
        metaRows = (threadId
          ? db.query(metaSql).all(chatId, threadId)
          : db.query(metaSql).all(chatId)) as MetaRow[];
      }

      const messages = buildChatMessages(sessionIds, metaRows);
      return c.json(messages);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
