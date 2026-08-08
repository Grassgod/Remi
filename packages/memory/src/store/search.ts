/**
 * MemoryStore — the recall pipeline (candidate gathering, rerank, formatting)
 * plus the `remember` write path and `reindex`.
 *
 * Moved verbatim out of `memory/store.ts`; `MemoryStore` delegates here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import type { VectorStore } from "@shared/db/vector-store.js";
import { createLogger } from "@shared/logger.js";
import type { IndexEntry, RecallDebugResult, RecallLayerResult } from "./types.js";
import { EntityIndex } from "./entity-index.js";
import { MemoryFiles } from "./files.js";
import { MemoryEntities } from "./entities.js";
import { splitMemorySections, resolveProjectRoot, findRemiMemoryFiles } from "./project-memory.js";

const log = createLogger("memory");

export class MemorySearch {
  constructor(
    readonly root: string,
    private readonly _vectorStore: VectorStore | null,
    private readonly index: EntityIndex,
    private readonly entities: MemoryEntities,
    private readonly files: MemoryFiles,
  ) {}

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
    for (const [pathStr, meta] of this.index._index) {
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
        const { extended } = splitMemorySections(content);
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
    const projectRoot = cwd ? resolveProjectRoot(cwd) : null;
    if (projectRoot) {
      findRemiMemoryFiles(projectRoot, (mdFile) => {
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
            const meta = this.index._index.get(vr.id);
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

  async _rerank(
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

  _updateAccessStats(path: string): void {
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
      this.index._invalidateIndex(path);
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
      const projectRoot = resolveProjectRoot(cwd);
      if (!projectRoot) {
        return "错误：找不到项目根目录，请先 remi init";
      }
      baseDir = join(projectRoot, ".remi", "entities");
    } else {
      baseDir = join(this.root, "entities");
    }

    const path = this.entities._resolveEntityPath(entity, type, baseDir);

    let result: string;
    if (existsSync(path)) {
      this.files._backup(path);
      this.entities._appendObservation(path, observation);
      this.entities._updateFrontmatterTimestamp(path);
      this.index._invalidateIndex(path);
      result = `已更新 ${entity}：${observation}`;
    } else {
      const content = this.entities._renderNewEntity(entity, type, observation, "user-explicit");
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, content, "utf-8");
      this.index._invalidateIndex(path);
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
    for (const [path, meta] of this.index._index) {
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

  _matches(mdFile: string, query: string, meta: IndexEntry): boolean {
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

  _matchesText(mdFile: string, query: string): boolean {
    try {
      const content = readFileSync(mdFile, "utf-8");
      return content.toLowerCase().includes(query.toLowerCase());
    } catch {
      return false;
    }
  }

  _formatResults(
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
          const { extended } = splitMemorySections(content);
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
}
