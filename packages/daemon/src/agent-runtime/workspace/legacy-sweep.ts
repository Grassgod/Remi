/**
 * One-time sweep of the pre-ADR-0018 workspace layout (ADR 0018, section 10).
 *
 * Runs once at daemon start, before any task is claimed. It inspects every git
 * repository of the old layout like any tree the daemon deletes
 * (`repo-inspection.ts`): unsaved work of a linked worktree is saved to a
 * snapshot ref, a standalone clone or bare repository with unsaved work can only
 * be kept. It moves the shared caches to their new homes and sets every other
 * old root entry aside in `legacy-<date>/` instead of deleting it. A repository
 * whose unsaved work could not be saved goes to `legacy-<date>/retained/`, which
 * expiry never deletes, together with the cache repository its worktrees belong
 * to when the new cache cannot take it. The marker `registry/.layout-v1` makes
 * it run once.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { STORAGE_SETTINGS_DEFAULTS, type StorageSubjectRef, type SubjectGitSnapshot } from "@multiremi/contracts/storage.js";
import { createLogger } from "@shared/logger.js";
import { copySnapshotRefs, pruneWorktrees, repairWorktrees, snapshotWorktree, type WorktreeSnapshot } from "./git-ops.js";
import {
  codeViewsRoot,
  isLayoutRootEntry,
  layoutMarkerFile,
  legacyDirectory,
  legacyRetainedDirectory,
  legacyRetainedList,
  registryRoot,
  sharedReposRoot,
  sharedRoot,
} from "./layout.js";
import { readRetainedList, writeRetainedList, type RetainedLegacyWorktree } from "./legacy-retained.js";
import { writeSubjectRecord, type SubjectRecord, type SubjectRecordRepo } from "./registry.js";
import {
  REPOSITORY_SEARCH_DEPTH,
  inspectTree,
  listLinkedWorktrees,
  repairMovedWorktrees,
  repositoryBlocker,
  unsearchableBlocker,
  type InspectedRepository,
  type RepositoryBlocker,
} from "./repo-inspection.js";

const log = createLogger("multiremi-legacy-sweep");

/**
 * `issues/<key>/<repo>`, `discussions/<key>/<session>/<repo>` and the older flat layouts: an old
 * workspace's repositories sit at most this many levels below the top-level entry.
 */
const WORKSPACE_DEPTH = 3;
/**
 * `.runtime/<session>/<agent>/[delegations/<id>/]<generation>/[executions/<fingerprint>/]work/<repo>`:
 * the private execution directories where on-demand checkouts used to land.
 */
const OLD_RUNTIME = ".runtime";
const RUNTIME_WORKSPACE_DEPTH = 10;
/** Provider homes, temp directories and plugin runtimes of a lane generation hold no worktrees and can be huge. */
const RUNTIME_SUPPORT_DIRECTORIES: ReadonlySet<string> = new Set(["home", "task-tmp", ".remi-runtime"]);
const SNAPSHOT_CONCURRENCY = 4;
const OLD_REPOS = ".repos";
const OLD_CODE_VIEWS = ".snapshots";

export interface LegacySweepOptions {
  root: string;
  /** The bare repository cache in use when it is not `shared/repos`; it is pruned and repaired too, and stays in place when it lies below the root. */
  repoCacheRoot?: string;
  now?: Date;
  /** Largest unsaved work saved per worktree; a worktree with more is retained for an operator instead. */
  snapshotMaxBytes?: number;
  /** Ownership fence, called before every mutation. */
  assertRootOwner?: () => void;
}

export interface LegacySweepResult {
  /** False when the marker showed the layout was already current. */
  swept: boolean;
  worktrees: number;
  snapshots: number;
  /** Worktrees moved to `legacy-<date>/retained/` because their unsaved work could not be snapshotted. */
  retained: number;
  /** Subjects that now have a `reclaimed` registry record carrying their snapshot. */
  recordedSubjects: number;
  /** Where the old entries went; null when there was nothing to set aside. */
  legacyDirectory: string | null;
  movedEntries: string[];
}

/** A git repository of the old layout, with the old workspace it belongs to. */
interface LegacyRepository {
  repository: InspectedRepository;
  /** The nearest old workspace directory with a `gc.json`, which names the subject; null when there is none. */
  workspace: { directory: string; marker: GcMarker } | null;
  /** Names the snapshot ref of a repository whose subject is unknown. */
  name: string;
}

