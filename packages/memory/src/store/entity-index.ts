/**
 * MemoryStore — on-disk entity index and the wiki-link graph.
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
import { join, basename, resolve } from "node:path";
import matter from "gray-matter";
import { LinkGraph, type Backlink, safeReadFile, entityNameFromPath } from "../link-graph.js";
import { createLogger } from "@shared/logger.js";
import type { IndexEntry } from "./types.js";

const log = createLogger("memory");

export class EntityIndex {
  readonly _index = new Map<string, IndexEntry>();
  readonly _linkGraph: LinkGraph;

  constructor(readonly root: string) {
    this._linkGraph = new LinkGraph({
      resolve: (rawTarget: string) => this._resolveEntityName(rawTarget),
    });
    this._ensureInitialized();
    this._buildIndex();
    this._rebuildLinkGraph();
  }

  _ensureInitialized(): void {
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

  _buildIndex(): void {
    this._index.clear();
    const entitiesDir = join(this.root, "entities");
    if (!existsSync(entitiesDir)) return;
    this._scanDir(entitiesDir);
  }

  _scanDir(dir: string): void {
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
    this._rebuildLinkGraph();
  }

  /**
   * Resolve a raw wikilink target to the canonical entity name.
   * Checks exact-match against entity names first, then aliases.
   * Case-insensitive. Returns null if no match.
   */
  private _resolveEntityName(rawTarget: string): string | null {
    const needle = rawTarget.trim().toLowerCase();
    if (!needle) return null;
    // First pass: exact name match
    for (const entry of this._index.values()) {
      if (entry.name.toLowerCase() === needle) return entry.name;
    }
    // Second pass: alias match
    for (const entry of this._index.values()) {
      for (const alias of entry.aliases) {
        if (alias.toLowerCase() === needle) return entry.name;
      }
    }
    return null;
  }

  _rebuildLinkGraph(): void {
    const files: Array<{ entityName: string; path: string; content: string }> = [];
    for (const [path, entry] of this._index) {
      files.push({
        entityName: entry.name || entityNameFromPath(path),
        path,
        content: safeReadFile(path),
      });
    }
    this._linkGraph.rebuild(files);
  }

  /** Public API: list all entities that link TO the given entity. */
  getBacklinks(entityName: string): Backlink[] {
    return this._linkGraph.getBacklinks(entityName);
  }

  /** Public API: list all entities the given entity links OUT TO. */
  getForwardLinks(entityName: string): string[] {
    return this._linkGraph.getForwardLinks(entityName);
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

  _findEntityByName(name: string): string | null {
    for (const [pathStr, meta] of this._index) {
      if (meta.name === name) return pathStr;
    }
    return null;
  }
}
