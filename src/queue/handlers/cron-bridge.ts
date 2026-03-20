/**
 * Cron handler bridge — dispatches BunQueue cron jobs to existing handler functions.
 *
 * Extracts all handler implementations from the old JobRunner and registers them
 * as a dispatcher for the remi:cron BunQueue queue.
 */

import type { Job } from "bunqueue/client";
import type { CronJobData } from "../queues.js";
import type { Remi } from "../../core.js";
import type { Connector } from "../../connectors/base.js";
import { createLogger } from "../../logger.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("cron:handler");

type HandlerFn = (remi: Remi, config?: Record<string, any>) => Promise<void>;

const handlers = new Map<string, HandlerFn>();

// ── Register all built-in handlers ──────────────────────────────

handlers.set("builtin:heartbeat", async (remi) => {
  for (const [name, provider] of remi._providers) {
    try {
      const healthy = await provider.healthCheck();
      if (!healthy) log.warn(`Provider ${name} health check failed`);
    } catch (e) {
      log.error(`Provider ${name} health check error:`, e);
    }
  }
  if (remi.authStore) {
    try { await remi.authStore.checkAndRefreshAll(); }
    catch (e) { log.error("Auth token refresh check error:", e); }
  }
  try { await remi.metrics.fetchUsageFromAPI(); }
  catch (e) { log.debug("Usage quota fetch failed:", e); }
});

handlers.set("builtin:compaction", async (remi) => {
  const yesterday = localDateStr(new Date(Date.now() - 86400000));
  const daily = remi.memory.readDaily(yesterday);
  if (!daily || daily.trim().length < 50) return;

  const existingMemory = remi.memory.readMemory();
  if (existingMemory.includes(`## From ${yesterday}`)) {
    log.info(`Skipping compaction for ${yesterday}: already exists in MEMORY.md`);
  } else {
    log.info(`Compacting daily notes for ${yesterday}`);

    const provider = remi._getProvider();
    const prompt =
      `Below are my daily notes from ${yesterday}.\n\n` +
      "Here is my EXISTING long-term memory (do NOT repeat anything already recorded here):\n" +
      "---\n" + existingMemory + "\n---\n\n" +
      "Extract ONLY NEW facts, decisions, or preferences NOT already in my existing memory. " +
      "Format as bullet points. " +
      "If everything is already recorded or nothing is worth remembering, respond with 'SKIP'.\n\n" +
      `Also identify any NEW people, organizations, or decisions mentioned. ` +
      `For each, output a line: ENTITY: name (type) - observation\n\n` +
      daily;

    const response = await provider.send(prompt);
    const text = response.text.trim();

    if (text.toUpperCase() !== "SKIP") {
      for (const line of text.split("\n")) {
        if (line.startsWith("ENTITY:")) {
          processEntityLine(remi, line);
        }
      }

      const summaryLines = text.split("\n").filter((line) => !line.startsWith("ENTITY:"));
      const summaryText = summaryLines.join("\n").trim();

      if (summaryText) {
        remi.memory.appendMemory(`\n## From ${yesterday}\n\n${summaryText}`);
        log.info(`Appended compacted memory from ${yesterday}`);
      }

      updateRollingSummary(remi, yesterday, summaryText);
    }
  }

  compressWeeklyLogs(remi);
  archiveOldLogs(remi);

  // Bridge sync removed in v3 — replaced by Symlink architecture
});

handlers.set("builtin:cleanup", async (remi) => {
  const removedDaily = remi.memory.cleanupOldDailies(30);
  const removedVersions = remi.memory.cleanupOldVersions(50);
  if (removedDaily || removedVersions) {
    log.info(`Cleanup: removed ${removedDaily} old dailies, ${removedVersions} old versions`);
  }
});

// builtin:cli-metrics removed — metrics now recorded in real-time via core.ts

// ── Agent handlers ────────────────────────────────────────────