/** A tree that holds work the sweep could not save: a repository with unsaved work, or a directory it could not search. */
interface SnapshotFailure {
  path: string;
  /** A directory that could not be listed, which may hold nothing at all; it stays where it is when it cannot be moved either. */
  unreadable?: true;
  reason: RetainedLegacyWorktree["reason"];
  message: string;
}

interface GcMarker {
  kind?: string;
  workspace_id?: string;
  issue_id?: string;
  chat_session_id?: string;
}

export async function runLegacySweep(options: LegacySweepOptions): Promise<LegacySweepResult> {
  const root = resolve(options.root);
  const result: LegacySweepResult = {
    swept: false, worktrees: 0, snapshots: 0, retained: 0, recordedSubjects: 0, legacyDirectory: null, movedEntries: [],
  };
  if (existsSync(layoutMarkerFile(root))) return result;
  options.assertRootOwner?.();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  result.swept = true;
  const now = options.now ?? new Date();

  const maxBytes = options.snapshotMaxBytes ?? STORAGE_SETTINGS_DEFAULTS.snapshot_max_bytes;
  // A repository cache configured below the root keeps its place; it holds the snapshot refs just made.
  const cacheEntry = options.repoCacheRoot ? relative(resolve(root), resolve(options.repoCacheRoot)).split(sep)[0] : undefined;
  const found = await findLegacyRepositories(root, {
    // The caches have not moved yet: the worktrees' links still name the old path.
    cacheRoots: [join(root, OLD_REPOS), sharedReposRoot(root), ...(options.repoCacheRoot ? [resolve(options.repoCacheRoot)] : [])],
    maxBytes,
    ignored: cacheEntry,
  });
  result.worktrees = found.repositories.length;
  const saved = await snapshotLegacyRepositories(found.repositories, found.failures, maxBytes, now);
  result.snapshots = saved.snapshots;
  options.assertRootOwner?.();
  for (const record of saved.records) writeSubjectRecord(root, record);
  result.recordedSubjects = saved.records.length;
  // Before the caches move: the repositories still sit where the worktrees' links name them.
  const retained = await retainWorktrees(root, saved.failures, now, options.assertRootOwner);
  result.retained = retained.entries.length;
  if (result.retained) {
    result.legacyDirectory = legacyDirectory(root, now);
    await retainRepositories(root, retained.owners, result.legacyDirectory, options.assertRootOwner);
  }

  options.assertRootOwner?.();
  mkdirSync(sharedRoot(root), { recursive: true, mode: 0o700 });
  await moveRepositories(join(root, OLD_REPOS), sharedReposRoot(root));
  moveCache(join(root, OLD_CODE_VIEWS), codeViewsRoot(root));
  const leftovers = readdirSync(root).filter((name) => !isLayoutRootEntry(name) && name !== cacheEntry).sort();
  if (leftovers.length) {
    const target = legacyDirectory(root, now);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of leftovers) {
      options.assertRootOwner?.();
      renameSync(join(root, name), uniqueChild(target, name));
      result.movedEntries.push(name);
    }
    result.legacyDirectory = target;
  }
  // Worktrees that stayed (Feishu topic workspaces) still point at the old cache path.
  const retainedRepositories = result.legacyDirectory ? [join(legacyRetainedDirectory(result.legacyDirectory), OLD_REPOS)] : [];
  for (const reposRoot of new Set([sharedReposRoot(root), ...(options.repoCacheRoot ? [resolve(options.repoCacheRoot)] : []), ...retainedRepositories])) {
    await maintainRepositories(reposRoot);
  }

  mkdirSync(registryRoot(root), { recursive: true, mode: 0o700 });
  writeFileSync(layoutMarkerFile(root), `${JSON.stringify({ version: 1, swept_at: now.toISOString() })}\n`, { mode: 0o600 });
  if (result.worktrees || result.movedEntries.length) log.info("Legacy workspace layout swept", { ...result });
  return result;
}

interface LegacySearch {
  /** Bare repository caches, old and new: they tell a linked worktree from a standalone clone. */
  cacheRoots: readonly string[];
  maxBytes: number;
  /** A top-level entry that is not part of the old layout. */
  ignored: string | undefined;
}

