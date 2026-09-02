import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizeWikiPath } from "@multiremi/contracts/wiki-path";
import type {
  AgentTask,
  AgentTaskProjectDoc,
  AgentTaskRepositoryWikiDoc,
} from "@daemon/contracts/types.js";

export const ISSUE_WIKI_DIRECTORY = "wiki";
export const ISSUE_WIKI_BASE_DIRECTORY = ".multiremi/wiki-base";

export interface IssueWikiManifestEntry {
  id: string;
  slug: string;
  path: string;
  title: string;
  summary: string | null;
  tags: string[];
  pinned: boolean;
  refs: Array<{ type: string; value: string }>;
  version: number;
  sha256: string;
  updatedAt: string;
}

export interface IssueWikiManifest {
  version: 1;
  projectId: string;
  workspaceId: string;
  pulledAt: string;
  docs: IssueWikiManifestEntry[];
}

/**
 * Fast-forward the local Wiki working copy without overwriting local edits.
 * Diverged files retain their original base and are reconciled by `remi wiki push`.
 */
export async function prepareIssueWikiWorkspace(workDir: string, task: AgentTask): Promise<IssueWikiManifest | null> {
  const projectId = task.project?.id?.trim();
  if (!projectId || task.issue?.issueKind === "intake") {
    const contexts = task.repositoryWikiContexts ?? task.repository_wiki_contexts ?? [];
    if (contexts.length) {
      return withIssueWikiLock(workDir, () => {
        prepareRepositoryWikiWorkspaces(workDir, task);
        return null;
      });
    }
    return null;
  }
  return withIssueWikiLock(workDir, () => prepareIssueWikiWorkspaceUnlocked(workDir, task, projectId));
}

function prepareIssueWikiWorkspaceUnlocked(workDir: string, task: AgentTask, projectId: string): IssueWikiManifest {
  const remoteDocs = (task.projectWikiDocs ?? task.project_wiki_docs ?? [])
    .filter((doc) => doc.kind === "wiki" && (!doc.projectId || doc.projectId === projectId));
  const wikiRoot = join(workDir, ISSUE_WIKI_DIRECTORY);
  const baseRoot = join(workDir, ISSUE_WIKI_BASE_DIRECTORY);
  const filesRoot = join(baseRoot, "files");
  const manifestPath = join(baseRoot, "manifest.json");
  ensureSafeDirectory(workDir, wikiRoot);
  ensureSafeDirectory(workDir, filesRoot);
  if (existsSync(join(wikiRoot, ".git"))) {
    throw new Error(`Reserved Wiki directory is already a Git worktree: ${wikiRoot}`);
  }

  const previous = readManifest(workDir, manifestPath);
  if (previous && previous.projectId !== projectId) {
    throw new Error(`Wiki working copy belongs to ${previous.projectId}, not ${projectId}`);
  }
  const previousById = new Map(previous?.docs.map((entry) => [entry.id, entry]) ?? []);
  const previousBySlug = new Map(previous?.docs.map((entry) => [entry.slug, entry]) ?? []);
  const matchedPriorPaths = new Set<string>();
  const nextEntries: IssueWikiManifestEntry[] = [];

  for (const doc of remoteDocs) {
    const prior = previousById.get(doc.id) ?? previousBySlug.get(doc.slug);
    if (prior) matchedPriorPaths.add(prior.path);
    const remotePath = projectDocPath(doc);
    const priorPath = prior?.path ?? remotePath;
    const localPath = join(wikiRoot, priorPath);
    const basePath = join(filesRoot, priorPath);
    const remoteText = markdownFile(doc.body);
    const remoteEntry = manifestEntry(doc, remotePath, remoteText);

    if (!prior) {
      if (readRegularText(workDir, localPath, "Wiki page") === null) writeTextAtomic(workDir, localPath, remoteText);
      writeReadOnlyText(workDir, basePath, remoteText);
      nextEntries.push(remoteEntry);
      continue;
    }

    const baseText = readVerifiedBase(workDir, basePath, prior);
    const localText = readRegularText(workDir, localPath, "Wiki page");
    const remoteUnchanged = prior.id === remoteEntry.id
      && prior.version === remoteEntry.version
      && prior.sha256 === remoteEntry.sha256
      && prior.path === remoteEntry.path;
    if (remoteUnchanged) {
      nextEntries.push(prior);
      continue;
    }
    if (localText !== null && localText === baseText) {
      if (prior.path !== remotePath) {
        removeRegularFile(workDir, localPath);
        removeRegularFile(workDir, basePath);
      }
      writeTextAtomic(workDir, join(wikiRoot, remotePath), remoteText);
      writeReadOnlyText(workDir, join(filesRoot, remotePath), remoteText);
      nextEntries.push(remoteEntry);
      continue;
    }
    // A missing/edited local file is a local change. Keep the old base so push
    // can merge it against the latest remote version.
    nextEntries.push(prior);
  }

  for (const prior of previous?.docs ?? []) {
    if (matchedPriorPaths.has(prior.path)) continue;
    const localPath = join(wikiRoot, prior.path);
    const basePath = join(filesRoot, prior.path);
    const localText = readRegularText(workDir, localPath, "Wiki page");
    const baseText = readVerifiedBase(workDir, basePath, prior);
    if (localText !== null && localText !== baseText) {
      nextEntries.push(prior);
      continue;
    }
    if (existsSync(localPath)) removeRegularFile(workDir, localPath);
    if (existsSync(basePath)) {
      removeRegularFile(workDir, basePath);
    }
  }

  const manifest: IssueWikiManifest = {
    version: 1,
    projectId,
    workspaceId: task.workspaceId,
    pulledAt: new Date().toISOString(),
    docs: nextEntries.sort((a, b) => a.slug.localeCompare(b.slug)),
  };
  writeJsonAtomic(workDir, manifestPath, manifest);
  prepareRepositoryWikiWorkspaces(workDir, task);
  return manifest;
}

