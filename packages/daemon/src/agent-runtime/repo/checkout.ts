import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, appendFileSync, chmodSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { RepoSpec } from "@daemon/contracts/types.js";

export type { RepoSpec } from "@daemon/contracts/types.js";
// Back-compat alias for existing `MultiremiRepoData` importers (e.g. worker/daemon.ts).
export type MultiremiRepoData = RepoSpec;

export interface MultiremiWorktreeParams {
  workspaceId: string;
  repoUrl: string;
  workDir: string;
  ref?: string;
  agentName?: string;
  taskId?: string;
  /** Stable branch for Issue workspaces, for example agent/MUL-28. */
  branchName?: string;
  coAuthoredByEnabled?: boolean;
  // Leave an existing worktree untouched (no reset/clean/checkout) and return
  // its current branch. Used by the daemon's pre-flight auto-checkout so a
  // resumed task never wipes uncommitted work; the CLI keeps the default
  // destructive-reset semantics (an agent asking again wants a clean tree).
  reuseExisting?: boolean;
}

export interface MultiremiWorktreeResult {
  path: string;
  branch_name: string;
  branchName: string;
  /** false when reuseExisting found the worktree already in place. */
  created: boolean;
  base_ref: string;
  baseRef: string;
}

export interface MultiremiSnapshotParams {
  workspaceId: string;
  repoUrl: string;
  snapshotsRoot: string;
  ref?: string;
}

export interface MultiremiSnapshotResult {
  path: string;
  commit: string;
  baseRef: string;
  created: boolean;
}

export interface MultiremiRepoCacheOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface MultiremiWorktreeState {
  dirty: boolean;
  hasChanges: boolean;
  hasUnpushedCommits: boolean;
}

const AGENT_GIT_EXCLUDE_PATTERNS = [".agent_context", ".multiremi", "CLAUDE.md", "AGENTS.md", ".claude", ".opencode"];
const MODERN_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const MIRRORED_TAG_FETCH_REFSPEC = "+refs/tags/*:refs/tags/*";
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_STALE_LOCK_MS = 60 * 60_000;
const RESERVED_ISSUE_WORKSPACE_DIRECTORIES = new Set(["wiki", ".multiremi"]);
const MULTIREMI_HOOK_MARKER = "# multiremi:prepare-commit-msg:co-authored-by";
const LEGACY_DAEMON_HOOK_SIGNATURES = [
  "# multimira:prepare-commit-msg:co-authored-by",
  "# Installed by the Multimira daemon.",
];
const DAEMON_INSTALLED_HOOK_SIGNATURES = [
  MULTIREMI_HOOK_MARKER,
  "# Installed by the Multiremi daemon.",
  ...LEGACY_DAEMON_HOOK_SIGNATURES,
];
const PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh
# multiremi:prepare-commit-msg:co-authored-by
# Multiremi: add Co-authored-by trailer for the Multiremi Agent.
# Installed by the Multiremi daemon. Do not edit - it will be overwritten.

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Skip merge and squash commits.
case "$COMMIT_SOURCE" in
  merge|squash) exit 0 ;;
esac

TRAILER="Co-authored-by: multiremi-agent <github@multiremi.ai>"

# Don't add if already present.
if grep -qF "$TRAILER" "$COMMIT_MSG_FILE"; then
  exit 0
fi

