/**
 * The git repositories inside a tree the daemon is about to delete or set aside
 * (ADR 0018, amendments A4 and A5).
 *
 * Reclaim, the cleanup of lane environments, orphan forget, the expiry of topic
 * workspaces and the legacy sweep all delete trees an agent has worked in, and
 * agents leave repositories in odd places: a clone inside a checkout, a worktree
 * of a clone, a sibling worktree beside the checkout, a bare repository used as
 * a remote. One inspection answers the same questions for every one of those
 * trees:
 *
 * - discover: every `.git` (file or directory) and every bare repository up to
 *   `REPOSITORY_SEARCH_DEPTH` levels down, inside other repositories too, never
 *   through a link; a bare repository is one git accepts as such, and not one
 *   the enclosing repository tracks as project content; what somebody put in a
 *   bare repository (a worktree) is found, what git keeps there is not searched;
 * - classify: *shared-linked* when the repository's common git directory is a
 *   bare repository of the shared cache, *standalone* otherwise (a plain clone,
 *   a bare repository, a worktree or submodule of one, anything git cannot place
 *   in the cache);
 * - check: unsaved work is uncommitted or untracked files, or commits no remote
 *   ref contains; a remote that lives in the tree dies with it and does not count;
 * - save: unsaved work of a shared-linked worktree becomes a snapshot ref in the
 *   shared repository, which outlives the tree. Nothing outlives a standalone
 *   repository, so unsaved work in one keeps the whole tree.
 *
 * Every repository is judged on its own: what is nested in it is left out of its
 * check and its snapshot, and examined as a repository of its own.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { SubjectGitSnapshot } from "@multiremi/contracts/storage.js";
import { createLogger } from "@shared/logger.js";
import {
  GitCheckFailedError,
  GitCommandError,
  SnapshotFailedError,
  assertSnapshotFits,
  commonGitDirectory,
  inspectUnsavedWork,
  isLinkedWorktree,
  repairWorktrees,
  runGit,
  snapshotWorktree,
  type UnsavedWork,
  type WorktreeScope,
} from "./git-ops.js";

const log = createLogger("multiremi-repo-inspection");

/** `.git` is looked for in the tree and this many directory levels below it. */
export const REPOSITORY_SEARCH_DEPTH = 6;
/** Directories listed at the same time while searching: a production tree has tens of thousands. */
const LISTING_CONCURRENCY = 16;
/** Directories shaped like a git directory that git is asked about at the same time. */
const PROBE_CONCURRENCY = 8;
/** What git says of a directory it does not take for a git directory (`LC_ALL=C` fixes the language). */
const NOT_A_REPOSITORY = /not a git repository/i;
/** What git keeps in a git directory of its own; anything else in a bare repository was put there by somebody (`git worktree add feature`). */
const GIT_DIRECTORY_ENTRIES: ReadonlySet<string> = new Set(["objects", "refs", "worktrees", "modules", "logs", "hooks", "info", "lfs"]);

/** Dependencies are rebuildable; a repository below one is not the agent's work. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);

export type RepositoryKind = "shared-linked" | "standalone";

/** Why a repository stops its tree from being deleted: the reason the tree is kept. */
export interface RepositoryBlocker {
  reason: "snapshot_failed" | "git_check_failed";
  message: string;
}

export interface DiscoverOptions {
  /** Directory levels searched below the tree; the tree itself is level 0. */
  maxDepth?: number;
  /**
   * Directories that are not entered, besides `.git` and `node_modules`. Given the
   * directory being listed and the name of one of its subdirectories.
   */
  skip?: (directory: string, name: string) => boolean;
}

export interface InspectOptions extends DiscoverOptions {
  /** Bare repository caches. A worktree whose repository is one of their repositories is shared-linked. */
  cacheRoots: readonly string[];
  /** Largest unsaved work (changed and untracked files) of one worktree that a snapshot can hold. */
  maxBytes: number;
  /**
   * Names directly below the tree that belong to the daemon (`wiki`, `.multiremi`). A repository at
   * the tree's root does not count them as its own content; repositories below them are still found.
   */
  daemonEntries?: ReadonlySet<string>;
  /**
   * Directories that are deleted together with the tree, the tree itself by default. A clone whose
   * remote is a repository in one of them has no remote that outlives it.
   */
  doomed?: readonly string[];
  /** Repositories checked at the same time; one by default. */
  concurrency?: number;
}

