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
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
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

/**
 * Push an agent's "--- 汇报 ---" narrative section to configured push targets.
 * Reuses the connector's own reply() pipeline — for Feishu this goes through
 * buildFinalCard → sendCardFeishu, giving us the same card identity, stats
 * footer, and collapsible thinking section that Remi uses for normal replies.
 *
 * Targets come from handler_config.pushTargets (preferred) or nested
 * handler_config.delivery.pushTargets. Connector name defaults to "feishu".
 */
async function pushAgentReport(
  remi: Remi,
  config: Record<string, any> | undefined,
  result: { stdout: string; exitCode: number; durationMs?: number },
  titlePrefix: string,
  tag: string,
): Promise<void> {
  if (result.exitCode !== 0 || !result.stdout.includes("--- 汇报 ---")) return;
  const [logLines, reportTail] = result.stdout.split("--- 汇报 ---", 2);
  const report = reportTail?.trim();
  if (!report) return;

  const delivery = (config?.delivery as Record<string, any> | undefined) ?? {};
  const pushTargets: string[] =
    (config?.pushTargets as string[]) ?? (delivery.pushTargets as string[]) ?? [];
  const connectorName: string =
    (config?.connectorName as string) ?? (delivery.connectorName as string) ?? "feishu";
  if (pushTargets.length === 0) {
    log.debug(`[${tag}] No pushTargets configured, skipping push`);
    return;
  }

  const connectors = remi["_connectors"] as Connector[];
  const connector = connectors.find((c) => c.name === connectorName);
  if (!connector) {
    log.warn(`[${tag}] Connector "${connectorName}" not found, skipping push`);
    return;
  }

  // Construct an AgentResponse so connector.reply() gives us the full card
  // treatment (stats footer, thinking/steps section).
  const response = {
    text: `${titlePrefix}\n\n${report}`,
    thinking: logLines?.trim() || null,
    durationMs: result.durationMs ?? null,
  };

  for (const target of pushTargets) {
    try {
      await connector.reply(target, response);
      log.info(`[${tag}] Report pushed to ${target}`);
    } catch (e) {
      log.warn(`[${tag}] Failed to push to ${target}: ${e}`);
    }
  }
}

/**
 * builtin:pulse — proactive "is anything worth interrupting?" briefing.
 *
 * Runs a one-shot session asking the agent to surface anything genuinely worth
 * pinging the user about (reminders, follow-ups, time-sensitive items) using its
 * memory. If the reply is the sentinel `[SKIPPED]` (default), nothing is posted —
 * this is the key anti-"cries wolf" pattern borrowed from agentara's pulse.
 * Otherwise the briefing is pushed to the configured Feishu targets.
 *
 * handler_config:
 *   pushTargets: string[]   — chat IDs to post to (required to actually deliver)
 *   connectorName: string   — default "feishu"
 *   prompt: string          — optional override of the default pulse prompt
 *   sentinel: string        — optional override of "[SKIPPED]"
 *   title: string           — optional card title prefix
 */
