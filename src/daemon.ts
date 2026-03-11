/**
 * Daemon process — always-on mode for production.
 *
 * Usage: bun run src/main.ts serve
 *
 * Manages:
 * - Connector lifecycle
 * - Scheduler (heartbeat, memory compaction, reminders)
 * - PID file (prevent duplicate instances)
 * - Graceful shutdown (SIGTERM/SIGINT)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { Connector } from "./connectors/base.js";
import type { RemiConfig } from "./config.js";
import { loadConfig, migrateConfigFile } from "./config.js";
import { Remi } from "./core.js";
import { ClaudeCLIProvider } from "./providers/claude-cli/index.js";
import { CronTimer } from "./scheduler/cron-timer.js";
import { FeishuConnector } from "./connectors/feishu/index.js";
import { flushDedupCacheSync } from "./connectors/feishu/receive.js";
import { AuthStore, FeishuAuthAdapter, ByteDanceSSOAdapter } from "./auth/index.js";
import type { TokenSyncRule } from "./auth/token-sync.js";
import { createLogger } from "./logger.js";
import { writeEcosystem, runBuildsSync, getEcosystemPath } from "./pm2.js";

const log = createLogger("daemon");

export class RemiDaemon {
  config: RemiConfig;
  private _abortController = new AbortController();

  constructor(config?: RemiConfig) {
    this.config = config ?? loadConfig();
  }

  // ── PID file management ──────────────────────────────────

  private _writePid(): void {
    const dir = dirname(this.config.pidFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.config.pidFile, String(process.pid));
    log.info(`PID file written: ${this.config.pidFile} (pid=${process.pid})`);
  }

  private _removePid(): void {
    if (existsSync(this.config.pidFile)) {
      unlinkSync(this.config.pidFile);
    }
  }

  private _checkExisting(): void {
    if (!existsSync(this.config.pidFile)) return;

    let pid: number;
    try {
      pid = parseInt(readFileSync(this.config.pidFile, "utf-8").trim(), 10);
    } catch {
      this._removePid();
      return;
    }
    if (isNaN(pid)) {
      this._removePid();
      return;
    }

    // Check if process is still running
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // Process doesn't exist — stale PID file
      this._removePid();
      return;
    }

    if (!alive) return;

    // Takeover: send SIGTERM and wait for old process to exit
    log.info(`Found existing Remi daemon (pid=${pid}), sending SIGTERM to take over...`);
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }

    const deadline = Date.now() + 10_000; // 10s timeout
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        // Old process exited
        log.info(`Old daemon (pid=${pid}) exited.`);
        this._removePid();
        return;
      }
      Bun.sleepSync(200);
    }

    // Still alive after timeout — force kill
    log.warn(`Old daemon (pid=${pid}) did not exit in 10s, sending SIGKILL...`);
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    Bun.sleepSync(500);
    this._removePid();
  }

  // ── Signal handling ──────────────────────────────────────

  private _setupSignals(): void {
    const handler = (sig: string) => {
      log.info(`Received ${sig}, shutting down...`);
      this._abortController.abort();
    };
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }

  // ── Build components ─────────────────────────────────────

  _buildRemi(): Remi {
    const remi = new Remi(this.config);

    // 1. Initialize AuthStore (1Passport) with token sync rules
    const syncRules: TokenSyncRule[] | undefined =
      this.config.tokenSync.length > 0
        ? (this.config.tokenSync as TokenSyncRule[])
        : undefined; // undefined → use defaults
    const authStore = new AuthStore(join(homedir(), ".remi", "auth"), syncRules);
    const hasFeishuCreds = !!(this.config.feishu.appId && this.config.feishu.appSecret);
    if (hasFeishuCreds) {
      authStore.registerAdapter(
        new FeishuAuthAdapter({
          appId: this.config.feishu.appId,
          appSecret: this.config.feishu.appSecret,
          domain: this.config.feishu.domain,
          userAccessToken: this.config.feishu.userAccessToken || undefined,
        }),
      );
    }
    if (this.config.bytedanceSso?.clientId) {
      authStore.registerAdapter(
        new ByteDanceSSOAdapter(this.config.bytedanceSso),
      );
      log.info("Registered ByteDance SSO adapter (1Passport)");
    }
    remi.authStore = authStore;

    // 2. Register providers
    const provider = this._buildProvider();
    remi.addProvider(provider);

    // 3. Feishu document tools (lark_fetch/lark_render/lark_search/lark_auth) are now
    // provided via MCP server (bytedance.lark_parser built-in lark-mcp-server).
    // Memory tools (recall/remember) via MCP server (src/mcp/memory-server.ts).

    // Register fallback if configured
    if (this.config.provider.fallback) {
      try {
        const fallback = this._buildProvider(this.config.provider.fallback);
        remi.addProvider(fallback);
      } catch (e) {
        log.warn("Failed to build fallback provider:", e);
      }
    }

    // 4. Register Feishu connector with token provider
    if (hasFeishuCreds) {
      // Merge bot profile groups into allowedGroups only (not monitorGroups —
      // bot profile groups require @bot or @triggerUser to respond)
      const feishuConfig = { ...this.config.feishu };
      for (const bot of this.config.bots) {
        for (const g of bot.groups) {
          if (!feishuConfig.allowedGroups.includes(g)) {
            feishuConfig.allowedGroups = [...feishuConfig.allowedGroups, g];
          }
        }
      }

      const feishu = new FeishuConnector(feishuConfig);
      feishu.setTokenProvider(() => authStore.getToken("feishu", "tenant"));
      feishu.setBotProfiles(this.config.bots);
      remi.addConnector(feishu);
      log.info(`Registered Feishu connector (with 1Passport, ${this.config.bots.length} bot profiles)`);
    }

    // Register restart handler (only triggered by /restart slash command)
    remi.onRestart((info) => this._restart(info));

    return remi;
  }

  private _buildProvider(name?: string | null) {
    const n = name ?? this.config.provider.name;
    if (n === "claude_cli") {
      return new ClaudeCLIProvider({
        model: this.config.provider.model,
        timeout: this.config.provider.timeout,
        allowedTools: this.config.provider.allowedTools,
        cwd: homedir(),
      });
    }
    throw new Error(`Unknown provider: ${n}`);
  }

  // ── Restart notification ────────────────────────────────

  private get _restartNotifyPath(): string {
    return join(homedir(), ".remi", "restart-notify.json");
  }

  private _saveRestartNotify(info: { chatId: string; connectorName?: string }): void {
    const dir = join(homedir(), ".remi");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this._restartNotifyPath, JSON.stringify(info));
  }

  /** After startup, check if we need to notify someone that restart succeeded. */
  private async _sendRestartNotify(remi: Remi): Promise<void> {
    const filePath = this._restartNotifyPath;
    if (!existsSync(filePath)) return;

    let info: { chatId: string; connectorName?: string };
    try {
      const raw = readFileSync(filePath, "utf-8");
      info = JSON.parse(raw);
      unlinkSync(filePath);
      log.info(`Restart notify: connector=${info.connectorName}, chatId=${info.chatId}`);
    } catch (e) {
      log.warn("Restart notify: failed to read file:", e);
      if (existsSync(filePath)) unlinkSync(filePath);
      return;
    }

    // Find the matching connector
    const connectors = remi["_connectors"] as Connector[];
    const connector = connectors.find(
      (c) => c.name === (info.connectorName ?? ""),
    );
    if (!connector) {
      log.warn(
        `Restart notify: connector "${info.connectorName}" not found (available: ${connectors.map((c) => c.name).join(", ")})`,
      );
      return;
    }

    // Retry — Feishu API may need time to obtain access token on cold start
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await connector.reply(info.chatId, { text: "Remi 重启成功，已上线。" });
        log.info(`Restart notification sent to ${info.connectorName}:${info.chatId}`);
        return;
      } catch (e) {
        log.warn(`Restart notify attempt ${attempt}/${maxRetries} failed: ${String(e)}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    log.error("Restart notification failed after all retries.");
  }

  // ── Self-restart ────────────────────────────────────────

  private _restart(info: { chatId: string; connectorName?: string }): void {
    log.info("Restart requested — rebuilding services and triggering PM2 restart...");

    this._saveRestartNotify(info);
    flushDedupCacheSync();

    // Run build steps for services that need them
    runBuildsSync(this.config);

    // Regenerate ecosystem config (picks up any config changes)
    writeEcosystem(this.config);

    // Trigger PM2 restart (detached so it outlives our process)
    const child = spawn("pm2", ["restart", getEcosystemPath(), "--update-env"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // PM2 will send SIGTERM which triggers our graceful shutdown
  }

  // ── Main run loop ────────────────────────────────────────

  async run(): Promise<void> {
    this._checkExisting();
    this._writePid();
    this._setupSignals();

    // One-time migration: [scheduler] + [[scheduled_skills]] → [[cron.jobs]]
    if (migrateConfigFile()) {
      log.info("Config migrated: [scheduler] + [[scheduled_skills]] → [[cron.jobs]]");
      this.config = loadConfig();
    }

    const remi = this._buildRemi();
    const cronTimer = new CronTimer(remi, this.config);

    log.info("=".repeat(60));
    log.info(`Remi daemon starting at ${new Date().toISOString()} (pid=${process.pid}, provider=${this.config.provider.name})`);

    // Send restart notification after connectors have time to fully initialize
    setTimeout(() => this._sendRestartNotify(remi), 5000);

    try {
      await Promise.all([
        remi.start(),
        cronTimer.start(this._abortController.signal),
      ]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        // Abort CronTimer if remi.start() or any component fails
        this._abortController.abort();
        throw e;
      }
    } finally {
      this._abortController.abort(); // Ensure CronTimer stops in all exit paths
      await remi.stop();
      this._removePid();
      log.info("Remi daemon stopped.");
    }
  }
}
