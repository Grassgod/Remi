/**
 * Git operations behind workspace reclaim and restore (ADR 0018, section 6).
 *
 * Every call is an asynchronous `git` child process with a deadline, so a hung
 * repository can never stall the daemon's event loop. There is no file-count or
 * pack-size limit: unsaved work is saved to a snapshot ref instead of keeping
 * the workspace forever. Which repositories to examine, and what to do about
 * each, is decided in `repo-inspection.ts`.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SubjectGitSnapshot } from "@multiremi/contracts/storage.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("multiremi-git-ops");

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
/** `status` over a large worktree with untracked files is the slowest call. */
const STATUS_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 2_000;
const SNAPSHOT_REF_ROOT = "refs/remi/snapshots";
const SNAPSHOT_AUTHOR = { name: "Remi", email: "remi@openremi.fun" };
/** The mode git records for a nested repository (a gitlink) instead of its content. */
const GITLINK_MODE = "160000";
/**
 * Variables that point git at a repository other than the one in its working
 * directory. A daemon started from a git hook or an agent's shell inherits them,
 * and every inspection would then judge that repository instead of the tree.
 */
const REPOSITORY_ENVIRONMENT: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
]);

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly kind: "failed" | "timeout",
    readonly stderr = "",
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** The worktree could not be examined reliably, so it must be kept. */
export class GitCheckFailedError extends Error {
  readonly code = "git_check_failed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitCheckFailedError";
  }
}

/** Unsaved work cannot be saved as a snapshot; the workspace must be kept. */
export class SnapshotFailedError extends Error {
  readonly code = "snapshot_failed";

  constructor(message: string) {
    super(message);
    this.name = "SnapshotFailedError";
  }
}

/** Unsaved work does not fit the snapshot budget. */
export class SnapshotTooLargeError extends SnapshotFailedError {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`unsaved work is ${bytes} bytes, above the ${maxBytes}-byte snapshot limit`);
    this.name = "SnapshotTooLargeError";
  }
}

/**
 * Unsaved work holds a repository nobody looked into (it lies below the depth the
 * search reaches). A snapshot would record it as a gitlink, a pointer to a commit
 * only that repository has, and drop its content.
 */
export class EmbeddedRepositoryError extends SnapshotFailedError {
  constructor(readonly paths: readonly string[]) {
    super(`unsaved work holds a repository that was not inspected, a snapshot would keep only a pointer to it: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""}`);
    this.name = "EmbeddedRepositoryError";
  }
}

export interface GitRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to the command's standard input. */
  input?: string;
  /** Treat these exit codes as success; the caller reads `exitCode`. */
  okExitCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run one git command. Rejects on a non-zero exit (unless allowed) and on timeout. */
