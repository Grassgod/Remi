import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RepoSpec } from "@daemon/contracts/types.js";
import type { TaskRepoCheckout, TaskRepoWarning } from "../prompts/ephemeral.js";
import type { MultiremiRepoCache } from "../repo/checkout.js";
import { redactGitCredentialError } from "../repo/credential-broker.js";

interface ChatRepositoryEntry {
  projectId: string;
  repoUrl: string;
  path: string;
}

interface ChatRepositoryManifest {
  version: 1;
  workspaceId: string;
  chatSessionId: string;
  projectId: string;
  entries: ChatRepositoryEntry[];
}

export interface PrepareChatRepositoriesOptions {
  workDir: string;
  workspaceId: string;
  chatSessionId: string;
  projectId: string;
  repos: RepoSpec[];
  cache: MultiremiRepoCache;
  signal?: AbortSignal;
}

/** Caller must establish a matching Project binding and a daemon-owned Chat directory. */
export async function prepareChatRepositories(options: PrepareChatRepositoriesOptions): Promise<{
  repos: RepoSpec[];
  reposToSync: RepoSpec[];
  warnings: TaskRepoWarning[];
  recordCheckouts(checkouts: TaskRepoCheckout[]): Promise<void>;
}> {
  const { workDir, workspaceId, chatSessionId, projectId, cache, signal } = options;
  const manifestPath = join(workDir, ".multiremi", "chat-repos.json");
  await validateMetadataPath(workDir);
  const previous = await readManifest(manifestPath, options);
  const warnings: TaskRepoWarning[] = [];
  // The Project binding is fixed at creation. Keep registered worktrees even
  // if the Project's repository resources change; startup never deletes them.
  const entries: ChatRepositoryEntry[] = previous?.entries ?? [];
  const warn = (repoUrl: string, message: string) => warnings.push({
    repoUrl,
    kind: "unavailable" as const,
    message: redactGitCredentialError(message),
  });

  const repos: RepoSpec[] = [];
  const reposToSync: RepoSpec[] = [];
  const paths = new Map(entries.map((entry) => [entry.path, entry.repoUrl]));
  for (const repo of options.repos) {
    signal?.throwIfAborted();
    try {
      const path = cache.expectedWorktreePath(workDir, repo.url);
      const occupiedBy = paths.get(path);
      if (occupiedBy && occupiedBy !== repo.url) {
        warn(repo.url, `Automatic checkout skipped: ${path} is reserved for another repository (${occupiedBy}). Use remi repo checkout after resolving the directory collision; do not overwrite preserved work.`);
        continue;
      }
      if (repos.some((candidate) => candidate.url === repo.url)) continue;
      const existing = cache.hasWorktree({ workspaceId, repoUrl: repo.url, workDir });
      paths.set(path, repo.url);
      repos.push(repo);
      if (!existing) reposToSync.push(repo);
    } catch (error) {
      warn(repo.url, `Automatic checkout skipped: ${errorText(error)}. Use remi repo checkout after resolving the existing directory; it was left untouched.`);
    }
  }

  const manifest: ChatRepositoryManifest = { version: 1, workspaceId, chatSessionId, projectId, entries };
  const persist = async () => {
    if (!previous && !manifest.entries.length) return;
    await writeManifest(workDir, manifestPath, manifest);
  };
  return {
    repos,
    reposToSync,
    warnings,
    recordCheckouts: async (checkouts) => {
      for (const checkout of checkouts) {
        if (!repos.some((repo) => repo.url === checkout.repoUrl)) continue;
        const expectedPath = cache.expectedWorktreePath(workDir, checkout.repoUrl);
        if (resolve(checkout.path) !== expectedPath
          || !cache.hasWorktree({ workspaceId, repoUrl: checkout.repoUrl, workDir })) {
          throw new Error(`cannot track an unverified Chat worktree: ${checkout.path}`);
        }
        const index = entries.findIndex((entry) => entry.repoUrl === checkout.repoUrl);
        const entry = { projectId, repoUrl: checkout.repoUrl, path: expectedPath };
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
      }
      await persist();
    },
  };
}

async function readManifest(path: string, options: PrepareChatRepositoriesOptions): Promise<ChatRepositoryManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(raw) as ChatRepositoryManifest;
  if (manifest.version !== 1 || manifest.workspaceId !== options.workspaceId
    || manifest.chatSessionId !== options.chatSessionId || manifest.projectId !== options.projectId
    || !Array.isArray(manifest.entries)) {
    throw new Error("Chat repository manifest does not match this workspace/session/project");
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || entry.projectId !== options.projectId || typeof entry.repoUrl !== "string"
      || typeof entry.path !== "string" || !entry.repoUrl
      || entry.path !== options.cache.expectedWorktreePath(options.workDir, entry.repoUrl)
      || seen.has(entry.path)) {
      throw new Error("Chat repository manifest contains an unsafe or duplicate worktree path");
    }
    seen.add(entry.path);
  }
  return manifest;
}

async function validateMetadataPath(workDir: string): Promise<void> {
  for (const [path, directory] of [
    [workDir, true],
    [join(workDir, ".multiremi"), true],
    [join(workDir, ".multiremi", "chat-repos.json"), false],
  ] as const) {
    let stat;
    try { stat = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`unsafe Chat repository metadata path: ${path}`);
    }
  }
}

async function writeManifest(workDir: string, path: string, manifest: ChatRepositoryManifest): Promise<void> {
  await validateMetadataPath(workDir);
  await mkdir(join(workDir, ".multiremi"), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
