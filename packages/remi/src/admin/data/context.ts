/**
 * RemiDataContext — cross-domain shared surface for the RemiData domain split.
 *
 * Holds the `~/.remi` roots, the metrics collector and the private helpers that
 * more than one domain calls (config store, PM2 app list, cron job list, file
 * backup). Every member here was moved verbatim out of `RemiData`.
 *
 * Domains that need a sibling domain's *public* method reach it lazily through
 * `host` (the RemiData facade), never through constructor injection, which
 * would deadlock the construction order.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { ConfigStore } from "@shared/db/config-store.js";
import { MetricsCollector } from "@shared/metrics/collector.js";
import { getDb } from "@shared/db/index.js";
import { backupFile } from "@memory/store/versions.js";
import type { DailyLogEntry, EntitySummary, TokenStatus } from "./types.js";
import type { MemoryEntitiesData } from "./entities.js";

/** The subset of the RemiData facade that cross-domain callers use. */
export interface RemiDataHost {
  readSoul(): string;
  listEntities(): EntitySummary[];
  listProjectMemories(): ReturnType<MemoryEntitiesData["listProjectMemories"]>;
  readProjectMemoryFile(projectId: string, filePath: string): string;
  listDailyDates(): DailyLogEntry[];
  readDaily(date: string): string;
  readTokenStatus(): TokenStatus[];
  getDaemonPid(): number | null;
  isDaemonAlive(): boolean;
}

export class RemiDataContext {
  readonly memoryDir: string;
  readonly _metrics: MetricsCollector;

  constructor(readonly root: string, private readonly resolveHost: () => RemiDataHost) {
    this.memoryDir = join(root, "memory");
    this._metrics = new MetricsCollector(root);
  }

  get host(): RemiDataHost {
    return this.resolveHost();
  }

  private _configStore: ConfigStore | null = null;

  _getConfigStore(): ConfigStore {
    if (!this._configStore) {
      this._configStore = new ConfigStore(getDb());
    }
    return this._configStore;
  }

  private _pm2Cache: { data: Array<{ name: string; pid?: number; pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number }; monit?: { memory?: number; cpu?: number } }>; ts: number } | null = null;

  _getPm2Apps() {
    const now = Date.now();
    if (this._pm2Cache && now - this._pm2Cache.ts < 5_000) return this._pm2Cache.data;
    try {
      const output = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 10_000 });
      const apps = JSON.parse(output);
      this._pm2Cache = { data: apps, ts: now };
      return apps as typeof this._pm2Cache.data;
    } catch {
      return [];
    }
  }

  _loadCronJobs(): Array<{
    id: string; name?: string; handler: string; enabled: boolean;
    cron?: string; every?: string | number; at?: string;
    handlerConfig?: Record<string, any>;
  }> {
    try {
      const jobs = this._getConfigStore().getSection("cronJobs") as any[] | undefined;
      if (!jobs || !Array.isArray(jobs)) return [];
      return jobs.map((j: any) => ({
        id: j.id ?? "unknown",
        name: j.name,
        handler: j.handler ?? j.id,
        enabled: j.enabled !== false,
        cron: j.cron,
        every: j.every,
        at: j.at,
        handlerConfig: j.handlerConfig ?? j.handler_config,
      }));
    } catch { return []; }
  }

  /**
   * No `keep`: the paths RemiData backs up (every skill's `SKILL.md`, every
   * scope's `.mcp.json`) share a stem, and retention prunes by stem — capping it
   * would make backing up one of them delete another's history.
   */
  _backup(filePath: string): void {
    backupFile(this.memoryDir, filePath);
  }

}
