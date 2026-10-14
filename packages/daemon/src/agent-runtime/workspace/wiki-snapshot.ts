/**
 * Wiki working copy snapshot and restore (ADR 0018, section 2).
 *
 * `wiki/` is work product, so reclaim keeps what the user changed: pages that
 * differ from the fetch baseline (`.multiremi/wiki-base`, by manifest hash) are
 * copied to `registry/<subject>.snapshot/wiki/`, and pages deleted from the
 * working copy are listed in `deleted.json`. Restore lays them back over a
 * freshly materialized working copy without overwriting newer local edits.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import { registrySnapshotDirectory, registrySnapshotWikiDirectory } from "./layout.js";
import { removeOwnedDirectorySync } from "./safe-remove.js";
import { SnapshotTooLargeError } from "./git-ops.js";

const WIKI_DIRECTORY = "wiki";
const WIKI_BASE_DIRECTORY = join(".multiremi", "wiki-base");
const DELETED_FILE = "deleted.json";

export interface WikiSnapshotOptions {
  root: string;
  subject: StorageSubjectRef;
  workDir: string;
  /** Total size the saved pages may reach. */
  maxBytes: number;
  /**
   * The saved snapshot has not been restored yet. Its pages are carried into
   * the new snapshot unless the working copy has newer content for them.
   */
  carryPending?: boolean;
  assertRootOwner?: () => void;
}

export interface WikiChanges {
  changed: Array<{ path: string; content: Buffer }>;
  /** Baseline pages missing from the working copy. */
  deleted: string[];
}

/** What differs between the working copy and its fetch baseline. */
export function collectWikiChanges(workDir: string, maxBytes: number): WikiChanges {
  const wikiRoot = join(workDir, WIKI_DIRECTORY);
  const baseline = readBaseline(workDir);
  const changed: WikiChanges["changed"] = [];
  const present = new Set<string>();
  let bytes = 0;
  for (const path of listPages(wikiRoot)) {
    present.add(path);
    const content = readFileSync(join(wikiRoot, path));
    if (baseline.get(path) === sha256(content)) continue;
    bytes += content.length;
    if (bytes > maxBytes) throw new SnapshotTooLargeError(bytes, maxBytes);
    changed.push({ path, content });
  }
  return { changed, deleted: [...baseline.keys()].filter((path) => !present.has(path)).sort() };
}

/**
 * Save the working copy's changes. Returns the number of changed plus deleted
 * pages; an existing snapshot is replaced, and removed when nothing changed.
 * With `carryPending`, pages and deletions of the snapshot being replaced that
 * the working copy does not supersede are saved again, so work that was never
 * taken back survives.
 */
export function snapshotWiki(options: WikiSnapshotOptions): number {
  const target = registrySnapshotDirectory(options.root, options.subject);
  const { changed, deleted: removed } = collectWikiChanges(options.workDir, options.maxBytes);
  const deleted = new Set(removed);
  if (options.carryPending) {
    const source = registrySnapshotWikiDirectory(options.root, options.subject);
    const superseded = new Set(changed.map((page) => page.path));
    for (const path of listPages(source)) {
      if (superseded.has(path) || deleted.has(path)) continue;
      changed.push({ path, content: readFileSync(join(source, path)) });
    }
    for (const path of readDeleted(join(source, DELETED_FILE))) {
      if (!superseded.has(path)) deleted.add(path);
    }
  }

  options.assertRootOwner?.();
  if (!changed.length && !deleted.size) {
    if (existsSync(target)) removeOwnedDirectorySync(options.root, target, { assertRootOwner: options.assertRootOwner });
    return 0;
  }
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    for (const page of changed) {
      const file = join(staging, WIKI_DIRECTORY, page.path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, page.content, { mode: 0o600 });
    }
    mkdirSync(join(staging, WIKI_DIRECTORY), { recursive: true, mode: 0o700 });
    writeFileSync(join(staging, WIKI_DIRECTORY, DELETED_FILE), `${JSON.stringify([...deleted].sort())}\n`, { mode: 0o600 });
    options.assertRootOwner?.();
    if (existsSync(target)) removeOwnedDirectorySync(options.root, target, { assertRootOwner: options.assertRootOwner });
    renameSync(staging, target);
  } finally {
    if (existsSync(staging)) removeOwnedDirectorySync(options.root, staging, { assertRootOwner: options.assertRootOwner });
  }
  return changed.length + deleted.size;
}