# Use git interpret-trailers for proper formatting.
git interpret-trailers --in-place --trailer "$TRAILER" "$COMMIT_MSG_FILE"
`;

export class MultiremiRepoCache {
  constructor(private root: string, private options: MultiremiRepoCacheOptions = {}) {}

  sync(workspaceId: string, repos: MultiremiRepoData[]): void {
    const workspaceRoot = join(this.root, safePathPart(workspaceId));
    mkdirSync(workspaceRoot, { recursive: true });
    for (const repo of repos) {
      const url = repo.url.trim();
      if (!url) continue;
      const barePath = this.barePath(workspaceId, url);
      this.withRepoLock(barePath, () => {
        if (isBareRepo(barePath)) {
          gitFetch(barePath, { allowFailure: true });
        } else {
          mkdirSync(workspaceRoot, { recursive: true });
          try {
            git(null, ["clone", "--bare", url, barePath]);
            gitFetch(barePath);
          } catch (err) {
            rmSync(barePath, { recursive: true, force: true });
            throw err;
          }
        }
      });
    }
  }

  lookup(workspaceId: string, repoUrl: string): string | null {
    const barePath = this.barePath(workspaceId, repoUrl);
    return isBareRepo(barePath) ? barePath : null;
  }

  createWorktree(params: MultiremiWorktreeParams): MultiremiWorktreeResult {
    const barePath = this.barePath(params.workspaceId, params.repoUrl);
    if (!isBareRepo(barePath)) {
      throw new Error(`repo not found in cache: ${params.repoUrl} (workspace: ${params.workspaceId})`);
    }

    return this.withRepoLock(barePath, () => this.createWorktreeLocked(barePath, params));
  }

  createSnapshot(params: MultiremiSnapshotParams): MultiremiSnapshotResult {
    const barePath = this.barePath(params.workspaceId, params.repoUrl);
    if (!isBareRepo(barePath)) {
      throw new Error(`repo not found in cache: ${params.repoUrl} (workspace: ${params.workspaceId})`);
    }
    return this.withRepoLock(barePath, () => {
      // Intake workspaces promise a fresh view for every round. A failed fetch
      // must fail preparation instead of silently presenting an old commit as
      // current.
      gitFetch(barePath);
      const baseRef = resolveBaseRef(barePath, params.ref);
      const commit = git(barePath, ["rev-parse", `${baseRef}^{commit}`]);
      const repoRoot = join(
        params.snapshotsRoot,
        safePathPart(params.workspaceId),
        bareDirName(params.repoUrl),
      );
      const snapshotPath = join(repoRoot, commit);
      if (existsSync(snapshotPath)) {
        return { path: snapshotPath, commit, baseRef, created: false };
      }

      mkdirSync(repoRoot, { recursive: true });
      const temporaryPath = join(repoRoot, `.${commit}.tmp-${process.pid}-${Date.now()}`);
      mkdirSync(temporaryPath, { recursive: true });
      try {
        const archive = spawnSync("git", ["--git-dir", barePath, "archive", "--format=tar", commit], {
          encoding: null,
          env: gitEnv(),
          maxBuffer: 1024 * 1024 * 1024,
        });
        if (archive.status !== 0 || !archive.stdout) {
          const error = String(archive.stderr ?? "").trim();
          throw new Error(`git archive failed${error ? `: ${error}` : ""}`);
        }
        const extracted = spawnSync("tar", ["-xf", "-", "-C", temporaryPath], {
          input: archive.stdout,
          encoding: null,
          maxBuffer: 1024 * 1024 * 1024,
        });
        if (extracted.status !== 0) {
          const error = String(extracted.stderr ?? "").trim();
          throw new Error(`snapshot extraction failed${error ? `: ${error}` : ""}`);
        }
        makeTreeReadOnly(temporaryPath);
        renameSync(temporaryPath, snapshotPath);
      } catch (error) {
        rmSync(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return { path: snapshotPath, commit, baseRef, created: true };
    });
  }

  inspectWorktree(worktreePath: string): MultiremiWorktreeState {
    if (!isGitWorktree(worktreePath)) throw new Error(`not a git worktree: ${worktreePath}`);
    const hasChanges = Boolean(git(worktreePath, ["status", "--porcelain"]));
    const hasUnpushedCommits = !Boolean(git(worktreePath, ["branch", "-r", "--contains", "HEAD"], { allowFailure: true }));
    return { dirty: hasChanges || hasUnpushedCommits, hasChanges, hasUnpushedCommits };
  }

  private createWorktreeLocked(barePath: string, params: MultiremiWorktreeParams): MultiremiWorktreeResult {
    const worktreePath = join(params.workDir, worktreeDirectoryName(params.repoUrl));
    const legacyWorktreePath = join(params.workDir, repoNameFromUrl(params.repoUrl));
    if (
      legacyWorktreePath !== worktreePath
      && !existsSync(worktreePath)
      && existsSync(legacyWorktreePath)
      && isGitWorktree(legacyWorktreePath)
    ) {
      git(barePath, ["worktree", "move", legacyWorktreePath, worktreePath]);
    }
    const requestedBranch = params.branchName?.trim() || null;
    if (params.reuseExisting && existsSync(worktreePath) && isGitWorktree(worktreePath)) {
      const currentBranch = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (requestedBranch && currentBranch !== requestedBranch) {
        throw new Error(`worktree ${worktreePath} is on ${currentBranch}, expected ${requestedBranch}; refusing to switch a persistent workspace`);
      }
      const baseRef = resolveBaseRef(barePath, params.ref);
      return { path: worktreePath, branch_name: currentBranch, branchName: currentBranch, created: false, base_ref: baseRef, baseRef };
    }

    gitFetch(barePath, { allowFailure: true });

    const baseRef = resolveBaseRef(barePath, params.ref);
    const branchName = requestedBranch ?? `agent/${sanitizeName(params.agentName ?? "agent")}/${shortId(params.taskId ?? "task")}`;

    if (existsSync(worktreePath)) {
      if (!isGitWorktree(worktreePath)) {
        throw new Error(`worktree path already exists and is not a git worktree: ${worktreePath}`);
      }
      const currentBranch = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (requestedBranch && currentBranch !== requestedBranch) {
        throw new Error(`worktree ${worktreePath} is on ${currentBranch}, expected ${requestedBranch}; refusing to switch a persistent workspace`);
      }
      excludeAgentFiles(worktreePath);
      applyCoAuthoredByHook(worktreePath, params.coAuthoredByEnabled !== false);
      return { path: worktreePath, branch_name: currentBranch, branchName: currentBranch, created: false, base_ref: baseRef, baseRef };
    }

    mkdirSync(params.workDir, { recursive: true });
    // A workspace GC may remove the worktree directory while the bare repo still
    // retains its registration. Prune only this repository immediately before
    // adding its next worktree instead of sweeping every cached repo on each GC.
    git(barePath, ["worktree", "prune"], { allowFailure: true });
    if (gitRefExists(barePath, `refs/heads/${branchName}`)) {
      git(barePath, ["worktree", "add", worktreePath, branchName]);
    } else if (gitRefExists(barePath, `refs/remotes/origin/${branchName}`)) {
      git(barePath, ["worktree", "add", "-b", branchName, worktreePath, `origin/${branchName}`]);
    } else {
      git(barePath, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
    }
    excludeAgentFiles(worktreePath);
    applyCoAuthoredByHook(worktreePath, params.coAuthoredByEnabled !== false);
    return { path: worktreePath, branch_name: branchName, branchName, created: true, base_ref: baseRef, baseRef };
  }

  private barePath(workspaceId: string, repoUrl: string): string {
    return join(this.root, safePathPart(workspaceId), bareDirName(repoUrl));
  }

  private withRepoLock<T>(barePath: string, fn: () => T): T {
    const release = acquireRepoCacheLock(
      barePath,
      this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    );
    try {
      return fn();
    } finally {
      release();
    }
  }
}

export function normalizeRepoList(rawRepos: unknown[]): MultiremiRepoData[] {
  const repos: MultiremiRepoData[] = [];
  const seen = new Set<string>();
  for (const raw of rawRepos) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const description = typeof record.description === "string" ? record.description : "";
    repos.push(description ? { url, description } : { url });
  }
  return repos;
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function makeTreeReadOnly(root: string): void {
  for (const entry of safeReadDir(root)) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      makeTreeReadOnly(path);
      chmodSync(path, 0o555);
    } else {
      chmodSync(path, 0o444);
    }
  }
  chmodSync(root, 0o555);
}

function git(cwd: string | null, args: string[], options: { allowFailure?: boolean } = {}): string {
  const result = spawnSync("git", args, {
    cwd: cwd ?? undefined,
    encoding: "utf8",
    env: gitEnv(),
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function gitFetch(barePath: string, options: { allowFailure?: boolean } = {}): void {
  try {
    ensureRemoteTrackingLayout(barePath);
    git(barePath, [
      "fetch",
      "--prune",
      "--prune-tags",
      "origin",
      MODERN_FETCH_REFSPEC,
      MIRRORED_TAG_FETCH_REFSPEC,
    ], { allowFailure: options.allowFailure });
    git(barePath, ["remote", "set-head", "origin", "--auto"], { allowFailure: true });
  } catch (err) {
    if (!options.allowFailure) throw err;
  }
}

function ensureRemoteTrackingLayout(barePath: string): void {
  const current = git(barePath, ["config", "--get", "remote.origin.fetch"], { allowFailure: true }).trim();
  if (current === MODERN_FETCH_REFSPEC || current === MODERN_FETCH_REFSPEC.slice(1)) return;
  git(barePath, ["config", "remote.origin.fetch", MODERN_FETCH_REFSPEC]);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isFinite(existing) && existing >= 0 ? existing : 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${index}`] = "*";
  return env;
}

