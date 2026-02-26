/**
 * Memory daemon — consume queued transcripts and run maintenance agent.
 *
 * Watches ~/.remi/queue/ for new .jsonl files, processes them through an LLM
 * to extract memory-worthy information, and patches memory files.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildMaintenancePrompt } from "./maintenance.js";
import type { MemoryStore } from "./store.js";
import { createLogger } from "../logger.js";

const log = createLogger("mem-daemon");

const LOCK_FILE = ".maintenance.lock";
const LOCK_TIMEOUT = 60; // seconds

export class MemoryDaemon {
  store: MemoryStore;
  queueDir: string;
  pollInterval: number;

  constructor(
    store: MemoryStore,
    options?: { queueDir?: string; pollInterval?: number },
  ) {
    this.store = store;
    this.queueDir = options?.queueDir ?? join(homedir(), ".remi", "queue");
    this.pollInterval = options?.pollInterval ?? 10.0;

    if (!existsSync(this.queueDir)) {
      mkdirSync(this.queueDir, { recursive: true });
    }
    const processedDir = join(this.queueDir, "processed");
    if (!existsSync(processedDir)) {
      mkdirSync(processedDir, { recursive: true });
    }
  }

  async run(shutdownSignal?: AbortSignal): Promise<void> {
    log.info(`MemoryDaemon started, watching ${this.queueDir}`);

    while (!shutdownSignal?.aborted) {
      try {
        await this._processQueue();
      } catch (e) {
        log.error("Queue processing error:", e);
      }

      // Wait for poll interval or shutdown
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollInterval * 1000);
        if (shutdownSignal) {
          shutdownSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }
      });
    }

    log.info("MemoryDaemon stopped.");
  }

  private async _processQueue(): Promise<void> {
    const lockPath = join(this.store.root, LOCK_FILE);
    if (existsSync(lockPath)) {
      const mtime = statSync(lockPath).mtimeMs / 1000;
      if (Date.now() / 1000 - mtime < LOCK_TIMEOUT) {
        return; // Lock held
      }
      // Stale lock
      unlinkSync(lockPath);
    }

    const pending = readdirSync(this.queueDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    if (pending.length === 0) return;

    // Acquire lock
    writeFileSync(lockPath, String(Date.now() / 1000), "utf-8");
    try {
      for (const file of pending) {
        await this._processFile(join(this.queueDir, file));
      }
    } finally {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    }
  }

  private async _processFile(jsonlFile: string): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(jsonlFile, "utf-8"));
    } catch (e) {
      log.error(`Failed to read ${jsonlFile}:`, e);
      return;
    }

    const contentHash = (data.hash as string) ?? "";

    // Idempotency check
    const processedFile = join(this.queueDir, ".processed");
    if (existsSync(processedFile)) {
      const processed = readFileSync(processedFile, "utf-8").split("\n");
      if (processed.includes(contentHash)) {
        unlinkSync(jsonlFile);
        return;
      }
    }

    const transcript = (data.transcript as string) ?? "";
    if (!transcript.trim()) {
      unlinkSync(jsonlFile);
      return;
    }

    log.info(`Processing queued transcript: ${jsonlFile.split("/").pop()}`);

    // Build prompt (placeholder for LLM integration)
    const prompt = buildMaintenancePrompt(
      null,
      "",
      transcript.slice(0, 5000),
      this._describeMemoryStructure(),
    );

    // TODO: call LLM with prompt, parse response, execute actions
    log.info(`Maintenance prompt built (${prompt.length} chars), LLM call pending`);

    // Record as processed
    appendFileSync(processedFile, `${contentHash}\n`, "utf-8");

    // Move to processed directory
    const dest = join(this.queueDir, "processed", jsonlFile.split("/").pop()!);
    renameSync(jsonlFile, dest);
  }

  _describeMemoryStructure(): string {
    const lines: string[] = [];
    const entitiesDir = join(this.store.root, "entities");
    if (existsSync(entitiesDir)) {
      for (const entry of readdirSync(entitiesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const count = readdirSync(join(entitiesDir, entry.name)).filter((f) =>
            f.endsWith(".md"),
          ).length;
          lines.push(`  entities/${entry.name}/: ${count} files`);
        }
      }
    }

    const dailyDir = join(this.store.root, "daily");
    if (existsSync(dailyDir)) {
      const count = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).length;
      lines.push(`  daily/: ${count} files`);
    }

    return lines.length > 0 ? lines.join("\n") : "  (empty)";
  }

  cleanupProcessed(keepDays: number = 30): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    const processedDir = join(this.queueDir, "processed");
    if (!existsSync(processedDir)) return 0;

    for (const file of readdirSync(processedDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const fullPath = join(processedDir, file);
      if (statSync(fullPath).mtimeMs < cutoff) {
        unlinkSync(fullPath);
        removed++;
      }
    }
    return removed;
  }
}