interface RepositoryWikiManifestEntry {
  id: string;
  repositoryId: string;
  repositoryName: string;
  path: string;
  version: number;
  sourceRevision: string | null;
  sha256: string;
  updatedAt: string;
}

interface RepositoryWikiManifestRepository {
  id: string;
  name: string;
  directory: string;
}

interface RepositoryWikiManifest {
  version: 1;
  workspaceId: string;
  pulledAt: string;
  repositories: RepositoryWikiManifestRepository[];
  docs: RepositoryWikiManifestEntry[];
}

function prepareRepositoryWikiWorkspaces(workDir: string, task: AgentTask): void {
  const contexts = task.repositoryWikiContexts ?? task.repository_wiki_contexts ?? [];
  const wikiRoot = join(workDir, ISSUE_WIKI_DIRECTORY, "repositories");
  const baseRoot = join(workDir, ISSUE_WIKI_BASE_DIRECTORY, "repositories");
  const manifestPath = join(baseRoot, "manifest.json");
  ensureSafeDirectory(workDir, wikiRoot);
  ensureSafeDirectory(workDir, baseRoot);
  const previous = readRepositoryManifest(workDir, manifestPath);
  const previousById = new Map(previous?.docs.map((entry) => [entry.id, entry]) ?? []);
  const next: RepositoryWikiManifestEntry[] = [];
  const repositories: RepositoryWikiManifestRepository[] = [];

  for (const context of contexts) {
    const repositoryDirectory = `${safeSlug(context.repository.name)}-${safeSlug(context.repository.id).slice(-8)}`;
    repositories.push({
      id: context.repository.id,
      name: context.repository.name,
      directory: repositoryDirectory,
    });
    ensureSafeDirectory(workDir, join(wikiRoot, repositoryDirectory));
    for (const doc of context.docs) {
      if (repositoryWikiDocUnavailable(doc)) {
        const prior = previousById.get(doc.id);
        if (prior) next.push(prior);
        continue;
      }
      const relativePath = validRepositoryManifestPath(doc.path) ? doc.path : null;
      if (!relativePath) throw new Error(`Repository Wiki path is invalid: ${doc.path}`);
      const path = join(repositoryDirectory, ...relativePath.split("/"));
      const localPath = join(wikiRoot, path);
      const basePath = join(baseRoot, "files", path);
      const text = markdownFile(doc.body);
      const prior = previousById.get(doc.id);
      const entry = repositoryManifestEntry(context.repository.id, context.repository.name, doc, path, text);
      const local = readRegularText(workDir, localPath, "Repository Wiki page");
      const base = prior ? readRegularText(workDir, basePath, "Repository Wiki baseline") : null;
      if (!prior || local === null || (base !== null && local === base)) {
        writeTextAtomic(workDir, localPath, text);
        writeReadOnlyText(workDir, basePath, text);
        next.push(entry);
      } else {
        next.push(prior);
      }
    }
  }

  writeJsonAtomic(workDir, manifestPath, {
    version: 1,
    workspaceId: task.workspaceId,
    pulledAt: new Date().toISOString(),
    repositories: repositories.sort((left, right) => left.name.localeCompare(right.name)),
    docs: next.sort((left, right) => left.path.localeCompare(right.path)),
  } satisfies RepositoryWikiManifest);
}