function isBareRepo(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return git(path, ["rev-parse", "--is-bare-repository"]) === "true";
  } catch {
    return false;
  }
}

function isGitWorktree(path: string): boolean {
  try {
    const info = statSync(join(path, ".git"));
    return !info.isDirectory();
  } catch {
    return false;
  }
}

function resolveBaseRef(barePath: string, requestedRef?: string): string {
  const ref = requestedRef?.trim();
  if (ref) {
    const candidates = [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref];
    for (const candidate of candidates) {
      if (gitRefExists(barePath, `${candidate}^{commit}`)) return candidate;
    }
    throw new Error(`cannot resolve requested ref ${JSON.stringify(ref)} in repo cache at ${barePath}`);
  }

  const originHead = git(barePath, ["symbolic-ref", "refs/remotes/origin/HEAD"], { allowFailure: true });
  if (originHead && gitRefExists(barePath, originHead)) return originHead;
  for (const candidate of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if (gitRefExists(barePath, candidate)) return candidate;
  }
  const bareHead = git(barePath, ["symbolic-ref", "HEAD"], { allowFailure: true });
  if (bareHead) {
    const originRef = `refs/remotes/origin/${bareHead.replace(/^refs\/heads\//, "")}`;
    if (gitRefExists(barePath, originRef)) return originRef;
    if (gitRefExists(barePath, bareHead)) return bareHead;
  }
  const originRefs = listOriginBranchRefs(barePath);
  if (originRefs.length === 1) return originRefs[0]!;
  if (!originRefs.length && gitRefExists(barePath, "HEAD")) return "HEAD";
  throw new Error(`cannot resolve default branch for repo cache at ${barePath}: origin/* is empty or ambiguous and bare HEAD has no match`);
}