handlers.set("agent:wiki-curate", async () => {
  const { AgentRunner } = await import("../../agents/index.js");
  const runner = new AgentRunner();
  const prompt = `执行今日 Wiki 维护。扫描所有项目的 memory 和 wiki 目录，综合记忆碎片生成/更新 Wiki L0/L1/L2。`;
  await runner.run("wiki-curate", prompt);
});

handlers.set("agent:memory-audit", async (remi) => {
  const { AgentRunner } = await import("../../agents/index.js");
  const runner = new AgentRunner();
  const prompt = `执行今日记忆审计。扫描所有记忆实体，去重、合并碎片、删除过期、修复矛盾、补充 summary、更新 importance。
最后读取 ~/.remi/agents/*/runs/ 下昨天的日志，汇总成一份可读汇报。`;
  const result = await runner.run("memory-audit", prompt);

  // Push audit report via connector if configured
  if (result.exitCode === 0 && result.stdout.includes("--- 汇报 ---")) {
    const report = result.stdout.split("--- 汇报 ---")[1]?.trim();
    if (report) {
      const connectors = remi["_connectors"] as any[];
      const feishu = connectors.find((c: any) => c.name === "feishu");
      if (feishu) {
        const pushTarget = remi.config.ownerId;
        if (pushTarget) {
          await feishu.reply(pushTarget, { text: `📋 记忆维护日报\n\n${report}` });
          log.info("[agent:memory-audit] Report pushed to owner");
        }
      }
    }
  }
});

handlers.set("skill:run", async (remi, config) => {
  if (!config?.skillName) throw new Error("Missing handlerConfig.skillName");

  const skillName = config.skillName as string;
  const today = localDateStr(new Date());
  const outputDir = (config.outputDir as string) ?? join(homedir(), ".remi", "skill-reports", skillName);

  // ── Phase 1: Generate ──
  log.info(`[skill:run] Generating: ${skillName} for ${today}`);

  const skillPath = join(homedir(), ".remi", ".claude", "skills", skillName, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Skill file not found: ${skillPath}`);

  let content = readFileSync(skillPath, "utf-8");
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) content = content.slice(frontmatterMatch[0].length);
  content = content.replace(/YYYY-MM-DD/g, today);

  const provider = remi._getProvider();
  const response = await provider.send(content.trim());
  const text = response.text.trim();

  if (!text || text.startsWith("[Provider error") || text.startsWith("[Provider timeout")) {
    throw new Error(`Generation failed: ${text.slice(0, 100)}`);
  }

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${today}.md`), text, "utf-8");
  log.info(`[skill:run] Report saved: ${skillName} → ${outputDir}/${today}.md`);

  // ── Phase 2: Deliver (optional) ──
  const delivery = config.delivery as Record<string, any> | undefined;
  if (!delivery) return;

  const connectorName = (delivery.connectorName as string) ?? "feishu";
  const connectors = remi["_connectors"] as Connector[];
  const connector = connectors.find((c) => c.name === connectorName);
  if (!connector) throw new Error(`Connector "${connectorName}" not found`);

  const maxLen = (delivery.maxPushLength as number) ?? 4000;
  let pushContent = text;

  if (pushContent.length > maxLen) {
    const truncated = pushContent.slice(0, maxLen);
    const lastSection = truncated.lastIndexOf("\n## ");
    const cutPoint = lastSection > maxLen * 0.5 ? lastSection : maxLen;
    pushContent = pushContent.slice(0, cutPoint).trim() + "\n\n> 回复「完整报告」查看完整内容";
  }

  const pushTargets = (delivery.pushTargets as string[]) ?? [];
  for (const target of pushTargets) {
    await connector.reply(target, { text: pushContent });
    log.info(`[skill:run] Pushed: ${skillName} → ${target}`);
  }
});

// ── Dispatcher (BunQueue Worker handler) ─────────────────────────

