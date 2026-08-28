import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizeWikiPath } from "@multiremi/contracts/wiki-path";
import { tmpdir } from "node:os";
import type { CliOptions } from "../options.js";
import { rawStringOption } from "../options.js";
import { isRecord, multiremiApiRequest } from "../http.js";
import { printJson } from "../output.js";

interface WikiDoc {
  id: string;
  projectId: string;
  workspaceId: string;
  slug: string;
  path: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  refs: Array<{ type: string; value: string }>;
  version: number;
  updatedAt: string;
}

interface WikiManifestEntry {
  id: string;
  slug: string;
  path: string;
  movedTo?: string;
  title: string;
  summary: string | null;
  tags: string[];
  pinned: boolean;
  refs: Array<{ type: string; value: string }>;
  version: number;
  sha256: string;
  updatedAt: string;
}

interface WikiManifest {
  version: 1;
  projectId: string;
  workspaceId: string;
  pulledAt: string;
  docs: WikiManifestEntry[];
}

interface WikiPaths {
  root: string;
  wiki: string;
  base: string;
  baseFiles: string;
  conflicts: string;
  manifest: string;
  lock: string;
}

interface WikiChange {
  slug: string;
  path: string;
  state: "added" | "modified" | "deleted" | "remote_changed" | "diverged" | "unchanged";
  localChanged: boolean;
  remoteChanged: boolean;
}

type PushAction =
  | { kind: "create"; slug: string; body: string; path: string; localSnapshot: string }
  | { kind: "update"; id: string; slug: string; body: string; path: string; previousPath: string; version: number; localSnapshot: string }
  | { kind: "delete"; slug: string; path: string; version: number; localSnapshot: null };

interface PushPlan {
  actions: PushAction[];
  conflicts: Array<{ slug: string; path: string; reason: string; body?: string }>;
}

interface RepositoryWikiDoc {
  id: string;
  repositoryId: string;
  path: string;
  title: string;
  body: string;
  version: number;
  sourceRevision: string | null;
  updatedAt: string;
}

interface RepositoryWikiManifestRepository {
  id: string;
  name: string;
  directory: string;
}

interface RepositoryWikiManifestEntry {
  id: string;
  repositoryId: string;
  repositoryName: string;
  path: string;
  movedTo?: string;
  version: number;
  sourceRevision: string | null;
  sha256: string;
  updatedAt: string;
}

interface RepositoryWikiManifest {
  version: 1;
  workspaceId: string;
  pulledAt: string;
  repositories: RepositoryWikiManifestRepository[];
  docs: RepositoryWikiManifestEntry[];
}

type RepositoryPushAction =
  | { kind: "create"; repositoryId: string; path: string; repositoryPath: string; body: string; localSnapshot: string }
  | { kind: "update"; repositoryId: string; id: string; path: string; previousPath: string; repositoryPath: string; body: string; version: number; localSnapshot: string }
  | { kind: "delete"; repositoryId: string; id: string; path: string; version: number; localSnapshot: null };

interface RepositoryPushPlan {
  actions: RepositoryPushAction[];
  conflicts: Array<{ repository_id: string; path: string; reason: string; body?: string }>;
}

export async function wikiPull(options: CliOptions, projectId: string): Promise<void> {
  const paths = wikiPaths(options);
  await withWikiLock(paths, async () => {
    const remote = await fetchWikiDocs(projectId, options);
    const manifest = reconcileWorkingCopy(paths, projectId, remote, Boolean(options.force));
    printJson({
      project_id: projectId,
      directory: paths.wiki,
      base_directory: paths.base,
      docs: manifest.docs.length,
      pulled_at: manifest.pulledAt,
    });
  });
}

export async function wikiStatus(options: CliOptions, projectId: string | null): Promise<void> {
  const paths = wikiPaths(options);
  await withWikiLock(paths, async () => {
    const manifest = projectId ? requireManifest(paths, projectId) : null;
    const remote = projectId ? await fetchWikiDocs(projectId, options) : [];
    const changes = manifest ? workingCopyStatus(paths, manifest, remote) : [];
    const repositoryState = await repositoryWorkingCopyState(paths, options);
    if (!manifest && !repositoryState.manifest) {
      throw new Error("Wiki working copy is not initialized; specify --project or run inside an Issue workspace with Repository Wiki context");
    }
    printJson({
      project_id: projectId,
      directory: paths.wiki,
      clean: changes.every((change) => change.state === "unchanged") && repositoryState.changes.length === 0,
      changes: changes.filter((change) => change.state !== "unchanged"),
      repository_changes: repositoryState.changes,
    });
  });
}

