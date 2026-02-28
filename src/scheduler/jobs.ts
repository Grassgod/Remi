/**
 * Scheduler for periodic tasks using pure async patterns.
 *
 * Jobs:
 * - Heartbeat: check provider health
 * - Memory compaction: archive daily notes → long-term memory + entity extraction
 * - Cleanup: remove old dailies and version files
 */

import type { RemiConfig } from "../config.js";
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
    const initBriefing = this._config.briefing;
    log.info(
      `Scheduler started (heartbeat=${this._heartbeatInterval}s, compact@${String(this._compactHour).padStart(2, "0")}:00` +
        (initBriefing.enabled
          ? `, briefing: generate@${String(initBriefing.generateHour).padStart(2, "0")}:00 push@${String(initBriefing.pushHour).padStart(2, "0")}:${String(initBriefing.pushMinute).padStart(2, "0")})`
          : ")"),
    );

    let lastCompactDate: string | null = null;
    let lastBriefingGenDate: string | null = null;
    let lastBriefingPushDate: string | null = null;

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

      // Hot-reload briefing config from remi.toml
      this._reloadBriefingConfig();

      const now = new Date();
      const today = now.toISOString().slice(0, 10);

      // Daily compaction (run once per day at configured hour)
      if (now.getHours() === this._compactHour && lastCompactDate !== today) {
        await this._compactMemory();
        await this._cleanup();
        lastCompactDate = today;
      }

      // Daily briefing generation (read from this._config for hot-reload)
      const briefing = this._config.briefing;
      if (
        briefing.enabled &&
        now.getHours() === briefing.generateHour &&
        lastBriefingGenDate !== today
      ) {
        await this._generateDailyBriefing(today);
        lastBriefingGenDate = today;
      }

      // Daily briefing push
      if (
        briefing.enabled &&
        now.getHours() === briefing.pushHour &&
        now.getMinutes() >= briefing.pushMinute &&
        lastBriefingPushDate !== today
      ) {
        await this._pushDailyBriefing(today);
        lastBriefingPushDate = today;
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

  private _reloadBriefingConfig(): void {
    try {
      const newConfig = loadConfig();
      const oldB = this._config.briefing;
      const newB = newConfig.briefing;

      // Compare briefing config fields
      if (
        oldB.enabled !== newB.enabled ||
        oldB.generateHour !== newB.generateHour ||
        oldB.pushHour !== newB.pushHour ||
        oldB.pushMinute !== newB.pushMinute ||
        oldB.connectorName !== newB.connectorName ||
        oldB.briefingDir !== newB.briefingDir ||
        JSON.stringify(oldB.pushTargets) !== JSON.stringify(newB.pushTargets)
      ) {
        this._config.briefing = newB;
        // Also update core's config so _tryBriefingDetail uses new briefingDir
        this._remi.config.briefing = newB;
        log.info(
          `Briefing config hot-reloaded: enabled=${newB.enabled}, ` +
            `generate@${String(newB.generateHour).padStart(2, "0")}:00, ` +
            `push@${String(newB.pushHour).padStart(2, "0")}:${String(newB.pushMinute).padStart(2, "0")}, ` +
            `targets=[${newB.pushTargets.join(",")}]`,
        );
      }
    } catch (e) {
      log.warn("Failed to reload config:", e);
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

  // ── Daily Briefing ─────────────────────────────────────────

  private get _briefingDir(): string {
    return this._config.briefing.briefingDir;
  }

  private _briefingPath(dateStr: string): string {
    return join(this._briefingDir, `${dateStr}.md`);
  }

  private async _generateDailyBriefing(today: string): Promise<void> {
    log.info(`Generating daily AI briefing for ${today}`);

    try {
      const provider = this._remi._getProvider();

      const prompt = `你是一位 AI 行业分析师。请搜索并整理**昨天**（以及最近 2-3 天）AI/大模型领域最火爆、最重要的 5 件事。

要求：
1. 使用 WebSearch 搜索以下关键词获取最新信息：
   - "AI agent news today"、"LLM news today"
   - "AI breakthrough latest"、"GPT Claude Gemini latest news"
   - "GitHub trending AI"、"AI open source trending"
   - "AI startup funding"、"AI product launch"
2. 从搜索结果中筛选出最重要的 5 件事（按影响力、新颖性、热度排序）
3. 输出两部分内容：

**第一部分：精简简报**（30 秒内读完）

# 🤖 AI 日报 | ${today}

> 昨日 AI 领域最值得关注的 5 件事

**1. [一句话标题]**
→ [核心要点，不超过 50 字]

**2. [一句话标题]**
→ [核心要点，不超过 50 字]

（以此类推共 5 条）

---
🔥 今日最火仓库: [repo-name] ⭐ [stars] — [一句话描述]

**第二部分：详细报告**（紧接简报后）

---

# 📋 AI 日报详细报告 | ${today}

## 1. [事件标题]
**概述**: [2-3 句话]
**为什么重要**: [影响分析]
**相关链接**: [来源 URL]

（以此类推共 5 条）

## 🔥 热门开源项目
| 项目 | Stars | 语言 | 亮点 |
|------|-------|------|------|
（列出 3-5 个热门仓库）

## 📊 行业观察
[2-3 句话宏观趋势总结]

注意事项：
- 每条消息必须有具体的名字、数字或事实，不要模糊
- 中文输出，技术术语保留英文
- 信息必须来自搜索结果，标注来源`;

      const response = await provider.send(prompt);
      const text = response.text.trim();

      if (!text || text.startsWith("[Provider error") || text.startsWith("[Provider timeout")) {
        log.error(`Daily briefing generation failed: ${text.slice(0, 100)}`);
        return;
      }

      // Save to file
      if (!existsSync(this._briefingDir)) {
        mkdirSync(this._briefingDir, { recursive: true });
      }
      writeFileSync(this._briefingPath(today), text, "utf-8");
      log.info(`Daily briefing saved to ${this._briefingPath(today)}`);
    } catch (e) {
      log.error("Daily briefing generation error:", e);
    }
  }

  private async _pushDailyBriefing(today: string): Promise<void> {
    const briefingPath = this._briefingPath(today);
    if (!existsSync(briefingPath)) {
      log.warn(`No briefing found for ${today}, skipping push`);
      return;
    }

    const content = readFileSync(briefingPath, "utf-8");
    if (!content.trim()) {
      log.warn(`Briefing for ${today} is empty, skipping push`);
      return;
    }

    const cfg = this._config.briefing;
    const connectors = this._remi["_connectors"] as Connector[];
    const connector = connectors.find((c) => c.name === cfg.connectorName);

    if (!connector) {
      log.error(
        `Briefing push: connector "${cfg.connectorName}" not found (available: ${connectors.map((c) => c.name).join(", ")})`,
      );
      return;
    }

    // Split into brief + detailed report if content is too long for one message
    // Feishu markdown card has content limits, so send briefing first, then details
    const separator = "# 📋 AI 日报详细报告";
    const separatorIdx = content.indexOf(separator);

    let briefPart: string;
    let detailPart: string | null = null;

    if (separatorIdx > 0) {
      briefPart = content.slice(0, separatorIdx).trim();
      detailPart = content.slice(separatorIdx).trim();
    } else {
      briefPart = content;
    }

    for (const target of cfg.pushTargets) {
      try {
        // Only push the brief summary; detailed report stays on disk for on-demand retrieval
        const footer = detailPart ? "\n\n> 回复「详细报告」查看完整分析" : "";
        await connector.reply(target, { text: briefPart + footer });
        log.info(`Briefing pushed to ${target}`);
      } catch (e) {
        log.error(`Failed to push briefing to ${target}:`, e);
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