export interface InspectedRepository {
  /** The working tree: the directory that holds `.git`, or a bare repository itself. */
  path: string;
  /** Path below the inspected tree with `/` separators; `.` for the tree itself. */
  relative: string;
  /** Null when git could not place the repository; it then has a blocker. */
  kind: RepositoryKind | null;
  /** A bare repository: no working tree, always standalone. */
  bare: boolean;
  /** Its git directory as git names it (the shared bare repository of a linked worktree); null with `kind`. */
  commonDir: string | null;
  /** Dirty or unpushed. For a standalone repository that is also its blocker. */
  unsaved: boolean;
  /** What this repository's own check and snapshot leave out. */
  scope: WorktreeScope | undefined;
  blocker: RepositoryBlocker | null;
}

/** A directory that could not be listed: a repository may hide below it. */
export interface UnsearchableDirectory {
  path: string;
  message: string;
}

export interface TreeInspection {
  tree: string;
  /** In search order: a repository comes before the repositories nested in it. */
  repositories: InspectedRepository[];
  unsearchable: UnsearchableDirectory[];
}

export interface Discovery {
  /** Directories that hold a `.git` or are a bare repository, in search order. */
  repositories: string[];
  /** The bare repositories among them. */
  bare: string[];
  unsearchable: UnsearchableDirectory[];
}

/**
 * Every directory that holds a `.git` or is a bare repository itself (`HEAD`,
 * `objects/` and `refs/`; the directories git keeps in it are not searched, a
 * worktree added inside it is), in search order (a directory before the ones
 * below it, siblings by name). Only directories are entered; links are never
 * followed. A directory that cannot be listed may hide a repository, so it is
 * reported and the tree cannot be judged.
 *
 * A directory laid out like a git directory is a bare repository only when git
 * says so (a docs folder can hold a `HEAD`, `objects/` and `refs/`), and when
 * the repository around it does not track it: a bare repository committed as
 * test data is part of that project, and is entered like any other directory.
 */
export async function discoverRepositories(tree: string, options: DiscoverOptions = {}): Promise<Discovery> {
  const maxDepth = options.maxDepth ?? REPOSITORY_SEARCH_DEPTH;
  const discovery: Discovery = { repositories: [], bare: [], unsearchable: [] };
  const listing = limited(LISTING_CONCURRENCY);
  const probing = limited(PROBE_CONCURRENCY);
  /** `enclosing`: the nearest repository above `directory`, found on the way down. */
  const visit = async (directory: string, depth: number, enclosing: string | null): Promise<void> => {
    let entries;
    try {
      entries = await listing(() => readdir(directory, { withFileTypes: true }));
    } catch (error) {
      // A path that is gone, or is not a directory after all, has nothing in it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") discovery.unsearchable.push({ path: directory, message: errorMessage(error) });
      return;
    }
    // A working tree is never also a bare repository, whatever else it holds.
    const hasGit = entries.some((entry) => entry.name === ".git");
    let bare = false;
    if (!hasGit && isGitDirectoryLayout(entries)) {
      try {
        bare = await probing(() => isBareRepository(directory, enclosing));
      } catch (error) {
        // git cannot say whether it is one, and it may be: like a directory that cannot be listed.
        discovery.unsearchable.push({ path: directory, message: errorMessage(error) });
      }
    }
    if (bare) {
      discovery.repositories.push(directory);
      discovery.bare.push(directory);
    } else if (hasGit) {
      discovery.repositories.push(directory);
      enclosing = directory;
    }
    if (depth >= maxDepth) return;
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== ".git" && !SKIPPED_DIRECTORIES.has(entry.name)
        && !(bare && GIT_DIRECTORY_ENTRIES.has(entry.name)) && !options.skip?.(directory, entry.name))
      .map((entry) => visit(join(directory, entry.name), depth + 1, enclosing)));
  };
  const root = resolve(tree);
  await visit(root, 0, null);
  discovery.repositories.sort(comparePaths);
  discovery.bare.sort(comparePaths);
  discovery.unsearchable.sort((left, right) => comparePaths(left.path, right.path));
  return discovery;
}

/** The entries of a git directory on its own, what `git init --bare` makes; only the layout, git has the say. */
function isGitDirectoryLayout(entries: readonly Dirent[]): boolean {
  // git accepts a link for any of the three.
  return entries.some((entry) => entry.name === "HEAD" && (entry.isFile() || entry.isSymbolicLink()))
    && entries.some((entry) => entry.name === "objects" && (entry.isDirectory() || entry.isSymbolicLink()))
    && entries.some((entry) => entry.name === "refs" && (entry.isDirectory() || entry.isSymbolicLink()));
}

/**
 * A directory laid out like a git directory that is a bare repository to judge: the repository it stands in (if
 * any) does not have it in its index, and git takes it for one, by that very path. What the enclosing repository
 * tracks is its content whatever git makes of it, so that is asked first.
 */
