import { posix, win32 } from "node:path";
import { createId, nowIso } from "@multiremi/ids.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { parseJson } from "@multiremi/store/helpers.js";
import type { CreateRuntimeWorkspaceInput, MultiremiRuntimeWorkspace } from "@multiremi/contracts/types.js";

export class RuntimeWorkspaceError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

/** Directory contents, credentials and native agent context never enter this repository. */
export class RuntimeWorkspacesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(id: string): MultiremiRuntimeWorkspace | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_runtime_workspaces WHERE id = ?").get(id);
    return row ? hydrate(row as Record<string, unknown>) : null;
  }

  list(workspaceId: string, includeArchived = false): MultiremiRuntimeWorkspace[] {
    return (this.ctx.db.query(`SELECT * FROM multiremi_runtime_workspaces
      WHERE workspace_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY created_at DESC, id`).all(workspaceId) as Record<string, unknown>[]).map(hydrate);
  }

  require(id: string, workspaceId: string): MultiremiRuntimeWorkspace {
    const item = this.get(id);
    if (!item || item.workspaceId !== workspaceId) throw new RuntimeWorkspaceError("Runtime workspace not found", 404);
    if (item.archivedAt) throw new RuntimeWorkspaceError("Runtime workspace is archived", 409);
    return item;
  }

  create(runtimeId: string, input: CreateRuntimeWorkspaceInput): MultiremiRuntimeWorkspace {
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime?.daemonId) throw new RuntimeWorkspaceError("Runtime must have a stable daemon identity");
    const workspaceId = runtime.workspaceId ?? "local";
    const name = requiredText(input.name, "name", 120);
    const root = requiredText(input.root_path, "root_path", 4096);
    if (!posix.isAbsolute(root) && !win32.isAbsolute(root)) throw new RuntimeWorkspaceError("root_path must be absolute");
    const path = /^[a-z]:[\\/]/i.test(root) || root.startsWith("\\\\") ? win32 : posix;
    const rootPath = path.normalize(root);
    if (path.parse(rootPath).root === rootPath) throw new RuntimeWorkspaceError("root_path must not be a filesystem root");
    const cwd = relativePath(input.cwd ?? ".", "cwd");
    if (input.context_paths != null && (!Array.isArray(input.context_paths) || input.context_paths.length > 32)) {
      throw new RuntimeWorkspaceError("context_paths must be an array of at most 32 relative paths");
    }
    const contextPaths = [...new Set((input.context_paths ?? []).map(p => relativePath(p, "context_paths")))];
    const envFile = input.env_file ? relativePath(input.env_file, "env_file") : null;
    const projectId = input.project_id || null;
    if (projectId && this.ctx.projects().getProject(projectId)?.workspaceId !== workspaceId) {
      throw new RuntimeWorkspaceError("Project belongs to another workspace");
    }
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      // Exact paths are deduplicated here. The daemon additionally locks the
      // canonical real path, covering symlink aliases and case differences.
      const key = (value: string) => path === win32 ? path.normalize(value).toLowerCase() : path.normalize(value);
      const duplicate = this.list(workspaceId).some(w => w.daemonId === runtime.daemonId
        && key(path.resolve(w.rootPath, w.cwd)) === key(path.resolve(rootPath, cwd)));
      if (duplicate) throw new RuntimeWorkspaceError("This directory is already registered on the daemon", 409);
      const id = createId("rws");
      const now = nowIso();
      this.ctx.db.run(`INSERT INTO multiremi_runtime_workspaces
        (id, workspace_id, daemon_id, owner_id, name, root_path, cwd, context_paths,
         env_file, project_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, runtime.daemonId!, runtime.ownerId ?? "local", name, rootPath, cwd,
        JSON.stringify(contextPaths), envFile, projectId, now, now]);
      return this.get(id)!;
    })();
  }

  rename(id: string, name: string): MultiremiRuntimeWorkspace {
    const item = this.get(id);
    if (!item) throw new RuntimeWorkspaceError("Runtime workspace not found", 404);
    this.ctx.db.run("UPDATE multiremi_runtime_workspaces SET name = ?, updated_at = ? WHERE id = ?",
      [requiredText(name, "name", 120), nowIso(), id]);
    return this.get(id)!;
  }

  archive(id: string): MultiremiRuntimeWorkspace {
    return this.ctx.db.transaction(() => {
      const item = this.get(id);
      if (!item) throw new RuntimeWorkspaceError("Runtime workspace not found", 404);
      this.ctx.lockWorkspaceRuntimeLifecycle(item.workspaceId);
      const busy = this.ctx.db.query(`SELECT id FROM multiremi_tasks WHERE runtime_workspace_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`).get(id);
      if (busy) throw new RuntimeWorkspaceError("Finish or cancel tasks before archiving the runtime workspace", 409);
      this.ctx.db.run("UPDATE multiremi_runtime_workspaces SET archived_at = ?, updated_at = ? WHERE id = ?",
        [nowIso(), nowIso(), id]);
      return this.get(id)!;
    })();
  }

  /** Changing a directory after any execution would invalidate native sessions. */
  assertIssueBindingChange(issueId: string, nextId: string | null, workspaceId: string): void {
    this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
    if (nextId) this.require(nextId, workspaceId);
    if (this.ctx.db.query("SELECT id FROM multiremi_tasks WHERE issue_id = ? LIMIT 1").get(issueId)) {
      throw new RuntimeWorkspaceError("An executed Issue keeps its runtime workspace; create a new Issue to use another directory", 409);
    }
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new RuntimeWorkspaceError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function relativePath(value: unknown, field: string): string {
  const path = requiredText(value, field, 4096).replace(/\\/g, "/");
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || path.includes(":") || path.split("/").includes("..")) {
    throw new RuntimeWorkspaceError(`${field} must stay inside root_path`);
  }
  return posix.normalize(path);
}

function hydrate(row: Record<string, unknown>): MultiremiRuntimeWorkspace {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), daemonId: String(row.daemon_id),
    ownerId: String(row.owner_id), name: String(row.name), rootPath: String(row.root_path), cwd: String(row.cwd),
    contextPaths: parseJson<string[]>(row.context_paths, []), envFile: row.env_file ? String(row.env_file) : null,
    projectId: row.project_id ? String(row.project_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
