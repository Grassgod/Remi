/**
 * ConfigHubService — orchestrates DB writes + immediate sync to tool files,
 * so the existing UI semantics (toggle/upsert in DB) actually take effect in
 * Claude/Codex/Gemini.
 */

import { createLogger } from "../../logger.js";
import type { AppType, McpConfig, Scope } from "./types.js";
import { APP_TYPES } from "./types.js";
import type { AdapterRegistry } from "./adapters/base.js";
import { GlobalMcpDao, SqliteManifestStore, type McpRow } from "./db/dao.js";
import { syncMcp, type SyncOutcome } from "./sync.js";

const log = createLogger("config-hub");

export interface SyncReport {
  byApp: Partial<Record<AppType, SyncOutcome>>;
}

export class ConfigHubService {
  constructor(
    private readonly mcp: GlobalMcpDao,
    private readonly manifests: SqliteManifestStore,
    private readonly adapters: AdapterRegistry,
  ) {}

  // ── Reads ─────────────────────────────────────────────────

  listGlobalMcp(): McpRow[] {
    return this.mcp.list();
  }

  /** Used by the ACP provider to enumerate MCP servers active for an agent. */
  getMcpServersForApp(
    app: AppType,
  ): Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> {
    const enabled = this.mcp.enabledFor(app);
    const out: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> = [];
    for (const [name, cfg] of Object.entries(enabled)) {
      if (!cfg.command) continue; // ACP only handles stdio
      out.push({
        name,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
      });
    }
    return out;
  }

  // ── Writes (each mutation auto-syncs the affected tools) ──

  upsertGlobalMcp(row: {
    id: string;
    name: string;
    config: McpConfig;
    description?: string;
    enabled: Partial<Record<AppType, boolean>>;
  }): SyncReport {
    this.mcp.upsert(row);
    return this.syncGlobal();
  }

  toggleGlobalMcp(id: string, app: AppType, enabled: boolean): SyncReport {
    this.mcp.setEnabled(id, app, enabled);
    return this.syncGlobal(app);
  }

  deleteGlobalMcp(id: string): SyncReport {
    this.mcp.delete(id);
    return this.syncGlobal();
  }

  // ── Sync orchestration ────────────────────────────────────

  /** Sync DB → tool files for the given scope (default = all Phase-1 tools, global). */
  syncGlobal(only?: AppType): SyncReport {
    const scope: Scope = { kind: "global" };
    const report: SyncReport = { byApp: {} };
    for (const app of APP_TYPES) {
      if (only && app !== only) continue;
      const adapter = this.adapters.get(app);
      if (!adapter) continue;
      try {
        const ours = this.mcp.enabledFor(app);
        const out = syncMcp(adapter, scope, ours, this.manifests);
        // Apply DB mutations the reconcile returned.
        for (const [name, cfg] of Object.entries(out.imports)) {
          this.mcp.upsertByName(name, cfg, app);
        }
        for (const name of out.disables) {
          this.mcp.setEnabledByName(name, app, false);
        }
        if (out.conflicts.length > 0) {
          log.warn(`[${app}] reconcile conflicts: ${out.conflicts.join(", ")}`);
        }
        report.byApp[app] = out;
      } catch (e: any) {
        log.error(`[${app}] sync failed: ${e?.message ?? e}`);
        report.byApp[app] = { imports: {}, disables: [], conflicts: [], synced: false };
      }
    }
    return report;
  }
}
