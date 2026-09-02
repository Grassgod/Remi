// Projects domain (projects, pinned items, project resources and project docs/wiki), extracted
// verbatim from MultiremiStore (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import {
  cleanOptionalString,
  clampSearchLimit,
  extractSearchSnippet,
  hasAnyField,
  nullableString,
  searchMatch,
  normalizeSearchQuery,
  searchRank,
  parseJson,
  toJson,
} from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { DaemonRetiredError } from "@multiremi/store/repos/daemon-retirement-repo.js";
import type {
  CreatePinnedItemInput,
  CreateProjectDocInput,
  CreateProjectDeviceInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  MultiremiAssigneeType,
  MultiremiPinnedItem,
  MultiremiPinnedItemType,
  MultiremiProject,
  MultiremiProjectDevice,
  MultiremiProjectDoc,
  MultiremiProjectDocIndexEntry,
  MultiremiProjectDocKind,
  MultiremiProjectDocRef,
  MultiremiProjectDocRevision,
  MultiremiProjectDocsIndex,
  MultiremiProjectResource,
  MultiremiProjectSearchResult,
  MultiremiWorkspaceProjectDoc,
  ReorderPinnedItemInput,
  ReplaceProjectDevicesInput,
  UpdateProjectDocInput,
  UpdateProjectInput,
  UpdateProjectResourceInput,
} from "@multiremi/contracts/types.js";
import { normalizeWikiPath } from "@multiremi/contracts/wiki-path";
import type { ProjectKnowledgeWriteControl } from "@multiremi/project-knowledge/types.js";

type Row = Record<string, unknown>;

export interface ProjectInstructionsWriteContext {
  instructionsUpdatedBy?: string | null;
}

export class ProjectInstructionsRevisionConflictError extends Error {
  readonly code = "project_instructions_revision_conflict";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super("Project instructions changed after they were loaded");
    this.name = "ProjectInstructionsRevisionConflictError";
  }
}

export const PROJECT_REF_MAX_DEPTH = 5;
const PROJECT_DOC_MEMORY_INDEX_LIMIT = 50;
const PROJECT_DOC_WIKI_INDEX_LIMIT = 100;
const PROJECT_DOC_INDEX_BODY_MAX = 500;
const PROJECT_DOC_INDEX_SUMMARY_MAX = 160;
const PROJECT_DOC_INDEX_SCHEMA_MAX = 1500;
const PROJECT_DOC_REFS_MAX = 20;
/** Reserved slug: the per-project doc that tells agents how to maintain the wiki. */
export const PROJECT_DOC_SCHEMA_SLUG = "_schema";
export const PROJECT_DOC_SCHEMA_TITLE = "Wiki Schema";
export const PROJECT_DOC_SCHEMA_TEMPLATE = `# Wiki Schema（本项目知识库维护规则）

本文档约束 agent 如何维护本项目的 wiki 与 memory，人和 agent 都可修订本文档。

## 分层
- 原始来源（Issue、Task、MR、commit、代码和人工材料）进入不可变 Raw；Raw 只作为待加工证据，不直接参与正式知识召回。
- Wiki 是从 Raw 归并出的长期知识：Repository Wiki 记录单仓库事实，Project Wiki 记录跨仓库架构、流程、决策与导航。
- Memory 只保存未来任务会反复使用的稳定环境事实、偏好和工作约定，不保存未整理素材、临时进度或代码事实。

## 维护纪律
- 每个非空 Wiki 必须维护两个非空根文件：\`index.md\` 是经过整理的阅读地图，\`log.md\` 是 Atlas 追加写入的加工记录。
- 除这两个根文件外，不预设 \`overview.md\`、固定目录、逐级目录入口或目录深度；页面和目录结构必须按项目语义形成，不要机械镜像来源路径或把目录前缀重复写进页面标题。
- 每次正式发布必须在同一批修改中更新受影响页面和 \`index.md\`，并在 \`log.md\` 末尾追加一条记录；不得覆盖或重写既有日志。
- \`log.md\` 每条记录至少包含日期、处理模式、仓库或项目、可用的 MR/Issue 与 revision、运行或 Task 标识、变更页面和变更原因。
- 写入前先用 \`remi wiki search\` / \`remi wiki get\` 查已有条目；能 update 就不要 create。
- 发现跨页重复时，把内容和全部 \`--ref\` 来源合并到权威页面；在平台支持软归档前，把旧页改成 superseded 跳转页并保留来源，不得硬删。
- 新事实与旧条目矛盾时：更新旧条目并在正文注明变化与依据（引用 issue/task），不要静默并存两个版本。
- 写入时用 --ref 引用来源（issue/task/url）；页面间用 [[slug]] 交叉链接。
- 一次性细节、只对当前 issue 有效的信息不要入库。
`;

export class ProjectsRepo {
  constructor(private ctx: StoreContext) {}