handlers.set("builtin:pulse", async (remi, config) => {
  const tag = "builtin:pulse";
  const sentinel: string = (config?.sentinel as string) ?? "[SKIPPED]";
  const title: string = (config?.title as string) ?? "🔔 Remi Pulse";
  const prompt: string =
    (config?.prompt as string) ??
    `You are Remi's proactive pulse. Using your memory (recall what you know about the user, ` +
    `recent daily notes, ongoing projects/missions), decide whether there is anything genuinely ` +
    `worth interrupting the user with RIGHT NOW — a due reminder, a stale follow-up, a time-sensitive ` +
    `item, or a useful nudge. Be conservative: only surface things that clear a high bar.\n\n` +
    `If there is something worth it, write a SHORT briefing (1-4 bullet points, no preamble).\n` +
    `If nothing clears the bar, reply with EXACTLY "${sentinel}" and nothing else.`;

  const provider = remi["_providers"].values().next().value as
    | import("../../providers/base.js").Provider
    | undefined;
  if (!provider) {
    log.warn(`[${tag}] no provider available, skipping`);
    return;
  }

  let text = "";
  try {
    const result = await provider.send(prompt, { chatId: "builtin:pulse" });
    text = (result.text ?? "").trim();
  } catch (e) {
    log.warn(`[${tag}] session failed: ${e}`);
    return;
  }

  // Self-suppression: if the model decided nothing is worth it, stay silent.
  if (!text || text.includes(sentinel)) {
    log.info(`[${tag}] nothing worth surfacing (suppressed)`);
    return;
  }

  // Deliver — same target/connector resolution as pushAgentReport.
  const delivery = (config?.delivery as Record<string, any> | undefined) ?? {};
  const pushTargets: string[] =
    (config?.pushTargets as string[]) ?? (delivery.pushTargets as string[]) ?? [];
  const connectorName: string =
    (config?.connectorName as string) ?? (delivery.connectorName as string) ?? "feishu";
  if (pushTargets.length === 0) {
    log.info(`[${tag}] briefing ready but no pushTargets configured — not delivered`);
    return;
  }
  const connectors = remi["_connectors"] as Connector[];
  const connector = connectors.find((c) => c.name === connectorName);
  if (!connector) {
    log.warn(`[${tag}] connector "${connectorName}" not found, skipping`);
    return;
  }
  const response = { text: `${title}\n\n${text}`, thinking: null, durationMs: null };
  for (const target of pushTargets) {
    try {
      await connector.reply(target, response);
      log.info(`[${tag}] briefing pushed to ${target}`);
    } catch (e) {
      log.warn(`[${tag}] failed to push to ${target}: ${e}`);
    }
  }
});

handlers.set("agent:wiki-curate", async (remi, config) => {
  const { AgentRunner } = await import("../../agents/index.js");
  const runner = new AgentRunner();
  const prompt = `执行今日 Wiki 维护。扫描所有项目的 memory 和 wiki 目录，综合记忆碎片生成/更新 Wiki L0/L1/L2。`;
  const result = await runner.run("wiki-curate", prompt);
  await pushAgentReport(remi, config, result, "📚 Wiki 维护日报", "agent:wiki-curate");
});

handlers.set("agent:memory-audit", async (remi, config) => {
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
  await pushAgentReport(remi, config, result, "📋 记忆维护日报", "agent:memory-audit");
});

/**
 * cli-ingest — Harvest Claude Code CLI conversations (~/.claude/projects/*)
 * and feed them into memory-extract for projects that Remi already knows.
 *
 * Opt-in rule: only process JSONLs whose cwd has a bootstrapped
 * `~/.remi/projects/{hash}/` directory. Projects Remi hasn't been
 * introduced to are ignored entirely for privacy.
 *
 * Per-JSONL cursor (last_pair_count) tracks how much we've already
 * processed so each new round is ingested exactly once.
 */