async function isBareRepository(directory: string, enclosing: string | null): Promise<boolean> {
  if (enclosing !== null && await isTracked(enclosing, join(directory, "HEAD"))) return false;
  return await gitTakesAsRepository(directory);
}

/**
 * `git --git-dir=<directory> rev-parse --git-dir` names the directory itself (compared by realpath). git
 * saying it is not a repository is the only "no"; any other failure leaves the question open and throws.
 */
async function gitTakesAsRepository(directory: string): Promise<boolean> {
  let named: string;
  try {
    named = (await runGit(["--git-dir", directory, "rev-parse", "--git-dir"], { cwd: directory, env: { LC_ALL: "C" } })).stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError && NOT_A_REPOSITORY.test(error.stderr)) return false;
    throw error;
  }
  const [reported, expected] = await Promise.all([realpath(resolve(directory, named)), realpath(directory)]);
  return reported === expected;
}

/** Whether `repository` has `file` in its index. If git cannot tell, it does not: the directory is then judged as what it looks like. */
async function isTracked(repository: string, file: string): Promise<boolean> {
  try {
    const listed = await runGit(["ls-files", "-z", "--", `:(literal)${relativeTo(repository, file)}`], {
      cwd: repository,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    return listed.stdout.length > 0;
  } catch {
    return false;
  }
}

/** Discover, classify and check every repository of a tree. Nothing is changed. */
export async function inspectTree(tree: string, options: InspectOptions): Promise<TreeInspection> {
  const root = resolve(tree);
  const { repositories: paths, bare, unsearchable } = await discoverRepositories(root, options);
  const caches = await realCacheRoots(options.cacheRoots);
  const bareRepositories = new Set(bare);
  const doomed = options.doomed ?? [root];
  const repositories = new Array<InspectedRepository>(paths.length);
  let next = 0;
  const work = async () => {
    for (let index = next++; index < paths.length; index = next++) {
      const path = paths[index]!;
      const nested = paths.filter((other) => other.startsWith(`${path}${sep}`)).map((other) => relativeTo(path, other));
      const exclude = [...(path === root ? options.daemonEntries ?? [] : []), ...nested];
      repositories[index] = await inspectRepository({
        path,
        relative: relativeTo(root, path),
        scope: exclude.length ? { exclude } : undefined,
        bare: bareRepositories.has(path),
        caches,
        maxBytes: options.maxBytes,
        doomed,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 1), paths.length) }, work));
  return { tree: root, repositories, unsearchable };
}

/** What keeps the tree: the first repository that cannot be saved or checked, else a directory that cannot be searched. */
export function treeBlocker(inspection: TreeInspection): RepositoryBlocker | null {
  const blocked = inspection.repositories.find((repository) => repository.blocker)?.blocker;
  if (blocked) return blocked;
  const [unsearchable] = inspection.unsearchable;
  return unsearchable ? unsearchableBlocker(unsearchable) : null;
}

export function unsearchableBlocker(directory: UnsearchableDirectory): RepositoryBlocker {
  return { reason: "git_check_failed", message: `cannot search ${directory.path} for repositories: ${directory.message}` };
}

/** Whether any repository of the tree holds unsaved work. */
export function treeHasUnsavedWork(inspection: TreeInspection): boolean {
  return inspection.repositories.some((repository) => repository.unsaved);
}

/** The shared bare repositories whose worktrees stand in the trees, to prune once the trees are gone. */
export function sharedRepositories(inspections: readonly TreeInspection[]): string[] {
  const repositories = new Set<string>();
  for (const inspection of inspections) {
    for (const repository of inspection.repositories) {
      if (repository.kind === "shared-linked" && repository.commonDir) repositories.add(repository.commonDir);
    }
  }
  return [...repositories];
}

export interface SnapshotTreeOptions {
  /** Ref path component(s) below `refs/remi/snapshots/`, normally the subject id. */
  subjectRef: string;
  maxBytes: number;
  now: Date;
  /** Where each saved repository is recorded as having stood; restore finds it again by this alone. */
  dirOf: (repository: InspectedRepository) => string;
  /** Called before each repository is saved, e.g. the ownership fence. */
  before?: () => void;
}

/**
 * Save the unsaved work of every shared-linked worktree of an inspected tree. A
 * tree with a blocker must not be saved: the caller keeps it whole.
 */
export async function snapshotTree(inspection: TreeInspection, options: SnapshotTreeOptions): Promise<SubjectGitSnapshot[]> {
  const saved: SubjectGitSnapshot[] = [];
  for (const repository of inspection.repositories) {
    if (repository.kind !== "shared-linked" || !repository.unsaved) continue;
    options.before?.();
    const snapshot = await snapshotWorktree({
      worktree: repository.path,
      subjectRef: options.subjectRef,
      maxBytes: options.maxBytes,
      now: options.now,
      scope: repository.scope,
    });
    if (snapshot) saved.push({ ...snapshot, dir: options.dirOf(repository) });
  }
  return saved;
}

/** A linked worktree of a tree and the repository that registers it. Paths are below the tree. */
export interface LinkedWorktree {
  path: string;
  /** The repository's git directory: outside the tree (the shared cache), or below it when the repository moves with the tree. */
  owner: { path: string; inside: boolean };
}

/**
 * The linked worktrees in a tree that is about to move (or has just moved). A
 * worktree keeps its link to its repository, its `.git` file, when the tree
 * moves, but the repository's record of where the worktree stands goes stale,
 * and a `git worktree prune` would drop it and break the worktree. Listed
 * before the move, they are renewed after it by `repairMovedWorktrees`. A
 * worktree git cannot read is left out: there is nothing to repair.
 */
export async function listLinkedWorktrees(tree: string): Promise<LinkedWorktree[]> {
  const root = resolve(tree);
  const real = await realpath(root).catch(() => root);
  const { repositories } = await discoverRepositories(root);
  const found: LinkedWorktree[] = [];
  for (const path of repositories) {
    if (!await isLinkedWorktree(path)) continue;
    try {
      const [gitDirectory, commonDirectory] = (await runGit(["rev-parse", "--absolute-git-dir", "--git-common-dir"], { cwd: path })).stdout.trim().split("\n");
      const owner = resolve(path, commonDirectory!);
      // A submodule has a git directory of its own; only a worktree has one below its repository's.
      if (owner === resolve(gitDirectory!)) continue;
      const base = [real, root].find((candidate) => owner === candidate || owner.startsWith(`${candidate}${sep}`));
      found.push({ path: relativeTo(root, path), owner: base ? { path: relativeTo(base, owner), inside: true } : { path: owner, inside: false } });
    } catch (error) {
      log.warn(`Cannot tell which repository ${path} belongs to: ${errorMessage(error)}`);
    }
  }
  return found;
}

/**
 * Point the repositories of the listed worktrees at where the worktrees stand
 * now, below `tree`. Run before anything prunes: a repair that fails is logged
 * and leaves the worktrees as they are.
 */
export async function repairMovedWorktrees(worktrees: readonly LinkedWorktree[], tree: string): Promise<void> {
  const root = resolve(tree);
  const byOwner = new Map<string, string[]>();
  for (const worktree of worktrees) {
    const owner = worktree.owner.inside ? join(root, worktree.owner.path) : worktree.owner.path;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), join(root, worktree.path)]);
  }
  for (const [owner, paths] of byOwner) {
    try {
      await repairWorktrees(owner, paths);
    } catch (error) {
      log.warn(`Could not point ${owner} at the moved worktrees ${paths.join(", ")}: ${errorMessage(error)}`);
    }
  }
}