/**
 * In the old `.runtime` tree the `home`, `task-tmp` and `.remi-runtime` directories that stand beside the
 * `work/` of a lane generation (directly below the generation, as a Chat's, which has no `work/`, do too)
 * are provider state, huge and without worktrees. They are skipped there and nowhere else: a repository an
 * agent called `home`, or one under a directory called `task-tmp`, lives in a `work/` and is its work.
 */
function skipRuntimeSupport(runtimeRoot: string): (directory: string, name: string) => boolean {
  return (directory, name) => RUNTIME_SUPPORT_DIRECTORIES.has(name) && isGenerationRoot(relative(runtimeRoot, directory).split(sep));
}

/** `<session>/<agent>/[delegations/<id>/]<generation>[/executions/<fingerprint>]` below `.runtime`. */
function isGenerationRoot(parts: readonly string[]): boolean {
  let index = 2;
  if (parts[index] === "delegations") index += 2;
  if (!/^[1-9]\d*$/.test(parts[index] ?? "")) return false;
  index++;
  if (parts[index] === "executions") index += 2;
  return parts.length === index;
}

/**
 * Every git repository below the old root entries, nested ones included. A
 * directory that cannot be listed may hide a repository, so it is handled like
 * work that could not be saved.
 */
async function findLegacyRepositories(
  root: string,
  search: LegacySearch,
): Promise<{ repositories: LegacyRepository[]; failures: SnapshotFailure[] }> {
  const repositories: LegacyRepository[] = [];
  const failures: SnapshotFailure[] = [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !isLayoutRootEntry(entry.name) && entry.name !== OLD_REPOS && entry.name !== OLD_CODE_VIEWS && entry.name !== search.ignored)
    .sort((left, right) => left.name.localeCompare(right.name));
  // All of them are set aside together, so a remote in one of them outlives none of the clones.
  const doomed = entries.map((entry) => join(root, entry.name));
  for (const entry of entries) {
    const top = join(root, entry.name);
    const runtime = entry.name === OLD_RUNTIME;
    const tree = await inspectTree(top, {
      cacheRoots: search.cacheRoots,
      maxBytes: search.maxBytes,
      concurrency: SNAPSHOT_CONCURRENCY,
      maxDepth: (runtime ? RUNTIME_WORKSPACE_DEPTH : WORKSPACE_DEPTH) + REPOSITORY_SEARCH_DEPTH,
      doomed,
      ...(runtime ? { skip: skipRuntimeSupport(top) } : {}),
    });
    for (const repository of tree.repositories) {
      repositories.push({
        repository,
        workspace: workspaceOf(top, repository.path),
        // The first level below `.runtime` is the session: it keeps the ref names of its worktrees apart.
        name: runtime ? `runtime-${relative(top, repository.path).split(sep)[0]}` : basename(dirname(repository.path)),
      });
    }
    for (const directory of tree.unsearchable) {
      const blocker = unsearchableBlocker(directory);
      log.warn(`${blocker.message}; it is kept in the retained directory`);
      failures.push({ path: directory.path, unreadable: true, reason: blocker.reason, message: blocker.message });
    }
  }
  return { repositories, failures };
}

/** The old workspace directory a repository stands in: the nearest one, from the repository up, that has a `gc.json`. */
function workspaceOf(top: string, repository: string): LegacyRepository["workspace"] {
  for (let directory = repository; ; directory = dirname(directory)) {
    const marker = readGcMarker(directory);
    if (marker) return { directory, marker };
    if (directory === top) return null;
  }
}

/**
 * Save what can be saved: unsaved work of a linked worktree becomes a snapshot ref.
 * A repository the inspection could not clear, or whose snapshot fails now, is
 * handed to `failures` with the work it holds.
 */