function repositoryWikiDocUnavailable(doc: AgentTaskRepositoryWikiDoc): boolean {
  const status = String(doc.status ?? "").trim().toLowerCase();
  const syncStatus = String(doc.syncStatus ?? doc.sync_status ?? "").trim().toLowerCase();
  return status === "failed" || status === "unavailable"
    || syncStatus === "failed" || syncStatus === "unavailable";
}

function repositoryManifestEntry(
  repositoryId: string,
  repositoryName: string,
  doc: AgentTaskRepositoryWikiDoc,
  path: string,
  text: string,
): RepositoryWikiManifestEntry {
  return {
    id: doc.id,
    repositoryId,
    repositoryName,
    path,
    version: Math.max(1, Math.floor(Number(doc.version ?? 1))),
    sourceRevision: doc.sourceRevision ?? null,
    sha256: sha256(text),
    updatedAt: doc.updatedAt,
  };
}

function readRepositoryManifest(workDir: string, path: string): RepositoryWikiManifest | null {
  const text = readRegularText(workDir, path, "Repository Wiki manifest");
  if (text === null) return null;
  const value = JSON.parse(text) as Partial<RepositoryWikiManifest>;
  if (value.version !== 1 || !Array.isArray(value.docs)) throw new Error("Repository Wiki manifest is invalid");
  if (value.repositories !== undefined && !Array.isArray(value.repositories)) throw new Error("Repository Wiki manifest repositories are invalid");
  for (const repository of value.repositories ?? []) {
    if (!repository?.id || !repository.name || !repository.directory || repository.directory.includes("/") || repository.directory.includes("\\")) {
      throw new Error("Repository Wiki manifest contains an invalid repository");
    }
  }
  for (const entry of value.docs) {
    if (!entry?.id || !entry.repositoryId || !validRepositoryManifestPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("Repository Wiki manifest contains an invalid entry");
    }
  }
  return { ...value, repositories: value.repositories ?? [] } as RepositoryWikiManifest;
}

function validRepositoryManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !value.toLowerCase().endsWith(".md") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function manifestEntry(doc: AgentTaskProjectDoc, path: string, text: string): IssueWikiManifestEntry {
  return {
    id: doc.id,
    slug: doc.slug,
    path,
    title: doc.title,
    summary: doc.summary,
    tags: [...doc.tags],
    pinned: doc.pinned,
    refs: docRefs(doc.refs),
    version: Number.isFinite(Number((doc as { version?: number }).version))
      ? Math.max(1, Math.floor(Number((doc as { version?: number }).version)))
      : 1,
    sha256: sha256(text),
    updatedAt: doc.updatedAt,
  };
}

function docRefs(value: unknown): Array<{ type: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref) => {
    if (!ref || typeof ref !== "object") return [];
    const type = String((ref as { type?: unknown }).type ?? "").trim();
    const refValue = String((ref as { value?: unknown }).value ?? "").trim();
    return type && refValue ? [{ type, value: refValue }] : [];
  });
}

