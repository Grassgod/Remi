/**
 * Conversation Worker handler.
 *
 * Dual-write pattern:
 *   1. JSONL file (source of truth) — complete events including tool calls, thinking
 *   2. SQLite conversations table (derived view) — structured summary for queries/dashboard
 *
 * Also triggers memory extraction via sliding window.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Job } from "bunqueue/client";
import type { ConversationJobData } from "../queues.js";
import { getDb } from "../../db/index.js";
import { createLogger } from "../../logger.js";
import type { RemiQueueManager } from "../index.js";

const log = createLogger("queue:conversation");

/** JSONL trace directory: ~/.remi/traces/{chatId}/ */
function getTraceDir(chatId: string): string {
  const dir = join(homedir(), ".remi", "traces", chatId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export async function handleConversationJob(
  job: Job<ConversationJobData>,
  queue: RemiQueueManager,
): Promise<void> {
  const data = job.data;

  // ═══════════════════════════════════════════════════
  //  1. JSONL — source of truth (append-only, complete)
  // ═══════════════════════════════════════════════════
  const traceDir = getTraceDir(data.chatId);
  const today = new Date().toISOString().slice(0, 10); // 2026-03-15
  const tracePath = join(traceDir, `${today}.jsonl`);

  const traceRecord = {
    ts: data.timestamp,
    sessionKey: data.sessionKey,
    chatId: data.chatId,
    sender: data.sender,
    connector: data.connector,
    userText: data.userText,
    assistantText: data.assistantText,
    thinking: data.thinking,
    toolCalls: data.toolCalls,
    events: data.events,
    model: data.model,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    costUsd: data.costUsd,
    durationMs: data.durationMs,
  };

  try {
    appendFileSync(tracePath, JSON.stringify(traceRecord) + "\n", "utf-8");
  } catch (e) {
    log.error(`Failed to write JSONL trace: ${e}`);
    // Don't throw — SQLite write can still proceed
  }

  // ═══════════════════════════════════════════════════
  //  2. SQLite — derived summary (structured, queryable)
  // ═══════════════════════════════════════════════════
  const db = getDb();
  try {
    db.run(
      `INSERT OR IGNORE INTO conversations
       (id, session_key, chat_id, sender, user_text, assistant_text,
        model, input_tokens, output_tokens, cost_usd, duration_ms,
        tool_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.toolCalls?.length ?? 0,
        data.timestamp,
      ],
    );
  } catch (e) {
    log.error(`Failed to write SQLite conversation: ${e}`);
  }

  log.debug(`Conversation recorded: ${data.sessionKey} [JSONL+SQLite]`);

  // ═══════════════════════════════════════════════════
  //  3. Sliding window → memory extraction trigger
  // ═══════════════════════════════════════════════════
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