async function snapshotLegacyRepositories(
  repositories: LegacyRepository[],
  failures: SnapshotFailure[],
  maxBytes: number,
  now: Date,
): Promise<{ snapshots: number; records: SubjectRecord[]; failures: SnapshotFailure[] }> {
  const outcomes: Array<{ snapshot: WorktreeSnapshot } | { failure: SnapshotFailure } | null> = new Array(repositories.length).fill(null);
  let next = 0;
  const work = async () => {
    for (let index = next++; index < repositories.length; index = next++) {
      const { repository, workspace, name } = repositories[index]!;
      const fail = (blocker: RepositoryBlocker) => {
        log.warn(`Cannot snapshot ${repository.path}; it is kept in the retained directory: ${blocker.message}`);
        outcomes[index] = { failure: { path: repository.path, reason: blocker.reason, message: blocker.message } };
      };
      if (repository.blocker) {
        fail(repository.blocker);
        continue;
      }
      if (repository.kind !== "shared-linked" || !repository.unsaved) continue;
      // A discussion has no subject to restore into: its work is saved under `legacy/` like any other
      // worktree of no known subject. (A read-only worktree at the Issue branch has nothing unsaved.)
      const subject = subjectOf(workspace?.marker ?? null);
      try {
        const snapshot = await snapshotWorktree({
          worktree: repository.path,
          subjectRef: subject?.id ?? `legacy/${name}`,
          maxBytes,
          now,
          scope: repository.scope,
        });
        if (snapshot) outcomes[index] = { snapshot };
      } catch (error) {
        fail(repositoryBlocker(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, repositories.length) }, work));

  const subjects = new Map<string, { subject: StorageSubjectRef; workspaceId: string; issueKey: string | null; git: SubjectGitSnapshot[]; repos: SubjectRecordRepo[] }>();
  let snapshots = 0;
  repositories.forEach(({ repository, workspace }, index) => {
    const outcome = outcomes[index];
    if (outcome && "failure" in outcome) {
      failures.push(outcome.failure);
      return;
    }
    if (!outcome) return;
    snapshots++;
    log.info(`Saved unsaved work of ${repository.path} as ${outcome.snapshot.ref}`);
    const subject = subjectOf(workspace?.marker ?? null);
    if (!subject || !workspace) return;
    // Restore finds the worktree again by this place below the subject's work directory.
    const dir = relativeTo(workspace.directory, repository.path);
    const entry = subjects.get(subject.id) ?? {
      subject,
      workspaceId: workspace.marker.workspace_id ?? "local",
      issueKey: subject.kind === "issue" ? issueKeyOf(workspace.directory) : null,
      git: [],
      repos: [],
    };
    entry.git.push({ ...outcome.snapshot, dir });
    entry.repos.push({ repo_url: outcome.snapshot.repo_url, dir, branch: outcome.snapshot.branch });
    subjects.set(subject.id, entry);
  });
  const created = now.toISOString();
  return {
    snapshots,
    failures: failures.sort((left, right) => left.path.localeCompare(right.path)),
    records: [...subjects.values()].map((entry): SubjectRecord => ({
      version: 1,
      subject: entry.subject,
      workspace_id: entry.workspaceId,
      issue_key: entry.issueKey,
      external_work_dir: null,
      repos: entry.repos,
      state: "reclaimed",
      last_used_at: created,
      created_at: created,
      reclaimed_at: created,
      snapshot: { created_at: created, git: entry.git, wiki_files: 0 },
    })),
  };
}

/** What was moved to `retained/`, and the cache repositories its linked worktrees belong to. */
interface RetainedOutcome {
  entries: RetainedLegacyWorktree[];
  /** Git directories of the repositories that register the linked worktrees now below `retained/`. */
  owners: string[];
}

/**
 * A tree whose unsaved work could not be saved holds the only copy of it, so it
 * must outlive the legacy directory's expiry. It moves to
 * `legacy-<date>/retained/<original path>` ahead of the top-level entry it lives
 * in, and `retained.json` records where it went and why. The linked worktrees in
 * it, itself or nested, are told to their repositories, so they keep working for
 * whoever recovers the work. What lies inside another retained tree moves along
 * with it.
 */
async function retainWorktrees(
  root: string,
  failures: SnapshotFailure[],
  now: Date,
  assertRootOwner: (() => void) | undefined,
): Promise<RetainedOutcome> {
  const outermost = failures.filter((failure) => !failures.some((other) => other !== failure && failure.path.startsWith(`${other.path}${sep}`)));
  if (!outermost.length) return { entries: [], owners: [] };
  const legacy = legacyDirectory(root, now);
  const retainedRoot = legacyRetainedDirectory(legacy);
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  const listed = new Map(readListedWorktrees(legacy).map((entry) => [entry.path, entry]));
  const retained: RetainedLegacyWorktree[] = [];
  const owners = new Set<string>();
  for (const failure of outermost) {
    assertRootOwner?.();
    const original = relative(root, failure.path);
    const parent = dirname(join(retainedRoot, original));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const target = uniqueChild(parent, basename(original));
    const entry: RetainedLegacyWorktree = {
      path: relative(legacy, target),
      original_path: original,
      reason: failure.reason,
      message: failure.message,
    };
    // Listed before it moves, so a crash in between never leaves a worktree nobody knows about.
    listed.set(entry.path, entry);
    writeRetainedList(legacy, { version: 1, worktrees: [...listed.values()] });
    // A directory that could not be listed has no worktrees to find.
    const linked = failure.unreadable ? [] : await listLinkedWorktrees(failure.path);
    try {
      moveTree(failure.path, target);
    } catch (error) {
      // Work that exists is never set aside to expire: failing here retries the sweep. A directory nobody can read
      // is different. Root-owned data of a container (a database volume) can be neither listed nor moved by this
      // user, and must not keep the daemon from starting; it stays in the legacy directory, which cannot delete it either.
      if (!failure.unreadable) throw error;
      listed.delete(entry.path);
      if (listed.size) writeRetainedList(legacy, { version: 1, worktrees: [...listed.values()] });
      else rmSync(legacyRetainedList(legacy), { force: true });
      removeEmptyParents(parent, legacy);
      log.warn(`Could not move ${failure.path} to the retained directory; it stays where it is: ${errorMessage(error)}`);
      continue;
    }
    retained.push(entry);
    for (const worktree of linked) if (!worktree.owner.inside) owners.add(worktree.owner.path);
    await repairMovedWorktrees(linked, target);
  }
  return { entries: retained, owners: [...owners] };
}

/**
 * The repository of a retained worktree must outlive it: its commits and branch live there. When the old
 * cache moves to its new home the worktrees follow. Where the new cache already holds a repository of the
 * same name the old one is not merged and would expire with the legacy directory, taking the commits of the
 * retained worktrees with it, so it is retained together with them, at its place below `retained/`.
 */
async function retainRepositories(
  root: string,
  owners: readonly string[],
  legacy: string,
  assertRootOwner: (() => void) | undefined,
): Promise<void> {
  const oldCache = join(root, OLD_REPOS);
  if (!lstatSync(oldCache, { throwIfNoEntry: false })?.isDirectory()) return;
  const realCache = realpathSync(oldCache);
  for (const owner of owners) {
    let real: string;
    try {
      real = realpathSync(owner);
    } catch {
      continue;
    }
    if (!real.startsWith(`${realCache}${sep}`)) continue;
    const below = relative(realCache, real);
    if (!existsSync(join(sharedReposRoot(root), below))) continue;
    assertRootOwner?.();
    const target = join(legacyRetainedDirectory(legacy), OLD_REPOS, below);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(join(oldCache, below), target);
    await copyRefsIntoExisting(join(sharedReposRoot(root), below), target, "the old repository is retained with its worktrees");
    try {
      await repairWorktrees(target);
    } catch (error) {
      log.warn(`Could not point the retained worktrees at ${target}: ${errorMessage(error)}`);
    }
  }
}

/** Take back the directories made for a move that did not happen, up to but not including `stop`. */
function removeEmptyParents(directory: string, stop: string): void {
  for (let current = directory; current.startsWith(`${stop}${sep}`); current = dirname(current)) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
  }
}