function readManifest(workDir: string, path: string): IssueWikiManifest | null {
  const text = readRegularText(workDir, path, "Wiki manifest");
  if (text === null) return null;
  let value: Partial<IssueWikiManifest>;
  try {
    value = JSON.parse(text) as Partial<IssueWikiManifest>;
  } catch (error) {
    throw new Error(`Wiki manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value.version !== 1 || typeof value.projectId !== "string" || !Array.isArray(value.docs)) {
    throw new Error("Wiki manifest has an unsupported or incomplete schema");
  }
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const entry of value.docs) {
    if (
      !entry
      || typeof entry.id !== "string"
      || !entry.id
      || typeof entry.slug !== "string"
      || !entry.slug
      || !validManifestPath(entry.path)
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) throw new Error("Wiki manifest contains an invalid entry");
    if (paths.has(entry.path) || ids.has(entry.id)) {
      throw new Error("Wiki manifest contains duplicate document identities or paths");
    }
    paths.add(entry.path);
    ids.add(entry.id);
  }
  return value as IssueWikiManifest;
}

function validManifestPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const normalized = normalizeWikiPath(value);
    return normalized === value && normalized !== "repositories.md" && !normalized.startsWith("repositories/");
  } catch {
    return false;
  }
}

function projectDocPath(doc: AgentTaskProjectDoc): string {
  const value = doc.path ?? `${safeSlug(doc.slug)}.md`;
  if (!validManifestPath(value)) throw new Error(`Project Wiki path is invalid: ${value}`);
  return value;
}

function safeSlug(value: string): string {
  const slug = value.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/^\.+$/, "").slice(0, 160);
  return slug || `wiki-${sha256(value).slice(0, 12)}`;
}

function markdownFile(body: string): string {
  return `${body.replace(/[\r\n]+$/, "")}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readVerifiedBase(workDir: string, path: string, entry: IssueWikiManifestEntry): string {
  const value = readRegularText(workDir, path, "Wiki baseline");
  if (value === null) throw new Error(`Wiki base is incomplete: ${entry.path}`);
  if (sha256(value) !== entry.sha256) {
    throw new Error(`Wiki baseline checksum mismatch: ${entry.path}; refusing to overwrite local work`);
  }
  return value;
}

function readRegularText(workDir: string, path: string, label: string): string | null {
  assertSafeAncestors(workDir, path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
}

function writeReadOnlyText(workDir: string, path: string, value: string): void {
  assertSafeFileTarget(workDir, path);
  if (existsSync(path)) chmodSync(path, 0o644);
  writeTextAtomic(workDir, path, value);
  chmodSync(path, 0o444);
}

function writeJsonAtomic(workDir: string, path: string, value: unknown): void {
  writeTextAtomic(workDir, path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(workDir: string, path: string, value: string): void {
  assertSafeFileTarget(workDir, path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tempPath, value, { mode: 0o644, flag: "wx" });
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function removeRegularFile(workDir: string, path: string): void {
  assertSafeFileTarget(workDir, path);
  if (!existsSync(path)) return;
  chmodSync(path, 0o644);
  rmSync(path, { force: true });
}

async function withIssueWikiLock<T>(workDir: string, operation: () => T | Promise<T>): Promise<T> {
  const root = resolve(workDir);
  const lock = join(root, ".multiremi", "wiki.lock");
  ensureSafeDirectory(root, dirname(lock));
  if (existsSync(join(dirname(lock), ".git"))) {
    throw new Error(`Reserved Multiremi directory is already a Git worktree: ${dirname(lock)}`);
  }
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      const stat = lstatSync(lock);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki lock is unsafe: ${lock}`);
      if (Date.now() - stat.mtimeMs > 60 * 60_000) {
        try {
          rmdirSync(lock);
          continue;
        } catch {
          // A live owner may have just released the lock.
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Wiki working-copy lock");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  try {
    return await operation();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // A future operation validates stale or malformed lock paths.
    }
  }
}

function ensureSafeDirectory(rootPath: string, target: string): void {
  const root = resolve(rootPath);
  if (!isWithin(root, target)) throw new Error(`Wiki path escapes the Issue workspace: ${target}`);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Issue workspace is unsafe: ${root}`);
  const rel = relative(root, target);
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o755 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki directory is unsafe: ${current}`);
  }
}

function assertSafeFileTarget(rootPath: string, path: string): void {
  const root = resolve(rootPath);
  ensureSafeDirectory(root, dirname(path));
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Wiki file target is unsafe: ${path}`);
}

function assertSafeAncestors(rootPath: string, path: string): void {
  const root = resolve(rootPath);
  if (!isWithin(root, path)) throw new Error(`Wiki path escapes the Issue workspace: ${path}`);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Issue workspace is unsafe: ${root}`);
  const rel = relative(root, dirname(path));
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki path contains an unsafe directory: ${current}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isFsError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
