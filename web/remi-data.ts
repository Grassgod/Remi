/**
 * RemiData — File-system data access layer for ~/.remi/
 *
 * Reads/writes Remi's persistent data directly from disk.
 * Zero dependency on Remi core — completely decoupled.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync, realpathSync, appendFileSync, renameSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { MetricsCollector, type AnalyticsSummary, type DailySummary, type TokenMetricEntry } from "../src/metrics/collector.js";
import { type TraceData, type SpanData, rowToTraceData } from "../src/tracing.js";
import { getDb } from "../src/db/index.js";
import { readLogEntries, type LogEntry } from "../src/logger.js";
import { MemoryStore, type RecallDebugResult } from "../src/memory/store.js";
import { Cron } from "croner";

// ── Types ──────────────────────────────────────────────

export interface EntitySummary {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
  related: string[];
  path: string;       // relative to entities/
  updatedAt: string;
}

export interface EntityDetail extends EntitySummary {
  content: string;     // full markdown including frontmatter
  body: string;        // markdown body only
  createdAt: string;
}

export interface TokenStatus {
  service: string;
  type: string;
  valid: boolean;
  expiresAt: number;
  expiresIn: string;   // human-readable
  refreshable: boolean;
}

export interface DailyLogEntry {
  date: string;
  size: number;
}

export interface SearchResult {
  source: string;      // "entity" | "daily" | "global"
  name: string;
  snippet: string;
  path: string;
}

export type { RecallDebugResult } from "../src/memory/store.js";

// ── Helpers ────────────────────────────────────────────

function pluralize(type: string): string {
  if (type === "person") return "people";
  if (type === "child") return "children";
  return type + "s";
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

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

// ── RemiData Class ─────────────────────────────────────

export class RemiData {
  readonly root: string;       // ~/.remi
  readonly memoryDir: string;  // ~/.remi/memory
  private _metrics: MetricsCollector;
  private _analyticsCache: { data: AnalyticsSummary; ts: number } | null = null;
  private readonly _cacheTTL = 60_000; // 60s
  private _memoryStore: MemoryStore | null = null;

  constructor(remiDir?: string) {
    this.root = remiDir ?? join(homedir(), ".remi");
    this.memoryDir = join(this.root, "memory");
    this._metrics = new MetricsCollector(this.root);
  }

  // ── Memory: MEMORY.md ──────────────────────────────

  readGlobalMemory(): string {
    const p = join(this.memoryDir, "MEMORY.md");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  writeGlobalMemory(content: string): void {
    const p = join(this.memoryDir, "MEMORY.md");
    this._backup(p);
    writeFileSync(p, content, "utf-8");
  }

  // ── Memory: Entities ───────────────────────────────

  listEntities(): EntitySummary[] {
    const entitiesDir = join(this.memoryDir, "entities");
    const results: EntitySummary[] = [];

    // 1. Scan entities/{type}/*.md
    if (existsSync(entitiesDir)) {
      for (const typeDir of readdirSync(entitiesDir)) {
        const typePath = join(entitiesDir, typeDir);
        if (!statSync(typePath).isDirectory()) continue;

        for (const file of readdirSync(typePath)) {
          if (!file.endsWith(".md")) continue;
          try {
            const fullPath = join(typePath, file);
            const raw = readFileSync(fullPath, "utf-8");
            const { data } = matter(raw);
            results.push({
              type: data.type ?? typeDir,
              name: data.name ?? basename(file, ".md"),
              tags: data.tags ?? [],
              summary: data.summary ?? "",
              aliases: data.aliases ?? [],
              related: data.related ?? [],
              path: `${typeDir}/${file}`,
              updatedAt: data.updated ?? data.created ?? "",
            });
          } catch {
            // skip malformed files
          }
        }
      }
    }

    // 2. Scan loose *.md files in memory root (feedback_*, from_*, etc.)
    const SKIP_ROOT = new Set(["MEMORY.md", "claude-bridge.md", ".bridge-snapshot", ".conversation_summary.md"]);
    for (const file of readdirSync(this.memoryDir)) {
      if (!file.endsWith(".md") || SKIP_ROOT.has(file) || file.startsWith(".")) continue;
      const fullPath = join(this.memoryDir, file);
      if (!statSync(fullPath).isFile()) continue;
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const { data } = matter(raw);
        if (!data.type && !data.name) continue; // skip files without frontmatter
        // Override type for loose files: from_* are archives, not projects
        let looseType = data.type ?? "note";
        if (file.startsWith("from_")) looseType = "archive";
        results.push({
          type: looseType,
          name: data.name ?? basename(file, ".md"),
          tags: data.tags ?? [],
          summary: data.description ?? data.summary ?? "",
          aliases: data.aliases ?? [],
          related: data.related ?? [],
          path: `_root/${file}`,
          updatedAt: data.updated ?? data.created ?? "",
        });
      } catch { /* skip */ }
    }

    return results;
  }

  // ── Memory: Project-level memories ─────────────────

  listProjectMemories(): Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    hasMemoryMd: boolean;
    memoryMdSize: number;
    files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }>;
  }> {
    const projectsDir = join(this.root, "projects");
    if (!existsSync(projectsDir)) return [];

    const results: Array<{
      projectId: string;
      projectName: string;
      projectPath: string;
      hasMemoryMd: boolean;
      memoryMdSize: number;
      files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }>;
    }> = [];

    // Resolve global memoryDir real path to detect symlink duplicates
    const globalMemoryReal = realpathSync(this.memoryDir);

    for (const projectDir of readdirSync(projectsDir)) {
      const memoryDir = join(projectsDir, projectDir, "memory");
      if (!existsSync(memoryDir) || !statSync(memoryDir).isDirectory()) continue;

      // Skip directories that are symlinks to the global memory (e.g. -home-hehuajie)
      try {
        if (realpathSync(memoryDir) === globalMemoryReal) continue;
      } catch { /* if realpath fails, include it */ }

      // Derive human-readable project name from path-encoded dir name
      // e.g. "-data00-home-hehuajie-project-larkparser" → "larkparser"
      const parts = projectDir.split("-project-");
      const projectName = parts.length > 1
        ? parts[parts.length - 1].replace(/-/g, "_")
        : projectDir;

      // Derive original filesystem path
      const projectPath = "/" + projectDir.replace(/^-/, "").replace(/-/g, "/");

      // Check for MEMORY.md
      const memoryMdPath = join(memoryDir, "MEMORY.md");
      const hasMemoryMd = existsSync(memoryMdPath);
      const memoryMdSize = hasMemoryMd ? statSync(memoryMdPath).size : 0;

      // Scan all .md files in memory dir (recursively one level)
      const files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }> = [];
      const scanDir = (dir: string, prefix: string) => {
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
          if (f.startsWith(".")) continue;
          const fp = join(dir, f);
          const st = statSync(fp);
          if (st.isDirectory()) {
            scanDir(fp, `${prefix}${f}/`);
          } else if (f.endsWith(".md")) {
            try {
              const raw = readFileSync(fp, "utf-8");
              const { data } = matter(raw);
              files.push({
                name: data.name ?? basename(f, ".md"),
                type: data.type ?? (f === "MEMORY.md" ? "memory" : "note"),
                summary: data.description ?? data.summary ?? "",
                path: `${prefix}${f}`,
                updatedAt: data.updated ?? "",
              });
            } catch {
              files.push({
                name: basename(f, ".md"),
                type: f === "MEMORY.md" ? "memory" : "note",
                summary: "",
                path: `${prefix}${f}`,
                updatedAt: "",
              });
            }
          }
        }
      };
      scanDir(memoryDir, "");

      // Only include projects that have actual content
      if (files.length > 0 || hasMemoryMd) {
        results.push({ projectId: projectDir, projectName, projectPath, hasMemoryMd, memoryMdSize, files });
      }
    }

    return results.sort((a, b) => b.files.length - a.files.length);
  }

  readProjectMemoryFile(projectId: string, filePath: string): string {
    const fp = join(this.root, "projects", projectId, "memory", filePath);
    return existsSync(fp) ? readFileSync(fp, "utf-8") : "";
  }

  readEntity(type: string, name: string): EntityDetail | null {
    // Try loose root files first (feedback, archive, note types from _root/)
    const filePath = this._findEntityFile(type, name) ?? this._findLooseFile(name);
    if (!filePath || !existsSync(filePath)) return null;

    const raw = readFileSync(filePath, "utf-8");
    const { data, content: body } = matter(raw);
    const entitiesDir = join(this.memoryDir, "entities");

    // Use the requested type (which may have been overridden during listing)
    // e.g. from_* files have frontmatter type=project but are listed as archive
    const isLooseFile = filePath.startsWith(this.memoryDir + "/") && !filePath.includes("/entities/");
    const effectiveType = isLooseFile ? type : (data.type ?? type);

    return {
      type: effectiveType,
      name: data.name ?? name,
      tags: data.tags ?? [],
      summary: data.summary ?? "",
      aliases: data.aliases ?? [],
      related: data.related ?? [],
      path: filePath.replace(entitiesDir + "/", ""),
      updatedAt: data.updated ?? "",
      createdAt: data.created ?? "",
      content: raw,
      body: body.trim(),
    };
  }

  createEntity(opts: { type: string; name: string; observation?: string; tags?: string[]; summary?: string }): void {
    const typeDir = join(this.memoryDir, "entities", pluralize(opts.type));
    if (!existsSync(typeDir)) mkdirSync(typeDir, { recursive: true });

    const slug = opts.name.replace(/[^\w\u4e00-\u9fff-]/g, "-").replace(/-+/g, "-");
    let filePath = join(typeDir, `${slug}.md`);
    let i = 2;
    while (existsSync(filePath)) {
      filePath = join(typeDir, `${slug}-${i}.md`);
      i++;
    }

    const now = isoNow();
    const frontmatter = {
      type: opts.type,
      name: opts.name,
      created: now,
      updated: now,
      tags: opts.tags ?? [],
      source: "user-explicit",
      summary: opts.summary ?? "",
      aliases: [],
      related: [],
    };

    let body = `\n# ${opts.name}\n`;
    if (opts.observation) {
      const date = new Date().toISOString().split("T")[0];
      body += `\n## 备注\n- [${date}] ${opts.observation}\n`;
    }

    writeFileSync(filePath, matter.stringify(body, frontmatter), "utf-8");
  }

  updateEntity(type: string, name: string, content: string): boolean {
    const filePath = this._findEntityFile(type, name);
    if (!filePath) return false;

    this._backup(filePath);

    // Update the "updated" timestamp in frontmatter
    const { data, content: body } = matter(content);
    data.updated = isoNow();
    writeFileSync(filePath, matter.stringify(body, data), "utf-8");
    return true;
  }

  deleteEntity(type: string, name: string): boolean {
    const filePath = this._findEntityFile(type, name);
    if (!filePath || !existsSync(filePath)) return false;

    this._backup(filePath);
    unlinkSync(filePath);
    return true;
  }

  private _findEntityFile(type: string, name: string): string | null {
    const typeDir = join(this.memoryDir, "entities", pluralize(type));
    if (!existsSync(typeDir)) return null;

    // Try direct slug match
    const slug = name.replace(/[^\w\u4e00-\u9fff-]/g, "-").replace(/-+/g, "-");
    const direct = join(typeDir, `${slug}.md`);
    if (existsSync(direct)) return direct;

    // Scan files and match by frontmatter name
    for (const file of readdirSync(typeDir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(typeDir, file), "utf-8");
        const { data } = matter(raw);
        if (data.name === name) return join(typeDir, file);
        if (data.aliases?.includes(name)) return join(typeDir, file);
      } catch { /* skip */ }
    }
    return null;
  }

  private _findLooseFile(name: string): string | null {
    // Search loose *.md files in memory root by frontmatter name
    for (const file of readdirSync(this.memoryDir)) {
      if (!file.endsWith(".md") || file.startsWith(".")) continue;
      const fp = join(this.memoryDir, file);
      if (!statSync(fp).isFile()) continue;
      try {
        const { data } = matter(readFileSync(fp, "utf-8"));
        if (data.name === name) return fp;
      } catch { /* skip */ }
    }
    return null;
  }

  // ── Memory: Search ─────────────────────────────────

  searchMemory(query: string): SearchResult[] {
    const q = query.toLowerCase();
    const results: SearchResult[] = [];

    // Search global memory
    const globalMem = this.readGlobalMemory();
    if (globalMem.toLowerCase().includes(q)) {
      const lines = globalMem.split("\n");
      const matchLine = lines.find(l => l.toLowerCase().includes(q)) ?? "";
      results.push({ source: "global", name: "MEMORY.md", snippet: matchLine.trim().slice(0, 200), path: "MEMORY.md" });
    }

    // Search entities
    for (const entity of this.listEntities()) {
      const matchFields = [entity.name, entity.summary, ...entity.tags, ...entity.aliases]
        .join(" ").toLowerCase();
      if (matchFields.includes(q)) {
        results.push({ source: "entity", name: entity.name, snippet: entity.summary || entity.type, path: entity.path });
      }
    }

    // Search daily logs
    for (const { date } of this.listDailyDates()) {
      const content = this.readDaily(date);
      if (content.toLowerCase().includes(q)) {
        const lines = content.split("\n");
        const matchLine = lines.find(l => l.toLowerCase().includes(q)) ?? "";
        results.push({ source: "daily", name: date, snippet: matchLine.trim().slice(0, 200), path: `daily/${date}.md` });
      }
    }

    // Search project-level memories
    for (const pm of this.listProjectMemories()) {
      for (const f of pm.files) {
        const content = this.readProjectMemoryFile(pm.projectId, f.path);
        if (content.toLowerCase().includes(q)) {
          const lines = content.split("\n");
          const matchLine = lines.find(l => l.toLowerCase().includes(q)) ?? "";
          results.push({ source: "project", name: `${pm.projectName}/${f.name}`, snippet: matchLine.trim().slice(0, 200), path: `${pm.projectId}:${f.path}` });
        }
      }
    }

    return results;
  }

  async recallDebug(query: string, cwd?: string): Promise<RecallDebugResult> {
    if (!this._memoryStore) {
      let vectorStore = null;
      try {
        const config = this._readRawConfig();
        const apiKey = (config?.embedding as Record<string, unknown>)?.api_key as string | undefined;
        if (apiKey) {
          const { VectorStore } = require("../src/db/vector-store.js");
          vectorStore = new VectorStore({ provider: "voyage", apiKey });
        }
      } catch { /* VectorStore unavailable */ }
      this._memoryStore = new MemoryStore(this.memoryDir, vectorStore);
    }
    return this._memoryStore.recall(query, { cwd, debug: true });
  }

  // ── Memory: Daily Logs ─────────────────────────────

  listDailyDates(): DailyLogEntry[] {
    const dailyDir = join(this.memoryDir, "daily");
    if (!existsSync(dailyDir)) return [];

    return readdirSync(dailyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => {
        const stat = statSync(join(dailyDir, f));
        return { date: f.replace(".md", ""), size: stat.size };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  readDaily(date: string): string {
    const p = join(this.memoryDir, "daily", `${date}.md`);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  // ── Auth Tokens ────────────────────────────────────

  readTokenStatus(): TokenStatus[] {
    const p = join(this.root, "auth", "tokens.json");
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

  // ── Config ─────────────────────────────────────────

  readConfig(): Record<string, any> {
    // Search: ./remi.toml then ~/.remi/remi.toml
    const paths = [
      join(process.cwd(), "remi.toml"),
      join(this.root, "remi.toml"),
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        try {
          const raw = readFileSync(p, "utf-8");
          const config = parseToml(raw) as Record<string, any>;
          // Redact secrets
          if (config.feishu) {
            if (config.feishu.app_secret) config.feishu.app_secret = "***";
            if (config.feishu.encrypt_key) config.feishu.encrypt_key = "***";
            if (config.feishu.verification_token) config.feishu.verification_token = "***";
            if (config.feishu.user_access_token) config.feishu.user_access_token = "***";
          }
          return { ...config, _path: p };
        } catch {
          return {};
        }
      }
    }
    return {};
  }

  updateConfig(patch: Record<string, any>): boolean {
    const p = join(this.root, "remi.toml");
    if (!existsSync(p)) return false;

    try {
      const raw = readFileSync(p, "utf-8");
      const config = parseToml(raw) as Record<string, any>;

      // Deep merge patch into config (one level deep)
      for (const [key, val] of Object.entries(patch)) {
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          config[key] = { ...(config[key] as any ?? {}), ...val };
        } else {
          config[key] = val;
        }
      }

      writeFileSync(p, stringifyToml(config), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  // ── Projects ─────────────────────────────────────────

  readProjects(): Record<string, string> {
    const config = this._readRawConfig();
    return (config.projects ?? {}) as Record<string, string>;
  }

  saveProject(alias: string, path: string): boolean {
    const config = this._readRawConfig();
    if (!config.projects) config.projects = {};
    (config.projects as Record<string, string>)[alias] = path;
    return this._writeRawConfig(config);
  }

  deleteProject(alias: string): boolean {
    const config = this._readRawConfig();
    if (!config.projects || !(alias in (config.projects as Record<string, string>))) return false;
    delete (config.projects as Record<string, string>)[alias];
    return this._writeRawConfig(config);
  }

  private _readRawConfig(): Record<string, any> {
    const paths = [
      join(process.cwd(), "remi.toml"),
      join(this.root, "remi.toml"),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        try {
          return parseToml(readFileSync(p, "utf-8")) as Record<string, any>;
        } catch { return {}; }
      }
    }
    return {};
  }

  private _writeRawConfig(config: Record<string, any>): boolean {
    const p = join(this.root, "remi.toml");
    try {
      writeFileSync(p, stringifyToml(config), "utf-8");
      return true;
    } catch { return false; }
  }

  // ── Daemon ─────────────────────────────────────────

  getDaemonPid(): number | null {
    const p = join(this.root, "remi.pid");
    if (!existsSync(p)) return null;

    try {
      return parseInt(readFileSync(p, "utf-8").trim(), 10);
    } catch {
      return null;
    }
  }

  isDaemonAlive(): boolean {
    const pid = this.getDaemonPid();
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // ── Status (aggregate) ─────────────────────────────

  getStatus() {
    const pid = this.getDaemonPid();
    const alive = this.isDaemonAlive();
    const tokens = this.readTokenStatus();
    const entities = this.listEntities();
    const dailyLogs = this.listDailyDates();

    // Session counts from DB
    let sessionTotal = 0, sessionMain = 0, sessionThreads = 0;
    try {
      const db = getDb();
      const rows = db.query("SELECT session_key FROM sessions").all() as { session_key: string }[];
      sessionTotal = rows.length;
      sessionThreads = rows.filter(r => r.session_key.includes(":thread:")).length;
      sessionMain = sessionTotal - sessionThreads;
    } catch {}

    return {
      daemon: { pid, alive },
      sessions: {
        total: sessionTotal,
        main: sessionMain,
        threads: sessionThreads,
      },
      tokens: {
        total: tokens.length,
        valid: tokens.filter(t => t.valid).length,
        nextExpiry: tokens.length > 0
          ? tokens.reduce((min, t) => t.expiresAt < min.expiresAt ? t : min).expiresIn
          : null,
      },
      memory: {
        entities: entities.length,
        entityTypes: [...new Set(entities.map(e => e.type))],
        dailyLogs: dailyLogs.length,
        latestLog: dailyLogs[0]?.date ?? null,
      },
    };
  }

  // ── Analytics ──────────────────────────────────────

  getAnalyticsSummary(): AnalyticsSummary {
    const now = Date.now();
    if (this._analyticsCache && now - this._analyticsCache.ts < this._cacheTTL) {
      return this._analyticsCache.data;
    }
    const data = this._metrics.getAnalytics();
    this._analyticsCache = { data, ts: now };
    return data;
  }

  getAnalyticsDaily(start: string, end: string): DailySummary[] {
    return this._metrics.getSummary(start, end);
  }

  getRecentMetrics(limit: number): TokenMetricEntry[] {
    return this._metrics.getRecent(limit);
  }

  async refreshUsageQuotas(): Promise<void> {
    await this._metrics.fetchUsageFromAPI();
    this._analyticsCache = null;
  }

  // scanCliUsage removed — metrics now recorded in real-time via core.ts

  // ── Traces ─────────────────────────────────────────

  getTraces(date: string, limit: number): TraceData[] {
    const db = getDb();
    const rows = db.query(`
      SELECT id, status, error, chat_id, sender_id, connector,
             cli_session_id, cost_usd, duration_ms, model,
             input_tokens, output_tokens, spans,
             created_at, cli_round_start, cli_round_end
      FROM conversations
      WHERE DATE(created_at) = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(date, limit) as any[];
    return rows.map(rowToTraceData);
  }

  getTrace(traceId: string): TraceData | null {
    const db = getDb();
    const row = db.query("SELECT * FROM conversations WHERE id = ?").get(Number(traceId)) as any | null;
    return row ? rowToTraceData(row) : null;
  }

  // ── Logs ──────────────────────────────────────────

  getLogs(query: { date: string; level?: string | null; module?: string | null; traceId?: string | null; search?: string | null; limit: number; offset: number }): { entries: LogEntry[]; total: number; hasMore: boolean } {
    const logsDir = join(this.root, "logs");
    let entries = readLogEntries(query.date, logsDir);

    // Apply filters
    if (query.level) {
      const lvl = query.level.toUpperCase();
      entries = entries.filter(e => e.level === lvl);
    }
    if (query.module) {
      entries = entries.filter(e => e.module === query.module);
    }
    if (query.traceId) {
      entries = entries.filter(e => e.traceId === query.traceId);
    }
    if (query.search) {
      const s = query.search.toLowerCase();
      entries = entries.filter(e => e.msg.toLowerCase().includes(s));
    }

    const total = entries.length;
    // Reverse to show most recent first, then apply offset+limit
    entries.reverse();
    const sliced = entries.slice(query.offset, query.offset + query.limit);
    return { entries: sliced, total, hasMore: query.offset + query.limit < total };
  }

  getLogModules(date?: string): string[] {
    const logsDir = join(this.root, "logs");
    const d = date ?? new Date().toISOString().slice(0, 10);
    const entries = readLogEntries(d, logsDir);
    return [...new Set(entries.map(e => e.module))].sort();
  }

  getLogStats(query?: { date?: string; level?: string | null; module?: string | null; search?: string | null; traceId?: string | null }): {
    total: number;
    levels: { DEBUG: number; INFO: number; WARN: number; ERROR: number };
    hourly: Array<{ hour: number; count: number; errors: number }>;
    moduleCount: number;
    topModules: string[];
    lastError: string | null;
    lastErrorModule: string | null;
  } {
    const logsDir = join(this.root, "logs");
    const d = query?.date ?? new Date().toISOString().slice(0, 10);
    let entries = readLogEntries(d, logsDir);

    // Apply same filters as getLogs
    if (query?.level) {
      const lvl = query.level.toUpperCase();
      entries = entries.filter(e => e.level === lvl);
    }
    if (query?.module) {
      entries = entries.filter(e => e.module === query.module);
    }
    if (query?.traceId) {
      entries = entries.filter(e => e.traceId === query.traceId);
    }
    if (query?.search) {
      const s = query.search.toLowerCase();
      entries = entries.filter(e => e.msg.toLowerCase().includes(s));
    }

    const levels = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    const hourly: Array<{ hour: number; count: number; errors: number }> = Array.from(
      { length: 24 }, (_, i) => ({ hour: i, count: 0, errors: 0 })
    );
    const moduleCounts: Record<string, number> = {};
    let lastError: string | null = null;
    let lastErrorModule: string | null = null;

    for (const e of entries) {
      if (e.level in levels) levels[e.level as keyof typeof levels]++;
      try {
        const hour = new Date(e.ts).getHours();
        if (hour >= 0 && hour < 24) {
          hourly[hour].count++;
          if (e.level === "ERROR") hourly[hour].errors++;
        }
      } catch { /* skip entries with unparseable timestamps */ }
      moduleCounts[e.module] = (moduleCounts[e.module] ?? 0) + 1;
      if (e.level === "ERROR") {
        if (!lastError || e.ts > lastError) {
          lastError = e.ts;
          lastErrorModule = e.module;
        }
      }
    }

    const topModules = Object.entries(moduleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    return {
      total: entries.length,
      levels,
      hourly,
      moduleCount: Object.keys(moduleCounts).length,
      topModules,
      lastError,
      lastErrorModule,
    };
  }

  // ── Monitor ───────────────────────────────────────

  getMonitorStats(): Record<string, unknown> {
    const today = new Date().toISOString().slice(0, 10);

    // Uptime from PID file
    let uptime = 0;
    const pidFile = join(this.root, "remi.pid");
    if (existsSync(pidFile)) {
      try {
        const stat = statSync(pidFile);
        uptime = Math.floor((Date.now() - stat.mtimeMs) / 1000);
      } catch { /* ignore */ }
    }

    // Active sessions
    let activeSessions = 0;
    const sessionsFile = join(this.root, "sessions.json");
    if (existsSync(sessionsFile)) {
      try {
        const data = JSON.parse(readFileSync(sessionsFile, "utf-8"));
        activeSessions = data.entries?.length ?? 0;
      } catch { /* ignore */ }
    }

    // Metrics for today
    const todayMetrics = this._metrics.readDay(today);
    const requestsToday = todayMetrics.length;

    // Requests in the last hour
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const requestsLastHour = todayMetrics.filter(m => m.ts >= oneHourAgo).length;

    // Trace stats from DB
    const convRows = getDb().query(`
      SELECT status, duration_ms, spans FROM conversations WHERE DATE(created_at) = ?
    `).all(today) as Array<{ status: string; duration_ms: number | null; spans: string | null }>;

    const traceTotal = convRows.length;
    const errorSpansCount = convRows.filter(r => r.status === "failed").length;
    const errorRate = traceTotal > 0 ? (errorSpansCount / traceTotal) * 100 : 0;

    const durations = convRows
      .map(r => r.duration_ms ?? 0)
      .filter(d => d > 0)
      .sort((a, b) => a - b);

    const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : null;
    const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : null;
    const avg = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    // Top operations from spans JSON
    const opMap = new Map<string, { count: number; totalMs: number }>();
    for (const row of convRows) {
      let spanArr: Array<{ op: string; ms?: number }> = [];
      try { spanArr = JSON.parse(row.spans ?? "[]"); } catch { /* skip */ }
      for (const s of spanArr) {
        const existing = opMap.get(s.op);
        if (existing) {
          existing.count++;
          existing.totalMs += s.ms ?? 0;
        } else {
          opMap.set(s.op, { count: 1, totalMs: s.ms ?? 0 });
        }
      }
    }
    const topOperations = [...opMap.entries()]
      .map(([name, data]) => ({ name, count: data.count, avgMs: Math.round(data.totalMs / data.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Log count
    const logsDir = join(this.root, "logs");
    let logsCount = 0;
    const logFile = join(logsDir, `${today}.jsonl`);
    if (existsSync(logFile)) {
      try {
        logsCount = readFileSync(logFile, "utf-8").split("\n").filter(l => l.trim()).length;
      } catch { /* ignore */ }
    }

    return {
      uptime,
      activeSessions,
      requestsToday,
      requestsLastHour,
      errorsToday: errorSpansCount,
      errorRate: Math.round(errorRate * 10) / 10,
      latencyP50: p50,
      latencyP95: p95,
      latencyAvg: avg,
      tracesCount: traceTotal,
      logsCount,
      topOperations,
    };
  }

  /**
   * One-time migration: split mixed skill_run.jsonl into per-job files
   * by inferring jobId from UTC timestamp ranges.
   */
  private _migrateSkillRunJsonl(): void {
    const runsDir = join(this.root, "cron", "runs");
    const mixedFile = join(runsDir, "skill_run.jsonl");
    if (!existsSync(mixedFile)) return;

    const lines = readFileSync(mixedFile, "utf-8").trim().split("\n").filter(Boolean);
    const buckets = new Map<string, string[]>();

    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        const ts = raw.ts as string;
        const d = new Date(ts);
        const hh = d.getUTCHours();
        const mm = d.getUTCMinutes();

        let jobId: string | null = null;
        if (hh === 2 && mm >= 10 && mm < 25) jobId = "skill:ai-daily-briefing";
        else if (hh === 2 && mm >= 25 && mm < 40) jobId = "skill:feishu-insight";
        else if (hh === 2 && mm >= 40 && mm < 55) jobId = "skill:memory-research";
        else if (hh === 20 && mm >= 0 && mm < 15) jobId = "skill:repo-update";
        else if (hh === 20 && mm >= 15 && mm < 35) jobId = "skill:larkparser-answer-maintain";

        if (!jobId) continue; // discard unmatched entries

        const enriched = JSON.stringify({ ...raw, jobId, handler: "skill:run" });
        const arr = buckets.get(jobId) ?? [];
        arr.push(enriched);
        buckets.set(jobId, arr);
      } catch { /* skip malformed lines */ }
    }

    // Write per-job files (append, in case some already exist from new writes)
    for (const [jobId, entries] of buckets) {
      const safeId = jobId.replace(/[:/]/g, "_");
      appendFileSync(join(runsDir, `${safeId}.jsonl`), entries.join("\n") + "\n", "utf-8");
    }

    // Mark as migrated
    renameSync(mixedFile, mixedFile + ".migrated");
  }

  private _loadAllRuns(): Array<{
    ts: string; jobId: string; handler: string;
    status: "ok" | "error" | "skipped"; durationMs: number; error?: string;
  }> {
    const runsDir = join(this.root, "cron", "runs");
    if (!existsSync(runsDir)) return [];

    // Run migration on first access
    this._migrateSkillRunJsonl();

    const entries: Array<{
      ts: string; jobId: string; handler: string;
      status: "ok" | "error" | "skipped"; durationMs: number; error?: string;
    }> = [];

    for (const file of readdirSync(runsDir).filter(f => f.endsWith(".jsonl"))) {
      const content = readFileSync(join(runsDir, file), "utf-8").trim();
      if (!content) continue;
      const fallbackId = file.replace(".jsonl", "").replace(/_/g, ":");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const raw = JSON.parse(line);
          const jobId = raw.jobId ?? fallbackId;
          entries.push({
            ts: raw.ts,
            jobId,
            handler: raw.handler ?? fallbackId,
            status: raw.status,
            durationMs: raw.durationMs,
            error: raw.error,
          });
        } catch { /* skip malformed lines */ }
      }
    }

    return entries.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  private _calcNextRun(job: { cron?: string; every?: string | number; tz?: string }): string | null {
    if (job.cron) {
      try {
        const c = new Cron(job.cron, { timezone: job.tz ?? "Asia/Shanghai" });
        const next = c.nextRun();
        return next?.toISOString() ?? null;
      } catch { return null; }
    }
    return null;
  }

  private _formatSchedule(job: { cron?: string; every?: string | number; at?: string }): { kind: string; expr?: string; intervalMs?: number; at?: string } {
    if (job.cron) return { kind: "cron", expr: job.cron };
    if (job.every) {
      const val = job.every;
      if (typeof val === "number") return { kind: "every", intervalMs: val * 1000 };
      const match = String(val).match(/^(\d+)\s*(s|m|h|d)?$/i);
      if (!match) return { kind: "every", intervalMs: 300_000 };
      const num = parseInt(match[1], 10);
      const unit = (match[2] ?? "s").toLowerCase();
      const ms = unit === "m" ? num * 60_000 : unit === "h" ? num * 3_600_000 : unit === "d" ? num * 86_400_000 : num * 1000;
      return { kind: "every", intervalMs: ms };
    }
    if (job.at) return { kind: "at", at: job.at };
    return { kind: "unknown" };
  }

  // ── Scheduler (reads cron config from remi.toml) ─────

  private _loadCronJobs(): Array<{
    id: string; name?: string; handler: string; enabled: boolean;
    cron?: string; every?: string | number; at?: string;
    handlerConfig?: Record<string, any>;
  }> {
    const paths = [
      join(process.cwd(), "remi.toml"),
      join(this.root, "remi.toml"),
    ];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const config = parseToml(readFileSync(p, "utf-8")) as Record<string, any>;
        const cronSection = config.cron as { jobs?: any[] } | undefined;
        if (!cronSection?.jobs) return [];
        return cronSection.jobs.map((j: any) => ({
          id: j.id ?? "unknown",
          name: j.name,
          handler: j.handler ?? j.id,
          enabled: j.enabled !== false,
          cron: j.cron,
          every: j.every,
          at: j.at,
          handlerConfig: j.handler_config ?? j.handlerConfig,
        }));
      } catch { return []; }
    }
    return [];
  }

  getSchedulerStatus() {
    const allRuns = this._loadAllRuns();
    const jobs = this._loadCronJobs().map((job) => {
      const jobRuns = allRuns.filter(r => r.jobId === job.id);

      // lastRun: most recent entry for this job
      const last = jobRuns[0] ?? null;

      // consecutiveErrors: count from most recent backwards until non-error
      let consecutiveErrors = 0;
      for (const r of jobRuns) {
        if (r.status === "error") consecutiveErrors++;
        else break;
      }

      // nextRunAt: compute from cron expression
      const nextRunAt = this._calcNextRun(job);

      return {
        jobId: job.id,
        jobName: job.name ?? job.id,
        enabled: job.enabled !== false,
        handler: job.handler,
        schedule: this._formatSchedule(job),
        lastRun: last ? {
          status: last.status,
          finishedAt: last.ts,
          durationMs: last.durationMs,
          error: last.error,
        } : null,
        nextRunAt,
        consecutiveErrors,
      };
    });
    return { jobs };
  }

  getSchedulerHistory(jobId?: string, limit = 50): Array<{ ts: string; status: string; durationMs: number; error?: string; jobId: string }> {
    let runs = this._loadAllRuns();
    if (jobId) runs = runs.filter(r => r.jobId === jobId);
    return runs.slice(0, Math.min(limit, 200)).map(r => ({
      ts: r.ts,
      jobId: r.jobId,
      status: r.status,
      durationMs: r.durationMs,
      error: r.error,
    }));
  }

  getSchedulerSummary(days: number) {
    const allRuns = this._loadAllRuns();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentRuns = allRuns.filter(r => r.ts >= cutoff);

    // Aggregate by date
    const byDate = new Map<string, { total: number; ok: number; error: number; skipped: number }>();
    for (const r of recentRuns) {
      const date = r.ts.slice(0, 10); // YYYY-MM-DD
      const bucket = byDate.get(date) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
      bucket.total++;
      if (r.status === "ok") bucket.ok++;
      else if (r.status === "error") bucket.error++;
      else if (r.status === "skipped") bucket.skipped++;
      byDate.set(date, bucket);
    }

    // Fill zero-days to ensure every day has an entry
    const result: Array<{ date: string; total: number; ok: number; error: number; skipped: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      const bucket = byDate.get(dateStr) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
      result.push({ date: dateStr, ...bucket });
    }
    return result;
  }

  // ── Skills ─────────────────────────────────────────────

  private get skillsDir(): string {
    return join(homedir(), ".remi", ".claude", "skills");
  }

  listSkills(): Array<{
    name: string; description: string; hasSchedule: boolean;
    cron?: string; outputDir?: string; reportCount?: number; lastReportDate?: string;
  }> {
    const dir = this.skillsDir;
    if (!existsSync(dir)) return [];

    const cronJobs = this._loadCronJobs();
    const cronMap = new Map<string, { cron?: string; outputDir?: string }>();
    for (const job of cronJobs) {
      if (job.handler === "skill:run" && job.handlerConfig?.skillName) {
        cronMap.set(job.handlerConfig.skillName as string, {
          cron: job.cron,
          outputDir: job.handlerConfig.outputDir as string | undefined,
        });
      }
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => {
        const name = e.name;
        const skillMd = join(dir, name, "SKILL.md");
        let description = "";
        if (existsSync(skillMd)) {
          try {
            const { data } = matter(readFileSync(skillMd, "utf-8"));
            description = (data.description as string) ?? "";
          } catch {}
        }

        const cronInfo = cronMap.get(name);
        let reportCount = 0;
        let lastReportDate: string | undefined;
        if (cronInfo?.outputDir && existsSync(cronInfo.outputDir)) {
          const reports = readdirSync(cronInfo.outputDir)
            .filter(f => f.endsWith(".md"))
            .sort()
            .reverse();
          reportCount = reports.length;
          if (reports[0]) lastReportDate = reports[0].replace(".md", "");
        }

        return {
          name,
          description,
          hasSchedule: cronMap.has(name),
          cron: cronInfo?.cron,
          outputDir: cronInfo?.outputDir,
          reportCount,
          lastReportDate,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readSkillFile(name: string, path = "SKILL.md"): string | null {
    if (path.includes("..") || path.startsWith("/")) return null;
    const filePath = join(this.skillsDir, name, path);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    return readFileSync(filePath, "utf-8");
  }

  writeSkillFile(name: string, content: string, path = "SKILL.md"): boolean {
    if (path.includes("..") || path.startsWith("/")) return false;
    const filePath = join(this.skillsDir, name, path);
    if (!existsSync(filePath)) return false;
    this._backup(filePath);
    writeFileSync(filePath, content, "utf-8");
    return true;
  }

  listSkillReports(name: string): string[] {
    const skills = this.listSkills();
    const skill = skills.find(s => s.name === name);
    if (!skill?.outputDir || !existsSync(skill.outputDir)) return [];
    return readdirSync(skill.outputDir)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""))
      .sort()
      .reverse();
  }

  readSkillReport(name: string, date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const skills = this.listSkills();
    const skill = skills.find(s => s.name === name);
    if (!skill?.outputDir) return null;
    const filePath = join(skill.outputDir, `${date}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  // ── Backup ─────────────────────────────────────────

  private _backup(filePath: string): void {
    if (!existsSync(filePath)) return;

    const versionsDir = join(this.memoryDir, ".versions");
    if (!existsSync(versionsDir)) mkdirSync(versionsDir, { recursive: true });

    const stem = basename(filePath, extname(filePath));
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "T");
    const backupPath = join(versionsDir, `${stem}-${ts}${extname(filePath)}`);

    writeFileSync(backupPath, readFileSync(filePath), "utf-8");
  }
}