/**
 * `repairMovedWorktrees` for worktrees that were *copied* from `source` into `target`, the original still standing.
 * Only a worktree that stands in `target` as a copy of the original is repaired: one with the same `.git` file, or
 * one already pointed at the copy of its repository by an earlier, interrupted attempt. Anything else at that path
 * is somebody else's.
 *
 * A worktree whose repository lies in the tree was copied together with it, but its `.git` still names the
 * original repository, and that is the one `git worktree repair` follows (older git repairs the original and
 * cross-links the two, leaving the copy broken once the original is gone): the copy is named first. Worktrees of a
 * repository outside the tree share it with the original and need only the repair.
 */
export async function repairCopiedWorktrees(worktrees: readonly LinkedWorktree[], source: string, target: string): Promise<void> {
  const from = resolve(source);
  const root = resolve(target);
  const copied: LinkedWorktree[] = [];
  for (const worktree of worktrees) {
    const named = await administrativeDirectory(join(root, worktree.path));
    if (named === null) continue;
    const copyOfRepository = worktree.owner.inside ? join(root, worktree.owner.path, "worktrees") : null;
    if (named === await administrativeDirectory(join(from, worktree.path))) {
      if (copyOfRepository) await nameCopiedRepository(join(root, worktree.path), copyOfRepository, named);
    } else if (!copyOfRepository || dirname(named) !== copyOfRepository) {
      continue;
    }
    copied.push(worktree);
  }
  await repairMovedWorktrees(copied, target);
}

