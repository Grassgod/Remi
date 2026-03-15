/**
 * RemiData — File-system data access layer for ~/.remi/
 *
 * Reads/writes Remi's persistent data directly from disk.
 * Zero dependency on Remi core — completely decoupled.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { MetricsCollector, type AnalyticsSummary, type DailySummary, type TokenMetricEntry } from "../src/metrics/collector.js";
import { CliUsageScanner } from "../src/metrics/cli-parser.js";
import { type TraceData, type SpanData, rowToTraceData } from "../src/tracing.js";
import { getDb } from "../src/db/index.js";
import { readLogEntries, type LogEntry } from "../src/logger.js";

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

export interface SessionEntry {
  key: string;
  sessionId: string;
  isThread: boolean;
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

  constructor(remiDir?: string) {
    this.root = remiDir ?? join(homedir(), ".remi");
    this.memoryDir = join(this.root, "memory");
    this._metrics = new MetricsCollector(this.root);

    // Auto-scan CLI metrics on first startup
    try {
      const scanner = new CliUsageScanner(this._metrics.metricsDir);
      const entries = scanner.scanNew();
      for (const entry of entries) this._metrics.record(entry);
    } catch { /* non-critical */ }
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
    if (!existsSync(entitiesDir)) return [];

    const results: EntitySummary[] = [];
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
    return results;
  }

  readEntity(type: string, name: string): EntityDetail | null {
    const filePath = this._findEntityFile(type, name);
    if (!filePath || !existsSync(filePath)) return null;

    const raw = readFileSync(filePath, "utf-8");
    const { data, content: body } = matter(raw);
    const entitiesDir = join(this.memoryDir, "entities");

    return {
      type: data.type ?? type,
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

    return results;
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

  // ── Sessions ───────────────────────────────────────

  readSessions(): SessionEntry[] {
    const p = join(this.root, "sessions.json");
    if (!existsSync(p)) return [];

    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const entries: [string, string][] = data.entries ?? [];
      return entries.map(([key, sessionId]) => ({
        key,
        sessionId,
        isThread: key.includes(":thread:"),
      }));
    } catch {
      return [];
    }
  }

  clearSession(key: string): boolean {
    const p = join(this.root, "sessions.json");
    if (!existsSync(p)) return false;

    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const entries: [string, string][] = data.entries ?? [];
      const filtered = entries.filter(([k]) => k !== key);
      if (filtered.length === entries.length) return false;
      data.entries = filtered;
      data.savedAt = Date.now();
      writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  clearAllSessions(): number {
    const p = join(this.root, "sessions.json");
    if (!existsSync(p)) return 0;

    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const count = (data.entries ?? []).length;
      data.entries = [];
      data.savedAt = Date.now();
      writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
      return count;
    } catch {
      return 0;
    }
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
    const sessions = this.readSessions();
    const tokens = this.readTokenStatus();
    const entities = this.listEntities();
    const dailyLogs = this.listDailyDates();

    return {
      daemon: { pid, alive },
      sessions: {
        total: sessions.length,
        main: sessions.filter(s => !s.isThread).length,
        threads: sessions.filter(s => s.isThread).length,
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

  scanCliUsage(): { count: number } {
    const scanner = new CliUsageScanner(this._metrics.metricsDir);
    const entries = scanner.scanNew();
    for (const entry of entries) {
      this._metrics.record(entry);
    }
    this._analyticsCache = null; // invalidate cache
    return { count: entries.length };
  }

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

  getLogs(query: { date: string; level?: string | null; module?: string | null; traceId?: string | null; limit: number; offset: number }): { entries: LogEntry[]; total: number; hasMore: boolean } {
    const logsDir = join(this.root, "logs");
    let entries = readLogEntries(query.date, logsDir);

    // Apply filters
    if (query.level) {
      const LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
      const minLevel = LEVELS[query.level.toUpperCase()] ?? 0;
      entries = entries.filter(e => (LEVELS[e.level] ?? 0) >= minLevel);
    }
    if (query.module) {
      entries = entries.filter(e => e.module === query.module);
    }
    if (query.traceId) {
      entries = entries.filter(e => e.traceId === query.traceId);
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
    const jobs = this._loadCronJobs().map((job) => ({
      jobId: job.id,
      jobName: job.name ?? job.id,
      enabled: job.enabled,
      handler: job.handler,
      schedule: job.cron ?? (job.every ? `every ${job.every}` : job.at ?? "unknown"),
      lastRun: null,    // BunQueue embedded — not accessible from dashboard process
      nextRunAt: null,
      consecutiveErrors: 0,
    }));
    return { jobs };
  }

  getSchedulerHistory(_jobId?: string, _limit = 50): Array<{ ts: string; status: string; durationMs: number; jobId: string }> {
    // BunQueue embedded mode — run history not accessible from dashboard process
    return [];
  }

  getSchedulerSummary(days: number) {
    const result: Array<{ date: string; total: number; ok: number; error: number; skipped: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      result.push({ date: dateStr, total: 0, ok: 0, error: 0, skipped: 0 });
    }
    return result;
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
