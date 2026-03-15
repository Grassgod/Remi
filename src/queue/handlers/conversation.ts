/**
 * Conversation Worker handler.
 *
 * Writes each conversation round to the conversations table,
 * and triggers memory extraction when the sliding window threshold is reached.
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
  const db = getDb();

  // 1. Write to conversations table
  db.run(
    `INSERT OR IGNORE INTO conversations
     (id, session_key, chat_id, sender, user_text, assistant_text,
      model, input_tokens, output_tokens, cost_usd, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id ?? crypto.randomUUID(),
      data.sessionKey,
      data.chatId,
      data.sender ?? null,
      data.userText,
      data.assistantText,
      data.model ?? null,
      data.inputTokens ?? null,
      data.outputTokens ?? null,
      data.costUsd ?? null,
      data.durationMs ?? null,
      data.timestamp,
    ],
  );

  log.debug(`Conversation recorded: ${data.sessionKey} (${data.model ?? "?"})`);

  // 2. Check sliding window for memory extraction
  if (queue.shouldExtractMemory(data.sessionKey)) {
    const rows = db
      .query<{ user_text: string; assistant_text: string }, [string]>(
        `SELECT user_text, assistant_text FROM conversations
         WHERE session_key = ? ORDER BY created_at DESC LIMIT 10`,
      )
      .all(data.sessionKey);

    if (rows.length === 0) return;

    const aggregated = rows
      .reverse()
      .map((r) => `User: ${r.user_text}\nAssistant: ${r.assistant_text}`)
      .join("\n---\n");

    const hash = createHash("sha256").update(aggregated).digest("hex").slice(0, 16);

    await queue.enqueueMemory({
      sessionKey: data.sessionKey,
      aggregatedText: aggregated,
      contentHash: hash,
      roundCount: rows.length,
      timestamp: new Date().toISOString(),
    });

    log.info(`Memory extraction triggered for ${data.sessionKey} (${rows.length} rounds)`);
  }
}