/** The administrative directory a worktree's `.git` file names, or null when it is not such a file. */
async function administrativeDirectory(worktree: string): Promise<string | null> {
  try {
    return /^gitdir: (.+)$/m.exec(await readFile(join(worktree, ".git"), "utf8"))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Point the `.git` file of a copied worktree at the administrative directory the copy of its repository has for it. */
async function nameCopiedRepository(worktree: string, administrative: string, named: string): Promise<void> {
  const copy = join(administrative, basename(named));
  try {
    if ((await stat(copy).catch(() => null))?.isDirectory()) await writeFile(join(worktree, ".git"), `gitdir: ${copy}\n`);
  } catch (error) {
    log.warn(`Could not point the copied worktree ${worktree} at the copy of its repository: ${errorMessage(error)}`);
  }
}

interface RepositoryToInspect {
  path: string;
  relative: string;
  scope: WorktreeScope | undefined;
  bare: boolean;
  caches: readonly string[];
  maxBytes: number;
  doomed: readonly string[];
}

async function inspectRepository(input: RepositoryToInspect): Promise<InspectedRepository> {
  const { path, relative, scope, bare, caches, maxBytes, doomed } = input;
  const failed = (error: unknown, kind: RepositoryKind | null = null, commonDir: string | null = null): InspectedRepository => ({
    path, relative, kind, bare, commonDir, unsaved: false, scope, blocker: repositoryBlocker(error),
  });
  let commonDir: string;
  let kind: RepositoryKind;
  try {
    commonDir = await commonGitDirectory(path);
    // A bare repository inside the tree is never the cache's: it goes with the tree.
    kind = !bare && await isSharedRepository(await realpath(commonDir), caches) ? "shared-linked" : "standalone";
  } catch (error) {
    return failed(new GitCheckFailedError(`cannot inspect ${path}: ${errorMessage(error)}`, { cause: error }));
  }
  try {
    const work = await inspectUnsavedWork(path, { scope, allRefs: kind === "standalone", bare, doomed });
    const unsaved = work.dirty || work.unpushed;
    if (kind === "standalone" && unsaved) {
      return {
        path, relative, kind, bare, commonDir, unsaved, scope,
        blocker: {
          reason: "snapshot_failed",
          message: `${path} is a standalone ${bare ? "bare repository" : "clone"} with unsaved work (${describeWork(work)}); a snapshot needs a shared repository`,
        },
      };
    }
    if (kind === "shared-linked" && work.dirty) await assertSnapshotFits(path, maxBytes, scope);
    return { path, relative, kind, bare, commonDir, unsaved, scope, blocker: null };
  } catch (error) {
    return failed(error, kind, commonDir);
  }
}

/**
 * Whether a git directory is a repository of the shared cache. It lies below a
 * cache root and no directory between the two is itself a git directory: the
 * administrative directory of a worktree and a submodule's repository lie
 * inside one, and are pruned with the worktree, so a ref written there would
 * not outlive the tree.
 */
async function isSharedRepository(commonDir: string, caches: readonly string[]): Promise<boolean> {
  const cache = caches.find((root) => commonDir.startsWith(`${root}${sep}`));
  if (!cache) return false;
  for (let directory = dirname(commonDir); directory !== cache; directory = dirname(directory)) {
    if (await isGitDirectory(directory)) return false;
  }
  return true;
}

async function isGitDirectory(path: string): Promise<boolean> {
  const [head, objects] = await Promise.all([stat(join(path, "HEAD")).catch(() => null), stat(join(path, "objects")).catch(() => null)]);
  return head?.isFile() === true && objects?.isDirectory() === true;
}

async function realCacheRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    // A cache that does not exist holds no repository.
    const real = await realpath(root).catch(() => null);
    if (real) resolved.push(real);
  }
  return resolved;
}

/** The reason a repository is kept because of this failure to check or save it. */
export function repositoryBlocker(error: unknown): RepositoryBlocker {
  return {
    reason: error instanceof SnapshotFailedError ? "snapshot_failed" : "git_check_failed",
    message: errorMessage(error),
  };
}

function describeWork(work: UnsavedWork): string {
  return [work.dirty ? "uncommitted or untracked files" : null, work.unpushed ? "commits no remote has" : null]
    .filter((part): part is string => part !== null)
    .join(" and ");
}

/** Runs tasks at most `concurrency` at a time; a finished task hands its place straight to the next one waiting. */
function limited(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active < concurrency) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Parents before their children, siblings by name: the order of a depth-first walk over sorted names. */
function comparePaths(left: string, right: string): number {
  const a = left.split(sep);
  const b = right.split(sep);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length - b.length;
}

function relativeTo(base: string, path: string): string {
  return path === base ? "." : path.slice(base.length + 1).split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