function gitRefExists(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function listOriginBranchRefs(repoPath: string): string[] {
  const output = git(repoPath, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"], { allowFailure: true });
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((ref) => ref && ref !== "refs/remotes/origin/HEAD")
    .sort();
}

export function multiremiRepoCacheLockPath(barePath: string): string {
  return `${barePath}.multiremi.lock`;
}

function acquireRepoCacheLock(barePath: string, timeoutMs: number, staleLockMs: number): () => void {
  const lockPath = multiremiRepoCacheLockPath(barePath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "holder.json"), JSON.stringify({
        pid: process.pid,
        bare_path: barePath,
        acquired_at: new Date().toISOString(),
      }, null, 2));
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (err) {
      if (!isPathAlreadyExistsError(err)) throw err;
      if (isStaleRepoCacheLock(lockPath, staleLockMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for repo cache lock: ${barePath}`);
      }
      sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
}

function isStaleRepoCacheLock(lockPath: string, staleLockMs: number): boolean {
  if (repoCacheLockOwnerExited(lockPath)) return true;
  if (staleLockMs <= 0) return false;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
}

function repoCacheLockOwnerExited(lockPath: string): boolean {
  try {
    const holder = JSON.parse(readFileSync(join(lockPath, "holder.json"), "utf8")) as { pid?: unknown };
    const pid = holder.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
    try {
      process.kill(Number(pid), 0);
      return false;
    } catch (error) {
      // EPERM means the process exists but is owned by another user. Unknown
      // errors are also kept conservative; only ESRCH proves the owner exited.
      return Boolean(
        error
        && typeof error === "object"
        && "code" in error
        && (error as { code?: unknown }).code === "ESRCH"
      );
    }
  } catch {
    // A missing, partially written, or legacy holder remains governed by the
    // age-based fallback rather than risking removal of a live lock.
    return false;
  }
}

function isPathAlreadyExistsError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "EEXIST");
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function bareDirName(repoUrl: string): string {
  const digest = createHash("sha256").update(repoUrl.trim()).digest("hex").slice(0, 16);
  return `${repoNameFromUrl(repoUrl)}-${digest}.git`;
}

function repoNameFromUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\/+$/, "");
  const withoutGit = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
  const rawName = basename(withoutGit.replace(/[:\\]/g, "/")) || "repo";
  return safePathPart(rawName.replace(/\.git$/, "")) || "repo";
}

function worktreeDirectoryName(repoUrl: string): string {
  const name = repoNameFromUrl(repoUrl);
  if (!RESERVED_ISSUE_WORKSPACE_DIRECTORIES.has(name.toLowerCase())) return name;
  const digest = createHash("sha256").update(repoUrl.trim()).digest("hex").slice(0, 8);
  return `${name}-repo-${digest}`;
}

function safePathPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function sanitizeName(value: string): string {
  return safePathPart(value).toLowerCase();
}

function shortId(value: string): string {
  const normalized = safePathPart(value);
  return normalized.length > 12 ? normalized.slice(0, 12) : normalized;
}

function excludeAgentFiles(worktreePath: string): void {
  const gitDir = git(worktreePath, ["rev-parse", "--git-dir"]);
  const excludePath = join(gitDir.startsWith("/") ? gitDir : join(worktreePath, gitDir), "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const additions = AGENT_GIT_EXCLUDE_PATTERNS.filter((pattern) => !existing.split(/\r?\n/).includes(pattern));
  if (additions.length) appendFileSync(excludePath, `${additions.join("\n")}\n`);
}

function applyCoAuthoredByHook(worktreePath: string, enabled: boolean): void {
  try {
    if (enabled) installCoAuthoredByHook(worktreePath);
    else removeCoAuthoredByHook(worktreePath);
  } catch {
    // Go treats hook install/remove failures as non-fatal to checkout.
  }
}

function installCoAuthoredByHook(worktreePath: string): void {
  const hookPath = prepareCommitMsgHookPath(worktreePath);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, PREPARE_COMMIT_MSG_HOOK, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
}

function removeCoAuthoredByHook(worktreePath: string): void {
  const hookPath = prepareCommitMsgHookPath(worktreePath);
  if (!existsSync(hookPath)) return;
  const content = readFileSync(hookPath, "utf8");
  if (!isDaemonInstalledHook(content)) return;
  rmSync(hookPath, { force: true });
}

function prepareCommitMsgHookPath(worktreePath: string): string {
  const commonDir = git(worktreePath, ["rev-parse", "--git-common-dir"]);
  const resolvedCommonDir = isAbsolute(commonDir) ? commonDir : join(worktreePath, commonDir);
  return join(resolvedCommonDir, "hooks", "prepare-commit-msg");
}

function isDaemonInstalledHook(content: string): boolean {
  return DAEMON_INSTALLED_HOOK_SIGNATURES.some((signature) => content.includes(signature));
}
