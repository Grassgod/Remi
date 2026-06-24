import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, appendFileSync, chmodSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  coAuthoredByEnabled?: boolean;
}

export interface MultiremiWorktreeResult {
  path: string;
  branch_name: string;
  branchName: string;
}

export interface MultiremiRepoCacheOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

const AGENT_GIT_EXCLUDE_PATTERNS = [".agent_context", ".multiremi", "CLAUDE.md", "AGENTS.md", ".claude", ".opencode"];
const MODERN_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_STALE_LOCK_MS = 60 * 60_000;
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
            ensureRemoteTrackingLayout(barePath);
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

  pruneWorktrees(): number {
    let pruned = 0;
    for (const workspace of safeReadDir(this.root)) {
      if (!workspace.isDirectory()) continue;
      const workspaceRoot = join(this.root, workspace.name);
      for (const repo of safeReadDir(workspaceRoot)) {
        if (!repo.isDirectory()) continue;
        const barePath = join(workspaceRoot, repo.name);
        if (!isBareRepo(barePath)) continue;
        this.withRepoLock(barePath, () => {
          git(barePath, ["worktree", "prune"], { allowFailure: true });
        });
        pruned++;
      }
    }
    return pruned;
  }

  private createWorktreeLocked(barePath: string, params: MultiremiWorktreeParams): MultiremiWorktreeResult {
    gitFetch(barePath, { allowFailure: true });

    const baseRef = resolveBaseRef(barePath, params.ref);
    const branchBase = `agent/${sanitizeName(params.agentName ?? "agent")}/${shortId(params.taskId ?? "task")}`;
    const worktreePath = join(params.workDir, repoNameFromUrl(params.repoUrl));
    let branchName = branchBase;

    if (existsSync(worktreePath)) {
      if (!isGitWorktree(worktreePath)) {
        throw new Error(`worktree path already exists and is not a git worktree: ${worktreePath}`);
      }
      git(worktreePath, ["reset", "--hard"]);
      git(worktreePath, ["clean", "-fd"]);
      try {
        git(worktreePath, ["checkout", "-B", branchName, baseRef]);
      } catch (err) {
        if (!isBranchCollisionError(err)) throw err;
        branchName = `${branchName}-${Date.now()}`;
        git(worktreePath, ["checkout", "-B", branchName, baseRef]);
      }
      excludeAgentFiles(worktreePath);
      applyCoAuthoredByHook(worktreePath, params.coAuthoredByEnabled !== false);
      return { path: worktreePath, branch_name: branchName, branchName };
    }

    mkdirSync(params.workDir, { recursive: true });
    try {
      git(barePath, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
    } catch (err) {
      if (!isBranchCollisionError(err)) throw err;
      branchName = `${branchName}-${Date.now()}`;
      git(barePath, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
    }
    excludeAgentFiles(worktreePath);
    applyCoAuthoredByHook(worktreePath, params.coAuthoredByEnabled !== false);
    return { path: worktreePath, branch_name: branchName, branchName };
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

function safeReadDir(path: string): ReturnType<typeof readdirSync> {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
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
    git(barePath, ["fetch", "--prune", "origin", "--tags"], { allowFailure: options.allowFailure });
    git(barePath, ["remote", "set-head", "origin", "--auto"], { allowFailure: true });
  } catch (err) {
    if (!options.allowFailure) throw err;
  }
}

function ensureRemoteTrackingLayout(barePath: string): void {
  const current = git(barePath, ["config", "--get", "remote.origin.fetch"], { allowFailure: true }).trim();
  if (current === MODERN_FETCH_REFSPEC || current === MODERN_FETCH_REFSPEC.slice(1)) return;
  git(barePath, ["config", "remote.origin.fetch", MODERN_FETCH_REFSPEC]);
  git(barePath, ["fetch", "--prune", "origin", "--tags"]);
  git(barePath, ["remote", "set-head", "origin", "--auto"], { allowFailure: true });
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
  if (staleLockMs <= 0) return false;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleLockMs;
  } catch {
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

function isBranchCollisionError(err: unknown): boolean {
  return err instanceof Error && err.message.toLowerCase().includes("a branch named");
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