  createProject(input: CreateProjectInput, writeContext: ProjectInstructionsWriteContext = {}): MultiremiProject {
    if (!input.title?.trim()) throw new Error("Project title is required");
    const id = input.id ?? createId("prj");
    const now = nowIso();
    const status = input.status ?? "in_progress";
    const archivedAt = isArchivedProjectStatus(status) ? now : null;
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const instructions = normalizeProjectInstructions(input.instructions);
    const deltaInstructions = normalizeProjectInstructions(input.deltaInstructions ?? input.delta_instructions);
    const hasInstructions = instructions !== "" || deltaInstructions !== "";
    const defaultAssignee = this.resolveDefaultAssignee(
      input.defaultAssigneeType === undefined ? input.default_assignee_type : input.defaultAssigneeType,
      input.defaultAssigneeId === undefined ? input.default_assignee_id : input.defaultAssigneeId,
      workspaceId,
    );
    const resources = input.resources ?? [];
    const hasLocalDirectory = resources.some((resource) =>
      String(resource.resourceType ?? resource.resource_type ?? "").trim() === "local_directory"
    );
    const hasGitRepository = resources.some((resource) =>
      String(resource.resourceType ?? resource.resource_type ?? "").trim() === "github_repo"
    );
    const tx = this.ctx.db.transaction(() => {
      if (hasLocalDirectory) this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      else if (hasGitRepository) this.ctx.lockWorkspaceRepositoryTopology(workspaceId);
      const result = this.ctx.db.run(
        `INSERT INTO multiremi_projects (
          id, title, description, instructions, delta_instructions, instructions_revision,
          instructions_updated_at, instructions_updated_by, icon, status, priority, workspace_id,
          lead_type, lead_id, default_assignee_type, default_assignee_id,
          archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title.trim(),
          input.description ?? null,
          instructions,
          deltaInstructions,
          hasInstructions ? 1 : 0,
          hasInstructions ? now : null,
          hasInstructions ? nullableString(writeContext.instructionsUpdatedBy) : null,
          input.icon ?? null,
          status,
          input.priority ?? "none",
          workspaceId,
          input.leadType === undefined ? input.lead_type ?? null : input.leadType,
          input.leadId === undefined ? input.lead_id ?? null : input.leadId,
          defaultAssignee.assigneeType,
          defaultAssignee.assigneeId,
          archivedAt,
          now,
          now,
        ],
      );
      const project = this.getProject(id)!;
      for (const resource of resources) {
        this.createProjectResourceForProject(project, resource);
      }
      return this.getProject(id)!;
    });
    return tx();
  }

  getProject(id: string): MultiremiProject | null {
    const row = this.ctx.db.query(projectSelect("WHERE p.id = ?")).get(id) as Row | null;
    return row ? toProject(row) : null;
  }

  listProjects(workspaceId?: string | null): MultiremiProject[] {
    const rows = workspaceId
      ? this.ctx.db.query(projectSelect("WHERE p.workspace_id = ? ORDER BY p.updated_at DESC")).all(workspaceId) as Row[]
      : this.ctx.db.query(projectSelect("ORDER BY p.updated_at DESC")).all() as Row[];
    return rows.map(toProject);
  }

  searchProjects(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { projects: MultiremiProjectSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listProjects(workspaceId).filter((project) => {
      if (!includeClosed && project.archivedAt) return false;
      return searchMatch(project.title, query) || searchMatch(project.description ?? "", query);
    }).map((project) => {
      const matchSource = searchMatch(project.title, query) ? "title" : "description";
      const result: MultiremiProjectSearchResult = {
        ...project,
        matchSource,
      };
      if (matchSource === "description" && project.description) result.matchedSnippet = extractSearchSnippet(project.description, query);
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { projects: rows.slice(offset, offset + limit), total: rows.length };
  }

  updateProject(id: string, input: UpdateProjectInput, writeContext: ProjectInstructionsWriteContext = {}): MultiremiProject {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    const now = nowIso();
    const status = input.status ?? current.status;
    const archivedAt = input.status === undefined
      ? current.archivedAt
      : isArchivedProjectStatus(status) ? current.archivedAt ?? now : null;
    const instructions = input.instructions === undefined
      ? current.instructions
      : normalizeProjectInstructions(input.instructions);
    const deltaInstructionsInput = input.deltaInstructions === undefined
      ? input.delta_instructions
      : input.deltaInstructions;
    const deltaInstructions = deltaInstructionsInput === undefined
      ? current.deltaInstructions
      : normalizeProjectInstructions(deltaInstructionsInput);
    const instructionsChanged = instructions !== current.instructions
      || deltaInstructions !== current.deltaInstructions;
    const writesInstructions = input.instructions !== undefined || deltaInstructionsInput !== undefined;
    const expectedInstructionsRevision = input.expectedInstructionsRevision
      ?? input.expected_instructions_revision;
    if (
      writesInstructions
      && expectedInstructionsRevision !== undefined
      && expectedInstructionsRevision !== current.instructionsRevision
    ) {
      throw new ProjectInstructionsRevisionConflictError(
        expectedInstructionsRevision,
        current.instructionsRevision,
      );
    }
    const defaultAssigneeTypeInput = input.defaultAssigneeType === undefined ? input.default_assignee_type : input.defaultAssigneeType;
    const defaultAssigneeIdInput = input.defaultAssigneeId === undefined ? input.default_assignee_id : input.defaultAssigneeId;
    const defaultAssignee = defaultAssigneeTypeInput === undefined && defaultAssigneeIdInput === undefined
      ? { assigneeType: current.defaultAssigneeType, assigneeId: current.defaultAssigneeId }
      : this.resolveDefaultAssignee(defaultAssigneeTypeInput, defaultAssigneeIdInput, current.workspaceId);
    const assignments: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (input.title !== undefined) assign("title", input.title);
    if (input.description !== undefined) assign("description", input.description);
    if (writesInstructions) {
      assign("instructions", instructions);
      assign("delta_instructions", deltaInstructions);
      assign("instructions_revision", instructionsChanged ? current.instructionsRevision + 1 : current.instructionsRevision);
      assign("instructions_updated_at", instructionsChanged ? now : current.instructionsUpdatedAt);
      assign(
        "instructions_updated_by",
        instructionsChanged ? nullableString(writeContext.instructionsUpdatedBy) : current.instructionsUpdatedBy,
      );
    }
    if (input.icon !== undefined) assign("icon", input.icon);
    if (input.status !== undefined) {
      assign("status", status);
      assign("archived_at", archivedAt);
    }
    if (input.priority !== undefined) assign("priority", input.priority);
    if (input.leadType !== undefined || input.lead_type !== undefined) {
      assign("lead_type", input.leadType === undefined ? input.lead_type : input.leadType);
    }
    if (input.leadId !== undefined || input.lead_id !== undefined) {
      assign("lead_id", input.leadId === undefined ? input.lead_id : input.leadId);
    }
    if (defaultAssigneeTypeInput !== undefined || defaultAssigneeIdInput !== undefined) {
      assign("default_assignee_type", defaultAssignee.assigneeType);
      assign("default_assignee_id", defaultAssignee.assigneeId);
    }
    assign("updated_at", now);
    values.push(id);
    if (writesInstructions && expectedInstructionsRevision !== undefined) {
      values.push(expectedInstructionsRevision);
    }
    const result = this.ctx.db.run(
      `UPDATE multiremi_projects SET ${assignments.join(", ")}
       WHERE id = ?${writesInstructions && expectedInstructionsRevision !== undefined ? " AND instructions_revision = ?" : ""}`,
      values,
    );
    if (writesInstructions && expectedInstructionsRevision !== undefined && result.changes === 0) {
      const latest = this.getProject(id);
      throw new ProjectInstructionsRevisionConflictError(
        expectedInstructionsRevision,
        latest?.instructionsRevision ?? current.instructionsRevision,
      );
    }
    return this.getProject(id)!;
  }

  /**
   * Validates and canonicalizes the project's default assignee (agent, member
   * or squad — same polymorphic ref an issue assignee uses). Null when unset.
   */
  private resolveDefaultAssignee(
    type: MultiremiAssigneeType | null | undefined,
    id: string | null | undefined,
    workspaceId: string,
  ): { assigneeType: MultiremiAssigneeType | null; assigneeId: string | null } {
    const resolved = this.ctx.squads().resolveAssigneeRef(type ?? null, id ?? null, workspaceId);
    return resolved ?? { assigneeType: null, assigneeId: null };
  }

  archiveProject(id: string): MultiremiProject {
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.archivedAt) return project;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_projects SET archived_at = ?, status = 'cancelled', updated_at = ? WHERE id = ?",
      [now, now, id],
    );
    return this.getProject(id)!;
  }

  restoreProject(id: string): MultiremiProject {
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!project.archivedAt) return project;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_projects SET archived_at = NULL, status = 'in_progress', updated_at = ? WHERE id = ?",
      [now, id],
    );
    return this.getProject(id)!;
  }

  listPinnedItems(workspaceId?: string | null, userId?: string | null): MultiremiPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_pinned_items
       WHERE workspace_id = ? AND user_id = ?
       ORDER BY position ASC, created_at ASC`,
    ).all(resolvedWorkspaceId, resolvedUserId) as Row[];
    return rows.map(toPinnedItem);
  }

  createPinnedItem(input: CreatePinnedItemInput): MultiremiPinnedItem {
    const itemType = normalizePinnedItemType(input.itemType ?? input.item_type);
    const itemId = String(input.itemId ?? input.item_id ?? "").trim();
    if (!itemId) throw new Error("item_id is required");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const userId = input.userId ?? input.user_id ?? "local";
    this.validatePinnedItemTarget(workspaceId, itemType, itemId);
    const existing = this.ctx.db.query(
      "SELECT id FROM multiremi_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
    ).get(workspaceId, userId, itemType, itemId) as Row | null;
    if (existing) throw new Error("Item already pinned");
    const maxRow = this.ctx.db.query(
      "SELECT COALESCE(MAX(position), 0) AS max_position FROM multiremi_pinned_items WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, userId) as Row | null;
    const id = input.id ?? createId("pin");
    const position = Number(maxRow?.max_position ?? 0) + 1;
    this.ctx.db.run(
      `INSERT INTO multiremi_pinned_items (id, workspace_id, user_id, item_type, item_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, userId, itemType, itemId, position, nowIso()],
    );
    return this.getPinnedItem(id)!;
  }

  getPinnedItem(id: string): MultiremiPinnedItem | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_pinned_items WHERE id = ?").get(id) as Row | null;
    return row ? toPinnedItem(row) : null;
  }

  deletePinnedItem(workspaceId: string | null | undefined, userId: string | null | undefined, itemType: string, itemId: string): void {
    const normalizedType = normalizePinnedItemType(itemType);
    this.ctx.db.run(
      "DELETE FROM multiremi_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
      [workspaceId ?? "local", userId ?? "local", normalizedType, itemId],
    );
  }

  reorderPinnedItems(workspaceId: string | null | undefined, userId: string | null | undefined, items: ReorderPinnedItemInput[]): MultiremiPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const tx = this.ctx.db.transaction(() => {
      for (const item of items) {
        if (!item.id) throw new Error("items[].id is required");
        const position = Number(item.position);
        if (!Number.isFinite(position)) throw new Error("items[].position must be a finite number");
        this.ctx.db.run(
          "UPDATE multiremi_pinned_items SET position = ? WHERE id = ? AND workspace_id = ? AND user_id = ?",
          [position, item.id, resolvedWorkspaceId, resolvedUserId],
        );
      }
      return this.listPinnedItems(resolvedWorkspaceId, resolvedUserId);
    });
    return tx();
  }

  listProjectResources(projectId: string): MultiremiProjectResource[] {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC",
    ).all(projectId) as Row[];
    return rows.map(toProjectResource);
  }

  listProjectDevices(projectId: string): MultiremiProjectDevice[] {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const rows = this.ctx.db.query(
      `SELECT device.*, profile.display_name
       FROM multiremi_project_devices device
       LEFT JOIN multiremi_daemon_profiles profile
         ON profile.workspace_id = device.workspace_id
        AND profile.daemon_id = device.daemon_id
       WHERE device.project_id = ?
       ORDER BY device.created_at ASC, device.daemon_id ASC`,
    ).all(projectId) as Row[];
    const runtimes = this.ctx.runtimes().listRuntimes().filter((runtime) => (
      (runtime.workspaceId ?? "local") === project.workspaceId
    ));
    return rows.map((row) => {
      const daemonId = String(row.daemon_id);
      const deviceRuntimes = runtimes.filter((runtime) => runtime.daemonId === daemonId);
      const providers = [...new Set(deviceRuntimes.map((runtime) => runtime.provider))].sort();
      return {
        projectId,
        workspaceId: project.workspaceId,
        daemonId,
        displayName: nullableString(row.display_name)
          ?? deviceRuntimes.find((runtime) => runtime.daemonDisplayName)?.daemonDisplayName
          ?? daemonId,
        online: deviceRuntimes.some((runtime) => runtime.status === "online"),
        providers,
        createdAt: String(row.created_at),
        createdBy: nullableString(row.created_by),
      };
    });
  }

  createProjectDevice(projectId: string, input: CreateProjectDeviceInput): MultiremiProjectDevice {
    const initialProject = this.getProject(projectId);
    if (!initialProject) throw new Error(`Project not found: ${projectId}`);
    const daemonId = String(input.daemonId ?? input.daemon_id ?? "").trim();
    if (!daemonId) throw new Error("daemon_id is required");
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initialProject.workspaceId);
      const project = this.getProject(projectId);
      if (!project || project.workspaceId !== initialProject.workspaceId) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const exists = this.ctx.runtimes().listRuntimes().some((runtime) => (
        runtime.daemonId === daemonId && (runtime.workspaceId ?? "local") === project.workspaceId
      ));
      if (!exists) throw new Error(`Daemon not found: ${daemonId}`);
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_project_devices (
          project_id, daemon_id, workspace_id, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?)`,
        [projectId, daemonId, project.workspaceId, now, input.createdBy ?? input.created_by ?? null],
      );
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
      return this.listProjectDevices(projectId).find((device) => device.daemonId === daemonId)!;
    })();
  }

  deleteProjectDevice(projectId: string, daemonId: string): void {
    const initialProject = this.getProject(projectId);
    if (!initialProject) throw new Error(`Project not found: ${projectId}`);
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initialProject.workspaceId);
      const project = this.getProject(projectId);
      if (!project || project.workspaceId !== initialProject.workspaceId) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const result = this.ctx.db.run(
        "DELETE FROM multiremi_project_devices WHERE project_id = ? AND daemon_id = ?",
        [projectId, daemonId],
      );
      if (result.changes === 0) throw new Error(`Project device not found: ${daemonId}`);
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [nowIso(), projectId]);
    })();
  }

  replaceProjectDevices(
    projectId: string,
    input: ReplaceProjectDevicesInput,
  ): MultiremiProjectDevice[] {
    const rawDaemonIds = input.daemonIds ?? input.daemon_ids;
    if (!Array.isArray(rawDaemonIds)) throw new Error("daemon_ids must be an array");
    if (rawDaemonIds.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("daemon_ids must contain non-empty strings");
    }
    const daemonIds = [...new Set(rawDaemonIds.map((value) => value.trim()))];
    const initialProject = this.getProject(projectId);
    if (!initialProject) throw new Error(`Project not found: ${projectId}`);

    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initialProject.workspaceId);
      const project = this.getProject(projectId);
      if (!project || project.workspaceId !== initialProject.workspaceId) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const knownDaemonIds = new Set(
        this.ctx.runtimes().listRuntimes()
          .filter((runtime) => (runtime.workspaceId ?? "local") === project.workspaceId)
          .map((runtime) => runtime.daemonId)
          .filter((daemonId): daemonId is string => !!daemonId),
      );
      const missing = daemonIds.find((daemonId) => !knownDaemonIds.has(daemonId));
      if (missing) throw new Error(`Daemon not found: ${missing}`);

      if (daemonIds.length === 0) {
        this.ctx.db.run("DELETE FROM multiremi_project_devices WHERE project_id = ?", [projectId]);
      } else {
        this.ctx.db.run(
          `DELETE FROM multiremi_project_devices
           WHERE project_id = ? AND daemon_id NOT IN (${daemonIds.map(() => "?").join(", ")})`,
          [projectId, ...daemonIds],
        );
      }
      const now = nowIso();
      for (const daemonId of daemonIds) {
        this.ctx.db.run(
          `INSERT INTO multiremi_project_devices (
             project_id, daemon_id, workspace_id, created_at, created_by
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, daemon_id) DO NOTHING`,
          [
            projectId,
            daemonId,
            project.workspaceId,
            now,
            input.createdBy ?? input.created_by ?? null,
          ],
        );
      }
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
      return this.listProjectDevices(projectId);
    })();
  }

  listProjectsForDaemon(workspaceId: string, daemonId: string): MultiremiProject[] {
    const rows = this.ctx.db.query(projectSelect(
      `JOIN multiremi_project_devices device ON device.project_id = p.id
       WHERE device.workspace_id = ? AND device.daemon_id = ?
       ORDER BY p.updated_at DESC`,
    )).all(workspaceId, daemonId) as Row[];
    return rows.map(toProject);
  }

  createProjectResource(projectId: string, input: CreateProjectResourceInput): MultiremiProjectResource {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const resourceType = String(input.resourceType ?? input.resource_type ?? "").trim();
    if (resourceType !== "local_directory" && resourceType !== "github_repo") {
      return this.createProjectResourceForProject(project, input);
    }
    const tx = this.ctx.db.transaction(() => {
      if (resourceType === "local_directory") {
        this.ctx.lockWorkspaceRuntimeLifecycle(project.workspaceId);
      } else {
        this.ctx.lockWorkspaceRepositoryTopology(project.workspaceId);
      }
      const currentProject = this.getProject(projectId);
      if (!currentProject || currentProject.workspaceId !== project.workspaceId) {
        throw new Error(`Project not found: ${projectId}`);
      }
      return this.createProjectResourceForProject(currentProject, input);
    });
    return tx();
  }

  /** Caller holds the workspace lifecycle lock when input is local_directory. */
  private createProjectResourceForProject(
    project: MultiremiProject,
    input: CreateProjectResourceInput,
  ): MultiremiProjectResource {
    const projectId = project.id;
    const resourceType = String(input.resourceType ?? input.resource_type ?? "").trim();
    const rawRef = input.resourceRef ?? input.resource_ref ?? {};
    const resourceRef = normalizeProjectResourceRef(resourceType, rawRef);
    this.assertLocalDirectoryDaemonNotRetired(project.workspaceId, resourceType, resourceRef);
    this.assertNoLocalDirectoryDaemonConflict(projectId, resourceType, resourceRef, null, "create");
    this.assertImportedGitRepository(project.workspaceId, resourceType, resourceRef);
    if (resourceType === "project_ref") this.assertValidProjectRef(projectId, resourceRef, project.workspaceId);
    const id = input.id ?? createId("res");
    const now = nowIso();
    const position = normalizeProjectResourcePosition(input.position, this.countProjectResources(projectId));
    this.ctx.db.run(
      `INSERT INTO multiremi_project_resources (
        id, project_id, workspace_id, resource_type, resource_ref, label, position, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        project.workspaceId,
        resourceType,
        toJson(resourceRef),
        cleanProjectResourceLabel(input.label),
        position,
        now,
        input.createdBy ?? null,
      ],
    );
    this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    return this.getProjectResource(id)!;
  }

  getProjectResource(id: string): MultiremiProjectResource | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_project_resources WHERE id = ?").get(id) as Row | null;
    return row ? toProjectResource(row) : null;
  }

  updateProjectResource(projectId: string, resourceId: string, input: UpdateProjectResourceInput): MultiremiProjectResource {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const existing = this.getProjectResource(resourceId);
    if (!existing || existing.projectId !== projectId) throw new Error(`Project resource not found: ${resourceId}`);
    if (existing.resourceType !== "local_directory" && existing.resourceType !== "github_repo") {
      return this.updateProjectResourceWithinLifecycleLock(project, existing, input);
    }
    const tx = this.ctx.db.transaction(() => {
      if (existing.resourceType === "local_directory") {
        this.ctx.lockWorkspaceRuntimeLifecycle(project.workspaceId);
      } else {
        this.ctx.lockWorkspaceRepositoryTopology(project.workspaceId);
      }
      const currentProject = this.getProject(projectId);
      if (!currentProject || currentProject.workspaceId !== project.workspaceId) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const currentResource = this.getProjectResource(resourceId);
      if (!currentResource || currentResource.projectId !== projectId) {
        throw new Error(`Project resource not found: ${resourceId}`);
      }
      return this.updateProjectResourceWithinLifecycleLock(currentProject, currentResource, input);
    });
    return tx();
  }

  /** Caller holds the workspace lifecycle lock when existing is local_directory. */
  private updateProjectResourceWithinLifecycleLock(
    project: MultiremiProject,
    existing: MultiremiProjectResource,
    input: UpdateProjectResourceInput,
  ): MultiremiProjectResource {
    const projectId = project.id;
    const resourceId = existing.id;
    const hasRef = hasAnyField(input, "resourceRef", "resource_ref");
    const rawRef = hasRef ? input.resourceRef ?? input.resource_ref ?? {} : existing.resourceRef;
    const resourceRef = normalizeProjectResourceRef(existing.resourceType, rawRef);
    this.assertLocalDirectoryDaemonNotRetired(project.workspaceId, existing.resourceType, resourceRef);
    this.assertNoLocalDirectoryDaemonConflict(projectId, existing.resourceType, resourceRef, resourceId, "update");
    this.assertImportedGitRepository(project.workspaceId, existing.resourceType, resourceRef);
    if (existing.resourceType === "project_ref") this.assertValidProjectRef(projectId, resourceRef, existing.workspaceId);
    const label = hasAnyField(input, "label") ? cleanProjectResourceLabel(input.label) : existing.label;
    const position = hasAnyField(input, "position")
      ? normalizeProjectResourcePosition(input.position, existing.position)
      : existing.position;
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_project_resources
       SET resource_ref = ?, label = ?, position = ?
       WHERE project_id = ? AND id = ?`,
      [toJson(resourceRef), label, position, projectId, resourceId],
    );
    if (result.changes === 0) throw new Error(`Project resource not found: ${resourceId}`);
    this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    return this.getProjectResource(resourceId)!;
  }

  deleteProjectResource(projectId: string, resourceId: string): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const existing = this.getProjectResource(resourceId);
    if (!existing || existing.projectId !== projectId) throw new Error(`Project resource not found: ${resourceId}`);
    if (existing.resourceType !== "local_directory") {
      this.deleteProjectResourceWithinLifecycleLock(projectId, resourceId);
      return;
    }
    const tx = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(project.workspaceId);
      const currentProject = this.getProject(projectId);
      if (!currentProject || currentProject.workspaceId !== project.workspaceId) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const currentResource = this.getProjectResource(resourceId);
      if (!currentResource || currentResource.projectId !== projectId) {
        throw new Error(`Project resource not found: ${resourceId}`);
      }
      this.deleteProjectResourceWithinLifecycleLock(projectId, resourceId);
    });
    tx();
  }

  /** Caller holds the workspace lifecycle lock when deleting local_directory. */
  private deleteProjectResourceWithinLifecycleLock(projectId: string, resourceId: string): void {
    const now = nowIso();
    const result = this.ctx.db.run(
      "DELETE FROM multiremi_project_resources WHERE project_id = ? AND id = ?",
      [projectId, resourceId],
    );
    if (result.changes === 0) throw new Error(`Project resource not found: ${resourceId}`);
    this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
  }

  listProjectDocs(projectId: string, input: { kind?: string | null } = {}): MultiremiProjectDoc[] {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const kind = cleanOptionalString(input.kind);
    const rows = kind
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_project_docs WHERE project_id = ? AND kind = ? ORDER BY pinned DESC, updated_at DESC",
      ).all(projectId, normalizeProjectDocKind(kind)) as Row[]
      : this.ctx.db.query(
        "SELECT * FROM multiremi_project_docs WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC",
      ).all(projectId) as Row[];
    return rows.map(toProjectDoc);
  }

  getProjectDoc(id: string): MultiremiProjectDoc | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_project_docs WHERE id = ?").get(id) as Row | null;
    return row ? toProjectDoc(row) : null;
  }

  /** Resolves a doc within a project by id first, then by slug (both are user-facing refs). */
  getProjectDocByRef(projectId: string, ref: string): MultiremiProjectDoc | null {
    const value = ref.trim();
    if (!value) return null;
    const byId = this.getProjectDoc(value);
    if (byId && byId.projectId === projectId) return byId;
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_project_docs WHERE project_id = ? AND slug = ?",
    ).get(projectId, value) as Row | null;
    return row ? toProjectDoc(row) : null;
  }

  createProjectDoc(projectId: string, input: CreateProjectDocInput): MultiremiProjectDoc {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const kind = normalizeProjectDocKind(input.kind ?? "wiki");
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const id = input.id ?? createId("pdoc");
    const slug = projectDocSlug(input.slug, title, id);
    const path = normalizeProjectWikiPath(input.path ?? `${slug}.md`);
    const summary = cleanOptionalString(input.summary);
    const body = String(input.body ?? "");
    const pinned = input.pinned === undefined || input.pinned === null ? kind === "memory" : Boolean(input.pinned);
    const authorType = cleanOptionalString(input.authorType ?? input.author_type);
    const authorId = cleanOptionalString(input.authorId ?? input.author_id);
    // The maintenance rules land before the project's first real doc does, so an
    // agent writing its first entry already has something to follow. Seeding a
    // `_schema` doc itself must not recurse — hence the slug guard.
    if (slug !== PROJECT_DOC_SCHEMA_SLUG) this.ensureProjectDocSchema(projectId);
    this.assertProjectDocIdentityAvailable(projectId, slug, path);
    const now = nowIso();
    const tx = this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO multiremi_project_docs (
          id, project_id, workspace_id, kind, slug, path, title, summary, body, tags, pinned, refs,
          source_task_id, source_issue_id, author_type, author_id,
          updated_by_type, updated_by_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId,
          project.workspaceId,
          kind,
          slug,
          path,
          title,
          summary,
          body,
          toJson(normalizeProjectDocTags(input.tags)),
          pinned ? 1 : 0,
          toJson(normalizeProjectDocRefs(input.refs)),
          cleanOptionalString(input.sourceTaskId ?? input.source_task_id),
          cleanOptionalString(input.sourceIssueId ?? input.source_issue_id),
          authorType,
          authorId,
          authorType,
          authorId,
          1,
          now,
          now,
        ],
      );
      this.insertProjectDocRevision(id, 1, title, summary, body, authorType, authorId, now);
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
      return this.getProjectDoc(id)!;
    });
    return tx();
  }

  /** Insert only relational control metadata after OpenViking has accepted the content. */
  createProjectDocMetadata(
    projectId: string,
    input: CreateProjectDocInput,
    control: ProjectKnowledgeWriteControl,
  ): MultiremiProjectDoc {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const kind = normalizeProjectDocKind(input.kind ?? "wiki");
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const id = input.id ?? createId("pdoc");
    const slug = projectDocSlug(input.slug, title, id);
    const path = normalizeProjectWikiPath(input.path ?? `${slug}.md`);
    const summary = cleanOptionalString(input.summary);
    const pinned = input.pinned === undefined || input.pinned === null ? kind === "memory" : Boolean(input.pinned);
    const authorType = cleanOptionalString(input.authorType ?? input.author_type);
    const authorId = cleanOptionalString(input.authorId ?? input.author_id);
    this.assertProjectDocIdentityAvailable(projectId, slug, path);
    const now = nowIso();
    const tx = this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO multiremi_project_docs (
          id, project_id, workspace_id, kind, slug, path, title, summary, body, tags, pinned, refs,
          source_task_id, source_issue_id, author_type, author_id,
          updated_by_type, updated_by_id, version,
          storage_backend, content_uri, content_sha256, sync_status, sync_error, snapshot_oid,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'openviking', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId,
          project.workspaceId,
          kind,
          slug,
          path,
          title,
          summary,
          toJson(normalizeProjectDocTags(input.tags)),
          pinned ? 1 : 0,
          toJson(normalizeProjectDocRefs(input.refs)),
          cleanOptionalString(input.sourceTaskId ?? input.source_task_id),
          cleanOptionalString(input.sourceIssueId ?? input.source_issue_id),
          authorType,
          authorId,
          authorType,
          authorId,
          control.contentUri,
          control.contentSha256,
          control.syncStatus ?? "ready",
          control.syncError ?? null,
          control.snapshotOid,
          now,
          now,
        ],
      );
      this.insertProjectDocRevision(id, 1, title, summary, "", authorType, authorId, now, control);
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
      return this.getProjectDoc(id)!;
    });
    return tx();
  }

  updateProjectDoc(projectId: string, ref: string, input: UpdateProjectDocInput): MultiremiProjectDoc {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const existing = this.getProjectDocByRef(projectId, ref);
    if (!existing) throw new Error(`Project doc not found: ${ref}`);
    const expectedVersion = input.expectedVersion ?? input.expected_version;
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== existing.version) {
      throw new Error("project doc version conflict");
    }
    const title = hasAnyField(input, "title") ? String(input.title ?? "").trim() : existing.title;
    if (!title) throw new Error("title is required");
    const slug = hasAnyField(input, "slug") ? projectDocSlug(input.slug, title, existing.id) : existing.slug;
    const path = hasAnyField(input, "path") ? normalizeProjectWikiPath(input.path) : existing.path;
    this.assertProjectDocIdentityAvailable(projectId, slug, path, existing.id);
    const summary = hasAnyField(input, "summary") ? cleanOptionalString(input.summary) : existing.summary;
    const body = hasAnyField(input, "body") ? String(input.body ?? "") : existing.body;
    const tags = hasAnyField(input, "tags") ? normalizeProjectDocTags(input.tags) : existing.tags;
    const pinned = hasAnyField(input, "pinned") ? Boolean(input.pinned) : existing.pinned;
    // refs are replaced wholesale (the CLI/API always send the full list), never merged.
    const refs = hasAnyField(input, "refs") ? normalizeProjectDocRefs(input.refs) : existing.refs;
    const updatedByType = cleanOptionalString(input.updatedByType ?? input.updated_by_type);
    const updatedById = cleanOptionalString(input.updatedById ?? input.updated_by_id);
    const version = existing.version + 1;
    const now = nowIso();
    const tx = this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_project_docs
         SET slug = ?, path = ?, title = ?, summary = ?, body = ?, tags = ?, pinned = ?, refs = ?,
             updated_by_type = ?, updated_by_id = ?, version = ?, updated_at = ?
         WHERE id = ?`,
        [
          slug,
          path,
          title,
          summary,
          body,
          toJson(tags),
          pinned ? 1 : 0,
          toJson(refs),
          updatedByType,
          updatedById,
          version,
          now,
          existing.id,
        ],
      );
      this.insertProjectDocRevision(existing.id, version, title, summary, body, updatedByType, updatedById, now);
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
      return this.getProjectDoc(existing.id)!;
    });
    return tx();
  }

  replaceProjectDocMetadataExact(
    prepared: MultiremiProjectDoc,
    control: ProjectKnowledgeWriteControl,
  ): MultiremiProjectDoc {
    const existing = this.getProjectDoc(prepared.id);
    if (!existing || existing.projectId !== prepared.projectId) {
      throw new Error(`Project doc not found: ${prepared.id}`);
    }
    if (prepared.version !== existing.version + 1) throw new Error("project doc version conflict");
    const tx = this.ctx.db.transaction(() => {
      const result = this.ctx.db.run(
        `UPDATE multiremi_project_docs
         SET slug = ?, path = ?, title = ?, summary = ?, tags = ?, pinned = ?, refs = ?,
             updated_by_type = ?, updated_by_id = ?, version = ?,
             storage_backend = 'openviking', content_uri = ?, content_sha256 = ?,
             sync_status = ?, sync_error = ?, snapshot_oid = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        [
          prepared.slug,
          prepared.path,
          prepared.title,
          prepared.summary,
          toJson(prepared.tags),
          prepared.pinned ? 1 : 0,
          toJson(prepared.refs),
          prepared.updatedByType,
          prepared.updatedById,
          prepared.version,
          control.contentUri,
          control.contentSha256,
          control.syncStatus ?? "ready",
          control.syncError ?? null,
          control.snapshotOid,
          prepared.updatedAt,
          prepared.id,
          existing.version,
        ],
      );
      if (result.changes !== 1) throw new Error("project doc version conflict");
      this.insertProjectDocRevision(
        prepared.id,
        prepared.version,
        prepared.title,
        prepared.summary,
        "",
        prepared.updatedByType,
        prepared.updatedById,
        prepared.updatedAt,
        control,
      );
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [prepared.updatedAt, prepared.projectId]);
      return this.getProjectDoc(prepared.id)!;
    });
    return tx();
  }

  setProjectDocSyncState(
    docId: string,
    input: Partial<ProjectKnowledgeWriteControl> & { storageBackend?: "sql" | "openviking" },
  ): MultiremiProjectDoc {
    const existing = this.getProjectDoc(docId);
    if (!existing) throw new Error(`Project doc not found: ${docId}`);
    this.ctx.db.run(
      `UPDATE multiremi_project_docs SET
         storage_backend = ?, content_uri = ?, content_sha256 = ?, sync_status = ?, sync_error = ?, snapshot_oid = ?
       WHERE id = ?`,
      [
        input.storageBackend ?? existing.storageBackend ?? "sql",
        input.contentUri === undefined ? existing.contentUri ?? null : input.contentUri,
        input.contentSha256 === undefined ? existing.contentSha256 ?? null : input.contentSha256,
        input.syncStatus ?? existing.syncStatus ?? "sql",
        input.syncError === undefined ? existing.syncError ?? null : input.syncError,
        input.snapshotOid === undefined ? existing.snapshotOid ?? null : input.snapshotOid,
        docId,
      ],
    );
    return this.getProjectDoc(docId)!;
  }

  private assertProjectDocIdentityAvailable(projectId: string, slug: string, path: string, excludeId?: string): void {
    const slugRow = this.ctx.db.query(
      "SELECT id FROM multiremi_project_docs WHERE project_id = ? AND slug = ?",
    ).get(projectId, slug) as { id: string } | null;
    if (slugRow && slugRow.id !== excludeId) throw new Error("UNIQUE constraint failed: project doc slug conflict");
    const pathRow = this.ctx.db.query(
      "SELECT id FROM multiremi_project_docs WHERE project_id = ? AND path = ?",
    ).get(projectId, path) as { id: string } | null;
    if (pathRow && pathRow.id !== excludeId) throw new Error("UNIQUE constraint failed: project doc path conflict");
  }

  setProjectDocRevisionStorage(
    docId: string,
    version: number,
    contentUri: string,
    contentSha256: string,
    snapshotOid: string | null,
  ): void {
    this.ctx.db.run(
      "UPDATE multiremi_project_doc_revisions SET content_uri = ?, content_sha256 = ?, snapshot_oid = ? WHERE doc_id = ? AND version = ?",
      [contentUri, contentSha256, snapshotOid, docId, version],
    );
  }

  listProjectDocsForMigration(workspaceId: string, statuses: string[] = []): MultiremiProjectDoc[] {
    const normalized = statuses.map((value) => value.trim()).filter(Boolean);
    if (!normalized.length) {
      return (this.ctx.db.query(
        "SELECT * FROM multiremi_project_docs WHERE workspace_id = ? ORDER BY project_id, created_at",
      ).all(workspaceId) as Row[]).map(toProjectDoc);
    }
    const placeholders = normalized.map(() => "?").join(", ");
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_project_docs WHERE workspace_id = ? AND sync_status IN (${placeholders}) ORDER BY project_id, created_at`,
    ).all(workspaceId, ...normalized) as Row[]).map(toProjectDoc);
  }

  deleteProjectDoc(projectId: string, ref: string): void {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const existing = this.getProjectDocByRef(projectId, ref);
    if (!existing) throw new Error(`Project doc not found: ${ref}`);
    const now = nowIso();
    this.ctx.db.transaction(() => {
      // Foreign keys are decorative here (sqlite runs with them off, the Postgres
      // bridge strips them), so the revisions go with the doc explicitly.
      this.ctx.db.run("DELETE FROM multiremi_project_doc_revisions WHERE doc_id = ?", [existing.id]);
      this.ctx.db.run("DELETE FROM multiremi_project_docs WHERE id = ?", [existing.id]);
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    })();
  }

  listProjectDocRevisions(docId: string): MultiremiProjectDocRevision[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_project_doc_revisions WHERE doc_id = ? ORDER BY version DESC",
    ).all(docId) as Row[];
    return rows.map(toProjectDocRevision);
  }

  searchProjectDocs(projectId: string, query: string, input: { kind?: string | null; limit?: number } = {}): MultiremiProjectDoc[] {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const term = query.trim();
    if (!term) return [];
    const kind = cleanOptionalString(input.kind);
    // The term is a literal substring, not a pattern: `%` and `_` in a user's
    // query must match themselves. Escaping them (and the escape char itself)
    // requires naming the escape char explicitly — sqlite's LIKE has none by
    // default while Postgres already treats backslash as one, so without the
    // clause the two dialects disagree on a term containing a backslash.
    const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    // LOWER() on both sides keeps the match case-insensitive in sqlite and Postgres
    // alike; the columns stay separate (no concatenation) so a NULL summary cannot
    // swallow the whole predicate.
    const where = "project_id = ? AND (LOWER(title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(summary) LIKE LOWER(?) ESCAPE '\\' OR LOWER(body) LIKE LOWER(?) ESCAPE '\\' OR LOWER(tags) LIKE LOWER(?) ESCAPE '\\')";
    const limit = clampSearchLimit(input.limit);
    const rows = kind
      ? this.ctx.db.query(
        `SELECT * FROM multiremi_project_docs WHERE ${where} AND kind = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      ).all(projectId, pattern, pattern, pattern, pattern, normalizeProjectDocKind(kind), limit) as Row[]
      : this.ctx.db.query(
        `SELECT * FROM multiremi_project_docs WHERE ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      ).all(projectId, pattern, pattern, pattern, pattern, limit) as Row[];
    return rows.map(toProjectDoc);
  }

  /**
   * Workspace-wide doc listing for the Knowledge view: every project's docs in
   * one query, joined with the project title so the client can group without a
   * second fetch. Ordered by recency (a browse view, unlike the pinned-first
   * per-project listing).
   */
  listWorkspaceDocs(workspaceId: string, input: { kind?: string | null; q?: string | null; limit?: number } = {}): MultiremiWorkspaceProjectDoc[] {
    const kind = cleanOptionalString(input.kind);
    const conditions = ["d.workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    if (kind) {
      conditions.push("d.kind = ?");
      params.push(normalizeProjectDocKind(kind));
    }
    const term = String(input.q ?? "").trim();
    if (term) {
      // Same literal-substring LIKE as searchProjectDocs: escape %, _ and the
      // escape char itself, LOWER() both sides, columns kept separate so a NULL
      // summary cannot swallow the predicate.
      const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      conditions.push("(LOWER(d.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(d.summary) LIKE LOWER(?) ESCAPE '\\' OR LOWER(d.body) LIKE LOWER(?) ESCAPE '\\' OR LOWER(d.tags) LIKE LOWER(?) ESCAPE '\\')");
      params.push(pattern, pattern, pattern, pattern);
    }
    params.push(clampWorkspaceDocLimit(input.limit));
    const rows = this.ctx.db.query(
      `SELECT d.*, p.title AS project_title FROM multiremi_project_docs d
       JOIN multiremi_projects p ON p.id = d.project_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.updated_at DESC LIMIT ?`,
    ).all(...params) as Row[];
    return rows.map((row) => ({ ...toProjectDoc(row), projectTitle: String(row.project_title ?? "") }));
  }

  /**
   * Seeds the project's `_schema` doc (the wiki maintenance rules) when it is
   * missing. Otherwise `_schema` is an ordinary doc: readable, editable,
   * revisioned — only the slug is reserved.
   */
  ensureProjectDocSchema(projectId: string): MultiremiProjectDoc {
    const existing = this.getProjectDocByRef(projectId, PROJECT_DOC_SCHEMA_SLUG);
    if (existing) return existing;
    return this.createProjectDoc(projectId, {
      kind: "wiki",
      slug: PROJECT_DOC_SCHEMA_SLUG,
      title: PROJECT_DOC_SCHEMA_TITLE,
      body: PROJECT_DOC_SCHEMA_TEMPLATE,
      pinned: false,
    });
  }

  /** Compact knowledge index injected into a task's prompt (see getTaskWithAgent). */
  getProjectDocsIndex(projectId: string): MultiremiProjectDocsIndex {
    const memory = this.ctx.db.query(
      `SELECT * FROM multiremi_project_docs WHERE project_id = ? AND kind = 'memory'
       ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    ).all(projectId, PROJECT_DOC_MEMORY_INDEX_LIMIT) as Row[];
    // `_schema` rides its own field, so it never eats a slot in the wiki listing.
    const wiki = this.ctx.db.query(
      `SELECT * FROM multiremi_project_docs WHERE project_id = ? AND kind = 'wiki' AND slug <> ?
       ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    ).all(projectId, PROJECT_DOC_SCHEMA_SLUG, PROJECT_DOC_WIKI_INDEX_LIMIT) as Row[];
    const schema = this.ctx.db.query(
      "SELECT body FROM multiremi_project_docs WHERE project_id = ? AND slug = ?",
    ).get(projectId, PROJECT_DOC_SCHEMA_SLUG) as Row | null;
    return {
      memory: memory.map((row) => toProjectDocIndexEntry(toProjectDoc(row))),
      wiki: wiki.map((row) => toProjectDocIndexEntry(toProjectDoc(row))),
      schema: schema ? trimProjectDocText(String(schema.body ?? ""), PROJECT_DOC_INDEX_SCHEMA_MAX) : null,
    };
  }

  private insertProjectDocRevision(
    docId: string,
    version: number,
    title: string,
    summary: string | null,
    body: string,
    authorType: string | null,
    authorId: string | null,
    createdAt: string,
    control?: Pick<ProjectKnowledgeWriteControl, "contentUri" | "contentSha256" | "snapshotOid">,
  ): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_project_doc_revisions (
        id, doc_id, version, title, summary, body, author_type, author_id,
        content_uri, content_sha256, snapshot_oid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("pdrev"), docId, version, title, summary, body, authorType, authorId,
        control?.contentUri ?? null, control?.contentSha256 ?? null, control?.snapshotOid ?? null, createdAt,
      ],
    );
  }

  private validatePinnedItemTarget(workspaceId: string, itemType: MultiremiPinnedItemType, itemId: string): void {
    if (itemType === "issue") {
      const row = this.ctx.db.query("SELECT id FROM multiremi_issues WHERE id = ? AND workspace_id = ?").get(itemId, workspaceId) as Row | null;
      if (!row) throw new Error(`Issue not found: ${itemId}`);
      return;
    }
    const project = this.getProject(itemId);
    if (!project || project.workspaceId !== workspaceId) throw new Error(`Project not found: ${itemId}`);
  }

  private countProjectResources(projectId: string): number {
    const row = this.ctx.db.query("SELECT COUNT(*) AS count FROM multiremi_project_resources WHERE project_id = ?")
      .get(projectId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  /** Caller holds the workspace repository-topology row lock. */
  private assertImportedGitRepository(
    workspaceId: string,
    resourceType: string,
    resourceRef: Record<string, unknown>,
  ): void {
    if (resourceType !== "github_repo") return;
    const url = String(resourceRef.url ?? "").trim();
    const workspace = this.ctx.workspaces().getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const target = canonicalGitRepositoryUrl(url);
    const imported = workspace.repos.some((value) => {
      if (!value || typeof value !== "object") return false;
      const candidate = String((value as Record<string, unknown>).url ?? "").trim();
      return candidate !== "" && canonicalGitRepositoryUrl(candidate) === target;
    });
    if (!imported) {
      throw new Error("github_repo repository must be imported before it can be added to a project");
    }
  }

  private assertNoLocalDirectoryDaemonConflict(
    projectId: string,
    resourceType: string,
    resourceRef: Record<string, unknown>,
    excludeId: string | null,
    mode: "create" | "update",
  ): void {
    if (resourceType !== "local_directory") return;
    const daemonId = String(resourceRef.daemonId ?? resourceRef.daemon_id ?? "").trim();
    if (!daemonId) return;
    for (const resource of this.listProjectResources(projectId)) {
      if (resource.id === excludeId || resource.resourceType !== "local_directory") continue;
      const existingDaemonId = String(resource.resourceRef.daemonId ?? resource.resourceRef.daemon_id ?? "").trim();
      if (existingDaemonId !== daemonId) continue;
      if (mode === "create") {
        throw new Error("this daemon already has a local_directory attached to the project; remove it before adding another");
      }
      throw new Error("another local_directory on this daemon is already attached to the project");
    }
  }

  private assertLocalDirectoryDaemonNotRetired(
    workspaceId: string,
    resourceType: string,
    resourceRef: Record<string, unknown>,
  ): void {
    if (resourceType !== "local_directory") return;
    const daemonId = String(resourceRef.daemonId ?? resourceRef.daemon_id ?? "").trim();
    if (!daemonId) return;
    const retired = this.ctx.db.query(
      "SELECT 1 FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?",
    ).get(workspaceId, daemonId);
    if (retired) throw new DaemonRetiredError(workspaceId, daemonId);
  }

  private assertValidProjectRef(owningProjectId: string, resourceRef: Record<string, unknown>, workspaceId: string): void {
    const targetId = String(resourceRef.projectId ?? resourceRef.project_id ?? "").trim();
    if (!targetId) throw new Error("project_ref project_id is required");
    if (targetId === owningProjectId) throw new Error("project_ref cannot reference its own project");
    const target = this.getProject(targetId);
    if (!target) throw new Error(`project_ref target project not found: ${targetId}`);
    if (target.workspaceId !== workspaceId) throw new Error("project_ref target belongs to another workspace");
    // Walk the target's project_ref graph; reaching the owning project again
    // means this edge would close a cycle. The visited set prunes shared
    // subtrees so a DAG diamond is not mistaken for a cycle. Write-time
    // rejection has a TOCTOU gap, so runtime resolution guards with its own
    // visited set — this keeps the graph acyclic under normal use.
    const visited = new Set<string>();
    const walk = (projectId: string, depth: number): void => {
      if (projectId === owningProjectId) throw new Error("project_ref would introduce a reference cycle");
      if (depth > PROJECT_REF_MAX_DEPTH || visited.has(projectId)) return;
      visited.add(projectId);
      for (const resource of this.listProjectResources(projectId)) {
        if (resource.resourceType !== "project_ref") continue;
        const nextId = String(resource.resourceRef.projectId ?? resource.resourceRef.project_id ?? "").trim();
        // Dangling targets are silently skipped (like resolveTaskRepos) so a
        // hard-deleted referenced project can't break a valid new edge.
        if (!nextId || !this.getProject(nextId)) continue;
        walk(nextId, depth + 1);
      }
    };
    walk(targetId, 1);
  }
}

function isArchivedProjectStatus(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

function normalizeProjectResourcePosition(value: number | null | undefined, fallback: number): number {
  if (value == null) return fallback;
  const position = Number(value);
  if (!Number.isInteger(position)) throw new Error("position must be an integer");
  return position;
}

function cleanProjectResourceLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const label = String(value).trim();
  return label ? label : null;
}

function normalizePinnedItemType(value: string | undefined): MultiremiPinnedItemType {
  if (value === "issue" || value === "project") return value;
  throw new Error("item_type must be 'issue' or 'project'");
}

// Wider than clampSearchLimit: the Knowledge view browses a whole workspace,
// not a single result page.
function clampWorkspaceDocLimit(value: number | undefined): number {
  const limit = Number(value ?? 200);
  if (!Number.isFinite(limit) || limit <= 0) return 200;
  return Math.min(500, Math.floor(limit));
}

function normalizeProjectResourceRef(resourceType: string, rawRef: Record<string, unknown>): Record<string, unknown> {
  if (!resourceType) throw new Error("resource_type is required");
  if (resourceType === "local_directory") return normalizeLocalDirectoryResourceRef(rawRef);
  if (resourceType === "project_ref") return normalizeProjectRefResourceRef(rawRef);
  if (resourceType !== "github_repo") throw new Error(`unknown resource_type "${resourceType}"`);
  const url = String(rawRef.url ?? "").trim();
  if (!url) throw new Error("github_repo url is required");
  if (!isValidGitRepoUrl(url)) throw new Error("github_repo url must be a valid http(s), ssh, git, or scp-like URL");
  const defaultBranchHint = String(rawRef.defaultBranchHint ?? rawRef.default_branch_hint ?? "").trim();
  return defaultBranchHint
    ? { url, defaultBranchHint, default_branch_hint: defaultBranchHint }
    : { url };
}

function normalizeProjectRefResourceRef(rawRef: Record<string, unknown>): Record<string, unknown> {
  const projectId = String(rawRef.projectId ?? rawRef.project_id ?? "").trim();
  if (!projectId) throw new Error("project_ref project_id is required");
  // Fixed key order keeps toJson deterministic so the UNIQUE(project_id,
  // resource_type, resource_ref) index catches duplicate references.
  return { projectId, project_id: projectId };
}

function normalizeLocalDirectoryResourceRef(rawRef: Record<string, unknown>): Record<string, unknown> {
  const localPath = String(rawRef.localPath ?? rawRef.local_path ?? "").trim();
  if (!localPath) throw new Error("local_directory local_path is required");
  if (!isAbsolutePath(localPath)) throw new Error("local_directory local_path must be absolute");
  const daemonId = String(rawRef.daemonId ?? rawRef.daemon_id ?? "").trim();
  if (!daemonId) throw new Error("local_directory daemon_id is required");
  const label = String(rawRef.label ?? "").trim();
  return label
    ? { localPath, local_path: localPath, daemonId, daemon_id: daemonId, label }
    : { localPath, local_path: localPath, daemonId, daemon_id: daemonId };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isValidGitRepoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.host) && ["http", "https", "ssh", "git"].includes(url.protocol.replace(":", ""));
  } catch {
    if (value.includes(" ") || value.includes("://")) return false;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return false;
    const at = value.indexOf("@");
    if (at >= colon) return false;
    const host = value.slice(at >= 0 ? at + 1 : 0, colon);
    const path = value.slice(colon + 1);
    return Boolean(host && path);
  }
}

function projectSelect(suffix: string): string {
  return `
    SELECT p.*,
      COUNT(i.id) AS issue_count,
      COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count,
      (
        SELECT COUNT(*)
        FROM multiremi_project_resources pr
        WHERE pr.project_id = p.id
      ) AS resource_count
    FROM multiremi_projects p
    LEFT JOIN multiremi_issues i ON i.project_id = p.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY p.id ORDER BY") : `${suffix} GROUP BY p.id`}
  `;
}

function toProject(row: Row): MultiremiProject {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    title: String(row.title),
    description: nullableString(row.description),
    instructions: String(row.instructions ?? ""),
    deltaInstructions: String(row.delta_instructions ?? ""),
    instructionsRevision: Number(row.instructions_revision ?? 0),
    instructionsUpdatedAt: nullableString(row.instructions_updated_at),
    instructionsUpdatedBy: nullableString(row.instructions_updated_by),
    icon: nullableString(row.icon),
    status: String(row.status ?? "planned") as MultiremiProject["status"],
    priority: String(row.priority ?? "none") as MultiremiProject["priority"],
    leadType: nullableString(row.lead_type) as MultiremiProject["leadType"],
    leadId: nullableString(row.lead_id),
    defaultAssigneeType: nullableString(row.default_assignee_type) as MultiremiProject["defaultAssigneeType"],
    defaultAssigneeId: nullableString(row.default_assignee_id),
    issueCount: Number(row.issue_count ?? 0),
    doneCount: Number(row.done_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeProjectInstructions(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n");
}

function canonicalGitRepositoryUrl(value: string): string {
  const url = value.trim();
  const scp = url.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (scp) {
    return `ssh://${scp[1]}@${scp[2]!.toLowerCase()}/${normalizeGitRepositoryPath(scp[3]!)}`;
  }
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username.toLowerCase()}@` : "";
    return `${parsed.protocol.toLowerCase()}//${user}${parsed.hostname.toLowerCase()}${
      parsed.port ? `:${parsed.port}` : ""
    }/${normalizeGitRepositoryPath(parsed.pathname)}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

function normalizeGitRepositoryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

function toProjectResource(row: Row): MultiremiProjectResource {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id ?? "local"),
    resourceType: String(row.resource_type),
    resourceRef: parseJson(row.resource_ref, {}),
    label: nullableString(row.label),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by),
  };
}

function toProjectDoc(row: Row): MultiremiProjectDoc {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id ?? "local"),
    kind: row.kind === "memory" ? "memory" : "wiki",
    slug: String(row.slug),
    path: normalizeProjectWikiPath(row.path ?? `${String(row.slug)}.md`),
    title: String(row.title),
    summary: nullableString(row.summary),
    body: String(row.body ?? ""),
    tags: normalizeProjectDocTags(parseJson(row.tags, [])),
    // The Postgres bridge may hand back a boolean where sqlite stores 0/1.
    pinned: row.pinned === true || Number(row.pinned) === 1,
    refs: normalizeProjectDocRefs(parseJson(row.refs, [])),
    sourceTaskId: nullableString(row.source_task_id),
    sourceIssueId: nullableString(row.source_issue_id),
    authorType: nullableString(row.author_type) as MultiremiProjectDoc["authorType"],
    authorId: nullableString(row.author_id),
    updatedByType: nullableString(row.updated_by_type) as MultiremiProjectDoc["updatedByType"],
    updatedById: nullableString(row.updated_by_id),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    storageBackend: row.storage_backend === "openviking" ? "openviking" : "sql",
    contentUri: nullableString(row.content_uri),
    contentSha256: nullableString(row.content_sha256),
    syncStatus: normalizeProjectDocSyncStatus(row.sync_status),
    syncError: nullableString(row.sync_error),
    snapshotOid: nullableString(row.snapshot_oid),
    compilationRunId: nullableString(row.compilation_run_id),
  };
}

