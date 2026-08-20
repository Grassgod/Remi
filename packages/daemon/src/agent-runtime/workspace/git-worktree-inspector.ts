import fs from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  STAGE,
  TREE,
  isDescendent,
  listRefs,
  resolveRef,
  statusMatrix,
  walk,
} from "isomorphic-git";
import { createLogger } from "@shared/logger.js";

const log = createLogger("multiremi-git-inspector");

export interface GitWorktreeInspector {
  hasDirtyWorktree(workspaceDir: string): Promise<boolean>;
  close(): void;
}

const MAX_REMOTE_CONTAINMENT_DEPTH = 10_000;
const MAX_INSPECTED_WORKTREE_ENTRIES = 10_000;
const MAX_INSPECTED_PACK_BYTES = 256 * 1024 * 1024;

/** Pure-JavaScript Git inspection keeps GC from spawning inside the Bun daemon. */
export class IsomorphicGitWorktreeInspector implements GitWorktreeInspector {
  async hasDirtyWorktree(workspaceDir: string): Promise<boolean> {
    try {
      const workspace = await lstat(workspaceDir);
      if (!workspace.isDirectory() || workspace.isSymbolicLink()) return true;
      const entries = await readdir(workspaceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".multiremi") continue;
        const dir = join(workspaceDir, entry.name);
        const gitdir = await openReadableGitDir(dir);
        if (!gitdir) continue;
        try {
          log.debug(`Inspecting Git worktree: ${dir}`);
          if (await repoHasLocalChanges(dir, gitdir.path)) return true;
          if (!await remoteContainsHead(dir, gitdir.path)) return true;
        } finally {
          await gitdir.close();
        }
      }
      return false;
    } catch (error) {
      log.debug(
        `Git worktree inspection failed closed for ${workspaceDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  close(): void {}
}

async function repoHasLocalChanges(dir: string, gitdir: string): Promise<boolean> {
  if (await exceedsWorktreeEntryLimit(dir)) {
    log.debug(`Retaining Git worktree above entry limit: ${dir}`);
    return true;
  }
  if (await exceedsPackByteLimit(gitdir)) {
    log.debug(`Retaining Git worktree above pack-byte limit: ${dir}`);
    return true;
  }
  // statusMatrix intentionally omits Git links. Until nested worktrees can be
  // inspected recursively, retain any workspace containing a submodule.
  if (await hasGitlink(dir, gitdir)) {
    log.debug(`Retaining Git worktree containing a Git link: ${dir}`);
    return true;
  }
  const matrix = await statusMatrix({ fs, dir, gitdir, refresh: false });
  const dirty = matrix.some(([, head, worktree, stage]) => head !== worktree || head !== stage);
  log.debug(`Git worktree status inspected: ${dir} dirty=${dirty}`);
  return dirty;
}

async function exceedsWorktreeEntryLimit(dir: string): Promise<boolean> {
  const pending = [dir];
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (current === dir && entry.name === ".git") continue;
      count++;
      if (count > MAX_INSPECTED_WORKTREE_ENTRIES) return true;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(join(current, entry.name));
      }
    }
  }
  return false;
}

async function exceedsPackByteLimit(gitdir: string): Promise<boolean> {
  const packDir = join(gitdir, "objects", "pack");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(packDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = join(packDir, entry.name);
    const info = await lstat(path);
    if (!entry.isFile() || info.isSymbolicLink()) {
      throw new Error(`Git pack entry is unsafe: ${path}`);
    }
    bytes += info.size;
    if (bytes > MAX_INSPECTED_PACK_BYTES) return true;
  }
  return false;
}

async function hasGitlink(dir: string, gitdir: string): Promise<boolean> {
  let found = false;
  await walk({
    fs,
    dir,
    gitdir,
    trees: [TREE({ ref: "HEAD" }), STAGE()],
    map: async (_filepath, entries) => {
      for (const entry of entries) {
        if (entry && await entry.type() === "commit") found = true;
      }
    },
  });
  return found;
}

async function remoteContainsHead(dir: string, gitdir: string): Promise<boolean> {
  const head = await resolveRef({ fs, dir, gitdir, ref: "HEAD" });
  const refs = await listRefs({ fs, dir, gitdir, filepath: "refs/remotes" });
  const cache = {};
  const tips: string[] = [];
  for (const ref of refs) {
    try {
      tips.push(await resolveRef({ fs, dir, gitdir, ref: `refs/remotes/${ref}` }));
    } catch {
      continue;
    }
  }
  if (tips.includes(head)) {
    log.debug(`Git HEAD exactly matches a remote ref: ${dir}`);
    return true;
  }
  for (const tip of tips) {
    try {
      if (await isDescendent({
        fs,
        dir,
        gitdir,
        oid: tip,
        ancestor: head,
        depth: MAX_REMOTE_CONTAINMENT_DEPTH,
        cache,
      })) {
        log.debug(`Git HEAD is contained by a remote ref: ${dir}`);
        return true;
      }
    } catch {
      // A corrupt or exceptionally deep ref cannot prove the workspace safe to delete.
    }
  }
  log.debug(`Git HEAD is not proven on a remote ref: ${dir}`);
  return false;
}

interface ReadableGitDir {
  path: string;
  close(): Promise<void>;
}

async function openReadableGitDir(dir: string): Promise<ReadableGitDir | null> {
  const marker = join(dir, ".git");
  let markerInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    markerInfo = await lstat(marker);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (markerInfo.isSymbolicLink()) throw new Error(`Git metadata link is unsafe: ${marker}`);
  if (markerInfo.isDirectory()) return { path: marker, close: async () => {} };
  if (!markerInfo.isFile() || markerInfo.size > 4096) {
    throw new Error(`Invalid Git metadata marker: ${marker}`);
  }
  const match = /^gitdir:\s*(.+)\s*$/i.exec(await readFile(marker, "utf8"));
  if (!match?.[1]) throw new Error(`Invalid Git worktree marker: ${marker}`);
  const target = match[1];
  const gitdir = isAbsolute(target) ? resolve(target) : resolve(dir, target);
  const gitdirInfo = await lstat(gitdir);
  if (!gitdirInfo.isDirectory() || gitdirInfo.isSymbolicLink()) {
    throw new Error(`Git worktree metadata is unsafe: ${gitdir}`);
  }
  const common = await resolveCommonGitDir(gitdir);
  if (common === gitdir) return { path: gitdir, close: async () => {} };

  const view = await mkdtemp(join(tmpdir(), "multiremi-git-read-"));
  try {
    await linkRequiredGitEntry(gitdir, view, "HEAD", "file");
    await linkRequiredGitEntry(gitdir, view, "index", "file");
    await linkRequiredGitEntry(common, view, "objects", "dir");
    await linkRequiredGitEntry(common, view, "refs", "dir");
    for (const name of ["packed-refs", "config", "shallow", "config.worktree"]) {
      await linkOptionalGitEntry(name === "config.worktree" ? gitdir : common, view, name);
    }
    return {
      path: view,
      close: async () => {
        await rm(view, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(view, { recursive: true, force: true });
    throw error;
  }
}

async function resolveCommonGitDir(gitdir: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(gitdir, "commondir"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return gitdir;
    throw error;
  }
  const value = raw.trim();
  if (!value) throw new Error(`Invalid Git commondir: ${gitdir}`);
  const common = isAbsolute(value) ? resolve(value) : resolve(gitdir, value);
  const info = await lstat(common);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Git common metadata is unsafe: ${common}`);
  }
  return common;
}

async function linkRequiredGitEntry(
  sourceRoot: string,
  targetRoot: string,
  name: string,
  type: "file" | "dir",
): Promise<void> {
  const source = join(sourceRoot, name);
  const info = await lstat(source);
  if (info.isSymbolicLink() || (type === "file" ? !info.isFile() : !info.isDirectory())) {
    throw new Error(`Git metadata entry is unsafe: ${source}`);
  }
  await symlink(source, join(targetRoot, name), type);
}

async function linkOptionalGitEntry(sourceRoot: string, targetRoot: string, name: string): Promise<void> {
  const source = join(sourceRoot, name);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(source);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error(`Git metadata entry is unsafe: ${source}`);
  }
  await symlink(source, join(targetRoot, name), info.isDirectory() ? "dir" : "file");
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