export async function wikiDiff(options: CliOptions, projectId: string): Promise<void> {
  const paths = wikiPaths(options);
  await withWikiLock(paths, async () => {
    const manifest = requireManifest(paths, projectId);
    const changes = workingCopyStatus(paths, manifest, await fetchWikiDocs(projectId, options));
    const moveTargets = detectProjectMoveTargets(paths, manifest, localMarkdownPaths(paths));
    let wrote = false;
    for (const change of changes.filter((entry) => entry.localChanged)) {
      const entry = manifest.docs.find((candidate) =>
        candidate.path === change.path || moveTargets.get(candidate.id) === change.path
      );
      const basePath = entry ? join(paths.baseFiles, entry.path) : emptyFile(paths, ".empty-base");
      const localPath = readLocalText(paths, change.path) !== null
        ? join(paths.wiki, change.path)
        : emptyFile(paths, ".empty-local");
      const diff = spawnSync("git", ["diff", "--no-index", "--", basePath, localPath], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (diff.error) throw new Error(`git diff failed: ${diff.error.message}`);
      if (diff.status !== 0 && diff.status !== 1) throw new Error(`git diff failed: ${diff.stderr || `exit ${diff.status}`}`);
      if (diff.stdout) {
        process.stdout.write(diff.stdout);
        wrote = true;
      }
    }
    if (!wrote) console.log("Wiki working copy is clean.");
  });
}

export async function wikiMove(
  options: CliOptions,
  projectId: string | null,
  ref: string,
  destination: string,
): Promise<void> {
  const paths = wikiPaths(options);
  await withWikiLock(paths, async () => {
    const manifest = projectId ? requireManifest(paths, projectId) : readManifest(paths);
    const repositoryManifest = readRepositoryWikiManifest(paths);
    const projectMatches = manifest?.docs.filter((entry) =>
      entry.id === ref || entry.slug === ref || entry.path === ref || entry.movedTo === ref
    ) ?? [];
    const repositoryMatches = repositoryManifest?.docs.filter((entry) => {
      const repositoryPath = entry.path.split("/").slice(1).join("/");
      return entry.id === ref || entry.path === ref || entry.movedTo === ref || repositoryPath === ref;
    }) ?? [];
    if (projectMatches.length + repositoryMatches.length !== 1) {
      throw new Error(projectMatches.length + repositoryMatches.length === 0
        ? `Wiki page not found: ${ref}`
        : `Wiki page reference is ambiguous: ${ref}`);
    }

    if (projectMatches.length === 1 && manifest) {
      const entry = projectMatches[0]!;
      const nextPath = normalizeProjectWorkingPath(destination);
      if (manifest.docs.some((candidate) => candidate.id !== entry.id && (candidate.path === nextPath || candidate.movedTo === nextPath))) {
        throw new Error(`Wiki destination already exists: ${nextPath}`);
      }
      moveRegularFile(paths, paths.wiki, entry.movedTo ?? entry.path, nextPath, "Wiki page");
      entry.movedTo = nextPath;
      writeManifest(paths, manifest);
      printJson({ moved: true, kind: "project", id: entry.id, slug: entry.slug, from: entry.path, to: nextPath });
      return;
    }

    const entry = repositoryMatches[0]!;
    const repository = repositoryManifest!.repositories.find((candidate) => candidate.id === entry.repositoryId)!;
    const normalized = normalizeWikiPath(destination);
    const nextPath = normalized.startsWith(`${repository.directory}/`)
      ? normalized
      : `${repository.directory}/${normalized}`;
    if (!validRepositoryManifestPath(nextPath)) throw new Error(`Unsafe Repository Wiki path: ${destination}`);
    if (repositoryManifest!.docs.some((candidate) => candidate.id !== entry.id && (candidate.path === nextPath || candidate.movedTo === nextPath))) {
      throw new Error(`Wiki destination already exists: ${nextPath}`);
    }
    moveRegularFile(paths, repositoryWikiRoot(paths), entry.movedTo ?? entry.path, nextPath, "Repository Wiki page");
    entry.movedTo = nextPath;
    writeRepositoryManifest(paths, repositoryManifest!);
    printJson({ moved: true, kind: "repository", id: entry.id, repository_id: entry.repositoryId, from: entry.path, to: nextPath });
  });
}

export async function wikiPush(options: CliOptions, projectId: string | null): Promise<void> {
  const paths = wikiPaths(options);
  await withWikiLock(paths, async () => {
    const sourceRevision = rawStringOption(options, "source-revision", "sourceRevision")?.trim()
      || process.env.MULTIREMI_SCM_REVISION?.trim()
      || null;
    const manifest = projectId ? requireManifest(paths, projectId) : null;
    const remote = projectId ? await fetchWikiDocs(projectId, options) : [];
    const plan = manifest
      ? buildPushPlan(paths, manifest, remote)
      : { actions: [], conflicts: [] } satisfies PushPlan;
    const repositoryState = await repositoryWorkingCopyState(paths, options);
    if (!manifest && !repositoryState.manifest) {
      throw new Error("Wiki working copy is not initialized; specify --project or run inside an Issue workspace with Repository Wiki context");
    }
    const repositoryPlan = repositoryState.manifest
      ? buildRepositoryPushPlan(paths, repositoryState.manifest, repositoryState.remoteByRepository)
      : { actions: [], conflicts: [] } satisfies RepositoryPushPlan;
    clearConflicts(paths);
    if (plan.conflicts.length || repositoryPlan.conflicts.length) {
      ensureSafeDirectory(paths.root, paths.conflicts);
      for (const conflict of plan.conflicts) {
        if (conflict.body !== undefined) writeAtomic(paths, join(paths.conflicts, conflict.path), conflict.body);
      }
      for (const conflict of repositoryPlan.conflicts) {
        if (conflict.body !== undefined) writeAtomic(paths, join(paths.conflicts, "repositories", conflict.path), conflict.body);
      }
      printJson({
        pushed: false,
        project_id: projectId,
        conflicts: plan.conflicts,
        repository_conflicts: repositoryPlan.conflicts,
        conflict_directory: paths.conflicts,
      });
      throw new Error("Wiki push stopped because the local and remote versions conflict; resolve the files and retry");
    }

    for (const action of plan.actions) {
      if (!projectId) throw new Error("Project Wiki changes require --project");
      if (action.kind === "create") {
        const body: Record<string, unknown> = {
          kind: "wiki",
          slug: action.slug,
          path: action.path,
          title: wikiTitle(action.slug, action.body),
          body: apiBody(action.body),
        };
        const taskId = process.env.MULTIREMI_TASK_ID?.trim();
        if (taskId) body.source_task_id = taskId;
        await multiremiApiRequest("POST", `/api/projects/${encodeURIComponent(projectId)}/docs`, body, options);
        continue;
      }
      if (action.kind === "update") {
        await multiremiApiRequest(
          "PUT",
          `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(action.slug)}`,
          { path: action.path, body: apiBody(action.body), expected_version: action.version },
          options,
        );
        continue;
      }
      await multiremiApiRequest(
        "DELETE",
        `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(action.slug)}?expected_version=${action.version}`,
        undefined,
        options,
      );
    }

    for (const action of repositoryPlan.actions) {
      const root = `/api/workspaces/${encodeURIComponent(repositoryState.manifest!.workspaceId)}/repos/${encodeURIComponent(action.repositoryId)}/wiki`;
      if (action.kind === "create") {
        const body: Record<string, unknown> = {
          path: action.repositoryPath,
          title: wikiTitle(action.repositoryPath.replace(/\.md$/i, ""), action.body),
          body: apiBody(action.body),
          status: "healthy",
        };
        if (sourceRevision) body.source_revision = sourceRevision;
        const taskId = process.env.MULTIREMI_TASK_ID?.trim();
        if (taskId) body.source_task_id = taskId;
        await multiremiApiRequest("POST", root, body, options);
      } else if (action.kind === "update") {
        await multiremiApiRequest("PUT", `${root}/${encodeURIComponent(action.id)}`, {
          path: action.repositoryPath,
          body: apiBody(action.body),
          expected_version: action.version,
          status: "healthy",
          ...(sourceRevision ? { source_revision: sourceRevision } : {}),
        }, options);
      } else {
        await multiremiApiRequest(
          "DELETE",
          `${root}/${encodeURIComponent(action.id)}?expected_version=${action.version}`,
          undefined,
          options,
        );
      }
    }

    if (projectId && manifest) {
      const refreshed = await fetchWikiDocs(projectId, options);
      reconcileAfterPush(paths, projectId, refreshed, plan);
    }
    if (repositoryState.manifest) {
      const refreshedRepositories = await fetchRepositoryWikiDocs(repositoryState.manifest, options);
      reconcileRepositoryAfterPush(paths, repositoryState.manifest, refreshedRepositories, repositoryPlan);
    }
    printJson({
      pushed: true,
      project_id: projectId,
      created: plan.actions.filter((action) => action.kind === "create").length,
      updated: plan.actions.filter((action) => action.kind === "update").length,
      deleted: plan.actions.filter((action) => action.kind === "delete").length,
      repository_created: repositoryPlan.actions.filter((action) => action.kind === "create").length,
      repository_updated: repositoryPlan.actions.filter((action) => action.kind === "update").length,
      repository_deleted: repositoryPlan.actions.filter((action) => action.kind === "delete").length,
    });
  });
}

function workingCopyStatus(paths: WikiPaths, manifest: WikiManifest, remoteDocs: WikiDoc[]): WikiChange[] {
  const remoteById = new Map(remoteDocs.map((doc) => [doc.id, doc]));
  const remoteBySlug = new Map(remoteDocs.map((doc) => [doc.slug, doc]));
  const localPaths = localMarkdownPaths(paths);
  const moveTargets = detectProjectMoveTargets(paths, manifest, localPaths);
  const trackedPaths = new Set(manifest.docs.flatMap((entry) => [entry.path, moveTargets.get(entry.id)].filter((path): path is string => Boolean(path))));
  const changes: WikiChange[] = [];
  for (const entry of manifest.docs) {
    const base = readVerifiedBase(paths, entry);
    const localPath = moveTargets.get(entry.id) ?? entry.path;
    const moved = localPath !== entry.path;
    const local = readLocalText(paths, localPath);
    const remote = remoteById.get(entry.id) ?? remoteBySlug.get(entry.slug);
    const remoteText = remote ? markdownFile(remote.body) : null;
    const localChanged = local !== base;
    const remoteChanged = remoteText !== base || Boolean(remote && remote.path !== entry.path);
    let state: WikiChange["state"] = "unchanged";
    if (local === null && base !== null) state = remoteChanged ? "diverged" : "deleted";
    else if (localChanged && remoteChanged && local !== remoteText) state = "diverged";
    else if (moved || localChanged) state = "modified";
    else if (remoteChanged) state = "remote_changed";
    changes.push({ slug: entry.slug, path: localPath, state, localChanged: localChanged || moved, remoteChanged });
  }
  for (const path of localPaths) {
    if (trackedPaths.has(path)) continue;
    changes.push({ slug: slugFromPath(path), path, state: "added", localChanged: true, remoteChanged: false });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function buildPushPlan(paths: WikiPaths, manifest: WikiManifest, remoteDocs: WikiDoc[]): PushPlan {
  const remoteById = new Map(remoteDocs.map((doc) => [doc.id, doc]));
  const remoteBySlug = new Map(remoteDocs.map((doc) => [doc.slug, doc]));
  const localPaths = localMarkdownPaths(paths);
  const moveTargets = detectProjectMoveTargets(paths, manifest, localPaths);
  const trackedPaths = new Set(manifest.docs.flatMap((entry) => [entry.path, moveTargets.get(entry.id)].filter((path): path is string => Boolean(path))));
  const actions: PushAction[] = [];
  const conflicts: PushPlan["conflicts"] = [];

  for (const entry of manifest.docs) {
    const base = readVerifiedBase(paths, entry);
    const localPath = moveTargets.get(entry.id) ?? entry.path;
    const moved = localPath !== entry.path;
    const local = readLocalText(paths, localPath);
    const remote = remoteById.get(entry.id) ?? remoteBySlug.get(entry.slug);
    const targetPath = moved ? localPath : remote?.path ?? entry.path;
    const remoteText = remote ? markdownFile(remote.body) : null;
    if (local === base && !moved) continue;
    if (local === null) {
      if (remoteText === null) continue;
      if (remoteText === base) {
        actions.push({ kind: "delete", slug: remote!.slug, path: entry.path, version: remote!.version, localSnapshot: null });
      } else {
        conflicts.push({ slug: entry.slug, path: entry.path, reason: "delete/modify" });
      }
      continue;
    }
    if (remoteText === local && (!moved || remote?.path === localPath)) continue;
    if (remoteText === base && remote) {
      actions.push({ kind: "update", id: remote.id, slug: remote.slug, path: targetPath, previousPath: entry.path, version: remote.version, body: local, localSnapshot: local });
      continue;
    }
    if (remoteText === null) {
      conflicts.push({ slug: entry.slug, path: entry.path, reason: "modify/delete", body: conflictBody(local, base, "") });
      continue;
    }
    const merged = mergeMarkdown(local, base, remoteText);
    if (merged.conflicted) {
      conflicts.push({ slug: entry.slug, path: entry.path, reason: "content conflict", body: merged.body });
    } else {
      actions.push({ kind: "update", id: remote!.id, slug: remote!.slug, path: targetPath, previousPath: entry.path, version: remote!.version, body: merged.body, localSnapshot: local });
    }
  }

  const usedSlugs = new Set(remoteDocs.map((doc) => doc.slug));
  for (const path of localPaths) {
    if (trackedPaths.has(path)) continue;
    const slug = uniqueSlugFromPath(path, usedSlugs);
    usedSlugs.add(slug);
    const local = readLocalText(paths, path) ?? "";
    const remote = remoteBySlug.get(slug);
    if (!remote) {
      actions.push({ kind: "create", slug, path, body: local, localSnapshot: local });
    } else if (markdownFile(remote.body) !== local) {
      conflicts.push({ slug, path, reason: "add/add", body: conflictBody(local, "", markdownFile(remote.body)) });
    }
  }
  return { actions, conflicts };
}

async function repositoryWorkingCopyState(
  paths: WikiPaths,
  options: CliOptions,
): Promise<{
  manifest: RepositoryWikiManifest | null;
  remoteByRepository: Map<string, RepositoryWikiDoc[]>;
  changes: Array<{ repository_id: string; path: string; state: WikiChange["state"] }>;
}> {
  const manifest = readRepositoryWikiManifest(paths);
  if (!manifest) return { manifest: null, remoteByRepository: new Map(), changes: [] };
  const remoteByRepository = await fetchRepositoryWikiDocs(manifest, options);
  const plan = buildRepositoryPushPlan(paths, manifest, remoteByRepository);
  const changes: Array<{ repository_id: string; path: string; state: WikiChange["state"] }> = plan.actions.map((action) => ({
    repository_id: action.repositoryId,
    path: action.path,
    state: action.kind === "create" ? "added" as const : action.kind === "delete" ? "deleted" as const : "modified" as const,
  }));
  changes.push(...plan.conflicts.map((conflict) => ({
    repository_id: conflict.repository_id,
    path: conflict.path,
    state: "diverged" as const,
  })));
  return { manifest, remoteByRepository, changes: changes.sort((left, right) => left.path.localeCompare(right.path)) };
}

function buildRepositoryPushPlan(
  paths: WikiPaths,
  manifest: RepositoryWikiManifest,
  remoteByRepository: Map<string, RepositoryWikiDoc[]>,
): RepositoryPushPlan {
  const remoteById = new Map([...remoteByRepository.values()].flat().map((doc) => [doc.id, doc]));
  const localPaths = repositoryMarkdownPaths(paths);
  const moveTargets = detectRepositoryMoveTargets(paths, manifest, localPaths);
  const trackedPaths = new Set(manifest.docs.flatMap((entry) => [entry.path, moveTargets.get(entry.id)].filter((path): path is string => Boolean(path))));
  const actions: RepositoryPushAction[] = [];
  const conflicts: RepositoryPushPlan["conflicts"] = [];

  for (const entry of manifest.docs) {
    const base = readRepositoryBase(paths, entry);
    const localPath = moveTargets.get(entry.id) ?? entry.path;
    const moved = localPath !== entry.path;
    const local = readRepositoryLocal(paths, localPath);
    const remote = remoteById.get(entry.id);
    const remoteText = remote ? markdownFile(remote.body) : null;
    if (local === base && !moved) continue;
    if (local === null) {
      if (remoteText === null) continue;
      if (remoteText === base) {
        actions.push({ kind: "delete", repositoryId: entry.repositoryId, id: entry.id, path: entry.path, version: remote!.version, localSnapshot: null });
      } else {
        conflicts.push({ repository_id: entry.repositoryId, path: entry.path, reason: "delete/modify" });
      }
      continue;
    }
    const repositoryPath = localPath.split("/").slice(1).join("/");
    if (remoteText === local && (!moved || remote?.path === repositoryPath)) continue;
    if (remoteText === base && remote) {
      actions.push({ kind: "update", repositoryId: entry.repositoryId, id: entry.id, path: localPath, previousPath: entry.path, repositoryPath, version: remote.version, body: local, localSnapshot: local });
      continue;
    }
    if (remoteText === null) {
      conflicts.push({ repository_id: entry.repositoryId, path: entry.path, reason: "modify/delete", body: conflictBody(local, base, "") });
      continue;
    }
    const merged = mergeMarkdown(local, base, remoteText);
    if (merged.conflicted) {
      conflicts.push({ repository_id: entry.repositoryId, path: entry.path, reason: "content conflict", body: merged.body });
    } else {
      actions.push({ kind: "update", repositoryId: entry.repositoryId, id: entry.id, path: localPath, previousPath: entry.path, repositoryPath, version: remote!.version, body: merged.body, localSnapshot: local });
    }
  }

  for (const path of localPaths) {
    if (trackedPaths.has(path)) continue;
    const repository = manifest.repositories.find((candidate) => path.startsWith(`${candidate.directory}/`));
    if (!repository) continue;
    const repositoryPath = path.slice(repository.directory.length + 1);
    const local = readRepositoryLocal(paths, path) ?? "";
    const remote = (remoteByRepository.get(repository.id) ?? []).find((doc) => doc.path === repositoryPath);
    if (!remote) {
      actions.push({ kind: "create", repositoryId: repository.id, path, repositoryPath, body: local, localSnapshot: local });
    } else if (markdownFile(remote.body) !== local) {
      conflicts.push({ repository_id: repository.id, path, reason: "add/add", body: conflictBody(local, "", markdownFile(remote.body)) });
    }
  }
  return { actions, conflicts };
}

async function fetchRepositoryWikiDocs(
  manifest: RepositoryWikiManifest,
  options: CliOptions,
): Promise<Map<string, RepositoryWikiDoc[]>> {
  const entries = await Promise.all(manifest.repositories.map(async (repository) => {
    const value = await multiremiApiRequest(
      "GET",
      `/api/workspaces/${encodeURIComponent(manifest.workspaceId)}/repos/${encodeURIComponent(repository.id)}/wiki`,
      undefined,
      options,
    );
    if (!isRecord(value) || !Array.isArray(value.docs)) throw new Error(`Repository Wiki response is invalid for ${repository.name}`);
    return [repository.id, value.docs.map((doc) => parseRepositoryWikiDoc(doc, repository.id))] as const;
  }));
  return new Map(entries);
}

function parseRepositoryWikiDoc(value: unknown, repositoryId: string): RepositoryWikiDoc {
  if (!isRecord(value)) throw new Error("Repository Wiki list contains an invalid document");
  const id = field(value, "id");
  const path = field(value, "path");
  const title = field(value, "title");
  if (!id || !path || !title || !validRepositoryRelativePath(path)) throw new Error("Repository Wiki document is missing id, path, or title");
  return {
    id,
    repositoryId,
    path,
    title,
    body: typeof value.body === "string" ? value.body : "",
    version: Math.max(1, Math.floor(Number(value.version) || 1)),
    sourceRevision: nullableField(value, "source_revision", "sourceRevision"),
    updatedAt: field(value, "updated_at", "updatedAt"),
  };
}

function reconcileRepositoryAfterPush(
  paths: WikiPaths,
  previous: RepositoryWikiManifest,
  remoteByRepository: Map<string, RepositoryWikiDoc[]>,
  plan: RepositoryPushPlan,
): void {
  const previousById = new Map(previous.docs.map((entry) => [entry.id, entry]));
  const actionByPath = new Map(plan.actions.map((action) => [action.path, action]));
  const updateActionById = new Map(plan.actions.filter((action): action is Extract<RepositoryPushAction, { kind: "update" }> => action.kind === "update").map((action) => [action.id, action]));
  const next: RepositoryWikiManifestEntry[] = [];
  const seen = new Set<string>();
  const baseRoot = repositoryBaseRoot(paths);
  const wikiRoot = repositoryWikiRoot(paths);
  ensureSafeDirectory(paths.root, baseRoot);
  ensureSafeDirectory(paths.root, wikiRoot);

  for (const repository of previous.repositories) {
    ensureSafeDirectory(paths.root, join(wikiRoot, repository.directory));
    for (const doc of remoteByRepository.get(repository.id) ?? []) {
      const prior = previousById.get(doc.id);
      const updateAction = updateActionById.get(doc.id);
      const path = updateAction?.path ?? `${repository.directory}/${doc.path}`;
      const action = updateAction ?? actionByPath.get(path);
      const local = readRepositoryLocal(paths, path);
      const remoteText = markdownFile(doc.body);
      const entry = repositoryManifestEntry(repository, doc, path, remoteText);
      if (!prior || (action && local === action.localSnapshot)) {
        writeAtomic(paths, join(wikiRoot, path), remoteText);
        writeReadOnly(paths, join(baseRoot, path), remoteText);
        if (prior && prior.path !== path) {
          rmWritable(paths, join(wikiRoot, prior.path));
          rmWritable(paths, join(baseRoot, prior.path));
        }
        next.push(entry);
      } else if (prior.movedTo) {
        next.push(prior);
      } else if (local === readRepositoryBase(paths, prior)) {
        if (prior.path !== path) {
          rmWritable(paths, join(wikiRoot, prior.path));
          rmWritable(paths, join(baseRoot, prior.path));
        }
        writeAtomic(paths, join(wikiRoot, path), remoteText);
        writeReadOnly(paths, join(baseRoot, path), remoteText);
        next.push(entry);
      } else {
        next.push(prior);
      }
      seen.add(doc.id);
    }
  }

  for (const prior of previous.docs) {
    if (seen.has(prior.id)) continue;
    const action = actionByPath.get(prior.path);
    if (action?.kind === "delete") {
      if (readRepositoryLocal(paths, prior.path) === null) rmWritable(paths, join(wikiRoot, prior.path));
      rmWritable(paths, join(baseRoot, prior.path));
      continue;
    }
    next.push(prior);
  }

  writeAtomic(paths, repositoryManifestPath(paths), `${JSON.stringify({
    ...previous,
    pulledAt: new Date().toISOString(),
    docs: next.sort((left, right) => left.path.localeCompare(right.path)),
  }, null, 2)}\n`);
}

function repositoryManifestEntry(
  repository: RepositoryWikiManifestRepository,
  doc: RepositoryWikiDoc,
  path: string,
  text: string,
): RepositoryWikiManifestEntry {
  return {
    id: doc.id,
    repositoryId: repository.id,
    repositoryName: repository.name,
    path,
    version: doc.version,
    sourceRevision: doc.sourceRevision,
    sha256: sha256(text),
    updatedAt: doc.updatedAt,
  };
}

function mergeMarkdown(local: string, base: string, remote: string): { body: string; conflicted: boolean } {
  const directory = mkdtempSync(join(tmpdir(), "multiremi-wiki-merge-"));
  try {
    const localPath = join(directory, "local.md");
    const basePath = join(directory, "base.md");
    const remotePath = join(directory, "remote.md");
    writeFileSync(localPath, local);
    writeFileSync(basePath, base);
    writeFileSync(remotePath, remote);
    const result = spawnSync(
      "git",
      ["merge-file", "-p", "-L", "local", "-L", "base", "-L", "remote", localPath, basePath, remotePath],
      { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    if (result.error) throw new Error(`git merge-file failed: ${result.error.message}`);
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git merge-file failed: ${result.stderr || `exit ${result.status}`}`);
    }
    return { body: result.stdout, conflicted: result.status === 1 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function reconcileWorkingCopy(paths: WikiPaths, projectId: string, remoteDocs: WikiDoc[], force: boolean): WikiManifest {
  ensureSafeDirectory(paths.root, paths.wiki);
  ensureSafeDirectory(paths.root, paths.baseFiles);
  const previous = readManifest(paths);
  if (previous && previous.projectId !== projectId) {
    throw new Error(`Wiki working copy belongs to ${previous.projectId}, not ${projectId}`);
  }
  const previousById = new Map(previous?.docs.map((entry) => [entry.id, entry]) ?? []);
  const previousBySlug = new Map(previous?.docs.map((entry) => [entry.slug, entry]) ?? []);
  const matchedPriorPaths = new Set<string>();
  const docs: WikiManifestEntry[] = [];
  for (const remote of remoteDocs) {
    const prior = previousById.get(remote.id) ?? previousBySlug.get(remote.slug);
    if (prior) matchedPriorPaths.add(prior.path);
    const path = remote.path;
    const localPath = prior?.movedTo ?? prior?.path ?? path;
    const basePath = join(paths.baseFiles, prior?.path ?? path);
    const remoteText = markdownFile(remote.body);
    const entry = manifestEntry(remote, path, remoteText);
    const local = readLocalText(paths, localPath);
    if (!prior) {
      if (force || local === null) writeAtomic(paths, join(paths.wiki, path), remoteText);
      writeReadOnly(paths, join(paths.baseFiles, path), remoteText);
      docs.push(entry);
      continue;
    }
    const base = force ? readRegularText(paths.root, basePath, "Wiki baseline") : readVerifiedBase(paths, prior);
    if (prior.movedTo) {
      docs.push(prior);
      continue;
    }
    const pathChanged = prior.path !== path;
    if (force || local === base) {
      if (pathChanged) {
        rmWritable(paths, join(paths.wiki, prior.path));
        rmWritable(paths, join(paths.baseFiles, prior.path));
      }
      writeAtomic(paths, join(paths.wiki, path), remoteText);
      writeReadOnly(paths, join(paths.baseFiles, path), remoteText);
      docs.push(entry);
      continue;
    }
    docs.push(prior);
  }
  for (const prior of previous?.docs ?? []) {
    if (matchedPriorPaths.has(prior.path)) continue;
    const localPath = join(paths.wiki, prior.path);
    const basePath = join(paths.baseFiles, prior.path);
    const local = readLocalText(paths, prior.path);
    const base = force ? readRegularText(paths.root, basePath, "Wiki baseline") : readVerifiedBase(paths, prior);
    if (!force && local !== base) {
      docs.push(prior);
      continue;
    }
    rmWritable(paths, localPath);
    rmWritable(paths, basePath);
  }
  return writeManifest(paths, {
    version: 1,
    projectId,
    workspaceId: remoteDocs[0]?.workspaceId ?? previous?.workspaceId ?? process.env.MULTIREMI_WORKSPACE_ID ?? "",
    pulledAt: new Date().toISOString(),
    docs: docs.sort((a, b) => a.slug.localeCompare(b.slug)),
  });
}

function reconcileAfterPush(paths: WikiPaths, projectId: string, remoteDocs: WikiDoc[], plan: PushPlan): WikiManifest {
  ensureSafeDirectory(paths.root, paths.wiki);
  ensureSafeDirectory(paths.root, paths.baseFiles);
  const previous = requireManifest(paths, projectId);
  const previousById = new Map(previous.docs.map((entry) => [entry.id, entry]));
  const previousBySlug = new Map(previous.docs.map((entry) => [entry.slug, entry]));
  const actionsByPath = new Map(plan.actions.map((action) => [action.path, action]));
  const updateActionsById = new Map(plan.actions.filter((action): action is Extract<PushAction, { kind: "update" }> => action.kind === "update").map((action) => [action.id, action]));
  const matchedPriorPaths = new Set<string>();
  const docs: WikiManifestEntry[] = [];

  for (const remote of remoteDocs) {
    const prior = previousById.get(remote.id) ?? previousBySlug.get(remote.slug);
    if (prior) matchedPriorPaths.add(prior.path);
    const updateAction = updateActionsById.get(remote.id);
    const path = updateAction?.path ?? remote.path;
    const local = readLocalText(paths, path);
    const remoteText = markdownFile(remote.body);
    const entry = manifestEntry(remote, path, remoteText);
    const action = updateAction ?? actionsByPath.get(path);
    if (!prior) {
      if ((!action && local === null) || (action && local === action.localSnapshot)) {
        writeAtomic(paths, join(paths.wiki, path), remoteText);
      }
      writeReadOnly(paths, join(paths.baseFiles, path), remoteText);
      docs.push(entry);
      continue;
    }

    const base = readVerifiedBase(paths, prior);
    if (action?.kind === "update") {
      if (local === action.localSnapshot) {
        writeAtomic(paths, join(paths.wiki, path), remoteText);
        writeReadOnly(paths, join(paths.baseFiles, path), remoteText);
        if (prior.path !== path) {
          rmWritable(paths, join(paths.wiki, prior.path));
          rmWritable(paths, join(paths.baseFiles, prior.path));
        }
        docs.push(entry);
      } else {
        // Another process edited this file while the push was in flight. Keep
        // the old merge base so the next push can reconcile all three versions.
        docs.push(prior);
      }
      continue;
    }
    if (local === base) {
      writeAtomic(paths, join(paths.wiki, path), remoteText);
      writeReadOnly(paths, join(paths.baseFiles, path), remoteText);
      docs.push(entry);
    } else {
      docs.push(prior);
    }
  }

  for (const prior of previous.docs) {
    if (matchedPriorPaths.has(prior.path)) continue;
    const action = actionsByPath.get(prior.path);
    const localPath = join(paths.wiki, prior.path);
    const basePath = join(paths.baseFiles, prior.path);
    const local = readLocalText(paths, prior.path);
    if (action?.kind === "delete") {
      // A file recreated while DELETE was in flight is a new, untracked page.
      // Preserve it, but retire the deleted document's baseline and identity.
      if (local === null) rmWritable(paths, localPath);
      rmWritable(paths, basePath);
      continue;
    }
    if (action) {
      // The just-written remote page disappeared before refresh. Retain the
      // old state so a later push reports a normal modify/delete conflict.
      readVerifiedBase(paths, prior);
      docs.push(prior);
      continue;
    }
    const base = readVerifiedBase(paths, prior);
    if (local !== base) {
      docs.push(prior);
      continue;
    }
    rmWritable(paths, localPath);
    rmWritable(paths, basePath);
  }

  return writeManifest(paths, {
    version: 1,
    projectId,
    workspaceId: remoteDocs[0]?.workspaceId ?? previous.workspaceId,
    pulledAt: new Date().toISOString(),
    docs: docs.sort((a, b) => a.slug.localeCompare(b.slug)),
  });
}

async function fetchWikiDocs(projectId: string, options: CliOptions): Promise<WikiDoc[]> {
  const value = await multiremiApiRequest(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/docs?kind=wiki`,
    undefined,
    options,
  );
  if (!isRecord(value) || !Array.isArray(value.docs)) throw new Error("Wiki list response is invalid");
  return value.docs.map(parseWikiDoc).sort((a, b) => a.slug.localeCompare(b.slug));
}

function parseWikiDoc(value: unknown): WikiDoc {
  if (!isRecord(value)) throw new Error("Wiki list contains an invalid document");
  const id = field(value, "id");
  const projectId = field(value, "project_id", "projectId");
  const workspaceId = field(value, "workspace_id", "workspaceId");
  const slug = field(value, "slug");
  const rawPath = field(value, "path") || `${safeSlug(slug)}.md`;
  const title = field(value, "title");
  if (!id || !projectId || !slug || !title) throw new Error("Wiki document is missing id, project, slug, or title");
  return {
    id,
    projectId,
    workspaceId,
    slug,
    path: normalizeProjectWorkingPath(rawPath),
    title,
    summary: nullableField(value, "summary"),
    body: typeof value.body === "string" ? value.body : "",
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
    pinned: value.pinned === true || Number(value.pinned) === 1,
    refs: Array.isArray(value.refs) ? value.refs.flatMap(parseRef) : [],
    version: Math.max(1, Math.floor(Number(value.version) || 1)),
    updatedAt: field(value, "updated_at", "updatedAt"),
  };
}

function parseRef(value: unknown): Array<{ type: string; value: string }> {
  if (!isRecord(value)) return [];
  const type = field(value, "type");
  const ref = field(value, "value");
  return type && ref ? [{ type, value: ref }] : [];
}

function manifestEntry(doc: WikiDoc, path: string, text: string): WikiManifestEntry {
  return {
    id: doc.id,
    slug: doc.slug,
    path,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags,
    pinned: doc.pinned,
    refs: doc.refs,
    version: doc.version,
    sha256: sha256(text),
    updatedAt: doc.updatedAt,
  };
}

function wikiPaths(options: CliOptions): WikiPaths {
  const workspaceRoot = resolve(process.env.MULTIREMI_WORKSPACE_ROOT?.trim() || process.cwd());
  const rawDirectory = rawStringOption(options, "dir")?.trim();
  const wiki = rawDirectory
    ? resolve(isAbsolute(rawDirectory) ? rawDirectory : join(workspaceRoot, rawDirectory))
    : join(workspaceRoot, "wiki");
  if (!isWithin(workspaceRoot, wiki)) {
    throw new Error("--dir must stay inside the Issue workspace");
  }
  const base = join(workspaceRoot, ".multiremi", "wiki-base");
  return {
    root: workspaceRoot,
    wiki,
    base,
    baseFiles: join(base, "files"),
    conflicts: join(workspaceRoot, ".multiremi", "wiki-conflicts"),
    manifest: join(base, "manifest.json"),
    lock: join(workspaceRoot, ".multiremi", "wiki.lock"),
  };
}

function requireManifest(paths: WikiPaths, projectId: string): WikiManifest {
  const manifest = readManifest(paths);
  if (!manifest) throw new Error("Wiki working copy is not initialized; run remi wiki pull first");
  if (manifest.projectId !== projectId) throw new Error(`Wiki working copy belongs to ${manifest.projectId}, not ${projectId}`);
  return manifest;
}

function readManifest(paths: WikiPaths): WikiManifest | null {
  const text = readRegularText(paths.root, paths.manifest, "Wiki manifest");
  if (text === null) return null;
  let value: Partial<WikiManifest>;
  try {
    value = JSON.parse(text) as Partial<WikiManifest>;
  } catch (error) {
    throw new Error(`Wiki manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value.version !== 1 || typeof value.projectId !== "string" || !Array.isArray(value.docs)) {
    throw new Error("Wiki manifest has an unsupported or incomplete schema");
  }
  const pathsSeen = new Set<string>();
  const idsSeen = new Set<string>();
  for (const entry of value.docs) {
    if (
      !entry
      || typeof entry.id !== "string"
      || !entry.id
      || typeof entry.slug !== "string"
      || !entry.slug
      || !validManifestPath(entry.path)
      || (entry.movedTo !== undefined && !validManifestPath(entry.movedTo))
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Wiki manifest contains an invalid entry");
    }
    if (pathsSeen.has(entry.path) || idsSeen.has(entry.id)) {
      throw new Error("Wiki manifest contains duplicate document identities or paths");
    }
    pathsSeen.add(entry.path);
    if (entry.movedTo) {
      if (pathsSeen.has(entry.movedTo)) throw new Error("Wiki manifest contains duplicate document identities or paths");
      pathsSeen.add(entry.movedTo);
    }
    idsSeen.add(entry.id);
  }
  return value as WikiManifest;
}

function repositoryWikiRoot(paths: WikiPaths): string {
  return join(paths.wiki, "repositories");
}

function repositoryBaseRoot(paths: WikiPaths): string {
  return join(paths.base, "repositories", "files");
}

function repositoryManifestPath(paths: WikiPaths): string {
  return join(paths.base, "repositories", "manifest.json");
}

function readRepositoryWikiManifest(paths: WikiPaths): RepositoryWikiManifest | null {
  const text = readRegularText(paths.root, repositoryManifestPath(paths), "Repository Wiki manifest");
  if (text === null) return null;
  let value: Partial<RepositoryWikiManifest>;
  try {
    value = JSON.parse(text) as Partial<RepositoryWikiManifest>;
  } catch (error) {
    throw new Error(`Repository Wiki manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value.version !== 1 || typeof value.workspaceId !== "string" || !value.workspaceId || !Array.isArray(value.repositories) || !Array.isArray(value.docs)) {
    throw new Error("Repository Wiki manifest has an unsupported or incomplete schema");
  }
  const repositoryIds = new Set<string>();
  const directories = new Set<string>();
  for (const repository of value.repositories) {
    if (!repository?.id || !repository.name || !validRepositoryDirectory(repository.directory)) {
      throw new Error("Repository Wiki manifest contains an invalid repository");
    }
    if (repositoryIds.has(repository.id) || directories.has(repository.directory)) {
      throw new Error("Repository Wiki manifest contains duplicate repositories or directories");
    }
    repositoryIds.add(repository.id);
    directories.add(repository.directory);
  }
  const docIds = new Set<string>();
  const docPaths = new Set<string>();
  for (const entry of value.docs) {
    if (
      !entry?.id
      || !repositoryIds.has(entry.repositoryId)
      || !validRepositoryManifestPath(entry.path)
      || (entry.movedTo !== undefined && !validRepositoryManifestPath(entry.movedTo))
      || !directories.has(entry.path.split("/")[0] ?? "")
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || docIds.has(entry.id)
      || docPaths.has(entry.path)
    ) {
      throw new Error("Repository Wiki manifest contains an invalid or duplicate document");
    }
    docIds.add(entry.id);
    docPaths.add(entry.path);
    if (entry.movedTo) {
      if (docPaths.has(entry.movedTo)) throw new Error("Repository Wiki manifest contains an invalid or duplicate document");
      docPaths.add(entry.movedTo);
    }
  }
  return value as RepositoryWikiManifest;
}

function validRepositoryDirectory(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function validRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeWikiPath(value) === value;
  } catch {
    return false;
  }
}

function validRepositoryManifestPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [directory, ...rest] = value.split("/");
  return validRepositoryDirectory(directory) && rest.length > 0 && validRepositoryRelativePath(rest.join("/"));
}

function readRepositoryLocal(paths: WikiPaths, path: string): string | null {
  if (!validRepositoryManifestPath(path)) throw new Error(`Unsafe Repository Wiki path: ${path}`);
  return readRegularText(paths.root, join(repositoryWikiRoot(paths), ...path.split("/")), "Repository Wiki page");
}

function readRepositoryBase(paths: WikiPaths, entry: RepositoryWikiManifestEntry): string {
  const value = readRegularText(paths.root, join(repositoryBaseRoot(paths), ...entry.path.split("/")), "Repository Wiki baseline");
  if (value === null) throw new Error(`Repository Wiki base is incomplete: ${entry.path}`);
  if (sha256(value) !== entry.sha256) throw new Error(`Repository Wiki baseline checksum mismatch: ${entry.path}`);
  return value;
}

function repositoryMarkdownPaths(paths: WikiPaths): string[] {
  const root = repositoryWikiRoot(paths);
  if (!existsSync(root)) return [];
  assertSafeDirectory(paths.root, root);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Repository Wiki path is a symbolic link: ${target}`);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !entry.name.startsWith(".")) {
        const path = relative(root, target).split("\\").join("/");
        if (!validRepositoryManifestPath(path)) throw new Error(`Unsafe Repository Wiki path: ${path}`);
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

function detectProjectMoveTargets(paths: WikiPaths, manifest: WikiManifest, localPaths: string[]): Map<string, string> {
  const targets = new Map<string, string>();
  const claimed = new Set<string>();
  for (const entry of manifest.docs) {
    if (!entry.movedTo) continue;
    if (!validManifestPath(entry.movedTo)) throw new Error(`Unsafe Wiki move destination: ${entry.movedTo}`);
    targets.set(entry.id, entry.movedTo);
    claimed.add(entry.movedTo);
  }
  const known = new Set(manifest.docs.flatMap((entry) => [entry.path, entry.movedTo].filter((path): path is string => Boolean(path))));
  const candidates = localPaths.filter((path) => !known.has(path));
  for (const entry of manifest.docs) {
    if (targets.has(entry.id) || readLocalText(paths, entry.path) !== null) continue;
    const base = readVerifiedBase(paths, entry);
    const matches = candidates.filter((path) => !claimed.has(path) && readLocalText(paths, path) === base);
    if (matches.length !== 1) continue;
    targets.set(entry.id, matches[0]!);
    claimed.add(matches[0]!);
  }
  return targets;
}

function detectRepositoryMoveTargets(
  paths: WikiPaths,
  manifest: RepositoryWikiManifest,
  localPaths: string[],
): Map<string, string> {
  const targets = new Map<string, string>();
  const claimed = new Set<string>();
  for (const entry of manifest.docs) {
    if (!entry.movedTo) continue;
    if (!validRepositoryManifestPath(entry.movedTo)) throw new Error(`Unsafe Repository Wiki move destination: ${entry.movedTo}`);
    targets.set(entry.id, entry.movedTo);
    claimed.add(entry.movedTo);
  }
  const known = new Set(manifest.docs.flatMap((entry) => [entry.path, entry.movedTo].filter((path): path is string => Boolean(path))));
  const candidates = localPaths.filter((path) => !known.has(path));
  for (const entry of manifest.docs) {
    if (targets.has(entry.id) || readRepositoryLocal(paths, entry.path) !== null) continue;
    const base = readRepositoryBase(paths, entry);
    const directory = entry.path.split("/")[0];
    const matches = candidates.filter((path) =>
      !claimed.has(path) && path.startsWith(`${directory}/`) && readRepositoryLocal(paths, path) === base
    );
    if (matches.length !== 1) continue;
    targets.set(entry.id, matches[0]!);
    claimed.add(matches[0]!);
  }
  return targets;
}

function validManifestPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeProjectWorkingPath(value) === value;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function localMarkdownPaths(paths: WikiPaths): string[] {
  if (!existsSync(paths.wiki)) return [];
  assertSafeDirectory(paths.root, paths.wiki);
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Wiki path is a symbolic link: ${target}`);
      if (entry.isDirectory()) {
        if (depth === 0 && entry.name === "repositories") continue;
        visit(target, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !entry.name.startsWith(".")) {
        const path = relative(paths.wiki, target).split("\\").join("/");
        if (!validManifestPath(path)) throw new Error(`Unsafe Wiki path: ${path}`);
        files.push(path);
      }
    }
  };
  visit(paths.wiki, 0);
  return files.sort();
}

function safeSlug(value: string): string {
  const slug = value.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/^\.+$/, "").slice(0, 160);
  return slug || `wiki-${sha256(value).slice(0, 12)}`;
}

function slugFromPath(path: string): string {
  return safeSlug(path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "");
}

function uniqueSlugFromPath(path: string, used: Set<string>): string {
  const base = slugFromPath(path);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a unique Wiki slug for ${path}`);
}

function normalizeProjectWorkingPath(value: unknown): string {
  const path = normalizeWikiPath(value);
  if (path === "repositories.md" || path.startsWith("repositories/")) {
    throw new Error("Project Wiki path uses the reserved repositories directory");
  }
  return path;
}

function wikiTitle(slug: string, body: string): string {
  const heading = body.split(/\r?\n/).map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim()).find(Boolean);
  return heading || slug.split(/[-_]+/).filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ") || slug;
}

function markdownFile(body: string): string {
  return `${body.replace(/[\r\n]+$/, "")}\n`;
}

function apiBody(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

function conflictBody(local: string, base: string, remote: string): string {
  return `<<<<<<< local\n${local.replace(/\n?$/, "\n")}||||||| base\n${base.replace(/\n?$/, "\n")}=======\n${remote.replace(/\n?$/, "\n")}>>>>>>> remote\n`;
}

function field(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function nullableField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === null) return null;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readLocalText(paths: WikiPaths, path: string): string | null {
  if (!validManifestPath(path)) throw new Error(`Unsafe Wiki path: ${path}`);
  return readRegularText(paths.root, join(paths.wiki, path), "Wiki page");
}

function readVerifiedBase(paths: WikiPaths, entry: WikiManifestEntry): string {
  const value = readRegularText(paths.root, join(paths.baseFiles, entry.path), "Wiki baseline");
  if (value === null) {
    throw new Error(`Wiki base is incomplete: ${entry.path}; preserve local edits before rebuilding it`);
  }
  if (sha256(value) !== entry.sha256) {
    throw new Error(`Wiki baseline checksum mismatch: ${entry.path}; refusing to merge with a modified base`);
  }
  return value;
}

function readRegularText(root: string, path: string, label: string): string | null {
  assertSafeAncestors(root, path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
}

function writeReadOnly(paths: WikiPaths, path: string, value: string): void {
  assertSafeFileTarget(paths.root, path);
  if (existsSync(path)) chmodSync(path, 0o644);
  writeAtomic(paths, path, value);
  chmodSync(path, 0o444);
}

function writeAtomic(paths: WikiPaths, path: string, value: string): void {
  assertSafeFileTarget(paths.root, path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tempPath, value, { mode: 0o644, flag: "wx" });
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function moveRegularFile(paths: WikiPaths, root: string, from: string, to: string, label: string): void {
  const source = join(root, ...from.split("/"));
  const destination = join(root, ...to.split("/"));
  if (source === destination) return;
  if (readRegularText(paths.root, source, label) === null) throw new Error(`${label} not found: ${from}`);
  assertSafeFileTarget(paths.root, destination);
  if (existsSync(destination)) throw new Error(`Wiki destination already exists: ${to}`);
  renameSync(source, destination);
}

function rmWritable(paths: WikiPaths, path: string): void {
  assertSafeFileTarget(paths.root, path);
  if (!existsSync(path)) return;
  chmodSync(path, 0o644);
  rmSync(path, { force: true });
}

function emptyFile(paths: WikiPaths, name: string): string {
  const path = join(paths.base, name);
  if (!existsSync(path)) writeAtomic(paths, path, "");
  return path;
}

function clearConflicts(paths: WikiPaths): void {
  if (!existsSync(paths.conflicts)) return;
  assertSafeDirectory(paths.root, paths.conflicts);
  rmSync(paths.conflicts, { recursive: true, force: true });
}

function writeManifest(paths: WikiPaths, manifest: WikiManifest): WikiManifest {
  writeAtomic(paths, paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function writeRepositoryManifest(paths: WikiPaths, manifest: RepositoryWikiManifest): RepositoryWikiManifest {
  writeAtomic(paths, repositoryManifestPath(paths), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function withWikiLock<T>(paths: WikiPaths, operation: () => Promise<T>): Promise<T> {
  ensureSafeDirectory(paths.root, dirname(paths.lock));
  if (existsSync(join(dirname(paths.lock), ".git"))) {
    throw new Error(`Reserved Multiremi directory is already a Git worktree: ${dirname(paths.lock)}`);
  }
  if (existsSync(paths.wiki)) {
    assertSafeDirectory(paths.root, paths.wiki);
    if (existsSync(join(paths.wiki, ".git"))) {
      throw new Error(`Reserved Wiki directory is already a Git worktree: ${paths.wiki}`);
    }
  }
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      mkdirSync(paths.lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      const stat = lstatSync(paths.lock);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Wiki lock is not a safe directory: ${paths.lock}`);
      }
      if (Date.now() - stat.mtimeMs > 60 * 60_000) {
        try {
          rmdirSync(paths.lock);
          continue;
        } catch {
          // A live owner may have just refreshed or released the lock.
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Wiki working-copy lock");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  try {
    return await operation();
  } finally {
    try {
      rmdirSync(paths.lock);
    } catch {
      // A missing lock is harmless; a future operation will validate the path.
    }
  }
}

function ensureSafeDirectory(root: string, target: string): void {
  if (!isWithin(root, target)) throw new Error(`Wiki path escapes the Issue workspace: ${target}`);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Issue workspace is not a safe directory: ${root}`);
  const rel = relative(root, target);
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o755 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki directory is unsafe: ${current}`);
  }
}

function assertSafeDirectory(root: string, target: string): void {
  assertSafeAncestors(root, join(target, ".sentinel"));
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki directory is unsafe: ${target}`);
}

function assertSafeFileTarget(root: string, path: string): void {
  ensureSafeDirectory(root, dirname(path));
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Wiki file target is unsafe: ${path}`);
}

function assertSafeAncestors(root: string, path: string): void {
  if (!isWithin(root, path)) throw new Error(`Wiki path escapes the Issue workspace: ${path}`);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Issue workspace is not a safe directory: ${root}`);
  const rel = relative(root, dirname(path));
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki path contains an unsafe directory: ${current}`);
  }
}

function isFsError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
