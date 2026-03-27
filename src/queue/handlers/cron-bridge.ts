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
  appendFileSync,
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

// builtin:compaction — removed: merged into agent:memory-audit (Phase 1 SUPPLEMENT + Phase 6-8)
// builtin:cleanup   — removed: merged into agent:memory-audit (Phase 8 CLEANUP)
// builtin:cli-metrics — removed: metrics now recorded in real-time via core.ts

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
  const prompt = `执行今日统一记忆维护（9 阶段）：
1. SUPPLEMENT — 读取昨日 daily notes，提取 memory-extract 遗漏的新事实写入实体（不写 MEMORY.md）
2. MERGE — 去重实体观察
3. DELETE — 删除过期事实（先备份到 .versions/）
4. FILL_SUMMARY — 补充缺失的 summary
5. UPDATE_IMPORTANCE — 更新实体重要性评分
6. COMPRESS — 压缩 8-30 天日志为周报，归档 >30 天周报
7. PRUNE_INDEX — 确保 MEMORY.md 不超过 200 行，归档旧 "## From" 段落到 compaction-archive/
8. CLEANUP — 清理 >30 天 dailies 和 >50 条 versions
9. REPORT — 汇总昨日所有 agent 运行日志`;
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
  const { jobId, handler, handlerConfig } = job.data;
  const fn = handlers.get(handler);
  if (!fn) {
    throw new Error(`Unknown cron handler: ${handler}`);
  }
  log.info(`Executing cron job: ${jobId} (handler=${handler})`);
  const start = Date.now();
  try {
    await fn(remi, handlerConfig);
    const durationMs = Date.now() - start;
    log.info(`Cron job ${jobId} completed in ${durationMs}ms`);
    appendRunLog(jobId, handler, "ok", durationMs);
  } catch (e) {
    const durationMs = Date.now() - start;
    log.error(`Cron job ${jobId} failed after ${durationMs}ms:`, e);
    appendRunLog(jobId, handler, "error", durationMs, String(e));
    throw e; // re-throw so BunQueue records failure + retries
  }
}

function appendRunLog(jobId: string, handler: string, status: "ok" | "error", durationMs: number, error?: string): void {
  try {
    const runsDir = join(homedir(), ".remi", "cron", "runs");
    if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
    const safeId = jobId.replace(/[:/]/g, "_");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      jobId,
      handler,
      status,
      durationMs,
      ...(error && { error: error.slice(0, 500) }),
    });
    appendFileSync(join(runsDir, `${safeId}.jsonl`), entry + "\n", "utf-8");
  } catch {
    // non-critical, don't let logging failure break cron
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Helper functions processEntityLine, updateRollingSummary, compressWeeklyLogs, archiveOldLogs
// removed — these responsibilities are now handled by agent:memory-audit phases