/** Rename a tree to another parent. That needs write access to the tree itself, which a directory the agent locked lacks. */
function moveTree(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    chmodSync(source, lstatSync(source).mode | 0o700);
    renameSync(source, target);
  }
}

/**
 * What an earlier, interrupted sweep already listed. A list that cannot be read must not hold the
 * daemon back for good: it is set aside, and the worktrees it named stay in `retained/` regardless.
 */
function readListedWorktrees(legacy: string): RetainedLegacyWorktree[] {
  try {
    return readRetainedList(legacy)?.worktrees ?? [];
  } catch (error) {
    const aside = uniqueChild(legacy, "retained.json.unreadable");
    log.warn(`Setting aside the unreadable ${legacyRetainedList(legacy)} as ${aside}: ${errorMessage(error)}`);
    renameSync(legacyRetainedList(legacy), aside);
    return [];
  }
}

function readGcMarker(workspaceDirectory: string): GcMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(workspaceDirectory, ".multiremi", "gc.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as GcMarker : null;
  } catch {
    return null;
  }
}

/** The Issue or Chat an old workspace belonged to. A discussion's work set belongs to its Issue's session, not to a workspace of the Issue. */
function subjectOf(marker: GcMarker | null): StorageSubjectRef | null {
  if (marker?.kind === "discussion_issue") return null;
  if (typeof marker?.chat_session_id === "string" && marker.chat_session_id) return { kind: "chat", id: marker.chat_session_id };
  if (typeof marker?.issue_id === "string" && marker.issue_id) return { kind: "issue", id: marker.issue_id };
  return null;
}

