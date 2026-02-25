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
import { dirname } from "node:path";
import type { RemiConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { Remi } from "./core.js";
import { ClaudeCLIProvider } from "./providers/claude-cli/index.js";
import { Scheduler } from "./scheduler/jobs.js";
import { getMemoryTools } from "./tools/memory-tools.js";
import { FeishuConnector } from "./connectors/feishu/index.js";

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
    console.log(`PID file written: ${this.config.pidFile} (pid=${process.pid})`);
  }

  private _removePid(): void {
    if (existsSync(this.config.pidFile)) {
      unlinkSync(this.config.pidFile);
    }
  }

  private _checkExisting(): void {
    if (!existsSync(this.config.pidFile)) return;

    try {
      const pid = parseInt(readFileSync(this.config.pidFile, "utf-8").trim(), 10);
      // Check if process exists
      process.kill(pid, 0);
      console.error(`Remi daemon already running (pid=${pid}). Exiting.`);
      process.exit(1);
    } catch (e) {
      // Process doesn't exist (ESRCH) or no permission — stale PID file
      if ((e as NodeJS.ErrnoException).code === "ESRCH" || (e as NodeJS.ErrnoException).code === "EPERM") {
        this._removePid();
      } else if ((e as Error).message?.includes("NaN")) {
        this._removePid();
      } else {
        // Process still running
        throw e;
      }
    }
  }

  // ── Signal handling ──────────────────────────────────────

  private _setupSignals(): void {
    const handler = (sig: string) => {
      console.log(`Received ${sig}, shutting down...`);
      this._abortController.abort();
    };
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }

  // ── Build components ─────────────────────────────────────

  _buildRemi(): Remi {
    const remi = new Remi(this.config);

    // Register providers
    const provider = this._buildProvider();
    remi.addProvider(provider);

    // Register memory tools on provider (if supported)
    this._registerMemoryTools(provider, remi);

    // Register fallback if configured
    if (this.config.provider.fallback) {
      try {
        const fallback = this._buildProvider(this.config.provider.fallback);
        remi.addProvider(fallback);
      } catch (e) {
        console.warn("Failed to build fallback provider:", e);
      }
    }

    // Register Feishu connector if credentials are configured
    if (this.config.feishu.appId && this.config.feishu.appSecret) {
      const feishu = new FeishuConnector(this.config.feishu);
      remi.addConnector(feishu);
      console.log("Registered Feishu connector");
    }

    return remi;
  }

  private _registerMemoryTools(provider: unknown, remi: Remi): void {
    const registerable = provider as { registerToolsFromDict?: (tools: Record<string, unknown>) => void };
    if (typeof registerable.registerToolsFromDict !== "function") return;

    try {
      const tools = getMemoryTools(remi.memory);
      registerable.registerToolsFromDict(tools);
      console.log(
        `Registered ${Object.keys(tools).length} memory tools on ${(provider as { name: string }).name}`,
      );
    } catch (e) {
      console.warn("Failed to register memory tools:", e);
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

  // ── Main run loop ────────────────────────────────────────

  async run(): Promise<void> {
    this._checkExisting();
    this._writePid();
    this._setupSignals();

    const remi = this._buildRemi();
    const scheduler = new Scheduler(remi, this.config);

    console.log(`Remi daemon starting (provider=${this.config.provider.name})`);

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
      await remi.stop();
      this._removePid();
      console.log("Remi daemon stopped.");
    }
  }
}
