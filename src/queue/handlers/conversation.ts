/**
 * Conversation Worker handler.
 *
 * Triggers memory extraction via sliding window.
 * Conversation recording is now done directly in core.ts → insertConversation().
 * CLI JSONL (~/.claude/projects/) is the full trace source of truth.
 */

import { createHash } from "node:crypto";
import type { Job } from "bunqueue/client";
import type { ConversationJobData } from "../queues.js";
import { getDb } from "../../db/index.js";
import { createLogger } from "../../logger.js";
import { findSessionJsonl, parseSessionPairs } from "../../conversation/parser.js";
import type { RemiQueueManager } from "../index.js";

const log = createLogger("queue:conversation");

export async function handleConversationJob(
  job: Job<ConversationJobData>,
  queue: RemiQueueManager,
): Promise<void> {
  const data = job.data;

  // Sliding window → memory extraction trigger
  if (queue.shouldExtractMemory(data.sessionKey)) {
    const db = getDb();
    const rows = db
      .query<
        { id: number; cli_session_id: string | null; cli_cwd: string | null },
        [string]
      >(
        `SELECT id, cli_session_id, cli_cwd FROM conversations
         WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`,
      )
      .all(data.chatId);

    if (rows.length === 0) return;

    const hash = createHash("sha256")
      .update(rows.map((r) => r.id).join(","))
      .digest("hex")
      .slice(0, 16);

    // Infer primary cwd for the conversation: most recent non-null
    const cwd = rows.find((r) => r.cli_cwd)?.cli_cwd ?? undefined;

    // Aggregate real conversation text from CLI JSONL
    // Dedupe by session_id; take last 3 pairs per session
    const parts: string[] = [];
    const seenSessions = new Set<string>();
    for (const row of rows) {
      if (!row.cli_session_id || seenSessions.has(row.cli_session_id)) continue;
      seenSessions.add(row.cli_session_id);
      const jsonlPath = findSessionJsonl(row.cli_session_id);
      if (!jsonlPath) continue;
      try {
        const pairs = parseSessionPairs(jsonlPath, row.cli_session_id).slice(-3);
        for (const p of pairs) {
          if (p.userText) parts.push(`User: ${p.userText.slice(0, 500)}`);
          if (p.remiText) parts.push(`Remi: ${p.remiText.slice(0, 500)}`);
        }
      } catch (err) {
        log.warn(`Failed to parse JSONL for ${row.cli_session_id}: ${err}`);
      }
    }

    const aggregatedText = parts.length > 0
      ? parts.join("\n\n").slice(0, 8000)
      : `[${rows.length} rounds from ${data.chatId} — no JSONL found]`;

    await queue.enqueueMemory({
      sessionKey: data.sessionKey,
      aggregatedText,
      contentHash: hash,
      roundCount: rows.length,
      timestamp: new Date().toISOString(),
      cwd,
    });

    log.info(
      `Memory extraction triggered for ${data.sessionKey} (${rows.length} rounds, cwd=${cwd ?? "none"}, text=${aggregatedText.length}b)`,
    );
  }
}