function toProjectDocRevision(row: Row): MultiremiProjectDocRevision {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    version: Number(row.version ?? 1),
    title: String(row.title),
    summary: nullableString(row.summary),
    body: String(row.body ?? ""),
    authorType: nullableString(row.author_type) as MultiremiProjectDocRevision["authorType"],
    authorId: nullableString(row.author_id),
    createdAt: String(row.created_at),
    contentUri: nullableString(row.content_uri),
    contentSha256: nullableString(row.content_sha256),
    snapshotOid: nullableString(row.snapshot_oid),
    compilationRunId: nullableString(row.compilation_run_id),
  };
}

function normalizeProjectDocSyncStatus(value: unknown): NonNullable<MultiremiProjectDoc["syncStatus"]> {
  const status = String(value ?? "sql");
  return status === "pending" || status === "ready" || status === "failed" || status === "deleting" ? status : "sql";
}

function toProjectDocIndexEntry(doc: MultiremiProjectDoc): MultiremiProjectDocIndexEntry {
  return {
    id: doc.id,
    slug: doc.slug,
    path: doc.path,
    title: doc.title,
    summary: doc.summary === null ? null : trimProjectDocText(doc.summary, PROJECT_DOC_INDEX_SUMMARY_MAX),
    body: doc.kind === "memory" ? trimProjectDocText(doc.body, PROJECT_DOC_INDEX_BODY_MAX) : null,
    kind: doc.kind,
    pinned: doc.pinned,
    sourceIssueId: doc.sourceIssueId,
    updatedAt: doc.updatedAt,
  };
}

