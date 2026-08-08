// Host-filesystem introspection the runtime reports to the server: local-skill
// discovery/packing (SKILL.md bundles under the provider's skills root) and git
// working-tree scanning/browsing for the repo-source picker. The two halves share
// the small safe-fs primitives below. Extracted verbatim from worker/daemon.ts
// (the daemon imports them back and re-exports the scan/browse entry points).
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { normalizeSkillFilePath } from "@daemon/agent-runtime/skills/ephemeral.js";
import type {
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiSkillFile,
} from "@multiremi/contracts/types.js";

const MAX_LOCAL_SKILL_FILE_SIZE = 1 << 20;
const MAX_LOCAL_SKILL_BUNDLE_SIZE = 8 << 20;
const MAX_LOCAL_SKILL_FILE_COUNT = 128;
const MAX_LOCAL_SKILL_DIR_DEPTH = 4;
const LOCAL_SKILL_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export function localSkillRootForProvider(provider: string, overrides: Record<string, string>): string | null {
  const normalized = provider.toLowerCase();
  if (overrides[normalized]) return overrides[normalized];
  if (normalized === "claude") {
    return process.env.MULTIREMI_CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  }
  if (normalized === "codex") {
    return process.env.MULTIREMI_CODEX_SKILLS_DIR ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills");
  }
  return null;
}

export function listRuntimeLocalSkills(provider: string, root: string): MultiremiRuntimeLocalSkillSummary[] {
  if (!existsSync(root)) return [];
  const rootPath = resolve(root);
  const summaries: MultiremiRuntimeLocalSkillSummary[] = [];
  const visited = new Set<string>();
  walkLocalSkillDirs(rootPath, rootPath, 0, summaries, provider, visited);
  return summaries.sort((left, right) => left.key.localeCompare(right.key));
}

function walkLocalSkillDirs(
  root: string,
  dir: string,
  depth: number,
  summaries: MultiremiRuntimeLocalSkillSummary[],
  provider: string,
  visited: Set<string>,
): void {
  if (depth > MAX_LOCAL_SKILL_DIR_DEPTH) return;
  const realPath = safeRealPath(dir);
  if (!realPath || visited.has(realPath)) return;
  visited.add(realPath);

  const entries = safeReadDir(dir);
  if (!entries) return;

  if (isFile(join(dir, "SKILL.md"))) {
    const key = slashPath(relative(root, dir));
    if (key) {
      let main: string;
      let files: MultiremiSkillFile[];
      try {
        main = readRuntimeLocalSkillMainFile(dir);
        files = collectRuntimeLocalSkillFiles(dir, false);
      } catch {
        return;
      }
      const meta = parseSkillFrontmatter(main);
      summaries.push({
        key,
        name: meta.name || humanizeSkillKey(key),
        description: meta.description,
        sourcePath: relativizeHomePath(dir),
        source_path: relativizeHomePath(dir),
        provider,
        fileCount: files.length + 1,
        file_count: files.length + 1,
      });
    }
    return;
  }

  for (const entry of entries) {
    if (isIgnoredLocalSkillEntry(entry.name)) continue;
    const child = join(dir, entry.name);
    if (isDirectory(child)) walkLocalSkillDirs(root, child, depth + 1, summaries, provider, visited);
  }
}

export function loadRuntimeLocalSkillBundle(provider: string, root: string, rawKey: string): {
  name: string;
  description: string;
  content: string;
  source_path: string;
  provider: string;
  files: MultiremiSkillFile[];
} {
  const key = normalizeLocalSkillKey(rawKey);
  if (key.split("/").length > MAX_LOCAL_SKILL_DIR_DEPTH) {
    throw new Error(`local skill key exceeds ${MAX_LOCAL_SKILL_DIR_DEPTH} directory levels`);
  }
  const rootPath = resolve(root);
  const skillDir = resolve(rootPath, key);
  const rel = slashPath(relative(rootPath, skillDir));
  if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) throw new Error("invalid skill key");
  if (!isDirectory(skillDir)) throw new Error("local skill not found");
  const content = readRuntimeLocalSkillMainFile(skillDir);
  const meta = parseSkillFrontmatter(content);
  return {
    name: meta.name || humanizeSkillKey(key),
    description: meta.description ?? "",
    content,
    source_path: skillDir,
    provider,
    files: collectRuntimeLocalSkillFiles(skillDir, true),
  };
}

