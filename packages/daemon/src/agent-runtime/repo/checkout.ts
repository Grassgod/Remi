import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, appendFileSync, chmodSync, copyFileSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { RepoSpec } from "@daemon/contracts/types.js";
import { createLogger } from "@shared/logger.js";
import {
  appendGitCredentialBrokerEnv,
  preferredHttpsCloneUrl,
  redactGitCredentialError,
  type GitCredentialBrokerEnvOptions,
} from "./credential-broker.js";

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
  /** The caller already refreshed this repo in the same preparation flow. */
  skipFetch?: boolean;
  signal?: AbortSignal;
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
  /** The caller already refreshed this repo in the same preparation flow. */
  skipFetch?: boolean;
  signal?: AbortSignal;
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
  /** Injectable so tests can exercise fetch retries without real delays. */
  fetchRetryDelaysMs?: readonly number[];
  fetchTimeoutMs?: number;
  cloneTimeoutMs?: number;
  repoSyncTimeoutMs?: number;
  processKillGraceMs?: number;
  credentialBroker?: Omit<
    GitCredentialBrokerEnvOptions,
    "workspaceId" | "taskId" | "repositoryUrl" | "repositoryUrls"
  >;
}

export interface MultiremiRepoSyncResult {
  repoUrl: string;
  status: "fresh" | "cached" | "failed";
  error: string | null;
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
const DEFAULT_FETCH_RETRY_DELAYS_MS = [1_000, 3_000] as const;
// Large active repos (10GB+, thousands of refs) need well over 30s to catch up
// after falling behind; a killed fetch discards all transfer progress, so a
// too-small budget turns one slow window into a permanent sync death spiral.
const DEFAULT_FETCH_TIMEOUT_MS = 150_000;
const DEFAULT_CLONE_TIMEOUT_MS = 600_000;
const DEFAULT_REPO_SYNC_TIMEOUT_MS = 300_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 2_000;
const DEFAULT_GIT_SSH_COMMAND = [
  "ssh",
  "-o BatchMode=yes",
  "-o ConnectTimeout=10",
  "-o ServerAliveInterval=15",
  "-o ServerAliveCountMax=3",
].join(" ");
const RESERVED_ISSUE_WORKSPACE_DIRECTORIES = new Set(["wiki", ".multiremi"]);
const MULTIREMI_HOOK_MARKER = "# multiremi:prepare-commit-msg:co-authored-by";
const MULTIREMI_CHAINED_HOOK_MARKER = "# multiremi:chained-hook-suffix=";
const LEGACY_DAEMON_HOOK_SIGNATURES = [
  "# multimira:prepare-commit-msg:co-authored-by",
  "# Installed by the Multimira daemon.",
];
const PREPARE_COMMIT_MSG_HOOK_BODY = `#!/bin/sh
# multiremi:prepare-commit-msg:co-authored-by
# Multiremi: attribute commits to Remi.
# Installed by the Multiremi daemon. Do not edit - it will be overwritten.

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Skip merge and squash commits.
case "$COMMIT_SOURCE" in
  merge|squash) exit 0 ;;
esac

TRAILER="Co-authored-by: Remi <remi@openremi.fun>"

# Don't add if already present.
if grep -qF "$TRAILER" "$COMMIT_MSG_FILE"; then
  exit 0
fi

# Use git interpret-trailers for proper formatting.
git interpret-trailers --in-place --trailer "$TRAILER" "$COMMIT_MSG_FILE"
`;

const log = createLogger("multiremi-repo-cache");

export class MultiremiRepoCache {
  constructor(private root: string, private options: MultiremiRepoCacheOptions = {}) {}