function trimProjectDocText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function normalizeProjectDocKind(value: unknown): MultiremiProjectDocKind {
  const kind = String(value ?? "").trim().toLowerCase();
  if (kind !== "wiki" && kind !== "memory") throw new Error(`unknown kind: ${value}`);
  return kind;
}

export function normalizeProjectDocTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0);
}

/**
 * Lenient by design: an unknown ref type is kept as written (the taxonomy is a
 * convention, not a constraint) — only a ref without a value is worthless.
 */
export function normalizeProjectDocRefs(value: unknown): MultiremiProjectDocRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((ref): ref is Record<string, unknown> => typeof ref === "object" && ref !== null)
    .map((ref) => ({ type: String(ref.type ?? "").trim(), value: String(ref.value ?? "").trim() }))
    .filter((ref) => ref.value.length > 0)
    .slice(0, PROJECT_DOC_REFS_MAX);
}

/**
 * Explicit slug wins; otherwise slugify the title. A title with no ASCII
 * alphanumerics (a pure CJK one, say) slugifies to nothing — fall back to the
 * doc id so the URL-ish ref always exists and stays unique.
 */
export function projectDocSlug(explicit: string | null | undefined, title: string, docId: string): string {
  const source = String(explicit ?? "").trim() || title;
  // The reserved slug is the one ref that survives slugification verbatim —
  // otherwise its leading underscore would be shaved off into "schema".
  if (source === PROJECT_DOC_SCHEMA_SLUG) return PROJECT_DOC_SCHEMA_SLUG;
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || docId;
}

export function normalizeProjectWikiPath(value: unknown): string {
  try {
    return normalizeWikiPath(value);
  } catch {
    throw new Error("invalid project wiki path");
  }
}

function toPinnedItem(row: Row): MultiremiPinnedItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: String(row.user_id ?? "local"),
    itemType: String(row.item_type ?? "issue") as MultiremiPinnedItemType,
    itemId: String(row.item_id ?? ""),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
  };
}
