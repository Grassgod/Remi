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

/** Resolve skill path: cwd → ~/.remi → /pipeline/skills/ */
function resolveSkillPath(skillName: string, cwd?: string): string {
  if (cwd) {
    const p = join(cwd, ".claude", "skills", skillName, "SKILL.md");
    if (existsSync(p)) return p;
  }
  const userSkill = join(homedir(), ".remi", ".claude", "skills", skillName, "SKILL.md");
  if (existsSync(userSkill)) return userSkill;
  const builtIn = join(import.meta.dir, "../../../pipeline/skills", skillName, "SKILL.md");
  if (existsSync(builtIn)) return builtIn;
  throw new Error(`Skill file not found: ${skillName} (searched cwd=${cwd ?? "none"}, ~/.remi, pipeline/)`);
}

handlers.set("skill:run", async (remi, config) => {
  if (!config?.skillName) throw new Error("Missing handlerConfig.skillName");

  const skillName = config.skillName as string;
  const jobId = config._jobId as string;
  const today = localDateStr(new Date());
  const outputDir = (config.outputDir as string) ?? join(homedir(), ".remi", "skill-reports", skillName);
  const runId = `${jobId}-${today}`;

  // ── Phase 1: Generate ──
  log.info(`[skill:run] Generating: ${skillName} for ${today}`);
  const genStart = Date.now();

  const skillPath = resolveSkillPath(skillName, config.cwd as string | undefined);

  let content = readFileSync(skillPath, "utf-8");
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) content = content.slice(frontmatterMatch[0].length);
  content = content.replace(/YYYY-MM-DD/g, today);

  const provider = remi._getProvider();
  const response = await provider.send(content.trim());
  const text = response.text.trim();

  if (!text || text.startsWith("[Provider error") || text.startsWith("[Provider timeout")) {
    const genMs = Date.now() - genStart;
    appendRunLog(jobId, "skill:run", "error", genMs, `Generation failed: ${text.slice(0, 100)}`, runId, "generate");
    throw new Error(`Generation failed: ${text.slice(0, 100)}`);
  }

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${today}.md`), text, "utf-8");
  const genMs = Date.now() - genStart;
  appendRunLog(jobId, "skill:run", "ok", genMs, undefined, runId, "generate");
  log.info(`[skill:run] Report saved: ${skillName} → ${outputDir}/${today}.md (${genMs}ms)`);

  // ── Phase 2: Deliver (optional) ──
  const delivery = config.delivery as Record<string, any> | undefined;
  if (!delivery) return;

  const pushStart = Date.now();
  const connectorName = (delivery.connectorName as string) ?? "feishu";
  const connectors = remi["_connectors"] as Connector[];
  const connector = connectors.find((c) => c.name === connectorName);
  if (!connector) {
    const pushMs = Date.now() - pushStart;
    appendRunLog(jobId, "skill:run", "error", pushMs, `Connector "${connectorName}" not found`, runId, "push");
    throw new Error(`Connector "${connectorName}" not found`);
  }

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
  const pushMs = Date.now() - pushStart;
  appendRunLog(jobId, "skill:run", "ok", pushMs, undefined, runId, "push");
});

// ── skill:gen — generate only (no delivery) ───────────────────────
handlers.set("skill:gen", async (remi, config) => {
  if (!config?.skillName) throw new Error("Missing handlerConfig.skillName");

  const skillName = config.skillName as string;
  const today = localDateStr(new Date());
  const outputDir = (config.outputDir as string) ?? join(homedir(), ".remi", "skill-reports", skillName);

  log.info(`[skill:gen] Generating: ${skillName} for ${today}`);

  const skillPath = resolveSkillPath(skillName, config.cwd as string | undefined);

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
  log.info(`[skill:gen] Report saved: ${skillName} → ${outputDir}/${today}.md`);
});

// ── skill:push — read existing file and deliver via connector ─────
handlers.set("skill:push", async (remi, config) => {
  const today = localDateStr(new Date());
  const outputDir = config?.outputDir as string;
  if (!outputDir) throw new Error("Missing handlerConfig.outputDir");

  const filePath = join(outputDir, `${today}.md`);
  if (!existsSync(filePath)) {
    log.warn(`[skill:push] No report for today: ${filePath}`);
    return;
  }

  const text = readFileSync(filePath, "utf-8").trim();
  if (!text) {
    log.warn(`[skill:push] Empty report: ${filePath}`);
    return;
  }

  const connectorName = (config?.connectorName as string) ?? "feishu";
  const connectors = remi["_connectors"] as Connector[];
  const connector = connectors.find((c) => c.name === connectorName);
  if (!connector) throw new Error(`Connector "${connectorName}" not found`);

  const maxLen = (config?.maxPushLength as number) ?? 4000;
  let pushContent = text;

  if (pushContent.length > maxLen) {
    const truncated = pushContent.slice(0, maxLen);
    const lastSection = truncated.lastIndexOf("\n## ");
    const cutPoint = lastSection > maxLen * 0.5 ? lastSection : maxLen;
    pushContent = pushContent.slice(0, cutPoint).trim() + "\n\n> 回复「完整报告」查看完整内容";
  }

  const pushTargets = (config?.pushTargets as string[]) ?? [];
  const skillName = (config?.skillName as string) ?? "unknown";
  for (const target of pushTargets) {
    await connector.reply(target, { text: pushContent });
    log.info(`[skill:push] Pushed: ${skillName} → ${target}`);
  }
});

// ── Release Notes generation ──────────────────────────────────────

handlers.set("release-notes:generate", async (remi, config) => {
  if (!config?.projectId) throw new Error("Missing handlerConfig.projectId");

  const { projectId, projectName, cwd, version, releaseBranch, newBranch, pushTargets } = config as {
    projectId: string; projectName: string; cwd: string;
    version: string; releaseBranch: string; newBranch: string;
    pushTargets: string[];
  };

  log.info(`[release-notes] Generating for ${projectName} v${version}`);

  // ── 1. Query completed missions ──
  const { MissionStore } = await import("../../mission/store.js");
  const store = new MissionStore();
  const missions = store.listByProject(projectId)
    .filter((m) => m.status === "done" && !m.releasedAt);

  if (missions.length === 0) {
    log.info("[release-notes] No completed missions, skipping");
    return;
  }

  // ── 2. Build mission context ──
  const missionEntries: string[] = [];
  for (const m of missions) {
    let description = "";
    if (m.outputDir) {
      const descPath = join(m.outputDir, "description.md");
      if (existsSync(descPath)) {
        const raw = readFileSync(descPath, "utf-8").trim();
        // Take first meaningful paragraph (skip headings)
        description = raw.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 3).join(" ");
      }
    }
    const durMin = m.totalDuration ? (m.totalDuration / 60000).toFixed(0) : "?";
    const mrNum = m.mrUrl?.match(/\/(\d+)$/)?.[1] ?? "";
    missionEntries.push(
      `- 标题: ${m.title}\n  描述: ${description || "(无)"}\n  MR: ${mrNum ? `!${mrNum}` : "(无)"} ${m.mrUrl ?? ""}\n  AI 执行耗时: ${durMin} min\n  创建: ${m.createdAt?.slice(0, 10)} 完成: ${m.completedAt?.slice(0, 10) ?? "?"}`,
    );
  }

  // ── 3. Git stats ──
  let gitStats = "";
  if (cwd) {
    try {
      const { execSync } = await import("child_process");
      gitStats = execSync(
        `git diff --stat origin/main...origin/${releaseBranch} 2>/dev/null | tail -1`,
        { cwd, encoding: "utf-8", timeout: 10000 },
      ).trim();
    } catch { /* ignore */ }
  }

  // ── 4. Build prompt ──
  const prompt = `你是一个版本发布通知助手。根据以下数据生成一条简洁的飞书群通知消息。

## 项目信息
- 项目名: ${projectName}
- 版本: v${version}
- Release 分支: ${releaseBranch}
- 下一版本分支: ${newBranch}

## 已完成的 Mission（共 ${missions.length} 个）
${missionEntries.join("\n\n")}

## Git 统计
${gitStats || "(无统计信息)"}

## 输出要求
生成飞书卡片内的 Markdown 内容（不含标题，标题由卡片 header 提供），要求：
1. 分类展示功能（✨ 新功能 / 🐛 修复 / ⚡ 优化），从 Mission 标题推断分类
2. 每个 Mission 一行：· 功能一句话描述 + MR 编号 + 耗时（如 "41 min"）
3. 底部分隔线后统计行：▸ Mission 总数 + 总耗时 + "全流程 Pipeline 自动执行（需求 → RFC → 代码 → 测试 → MR）"
4. 项目名用 PascalCase（如 lark_parser → LarkParser）
5. 排版紧凑，分类标题和条目之间不要空行，只在分类之间留一个空行
6. 保持简洁有冲击力，让读者第一眼 get 到新功能，第二眼 get 到自动化能力
7. 只输出卡片 body 的 Markdown 内容，不要输出其他说明文字`;

  // ── 5. Generate via AI provider ──
  const provider = remi._getProvider();
  const response = await provider.send(prompt);
  const text = response.text?.trim();

  if (!text || text.startsWith("[Provider error")) {
    throw new Error(`Release notes generation failed: ${text?.slice(0, 100)}`);
  }

  // ── 6. Deliver to Feishu as card ──
  if (pushTargets?.length > 0) {
    try {
      const { createFeishuClient } = await import("../../connectors/feishu/client.js");
      const { sendCardFeishu } = await import("../../connectors/feishu/send.js");
      const { loadConfig: loadCfg } = await import("../../config.js");
      const cfg = loadCfg();
      const client = createFeishuClient({ appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret, domain: cfg.feishu.domain });

      // PascalCase: lark_parser → LarkParser
      const displayName = projectName.replace(/(^|[_-])(\w)/g, (_: string, __: string, c: string) => c.toUpperCase());
      const card = {
        schema: "2.0",
        header: {
          title: { tag: "plain_text" as const, content: `🚀 ${displayName} v${version} 已发布` },
          template: "turquoise" as const,
        },
        config: { width_mode: "fill" },
        body: { elements: [{ tag: "markdown", content: text }] },
      };
      for (const target of pushTargets) {
        await sendCardFeishu(client, target, card);
        log.info(`[release-notes] Card pushed to ${target}`);
      }
    } catch (e) {
      log.warn(`[release-notes] Card delivery failed: ${e}`);
    }
  }

  // Save report & mark missions as released
  const outputDir = join(homedir(), ".remi", "skill-reports", "release-notes");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${projectId}-v${version}.md`), text, "utf-8");
  store.markReleased(missions.map((m) => m.id));

  // ── 7. Trigger linked QA knowledge sync (reuse existing maintain skill) ──
  try {
    const cronJobs = remi.config.cronJobs ?? [];
    const keyword = projectId.replace(/_/g, "");
    const maintainJob = cronJobs.find(
      (j: any) => j.handlerConfig?.skillName?.includes(keyword),
    );
    if (maintainJob) {
      await remi.queue.enqueueCron({
        jobId: `${maintainJob.id}-release-sync`,
        handler: maintainJob.handler,
        handlerConfig: maintainJob.handlerConfig,
      });
      log.info(`[release-notes] Triggered QA maintain skill: ${maintainJob.id}`);
    } else {
      log.info(`[release-notes] No linked QA skill found for "${keyword}"`);
    }
  } catch (e) {
    log.warn(`[release-notes] QA sync trigger failed: ${e}`);
  }

  log.info(`[release-notes] Done: ${projectName} v${version}`);
});