function collectRuntimeLocalSkillFiles(skillDir: string, includeContent: boolean): MultiremiSkillFile[] {
  const files: MultiremiSkillFile[] = [];
  let totalSize = 0;

  const visit = (dir: string): void => {
    const entries = safeReadDir(dir);
    if (!entries) return;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredLocalSkillEntry(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile() || isIgnoredLocalSkillEntry(entry.name) || entry.name.toLowerCase() === "skill.md") continue;
      const rel = slashPath(relative(skillDir, path));
      let normalized: string;
      try {
        normalized = normalizeSkillFilePath(rel);
      } catch {
        continue;
      }
      const size = fileSize(path);
      if (size == null || size > MAX_LOCAL_SKILL_FILE_SIZE) continue;
      const content = readRuntimeLocalSkillTextFile(path);
      if (content == null) continue;
      if (files.length >= MAX_LOCAL_SKILL_FILE_COUNT) throw new Error(`local skill exceeds ${MAX_LOCAL_SKILL_FILE_COUNT} files`);
      totalSize += size;
      if (totalSize > MAX_LOCAL_SKILL_BUNDLE_SIZE) throw new Error(`local skill exceeds ${MAX_LOCAL_SKILL_BUNDLE_SIZE} bytes in total`);
      files.push({ path: normalized, content: includeContent ? content : "" });
    }
  };

  visit(skillDir);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readRuntimeLocalSkillMainFile(skillDir: string): string {
  const mainPath = join(skillDir, "SKILL.md");
  const size = fileSize(mainPath);
  if (size == null) throw new Error("local skill not found");
  if (size > MAX_LOCAL_SKILL_FILE_SIZE) throw new Error(`SKILL.md exceeds ${MAX_LOCAL_SKILL_FILE_SIZE} bytes`);
  const content = readRuntimeLocalSkillTextFile(mainPath);
  if (content == null) throw new Error("SKILL.md is not valid UTF-8 text");
  return content;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!parsed) continue;
    const key = parsed[1]!.toLowerCase();
    const value = parsed[2]!.trim().replace(/^["']|["']$/g, "");
    if (key === "name") meta.name = value;
    if (key === "description") meta.description = value;
  }
  return meta;
}

function normalizeLocalSkillKey(value: string): string {
  const normalized = slashPath(String(value ?? "").trim());
  if (!normalized) throw new Error("skill key is required");
  const parts = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("/") || parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("invalid skill key");
  }
  return parts.join("/");
}

function isIgnoredLocalSkillEntry(name: string): boolean {
  if (!name || name.startsWith(".")) return true;
  const normalized = name.toLowerCase();
  return normalized === "license" || normalized === "license.md" || normalized === "license.txt";
}

function relativizeHomePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  const prefix = `${home}/`;
  const normalized = slashPath(path);
  const normalizedPrefix = slashPath(prefix);
  if (normalized.startsWith(normalizedPrefix)) return `~/${normalized.slice(normalizedPrefix.length)}`;
  return normalized;
}

