/**
 * Scheduler for periodic tasks using pure async patterns.
 *
 * Jobs:
 * - Heartbeat: check provider health
 * - Memory compaction: archive daily notes → long-term memory + entity extraction
 * - Cleanup: remove old dailies and version files
 */

import type { RemiConfig } from "../config.js";
import type { Remi } from "../core.js";
import { createLogger } from "../logger.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

const log = createLogger("scheduler");

function parseCronHour(cronExpr: string): number {
  const parts = cronExpr.split(" ");
  if (parts.length >= 2) {
    const hour = parseInt(parts[1], 10);
    if (!isNaN(hour)) return hour;
  }
  return 3; // default: 3 AM
}

export class Scheduler {
  private _remi: Remi;
  private _config: RemiConfig;
  private _compactHour: number;
  private _heartbeatInterval: number;

  constructor(remi: Remi, config: RemiConfig) {
    this._remi = remi;
    this._config = config;
    this._compactHour = parseCronHour(config.scheduler.memoryCompactCron);
    this._heartbeatInterval = config.scheduler.heartbeatInterval;
  }

  async start(shutdownSignal: AbortSignal): Promise<void> {
    log.info(
      `Scheduler started (heartbeat=${this._heartbeatInterval}s, compact@${String(this._compactHour).padStart(2, "0")}:00)`,
    );

    let lastCompactDate: string | null = null;

    while (!shutdownSignal.aborted) {
      // Wait for heartbeat interval or shutdown
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this._heartbeatInterval * 1000);
        shutdownSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      if (shutdownSignal.aborted) break;

      // Heartbeat
      await this._heartbeat();

      // Daily compaction (run once per day at configured hour)
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getHours() === this._compactHour && lastCompactDate !== today) {
        await this._compactMemory();
        await this._cleanup();
        lastCompactDate = today;
      }
    }

    log.info("Scheduler stopped.");
  }

  private async _heartbeat(): Promise<void> {
    for (const [name, provider] of this._remi._providers) {
      try {
        const healthy = await provider.healthCheck();
        if (!healthy) {
          log.warn(`Provider ${name} health check failed`);
        }
      } catch (e) {
        log.error(`Provider ${name} health check error:`, e);
      }
    }

    // Auth token refresh check
    if (this._remi.authStore) {
      try {
        await this._remi.authStore.checkAndRefreshAll();
      } catch (e) {
        log.error("Auth token refresh check error:", e);
      }
    }
  }

  private async _compactMemory(): Promise<void> {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const daily = this._remi.memory.readDaily(yesterday);

    if (!daily || daily.trim().length < 50) {
      return;
    }

    log.info(`Compacting daily notes for ${yesterday}`);

    try {
      const provider = this._remi._getProvider();
      const prompt =
        `Below are my daily notes from ${yesterday}. ` +
        "Extract any important facts, decisions, or preferences that should be " +
        "remembered long-term. Format as bullet points. " +
        "If nothing is worth remembering long-term, respond with 'SKIP'.\n\n" +
        `Also identify any people, organizations, or decisions mentioned. ` +
        `For each, output a line: ENTITY: name (type) - observation\n\n` +
        daily;

      const response = await provider.send(prompt);
      const text = response.text.trim();

      if (text.toUpperCase() !== "SKIP") {
        // Extract entity observations
        for (const line of text.split("\n")) {
          if (line.startsWith("ENTITY:")) {
            this._processEntityLine(line);
          }
        }

        // Filter out ENTITY lines for the general summary
        const summaryLines = text
          .split("\n")
          .filter((line) => !line.startsWith("ENTITY:"));
        const summaryText = summaryLines.join("\n").trim();

        if (summaryText) {
          this._remi.memory.appendMemory(`\n## From ${yesterday}\n\n${summaryText}`);
          log.info(`Appended compacted memory from ${yesterday}`);
        }

        // Update rolling summary
        this._updateRollingSummary(yesterday, summaryText);
      }

      // Compress old daily logs into weekly summaries
      this._compressWeeklyLogs();

      // Archive very old logs
      this._archiveOldLogs();
    } catch (e) {
      log.error("Memory compaction failed:", e);
    }
  }

  private _processEntityLine(line: string): void {
    const match = line.match(/ENTITY:\s*(.+?)\s*\((\w+)\)\s*-\s*(.+)/);
    if (!match) return;
    const [, name, etype, observation] = match;
    try {
      const entityPath = this._remi.memory._findEntityByName(name);
      if (entityPath) {
        this._remi.memory.appendObservation(name, observation);
      } else {
        this._remi.memory.createEntity(name, etype, observation, "agent-inferred");
      }
    } catch (e) {
      log.warn(`Failed to process entity ${name}:`, e);
    }
  }

  private _updateRollingSummary(dateStr: string, summary: string): void {
    const summaryFile = join(this._remi.memory.root, ".conversation_summary.md");
    try {
      let existing = "";
      if (existsSync(summaryFile)) {
        existing = readFileSync(summaryFile, "utf-8");
      }
      const entry = `\n## ${dateStr}\n${summary}\n`;
      writeFileSync(summaryFile, existing + entry, "utf-8");
    } catch (e) {
      log.warn("Failed to update rolling summary:", e);
    }
  }

  private _compressWeeklyLogs(): void {
    const dailyDir = join(this._remi.memory.root, "daily");
    if (!existsSync(dailyDir)) return;

    const now = Date.now();

    for (const file of readdirSync(dailyDir).sort()) {
      if (!file.endsWith(".md") || file.startsWith("weekly-")) continue;
      const stem = file.replace(".md", "");
      const logDate = Date.parse(stem);
      if (isNaN(logDate)) continue;

      const ageDays = (now - logDate) / (24 * 60 * 60 * 1000);
      if (ageDays >= 8 && ageDays <= 30) {
        // Determine ISO week
        const d = new Date(logDate);
        const dayOfYear = Math.floor(
          (d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000,
        );
        const weekNum = Math.ceil(
          (dayOfYear + new Date(d.getFullYear(), 0, 1).getDay()) / 7,
        );
        const weeklyName = `weekly-${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}.md`;
        const weeklyPath = join(dailyDir, weeklyName);

        const content = readFileSync(join(dailyDir, file), "utf-8");
        appendFileSync(weeklyPath, `\n## ${stem}\n${content}\n`, "utf-8");

        unlinkSync(join(dailyDir, file));
      }
    }
  }

  private _archiveOldLogs(): void {
    const dailyDir = join(this._remi.memory.root, "daily");
    if (!existsSync(dailyDir)) return;

    const archiveDir = join(dailyDir, "archive");
    const now = Date.now();

    for (const file of readdirSync(dailyDir).sort()) {
      if (!file.endsWith(".md")) continue;
      const fullPath = join(dailyDir, file);

      if (file.startsWith("weekly-")) {
        try {
          const parts = file.replace(".md", "").split("-");
          const year = parseInt(parts[1], 10);
          const week = parseInt(parts[2].slice(1), 10);
          // Approximate week date
          const weekDate = new Date(year, 0, 1 + (week - 1) * 7);
          if ((now - weekDate.getTime()) / (24 * 60 * 60 * 1000) > 30) {
            if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
            renameSync(fullPath, join(archiveDir, file));
          }
        } catch {
          continue;
        }
      } else {
        const logDate = Date.parse(file.replace(".md", ""));
        if (!isNaN(logDate) && (now - logDate) / (24 * 60 * 60 * 1000) > 30) {
          if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
          renameSync(fullPath, join(archiveDir, file));
        }
      }
    }
  }

  private async _cleanup(): Promise<void> {
    const removedDaily = this._remi.memory.cleanupOldDailies(30);
    const removedVersions = this._remi.memory.cleanupOldVersions(50);
    if (removedDaily || removedVersions) {
      log.info(
        `Cleanup: removed ${removedDaily} old dailies, ${removedVersions} old versions`,
      );
    }
  }
}