export async function runGit(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  options.signal?.throwIfAborted();
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  const command = `git ${args.join(" ")}`;
  const child = spawn("git", [...args], {
    cwd: options.cwd,
    env: gitEnvironment(options.env),
    detached: process.platform !== "win32",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  return await new Promise<GitRunResult>((resolveRun, rejectRun) => {
    let terminal: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (error: Error) => {
      if (terminal) return;
      terminal = error;
      killTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      terminate(new GitCommandError(`${command} timed out after ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      const reason = options.signal?.reason;
      terminate(reason instanceof Error ? reason : new Error(`${command} aborted`));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanup();
      rejectRun(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (terminal) {
        rejectRun(terminal);
        return;
      }
      const result: GitRunResult = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1,
      };
      if (result.exitCode !== 0 && !options.okExitCodes?.includes(result.exitCode)) {
        const detail = result.stderr.trim() || result.stdout.trim();
        rejectRun(new GitCommandError(
          `${command} failed${detail ? `: ${detail}` : ""}`,
          "failed",
          result.stderr,
          result.exitCode,
        ));
        return;
      }
      resolveRun(result);
    });
  });
}

/** Trimmed stdout of a successful command. */
async function gitText(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
  return (await runGit(args, { ...options, cwd })).stdout.trim();
}

export interface UnsavedWork {
  /** Uncommitted changes or untracked (not ignored) files. */
  dirty: boolean;
  /** Commits that no remote-tracking branch contains. */
  unpushed: boolean;
}

/** Narrows what counts as the worktree's own content. */
export interface WorktreeScope {
  /**
   * Paths below the worktree that are neither checked nor snapshotted: the
   * daemon's own directories and the repositories nested in it, which are
   * examined on their own.
   */
  exclude?: readonly string[];
}

export interface InspectOptions {
  scope?: WorktreeScope;
  /**
   * Judge every ref of the repository, not only the checked-out commit. A
   * repository that is deleted together with its working tree loses its side
   * branches, tags and stashes too; a linked worktree's repository outlives it.
   */
  allRefs?: boolean;
  /** A bare repository has no working tree: only its commits are judged, and always all of its refs. */
  bare?: boolean;
  /**
   * Directories that are deleted together with the repository. A remote that lives
   * in one of them keeps nothing alive, so commits that only its remote-tracking
   * refs hold are unsaved work, as if the repository had no remote.
   */
  doomed?: readonly string[];
}

/** `-- . :(exclude,literal)<path>...`, or nothing for a plain worktree. */
function scopeArguments(scope: WorktreeScope | undefined): string[] {
  return scope?.exclude?.length ? ["--", ".", ...scope.exclude.map((path) => `:(exclude,literal)${path}`)] : [];
}

/**
 * Whether a repository holds anything a deletion would lose.
 *
 * Throws `GitCheckFailedError` when git cannot answer or a submodule that is not
 * examined on its own has local changes (its contents are outside what a
 * snapshot saves).
 */
export async function inspectUnsavedWork(worktree: string, options: InspectOptions = {}): Promise<UnsavedWork> {
  try {
    let dirty = false;
    if (!options.bare) {
      const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal", ...scopeArguments(options.scope)], {
        cwd: worktree,
        env: { GIT_OPTIONAL_LOCKS: "0" },
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      dirty = status.stdout.trim().length > 0;
      if (dirty && await hasGitmodules(worktree) && await hasDirtySubmodule(worktree, options.scope)) {
        throw new GitCheckFailedError(`submodule has local changes: ${worktree}`);
      }
    }
    return { dirty, unpushed: await hasUnpushedCommits(worktree, options) };
  } catch (error) {
    if (error instanceof GitCheckFailedError) throw error;
    throw new GitCheckFailedError(`cannot inspect ${worktree}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Commits no remote-tracking ref contains. With `allRefs` (and in a bare
 * repository) that is any commit of any ref: a repository without remotes and
 * with a commit has unpushed work. Otherwise it is the commits of HEAD; a
 * detached HEAD is named by no branch, so it is only at risk when no branch
 * reaches it either. A tag does not count: the repository cache prunes tags
 * that no remote has when it syncs.
 */
async function hasUnpushedCommits(worktree: string, options: InspectOptions): Promise<boolean> {
  if (options.allRefs || options.bare) {
    const surviving = await survivingRemotes(worktree, options.doomed);
    const remotes = surviving ? surviving.map((name) => `--remotes=${name}`) : ["--remotes"];
    return (await gitText(worktree, ["rev-list", "-n1", "--all", "--not", ...remotes])).length > 0;
  }
  const head = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: worktree, okExitCodes: [1] });
  if (head.exitCode !== 0) return false;
  const detached = (await runGit(["symbolic-ref", "-q", "HEAD"], { cwd: worktree, okExitCodes: [1] })).exitCode === 1;
  return (await gitText(worktree, ["rev-list", "-n1", "HEAD", "--not", "--remotes", ...(detached ? ["--branches"] : [])])).length > 0;
}

/**
 * The remotes whose remote-tracking refs prove a commit exists elsewhere, or null
 * when every remote does. A remote whose URL is a local path inside a directory
 * that is deleted with the repository is dropped: it dies with it.
 */
async function survivingRemotes(repository: string, doomed: readonly string[] | undefined): Promise<string[] | null> {
  if (!doomed?.length) return null;
  const configured = await runGit(["config", "--null", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"], {
    cwd: repository,
    okExitCodes: [1],
  });
  const urls = new Map<string, string[]>();
  for (const record of configured.stdout.split("\0")) {
    const newline = record.indexOf("\n");
    if (newline < 0) continue;
    const key = record.slice(0, newline);
    const name = key.slice("remote.".length, key.lastIndexOf("."));
    urls.set(name, [...(urls.get(name) ?? []), record.slice(newline + 1)]);
  }
  const roots = await Promise.all(doomed.map((directory) => realPathOrAncestor(directory)));
  const surviving: string[] = [];
  let dropped = false;
  for (const [name, remoteUrls] of urls) {
    const doomedRemote = (await Promise.all(remoteUrls.map(async (url) => {
      const local = localRemotePath(url, repository);
      if (!local) return false;
      const real = await realPathOrAncestor(local);
      return roots.some((root) => real === root || real.startsWith(`${root}${sep}`));
    }))).some(Boolean);
    if (doomedRemote) dropped = true;
    else surviving.push(name);
  }
  return dropped ? surviving : null;
}

/** The directory a remote URL names when it is a path on this machine; null for anything that is fetched over a network. */
function localRemotePath(url: string, base: string): string | null {
  let path = url;
  if (/^file:\/\//i.test(url)) {
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      return null;
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    return null;
  } else {
    // `host:path` is ssh unless the colon follows a Windows drive letter.
    const colon = url.indexOf(":");
    const slash = url.indexOf("/");
    const drive = process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(url);
    if (colon > 0 && (slash < 0 || colon < slash) && !drive) return null;
  }
  return isAbsolute(path) ? path : resolve(base, path);
}

/** realpath of a path that may not exist (anymore): the nearest existing ancestor is resolved and the rest appended. */
async function realPathOrAncestor(path: string): Promise<string> {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      if (dirname(current) === current) return resolve(path);
      missing.push(basename(current));
    }
  }
}

async function hasGitmodules(worktree: string): Promise<boolean> {
  return (await lstat(join(worktree, ".gitmodules")).catch(() => null))?.isFile() === true;
}

async function hasDirtySubmodule(worktree: string, scope: WorktreeScope | undefined): Promise<boolean> {
  const status = await runGit(["status", "--porcelain=v2", "-z", "--untracked-files=no", ...scopeArguments(scope)], {
    cwd: worktree,
    env: { GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  // `1 <XY> <sub> ...`: the sub field is `N...` for ordinary files and
  // `S<c><m><u>` for a submodule, where a letter marks new commits, modified
  // tracked content or untracked content.
  return status.stdout.split("\0").some((entry) => {
    const fields = entry.split(" ");
    return (fields[0] === "1" || fields[0] === "2" || fields[0] === "u")
      && /^S[.CMU]{3}$/.test(fields[2] ?? "") && fields[2] !== "S...";
  });
}

export interface SnapshotWorktreeInput {
  worktree: string;
  /** Ref path component(s) below `refs/remi/snapshots/`, normally the subject id. */
  subjectRef: string;
  /** Written into the snapshot; falls back to the repository's recorded URL. */
  repoUrl?: string;
  maxBytes: number;
  now?: Date;
  scope?: WorktreeScope;
}

/** A snapshot entry before it is told where its worktree stood (`dir`). */
export type WorktreeSnapshot = Omit<SubjectGitSnapshot, "dir">;

/**
 * Save a worktree's unsaved work as a commit above HEAD pinned by a ref in the
 * shared bare repository. Returns null when there is nothing to save. Only a
 * linked worktree can be saved this way; a standalone clone is deleted together
 * with the repository its ref would live in.
 *
 * Uncommitted and untracked files go through a temporary index, so the real
 * index and working tree are never touched. Unpushed commits need no new commit:
 * the ref keeps them (and every ancestor) reachable after the worktree is gone.
 */
export async function snapshotWorktree(input: SnapshotWorktreeInput): Promise<WorktreeSnapshot | null> {
  const unsaved = await inspectUnsavedWork(input.worktree, { scope: input.scope });
  if (!unsaved.dirty && !unsaved.unpushed) return null;
  const head = await gitText(input.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const branch = (await runGit(["symbolic-ref", "--short", "-q", "HEAD"], {
    cwd: input.worktree,
    okExitCodes: [1],
  })).stdout.trim() || null;

  let commit = head;
  if (unsaved.dirty) {
    await assertSnapshotFits(input.worktree, input.maxBytes, input.scope);
    commit = await commitWorkingTree(input, head);
  }
  const ref = await createSnapshotRef(input.worktree, input.subjectRef, commit);
  return {
    repo_url: input.repoUrl ?? await recordedRepositoryUrl(input.worktree),
    ref,
    commit,
    head,
    branch,
  };
}

/**
 * Check that the unsaved work of a worktree can be saved: the changed and
 * untracked files fit the budget (their sizes are summed, stopping as soon as it
 * is exceeded), and none of them is a repository nobody looked into. git lists
 * such a repository as one untracked directory, and a snapshot would record only
 * a pointer to it.
 */
export async function assertSnapshotFits(worktree: string, maxBytes: number, scope?: WorktreeScope): Promise<void> {
  const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", ...scopeArguments(scope)], {
    cwd: worktree,
    env: { GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  let bytes = 0;
  const embedded: string[] = [];
  const entries = status.stdout.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy lists its source path as the following NUL field.
    if (code[0] === "R" || code[0] === "C") index++;
    if (code === "??" && path.endsWith("/")) {
      embedded.push(path.slice(0, -1));
      continue;
    }
    if (code.includes("D") && !code.includes("?")) continue;
    const info = await lstat(join(worktree, path)).catch(() => null);
    if (info?.isFile()) bytes += info.size;
    if (bytes > maxBytes) throw new SnapshotTooLargeError(bytes, maxBytes);
  }
  if (embedded.length) throw new EmbeddedRepositoryError(embedded.map((path) => join(worktree, path)));
}

/**
 * The paths the index holds as a gitlink that HEAD does not. `git add` turns any
 * directory with a `.git` into one, whatever it contains, so nothing of the
 * repository would be in the snapshot.
 */
async function gainedGitlinks(worktree: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const diff = await runGit(["diff-index", "--cached", "--raw", "-z", "--no-renames", "HEAD"], { cwd: worktree, env });
  const fields = diff.stdout.split("\0");
  const paths: string[] = [];
  // `:<old mode> <new mode> <old oid> <new oid> <status>` followed by the path.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode] = fields[index]!.replace(/^:/, "").split(" ");
    if (newMode === GITLINK_MODE && oldMode !== GITLINK_MODE) paths.push(join(worktree, fields[index + 1]!));
  }
  return paths;
}

async function commitWorkingTree(input: SnapshotWorktreeInput, head: string): Promise<string> {
  const gitDirectory = resolve(input.worktree, await gitText(input.worktree, ["rev-parse", "--git-dir"]));
  const indexFile = join(gitDirectory, `remi-snapshot-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runGit(["read-tree", "HEAD"], { cwd: input.worktree, env });
    await runGit(["add", "-A", ...scopeArguments(input.scope)], { cwd: input.worktree, env, timeoutMs: STATUS_TIMEOUT_MS });
    const gitlinks = await gainedGitlinks(input.worktree, env);
    if (gitlinks.length) throw new EmbeddedRepositoryError(gitlinks);
    const tree = await gitText(input.worktree, ["write-tree"], { env });
    if (tree === await gitText(input.worktree, ["rev-parse", "--verify", "HEAD^{tree}"])) return head;
    const moment = (input.now ?? new Date()).toISOString();
    return await gitText(input.worktree, [
      "commit-tree", tree, "-p", head, "-m", `remi snapshot ${input.subjectRef} ${moment}`,
    ], {
      env: {
        GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR.name,
        GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR.email,
        GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR.name,
        GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR.email,
      },
    });
  } finally {
    await rm(indexFile, { force: true });
  }
}

/** `refs/remi/snapshots/<subject>/<n>` with n one above the highest existing; retried on a race. */
async function createSnapshotRef(worktree: string, subjectRef: string, commit: string): Promise<string> {
  const prefix = `${SNAPSHOT_REF_ROOT}/${snapshotRefSubject(subjectRef)}`;
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = (await gitText(worktree, ["for-each-ref", "--format=%(refname)", `${prefix}/`]))
      .split("\n")
      .map((name) => Number(name.slice(prefix.length + 1)))
      .filter((n) => Number.isInteger(n) && n > 0);
    const ref = `${prefix}/${Math.max(0, ...existing) + 1}`;
    // `create` fails when another writer took the number meanwhile.
    const result = await runGit(["update-ref", "--stdin"], {
      cwd: worktree,
      input: `create ${ref} ${commit}\n`,
      okExitCodes: [128],
    });
    if (result.exitCode === 0) return ref;
    lastError = result.stderr.trim();
  }
  throw new GitCommandError(`could not allocate a snapshot ref below ${prefix}: ${lastError}`, "failed");
}

function snapshotRefSubject(subjectRef: string): string {
  const parts = subjectRef.split("/").map((part) => part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, ""));
  if (!parts.length || parts.some((part) => !part)) throw new Error(`invalid snapshot subject: ${subjectRef}`);
  return parts.join("/");
}

async function recordedRepositoryUrl(worktree: string): Promise<string> {
  for (const key of ["multiremi.repository-url", "remote.origin.url"]) {
    const result = await runGit(["config", "--get", key], { cwd: worktree, okExitCodes: [1] });
    if (result.stdout.trim()) return result.stdout.trim();
  }
  return "";
}

export type SnapshotRestoreStatus = "restored" | "diverged" | "missing" | "dirty" | "other_branch";

export interface SnapshotRestoreResult {
  status: SnapshotRestoreStatus;
  ref: string;
}

/**
 * Put a snapshot back into a freshly checked-out worktree.
 *
 * Only a worktree that is still behind the snapshot is touched: it is
 * fast-forwarded to the snapshot's HEAD and the snapshot's tree is brought back
 * as uncommitted changes. A worktree that diverged is left alone, with the ref
 * kept for manual recovery. A worktree of any repository but the one that holds
 * the snapshot's ref takes nothing, and neither does one on another branch than
 * the snapshot was taken on (fast-forwarding it would move that branch onto work
 * that was never made there), unless it is detached at the snapshot's HEAD.
 */
export async function restoreSnapshot(worktree: string, snapshot: WorktreeSnapshot): Promise<SnapshotRestoreResult> {
  const result = (status: SnapshotRestoreStatus): SnapshotRestoreResult => ({ status, ref: snapshot.ref });
  const saved = await runGit(["rev-parse", "--verify", "-q", `${snapshot.ref}^{commit}`], { cwd: worktree, okExitCodes: [1] });
  if (saved.stdout.trim() !== snapshot.commit) return result("missing");
  for (const oid of new Set([snapshot.head, snapshot.commit])) {
    const exists = await runGit(["cat-file", "-e", `${oid}^{commit}`], { cwd: worktree, okExitCodes: [1, 128] });
    if (exists.exitCode !== 0) return result("missing");
  }
  if (snapshot.branch) {
    const branch = (await runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: worktree, okExitCodes: [1] })).stdout.trim();
    const onBranch = branch ? branch === snapshot.branch : await gitText(worktree, ["rev-parse", "HEAD"]) === snapshot.head;
    if (!onBranch) return result("other_branch");
  }
  const current = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: worktree,
    env: { GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (current.stdout.trim()) return result("dirty");
  const ancestor = await runGit(["merge-base", "--is-ancestor", "HEAD", snapshot.head], {
    cwd: worktree,
    okExitCodes: [1],
  });
  if (ancestor.exitCode !== 0) {
    log.warn(`snapshot_restore_diverged: ${worktree} kept as is; snapshot stays at ${snapshot.ref}`);
    return result("diverged");
  }
  await runGit(["reset", "--hard", snapshot.head], { cwd: worktree });
  if (snapshot.commit !== snapshot.head) {
    await runGit(["read-tree", "-u", "--reset", snapshot.commit], { cwd: worktree });
    await runGit(["reset", snapshot.head], { cwd: worktree });
  }
  return result("restored");
}

/** The shared repository a worktree belongs to (its common git directory). */
export async function commonGitDirectory(worktree: string): Promise<string> {
  const output = await gitText(worktree, ["rev-parse", "--git-common-dir"]);
  return isAbsolute(output) ? output : resolve(worktree, output);
}

/** Drop registrations whose directory is gone. */
export async function pruneWorktrees(gitDirectory: string): Promise<void> {
  await runGit(["--git-dir", gitDirectory, "worktree", "prune"]);
}

/**
 * Point the linked worktrees of a repository back at it after the repository
 * moved. Run inside the repository; a worktree whose directory is gone is left
 * for `pruneWorktrees`. Worktrees that moved themselves are found by naming
 * their new `paths`.
 */
export async function repairWorktrees(gitDirectory: string, paths: readonly string[] = []): Promise<void> {
  await runGit(["worktree", "repair", ...paths], { cwd: gitDirectory });
}

/**
 * Copy the snapshot refs of `source` into `target`, for a repository that now
 * exists in two places. Fetching them brings the snapshot objects along.
 */
export async function copySnapshotRefs(target: string, source: string): Promise<void> {
  await runGit(["--git-dir", target, "fetch", "--no-tags", source, `${SNAPSHOT_REF_ROOT}/*:${SNAPSHOT_REF_ROOT}/*`], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
}

/** True when `directory` is a linked git worktree (it holds a `.git` file). */
export async function isLinkedWorktree(directory: string): Promise<boolean> {
  const info = await lstat(join(directory, ".git")).catch(() => null);
  return info?.isFile() === true;
}

/**
 * `env` without the variables that name a repository (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, ...). A caller that wants one sets it explicitly afterwards,
 * like the temporary index of a snapshot.
 */
export function withoutRepositoryEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  // The names are case-insensitive on Windows.
  for (const [key, value] of Object.entries(env)) {
    if (!REPOSITORY_ENVIRONMENT.has(key.toUpperCase())) clean[key] = value;
  }
  return clean;
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...withoutRepositoryEnvironment(process.env), ...extra, GIT_TERMINAL_PROMPT: "0" };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isFinite(existing) && existing >= 0 ? existing : 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${index}`] = "*";
  return env;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // The process may have exited between the deadline and the signal.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
