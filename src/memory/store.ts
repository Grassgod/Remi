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
} from "node:fs";
import { join, relative, dirname, basename, resolve } from "node:path";
import matter from "gray-matter";

const PLURAL_MAP: Record<string, string> = {
  person: "people",
  child: "children",
};

export const CONTEXT_WARN_THRESHOLD = 6000;

interface IndexEntry {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
}

export class MemoryStore {
  root: string;
  private _index = new Map<string, IndexEntry>();

  constructor(root: string) {
    this.root = root;
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

  recall(
    query: string,
    options?: {
      type?: string | null;
      tags?: string[] | null;
      cwd?: string | null;
    },
  ): string {
    const type = options?.type ?? null;
    const tags = options?.tags ?? null;
    const cwd = options?.cwd ?? null;

    const results: Array<{
      source: string;
      path: string;
      meta: IndexEntry | Record<string, never>;
    }> = [];

    // 1. Search entities (index first, then body)
    for (const [pathStr, meta] of this._index) {
      if (type && meta.type !== type) continue;
      if (tags && tags.length > 0) {
        const metaTags = new Set(meta.tags);
        if (!tags.some((t) => metaTags.has(t))) continue;
      }
      if (this._matches(pathStr, query, meta)) {
        results.push({ source: "entity", path: pathStr, meta });
      }
    }

    // 2. Search daily logs
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
        }
      }
    }

    // 3. Search project memory
    const projectRoot = cwd ? this._projectRoot(cwd) : null;
    if (projectRoot) {
      this._findRemiMemoryFiles(projectRoot, (mdFile) => {
        if (this._matchesText(mdFile, query)) {
          results.push({ source: "project", path: mdFile, meta: {} });
        }
      });
    }

    return this._formatResults(results, query);
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

    if (existsSync(path)) {
      this._backup(path);
      this._appendObservation(path, observation);
      this._updateFrontmatterTimestamp(path);
      this._invalidateIndex(path);
      return `已更新 ${entity}：${observation}`;
    } else {
      const content = this._renderNewEntity(entity, type, observation, "user-explicit");
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, content, "utf-8");
      this._invalidateIndex(path);
      return `已创建 ${entity}（${type}）：${observation}`;
    }
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

    // Otherwise return summary list
    const lines: string[] = [];
    for (const { source, path, meta } of results) {
      if (source === "entity" && "name" in meta) {
        const m = meta as IndexEntry;
        lines.push(`- [${source}] ${m.name} (${m.type}): ${m.summary}`);
      } else if (source === "daily") {
        lines.push(`- [${source}] ${basename(path, ".md")}`);
      } else if (source === "project") {
        lines.push(`- [${source}] ${path}`);
      }
    }
    return lines.join("\n");
  }

  // ── 3. Manifest/TOC context assembly ──────────────────────

  gatherContext(cwd?: string | null): string {
    this._ensureInitialized();
    let context = this._assemble(cwd ?? null);
    if (context.length > CONTEXT_WARN_THRESHOLD) {
      console.warn(
        `记忆上下文 ${context.length} 字符（阈值：${CONTEXT_WARN_THRESHOLD}）`,
      );
      context +=
        `\n\n⚠️ 当前上下文 ${context.length} 字符（阈值：${CONTEXT_WARN_THRESHOLD}），` +
        "建议用 recall 替代全文加载，或精简 MEMORY.md 的 ## 近期焦点 章节。";
    }
    return context;
  }

  private _assemble(cwd: string | null): string {
    const parts: string[] = [];

    // 1. Personal global memory (always injected)
    const globalMemory = join(this.root, "MEMORY.md");
    if (existsSync(globalMemory)) {
      const content = readFileSync(globalMemory, "utf-8");
      if (content.trim()) {
        parts.push(`# 个人记忆\n${content}`);
      }
    }

    // 2. Project memory
    const projectRoot = cwd ? this._projectRoot(cwd) : null;
    const currentMemory = cwd ? join(cwd, ".remi", "memory.md") : null;
    if (currentMemory && existsSync(currentMemory)) {
      const label = basename(cwd!);
      parts.push(
        `# 当前模块记忆 (${label})\n${readFileSync(currentMemory, "utf-8")}`,
      );
    } else if (projectRoot) {
      const rootMemory = join(projectRoot, ".remi", "memory.md");
      if (existsSync(rootMemory)) {
        parts.push(
          `# 项目记忆 (${basename(projectRoot)})\n${readFileSync(rootMemory, "utf-8")}`,
        );
      }
    }

    // 3. Today's daily log — not injected into context (available via recall)

    // 4. Manifest
    const manifest = this._buildManifest(cwd);
    if (manifest) {
      parts.push(manifest);
    }

    return parts.length > 0 ? parts.join("\n\n---\n\n") : "";
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

  _buildManifest(cwd?: string | null): string {
    const rows: Array<{ source: string; name: string; summary: string }> = [];

    // 1. Project .remi/memory.md files
    const projectRoot = cwd ? this._projectRoot(cwd) : null;
    const currentMemory = cwd ? join(cwd, ".remi", "memory.md") : null;
    if (projectRoot) {
      this._findRemiMemoryFiles(projectRoot, (mdFile) => {
        if (currentMemory && mdFile === currentMemory) return;
        if (
          !(currentMemory && existsSync(currentMemory)) &&
          mdFile === join(projectRoot, ".remi", "memory.md")
        ) {
          return;
        }
        const summary = this._readFirstLine(mdFile);
        const rel = relative(projectRoot, mdFile);
        const source =
          dirname(dirname(mdFile)) === projectRoot ? "项目记忆" : "模块记忆";
        rows.push({ source, name: rel, summary });
      });
    }

    // 2. Entity directory (from in-memory index)
    for (const [, meta] of this._index) {
      rows.push({
        source: "实体",
        name: `${meta.name} (${meta.type})`,
        summary: meta.summary,
      });
    }

    // 3. Daily log entry
    const dailyDir = join(this.root, "daily");
    if (existsSync(dailyDir)) {
      const days = readdirSync(dailyDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      if (days.length > 0) {
        rows.push({
          source: "日志",
          name: "daily/",
          summary: `最近 ${Math.min(days.length, 7)} 天可用，recall("日期或关键词") 查看`,
        });
      }
    }

    if (rows.length === 0) return "";
    let header = "# 可用记忆（使用 recall 工具查看详情）\n\n";
    header += "| 来源 | 路径/名称 | 摘要 |\n|------|----------|------|\n";
    for (const r of rows) {
      header += `| ${r.source} | ${r.name} | ${r.summary} |\n`;
    }
    return header;
  }

  private _readFirstLine(mdFile: string): string {
    try {
      const content = readFileSync(mdFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          return trimmed.replace(/^#+\s*/, "").trim();
        }
      }
      return "";
    } catch {
      return "";
    }
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
      console.warn(`Entity ${name} already exists at ${path}`);
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
      console.warn(`Entity ${name} not found for update`);
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
      console.warn(`Entity ${name} not found for observation`);
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
      console.warn(`Project memory not found: ${memoryFile}`);
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
      console.warn(`Entity ${name} not found for deletion`);
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
}
