/**
 * Cron handler bridge — dispatches BunQueue cron jobs to existing handler functions.
 *
 * Extracts all handler implementations from the old JobRunner and registers them
 * as a dispatcher for the remi:cron BunQueue queue.
 */

import type { Job } from "bunqueue/client";
import type { CronJobData } from "../queues.js";
import type { Remi } from "../../remi/core.js";
import type { Connector } from "../../connectors/base.js";
import { createLogger } from "@shared/logger.js";
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

// builtin:cli-metrics — removed: metrics now recorded in real-time via core.ts

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
    | import("@shared/contracts/provider-types.js").Provider
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

  // Deliver — resolve push targets + connector from handler config.
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

/** Resolve skill path: cwd → legacy */
function resolveSkillPath(skillName: string, cwd?: string): string {
  if (cwd) {
    const p = join(cwd, ".claude", "skills", skillName, "SKILL.md");
    if (existsSync(p)) return p;
  }
  const ccManaged = join(homedir(), ".claude", "skills", skillName, "SKILL.md");
  if (existsSync(ccManaged)) return ccManaged;
  const legacy = join(homedir(), ".remi", ".claude", "skills", skillName, "SKILL.md");
  if (existsSync(legacy)) return legacy;
  throw new Error(`Skill file not found: ${skillName} (searched cwd=${cwd ?? "none"}, ~/.claude, ~/.remi)`);
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
