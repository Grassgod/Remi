import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { AgentTask, AgentTaskProjectContext } from "@daemon/contracts/types.js";
import { MultiremiRepoCache } from "../repo/checkout.js";

export interface IntakeWorkspaceOptions {
  snapshotsRoot: string;
  skipRepoFetch?: boolean;
  signal?: AbortSignal;
}

export interface PreparedIntakeRepo {
  repoUrl: string;
  repoName: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  status: "ready" | "error";
  dirty: false;
  error: string | null;
}

export interface PreparedIntakeWorkspace {
  checkouts: [];
  repos: PreparedIntakeRepo[];
  warnings: [];
}

export async function prepareIntakeWorkspace(
  workDir: string,
  task: AgentTask,
  repoCache: MultiremiRepoCache,
  options: IntakeWorkspaceOptions,
): Promise<PreparedIntakeWorkspace> {
  const contexts = task.projectContexts ?? task.project_contexts ?? [];
  const stagingRoot = join(workDir, `.projects.tmp-${process.pid}-${Date.now()}`);
  const projectsRoot = join(workDir, "projects");
  const backupRoot = join(workDir, `.projects.old-${process.pid}-${Date.now()}`);
  mkdirSync(stagingRoot, { recursive: true });

  const repos: PreparedIntakeRepo[] = [];
  const projectEntries: Array<Record<string, unknown>> = [];
  const usedDirectories = new Set<string>();
  try {
    for (const context of contexts) {
      const directory = uniqueProjectDirectory(context, usedDirectories);
      const projectRoot = join(stagingRoot, directory);
      mkdirSync(join(projectRoot, "repos"), { recursive: true });
      writeProjectKnowledge(projectRoot, context);
      writeJson(join(projectRoot, "project.json"), {
        id: context.project.id,
        title: context.project.title,
        description: context.project.description,
        resources: context.resources.map((resource) => ({
          id: resource.id,
          type: resource.resourceType,
          label: resource.label,
          ref: resource.resourceRef,
        })),
      });

      const projectRepos: Array<Record<string, unknown>> = [];
      const usedRepoDirectories = new Set<string>();
      for (const repo of context.repos) {
        const repoName = uniqueRepoDirectory(repo.url, usedRepoDirectories);
        const linkPath = join(projectRoot, "repos", repoName);
        let snapshot;
        try {
          snapshot = await repoCache.createSnapshot({
            workspaceId: task.workspaceId,
            repoUrl: repo.url,
            snapshotsRoot: options.snapshotsRoot,
            skipFetch: options.skipRepoFetch,
            signal: options.signal,
          });
        } catch (error) {
          options.signal?.throwIfAborted();
          // A repo without any usable snapshot must not sink the whole intake
          // round; the caller surfaces it as an availability warning instead.
          repos.push({
            repoUrl: repo.url,
            repoName,
            worktreePath: join(projectsRoot, directory, "repos", repoName),
            branchName: "",
            baseRef: "",
            status: "error",
            dirty: false,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        symlinkSync(snapshot.path, linkPath, "dir");
        repos.push({
          repoUrl: repo.url,
          repoName,
          worktreePath: join(projectsRoot, directory, "repos", repoName),
          branchName: "",
          baseRef: snapshot.commit,
          status: "ready",
          dirty: false,
          error: null,
        });
        projectRepos.push({
          name: repoName,
          url: repo.url,
          commit: snapshot.commit,
          base_ref: snapshot.baseRef,
          path: `projects/${directory}/repos/${repoName}`,
        });
      }
      projectEntries.push({
        id: context.project.id,
        title: context.project.title,
        directory,
        repos: projectRepos,
      });
    }

    makeViewReadOnly(stagingRoot);
    if (existsSync(projectsRoot)) renameSync(projectsRoot, backupRoot);
    renameSync(stagingRoot, projectsRoot);
    if (existsSync(backupRoot)) removeReadOnlyTree(backupRoot);
  } catch (error) {
    if (existsSync(stagingRoot)) removeReadOnlyTree(stagingRoot);
    if (!existsSync(projectsRoot) && existsSync(backupRoot)) renameSync(backupRoot, projectsRoot);
    throw error;
  }

  writeJson(join(workDir, "manifest.json"), {
    version: 1,
    mode: "intake",
    issue_id: task.issueId,
    issue_key: task.issue?.key ?? null,
    task_id: task.id,
    generated_at: new Date().toISOString(),
    projects: projectEntries,
  });
  writeJson(join(workDir, ".multiremi", "workspace.json"), {
    version: 1,
    kind: "intake",
    read_only: true,
    issue_id: task.issueId,
    issue_key: task.issue?.key ?? null,
    task_id: task.id,
  });

  return { checkouts: [], repos, warnings: [] };
}

function writeProjectKnowledge(projectRoot: string, context: AgentTaskProjectContext): void {
  const knowledgeRoot = join(projectRoot, "knowledge");
  const index = context.docs.map((doc) => ({
    id: doc.id,
    kind: doc.kind,
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags,
    pinned: doc.pinned,
    updated_at: doc.updatedAt,
    path: `${doc.kind}/${safePathPart(doc.slug)}.md`,
  }));
  for (const doc of context.docs) {
    const path = join(knowledgeRoot, doc.kind, `${safePathPart(doc.slug)}.md`);
    mkdirSync(join(knowledgeRoot, doc.kind), { recursive: true });
    writeFileSync(path, `${doc.body.replace(/\s+$/, "")}\n`, { mode: 0o444 });
  }
  writeJson(join(knowledgeRoot, "index.json"), { project_id: context.project.id, docs: index });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

function uniqueProjectDirectory(context: AgentTaskProjectContext, used: Set<string>): string {
  const base = safePathPart(context.project.title) || context.project.id;
  let candidate = base;
  if (used.has(candidate)) candidate = `${base}-${safePathPart(context.project.id).slice(-8)}`;
  used.add(candidate);
  return candidate;
}

function repoDirectoryName(url: string): string {
  const normalized = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  return safePathPart(basename(normalized)) || "repo";
}

function uniqueRepoDirectory(url: string, used: Set<string>): string {
  const base = repoDirectoryName(url);
  const candidate = used.has(base)
    ? `${base}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`
    : base;
  used.add(candidate);
  return candidate;
}

function safePathPart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/^\.+$/, "").slice(0, 120);
}

function removeReadOnlyTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    void readlinkSync(path);
    rmSync(path, { force: true });
    return;
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) removeReadOnlyTree(join(path, entry));
  } else {
    chmodSync(path, 0o644);
  }
  rmSync(path, { recursive: true, force: true });
}

function makeViewReadOnly(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) makeViewReadOnly(join(path, entry));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, 0o444);
  }
}