function safeReadDir(path: string): Dirent[] | null {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function safeRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readRuntimeLocalSkillTextFile(path: string): string | null {
  try {
    const content = readFileSync(path);
    if (isLikelyBinaryLocalSkillFile(content)) return null;
    return LOCAL_SKILL_TEXT_DECODER.decode(content);
  } catch {
    return null;
  }
}

function isLikelyBinaryLocalSkillFile(content: Uint8Array): boolean {
  if (content.length === 0) return false;
  const sample = content.subarray(0, Math.min(content.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious > Math.max(16, sample.length * 0.1);
}

function humanizeSkillKey(key: string): string {
  return basename(key).replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}

const DIRECTORY_SCAN_DEFAULT_DEPTH = 3;
const DIRECTORY_SCAN_MAX_DEPTH = 5;
const DIRECTORY_SCAN_MAX_CANDIDATES = 100;
const DIRECTORY_SCAN_TIME_BUDGET_MS = 20_000;
const DIRECTORY_SCAN_SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", ".cache", "vendor",
  "__pycache__", ".turbo", ".venv", "venv", "target", "Library",
]);

/**
 * Walk a runtime directory tree (iterative BFS) looking for git working trees.
 * A directory containing `.git` (dir or file) is a candidate and is not
 * descended into. Metadata is read purely from the filesystem — no git spawn —
 * so a pathological root can only cost the ~20s time box, never a hung process.
 */
export async function scanRuntimeDirectories(root: string | undefined, maxDepthParam: number | undefined): Promise<MultiremiRuntimeDirectoryCandidate[]> {
  const rootPath = resolve(root && root.trim() ? expandHomePath(root.trim()) : homedir());
  if (!isDirectory(rootPath)) throw new Error(`directory does not exist: ${rootPath}`);
  const maxDepth = Math.min(Number.isFinite(maxDepthParam) ? Number(maxDepthParam) : DIRECTORY_SCAN_DEFAULT_DEPTH, DIRECTORY_SCAN_MAX_DEPTH);
  const deadline = Date.now() + DIRECTORY_SCAN_TIME_BUDGET_MS;
  const candidates: MultiremiRuntimeDirectoryCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  let dequeued = 0;
  scan: while (queue.length > 0) {
    if (candidates.length >= DIRECTORY_SCAN_MAX_CANDIDATES || Date.now() >= deadline) break;
    const { dir, depth } = queue.shift()!;
    // Yield to the event loop periodically so a large tree can't block ACP
    // streaming or cancellation polling on a busy daemon.
    if (++dequeued % 50 === 0) await new Promise((r) => setTimeout(r, 0));
    // A git working tree is a leaf candidate: record it and stop descending.
    if (existsSync(join(dir, ".git"))) {
      candidates.push(readDirectoryCandidate(dir));
      continue;
    }
    if (depth >= maxDepth) continue;
    const entries = safeReadDir(dir);
    if (!entries) continue;
    for (const entry of entries) {
      // Re-check the time box inside the per-entry loop: a huge fan-out could
      // otherwise blow past the budget before the next dequeue.
      if (Date.now() >= deadline) break scan;
      if (isSkippedScanDir(entry.name)) continue;
      const child = join(dir, entry.name);
      // lstat (no symlink follow) so symlinked directories are skipped for loop safety.
      if (!isRealDirectory(child)) continue;
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return candidates;
}

const DIRECTORY_BROWSE_MAX_ENTRIES = 200;
const DIRECTORY_BROWSE_TIME_BUDGET_MS = 10_000;
const DIRECTORY_BROWSE_YIELD_EVERY = 200;

/**
 * List the immediate child directories of `root` (depth 1) — the folder-picker
 * counterpart to scan mode. Every visible directory is surfaced, git or not;
 * dot-dirs and the usual junk (see DIRECTORY_SCAN_SKIP_DIRS) are hidden and
 * symlinked dirs are skipped for loop safety. Git children carry the same
 * remote/branch metadata scan mode reads. Sorted by name, capped at 200.
 *
 * Like scan mode, this is guarded against a pathological root (e.g. a directory
 * with hundreds of thousands of entries, worse on cold NFS): the per-entry lstat
 * sweep checks a time box and yields to the event loop periodically so it can't
 * block ACP streaming or cancellation polling on a busy daemon. Returns the
 * expanded absolute `resolvedRoot` so the UI can render/ascend on empty listings.
 */
export async function browseRuntimeDirectory(root: string | undefined): Promise<{
  candidates: MultiremiRuntimeDirectoryCandidate[];
  resolvedRoot: string;
}> {
  const rootPath = resolve(root && root.trim() ? expandHomePath(root.trim()) : homedir());
  if (!isDirectory(rootPath)) throw new Error(`directory does not exist: ${rootPath}`);
  const entries = safeReadDir(rootPath);
  if (!entries) return { candidates: [], resolvedRoot: rootPath };
  const deadline = Date.now() + DIRECTORY_BROWSE_TIME_BUDGET_MS;
  const names: string[] = [];
  let seen = 0;
  for (const entry of entries) {
    if (Date.now() >= deadline) break;
    // Yield to the event loop periodically so a huge fan-out can't block the
    // daemon's ACP streaming / cancellation polling mid-sweep.
    if (++seen % DIRECTORY_BROWSE_YIELD_EVERY === 0) await new Promise((r) => setTimeout(r, 0));
    if (isSkippedScanDir(entry.name)) continue;
    // lstat (no symlink follow) so symlinked directories are skipped for loop safety.
    if (!isRealDirectory(join(rootPath, entry.name))) continue;
    names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  const capped = names.slice(0, DIRECTORY_BROWSE_MAX_ENTRIES);
  const candidates: MultiremiRuntimeDirectoryCandidate[] = [];
  for (let i = 0; i < capped.length; i++) {
    if (i > 0 && i % DIRECTORY_BROWSE_YIELD_EVERY === 0) await new Promise((r) => setTimeout(r, 0));
    candidates.push(readBrowseCandidate(join(rootPath, capped[i]!)));
  }
  return { candidates, resolvedRoot: rootPath };
}

function readBrowseCandidate(dir: string): MultiremiRuntimeDirectoryCandidate {
  const isGitRepo = existsSync(join(dir, ".git"));
  const gitDir = isGitRepo ? resolveGitDir(dir) : null;
  return {
    path: dir,
    name: basename(dir),
    remoteUrl: gitDir ? readGitRemoteOriginUrl(gitDir) : null,
    currentBranch: gitDir ? readGitCurrentBranch(gitDir) : null,
    isDirty: null,
    isGitRepo,
  };
}

function isSkippedScanDir(name: string): boolean {
  return name.startsWith(".") || DIRECTORY_SCAN_SKIP_DIRS.has(name);
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function readDirectoryCandidate(dir: string): MultiremiRuntimeDirectoryCandidate {
  const gitDir = resolveGitDir(dir);
  return {
    path: dir,
    name: basename(dir),
    remoteUrl: gitDir ? readGitRemoteOriginUrl(gitDir) : null,
    currentBranch: gitDir ? readGitCurrentBranch(gitDir) : null,
    isDirty: null,
  };
}

/**
 * Resolve the git directory for a candidate. A `.git` directory is used as-is;
 * a `.git` file (worktree/submodule) is resolved via its `gitdir:` pointer.
 * Best effort — returns null when the pointer can't be resolved.
 */
function resolveGitDir(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const pointer = safeReadTextFile(dotGit);
  const match = pointer?.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const target = match[1]!.trim();
  const resolved = isAbsolute(target) ? target : resolve(dir, target);
  return isDirectory(resolved) ? resolved : null;
}

function readGitRemoteOriginUrl(gitDir: string): string | null {
  const config = readGitConfig(gitDir);
  if (!config) return null;
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^url\s*=\s*(.+)$/);
    if (url) return url[1]!.trim() || null;
  }
  return null;
}

/**
 * Read a git dir's config. A linked worktree's gitdir (`.git/worktrees/<name>`)
 * has no local `config` — the shared config lives in the common dir named by the
 * sibling `commondir` pointer, so fall back to that when the direct read misses.
 */
function readGitConfig(gitDir: string): string | null {
  const direct = safeReadTextFile(join(gitDir, "config"));
  if (direct) return direct;
  const pointer = safeReadTextFile(join(gitDir, "commondir"));
  const target = pointer?.trim();
  if (!target) return null;
  const commonDir = isAbsolute(target) ? target : resolve(gitDir, target);
  return safeReadTextFile(join(commonDir, "config"));
}

function readGitCurrentBranch(gitDir: string): string | null {
  const head = safeReadTextFile(join(gitDir, "HEAD"));
  const match = head?.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return match ? match[1]!.trim() || null : null;
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