handlers.set("cli-ingest", async (remi) => {
  const { getDb } = await import("../../db/index.js");
  const { parseSessionPairs } = await import("../../conversation/parser.js");
  const db = getDb();

  db.exec(`CREATE TABLE IF NOT EXISTS cli_ingest_cursor (
    jsonl_path TEXT PRIMARY KEY,
    last_pair_count INTEGER NOT NULL DEFAULT 0,
    last_ingested_at TEXT NOT NULL
  )`);

  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) {
    log.debug("[cli-ingest] ~/.claude/projects not found, skipping");
    return;
  }

  // Only consider JSONLs modified in the last 3 hours — keeps scan fast
  const cutoffMs = Date.now() - 3 * 3600 * 1000;
  let ingested = 0;
  let skippedNoOptIn = 0;
  let skippedInactive = 0;

  // Use plain readdir + statSync: ~/.claude/projects/ entries are often
  // symlinks into ~/.remi/projects/, which Dirent.isDirectory() would skip.
  for (const name of readdirSync(projectsDir)) {
    const projDir = join(projectsDir, name);
    let projStat;
    try { projStat = statSync(projDir); } catch { continue; }
    if (!projStat.isDirectory()) continue;

    for (const file of readdirSync(projDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const jsonlPath = join(projDir, file);

      let stat;
      try { stat = statSync(jsonlPath); } catch { continue; }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoffMs) { skippedInactive++; continue; }

      // Extract cwd — scan first ~20 lines (line 1 is often file-history-snapshot,
      // cwd lives on the first user/assistant message line).
      let cwd: string | undefined;
      try {
        const head = readFileSync(jsonlPath, { encoding: "utf-8", flag: "r" }).slice(0, 16384);
        const lines = head.split("\n", 20);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (typeof obj.cwd === "string" && obj.cwd) { cwd = obj.cwd; break; }
          } catch { /* skip malformed line */ }
        }
      } catch { continue; }
      if (!cwd) continue;

      // Skip agent cwds — these are Remi's own background-agent runs
      // (memory-extract, memory-audit, wiki-curate). Ingesting them would
      // create a feedback loop: agent run → JSONL → cli-ingest → agent run.
      if (/\/agents\/[^/]+\/?$/.test(cwd)) { skippedNoOptIn++; continue; }

      // Opt-in: Remi must already know this project
      const projectHash = cwd.replace(/\//g, "-");
      const remiProjectDir = join(homedir(), ".remi", "projects", projectHash);
      if (!existsSync(remiProjectDir)) { skippedNoOptIn++; continue; }

      const sessionId = basename(file, ".jsonl");
      let pairs;
      try {
        pairs = parseSessionPairs(jsonlPath, sessionId);
      } catch (e) {
        log.warn(`[cli-ingest] parse failed for ${sessionId}: ${e}`);
        continue;
      }

      const cursor = db
        .query<{ last_pair_count: number }, [string]>(
          "SELECT last_pair_count FROM cli_ingest_cursor WHERE jsonl_path = ?",
        )
        .get(jsonlPath);
      const lastCount = cursor?.last_pair_count ?? 0;
      if (pairs.length <= lastCount) continue;

      const newPairs = pairs.slice(lastCount);
      const parts: string[] = [];
      for (const p of newPairs) {
        if (p.userText) parts.push(`User: ${p.userText.slice(0, 500)}`);
        if (p.remiText) parts.push(`Remi: ${p.remiText.slice(0, 500)}`);
      }
      const aggregatedText = parts.join("\n\n").slice(0, 8000);
      if (!aggregatedText) continue;

      const contentHash = createHash("sha256")
        .update(`${jsonlPath}:${lastCount}:${pairs.length}`)
        .digest("hex")
        .slice(0, 16);

      await remi.queue.enqueueMemory({
        sessionKey: `cli-ingest:${sessionId}`,
        aggregatedText,
        contentHash,
        roundCount: newPairs.length,
        timestamp: new Date().toISOString(),
        cwd,
      });

      db.query(
        "INSERT OR REPLACE INTO cli_ingest_cursor(jsonl_path, last_pair_count, last_ingested_at) VALUES (?, ?, ?)",
      ).run(jsonlPath, pairs.length, new Date().toISOString());

      ingested++;
      log.info(
        `[cli-ingest] ${sessionId}: +${newPairs.length} pairs (cwd=${cwd}, total=${pairs.length})`,
      );
    }
  }

  log.info(
    `[cli-ingest] done — ingested=${ingested}, skipped_no_optin=${skippedNoOptIn}, skipped_inactive=${skippedInactive}`,
  );
});

/** Resolve skill path: cwd → cc-switch managed → legacy → pipeline built-in */
function resolveSkillPath(skillName: string, cwd?: string): string {
  if (cwd) {
    const p = join(cwd, ".claude", "skills", skillName, "SKILL.md");
    if (existsSync(p)) return p;
  }
  const ccManaged = join(homedir(), ".claude", "skills", skillName, "SKILL.md");
  if (existsSync(ccManaged)) return ccManaged;
  const legacy = join(homedir(), ".remi", ".claude", "skills", skillName, "SKILL.md");
  if (existsSync(legacy)) return legacy;
  const builtIn = join(import.meta.dir, "../../../pipeline/skills", skillName, "SKILL.md");
  if (existsSync(builtIn)) return builtIn;
  throw new Error(`Skill file not found: ${skillName} (searched cwd=${cwd ?? "none"}, ~/.claude, ~/.remi, pipeline/)`);
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