/** The old Issue workspace directory was named after the Issue key. */
function issueKeyOf(workspaceDirectory: string): string | null {
  try {
    const task: unknown = JSON.parse(readFileSync(join(workspaceDirectory, ".multiremi", "task.json"), "utf8"));
    const key = (task as { issue?: { key?: unknown } } | null)?.issue?.key;
    if (typeof key === "string" && key) return key;
  } catch {
    // Fall back to the directory name below.
  }
  return basename(workspaceDirectory);
}

/** Rename a rebuildable cache to its new home unless something already lives there. */
function moveCache(source: string, target: string): void {
  if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory() || existsSync(target)) return;
  renameSync(source, target);
}

/**
 * Move the bare repository cache to its new home. Where the new cache already
 * has a repository (a fresh clone made before the sweep ran), the old one is
 * kept in `.repos` for the leftover pass, but its snapshot refs are copied over
 * first: they are the only pointer a reclaimed record has to unsaved work.
 */
async function moveRepositories(source: string, target: string): Promise<void> {
  if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) return;
  if (!existsSync(target)) {
    renameSync(source, target);
    return;
  }
  for (const workspace of readdirSync(source, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const sourceWorkspace = join(source, workspace.name);
    const targetWorkspace = join(target, workspace.name);
    if (!existsSync(targetWorkspace)) {
      renameSync(sourceWorkspace, targetWorkspace);
      continue;
    }
    for (const repo of readdirSync(sourceWorkspace, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      const sourceRepo = join(sourceWorkspace, repo.name);
      const targetRepo = join(targetWorkspace, repo.name);
      if (!existsSync(targetRepo)) {
        renameSync(sourceRepo, targetRepo);
        continue;
      }
      await copyRefsIntoExisting(targetRepo, sourceRepo, "the old copy stays in the legacy directory");
    }
  }
}

/** The new cache already has this repository: the snapshot refs made in the old one are the only pointer a reclaimed record has. */
async function copyRefsIntoExisting(targetRepo: string, sourceRepo: string, where: string): Promise<void> {
  try {
    await copySnapshotRefs(targetRepo, sourceRepo);
    log.warn(`${targetRepo} already exists; ${where} and its snapshot refs were copied`);
  } catch (error) {
    log.warn(`${targetRepo} already exists and the snapshot refs of ${sourceRepo} could not be copied: ${errorMessage(error)}`);
  }
}

function uniqueChild(directory: string, name: string): string {
  let candidate = join(directory, name);
  for (let suffix = 1; existsSync(candidate); suffix++) candidate = join(directory, `${name}.${suffix}`);
  return candidate;
}

/**
 * After the move: drop the registrations of worktrees that were set aside, then
 * repair those of worktrees that stayed in place (Feishu topic workspaces), whose
 * `.git` file still names the cache's old path.
 */
async function maintainRepositories(reposRoot: string): Promise<void> {
  let workspaces;
  try {
    workspaces = readdirSync(reposRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    for (const repo of readdirSync(join(reposRoot, workspace.name), { withFileTypes: true })) {
      if (!repo.isDirectory() || !repo.name.endsWith(".git")) continue;
      const path = join(reposRoot, workspace.name, repo.name);
      try {
        await pruneWorktrees(path);
        await repairWorktrees(path);
      } catch (error) {
        log.warn(`Could not prune and repair worktrees of ${path}: ${errorMessage(error)}`);
      }
    }
  }
}

/** `.` for the directory itself, otherwise the path below it with `/` separators. */
function relativeTo(base: string, path: string): string {
  return relative(base, path).split(sep).join("/") || ".";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