export interface WikiRestoreOptions {
  root: string;
  subject: StorageSubjectRef;
  workDir: string;
}

/**
 * Put a saved snapshot over a materialized working copy. A page is touched
 * only while it still equals the fetch baseline (or does not exist), so edits
 * made since the working copy was rebuilt are never overwritten. Returns the
 * number of pages restored or deleted.
 */
export function restoreWiki(options: WikiRestoreOptions): number {
  const source = registrySnapshotWikiDirectory(options.root, options.subject);
  if (!existsSync(source)) return 0;
  const wikiRoot = resolve(options.workDir, WIKI_DIRECTORY);
  const baseline = readBaseline(options.workDir);
  let applied = 0;
  for (const path of listPages(source)) {
    const file = pageFile(wikiRoot, path);
    const saved = readFileSync(join(source, path));
    const current = readPage(file);
    if (current !== null) {
      const hash = sha256(current);
      // Already restored, or edited since the working copy was rebuilt.
      if (hash === sha256(saved) || hash !== baseline.get(path)) continue;
    }
    assertNoLinkedAncestor(wikiRoot, file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, saved, { mode: 0o644, flag: "wx" });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    applied++;
  }
  for (const path of readDeleted(join(source, DELETED_FILE))) {
    const file = pageFile(wikiRoot, path);
    const current = readPage(file);
    if (current === null || sha256(current) !== baseline.get(path)) continue;
    rmSync(file, { force: true });
    applied++;
  }
  return applied;
}

/** Page path (below `wiki/`) to the hash its fetch baseline had. Missing or unreadable manifests mean no baseline. */
function readBaseline(workDir: string): Map<string, string> {
  const baseline = new Map<string, string>();
  const base = join(workDir, WIKI_BASE_DIRECTORY);
  for (const [manifest, prefix] of [
    [join(base, "manifest.json"), ""],
    [join(base, "repositories", "manifest.json"), "repositories/"],
  ] as const) {
    let docs: unknown;
    try {
      docs = (JSON.parse(readFileSync(manifest, "utf8")) as { docs?: unknown }).docs;
    } catch {
      continue;
    }
    if (!Array.isArray(docs)) continue;
    for (const doc of docs as Array<{ path?: unknown; sha256?: unknown }>) {
      if (typeof doc?.path === "string" && typeof doc.sha256 === "string" && safePagePath(`${prefix}${doc.path}`)) {
        baseline.set(`${prefix}${doc.path}`, doc.sha256);
      }
    }
  }
  return baseline;
}

/** Markdown pages below `root` as `/`-separated relative paths; links are never followed. */
function listPages(root: string): string[] {
  const pages: string[] = [];
  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git") visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        pages.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return pages.sort();
}

function readDeleted(path: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && safePagePath(entry)) : [];
  } catch {
    return [];
  }
}

function readPage(file: string): Buffer | null {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) throw new Error(`Wiki page is not a regular file: ${file}`);
  return readFileSync(file);
}

function safePagePath(path: string): boolean {
  return !!path && path.length <= 1024 && !path.includes("\0") && !path.includes("\\")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function pageFile(wikiRoot: string, path: string): string {
  if (!safePagePath(path)) throw new Error(`Wiki snapshot path is invalid: ${path}`);
  return join(wikiRoot, ...path.split("/"));
}

function assertNoLinkedAncestor(root: string, file: string): void {
  let current = root;
  for (const part of relative(root, dirname(file)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Wiki directory is unsafe: ${current}`);
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
