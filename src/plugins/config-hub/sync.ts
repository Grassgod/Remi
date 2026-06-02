/**
 * Sync orchestration for one (tool, scope) MCP file.
 *
 * Pulls `ours` (the DB's enabled set) + reads `theirs` (the file) + loads the
 * stored `base` manifest, runs the pure reconcile, then: backs up, writes the
 * file, persists the new manifest, and returns the DB mutations the caller
 * must apply (imports/disables) plus any conflicts to surface.
 *
 * Decoupled from the concrete DB via ManifestStore + plain EntryMap input, so
 * it's testable without SQLite.
 */

import { resolve } from "node:path";
import type { AppType, EntryMap, Manifest, Scope } from "./types.js";
import type { ToolAdapter } from "./adapters/base.js";
import { reconcileMcp } from "./reconcile.js";
import { backupFile } from "./util.js";

export interface ManifestStore {
  get(app: AppType, scopeKey: string): Manifest;
  set(app: AppType, scopeKey: string, manifest: Manifest): void;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === "global" ? "global" : `project:${resolve(scope.projectDir)}`;
}

export interface SyncOutcome {
  /** servers to upsert into the DB and mark enabled for this tool */
  imports: EntryMap;
  /** server names to set enabled_<tool> = 0 */
  disables: string[];
  /** server names needing human resolution (both sides changed) */
  conflicts: string[];
  /** false when the tool isn't present and sync was skipped */
  synced: boolean;
}

export function syncMcp(
  adapter: ToolAdapter,
  scope: Scope,
  ours: EntryMap,
  manifests: ManifestStore,
): SyncOutcome {
  if (!adapter.isPresent(scope)) {
    return { imports: {}, disables: [], conflicts: [], synced: false };
  }

  adapter.prepareScope?.(scope);

  const path = adapter.mcpPath(scope);
  const theirs = adapter.readMcp(path); // throws on malformed → caller aborts, file untouched
  const key = scopeKey(scope);
  const base = manifests.get(adapter.app, key);

  const r = reconcileMcp(ours, theirs, base);

  backupFile(path);
  adapter.writeMcp(path, r.toFile);
  manifests.set(adapter.app, key, r.nextManifest);

  return { imports: r.imports, disables: r.disables, conflicts: r.conflicts, synced: true };
}
