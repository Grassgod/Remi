/**
 * Repo checkout for agent execution — the Bun port of the Go daemon's repocache
 * + execenv git-worktree setup. A workspace repo is bare-cloned once into a
 * cache (fast re-checkouts), then each task gets an isolated git worktree to run
 * the agent in. Shells out to `git` (Bun.spawn), like the Go daemon does.
 */

import { join } from "node:path";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Env for git subprocesses (mirrors the Go daemon's repocache.gitEnv):
 *   - GIT_TERMINAL_PROMPT=0 — auth failures error out instead of hanging on a
 *     non-existent TTY.
 *   - safe.directory=* via GIT_CONFIG_* — the daemon owns its caches/worktrees,
 *     so git's ownership check adds no security and breaks CI where the runner
 *     UID differs from the dir owner. Appended at the next free index so we
 *     don't clobber any env-scoped git config (auth, URL rewrites).
 */
function gitEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") base[k] = v;
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(existing + 1),
    [`GIT_CONFIG_KEY_${existing}`]: "safe.directory",
    [`GIT_CONFIG_VALUE_${existing}`]: "*",
  };
}

/** Scaffolding files the agent writes that must not show as worktree changes. */
const AGENT_EXCLUDE_PATTERNS = [".agent_context", "CLAUDE.md", "AGENTS.md", ".claude", ".opencode"];

async function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv() });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** Deterministic cache dir name for a repo URL (mirrors the Go cache key shape). */
export function cacheKey(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/:/g, "+")
    .replace(/\//g, "+")
    .replace(/\.git$/, "") + ".git";
}

/** Bare-clone the repo into the cache (or fetch if already cached). */
export async function ensureRepoCache(cacheRoot: string, repoUrl: string): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const barePath = join(cacheRoot, cacheKey(repoUrl));
  if (existsSync(barePath)) {
    const r = await git(["fetch", "--prune", "origin"], barePath);
    if (!r.ok) throw new Error(`git fetch failed for ${repoUrl}: ${r.err}`);
    return barePath;
  }
  const r = await git(["clone", "--bare", repoUrl, barePath]);
  if (!r.ok) throw new Error(`git clone --bare failed for ${repoUrl}: ${r.err}`);
  return barePath;
}

/** The bare cache's default branch (origin/HEAD, else main/master). */
async function defaultRef(barePath: string): Promise<string> {
  const head = await git(["symbolic-ref", "--short", "HEAD"], barePath);
  if (head.ok && head.out) return head.out;
  for (const b of ["main", "master"]) {
    const v = await git(["rev-parse", "--verify", b], barePath);
    if (v.ok) return b;
  }
  return "HEAD";
}

export interface WorkdirResult {
  /** Absolute path the agent should run in. */
  workdir: string;
  /** The bare cache backing the worktree. */
  barePath: string;
  /** The branch checked out into the worktree. */
  branch: string;
}

/**
 * Prepare an isolated git worktree for a task: ensure the cache, then add a
 * worktree on a fresh task branch off `ref` (default branch when omitted).
 */
export async function prepareWorkdir(
  baseDir: string,
  repoUrl: string,
  workdirName: string,
  ref?: string,
): Promise<WorkdirResult> {
  const cacheRoot = join(baseDir, "cache");
  const barePath = await ensureRepoCache(cacheRoot, repoUrl);
  const base = ref || (await defaultRef(barePath));
  const workdir = join(baseDir, "work", workdirName);
  await mkdir(join(baseDir, "work"), { recursive: true });

  let branch = `multimira/${workdirName}`;
  let r = await git(["worktree", "add", "-b", branch, workdir, base], barePath);
  if (!r.ok && r.err.includes("already exists")) {
    // Branch name collision: append a timestamp and retry once (mirrors Go).
    branch = `${branch}-${Math.floor(Date.now() / 1000)}`;
    r = await git(["worktree", "add", "-b", branch, workdir, base], barePath);
  }
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err}`);

  // Keep the agent's scaffolding files out of the worktree's change set so a
  // task's diff reflects only real code edits.
  await excludeFromGit(workdir, AGENT_EXCLUDE_PATTERNS);

  return { workdir, barePath, branch };
}

/** Append patterns to the worktree's .git/info/exclude (idempotent). */
async function excludeFromGit(workdir: string, patterns: string[]): Promise<void> {
  const gd = await git(["rev-parse", "--git-dir"], workdir);
  if (!gd.ok) return;
  const gitDir = gd.out.startsWith("/") ? gd.out : join(workdir, gd.out);
  const excludePath = join(gitDir, "info", "exclude");
  await mkdir(join(gitDir, "info"), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    /* file may not exist yet */
  }
  const missing = patterns.filter((p) => !existing.includes(p));
  if (missing.length) await appendFile(excludePath, `\n${missing.join("\n")}\n`);
}

/** Remove a task worktree + delete its branch (best-effort, mirrors Go). */
export async function removeWorktree(barePath: string, workdir: string, branch?: string): Promise<void> {
  await git(["worktree", "remove", "--force", workdir], barePath);
  if (branch) await git(["branch", "-D", branch], barePath);
}
