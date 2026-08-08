/**
 * Memory system v2 — entity memory + Manifest/TOC context assembly.
 *
 * Markdown files are the source of truth. Entities use YAML frontmatter for
 * structured metadata. An in-memory index (built once at startup, updated
 * incrementally on writes) avoids repeated disk scans.
 *
 * The implementation is split by responsibility under `./store/`: the on-disk
 * index + link graph, the recall/rerank pipeline, entity CRUD, and MEMORY.md /
 * daily-log / `.versions` file management. This class is the facade; its public
 * surface is unchanged.
 */

import type { VectorStore } from "@shared/db/vector-store.js";
import type { Backlink } from "./link-graph.js";
import type { IndexEntry, RecallDebugResult } from "./store/types.js";
import { EntityIndex } from "./store/entity-index.js";
import { MemoryFiles } from "./store/files.js";
import { MemoryEntities } from "./store/entities.js";
import { MemorySearch } from "./store/search.js";
import { resolveProjectRoot } from "./store/project-memory.js";

export type { RecallLayerResult, RecallDebugResult } from "./store/types.js";

export class MemoryStore {
  root: string;
  private _idx: EntityIndex;
  private _files: MemoryFiles;
  private _entities: MemoryEntities;
  private _search: MemorySearch;

  constructor(root: string, vectorStore?: VectorStore | null) {
    this.root = root;
    this._idx = new EntityIndex(root);
    this._files = new MemoryFiles(root);
    this._entities = new MemoryEntities(root, this._idx, this._files);
    this._search = new MemorySearch(root, vectorStore ?? null, this._idx, this._entities, this._files);
  }

  /** The live entity index. Exposed for tests and incremental-update callers. */
  get _index(): Map<string, IndexEntry> {
    return this._idx._index;
  }


  _ensureInitialized(): void {
    return this._idx._ensureInitialized();
  }
  _buildIndex(): void {
    return this._idx._buildIndex();
  }
  _invalidateIndex(path: string): void {
    return this._idx._invalidateIndex(path);
  }
  _parseFrontmatter(path: string): Record<string, unknown> {
    return this._idx._parseFrontmatter(path);
  }
  _findEntityByName(name: string): string | null {
    return this._idx._findEntityByName(name);
  }
  _rebuildLinkGraph(): void {
    return this._idx._rebuildLinkGraph();
  }
  getBacklinks(entityName: string): Backlink[] {
    return this._idx.getBacklinks(entityName);
  }
  getForwardLinks(entityName: string): string[] {
    return this._idx.getForwardLinks(entityName);
  }

  _backup(path: string): void {
    return this._files._backup(path);
  }
  get memoryFile(): string {
    return this._files.memoryFile;
  }
  readMemory(): string {
    return this._files.readMemory();
  }
  writeMemory(content: string): void {
    return this._files.writeMemory(content);
  }
  appendMemory(entry: string): void {
    return this._files.appendMemory(entry);
  }
  readDaily(date?: string | null): string {
    return this._files.readDaily(date);
  }
  appendDaily(entry: string, date?: string | null): void {
    return this._files.appendDaily(entry, date);
  }
  cleanupOldDailies(keepDays: number = 30): number {
    return this._files.cleanupOldDailies(keepDays);
  }
  cleanupOldVersions(keep: number = 50): number {
    return this._files.cleanupOldVersions(keep);
  }

  _slugify(name: string): string {
    return this._entities._slugify(name);
  }
  _resolveEntityPath(entity: string, type: string, baseDir: string): string {
    return this._entities._resolveEntityPath(entity, type, baseDir);
  }
  _renderNewEntity(
    entity: string,
    type: string,
    observation: string,
    source: "user-explicit" | "agent-inferred" = "agent-inferred",
  ): string {
    return this._entities._renderNewEntity(entity, type, observation, source);
  }
  _appendObservation(path: string, observation: string): void {
    return this._entities._appendObservation(path, observation);
  }
  _updateFrontmatterTimestamp(path: string): void {
    return this._entities._updateFrontmatterTimestamp(path);
  }
  createEntity(
    name: string,
    type: string,
    content: string,
    source: "user-explicit" | "agent-inferred" = "agent-inferred",
  ): void {
    return this._entities.createEntity(name, type, content, source);
  }
  updateEntity(name: string, content: string): void {
    return this._entities.updateEntity(name, content);
  }
  appendObservation(name: string, observation: string): void {
    return this._entities.appendObservation(name, observation);
  }
  patchProjectMemory(
    projectPath: string,
    section: string,
    content: string,
    mode: "append" | "overwrite" = "append",
  ): void {
    return this._entities.patchProjectMemory(projectPath, section, content, mode);
  }
  deleteEntity(name: string): void {
    return this._entities.deleteEntity(name);
  }

  _updateAccessStats(path: string): void {
    return this._search._updateAccessStats(path);
  }
  remember(
    entity: string,
    type: string,
    observation: string,
    scope: "personal" | "project" = "personal",
    cwd?: string | null,
  ): string {
    return this._search.remember(entity, type, observation, scope, cwd);
  }
  async reindex(): Promise<number> {
    return await this._search.reindex();
  }

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
    return await this._search.recall(query, options);
  }

  _projectRoot(cwd: string): string | null {
    return resolveProjectRoot(cwd);
  }
}
