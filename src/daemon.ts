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

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { Connector } from "./connectors/base.js";
import type { RemiConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { Remi } from "./core.js";
import { ClaudeCLIProvider } from "./providers/claude-cli/index.js";
import { Scheduler } from "./scheduler/jobs.js";
import { getMemoryTools } from "./tools/memory-tools.js";
import { getFeishuTools } from "./tools/feishu-tools.js";
import { FeishuConnector } from "./connectors/feishu/index.js";
import { AuthStore, FeishuAuthAdapter } from "./auth/index.js";
import { createLogger } from "./logger.js";
import { startWebDashboard, stopWebDashboard } from "../web/server.js";

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

    // 1. Initialize AuthStore (1Passport)
    const authStore = new AuthStore(join(homedir(), ".remi", "auth"));
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
    remi.authStore = authStore;

    // 2. Register providers
    const provider = this._buildProvider();
    remi.addProvider(provider);

    // 3. Register tools with token provider from AuthStore
    this._registerMemoryTools(provider, remi);
    this._registerFeishuTools(provider, hasFeishuCreds ? authStore : undefined);

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
      const feishu = new FeishuConnector(this.config.feishu);
      feishu.setTokenProvider(() => authStore.getToken("feishu", "tenant"));
      remi.addConnector(feishu);
      log.info("Registered Feishu connector (with 1Passport)");
    }

    // Register restart handler (only triggered by /restart slash command)
    remi.onRestart((info) => this._restart(info));

    return remi;
  }

  private _registerMemoryTools(provider: unknown, remi: Remi): void {
    const registerable = provider as { registerToolsFromDict?: (tools: Record<string, unknown>) => void };
    if (typeof registerable.registerToolsFromDict !== "function") return;

    try {
      const tools = getMemoryTools(remi.memory);
      registerable.registerToolsFromDict(tools);
      log.info(
        `Registered ${Object.keys(tools).length} memory tools on ${(provider as { name: string }).name}`,
      );
    } catch (e) {
      log.warn("Failed to register memory tools:", e);
    }
  }

  private _registerFeishuTools(provider: unknown, authStore?: AuthStore): void {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) return;

    const registerable = provider as { registerToolsFromDict?: (tools: Record<string, unknown>) => void };
    if (typeof registerable.registerToolsFromDict !== "function") return;

    // Token provider for document tools: prefer user token, fall back to tenant
    const tokenProvider = authStore
      ? async () => {
          try {
            return await authStore.getToken("feishu", "user");
          } catch {
            return authStore.getToken("feishu", "tenant");
          }
        }
      : undefined;

    try {
      const tools = getFeishuTools(this.config.feishu, tokenProvider);
      registerable.registerToolsFromDict(tools);
      log.info(
        `Registered ${Object.keys(tools).length} feishu tools on ${(provider as { name: string }).name}`,
      );
    } catch (e) {
      log.warn("Failed to register feishu tools:", e);
    }
  }

  private _buildProvider(name?: string | null) {
    const n = name ?? this.config.provider.name;
    if (n === "claude_cli") {
      return new ClaudeCLIProvider({
        model: this.config.provider.model,
        timeout: this.config.provider.timeout,
        allowedTools: this.config.provider.allowedTools,
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
    log.info("Restart requested — spawning new process and shutting down...");

    // Save notification info so the new process can notify the user
    this._saveRestartNotify(info);

    // Keep PID file — new process will detect us and send SIGTERM to take over

    // Clean env: remove CLAUDECODE which interferes with Claude CLI provider
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    // Redirect new process stdout/stderr to log file
    const logDir = join(homedir(), ".remi", "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFd = openSync(join(logDir, "remi.log"), "a");

    // Spawn a new daemon process (detached so it outlives the parent)
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: process.cwd(),
      env: cleanEnv,
    });
    child.unref();

    // Trigger graceful shutdown of current process
    this._abortController.abort();
  }

  // ── Main run loop ────────────────────────────────────────

  async run(): Promise<void> {
    this._checkExisting();
    this._writePid();
    this._setupSignals();

    const remi = this._buildRemi();
    const scheduler = new Scheduler(remi, this.config);

    log.info("=".repeat(60));
    log.info(`Remi daemon starting at ${new Date().toISOString()} (pid=${process.pid}, provider=${this.config.provider.name})`);

    // Start Web Dashboard
    try {
      const { port } = startWebDashboard();
      log.info(`Web Dashboard started on port ${port}`);
    } catch (e) {
      log.warn("Web Dashboard failed to start:", e);
    }

    // Send restart notification after connectors have time to fully initialize
    setTimeout(() => this._sendRestartNotify(remi), 5000);

    try {
      await Promise.all([
        remi.start(),
        scheduler.start(this._abortController.signal),
      ]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        throw e;
      }
    } finally {
      stopWebDashboard();
      await remi.stop();
      this._removePid();
      log.info("Remi daemon stopped.");
    }
  }
}
