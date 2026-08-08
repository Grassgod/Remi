/**
 * RemiData — Auth tokens and token sync rules.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TokenStatus } from "./types.js";
import { RemiDataContext } from "./context.js";

export class TokenSyncData {
  constructor(private readonly ctx: RemiDataContext) {}

  readSyncRules(): Array<{ name: string; source: string; target: string; format: string; key?: string; extraKeys?: Record<string, string> }> {
    const config = this.ctx._getConfigStore().load();
    return config.tokenSync.map(r => ({
      name: r.name ?? "",
      source: r.source ?? "",
      target: r.target ?? "",
      format: r.format ?? "mirror",
      ...(r.key ? { key: r.key } : {}),
      ...(r.extraKeys ? { extraKeys: r.extraKeys } : {}),
    }));
  }

  saveSyncRules(rules: Array<{ name: string; source: string; target: string; format: string; key?: string; extraKeys?: Record<string, string> }>): boolean {
    try {
      this.ctx._getConfigStore().setSection("tokenSync", rules);
      return true;
    } catch { return false; }
  }

  /** Preview source token + synced target file for a sync rule */
  previewSyncRule(source: string, target: string): { sourceContent: string | null; targetContent: string | null } {
    // Read source tokens
    let sourceContent: string | null = null;
    const tokensPath = join(this.ctx.root, "auth", "tokens.json");
    if (existsSync(tokensPath)) {
      try {
        const all = JSON.parse(readFileSync(tokensPath, "utf-8"));
        const [adapter, tokenType] = source.split("/", 2);
        if (tokenType === "*") {
          // All tokens for this adapter
          sourceContent = all[adapter] ? JSON.stringify(all[adapter], null, 2) : null;
        } else {
          sourceContent = all[adapter]?.[tokenType] ? JSON.stringify(all[adapter][tokenType], null, 2) : null;
        }
      } catch {}
    }

    // Read target file
    let targetContent: string | null = null;
    const expandedTarget = target.replace(/^~/, homedir());
    if (existsSync(expandedTarget)) {
      try {
        const raw = readFileSync(expandedTarget, "utf-8");
        // Try to pretty-print JSON
        try { targetContent = JSON.stringify(JSON.parse(raw), null, 2); } catch { targetContent = raw; }
      } catch {}
    }

    return { sourceContent, targetContent };
  }

  readTokenStatus(): TokenStatus[] {
    const p = join(this.ctx.root, "auth", "tokens.json");
    if (!existsSync(p)) return [];

    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const now = Date.now();
      const results: TokenStatus[] = [];

      for (const [service, types] of Object.entries(data)) {
        for (const [type, token] of Object.entries(types as Record<string, any>)) {
          const expiresAt = token.expiresAt ?? 0;
          const msLeft = expiresAt - now;
          results.push({
            service,
            type,
            valid: msLeft > 0,
            expiresAt,
            expiresIn: humanDuration(msLeft),
            refreshable: !!token.refreshToken,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}

function humanDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
