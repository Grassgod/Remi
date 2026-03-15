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
      .query<{ id: number; model: string | null }, [string]>(
        `SELECT id, model FROM conversations
         WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`,
      )
      .all(data.chatId);

    if (rows.length === 0) return;

    // Build aggregated text from CLI JSONL via cli_request_id (future)
    // For now, use a simple hash of row IDs as dedup key
    const hash = createHash("sha256")
      .update(rows.map((r) => r.id).join(","))
      .digest("hex")
      .slice(0, 16);

    await queue.enqueueMemory({
      sessionKey: data.sessionKey,
      aggregatedText: `[${rows.length} rounds from ${data.chatId}]`,
      contentHash: hash,
      roundCount: rows.length,
      timestamp: new Date().toISOString(),
    });

    log.info(`Memory extraction triggered for ${data.sessionKey} (${rows.length} rounds)`);
  }
}
