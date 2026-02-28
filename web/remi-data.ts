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

  constructor(remiDir?: string) {
    this.root = remiDir ?? join(homedir(), ".remi");
    this.memoryDir = join(this.root, "memory");
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