  async sync(
    workspaceId: string,
    repos: MultiremiRepoData[],
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiremiRepoSyncResult[]> {
    const workspaceRoot = join(this.root, safePathPart(workspaceId));
    mkdirSync(workspaceRoot, { recursive: true });
    const results: MultiremiRepoSyncResult[] = [];
    for (const repo of repos) {
      const url = repo.url.trim();
      if (!url) continue;
      const barePath = this.barePath(workspaceId, url);
      const scope = repoSyncAbortScope(
        options.signal,
        repoSyncBudgetMs(this.options, isBareRepo(barePath)),
        url,
      );
      try {
        const result = await this.withRepoLock(barePath, async () => {
          const gitAuth = this.gitAuth(workspaceId, url);
          const cloneUrl = this.cloneUrl(url);
          if (isBareRepo(barePath)) {
            let lastError: unknown = null;
            if (cloneUrl !== url) {
              try {
                await this.fetch(barePath, { remote: cloneUrl, env: gitAuth, signal: scope.signal });
                configureRepoTransport(barePath, url, cloneUrl);
                return repoSyncResult(url, "fresh");
              } catch (error) {
                scope.signal.throwIfAborted();
                lastError = error;
              }
            }
            try {
              configureRepoTransport(barePath, url, url);
              await this.fetch(barePath, { env: gitAuth, signal: scope.signal });
              return repoSyncResult(url, "fresh");
            } catch (error) {
              scope.signal.throwIfAborted();
              lastError = error;
            }
            if (gitAuth) {
              try {
                await this.fetch(barePath, { signal: scope.signal });
                return repoSyncResult(url, "fresh");
              } catch (error) {
                scope.signal.throwIfAborted();
                lastError = error;
              }
            }
            return repoSyncResult(url, "cached", lastError);
          }

          mkdirSync(workspaceRoot, { recursive: true });
          let selectedUrl = cloneUrl;
          let selectedEnv = gitAuth;
          try {
            await this.clone(cloneUrl, barePath, { env: gitAuth, signal: scope.signal });
          } catch (preferredError) {
            rmSync(barePath, { recursive: true, force: true });
            scope.signal.throwIfAborted();
            if (cloneUrl === url) throw preferredError;
            await this.clone(url, barePath, { signal: scope.signal });
            selectedUrl = url;
            selectedEnv = undefined;
          }
          configureRepoTransport(barePath, url, selectedUrl);
          try {
            await this.fetch(barePath, { env: selectedEnv, signal: scope.signal });
            return repoSyncResult(url, "fresh");
          } catch (error) {
            scope.signal.throwIfAborted();
            return repoSyncResult(url, "cached", error);
          }
        }, scope.signal);
        results.push(result);
      } catch (error) {
        options.signal?.throwIfAborted();
        const status = isBareRepo(barePath) ? "cached" : "failed";
        if (status === "failed") rmSync(barePath, { recursive: true, force: true });
        results.push(repoSyncResult(url, status, error));
      } finally {
        scope.dispose();
      }
    }
    return results;
  }

  lookup(workspaceId: string, repoUrl: string): string | null {
    const barePath = this.barePath(workspaceId, repoUrl);
    return isBareRepo(barePath) ? barePath : null;
  }

  async createWorktree(params: MultiremiWorktreeParams): Promise<MultiremiWorktreeResult> {
    const barePath = this.barePath(params.workspaceId, params.repoUrl);
    if (!isBareRepo(barePath)) {
      throw new Error(`repo not found in cache: ${params.repoUrl} (workspace: ${params.workspaceId})`);
    }

    return await this.withRepoLock(barePath, () => this.createWorktreeLocked(barePath, params), params.signal);
  }

  async createSnapshot(params: MultiremiSnapshotParams): Promise<MultiremiSnapshotResult> {
    const barePath = this.barePath(params.workspaceId, params.repoUrl);
    if (!isBareRepo(barePath)) {
      throw new Error(`repo not found in cache: ${params.repoUrl} (workspace: ${params.workspaceId})`);
    }
    return await this.withRepoLock(barePath, async () => {
      // Intake workspaces promise a fresh view for every round. A failed fetch
      // must fail preparation instead of silently presenting an old commit as
      // current.
      if (!params.skipFetch) {
        await this.fetch(barePath, {
          env: this.gitAuth(params.workspaceId, params.repoUrl),
          signal: params.signal,
        });
      }
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
    }, params.signal);
  }

  inspectWorktree(worktreePath: string): MultiremiWorktreeState {
    if (!isGitWorktree(worktreePath)) throw new Error(`not a git worktree: ${worktreePath}`);
    const hasChanges = Boolean(git(worktreePath, ["status", "--porcelain"]));
    const hasUnpushedCommits = !Boolean(git(worktreePath, ["branch", "-r", "--contains", "HEAD"], { allowFailure: true }));
    return { dirty: hasChanges || hasUnpushedCommits, hasChanges, hasUnpushedCommits };
  }

  private async createWorktreeLocked(
    barePath: string,
    params: MultiremiWorktreeParams,
  ): Promise<MultiremiWorktreeResult> {
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
      excludeAgentFiles(worktreePath);
      applyCoAuthoredByHook(worktreePath, params.coAuthoredByEnabled !== false);
      return { path: worktreePath, branch_name: currentBranch, branchName: currentBranch, created: false, base_ref: baseRef, baseRef };
    }

    if (!params.skipFetch) {
      await this.fetch(barePath, {
        allowFailure: true,
        env: this.gitAuth(params.workspaceId, params.repoUrl),
        signal: params.signal,
      });
    }

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

  private gitAuth(workspaceId: string, repositoryUrl: string): NodeJS.ProcessEnv | undefined {
    const broker = this.options.credentialBroker;
    if (!broker) return undefined;
    return appendGitCredentialBrokerEnv(process.env, {
      ...broker,
      workspaceId,
      repositoryUrl,
      repositoryUrls: [repositoryUrl],
    });
  }

  private cloneUrl(repositoryUrl: string): string {
    if (!this.options.credentialBroker) return repositoryUrl;
    return preferredHttpsCloneUrl(repositoryUrl);
  }

  private async clone(
    url: string,
    barePath: string,
    options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
  ): Promise<void> {
    await gitNetwork(null, ["clone", "--bare", url, barePath], {
      ...options,
      timeoutMs: this.options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS,
      killGraceMs: this.options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS,
    });
  }

  private async fetch(
    barePath: string,
    options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; remote?: string; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    return await gitFetch(barePath, {
      ...options,
      retryDelaysMs: this.options.fetchRetryDelaysMs ?? DEFAULT_FETCH_RETRY_DELAYS_MS,
      timeoutMs: this.options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      killGraceMs: this.options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS,
    });
  }

  private async withRepoLock<T>(
    barePath: string,
    fn: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await acquireRepoCacheLock(
      barePath,
      this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      signal,
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Wall-clock budget for one repo's sync scope. A refresh of an existing bare
 * repo only needs the fetch ladder, so it runs under repoSyncTimeoutMs. Initial
 * materialization must additionally leave room for a full clone and its
 * fallback-URL retry — without this the outer scope would abort the clone at
 * the refresh budget, making cloneTimeoutMs unreachable.
 */
export function repoSyncBudgetMs(options: MultiremiRepoCacheOptions, hasBareRepo: boolean): number {
  const refreshBudget = options.repoSyncTimeoutMs ?? DEFAULT_REPO_SYNC_TIMEOUT_MS;
  if (hasBareRepo) return refreshBudget;
  const cloneBudget = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  return refreshBudget + 2 * cloneBudget;
}

/** Reads MULTIREMI_REPO_{FETCH,CLONE,SYNC}_TIMEOUT_MS into repo cache options. */
export function repoCacheTimeoutOverrides(
  env: Record<string, string | undefined>,
): Pick<MultiremiRepoCacheOptions, "fetchTimeoutMs" | "cloneTimeoutMs" | "repoSyncTimeoutMs"> {
  const overrides: Pick<MultiremiRepoCacheOptions, "fetchTimeoutMs" | "cloneTimeoutMs" | "repoSyncTimeoutMs"> = {};
  const fetchTimeoutMs = positiveIntEnv(env.MULTIREMI_REPO_FETCH_TIMEOUT_MS);
  const cloneTimeoutMs = positiveIntEnv(env.MULTIREMI_REPO_CLONE_TIMEOUT_MS);
  const repoSyncTimeoutMs = positiveIntEnv(env.MULTIREMI_REPO_SYNC_TIMEOUT_MS);
  if (fetchTimeoutMs) overrides.fetchTimeoutMs = fetchTimeoutMs;
  if (cloneTimeoutMs) overrides.cloneTimeoutMs = cloneTimeoutMs;
  if (repoSyncTimeoutMs) overrides.repoSyncTimeoutMs = repoSyncTimeoutMs;
  return overrides;
}

function positiveIntEnv(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

function git(
  cwd: string | null,
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync("git", args, {
    cwd: cwd ?? undefined,
    encoding: "utf8",
    env: gitEnv(options.env),
  });
  const output = redactGitCredentialError(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${redactedGitArguments(args)} failed${output ? `: ${output}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

class GitProcessTimeoutError extends Error {
  constructor(command: string, readonly timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = "GitProcessTimeoutError";
  }
}

class RepoSyncTimeoutError extends Error {
  constructor(repoUrl: string, readonly timeoutMs: number) {
    super(`repository sync timed out after ${timeoutMs}ms: ${redactGitCredentialError(repoUrl)}`);
    this.name = "RepoSyncTimeoutError";
  }
}

function repoSyncAbortScope(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  repoUrl: string,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cancel = () => {
    if (!controller.signal.aborted) controller.abort(parent?.reason ?? new Error("repository sync aborted"));
  };
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new RepoSyncTimeoutError(repoUrl, boundedTimeoutMs));
    }
  }, boundedTimeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}

async function gitNetwork(
  cwd: string | null,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs: number;
    killGraceMs: number;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  const command = `git ${redactedGitArguments(args)}`;
  const child = spawn("git", args, {
    cwd: cwd ?? undefined,
    env: networkGitEnv(options.env),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));

  return await new Promise<string>((resolve, reject) => {
    let terminalError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (error: Error) => {
      if (terminalError) return;
      terminalError = error;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), Math.max(0, options.killGraceMs));
      killTimer.unref?.();
    };
    const timeout = setTimeout(() => {
      terminate(new GitProcessTimeoutError(command, options.timeoutMs));
    }, Math.max(1, options.timeoutMs));
    timeout.unref?.();
    const onAbort = () => {
      const reason = options.signal?.reason;
      terminate(reason instanceof Error ? reason : new Error(`${command} aborted`));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (terminalError) {
        reject(terminalError);
        return;
      }
      const rawOutput = `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`.trim();
      const output = redactGitCredentialError(rawOutput);
      if (code !== 0) {
        reject(new Error(`${command} failed${output ? `: ${output}` : signal ? `: terminated by ${signal}` : ""}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

async function gitFetch(
  barePath: string,
  options: {
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    remote?: string;
    retryDelaysMs?: readonly number[];
    signal?: AbortSignal;
    timeoutMs?: number;
    killGraceMs?: number;
  } = {},
): Promise<boolean> {
  try {
    ensureRemoteTrackingLayout(barePath, options.env);
    const remote = options.remote ?? "origin";
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FETCH_RETRY_DELAYS_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    for (let attempt = 0; ; attempt += 1) {
      options.signal?.throwIfAborted();
      try {
        await gitNetwork(barePath, [
          "fetch",
          "--prune",
          "--prune-tags",
          remote,
          MODERN_FETCH_REFSPEC,
          MIRRORED_TAG_FETCH_REFSPEC,
        ], {
          env: options.env,
          signal: options.signal,
          timeoutMs,
          killGraceMs,
        });
        break;
      } catch (error) {
        options.signal?.throwIfAborted();
        const retryDelayMs = retryDelaysMs[attempt];
        if (retryDelayMs === undefined || !isRetryableGitFetchError(error)) throw error;
        log.warn("Repo fetch hit a transient network error; retrying", {
          barePath,
          remote: redactGitCredentialError(remote),
          attempt: attempt + 1,
          maxAttempts: retryDelaysMs.length + 1,
          retryDelayMs,
          error: errorMessage(error),
        });
        await sleep(Math.max(0, retryDelayMs), options.signal);
      }
    }
    if (remote === "origin") {
      try {
        await gitNetwork(barePath, ["remote", "set-head", "origin", "--auto"], {
          env: options.env,
          signal: options.signal,
          timeoutMs,
          killGraceMs,
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof GitProcessTimeoutError) {
          log.warn("Repo remote HEAD refresh timed out; continuing", {
            event: "repo_remote_head_refresh_timeout",
            barePath,
            timeoutMs,
            error: redactGitCredentialError(errorMessage(error)),
          });
        }
      }
    }
    return true;
  } catch (err) {
    options.signal?.throwIfAborted();
    if (!options.allowFailure) throw err;
    return false;
  }
}

function isRetryableGitFetchError(error: unknown): boolean {
  if (error instanceof GitProcessTimeoutError) return true;
  const message = errorMessage(error).toLowerCase();
  return [
    "connection timed out",
    "operation timed out",
    "connection reset",
    "connection refused",
    "could not resolve host",
    "could not resolve hostname",
    "temporary failure in name resolution",
    "network is unreachable",
    "no route to host",
    "broken pipe",
  ].some((marker) => message.includes(marker));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repoSyncResult(
  repoUrl: string,
  status: MultiremiRepoSyncResult["status"],
  error: unknown = null,
): MultiremiRepoSyncResult {
  return {
    repoUrl,
    status,
    error: error == null ? null : redactGitCredentialError(errorMessage(error)),
  };
}

function ensureRemoteTrackingLayout(barePath: string, env?: NodeJS.ProcessEnv): void {
  const current = git(barePath, ["config", "--get", "remote.origin.fetch"], {
    allowFailure: true,
    env,
  }).trim();
  if (current === MODERN_FETCH_REFSPEC || current === MODERN_FETCH_REFSPEC.slice(1)) return;
  git(barePath, ["config", "remote.origin.fetch", MODERN_FETCH_REFSPEC], { env });
}

function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isFinite(existing) && existing >= 0 ? existing : 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${index}`] = "*";
  return env;
}

function networkGitEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = gitEnv(base);
  if (!env.GIT_SSH_COMMAND?.trim()) env.GIT_SSH_COMMAND = DEFAULT_GIT_SSH_COMMAND;
  // Some managed hosts wrap git with their own fetch retry loop. The daemon
  // owns retries and deadlines here; nested retries would multiply delays and
  // obscure which attempt actually timed out.
  env.GIT_FETCH_RETRIES = "1";
  return env;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort; close/error will settle the runner.
  }
}

function configureRepoTransport(barePath: string, repositoryUrl: string, cloneUrl: string): void {
  git(barePath, ["remote", "set-url", "origin", cloneUrl]);
  git(barePath, ["config", "multiremi.repository-url", repositoryUrl]);
}

function redactedGitArguments(args: string[]): string {
  return args.map((arg) => redactGitCredentialError(arg)).join(" ");
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

async function acquireRepoCacheLock(
  barePath: string,
  timeoutMs: number,
  staleLockMs: number,
  signal?: AbortSignal,
): Promise<() => void> {
  const lockPath = multiremiRepoCacheLockPath(barePath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    signal?.throwIfAborted();
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
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())), signal);
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

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  let chainedHookSuffix: string | null = null;
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing.includes(MULTIREMI_HOOK_MARKER)) {
      chainedHookSuffix = parseChainedHookSuffix(existing);
    } else if (!isLegacyDaemonInstalledHook(existing)) {
      chainedHookSuffix = preserveUserHook(hookPath, existing);
    }
  }
  writeManagedHookAtomically(hookPath, prepareCommitMsgHook(chainedHookSuffix));
}

function removeCoAuthoredByHook(worktreePath: string): void {
  const hookPath = prepareCommitMsgHookPath(worktreePath);
  if (!existsSync(hookPath)) return;
  const content = readFileSync(hookPath, "utf8");
  if (content.includes(MULTIREMI_HOOK_MARKER)) {
    const chainedHookSuffix = parseChainedHookSuffix(content);
    if (chainedHookSuffix) {
      const chainedHookPath = `${hookPath}${chainedHookSuffix}`;
      if (existsSync(chainedHookPath)) {
        renameSync(chainedHookPath, hookPath);
        return;
      }
    }
    rmSync(hookPath, { force: true });
    return;
  }
  if (isLegacyDaemonInstalledHook(content)) rmSync(hookPath, { force: true });
}

function prepareCommitMsgHookPath(worktreePath: string): string {
  const commonDir = git(worktreePath, ["rev-parse", "--git-common-dir"]);
  const resolvedCommonDir = isAbsolute(commonDir) ? commonDir : join(worktreePath, commonDir);
  return join(resolvedCommonDir, "hooks", "prepare-commit-msg");
}

function prepareCommitMsgHook(chainedHookSuffix: string | null): string {
  if (!chainedHookSuffix) return PREPARE_COMMIT_MSG_HOOK_BODY;
  return PREPARE_COMMIT_MSG_HOOK_BODY.replace(
    "\nCOMMIT_MSG_FILE=",
    `\n${MULTIREMI_CHAINED_HOOK_MARKER}${chainedHookSuffix}\nCHAINED_HOOK="\${0}${chainedHookSuffix}"\nif [ -x "$CHAINED_HOOK" ]; then\n  "$CHAINED_HOOK" "$@" || exit $?\nfi\n\nCOMMIT_MSG_FILE=`,
  );
}

function preserveUserHook(hookPath: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 12);
  let suffix = `.multiremi-user-${digest}`;
  let index = 1;
  while (existsSync(`${hookPath}${suffix}`)) {
    suffix = `.multiremi-user-${digest}-${index}`;
    index += 1;
  }
  const chainedHookPath = `${hookPath}${suffix}`;
  copyFileSync(hookPath, chainedHookPath);
  chmodSync(chainedHookPath, statSync(hookPath).mode & 0o777);
  return suffix;
}

function writeManagedHookAtomically(hookPath: string, content: string): void {
  const temporaryPath = `${hookPath}.multiremi-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o755 });
    chmodSync(temporaryPath, 0o755);
    renameSync(temporaryPath, hookPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function parseChainedHookSuffix(content: string): string | null {
  const line = content.split(/\r?\n/).find((value) => value.startsWith(MULTIREMI_CHAINED_HOOK_MARKER));
  const suffix = line?.slice(MULTIREMI_CHAINED_HOOK_MARKER.length).trim() ?? "";
  return /^\.multiremi-user-[a-f0-9]{12}(?:-\d+)?$/.test(suffix) ? suffix : null;
}

function isLegacyDaemonInstalledHook(content: string): boolean {
  return LEGACY_DAEMON_HOOK_SIGNATURES.some((signature) => content.includes(signature));
}