export async function handleCronJob(job: Job<CronJobData>, remi: Remi): Promise<void> {
  const { handler, handlerConfig } = job.data;
  const fn = handlers.get(handler);
  if (!fn) {
    throw new Error(`Unknown cron handler: ${handler}`);
  }
  log.info(`Executing cron job: ${handler}`);
  const start = Date.now();
  try {
    await fn(remi, handlerConfig);
    const durationMs = Date.now() - start;
    log.info(`Cron job ${handler} completed in ${durationMs}ms`);
    appendRunLog(handler, "ok", durationMs);
  } catch (e) {
    const durationMs = Date.now() - start;
    log.error(`Cron job ${handler} failed after ${durationMs}ms:`, e);
    appendRunLog(handler, "error", durationMs, String(e));
    throw e; // re-throw so BunQueue records failure + retries
  }
}

function appendRunLog(handler: string, status: "ok" | "error", durationMs: number, error?: string): void {
  try {
    const runsDir = join(homedir(), ".remi", "cron", "runs");
    if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
    const safeId = handler.replace(/[:/]/g, "_");
    const entry = JSON.stringify({ ts: new Date().toISOString(), status, durationMs, ...(error && { error: error.slice(0, 500) }) });
    appendFileSync(join(runsDir, `${safeId}.jsonl`), entry + "\n", "utf-8");
  } catch {
    // non-critical, don't let logging failure break cron
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function processEntityLine(remi: Remi, line: string): void {
  const match = line.match(/ENTITY:\s*(.+?)\s*\((\w+)\)\s*-\s*(.+)/);
  if (!match) return;
  const [, name, etype, observation] = match;
  try {
    const entityPath = remi.memory._findEntityByName(name);
    if (entityPath) {
      remi.memory.appendObservation(name, observation);
    } else {
      remi.memory.createEntity(name, etype, observation, "agent-inferred");
    }
  } catch (e) {
    log.warn(`Failed to process entity ${name}:`, e);
  }
}

function updateRollingSummary(remi: Remi, dateStr: string, summary: string): void {
  const summaryFile = join(remi.memory.root, ".conversation_summary.md");
  try {
    let existing = "";
    if (existsSync(summaryFile)) existing = readFileSync(summaryFile, "utf-8");
    writeFileSync(summaryFile, existing + `\n## ${dateStr}\n${summary}\n`, "utf-8");
  } catch (e) {
    log.warn("Failed to update rolling summary:", e);
  }
}

function compressWeeklyLogs(remi: Remi): void {
  const dailyDir = join(remi.memory.root, "daily");
  if (!existsSync(dailyDir)) return;
  const now = Date.now();

  for (const file of readdirSync(dailyDir).sort()) {
    if (!file.endsWith(".md") || file.startsWith("weekly-")) continue;
    const logDate = Date.parse(file.replace(".md", ""));
    if (isNaN(logDate)) continue;

    const ageDays = (now - logDate) / 86400000;
    if (ageDays >= 8 && ageDays <= 30) {
      const d = new Date(logDate);
      const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000);
      const weekNum = Math.ceil((dayOfYear + new Date(d.getFullYear(), 0, 1).getDay()) / 7);
      const weeklyName = `weekly-${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}.md`;
      const weeklyPath = join(dailyDir, weeklyName);
      const content = readFileSync(join(dailyDir, file), "utf-8");
      appendFileSync(weeklyPath, `\n## ${file.replace(".md", "")}\n${content}\n`, "utf-8");
      unlinkSync(join(dailyDir, file));
    }
  }
}

function archiveOldLogs(remi: Remi): void {
  const dailyDir = join(remi.memory.root, "daily");
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
        const weekDate = new Date(year, 0, 1 + (week - 1) * 7);
        if ((now - weekDate.getTime()) / 86400000 > 30) {
          if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
          renameSync(fullPath, join(archiveDir, file));
        }
      } catch { continue; }
    } else {
      const logDate = Date.parse(file.replace(".md", ""));
      if (!isNaN(logDate) && (now - logDate) / 86400000 > 30) {
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
        renameSync(fullPath, join(archiveDir, file));
      }
    }
  }
}
