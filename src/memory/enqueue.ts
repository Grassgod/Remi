/**
 * Stop hook entry point — enqueue transcript for async processing.
 *
 * Usage (Claude Code stop hook):
 *   bun run src/memory/enqueue.ts
 *
 * Reads transcript from stdin, writes to ~/.remi/queue/{timestamp}.jsonl.
 * Must complete within 5 seconds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";

const log = createLogger("enqueue");

async function main(): Promise<void> {
  const queueDir = join(homedir(), ".remi", "queue");
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }

  // Read transcript from stdin
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  const transcript = chunks.join("");

  if (!transcript.trim()) return;

  // Idempotency: hash-based dedup
  const contentHash = createHash("sha256")
    .update(transcript)
    .digest("hex")
    .slice(0, 16);

  const processedFile = join(queueDir, ".processed");
  if (existsSync(processedFile)) {
    const processed = readFileSync(processedFile, "utf-8").split("\n");
    if (processed.includes(contentHash)) return;
  }

  const now = new Date();
  const ts =
    now.toISOString().replace(/[-:]/g, "").replace(/T/, "T").replace(/\.\d{3}Z$/, "").slice(0, 15);

  const entry = {
    timestamp: ts,
    hash: contentHash,
    transcript,
  };

  const outputPath = join(queueDir, `${ts}.jsonl`);
  writeFileSync(outputPath, JSON.stringify(entry) + "\n", "utf-8");
}

main().catch((e) => log.error("enqueue failed:", e));
