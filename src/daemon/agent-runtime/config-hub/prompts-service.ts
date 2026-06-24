/**
 * PromptsService — managed-block fan-out for CLAUDE.md / AGENTS.md / GEMINI.md.
 *
 * Model: single canonical source → fan out to all three files, but each file
 * keeps its block marked with `<!-- hub:start --> … <!-- hub:end -->`. Content
 * OUTSIDE the block is owned by the user/tool and is NEVER touched.
 *
 * Drift detection (handles "the model itself edited CLAUDE.md/AGENTS.md"):
 *   base = hash of what hub last wrote into the block (per app, in manifest)
 *   file_block = hash of the block content right now
 *   db = hash of the canonical content
 *
 *   only db changed         → write the new canonical into all files
 *   only file_block changed → import that file's block back into DB canonical,
 *                              then fan it out to the other files (the user's
 *                              "edit anywhere → sync everywhere" intent)
 *   both changed            → CONFLICT, leave the file alone, surface it
 *   marker missing          → re-insert the block at the file's end
 *   no enabled prompt       → remove block from files (keep user prose)
 *
 * Schema-compat note: cc-switch v10's `prompts` table is keyed by (id, app_type).
 * We preserve that layout by storing 3 rows per logical prompt with identical
 * content; the single-canonical invariant is enforced at this service layer.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AppType } from "./types.js";
import { APP_TYPES } from "./types.js";
import type { AdapterRegistry } from "./adapters/base.js";
import type { SqliteManifestStore } from "./db/dao.js";
import { writeFileAtomic, backupFile } from "./util.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("config-hub");
const MARK_START = "<!-- hub:start -->";
const MARK_END = "<!-- hub:end -->";
const MANIFEST_KEY = "__block__";
const PROMPT_SCOPE = "global:prompts";

export type PromptAction =
  | "written"
  | "removed"
  | "imported"
  | "marker_restored"
  | "conflict"
  | "noop";

export interface PromptRow {
  id: string;
  name: string;
  content: string;
  description: string | null;
  enabled: boolean;
}

export interface PromptSyncReport {
  byApp: Partial<Record<AppType, { action: PromptAction; conflictWith?: string }>>;
  conflicts: string[];
}

function hashStr(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface ExtractedBlock {
  inner: string;
  hasMarkers: boolean;
  startIdx: number;
  endIdx: number;
}

export function extractBlock(text: string): ExtractedBlock {
  const s = text.indexOf(MARK_START);
  if (s === -1) return { inner: "", hasMarkers: false, startIdx: -1, endIdx: -1 };
  const e = text.indexOf(MARK_END, s + MARK_START.length);
  if (e === -1) return { inner: "", hasMarkers: false, startIdx: -1, endIdx: -1 };
  return {
    inner: text.slice(s + MARK_START.length, e).trim(),
    hasMarkers: true,
    startIdx: s,
    endIdx: e + MARK_END.length,
  };
}

export function upsertBlock(text: string, content: string): string {
  const blockText = `${MARK_START}\n${content.trim()}\n${MARK_END}`;
  const { hasMarkers, startIdx, endIdx } = extractBlock(text);
  if (hasMarkers) {
    return text.slice(0, startIdx) + blockText + text.slice(endIdx);
  }
  const trimmed = text.replace(/\s+$/, "");
  return (trimmed.length > 0 ? trimmed + "\n\n" : "") + blockText + "\n";
}

export function removeBlock(text: string): string {
  const { hasMarkers, startIdx, endIdx } = extractBlock(text);
  if (!hasMarkers) return text;
  const before = text.slice(0, startIdx).replace(/[ \t]+$/, "");
  const after = text.slice(endIdx);
  return (before + after).replace(/\n{3,}/g, "\n\n");
}

export class PromptsService {
  constructor(
    private readonly db: Database,
    private readonly adapters: AdapterRegistry,
    private readonly manifests?: SqliteManifestStore,
  ) {}

  // ── Reads ────────────────────────────────────────────────

  list(): PromptRow[] {
    const rows = this.db
      .query(
        `SELECT id, MAX(name) AS name, MAX(content) AS content,
                MAX(description) AS description, MAX(enabled) AS enabled
         FROM prompts GROUP BY id`,
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? "",
      content: r.content ?? "",
      description: r.description ?? null,
      enabled: !!r.enabled,
    }));
  }

  get(id: string): PromptRow | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  // ── Writes (each mutation auto-syncs all tools) ──────────

  upsertCanonical(opts: {
    id: string;
    name: string;
    content: string;
    description?: string;
    enabled?: boolean;
  }): PromptSyncReport {
    const now = Date.now();
    const enabled = opts.enabled !== false ? 1 : 0;
    const tx = this.db.transaction(() => {
      if (enabled) this.db.run(`UPDATE prompts SET enabled = 0`); // single-enabled invariant
      for (const app of APP_TYPES) {
        this.db.run(
          `INSERT INTO prompts (id, app_type, name, content, description, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id, app_type) DO UPDATE SET
             name=excluded.name,
             content=excluded.content,
             description=excluded.description,
             enabled=excluded.enabled,
             updated_at=excluded.updated_at`,
          [opts.id, app, opts.name, opts.content, opts.description ?? "", enabled, now, now],
        );
      }
    });
    tx();
    return this.syncAll();
  }

  setEnabled(id: string, enabled: boolean): PromptSyncReport {
    if (enabled) {
      this.db.run(`UPDATE prompts SET enabled = 0`);
      this.db.run(`UPDATE prompts SET enabled = 1 WHERE id = ?`, [id]);
    } else {
      this.db.run(`UPDATE prompts SET enabled = 0 WHERE id = ?`, [id]);
    }
    return this.syncAll();
  }

  delete(id: string): PromptSyncReport {
    this.db.run(`DELETE FROM prompts WHERE id = ?`, [id]);
    return this.syncAll();
  }

  // ── Sync (per-file 3-way reconcile) ──────────────────────

  syncAll(): PromptSyncReport {
    const enabled = this.db
      .query(`SELECT id, content FROM prompts WHERE enabled = 1 LIMIT 1`)
      .get() as { id: string; content: string } | null;

    const report: PromptSyncReport = { byApp: {}, conflicts: [] };
    for (const app of APP_TYPES) {
      const adapter = this.adapters.get(app);
      if (!adapter?.promptPath) continue;
      if (!adapter.isPresent({ kind: "global" })) continue;
      const path = adapter.promptPath({ kind: "global" });
      if (!path) continue;
      try {
        const r = this.syncFile(app, path, enabled);
        report.byApp[app] = r;
        if (r.action === "conflict" && r.conflictWith) report.conflicts.push(`${app}: ${r.conflictWith}`);
      } catch (e: any) {
        log.warn(`[prompts:${app}] sync failed: ${e?.message ?? e}`);
        report.byApp[app] = { action: "noop" };
      }
    }
    return report;
  }

  // ── Private ──────────────────────────────────────────────

  private getBaseHash(app: AppType): string {
    if (!this.manifests) return "";
    const m = this.manifests.get(app, PROMPT_SCOPE);
    return m[MANIFEST_KEY] ?? "";
  }

  private setBaseHash(app: AppType, hash: string): void {
    if (!this.manifests) return;
    this.manifests.set(app, PROMPT_SCOPE, hash ? { [MANIFEST_KEY]: hash } : {});
  }

  private importCanonicalContent(content: string): void {
    const now = Date.now();
    this.db.run(`UPDATE prompts SET content = ?, updated_at = ? WHERE enabled = 1`, [content, now]);
  }

  private syncFile(
    app: AppType,
    path: string,
    enabled: { id: string; content: string } | null,
  ): { action: PromptAction; conflictWith?: string } {
    const baseHash = this.getBaseHash(app);
    const currentText = existsSync(path) ? readFileSync(path, "utf8") : "";
    const { inner, hasMarkers } = extractBlock(currentText);
    const currentBlockHash = hasMarkers ? hashStr(inner) : "";

    if (!enabled) {
      if (!hasMarkers) return { action: "noop" };
      backupFile(path);
      writeFileAtomic(path, removeBlock(currentText));
      this.setBaseHash(app, "");
      return { action: "removed" };
    }

    const ourHash = hashStr(enabled.content);

    // Drift in file's block since hub last wrote it.
    if (hasMarkers && baseHash && currentBlockHash !== baseHash) {
      if (ourHash !== baseHash) {
        // Both DB canonical and file block diverged → real conflict.
        return { action: "conflict", conflictWith: "both DB canonical and file block changed since last sync" };
      }
      // Only file changed → import back into canonical and re-fan-out next tick.
      this.importCanonicalContent(inner);
      this.setBaseHash(app, currentBlockHash);
      return { action: "imported" };
    }

    // Either no drift, or marker missing → write canonical.
    backupFile(path);
    const newText = upsertBlock(currentText, enabled.content);
    writeFileAtomic(path, newText);
    this.setBaseHash(app, ourHash);
    return { action: hasMarkers ? "written" : "marker_restored" };
  }
}
