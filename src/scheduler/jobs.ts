/**
 * Scheduler for periodic tasks using pure async patterns.
 *
 * Jobs:
 * - Heartbeat: check provider health
 * - Memory compaction: archive daily notes → long-term memory + entity extraction
 * - Cleanup: remove old dailies and version files
 * - Scheduled skills: config-driven skill execution and push
 */

import type { RemiConfig, ScheduledSkillConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { Remi } from "../core.js";
import type { Connector } from "../connectors/base.js";
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
import { homedir } from "node:os";

const log = createLogger("scheduler");

/** Format a Date as YYYY-MM-DD in local timezone (not UTC). */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
    const skillNames = this._config.scheduledSkills
      .filter((s) => s.enabled)
      .map((s) => s.name);
    log.info(
      `Scheduler started (heartbeat=${this._heartbeatInterval}s, compact@${String(this._compactHour).padStart(2, "0")}:00` +
        (skillNames.length > 0
          ? `, scheduled_skills: [${skillNames.join(", ")}]`
          : "") +
        ")",
    );

    let lastCompactDate: string | null = null;
    // Per-skill tracking: name → { lastGenDate, lastPushDate }
    const skillTracker = new Map<string, { lastGenDate: string | null; lastPushDate: string | null }>();

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

      // Hot-reload configs from remi.toml
      this._reloadScheduledSkillsConfig();

      const now = new Date();
      const today = localDateStr(now);

      // Daily compaction (run once per day at configured hour)
      if (now.getHours() === this._compactHour && lastCompactDate !== today) {
        await this._compactMemory();
        await this._cleanup();
        lastCompactDate = today;
      }

      // Scheduled skills — generic skill execution loop
      for (const skill of this._config.scheduledSkills) {
        if (!skill.enabled || !skill.name) continue;

        if (!skillTracker.has(skill.name)) {
          skillTracker.set(skill.name, { lastGenDate: null, lastPushDate: null });
        }
        const tracker = skillTracker.get(skill.name)!;

        // Generate
        if (
          now.getHours() === skill.generateHour &&
          tracker.lastGenDate !== today
        ) {
          await this._generateSkillReport(skill, today);
          tracker.lastGenDate = today;
        }

        // Push
        if (
          now.getHours() === skill.pushHour &&
          now.getMinutes() >= skill.pushMinute &&
          tracker.lastPushDate !== today
        ) {
          await this._pushSkillReport(skill, today);
          tracker.lastPushDate = today;
        }
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
    const yesterday = localDateStr(new Date(Date.now() - 86400000));
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

  // ── Scheduled Skills (generic config-driven) ───────────────

  /**
   * Load a skill's SKILL.md content, strip YAML frontmatter,
   * and substitute date placeholders.
   */
  private _loadSkillPrompt(skillName: string, dateStr: string): string | null {
    const skillPath = join(
      homedir(), ".remi", ".claude", "skills", skillName, "SKILL.md",
    );

    if (!existsSync(skillPath)) {
      log.error(`Skill file not found: ${skillPath}`);
      return null;
    }

    let content = readFileSync(skillPath, "utf-8");

    // Strip YAML frontmatter (--- ... ---)
    const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    if (frontmatterMatch) {
      content = content.slice(frontmatterMatch[0].length);
    }

    // Substitute date placeholders
    content = content.replace(/YYYY-MM-DD/g, dateStr);

    return content.trim();
  }

  private _reloadScheduledSkillsConfig(): void {
    try {
      const newConfig = loadConfig();
      const oldSkills = this._config.scheduledSkills;
      const newSkills = newConfig.scheduledSkills;

      if (JSON.stringify(oldSkills) !== JSON.stringify(newSkills)) {
        this._config.scheduledSkills = newSkills;
        this._remi.config.scheduledSkills = newSkills;
        const names = newSkills.filter((s) => s.enabled).map((s) => s.name);
        log.info(`Scheduled skills hot-reloaded: [${names.join(", ")}]`);
      }
    } catch (e) {
      log.warn("Failed to reload scheduled skills config:", e);
    }
  }

  private async _generateSkillReport(skill: ScheduledSkillConfig, today: string): Promise<void> {
    log.info(`Generating scheduled skill report: ${skill.name} for ${today}`);

    try {
      const prompt = this._loadSkillPrompt(skill.name, today);
      if (!prompt) return;

      const provider = this._remi._getProvider();
      const response = await provider.send(prompt);
      const text = response.text.trim();

      if (!text || text.startsWith("[Provider error") || text.startsWith("[Provider timeout")) {
        log.error(`Skill report generation failed (${skill.name}): ${text.slice(0, 100)}`);
        return;
      }

      if (!existsSync(skill.outputDir)) {
        mkdirSync(skill.outputDir, { recursive: true });
      }

      const reportPath = join(skill.outputDir, `${today}.md`);
      writeFileSync(reportPath, text, "utf-8");
      log.info(`Skill report saved: ${skill.name} → ${reportPath}`);
    } catch (e) {
      log.error(`Skill report generation error (${skill.name}):`, e);
    }
  }

  private async _pushSkillReport(skill: ScheduledSkillConfig, today: string): Promise<void> {
    const reportPath = join(skill.outputDir, `${today}.md`);
    if (!existsSync(reportPath)) {
      log.warn(`No report found for skill ${skill.name} on ${today}, skipping push`);
      return;
    }

    const content = readFileSync(reportPath, "utf-8");
    if (!content.trim()) {
      log.warn(`Report for skill ${skill.name} on ${today} is empty, skipping push`);
      return;
    }

    const connectors = this._remi["_connectors"] as Connector[];
    const connector = connectors.find((c) => c.name === skill.connectorName);

    if (!connector) {
      log.error(
        `Skill push (${skill.name}): connector "${skill.connectorName}" not found`,
      );
      return;
    }

    let pushContent = content;

    // Truncate if too long
    if (pushContent.length > skill.maxPushLength) {
      // Try to cut at a section boundary (## heading)
      const truncated = pushContent.slice(0, skill.maxPushLength);
      const lastSection = truncated.lastIndexOf("\n## ");
      const cutPoint = lastSection > skill.maxPushLength * 0.5 ? lastSection : skill.maxPushLength;
      pushContent = pushContent.slice(0, cutPoint).trim() + "\n\n> 回复「完整报告」查看完整内容";
    }

    for (const target of skill.pushTargets) {
      try {
        await connector.reply(target, { text: pushContent });
        log.info(`Skill report pushed: ${skill.name} → ${target}`);
      } catch (e) {
        log.error(`Failed to push skill report (${skill.name}) to ${target}:`, e);
      }
    }
  }
}