// ── Mission Board handlers ──────────────────────────────────────

handlers.set("builtin:mr-poll", async (remi) => {
  const { pollMRStatus } = await import("../../mission/github.js");
  await pollMRStatus(remi);
});

handlers.set("builtin:skill-optimize", async (remi, config) => {
  const { MissionStore } = await import("../../mission/store.js");
  const store = new MissionStore();
  const feedbacks = store.getRecentFeedbacks(24 * 60 * 60 * 1000); // last 24h

  if (feedbacks.length === 0) {
    log.info("[skill-optimize] No recent feedbacks, skipping");
    return;
  }

  // Group by skill
  const grouped = new Map<string, typeof feedbacks>();
  for (const f of feedbacks) {
    const list = grouped.get(f.skillName) ?? [];
    list.push(f);
    grouped.set(f.skillName, list);
  }

  log.info(`[skill-optimize] Found ${feedbacks.length} feedback(s) across ${grouped.size} skill(s)`);

  // For each skill with feedback, generate optimization prompt
  for (const [skillName, items] of grouped) {
    const skillPath = join(homedir(), ".remi", ".claude", "skills", skillName, "SKILL.md");
    if (!existsSync(skillPath)) {
      log.warn(`[skill-optimize] Skill file not found: ${skillPath}`);
      continue;
    }

    const currentSkill = readFileSync(skillPath, "utf-8");
    const feedbackSummary = items.map(f =>
      `- [${f.feedbackType}] step=${f.step}: ${f.detail ?? "no detail"}`
    ).join("\n");

    const prompt = `Analyze the following skill and its recent feedback. Suggest small, focused improvements.

## Current Skill
${currentSkill}

## Recent Feedback (${items.length} items)
${feedbackSummary}

## Requirements
- Only suggest small improvements, don't restructure
- Focus on the most common feedback patterns
- Output the improved SKILL.md content if changes are warranted`;

    // Use provider to analyze (if available)
    const provider = remi._providers.values().next().value;
    if (provider) {
      try {
        const result = await provider.send(prompt, { chatId: `skill-optimize-${skillName}` });
        log.info(`[skill-optimize] ${skillName}: ${result.text?.length ?? 0} chars response`);
        // Log optimization suggestion (don't auto-apply in Phase 3)
      } catch (err) {
        log.warn(`[skill-optimize] Failed for ${skillName}: ${(err as Error).message}`);
      }
    }
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
  const selfLogged = handler === "skill:run"; // skill:run logs its own phases
  const config = selfLogged ? { ...handlerConfig, _jobId: jobId } : handlerConfig;
  const start = Date.now();
  try {
    await fn(remi, config);
    const durationMs = Date.now() - start;
    log.info(`Cron job ${jobId} completed in ${durationMs}ms`);
    if (!selfLogged) appendRunLog(jobId, handler, "ok", durationMs);
  } catch (e) {
    const durationMs = Date.now() - start;
    log.error(`Cron job ${jobId} failed after ${durationMs}ms:`, e);
    if (!selfLogged) appendRunLog(jobId, handler, "error", durationMs, String(e));
    throw e; // re-throw so BunQueue records failure + retries
  }
}

function appendRunLog(jobId: string, handler: string, status: "ok" | "error", durationMs: number, error?: string, runId?: string, phase?: string): void {
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
      ...(runId && { runId }),
      ...(phase && { phase }),
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
