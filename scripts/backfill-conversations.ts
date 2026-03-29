#!/usr/bin/env bun
/**
 * Backfill thread_id and user_message for existing conversations.
 *
 * Data sources:
 * - thread_id: from sessions.json (sessionKey format: chatId:thread:rootId)
 * - user_message: from CLI JSONL files (user type entries)
 *
 * Usage: bun run scripts/backfill-conversations.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const isDryRun = process.argv.includes("--dry-run");
const DB_PATH = join(homedir(), ".remi", "remi.db");
const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const SESSIONS_FILE = join(homedir(), ".remi", "sessions.json");

const db = new Database(DB_PATH);

// ── Step 1: Build sessionId → threadId map from sessions.json ──

const sessionToThread = new Map<string, string>();

if (existsSync(SESSIONS_FILE)) {
  try {
    const sessData = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    const entries: [string, string][] = sessData.entries ?? [];
    for (const [sessionKey, sessionId] of entries) {
      // Format: "chatId:thread:rootId" or "chatId"
      const threadMatch = sessionKey.match(/:thread:(.+)$/);
      if (threadMatch) {
        sessionToThread.set(sessionId, threadMatch[1]);
      }
    }
    console.log(`Loaded ${sessionToThread.size} session → thread mappings from sessions.json`);
  } catch (e) {
    console.warn("Failed to parse sessions.json:", (e as Error).message);
  }
}

// ── Step 2: Build sessionId → JSONL response map ──

function loadSessionJSONL(sessionId: string): Map<number, string> {
  // Returns: index → user message text (0-based by order of user entries)
  const userMessages = new Map<number, string>();
  try {
    for (const dir of readdirSync(CLAUDE_PROJECTS)) {
      const jsonlPath = join(CLAUDE_PROJECTS, dir, sessionId + ".jsonl");
      if (existsSync(jsonlPath)) {
        const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
        let userIdx = 0;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" && obj.message?.content) {
              const textBlocks = obj.message.content.filter((b: any) => b.type === "text");
              if (textBlocks.length > 0) {
                userMessages.set(userIdx, textBlocks.map((b: any) => b.text).join("\n"));
                userIdx++;
              }
            }
          } catch {}
        }
        break;
      }
    }
  } catch {}
  return userMessages;
}

// ── Step 3: Query conversations needing backfill ──

const rows = db.query(
  `SELECT id, chat_id, cli_session_id, thread_id, user_message
   FROM conversations
   WHERE (thread_id IS NULL OR user_message IS NULL)
     AND status = 'completed'
   ORDER BY created_at ASC`
).all() as any[];

console.log(`Found ${rows.length} conversations to backfill`);

// Group by session to process JSONL efficiently
const bySession = new Map<string, any[]>();
for (const row of rows) {
  if (!row.cli_session_id) continue;
  const list = bySession.get(row.cli_session_id) ?? [];
  list.push(row);
  bySession.set(row.cli_session_id, list);
}

let threadFilled = 0;
let msgFilled = 0;

const updateStmt = db.prepare(
  "UPDATE conversations SET thread_id = COALESCE(?, thread_id), user_message = COALESCE(?, user_message) WHERE id = ?"
);

for (const [sessionId, convs] of bySession) {
  // Backfill thread_id from sessions.json
  const threadId = sessionToThread.get(sessionId);

  // Backfill user_message from JSONL
  const userMsgs = loadSessionJSONL(sessionId);

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    const newThread = conv.thread_id ? null : (threadId ?? null);
    const newMsg = conv.user_message ? null : (userMsgs.get(i) ?? null);

    if (newThread || newMsg) {
      if (isDryRun) {
        if (newThread) console.log(`  [DRY] conv ${conv.id}: thread_id = ${newThread.slice(0, 20)}...`);
        if (newMsg) console.log(`  [DRY] conv ${conv.id}: user_message = ${newMsg.slice(0, 50)}...`);
      } else {
        updateStmt.run(newThread, newMsg, conv.id);
      }
      if (newThread) threadFilled++;
      if (newMsg) msgFilled++;
    }
  }
}

console.log(`\nResults${isDryRun ? " (DRY RUN)" : ""}:`);
console.log(`  thread_id filled: ${threadFilled}`);
console.log(`  user_message filled: ${msgFilled}`);
console.log(`  total conversations: ${rows.length}`);
