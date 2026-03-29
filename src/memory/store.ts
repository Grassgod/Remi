/**
 * Memory system v2 — entity memory + Manifest/TOC context assembly.
 *
 * Markdown files are the source of truth. Entities use YAML frontmatter for
 * structured metadata. An in-memory index (built once at startup, updated
 * incrementally on writes) avoids repeated disk scans.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  renameSync,
  lstatSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import type { VectorStore } from "../db/vector-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("memory");

const PLURAL_MAP: Record<string, string> = {
  person: "people",
  child: "children",
};


interface IndexEntry {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
  importance: number;
  lastAccessed: string;
  accessCount: number;
}

export interface RecallLayerResult {
  name: string;
  ran: boolean;
  durationMs: number;
  candidateCount: number;
  exitedEarly?: boolean;
  reason?: string;
  matches: Array<{ source: string; name: string; snippet: string }>;
}

export interface RecallDebugResult {
  query: string;
  result: string;
  totalMs: number;
  layers: RecallLayerResult[];
}

export class MemoryStore {
  root: string;
  private _index = new Map<string, IndexEntry>();
  private _vectorStore: VectorStore | null = null;

  constructor(root: string, vectorStore?: VectorStore | null) {
    this.root = root;
    this._vectorStore = vectorStore ?? null;
    this._ensureInitialized();
    this._buildIndex();
  }

  // ── 2.1 Initialization ────────────────────────────────────

  private _ensureInitialized(): void {
    for (const d of [
      "entities/people",
      "entities/organizations",
      "entities/decisions",
      "daily",
      ".versions",
    ]) {
      const dirPath = join(this.root, d);
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    }

    const globalMemory = join(this.root, "MEMORY.md");
    if (!existsSync(globalMemory)) {
      writeFileSync(
        globalMemory,
        "# 个人记忆\n\n## 用户偏好\n\n## 长期目标\n\n## 近期焦点\n",
        "utf-8",
      );
    }
  }

  // ── 2.2 In-memory index ───────────────────────────────────

  _buildIndex(): void {
    this._index.clear();
    const entitiesDir = join(this.root, "entities");
    if (!existsSync(entitiesDir)) return;
    this._scanDir(entitiesDir);
  }

  private _scanDir(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this._scanDir(fullPath);
      } else if (entry.name.endsWith(".md")) {
        const meta = this._parseFrontmatter(fullPath);
        this._index.set(fullPath, {
          type: (meta.type as string) ?? "",
          name: (meta.name as string) ?? basename(fullPath, ".md"),
          tags: (meta.tags as string[]) ?? [],
          summary: (meta.summary as string) ?? "",
          aliases: (meta.aliases as string[]) ?? [],
          importance: (meta.importance as number) ?? 0.5,
          lastAccessed: meta.last_accessed instanceof Date
            ? (meta.last_accessed as Date).toISOString().slice(0, 10)
            : ((meta.last_accessed as string) ?? ""),
          accessCount: (meta.access_count as number) ?? 0,
        });
      }
    }
  }

  _invalidateIndex(path: string): void {
    const meta = this._parseFrontmatter(path);
    this._index.set(path, {
      type: (meta.type as string) ?? "",
      name: (meta.name as string) ?? basename(path, ".md"),
      tags: (meta.tags as string[]) ?? [],
      summary: (meta.summary as string) ?? "",
      aliases: (meta.aliases as string[]) ?? [],
      importance: (meta.importance as number) ?? 0.5,
      lastAccessed: meta.last_accessed instanceof Date
            ? (meta.last_accessed as Date).toISOString().slice(0, 10)
            : ((meta.last_accessed as string) ?? ""),
      accessCount: (meta.access_count as number) ?? 0,
    });
  }

  _parseFrontmatter(path: string): Record<string, unknown> {
    try {
      const content = readFileSync(path, "utf-8");
      const { data } = matter(content);
      return data as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // ── 2.3 File naming & paths ───────────────────────────────

  private _typeToDir(typeName: string): string {
    const t = typeName.toLowerCase();
    if (t in PLURAL_MAP) return PLURAL_MAP[t];
    return t + "s";
  }

  _slugify(name: string): string {
    let slug = name.replace(/[<>:"/\\|?*\n\r\t]/g, "");
    slug = slug.trim().replace(/ /g, "-");
    return slug || "unnamed";
  }

  _resolveEntityPath(entity: string, type: string, baseDir: string): string {
    const typeDir = join(baseDir, this._typeToDir(type));
    if (!existsSync(typeDir)) {
      mkdirSync(typeDir, { recursive: true });
    }
    const slug = this._slugify(entity);

    // Check existing files whose name field matches
    const pattern = `${slug}`;
    for (const file of readdirSync(typeDir)) {
      if (file.startsWith(pattern) && file.endsWith(".md")) {
        const fullPath = join(typeDir, file);
        const meta = this._parseFrontmatter(fullPath);
        if (meta.name === entity) {
          return fullPath;
        }
      }
    }

    // Generate new path, handle collision
    let path = join(typeDir, `${slug}.md`);
    let counter = 2;
    while (existsSync(path)) {
      path = join(typeDir, `${slug}-${counter}.md`);
      counter++;
    }
    return path;
  }

  // ── 2.4 Entity CRUD (internal) ────────────────────────────

  private _renderNewEntity(
    entity: string,
    type: string,
    observation: string,
    source: "user-explicit" | "agent-inferred" = "agent-inferred",
  ): string {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
    return (
      `---\n` +
      `type: ${type}\n` +
      `name: ${entity}\n` +
      `created: ${ts}\n` +
      `updated: ${ts}\n` +
      `tags: []\n` +
      `source: ${source}\n` +
      `summary: ""\n` +
      `aliases: []\n` +
      `related: []\n` +
      `importance: 0.5\n` +
      `last_accessed: ${ts.slice(0, 10)}\n` +
      `access_count: 0\n` +
      `---\n\n` +
      `# ${entity}\n\n` +
      `## 备注\n` +
      `- [${ts.slice(0, 10)}] ${observation}\n`
    );
  }

  private _appendObservation(path: string, observation: string): void {
    let content = readFileSync(path, "utf-8");
    const ts = new Date().toISOString().slice(0, 10);
    const entry = `\n- [${ts}] ${observation}`;

    if (content.includes("## 备注")) {
      content = content.replace("## 备注", `## 备注${entry}`);
    } else {
      content += `\n\n## 备注${entry}`;
    }

    writeFileSync(path, content, "utf-8");
  }

  private _updateFrontmatterTimestamp(path: string): void {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
    let content = readFileSync(path, "utf-8");
    content = content.replace(/^updated:.*$/m, `updated: ${ts}`);
    writeFileSync(path, content, "utf-8");
  }

  private _backup(path: string): void {
    if (!existsSync(path)) return;
    const versionsDir = join(this.root, ".versions");
    if (!existsSync(versionsDir)) {
      mkdirSync(versionsDir, { recursive: true });
    }
    const stem = basename(path, ".md");
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/T/, "T")
      .replace(/\.\d{3}Z$/, "")
      .slice(0, 15);
    const backupPath = join(versionsDir, `${stem}-${ts}.md`);
    writeFileSync(backupPath, readFileSync(path, "utf-8"), "utf-8");

    // Cleanup old versions for this entity
    const allVersions = readdirSync(versionsDir)
      .filter((f) => f.startsWith(`${stem}-`) && f.endsWith(".md"))
      .sort();
    for (const old of allVersions.slice(0, -10)) {
      unlinkSync(join(versionsDir, old));
    }
  }

  // ── 2.5 Hot Path tools ────────────────────────────────────

  async recall(query: string, options?: { type?: string | null; tags?: string[] | null; cwd?: string | null; debug?: false }): Promise<string>;
  async recall(query: string, options: { type?: string | null; tags?: string[] | null; cwd?: string | null; debug: true }): Promise<RecallDebugResult>;
  async recall(
    query: string,
    options?: {
      type?: string | null;
      tags?: string[] | null;
      cwd?: string | null;
      debug?: boolean;
    },
  ): Promise<string | RecallDebugResult> {
    const type = options?.type ?? null;
    const tags = options?.tags ?? null;
    const cwd = options?.cwd ?? null;
    const debug = options?.debug ?? false;

    const t0 = debug ? performance.now() : 0;
    const layers: RecallLayerResult[] = [];

    type Candidate = { source: string; path: string; meta: IndexEntry | Record<string, never> };
    const results: Candidate[] = [];
    const l1Start = debug ? performance.now() : 0;
    const l1Matches: Array<{ source: string; name: string; snippet: string }> = [];

    // 1. Search entities (index first, then body)
    for (const [pathStr, meta] of this._index) {
      if (type && meta.type !== type) continue;
      if (tags && tags.length > 0) {
        const metaTags = new Set(meta.tags);
        if (!tags.some((t) => metaTags.has(t))) continue;
      }
      if (this._matches(pathStr, query, meta)) {
        results.push({ source: "entity", path: pathStr, meta });
        if (debug) l1Matches.push({ source: "entity", name: meta.name, snippet: meta.summary || meta.type });
      }
    }

    // 2. Search extended memory sections (not injected into context)
    const globalMemory = join(this.root, "MEMORY.md");
    if (existsSync(globalMemory)) {
      const content = readFileSync(globalMemory, "utf-8");
      if (content.trim()) {
        const { extended } = this._splitMemorySections(content);
        const lq = query.toLowerCase();
        for (const sec of extended) {
          if (
            sec.heading.toLowerCase().includes(lq) ||
            sec.body.toLowerCase().includes(lq)
          ) {
            results.push({
              source: "memory-section",
              path: `## ${sec.heading}`,
              meta: {} as Record<string, never>,
            });
            if (debug) l1Matches.push({ source: "memory-section", name: sec.heading, snippet: sec.body.slice(0, 100) });
          }
        }
      }
    }

    // 3a. Search daily logs
    const dailyDir = join(this.root, "daily");
    if (existsSync(dailyDir)) {
      const files = readdirSync(dailyDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      for (const file of files) {
        const fullPath = join(dailyDir, file);
        if (this._matchesText(fullPath, query)) {
          results.push({ source: "daily", path: fullPath, meta: {} });
          if (debug) l1Matches.push({ source: "daily", name: basename(file, ".md"), snippet: "" });
        }
      }
    }

    // 3b. Search project memory
    const projectRoot = cwd ? this._projectRoot(cwd) : null;
    if (projectRoot) {
      this._findRemiMemoryFiles(projectRoot, (mdFile) => {
        if (this._matchesText(mdFile, query)) {
          results.push({ source: "project", path: mdFile, meta: {} });
          if (debug) l1Matches.push({ source: "project", name: basename(mdFile), snippet: "" });
        }
      });
    }

    // L1 check: if exact name match found, return immediately
    const q = query.toLowerCase();
    let exactMatch = false;
    let exactResult = "";
    for (const r of results) {
      if (r.source === "entity" && "name" in r.meta && (r.meta as IndexEntry).name.toLowerCase() === q) {
        this._updateAccessStats(r.path);
        log.info(`recall "${query}" → L1 exact match: ${(r.meta as IndexEntry).name}`);
        exactResult = readFileSync(r.path, "utf-8");
        exactMatch = true;
        break;
      }
    }

    // Check L1 result quality — if only low-quality matches (short daily refs), continue to L2
    const formatted = results.length > 0 ? this._formatResults(results, query) : "";
    const l1Quality = formatted.length >= 50 && results.some(r => r.source === "entity");
    const l1Early = exactMatch || (l1Quality && results.length <= 5);

    if (l1Early && !debug) {
      return exactMatch ? exactResult : formatted;
    }

    if (debug) {
      layers.push({
        name: "L1: Index + Substring Search", ran: true,
        durationMs: Math.round((performance.now() - l1Start) * 10) / 10,
        candidateCount: results.length, exitedEarly: l1Early, matches: l1Matches,
      });
    }

    if (l1Early && debug) {
      layers.push({ name: "L2: Vector Search", ran: false, durationMs: 0, candidateCount: 0, reason: "L1 quality sufficient", matches: [] });
      layers.push({ name: "L3: Voyage Rerank", ran: false, durationMs: 0, candidateCount: 0, reason: "Skipped", matches: [] });
      return { query, result: exactMatch ? exactResult : formatted, totalMs: Math.round((performance.now() - t0) * 10) / 10, layers };
    }

    // L2: Vector search (if available and L1 quality is insufficient)
    const l2Start = debug ? performance.now() : 0;
    const l2Matches: Array<{ source: string; name: string; snippet: string }> = [];
    let l2Ran = false;

    if (this._vectorStore && !l1Quality) {
      l2Ran = true;
      try {
        const vecResults = await this._vectorStore.search(query, 10);
        for (const vr of vecResults) {
          if (existsSync(vr.id)) {
            const meta = this._index.get(vr.id);
            if (meta) {
              results.push({ source: "vector", path: vr.id, meta });
              if (debug) l2Matches.push({ source: "vector", name: meta.name, snippet: meta.summary || "" });
            }
          }
        }
        log.info(`recall "${query}" → L2 vector: ${results.length} candidates`);
      } catch (e) {
        log.warn("Vector search failed:", e);
      }
    }

    if (debug) {
      layers.push({
        name: "L2: Vector Search", ran: l2Ran,
        durationMs: Math.round((performance.now() - l2Start) * 10) / 10,
        candidateCount: l2Matches.length,
        reason: l2Ran ? undefined : (this._vectorStore ? "L1 quality sufficient" : "No vector store configured"),
        matches: l2Matches,
      });
    }

    if (results.length === 0) {
      log.info(`recall "${query}" → no results at any level`);
      if (debug) {
        layers.push({ name: "L3: Voyage Rerank", ran: false, durationMs: 0, candidateCount: 0, reason: "No candidates", matches: [] });
        return { query, result: "", totalMs: Math.round((performance.now() - t0) * 10) / 10, layers };
      }
      return "";
    }

    // L3: Rerank if too many candidates
    const l3Start = debug ? performance.now() : 0;
    let l3Ran = false;
    const l3Matches: Array<{ source: string; name: string; snippet: string }> = [];

    if (results.length > 3) {
      l3Ran = true;
      try {
        log.info(`recall "${query}" → L3 rerank: ${results.length} candidates → top 3`);
        const reranked = await this._rerank(results, query);
        if (debug) {
          for (const r of reranked) {
            const name = "name" in r.meta ? (r.meta as IndexEntry).name : basename(r.path, ".md");
            l3Matches.push({ source: r.source, name, snippet: "" });
          }
          layers.push({
            name: "L3: Voyage Rerank", ran: true,
            durationMs: Math.round((performance.now() - l3Start) * 10) / 10,
            candidateCount: l3Matches.length, matches: l3Matches,
          });
          return { query, result: this._formatResults(reranked, query), totalMs: Math.round((performance.now() - t0) * 10) / 10, layers };
        }
        return this._formatResults(reranked, query);
      } catch (e) {
        log.warn("Rerank failed, returning unranked:", e);
      }
    }

    const resultText = this._formatResults(results, query);
    if (debug) {
      layers.push({
        name: "L3: Voyage Rerank", ran: l3Ran,
        durationMs: Math.round((performance.now() - l3Start) * 10) / 10,
        candidateCount: l3Ran ? 0 : 0,
        reason: l3Ran ? "Rerank failed, returning unranked" : `Only ${results.length} candidates (<=3)`,
        matches: l3Matches,
      });
      return { query, result: resultText, totalMs: Math.round((performance.now() - t0) * 10) / 10, layers };
    }
    return resultText;
  }

  private async _rerank(
    candidates: Array<{ source: string; path: string; meta: IndexEntry | Record<string, never> }>,
    query: string,
  ): Promise<Array<{ source: string; path: string; meta: IndexEntry | Record<string, never> }>> {
    const apiKey = this._vectorStore?.apiKey;
    if (!apiKey) {
      log.warn("rerank skipped: no Voyage API key available");
      return candidates.slice(0, 3);
    }

    // Build document texts for reranking
    const documents = candidates.map((c) => {
      const name = "name" in c.meta ? (c.meta as IndexEntry).name : basename(c.path, ".md");
      const type = "type" in c.meta ? (c.meta as IndexEntry).type : c.source;
      const preview = existsSync(c.path) ? readFileSync(c.path, "utf-8").slice(0, 500) : "";
      return `${name} (${type})\n${preview}`;
    });

    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        documents,
        model: "rerank-2-lite",
        top_k: 3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.warn(`Voyage rerank API error ${res.status}: ${errText}`);
      return candidates.slice(0, 3);
    }

    const data = (await res.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    if (!data.results?.length) return candidates.slice(0, 3);

    const reranked = data.results
      .map((r) => {
        if (r.index < 0 || r.index >= candidates.length) {
          log.warn(`rerank index ${r.index} out of range (candidates: ${candidates.length})`);
          return null;
        }
        return candidates[r.index];
      })
      .filter(Boolean);

    log.info(`rerank: ${data.results.map(r => `#${r.index}=${r.relevance_score.toFixed(3)}`).join(", ")}`);
    return (reranked.length > 0 ? reranked : candidates.slice(0, 3)) as typeof candidates;
  }

  private _updateAccessStats(path: string): void {
    try {
      let content = readFileSync(path, "utf-8");
      const today = new Date().toISOString().slice(0, 10);

      if (content.includes("last_accessed:")) {
        content = content.replace(/^last_accessed:.*$/m, `last_accessed: ${today}`);
      }
      if (content.includes("access_count:")) {
        content = content.replace(/^access_count:.*$/m, (match) => {
          const count = parseInt(match.split(":")[1]) || 0;
          return `access_count: ${count + 1}`;
        });
      }
      writeFileSync(path, content, "utf-8");
      this._invalidateIndex(path);
    } catch {
      // non-critical
    }
  }

  remember(
    entity: string,
    type: string,
    observation: string,
    scope: "personal" | "project" = "personal",
    cwd?: string | null,
  ): string {
    let baseDir: string;

    if (scope === "project") {
      if (!cwd) {
        return "错误：scope=project 需要提供 cwd";
      }
      const projectRoot = this._projectRoot(cwd);
      if (!projectRoot) {
        return "错误：找不到项目根目录，请先 remi init";
      }
      baseDir = join(projectRoot, ".remi", "entities");
    } else {
      baseDir = join(this.root, "entities");
    }

    const path = this._resolveEntityPath(entity, type, baseDir);

    let result: string;
    if (existsSync(path)) {
      this._backup(path);
      this._appendObservation(path, observation);
      this._updateFrontmatterTimestamp(path);
      this._invalidateIndex(path);
      result = `已更新 ${entity}：${observation}`;
    } else {
      const content = this._renderNewEntity(entity, type, observation, "user-explicit");
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, content, "utf-8");
      this._invalidateIndex(path);
      result = `已创建 ${entity}（${type}）：${observation}`;
    }

    // Async vector index update
    if (this._vectorStore) {
      const fileContent = readFileSync(path, "utf-8");
      this._vectorStore.upsert(path, fileContent, { type, name: entity })
        .catch((e: unknown) => log.warn("Vector upsert failed:", e));
    }

    return result;
  }

  async reindex(): Promise<number> {
    if (!this._vectorStore) return 0;
    let count = 0;
    for (const [path, meta] of this._index) {
      try {
        const content = readFileSync(path, "utf-8");
        await this._vectorStore.upsert(path, content, {
          type: meta.type,
          name: meta.name,
        });
        count++;
      } catch (e) {
        log.warn(`Reindex failed for ${path}:`, e);
      }
    }
    log.info(`Reindexed ${count} entities`);
    return count;
  }

  private _matches(mdFile: string, query: string, meta: IndexEntry): boolean {
    const q = query.toLowerCase();

    // Exact name match
    if (meta.name.toLowerCase() === q) return true;

    // Aliases match
    for (const alias of meta.aliases) {
      if (q.includes(alias.toLowerCase()) || alias.toLowerCase().includes(q)) return true;
    }

    // Body substring
    return this._matchesText(mdFile, query);
  }

  private _matchesText(mdFile: string, query: string): boolean {
    try {
      const content = readFileSync(mdFile, "utf-8");
      return content.toLowerCase().includes(query.toLowerCase());
    } catch {
      return false;
    }
  }

  private _formatResults(
    results: Array<{
      source: string;
      path: string;
      meta: IndexEntry | Record<string, never>;
    }>,
    query: string,
  ): string {
    if (results.length === 0) return "";

    const q = query.toLowerCase();

    // Check for exact entity name match → return full text
    for (const { source, path, meta } of results) {
      if (source === "entity" && "name" in meta && (meta as IndexEntry).name.toLowerCase() === q) {
        return readFileSync(path, "utf-8");
      }
    }

    // Check for memory-section match → return section body if heading matches
    for (const { source, path } of results) {
      if (source === "memory-section") {
        const heading = path.replace(/^##\s*/, "");
        if (heading.toLowerCase().includes(q)) {
          // Read and return the full section body
          const globalMemory = join(this.root, "MEMORY.md");
          const content = readFileSync(globalMemory, "utf-8");
          const { extended } = this._splitMemorySections(content);
          const sec = extended.find(
            (s) => s.heading === heading,
          );
          if (sec) return `## ${sec.heading}\n${sec.body}`;
        }
      }
    }

    // Otherwise return summary list
    const lines: string[] = [];
    for (const { source, path, meta } of results) {
      if ((source === "entity" || source === "vector") && "name" in meta) {
        const m = meta as IndexEntry;
        lines.push(`- [${source}] ${m.name} (${m.type}): ${m.summary}`);
      } else if (source === "daily") {
        lines.push(`- [${source}] ${basename(path, ".md")}`);
      } else if (source === "project") {
        lines.push(`- [${source}] ${path}`);
      } else if (source === "memory-section") {
        const heading = path.replace(/^##\s*/, "");
        lines.push(`- [记忆] ${heading}`);
      }
    }
    return lines.join("\n");
  }

  // ── 3. Context (removed — Claude Code loads CLAUDE.md + MEMORY.md natively) ──

  /** Sections considered "core" identity — not returned by recall as extended sections. */
  private static CORE_SECTIONS = new Set(["关于主人", "用户偏好"]);

  /**
   * Parse MEMORY.md into sections. Returns core (identity) and
   * extended (searchable via recall) parts.
   */
  private _splitMemorySections(content: string): {
    core: string;
    extended: Array<{ heading: string; body: string }>;
  } {
    const lines = content.split("\n");
    const sections: Array<{ heading: string; body: string[] }> = [];
    let current: { heading: string; body: string[] } | null = null;
    const preamble: string[] = [];

    for (const line of lines) {
      const m = line.match(/^##\s+(.+)/);
      if (m) {
        if (current) sections.push(current);
        current = { heading: m[1].trim(), body: [] };
      } else if (current) {
        current.body.push(line);
      } else {
        preamble.push(line);
      }
    }
    if (current) sections.push(current);

    const coreLines = [...preamble];
    const extended: Array<{ heading: string; body: string }> = [];

    for (const sec of sections) {
      if (MemoryStore.CORE_SECTIONS.has(sec.heading)) {
        coreLines.push(`## ${sec.heading}`, ...sec.body);
      } else {
        const body = sec.body.join("\n").trim();
        if (body) {
          extended.push({ heading: sec.heading, body });
        }
      }
    }

    return { core: coreLines.join("\n").trim(), extended };
  }


  _projectRoot(cwd: string): string | null {
    let p = resolve(cwd);
    let root: string | null = null;
    while (true) {
      if (existsSync(join(p, ".remi"))) {
        root = p;
      }
      const parent = dirname(p);
      if (parent === p) break;
      p = parent;
    }
    return root;
  }


  private _findRemiMemoryFiles(root: string, callback: (path: string) => void): void {
    const remiMemory = join(root, ".remi", "memory.md");
    if (existsSync(remiMemory)) {
      callback(remiMemory);
    }
    // Scan subdirectories
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          this._findRemiMemoryFiles(join(root, entry.name), callback);
        }
      }
    } catch {
      // Permission errors etc.
    }
  }

  // ── 2.6 Maintenance agent internal methods ────────────────

  createEntity(
    name: string,
    type: string,
    content: string,
    source: "user-explicit" | "agent-inferred" = "agent-inferred",
  ): void {
    const baseDir = join(this.root, "entities");
    const path = this._resolveEntityPath(name, type, baseDir);
    if (existsSync(path)) {
      log.warn(`Entity ${name} already exists at ${path}`);
      return;
    }
    const rendered = this._renderNewEntity(name, type, content, source);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, rendered, "utf-8");
    this._invalidateIndex(path);
  }

  updateEntity(name: string, content: string): void {
    const path = this._findEntityByName(name);
    if (!path) {
      log.warn(`Entity ${name} not found for update`);
      return;
    }
    this._backup(path);
    writeFileSync(path, content, "utf-8");
    this._updateFrontmatterTimestamp(path);
    this._invalidateIndex(path);
  }

  appendObservation(name: string, observation: string): void {
    const path = this._findEntityByName(name);
    if (!path) {
      log.warn(`Entity ${name} not found for observation`);
      return;
    }
    this._backup(path);
    this._appendObservation(path, observation);
    this._updateFrontmatterTimestamp(path);
    this._invalidateIndex(path);
  }

  patchProjectMemory(
    projectPath: string,
    section: string,
    content: string,
    mode: "append" | "overwrite" = "append",
  ): void {
    const memoryFile = join(projectPath, ".remi", "memory.md");
    if (!existsSync(memoryFile)) {
      log.warn(`Project memory not found: ${memoryFile}`);
      return;
    }

    this._backup(memoryFile);
    let text = readFileSync(memoryFile, "utf-8");

    const sectionHeader = `## ${section}`;
    if (text.includes(sectionHeader)) {
      const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(## ${escapedSection}\n)(.*?)(?=\n## |$)`, "s");
      const match = text.match(pattern);
      if (match) {
        let replacement: string;
        if (mode === "overwrite") {
          replacement = `${sectionHeader}\n${content}\n`;
        } else {
          const existing = match[2].trimEnd();
          replacement = `${sectionHeader}\n${existing}\n${content}\n`;
        }
        text = text.slice(0, match.index!) + replacement + text.slice(match.index! + match[0].length);
      }
    } else {
      text = text.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
    }

    writeFileSync(memoryFile, text, "utf-8");
  }

  deleteEntity(name: string): void {
    const path = this._findEntityByName(name);
    if (!path) {
      log.warn(`Entity ${name} not found for deletion`);
      return;
    }
    this._backup(path);
    unlinkSync(path);
    this._index.delete(path);
  }

  _findEntityByName(name: string): string | null {
    for (const [pathStr, meta] of this._index) {
      if (meta.name === name) return pathStr;
    }
    return null;
  }

  // ── 2.7 v1 compat ────────────────────────────────────────

  get memoryFile(): string {
    return join(this.root, "MEMORY.md");
  }

  readMemory(): string {
    if (existsSync(this.memoryFile)) {
      return readFileSync(this.memoryFile, "utf-8");
    }
    return "";
  }

  writeMemory(content: string): void {
    this._backup(this.memoryFile);
    writeFileSync(this.memoryFile, content, "utf-8");
  }

  appendMemory(entry: string): void {
    this._backup(this.memoryFile);
    appendFileSync(this.memoryFile, `\n${entry.trimEnd()}\n`, "utf-8");
  }

  private _dailyPath(date?: string | null): string {
    const d = date ?? new Date().toISOString().slice(0, 10);
    return join(this.root, "daily", `${d}.md`);
  }

  readDaily(date?: string | null): string {
    const path = this._dailyPath(date);
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
    return "";
  }

  appendDaily(entry: string, date?: string | null): void {
    const path = this._dailyPath(date);
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(path) || statSync(path).size === 0) {
      const d = date ?? now.toISOString().slice(0, 10);
      writeFileSync(path, `# ${d}\n\n`, "utf-8");
    }
    appendFileSync(path, `- [${timestamp}] ${entry.trimEnd()}\n`, "utf-8");
  }

  cleanupOldDailies(keepDays: number = 30): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    const dailyDir = join(this.root, "daily");
    if (!existsSync(dailyDir)) return 0;

    for (const file of readdirSync(dailyDir)) {
      if (!file.endsWith(".md")) continue;
      const stem = file.replace(".md", "");
      const parsed = Date.parse(stem);
      if (!isNaN(parsed) && parsed < cutoff) {
        unlinkSync(join(dailyDir, file));
        removed++;
      }
    }
    return removed;
  }

  cleanupOldVersions(keep: number = 50): number {
    const versionsDir = join(this.root, ".versions");
    if (!existsSync(versionsDir)) return 0;

    const files = readdirSync(versionsDir)
      .map((f) => ({
        name: f,
        mtime: statSync(join(versionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    let removed = 0;
    for (const file of files.slice(keep)) {
      unlinkSync(join(versionsDir, file.name));
      removed++;
    }
    return removed;
  }

  // Bridge code removed in v3 — replaced by Symlink architecture
}
