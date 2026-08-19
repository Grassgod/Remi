// Issues domain (issues, comments, activity/timeline, dependencies, subscribers, labels, inbox,
// reactions, attachments and issue metadata), extracted verbatim from MultiremiStore (the facade
// delegates every public method here).
import {
  cleanOptionalString,
  clampSearchLimit,
  extractSearchSnippet,
  hasAnyField,
  isActiveTaskStatus,
  normalizeSearchQuery,
  nullableString,
  parseJson,
  resolveOptionalStringField,
  searchMatch,
  searchRank,
  toJson,
} from "@multiremi/store/helpers.js";
import { type StoreContext, toInboxItem, toIssueComment } from "@multiremi/store/context.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
import type {
  AssignIssueInput,
  AssignIssueResult,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateAttachmentInput,
  CreateIssueCommentInput,
  CreateIssueDependencyInput,
  CreateIssueInput,
  CreateLabelInput,
  ListIssueCommentsInput,
  ListIssueCommentsResult,
  ListIssuesInput,
  MultiremiAgent,
  MultiremiAssigneeFrequencyEntry,
  MultiremiAssigneeType,
  MultiremiAttachment,
  MultiremiCommentReaction,
  MultiremiInboxItem,
  MultiremiIssue,
  MultiremiIssueActivity,
  MultiremiIssueAssigneeGroup,
  MultiremiIssueChildProgress,
  MultiremiIssueComment,
  MultiremiIssueDependency,
  MultiremiIssueDependencyType,
  MultiremiIssueKind,
  MultiremiIssuePriority,
  MultiremiIssueReaction,
  MultiremiIssueSearchResult,
  MultiremiIssueSubscriber,
  MultiremiIssueWithTasks,
  MultiremiLabel,
  MultiremiSubscriptionReason,
  MultiremiTask,
  MultiremiTimelineEntry,
  QuickCreateIssueInput,
  QuickCreateIssueResult,
  UpdateIssueCommentInput,
  UpdateIssueInput,
  UpdateLabelInput,
} from "@multiremi/contracts/types.js";

const log = createLogger("multiremi-store");

type Row = Record<string, unknown>;

const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
const CLOSED_ISSUE_STATUSES = new Set(["done", "completed", "closed", "cancelled", "failed"]);
const SYSTEM_AUTHOR_ID = "00000000-0000-0000-0000-000000000000";
const MAX_ISSUE_METADATA_KEYS = 50;
const ISSUE_METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const COMMENT_HARD_CAP = 2000;
const COMMENT_SUMMARY_RUNES = 200;

export type IssueDeletionBlockCode =
  | "issue_not_found"
  | "issue_has_active_tasks"
  | "issue_workspace_not_cleaned"
  | "issue_workspace_archive_invalid"
  | "issue_deletion_conflict";

export type BeginIssueDeletionResult =
  | { ok: true }
  | { ok: false; code: IssueDeletionBlockCode; error: string };
type IssueDeletionBlockedResult = Extract<BeginIssueDeletionResult, { ok: false }>;

// ── reactions ─────────────────────────────────────────────────────────────────
// Issue reactions and comment reactions are the same table shape hung off two different parents,
// so the list/add/remove bodies live once on the repo and are configured by these two specs. Only
// the parent existence check and the workspace lookup stay with the public methods.
interface ReactionInput {
  actorType?: string;
  actorId?: string | null;
  emoji: string;
}

/**
 * `table` and `parentColumn` are interpolated into SQL text. Both instances are module-level
 * constants that never see request input — do not widen them to accept caller-supplied strings.
 */
interface ReactionSpec<T> {
  table: string;
  parentColumn: string;
  hydrate: (row: Row) => T;
}

const ISSUE_REACTIONS: ReactionSpec<MultiremiIssueReaction> = {
  table: "multiremi_issue_reactions",
  parentColumn: "issue_id",
  hydrate: toIssueReaction,
};

const COMMENT_REACTIONS: ReactionSpec<MultiremiCommentReaction> = {
  table: "multiremi_comment_reactions",
  parentColumn: "comment_id",
  hydrate: toCommentReaction,
};

export class IssuesRepo {
  constructor(private ctx: StoreContext) {}

  createIssue(input: CreateIssueInput): MultiremiIssue {
    const parentIssueId = input.parentIssueId ?? input.parent_issue_id ?? null;
    const explicitWorkspaceId = input.workspaceId ?? input.workspace_id ?? null;
    const workspaceId = explicitWorkspaceId ?? "local";
    const parent = parentIssueId ? this.getIssue(parentIssueId) : null;
    if (parentIssueId && !parent) throw new Error(`Parent issue not found: ${parentIssueId}`);
    if (parent && parent.workspaceId !== workspaceId) throw new Error("Parent issue belongs to another workspace");

    const projectId = input.projectId ?? input.project_id ?? (parent ? parent.projectId : null);
    if (projectId) {
      const project = this.ctx.projects().getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    const issueKind = normalizeIssueKind(input.issueKind ?? input.issue_kind);
    const sourceIssueId = cleanOptionalString(input.sourceIssueId ?? input.source_issue_id) ?? null;
    if (sourceIssueId) {
      const sourceIssue = this.getIssue(sourceIssueId);
      if (!sourceIssue) throw new Error(`Source issue not found: ${sourceIssueId}`);
      if (sourceIssue.workspaceId !== workspaceId) throw new Error("Source issue belongs to another workspace");
      if (sourceIssue.issueKind !== "intake") throw new Error("Source issue must be an intake issue");
      if (issueKind !== "execution") throw new Error("Only execution issues can have a source issue");
    }

    let assigneeType = input.assigneeType ?? input.assignee_type ?? null;
    let assigneeId = input.assigneeId ?? input.assignee_id ?? null;
    if (assigneeType || assigneeId) {
      const resolvedAssignee = this.ctx.squads().resolveAssigneeRef(assigneeType, assigneeId, workspaceId);
      assigneeType = resolvedAssignee?.assigneeType ?? null;
      assigneeId = resolvedAssignee?.assigneeId ?? null;
      this.validateIssueAssignee(assigneeType, assigneeId);
    }
    const id = input.id ?? createId("iss");
    const now = nowIso();
    const issueNumber = this.nextIssueNumber(workspaceId);
    const issueKey = formatIssueKey(issueNumber);
    const priority = normalizeIssuePriority(input.priority);
    const position = normalizeIssuePosition(input.position);
    const startDate = normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date");
    const dueDate = normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date");
    const acceptanceCriteria = normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? []);
    const contextRefs = normalizeJsonArray(input.contextRefs ?? input.context_refs ?? []);
    const createdBy = input.createdBy ?? input.created_by ?? null;
    this.ctx.db.run(
      `INSERT INTO multiremi_issues (
        id, issue_number, issue_key, title, description, status, priority, workspace_id, project_id,
        parent_issue_id, issue_kind, source_issue_id, assignee_type, assignee_id, position, start_date, due_date,
        acceptance_criteria, context_refs, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        issueNumber,
        issueKey,
        input.title,
        input.description ?? null,
        normalizeIssueStatus(input.status),
        priority,
        workspaceId,
        projectId,
        parentIssueId,
        issueKind,
        sourceIssueId,
        assigneeType,
        assigneeId,
        position,
        startDate,
        dueDate,
        toJson(acceptanceCriteria),
        toJson(contextRefs),
        createdBy,
        now,
        now,
      ],
    );
    if (projectId) {
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    }
    this.ctx.appendIssueActivity(id, {
      actorType: "system",
      actorId: createdBy,
      type: "issue_created",
      body: input.title,
      data: { projectId, parentIssueId, issueKind, sourceIssueId, priority, startDate, dueDate },
    });
    if (sourceIssueId) {
      this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, sourceIssueId]);
      this.ctx.appendIssueActivity(sourceIssueId, {
        actorType: "agent",
        actorId: null,
        type: "issue_generated",
        body: input.title,
        data: { issueId: id, issueKey, projectId },
      });
    }
    if (createdBy) {
      const creator = this.ctx.workspaces().findWorkspaceMemberForUser(createdBy, workspaceId);
      if (creator) this.addIssueSubscriber(id, creator.id, "created");
    }
    this.ctx.issueSessions().getOrCreateDefaultIssueSession(id, createdBy);
    return this.getIssue(id)!;
  }

  getIssue(id: string): MultiremiIssue | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssue(toIssue(row)) : null;
  }

  listGeneratedIssues(sourceIssueId: string): MultiremiIssue[] {
    const source = this.getIssue(sourceIssueId);
    if (!source) throw new Error(`Issue not found: ${sourceIssueId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_issues WHERE source_issue_id = ? ORDER BY created_at ASC, id ASC",
    ).all(sourceIssueId) as Row[];
    return this.hydrateIssues(rows.map((row) => toIssue(row)));
  }

  findGeneratedIssueByTitle(sourceIssueId: string, title: string): MultiremiIssue | null {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return null;
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_issues
       WHERE source_issue_id = ? AND lower(title) = lower(?)
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    ).get(sourceIssueId, normalizedTitle) as Row | null;
    return row ? this.hydrateIssue(toIssue(row)) : null;
  }

  getIssueByRef(ref: string, workspaceId?: string | null): MultiremiIssue | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getIssue(value);
    if (exact && (!workspaceId || exact.workspaceId === workspaceId)) return exact;

    const rows: Row[] = [];
    const seen = new Set<string>();
    const addRows = (queryRows: Row[]) => {
      for (const row of queryRows) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    };
    const workspaceFilter = workspaceId ? " AND workspace_id = ?" : "";
    const workspaceParams = workspaceId ? [workspaceId] : [];
    addRows(this.ctx.db.query(`SELECT * FROM multiremi_issues WHERE lower(issue_key) = lower(?)${workspaceFilter}`).all(value, ...workspaceParams) as Row[]);
    if (/^\d+$/.test(value)) {
      addRows(this.ctx.db.query(`SELECT * FROM multiremi_issues WHERE issue_number = ?${workspaceFilter}`).all(Number(value), ...workspaceParams) as Row[]);
    }
    if (/^iss_[a-z0-9_]+$/i.test(value)) {
      addRows(this.ctx.db.query(`SELECT * FROM multiremi_issues WHERE id LIKE ?${workspaceFilter} ORDER BY created_at ASC`).all(`${value}%`, ...workspaceParams) as Row[]);
    }
    if (rows.length === 1) return this.hydrateIssue(toIssue(rows[0]!));
    if (!workspaceId && rows.length > 1) {
      const localRows = rows.filter((row) => String(row.workspace_id ?? "local") === "local");
      if (localRows.length === 1) return this.hydrateIssue(toIssue(localRows[0]!));
    }
    return null;
  }

  getIssueWithTasks(id: string): MultiremiIssueWithTasks | null {
    const issue = this.getIssue(id);
    if (!issue) return null;
    return {
      ...issue,
      tasks: this.ctx.tasks().listTasksForIssue(id),
      reactions: this.listIssueReactions(id),
      attachments: this.listAttachmentsForIssue(id),
      children: this.listChildIssues(id),
      childProgress: this.getChildIssueProgress(id),
      dependencies: this.listIssueDependencies(id),
    };
  }

  listIssues(input: ListIssuesInput = {}): MultiremiIssue[] {
    const { where, params } = buildIssueListWhere(input);
    const offset = normalizeListOffset(input.offset);
    const limit = input.limit === undefined ? Number.POSITIVE_INFINITY : normalizeListLimit(input.limit);
    // Metadata is a JSON column filtered in JS; when it (or an unbounded limit) is present we can't
    // safely push LIMIT/OFFSET into SQL, so we narrow the rows in SQL and paginate afterward.
    const hasMetadata = Boolean(input.metadata) && Object.keys(input.metadata!).length > 0;

    if (!hasMetadata && Number.isFinite(limit)) {
      const rows = this.ctx.db
        .query(`SELECT * FROM multiremi_issues ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Row[];
      return this.hydrateIssues(rows.map((row) => toIssue(row)));
    }

    const rows = this.ctx.db
      .query(`SELECT * FROM multiremi_issues ${where} ORDER BY updated_at DESC`)
      .all(...params) as Row[];
    const issues = rows
      .map((row) => toIssue(row))
      .filter((issue) => issueMatchesListFilter(issue, input))
      .slice(offset, offset + limit);
    return this.hydrateIssues(issues);
  }

  listGroupedIssues(input: ListIssuesInput = {}): { groups: MultiremiIssueAssigneeGroup[] } {
    const limit = normalizeListLimit(input.limit, 50, 100);
    const offset = normalizeListOffset(input.offset);
    const issues = this.listIssues({ ...input, limit: undefined, offset: undefined })
      .sort((left, right) => {
        const typeRank = assigneeGroupRank(left.assigneeType) - assigneeGroupRank(right.assigneeType);
        if (typeRank !== 0) return typeRank;
        return String(left.assigneeId ?? "").localeCompare(String(right.assigneeId ?? ""))
          || left.position - right.position
          || Date.parse(right.createdAt) - Date.parse(left.createdAt);
      });
    const groups = new Map<string, MultiremiIssueAssigneeGroup>();
    for (const issue of issues) {
      const id = assigneeGroupId(issue.assigneeType, issue.assigneeId);
      const group = groups.get(id) ?? {
        id,
        assigneeType: issue.assigneeType,
        assigneeId: issue.assigneeId,
        issues: [],
        total: 0,
      };
      group.total += 1;
      if (group.total > offset && group.issues.length < limit) group.issues.push(issue);
      groups.set(id, group);
    }
    return { groups: [...groups.values()] };
  }

  listAssigneeFrequency(input: {
    workspaceId?: string | null;
    actorId?: string | null;
    actor_id?: string | null;
    memberId?: string | null;
    member_id?: string | null;
    userId?: string | null;
    user_id?: string | null;
  } = {}): MultiremiAssigneeFrequencyEntry[] {
    const workspaceId = input.workspaceId ?? "local";
    const actorId = input.actorId ?? input.actor_id ?? input.memberId ?? input.member_id ?? input.userId ?? input.user_id ?? null;
    const frequency = new Map<string, { assigneeType: MultiremiAssigneeType; assigneeId: string; frequency: number }>();
    const add = (assigneeType: unknown, assigneeId: unknown, count = 1) => {
      const type = nullableString(assigneeType) as MultiremiAssigneeType | null;
      const id = nullableString(assigneeId);
      if (!type || !id) return;
      if (type !== "agent" && type !== "member" && type !== "squad") return;
      const key = `${type}:${id}`;
      const current = frequency.get(key) ?? { assigneeType: type, assigneeId: id, frequency: 0 };
      current.frequency += count;
      frequency.set(key, current);
    };

    const issueRows = actorId
      ? this.ctx.db.query(`
          SELECT assignee_type, assignee_id, COUNT(*) AS frequency
          FROM multiremi_issues
          WHERE workspace_id = ? AND created_by = ? AND assignee_type IS NOT NULL AND assignee_id IS NOT NULL
          GROUP BY assignee_type, assignee_id
        `).all(workspaceId, actorId) as Row[]
      : this.ctx.db.query(`
          SELECT assignee_type, assignee_id, COUNT(*) AS frequency
          FROM multiremi_issues
          WHERE workspace_id = ? AND assignee_type IS NOT NULL AND assignee_id IS NOT NULL
          GROUP BY assignee_type, assignee_id
        `).all(workspaceId) as Row[];
    for (const row of issueRows) add(row.assignee_type, row.assignee_id, Number(row.frequency ?? 0));

    const activityRows = actorId
      ? this.ctx.db.query(`
          SELECT a.data
          FROM multiremi_issue_activity a
          JOIN multiremi_issues i ON i.id = a.issue_id
          WHERE i.workspace_id = ? AND a.actor_type = 'member' AND a.actor_id = ?
            AND a.type IN ('assignee_changed', 'issue_assigned')
        `).all(workspaceId, actorId) as Row[]
      : this.ctx.db.query(`
          SELECT a.data
          FROM multiremi_issue_activity a
          JOIN multiremi_issues i ON i.id = a.issue_id
          WHERE i.workspace_id = ? AND a.type IN ('assignee_changed', 'issue_assigned')
        `).all(workspaceId) as Row[];
    for (const row of activityRows) {
      const data = parseJson<Record<string, unknown>>(row.data, {});
      add(data.to_type ?? data.toType ?? data.assignee_type ?? data.assigneeType, data.to_id ?? data.toId ?? data.assignee_id ?? data.assigneeId);
    }

    return [...frequency.values()]
      .map((entry) => ({
        assigneeType: entry.assigneeType,
        assignee_type: entry.assigneeType,
        assigneeId: entry.assigneeId,
        assignee_id: entry.assigneeId,
        frequency: entry.frequency,
      }))
      .sort((left, right) => right.frequency - left.frequency || left.assigneeType.localeCompare(right.assigneeType) || left.assigneeId.localeCompare(right.assigneeId));
  }

  batchUpdateIssues(input: BatchUpdateIssuesInput): { updated: number; issues: MultiremiIssue[] } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    const updates = input.updates ?? {};
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    if (!hasIssueMutation(updates)) return { updated: 0, issues: [] };
    const issues: MultiremiIssue[] = [];
    for (const issueId of issueIds) {
      try {
        issues.push(this.updateIssue(issueId, updates));
      } catch {
        // Match Multiremi's batch behavior: skip invalid or inaccessible rows.
      }
    }
    return { updated: issues.length, issues };
  }

  deleteIssue(id: string): boolean {
    const issue = this.getIssue(id);
    if (!issue) return false;
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
      this.ctx.lockIssueArchiveLifecycle(id);
      const current = this.getIssue(id);
      if (!current || current.workspaceId !== issue.workspaceId) return false;
      if (this.issueDeletionBlockWithinLifecycleLock(id)) return false;
      this.ctx.db.run(
        "UPDATE multiremi_issues SET lifecycle_state = 'deleting' WHERE id = ?",
        [id],
      );
      return this.deleteIssueRowsWithinLifecycleLock(current);
    })();
  }

  /** Delete every fenced Issue in one control-plane transaction. */
  deleteIssuesAtomically(ids: string[]): { deleted: number } {
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length === 0) return { deleted: 0 };
    const initial = uniqueIds
      .map((id) => this.getIssue(id))
      .filter((issue): issue is MultiremiIssue => Boolean(issue));
    return this.ctx.db.transaction(() => {
      for (const workspaceId of [...new Set(initial.map((issue) => issue.workspaceId))].sort()) {
        this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      }
      for (const id of uniqueIds) this.ctx.lockIssueArchiveLifecycle(id);

      const current: MultiremiIssue[] = [];
      for (const id of uniqueIds) {
        const issue = this.getIssue(id);
        if (!issue) continue;
        const block = this.issueDeletionBlockWithinLifecycleLock(id);
        if (block) throw Object.assign(new Error(block.error), { code: block.code, issueId: id });
        if (this.issueLifecycleState(id) !== "deleting") {
          throw Object.assign(new Error("Issue deletion was not fenced"), {
            code: "issue_deletion_conflict",
            issueId: id,
          });
        }
        current.push(issue);
      }
      let deleted = 0;
      for (const issue of current) {
        if (this.deleteIssueRowsWithinLifecycleLock(issue)) deleted++;
      }
      return { deleted };
    })();
  }

  private deleteIssueRowsWithinLifecycleLock(issue: MultiremiIssue): boolean {
    const id = issue.id;
    this.cancelActiveIssueTasks(id, "issue_deleted");
    this.ctx.db.run("UPDATE multiremi_autopilot_runs SET status = 'failed', completed_at = ?, failure_reason = ? WHERE issue_id = ? AND completed_at IS NULL", [
      nowIso(),
      "issue deleted",
      id,
    ]);
    this.ctx.db.run("UPDATE multiremi_autopilot_runs SET issue_id = NULL WHERE issue_id = ?", [id]);
    // PostgreSQL intentionally does not rely on FK cascades and SQLite tests
    // may run with them disabled. Remove the machine-local checkout record
    // and archive control-plane rows explicitly so deleting an Issue cannot
    // leave a retirement blocker or orphaned archive metadata.
    this.ctx.db.run("DELETE FROM multiremi_session_archives WHERE issue_id = ?", [id]);
    this.ctx.db.run("DELETE FROM multiremi_issue_workspaces WHERE issue_id = ?", [id]);
    const removed = this.ctx.db.run("DELETE FROM multiremi_issues WHERE id = ?", [id]);
    if (issue.projectId) {
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [nowIso(), issue.projectId]);
    }
    return removed.changes === 1;
  }

  /**
   * Persist the hard-delete fence before archive paths are snapshotted.
   * Re-entering an already deleting Issue is intentional: a process may stop
   * after writing the durable purge receipt and the next request must be able
   * to resume the same deletion.
   */
  beginIssueDeletion(id: string): BeginIssueDeletionResult {
    const issue = this.getIssue(id);
    if (!issue) {
      return { ok: false, code: "issue_not_found", error: "issue not found" };
    }
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
      this.ctx.lockIssueArchiveLifecycle(id);
      const current = this.getIssue(id);
      if (!current || current.workspaceId !== issue.workspaceId) {
        return { ok: false, code: "issue_not_found", error: "issue not found" } as const;
      }
      const block = this.issueDeletionBlockWithinLifecycleLock(id);
      if (block) return block;
      const state = this.issueLifecycleState(id);
      if (state !== "active" && state !== "deleting") {
        return {
          ok: false,
          code: "issue_deletion_conflict",
          error: "issue deletion lifecycle is not writable",
        } as const;
      }
      this.ctx.db.run(
        "UPDATE multiremi_issues SET lifecycle_state = 'deleting' WHERE id = ?",
        [id],
      );
      return { ok: true } as const;
    })();
  }

  abortIssueDeletion(id: string): void {
    const issue = this.getIssue(id);
    if (!issue) return;
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
      this.ctx.lockIssueArchiveLifecycle(id);
      this.ctx.db.run(
        "UPDATE multiremi_issues SET lifecycle_state = 'active' WHERE id = ? AND lifecycle_state = 'deleting'",
        [id],
      );
    })();
  }

  deletionLifecycleState(id: string): string | null {
    return this.getIssue(id) ? this.issueLifecycleState(id) : null;
  }

  private issueDeletionBlockWithinLifecycleLock(id: string): IssueDeletionBlockedResult | null {
    if (this.ctx.tasks().listTasksForIssue(id).some((task) => isActiveTaskStatus(task.status))) {
      return {
        ok: false,
        code: "issue_has_active_tasks",
        error: "active Issue tasks must finish before hard deletion",
      };
    }
    const workspace = this.ctx.db.query(
      `SELECT status, cleaned_archive_id, cleaned_archive_source_revision,
              cleaned_archive_sha256
       FROM multiremi_issue_workspaces WHERE issue_id = ?`,
    ).get(id) as { status?: unknown } | null;
    if (workspace) {
      if (String(workspace.status) !== "cleaned") {
        return {
          ok: false,
          code: "issue_workspace_not_cleaned",
          error: "issue workspace must be archived and cleaned before hard deletion",
        };
      }
      const archiveId = String((workspace as Row).cleaned_archive_id ?? "");
      const sourceRevision = String((workspace as Row).cleaned_archive_source_revision ?? "");
      const sha256 = String((workspace as Row).cleaned_archive_sha256 ?? "");
      const exactReady = archiveId && sourceRevision && sha256
        ? this.ctx.db.query(
          `SELECT 1 AS present FROM multiremi_session_archives
           WHERE id = ? AND issue_id = ? AND source_revision = ? AND sha256 = ?
             AND status = 'ready'`,
        ).get(archiveId, id, sourceRevision, sha256)
        : null;
      return exactReady
        ? null
        : {
          ok: false,
          code: "issue_workspace_archive_invalid",
          error: "cleaned Issue workspace is not bound to an exact ready session archive",
        };
    }
    // Missing workspace state is safe only for an Issue that was never
    // materialized. Any task/session/archive proves a Runtime touched it, so
    // absence of the cleanup acknowledgement must fail closed.
    const hasTask = Boolean(this.ctx.db.query(
      "SELECT 1 AS present FROM multiremi_tasks WHERE issue_id = ? LIMIT 1",
    ).get(id));
    const hasArchive = Boolean(this.ctx.db.query(
      "SELECT 1 AS present FROM multiremi_session_archives WHERE issue_id = ? LIMIT 1",
    ).get(id));
    const hasMaterializedSession = Boolean(this.ctx.db.query(
      `SELECT 1 AS present
       FROM multiremi_issue_sessions s
       WHERE s.issue_id = ? AND (
         s.is_default = 0
         OR EXISTS (SELECT 1 FROM multiremi_session_events e WHERE e.session_id = s.id)
         OR EXISTS (SELECT 1 FROM multiremi_session_participants p WHERE p.session_id = s.id)
         OR EXISTS (SELECT 1 FROM multiremi_session_agent_lanes l WHERE l.session_id = s.id)
       )
       LIMIT 1`,
    ).get(id));
    const hasRuntimeEvidence = hasTask || hasArchive || hasMaterializedSession;
    return hasRuntimeEvidence
      ? {
        ok: false,
        code: "issue_workspace_not_cleaned",
        error: "issue workspace cleanup state is missing for a materialized Issue",
      }
      : null;
  }

  private issueLifecycleState(id: string): string {
    const row = this.ctx.db.query(
      "SELECT lifecycle_state FROM multiremi_issues WHERE id = ?",
    ).get(id) as { lifecycle_state?: unknown } | null;
    return String(row?.lifecycle_state ?? "active");
  }

  batchDeleteIssues(input: BatchDeleteIssuesInput): { deleted: number } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    let deleted = 0;
    for (const issueId of issueIds) {
      if (this.deleteIssue(issueId)) deleted += 1;
    }
    return { deleted };
  }

  searchIssues(input: {
    q: string;
    workspaceId?: string | null;
    includeClosed?: boolean;
    includeCommentBodies?: boolean;
    limit?: number;
    offset?: number;
  }): { issues: MultiremiIssueSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const includeCommentBodies = input.includeCommentBodies !== false;
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listIssues().map((issue) => ({
      issue,
      matchedCommentSnippet: includeCommentBodies
        ? this.searchIssueCommentSnippet(issue.id, query)
        : null,
    })).filter(({ issue, matchedCommentSnippet }) => {
      if (issue.workspaceId !== workspaceId) return false;
      if (!includeClosed && CLOSED_ISSUE_STATUSES.has(issue.status)) return false;
      return searchMatch(issue.key, query)
        || searchMatch(issue.title, query)
        || searchMatch(issue.description ?? "", query)
        || matchedCommentSnippet !== null;
    }).map(({ issue, matchedCommentSnippet }) => {
      const matchSource = searchMatch(issue.key, query)
        ? "key"
        : searchMatch(issue.title, query)
          ? "title"
          : searchMatch(issue.description ?? "", query)
            ? "description"
            : "comment";
      const result: MultiremiIssueSearchResult = {
        ...issue,
        matchSource,
      };
      if (matchSource === "description" && issue.description) result.matchedDescriptionSnippet = extractSearchSnippet(issue.description, query);
      if (matchedCommentSnippet !== null) {
        result.matchedCommentSnippet = matchedCommentSnippet;
        if (matchSource === "comment") result.matchedSnippet = matchedCommentSnippet;
      }
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { issues: rows.slice(offset, offset + limit), total: rows.length };
  }

  private searchIssueCommentSnippet(issueId: string, query: string): string | null {
    const rows = this.ctx.db.query(
      "SELECT body FROM multiremi_issue_comments WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    const match = rows.find((row) => searchMatch(String(row.body ?? ""), query));
    return match ? extractSearchSnippet(String(match.body ?? ""), query) : null;
  }

  listChildIssues(parentIssueId: string): MultiremiIssue[] {
    const parent = this.getIssue(parentIssueId);
    if (!parent) throw new Error(`Issue not found: ${parentIssueId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_issues WHERE parent_issue_id = ? ORDER BY position ASC, created_at DESC",
    ).all(parentIssueId) as Row[];
    return rows.map((row) => this.hydrateIssue(toIssue(row)));
  }

  listChildIssueProgress(workspaceId = "local"): MultiremiIssueChildProgress[] {
    const rows = this.ctx.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multiremi_issues
       WHERE workspace_id = ? AND parent_issue_id IS NOT NULL
       GROUP BY parent_issue_id
       ORDER BY parent_issue_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(toChildIssueProgress);
  }

  getChildIssueProgress(parentIssueId: string): MultiremiIssueChildProgress {
    const row = this.ctx.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multiremi_issues
       WHERE parent_issue_id = ?
       GROUP BY parent_issue_id`,
    ).get(parentIssueId) as Row | null;
    return row ? toChildIssueProgress(row) : { parentIssueId, total: 0, done: 0 };
  }

  listIssueDependencies(issueId: string): MultiremiIssueDependency[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_issue_dependencies
       WHERE issue_id = ? OR depends_on_issue_id = ?
       ORDER BY created_at ASC`,
    ).all(issueId, issueId) as Row[];
    return rows.map((row) => this.hydrateIssueDependency(toIssueDependency(row)));
  }

  createIssueDependency(issueId: string, input: CreateIssueDependencyInput): MultiremiIssueDependency {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const dependsOnIssueId = input.dependsOnIssueId ?? input.depends_on_issue_id ?? "";
    const dependsOnIssue = this.getIssue(dependsOnIssueId);
    if (!dependsOnIssue) throw new Error(`Dependent issue not found: ${dependsOnIssueId}`);
    if (issue.id === dependsOnIssue.id) throw new Error("An issue cannot depend on itself");
    if (issue.workspaceId !== dependsOnIssue.workspaceId) throw new Error("Issue dependency must stay within a workspace");
    const type = normalizeIssueDependencyType(input.type);
    const id = input.id ?? createId("dep");
    const now = nowIso();
    const existing = this.ctx.db.query(
      `SELECT * FROM multiremi_issue_dependencies
       WHERE issue_id = ? AND depends_on_issue_id = ? AND type = ?`,
    ).get(issue.id, dependsOnIssue.id, type) as Row | null;
    if (existing) return this.hydrateIssueDependency(toIssueDependency(existing));
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_dependencies (
        id, workspace_id, issue_id, depends_on_issue_id, type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, issue.workspaceId, issue.id, dependsOnIssue.id, type, now],
    );
    this.ctx.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_added",
      body: `${type} ${dependsOnIssue.key}`,
      data: { dependencyId: id, dependsOnIssueId: dependsOnIssue.id, type },
    });
    return this.getIssueDependency(id)!;
  }

  getIssueDependency(id: string): MultiremiIssueDependency | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issue_dependencies WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueDependency(toIssueDependency(row)) : null;
  }

  deleteIssueDependency(issueId: string, dependencyId: string): void {
    const dependency = this.getIssueDependency(dependencyId);
    if (!dependency) return;
    if (dependency.issueId !== issueId && dependency.dependsOnIssueId !== issueId) {
      throw new Error(`Dependency not found for issue: ${issueId}`);
    }
    this.ctx.db.run("DELETE FROM multiremi_issue_dependencies WHERE id = ?", [dependencyId]);
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_removed",
      body: dependency.type,
      data: { dependencyId, issueId: dependency.issueId, dependsOnIssueId: dependency.dependsOnIssueId, type: dependency.type },
    });
  }

  updateIssue(id: string, input: UpdateIssueInput): MultiremiIssue {
    let previous: MultiremiIssue | null = null;
    let updatedAt = "";
    const updated = this.ctx.db.transaction(() => {
      // A no-op UPDATE is a portable write lock: Postgres locks this Issue row
      // until commit, while SQLite serializes the writer transaction. Re-read
      // only after acquiring it so a user terminal transition and a worker
      // lifecycle transition can never derive writes from the same stale row.
      const locked = this.ctx.db.run("UPDATE multiremi_issues SET id = id WHERE id = ?", [id]);
      if (locked.changes === 0) throw new Error(`Issue not found: ${id}`);
      const current = this.getIssue(id);
      if (!current) throw new Error(`Issue not found: ${id}`);
      previous = current;

      const nextWorkspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", current.workspaceId) ?? "local";
      const nextProjectId = resolveOptionalStringField(input, "projectId", "project_id", current.projectId);
      const nextParentIssueId = resolveOptionalStringField(input, "parentIssueId", "parent_issue_id", current.parentIssueId);
      let nextAssigneeType = resolveOptionalStringField(input, "assigneeType", "assignee_type", current.assigneeType) as MultiremiAssigneeType | null;
      let nextAssigneeId = resolveOptionalStringField(input, "assigneeId", "assignee_id", current.assigneeId);
      const nextStartDate = hasAnyField(input, "startDate", "start_date")
        ? normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date")
        : current.startDate;
      const nextDueDate = hasAnyField(input, "dueDate", "due_date")
        ? normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date")
        : current.dueDate;
      const nextAcceptanceCriteria = hasAnyField(input, "acceptanceCriteria", "acceptance_criteria")
        ? normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? [])
        : current.acceptanceCriteria;
      const nextContextRefs = hasAnyField(input, "contextRefs", "context_refs")
        ? normalizeJsonArray(input.contextRefs ?? input.context_refs ?? [])
        : current.contextRefs;

      if (nextProjectId) {
        const project = this.ctx.projects().getProject(nextProjectId);
        if (!project) throw new Error(`Project not found: ${nextProjectId}`);
        if (project.workspaceId !== nextWorkspaceId) throw new Error("Project belongs to another workspace");
      }
      if (nextParentIssueId) {
        const parent = this.getIssue(nextParentIssueId);
        if (!parent) throw new Error(`Parent issue not found: ${nextParentIssueId}`);
        if (parent.workspaceId !== nextWorkspaceId) throw new Error("Parent issue belongs to another workspace");
        this.validateIssueParent(id, nextParentIssueId);
      }
      if (hasAnyField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id")) {
        const requestedAssigneeType = hasAnyField(input, "assigneeType", "assignee_type")
          ? resolveOptionalStringField(input, "assigneeType", "assignee_type", current.assigneeType) as MultiremiAssigneeType | null
          : hasAnyField(input, "assigneeId", "assignee_id")
            ? null
            : nextAssigneeType;
        const resolvedAssignee = this.ctx.squads().resolveAssigneeRef(requestedAssigneeType, nextAssigneeId, nextWorkspaceId);
        nextAssigneeType = resolvedAssignee?.assigneeType ?? null;
        nextAssigneeId = resolvedAssignee?.assigneeId ?? null;
        this.validateIssueAssignee(nextAssigneeType, nextAssigneeId);
      }

      updatedAt = nowIso();
      this.ctx.db.run(
        `UPDATE multiremi_issues SET
        title = ?,
        description = ?,
        status = ?,
        priority = ?,
        workspace_id = ?,
        project_id = ?,
        parent_issue_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        position = ?,
        start_date = ?,
        due_date = ?,
        acceptance_criteria = ?,
        context_refs = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        hasAnyField(input, "status") ? normalizeIssueStatus(input.status) : current.status,
        normalizeIssuePriority(input.priority ?? current.priority),
        nextWorkspaceId,
        nextProjectId,
        nextParentIssueId,
        nextAssigneeType,
        nextAssigneeId,
        input.position === undefined || input.position === null ? current.position : normalizeIssuePosition(input.position),
        nextStartDate,
        nextDueDate,
        toJson(nextAcceptanceCriteria),
        toJson(nextContextRefs),
        updatedAt,
        id,
        ],
      );
      const next = this.getIssue(id)!;
      this.ctx.autopilots().enqueueIssueStatusChangedEvent({
        issue: next,
        previousStatus: current.status,
        actorType: "system",
        actorId: null,
      });
      return next;
    })();
    this.ctx.appendIssueActivity(id, {
      actorType: "system",
      actorId: null,
      type: "issue_updated",
      body: null,
      data: input,
    });
    if (previous!.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [updatedAt, previous!.projectId]);
    if (updated.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [updatedAt, updated.projectId]);
    this.notifyParentOfChildDone(previous!, updated);
    return updated;
  }

  private notifyParentOfChildDone(previous: MultiremiIssue, issue: MultiremiIssue): void {
    if (!issue.parentIssueId) return;
    if (previous.status === "done" || issue.status !== "done") return;
    const parent = this.getIssue(issue.parentIssueId);
    if (!parent) return;
    if (parent.status === "done" || parent.status === "cancelled") return;
    if (parent.assigneeType === "member") return;

    const body = childDoneSystemCommentBody({
      mentionPrefix: this.parentAssigneeMentionPrefix(parent),
      childKey: issue.key,
      childId: issue.id,
      childTitle: issue.title,
    });
    const comment = this.createSystemIssueComment(parent.id, body, {
      type: "child_done_parent_notification",
      childIssueId: issue.id,
      child_issue_id: issue.id,
    });
    this.triggerParentAssigneeForChildDone(parent, issue, comment);
  }

  private parentAssigneeMentionPrefix(parent: MultiremiIssue): string {
    if (!parent.assigneeType || !parent.assigneeId) return "";
    if (parent.assigneeType === "agent") {
      const agent = this.ctx.agents().getAgent(parent.assigneeId);
      if (!agent || agent.archivedAt || agent.workspaceId !== parent.workspaceId) return "";
      return `[@${sanitizeChildDoneMentionLabel(agent.name)}](mention://agent/${agent.id}) `;
    }
    if (parent.assigneeType === "squad") {
      const squad = this.ctx.squads().getSquad(parent.assigneeId);
      if (!squad || squad.archivedAt || squad.workspaceId !== parent.workspaceId) return "";
      return `[@${sanitizeChildDoneMentionLabel(squad.name)}](mention://squad/${squad.id}) `;
    }
    return "";
  }

  private createSystemIssueComment(issueId: string, body: string, data: Record<string, unknown>): MultiremiIssueComment {
    const id = createId("cmt");
    const now = nowIso();
    const issueSession = this.ctx.issueSessions().getOrCreateDefaultIssueSession(issueId);
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_comments (
         id, issue_id, issue_session_id, author_type, author_id, parent_id, body, type, created_at, updated_at
       ) VALUES (?, ?, ?, 'system', ?, NULL, ?, 'system', ?, ?)`,
      [id, issueId, issueSession.id, SYSTEM_AUTHOR_ID, body, now, now],
    );
    this.ctx.issueSessions().appendSessionEvent(issueSession.id, {
      authorType: "system",
      authorId: SYSTEM_AUTHOR_ID,
      kind: "system",
      body,
      sourceCommentId: id,
      metadata: data,
      createdAt: now,
    });
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "comment_created",
      body,
      data: { commentId: id, comment_id: id, ...data },
    });
    const comment = this.getIssueComment(id)!;
    // Same live-update contract as createIssueComment — system comments are
    // store-internal and never pass through the HTTP layer. Best-effort.
    try {
      const workspaceId = this.ctx.issueWorkspaceId(issueId);
      if (workspaceId) {
        this.ctx.emitWorkspaceEvent({
          type: "comment:created",
          workspaceId,
          actorType: "system",
          actorId: SYSTEM_AUTHOR_ID,
          payload: { comment },
        });
      }
    } catch (err) {
      log.warn(`comment:created broadcast skipped for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return comment;
  }

  private triggerParentAssigneeForChildDone(parent: MultiremiIssue, child: MultiremiIssue, systemComment: MultiremiIssueComment): void {
    if (!parent.assigneeType || !parent.assigneeId) return;
    if (parent.assigneeType === "agent") {
      const agent = this.ctx.agents().getAgent(parent.assigneeId);
      if (!agent || agent.archivedAt || agent.workspaceId !== parent.workspaceId) return;
      this.enqueueChildDoneParentTask(parent, agent, systemComment, parent.assigneeType, parent.assigneeId);
      return;
    }
    if (parent.assigneeType !== "squad") return;
    const squad = this.ctx.squads().getSquad(parent.assigneeId);
    if (!squad || squad.archivedAt || squad.workspaceId !== parent.workspaceId || !squad.leaderId) return;
    if (childAssigneeIsSquad(child, squad.id)) return;
    if (this.effectiveChildAgentOwner(child) === squad.leaderId) return;
    const leader = this.ctx.agents().getAgent(squad.leaderId);
    if (!leader || leader.archivedAt || leader.workspaceId !== parent.workspaceId) return;
    this.enqueueChildDoneParentTask(parent, leader, systemComment, parent.assigneeType, parent.assigneeId);
  }

  private enqueueChildDoneParentTask(
    parent: MultiremiIssue,
    agent: MultiremiAgent,
    systemComment: MultiremiIssueComment,
    assigneeType: MultiremiAssigneeType,
    assigneeId: string,
  ): void {
    if (this.hasActiveTaskForIssueAndAgent(parent.id, agent.id)) return;
    const task = this.ctx.tasks().createTask({
      agentId: agent.id,
      issueId: parent.id,
      triggerCommentId: systemComment.id,
      workspaceId: parent.workspaceId,
      prompt: childDoneParentTaskPrompt(systemComment),
    });
    this.ctx.appendIssueActivity(parent.id, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "child_done_parent_triggered",
      body: `Queued ${agent.name}`,
      data: {
        commentId: systemComment.id,
        comment_id: systemComment.id,
        assigneeType,
        assignee_type: assigneeType,
        assigneeId,
        assignee_id: assigneeId,
        agentId: agent.id,
        agent_id: agent.id,
        taskId: task.id,
        task_id: task.id,
      },
    });
  }

  private effectiveChildAgentOwner(child: MultiremiIssue): string | null {
    if (!child.assigneeType || !child.assigneeId) return null;
    if (child.assigneeType === "agent") return child.assigneeId;
    if (child.assigneeType !== "squad") return null;
    const squad = this.ctx.squads().getSquad(child.assigneeId);
    return squad?.leaderId ?? null;
  }

  assignIssue(id: string, input: AssignIssueInput): AssignIssueResult {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const requestedAssigneeType = input.assigneeType ?? input.assignee_type ?? null;
    const requestedAssigneeId = input.assigneeId ?? input.assignee_id ?? null;
    const actorType = input.actorType ?? input.actor_type ?? "system";
    const actorId = input.actorId ?? input.actor_id ?? null;
    const now = nowIso();

    if (requestedAssigneeType && !requestedAssigneeId) {
      throw new Error("Assignee id is required when assignee type is provided");
    }
    if (!requestedAssigneeType && !requestedAssigneeId) {
      const cancelled = this.cancelActiveIssueTasks(id, "issue_unassigned");
      this.ctx.db.run(
        "UPDATE multiremi_issues SET assignee_type = NULL, assignee_id = NULL, updated_at = ? WHERE id = ?",
        [now, id],
      );
      this.ctx.appendIssueActivity(id, {
        actorType,
        actorId,
        type: "issue_unassigned",
        body: null,
        data: { cancelled },
      });
      return { issue: this.getIssue(id)!, task: null };
    }

    // requestedAssigneeId is non-null here (the early-return above handled the
    // unassign case), so resolveAssigneeRef either returns a match or throws.
    const resolvedAssignee = this.ctx.squads().resolveAssigneeRef(requestedAssigneeType, requestedAssigneeId, current.workspaceId)!;
    const assigneeType = resolvedAssignee.assigneeType;
    const assigneeId = resolvedAssignee.assigneeId;
    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = assigneeType === "member" ? null : this.ctx.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (assigneeType !== "member" && !taskAgent) {
      throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);
    }
    const cancelled = this.cancelActiveIssueTasks(id, "issue_reassigned");
    this.ctx.db.run(
      `UPDATE multiremi_issues
       SET assignee_type = ?, assignee_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        assigneeType,
        assigneeId,
        taskAgent ? "todo" : current.status,
        now,
        id,
      ],
    );

    let task: MultiremiTask | null = null;
    if (taskAgent) {
      task = this.ctx.tasks().createTask({
        agentId: taskAgent.id,
        issueId: id,
        workspaceId: current.workspaceId,
        prompt: input.prompt?.trim() || current.title,
      });
    }
    if (assigneeType === "member") {
      this.addIssueSubscriber(id, assigneeId, "assigned");
      this.ctx.createInboxItem({
        issueId: id,
        memberId: assigneeId,
        type: "issue_assigned",
        title: `${current.key} assigned to you`,
        body: current.title,
        actorType: "system",
        actorId: null,
      });
    }

    this.ctx.appendIssueActivity(id, {
      actorType,
      actorId,
      type: "issue_assigned",
      body: taskAgent ? `Queued ${taskAgent.name}` : null,
      data: {
        assigneeType,
        assignee_type: assigneeType,
        assigneeId,
        assignee_id: assigneeId,
        toType: assigneeType,
        to_type: assigneeType,
        toId: assigneeId,
        to_id: assigneeId,
        taskId: task?.id ?? null,
        task_id: task?.id ?? null,
        cancelled,
      },
    });
    if (current.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    return { issue: this.getIssue(id)!, task };
  }

  quickCreateIssue(input: QuickCreateIssueInput): QuickCreateIssueResult {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("prompt is required");
    const agentId = input.agentId ?? input.agent_id ?? null;
    const squadId = input.squadId ?? input.squad_id ?? null;
    if (Boolean(agentId) === Boolean(squadId)) throw new Error("exactly one of agent_id or squad_id is required");

    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const projectId = input.projectId ?? input.project_id ?? null;
    if (projectId) {
      const project = this.ctx.projects().getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
      if (project.archivedAt) throw new Error("Project is archived");
    }

    const requestedAssigneeType: MultiremiAssigneeType = squadId ? "squad" : "agent";
    const requestedAssigneeId = squadId ?? agentId!;
    const resolvedAssignee = this.ctx.squads().resolveAssigneeRef(requestedAssigneeType, requestedAssigneeId, workspaceId);
    const assigneeType = resolvedAssignee?.assigneeType ?? requestedAssigneeType;
    const assigneeId = resolvedAssignee?.assigneeId ?? requestedAssigneeId;
    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = this.ctx.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (!taskAgent) throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);

    const issue = this.createIssue({
      title: quickCreateTitle(prompt),
      description: prompt,
      workspaceId,
      projectId,
      assigneeType,
      assigneeId,
      status: "todo",
      issueKind: "intake",
      createdBy: input.requesterId ?? input.requester_id ?? null,
      contextRefs: [{ type: "quick_create", prompt }],
    });
    const task = this.ctx.tasks().createTask({
      agentId: taskAgent.id,
      taskKind: "quick_create",
      issueId: issue.id,
      workspaceId,
      prompt: quickCreateTaskPrompt(prompt, projectId),
    });
    this.ctx.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: input.requesterId ?? input.requester_id ?? null,
      type: "quick_create_queued",
      body: prompt,
      data: { taskId: task.id, assigneeType, assigneeId, projectId },
    });
    return { issue: this.getIssue(issue.id)!, task };
  }

  createIssueComment(issueId: string, input: CreateIssueCommentInput): MultiremiIssueComment {
    const rawBody = input.body ?? input.content ?? "";
    if (!rawBody.trim()) throw new Error("Comment body is required");
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const parentId = input.parentId ?? input.parent_id ?? null;
    const parent = parentId ? this.getIssueComment(parentId) : null;
    if (parentId) {
      if (!parent || parent.issueId !== issueId) throw new Error(`Parent comment not found: ${parentId}`);
    }
    const issueSessionId = cleanOptionalString(input.issueSessionId ?? input.issue_session_id)
      ?? parent?.issueSessionId
      ?? this.ctx.issueSessions().getOrCreateDefaultIssueSession(issueId, input.authorId ?? null).id;
    const issueSession = this.ctx.issueSessions().getIssueSession(issueSessionId);
    if (!issueSession || issueSession.issueId !== issueId) {
      throw new Error(`Issue session not found for issue: ${issueSessionId}`);
    }
    if (parent && parent.issueSessionId && parent.issueSessionId !== issueSessionId) {
      throw new Error("Reply must belong to the parent comment's session");
    }
    const id = createId("cmt");
    const now = nowIso();
    const body = rawBody.trim();
    const taskId = cleanOptionalString(input.taskId ?? input.task_id) ?? null;
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_comments (
         id, issue_id, issue_session_id, author_type, author_id, task_id, parent_id, body, type, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, issueSessionId, input.authorType ?? "member", input.authorId ?? null, taskId, parentId, body, "comment", now, now],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, issueId, attachmentIds);
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    if (parentId) this.unresolveThreadRoot(parentId);
    const authorType = input.authorType ?? "member";
    if (authorType === "agent" && input.authorId) {
      this.ctx.issueSessions().addSessionParticipant(issueSessionId, {
        participantType: "agent",
        participantId: input.authorId,
      });
    } else if (authorType === "member" && input.authorId) {
      const member = this.ctx.workspaces().getWorkspaceMember(input.authorId) ?? this.ctx.workspaces().findWorkspaceMemberForUser(input.authorId, issue.workspaceId);
      if (member) {
        this.ctx.issueSessions().addSessionParticipant(issueSessionId, {
          participantType: "member",
          participantId: member.id,
        });
      }
    }
    this.ctx.issueSessions().appendSessionEvent(issueSessionId, {
      authorType,
      authorId: input.authorId ?? null,
      kind: "message",
      body,
      sourceCommentId: id,
      metadata: { parent_comment_id: parentId },
      createdAt: now,
    });
    if (authorType === "member" && input.authorId) {
      // authorId is a request user id, not a member row id — translate before
      // subscribing, and skip (rather than fail the comment) when the author
      // has no member row in this workspace.
      const authorMember = this.ctx.workspaces().findWorkspaceMemberForUser(input.authorId, issue.workspaceId);
      if (authorMember) this.addIssueSubscriber(issueId, authorMember.id, "commented");
    }
    this.ctx.appendIssueActivity(issueId, {
      actorType: authorType,
      actorId: input.authorId ?? null,
      type: "comment_created",
      body,
      data: { commentId: id },
    });
    const comment = this.getIssueComment(id)!;
    // Live-update open issue pages. Emitted from the store (not the HTTP
    // layer) because agent replies and system comments are created directly
    // through the store and would otherwise never reach the browser.
    this.ctx.emitWorkspaceEvent({
      type: "comment:created",
      workspaceId: issue.workspaceId,
      actorType: authorType,
      actorId: input.authorId ?? null,
      payload: { comment },
    });
    const mentionedMemberIds = this.triggerMemberMentions(issue, comment);
    this.notifySubscribedMembers(
      issue,
      "comment_created",
      "New comment",
      body,
      authorType,
      input.authorId ?? null,
      mentionedMemberIds,
      { comment_id: id, issue_session_id: issueSessionId },
    );
    const mentionTasks = this.triggerCommentMentions(issue, comment);
    this.triggerAssigneeAutoResponse(issue, comment, mentionTasks.length > 0 || mentionedMemberIds.length > 0);
    return comment;
  }

  /**
   * Un-mentioned human comments route to the issue's assigned agent (squad →
   * leader) so the assignee keeps the conversation without an explicit @
   * (MUL-35). Any explicit mention — agent, squad or member — suppresses this:
   * the author already addressed someone. Agent/system comments never trigger
   * it, so an agent's own replies cannot re-queue itself; agents wake other
   * agents only through explicit mentions. Each human comment dispatches
   * individually (no batching, by request).
   */
  private triggerAssigneeAutoResponse(
    issue: MultiremiIssue,
    comment: MultiremiIssueComment,
    hasExplicitMentions: boolean,
  ): MultiremiTask | null {
    if (comment.authorType !== "member") return null;
    if (hasExplicitMentions) return null;
    if (issue.assigneeType !== "agent" && issue.assigneeType !== "squad") return null;
    if (!issue.assigneeId) return null;
    const agent = this.ctx.resolveRunnableAgentForAssignee(issue.assigneeType, issue.assigneeId);
    if (!agent) return null;
    const task = this.ctx.tasks().createTask({
      agentId: agent.id,
      issueId: issue.id,
      triggerCommentId: comment.id,
      workspaceId: issue.workspaceId,
      prompt: assigneeCommentPrompt(comment),
    });
    this.ctx.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "comment_assignee_triggered",
      body: `Queued ${agent.name}`,
      data: {
        commentId: comment.id,
        assigneeType: issue.assigneeType,
        assigneeId: issue.assigneeId,
        agentId: agent.id,
        taskId: task.id,
      },
    });
    return task;
  }

  updateIssueComment(id: string, input: UpdateIssueCommentInput): MultiremiIssueComment {
    const current = this.ctx.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const body = (input.body ?? input.content ?? "").trim();
    if (!body) throw new Error("Comment body is required");
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issue_comments SET body = ?, updated_at = ? WHERE id = ?",
      [body, now, id],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, current.issueId, attachmentIds);
    if (current.body !== body) this.cancelTasksByTriggerComments([id]);
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    if (current.issueSessionId && current.body !== body) {
      this.ctx.issueSessions().appendSessionEvent(current.issueSessionId, {
        authorType: "system",
        authorId: null,
        kind: "message_edited",
        body,
        metadata: { comment_id: id, previous_body: current.body },
        createdAt: now,
      });
    }
    this.ctx.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_updated",
      body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  deleteIssueComment(id: string): void {
    const current = this.ctx.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const ids = this.collectCommentTreeIds(id);
    const deletedComments = ids
      .map((commentId) => this.ctx.getRawIssueComment(commentId))
      .filter((comment): comment is MultiremiIssueComment => comment !== null);
    const now = nowIso();
    this.cancelTasksByTriggerComments(ids);
    for (const commentId of ids) {
      this.ctx.db.run("DELETE FROM multiremi_comment_reactions WHERE comment_id = ?", [commentId]);
      this.ctx.db.run("DELETE FROM multiremi_attachments WHERE comment_id = ?", [commentId]);
    }
    for (const commentId of ids.slice().reverse()) {
      this.ctx.db.run("DELETE FROM multiremi_issue_comments WHERE id = ?", [commentId]);
    }
    for (const comment of deletedComments) {
      if (!comment.issueSessionId) continue;
      this.ctx.issueSessions().appendSessionEvent(comment.issueSessionId, {
        authorType: "system",
        authorId: null,
        kind: "message_deleted",
        body: "",
        metadata: { comment_id: comment.id, deleted_body: comment.body },
        createdAt: now,
      });
    }
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.ctx.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_deleted",
      body: current.body,
      data: { commentId: id, deletedCommentIds: ids },
    });
  }

  resolveIssueComment(id: string, input: { actorType?: string; actorId?: string | null } = {}): MultiremiIssueComment {
    const current = this.ctx.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_issue_comments
       SET resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?, updated_at = ?
       WHERE id = ?`,
      [now, input.actorType ?? "member", input.actorId ?? "local", now, id],
    );
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    if (current.issueSessionId) {
      this.ctx.issueSessions().appendSessionEvent(current.issueSessionId, {
        authorType: input.actorType ?? "member",
        authorId: input.actorId ?? "local",
        kind: "thread_resolved",
        body: current.body,
        metadata: { comment_id: id },
        createdAt: now,
      });
    }
    this.ctx.appendIssueActivity(current.issueId, {
      actorType: input.actorType ?? "member",
      actorId: input.actorId ?? "local",
      type: "comment_resolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  unresolveIssueComment(id: string): MultiremiIssueComment {
    const current = this.ctx.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (!current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [now, id],
    );
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    if (current.issueSessionId) {
      this.ctx.issueSessions().appendSessionEvent(current.issueSessionId, {
        authorType: "system",
        authorId: null,
        kind: "thread_unresolved",
        body: current.body,
        metadata: { comment_id: id },
        createdAt: now,
      });
    }
    this.ctx.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_unresolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  getIssueComment(id: string): MultiremiIssueComment | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueComment(toIssueComment(row)) : null;
  }

  listIssueComments(issueId: string): MultiremiIssueComment[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_issue_comments WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map((row) => this.hydrateIssueComment(toIssueComment(row)));
  }

  listIssueCommentsForGoCli(issueId: string, input: ListIssueCommentsInput = {}): ListIssueCommentsResult {
    const issueSessionId = cleanOptionalString(input.issueSessionId ?? input.issue_session_id);
    if (issueSessionId) {
      const session = this.ctx.issueSessions().getIssueSession(issueSessionId);
      if (!session || session.issueId !== issueId) throw new Error("issue session not found in this issue");
    }
    const comments = this.listIssueComments(issueId)
      .filter((comment) => !issueSessionId || comment.issueSessionId === issueSessionId)
      .slice(0, COMMENT_HARD_CAP);
    const since = parseCommentCursorTime(input.since);
    const rootsOnly = Boolean(input.rootsOnly ?? input.roots_only);
    const thread = normalizeCommentString(input.thread);
    const recent = normalizeNullableInteger(input.recent);
    const tail = normalizeNullableInteger(input.tail);
    const tailSet = input.tail !== undefined && input.tail !== null;
    const summary = Boolean(input.summary);
    const before = parseCommentCursorTime(input.before);
    const beforeId = normalizeCommentString(input.beforeId ?? input.before_id);

    validateCommentListOptions({ rootsOnly, thread, recent, tail, tailSet, before, beforeId });

    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    let nextBefore: string | null = null;
    let nextBeforeId: string | null = null;
    let selected: MultiremiIssueComment[];

    if (thread) {
      const anchor = byId.get(thread);
      if (!anchor) throw new Error("thread anchor not found in this issue");
      const rootId = commentThreadRootId(anchor, byId);
      const threadRows = comments.filter((comment) => comment.id === rootId || commentHasAncestorId(comment, rootId, byId));
      if (tailSet) {
        const root = threadRows.find((comment) => comment.id === rootId);
        let replies = threadRows
          .filter((comment) => comment.id !== rootId)
          .filter((comment) => !before || compareCommentCursor(comment, before, beforeId) < 0);
        const requestedTail = Math.min(tail ?? 0, COMMENT_HARD_CAP);
        const page = replies.slice(-(requestedTail + 1));
        let hasMore = page.length > requestedTail;
        replies = hasMore ? page.slice(1) : page;
        const retainedReplies = since
          ? replies.filter((comment) => commentCreatedAfter(comment, since))
          : replies;
        selected = root ? [root, ...retainedReplies] : retainedReplies;
        if (hasMore && replies.length > 0) {
          if (since && !commentCreatedAfter(replies[0]!, since)) hasMore = false;
          if (hasMore) {
            nextBefore = cursorTimestamp(replies[0]!);
            nextBeforeId = replies[0]!.id;
          }
        }
      } else {
        selected = since
          ? threadRows.filter((comment) => commentCreatedAfter(comment, since))
          : threadRows;
      }
    } else if (recent && recent > 0) {
      const groups = commentThreadGroups(comments);
      let ranked = groups
        .filter((group) => !before || compareCommentGroupCursor(group, before, beforeId) < 0)
        .sort((a, b) => (b.lastActivityMs - a.lastActivityMs) || b.rootId.localeCompare(a.rootId));
      ranked = ranked.slice(0, Math.min(recent, COMMENT_HARD_CAP));
      ranked.sort((a, b) => (a.lastActivityMs - b.lastActivityMs) || a.rootId.localeCompare(b.rootId));
      selected = ranked.flatMap((group) => {
        return since ? group.comments.filter((comment) => commentCreatedAfter(comment, since)) : group.comments;
      });
      const head = ranked[0];
      const emitCursor = ranked.length >= recent
        && head
        && (!since || head.lastActivityMs > since.getTime());
      if (emitCursor && head) {
        nextBefore = new Date(head.lastActivityMs).toISOString();
        nextBeforeId = head.rootId;
      }
    } else if (rootsOnly) {
      selected = comments
        .filter((comment) => !comment.parentId)
        .filter((comment) => !since || commentCreatedAfter(comment, since))
        .map((comment) => withCommentRootStats(comment, comments, byId));
    } else {
      selected = since ? comments.filter((comment) => commentCreatedAfter(comment, since)) : comments;
    }

    const out = summary ? selected.map(withCommentSummary) : selected.map(cloneComment);
    return {
      comments: out,
      nextBefore,
      nextBeforeId,
      next_before: nextBefore,
      next_before_id: nextBeforeId,
    };
  }

  listIssueActivity(issueId: string): MultiremiIssueActivity[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueActivity);
  }

  recordSquadLeaderEvaluation(issueId: string, input: {
    outcome: "action" | "no_action" | "failed" | string;
    reason?: string | null;
    taskId?: string | null;
    actorId?: string | null;
  }): MultiremiIssueActivity {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const outcome = String(input.outcome ?? "").trim();
    if (outcome !== "action" && outcome !== "no_action" && outcome !== "failed") {
      throw new Error("outcome must be 'action', 'no_action', or 'failed'");
    }
    if (issue.assigneeType !== "squad" || !issue.assigneeId) throw new Error("issue is not assigned to a squad");
    const squad = this.ctx.squads().getSquad(issue.assigneeId);
    if (!squad) throw new Error("squad not found");
    const actorId = input.actorId ?? squad.leaderId;
    if (squad.leaderId && actorId !== squad.leaderId) throw new Error("only the squad leader agent can record evaluations");
    if (input.taskId) {
      const task = this.ctx.tasks().getTask(input.taskId);
      if (!task || task.issueId !== issue.id) throw new Error("task does not belong to issue");
    }
    const id = createId("act");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at)
       VALUES (?, ?, 'agent', ?, 'squad_leader_evaluated', ?, ?, ?)`,
      [
        id,
        issue.id,
        actorId ?? null,
        input.reason ?? null,
        toJson({
          squad_id: squad.id,
          task_id: input.taskId ?? null,
          outcome,
          reason: input.reason ?? "",
        }),
        now,
      ],
    );
    return this.listIssueActivity(issue.id).find((activity) => activity.id === id)!;
  }

  listIssueTimeline(issueId: string, options: { ascending?: boolean; issueSessionId?: string | null } = {}): MultiremiTimelineEntry[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const sessionId = cleanOptionalString(options.issueSessionId);
    if (sessionId) {
      const session = this.ctx.issueSessions().getIssueSession(sessionId);
      if (!session || session.issueId !== issueId) throw new Error(`Issue session not found for issue: ${sessionId}`);
    }
    const entries: MultiremiTimelineEntry[] = [
      ...this.listIssueComments(issueId)
        .filter((comment) => !sessionId || comment.issueSessionId === sessionId)
        .map(commentToTimelineEntry),
      // Issue property changes belong to the Issue, not one product Session.
      // Keep them in the legacy aggregate timeline, while Session timelines
      // remain isolated conversation histories.
      ...(sessionId ? [] : this.listIssueActivity(issueId).map(activityToTimelineEntry)),
    ];
    const ascending = options.ascending !== false;
    return entries.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return ascending ? left.createdAt.localeCompare(right.createdAt) : right.createdAt.localeCompare(left.createdAt);
      }
      return ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id);
    });
  }

  listIssueSubscribers(issueId: string): MultiremiIssueSubscriber[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_issue_subscribers WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueSubscriber);
  }

  addIssueSubscriber(issueId: string, memberId: string, reason: MultiremiSubscriptionReason = "manual"): MultiremiIssueSubscriber {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const member = this.ctx.workspaces().getWorkspaceMember(memberId);
    if (!member) throw new Error(`Member not found: ${memberId}`);
    if (member.archivedAt) throw new Error(`Member is archived: ${memberId}`);
    if (member.workspaceId !== issue.workspaceId) throw new Error("target user is not a member of this workspace");
    return this.addTypedIssueSubscriber(issueId, "member", memberId, reason);
  }

  addTypedIssueSubscriber(
    issueId: string,
    userType: string,
    userId: string,
    reason: MultiremiSubscriptionReason = "manual",
  ): MultiremiIssueSubscriber {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const normalizedUserType = normalizeIssueSubscriberUserType(userType);
    if (!this.isWorkspaceSubscriberTarget(issue.workspaceId, normalizedUserType, userId)) {
      throw new Error("target user is not a member of this workspace");
    }
    const now = nowIso();
    const id = createId("sub");
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_subscribers (id, issue_id, member_id, user_type, user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, user_type, user_id) DO UPDATE SET reason = excluded.reason`,
      [id, issueId, userId, normalizedUserType, userId, reason, now],
    );
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_issue_subscribers WHERE issue_id = ? AND user_type = ? AND user_id = ?",
    ).get(issueId, normalizedUserType, userId) as Row | null;
    return toIssueSubscriber(row!);
  }

  removeIssueSubscriber(issueId: string, memberId: string): void {
    this.removeTypedIssueSubscriber(issueId, "member", memberId);
  }

  removeTypedIssueSubscriber(issueId: string, userType: string, userId: string): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const normalizedUserType = normalizeIssueSubscriberUserType(userType);
    if (!this.isWorkspaceSubscriberTarget(issue.workspaceId, normalizedUserType, userId)) {
      throw new Error("target user is not a member of this workspace");
    }
    this.ctx.db.run(
      "DELETE FROM multiremi_issue_subscribers WHERE issue_id = ? AND user_type = ? AND user_id = ?",
      [issueId, normalizedUserType, userId],
    );
  }

  private isWorkspaceSubscriberTarget(workspaceId: string, userType: string, userId: string): boolean {
    const id = cleanOptionalString(userId);
    if (!id) return false;
    if (userType === "member") {
      const member = this.ctx.workspaces().getWorkspaceMember(id);
      return Boolean(member && !member.archivedAt && member.workspaceId === workspaceId);
    }
    if (userType === "agent") {
      const agent = this.ctx.agents().getAgent(id);
      return Boolean(agent && !agent.archivedAt && agent.workspaceId === workspaceId);
    }
    return false;
  }

  listLabels(workspaceId?: string | null): MultiremiLabel[] {
    const rows = workspaceId
      ? this.ctx.db.query("SELECT * FROM multiremi_issue_labels WHERE workspace_id = ? ORDER BY lower(name) ASC").all(workspaceId) as Row[]
      : this.ctx.db.query("SELECT * FROM multiremi_issue_labels ORDER BY workspace_id ASC, lower(name) ASC").all() as Row[];
    return rows.map(toLabel);
  }

  getLabel(id: string): MultiremiLabel | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issue_labels WHERE id = ?").get(id) as Row | null;
    return row ? toLabel(row) : null;
  }

  createLabel(input: CreateLabelInput): MultiremiLabel {
    const name = normalizeLabelName(input.name);
    const color = normalizeLabelColor(input.color);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const existing = this.ctx.db.query(
      "SELECT id FROM multiremi_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?)",
    ).get(workspaceId, name) as Row | null;
    if (existing) throw new Error(`Label already exists in workspace: ${name}`);
    const id = input.id ?? createId("lbl");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_labels (id, workspace_id, name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, name, color, now, now],
    );
    return this.getLabel(id)!;
  }

  updateLabel(id: string, input: UpdateLabelInput): MultiremiLabel {
    const current = this.getLabel(id);
    if (!current) throw new Error(`Label not found: ${id}`);
    const name = input.name === undefined ? current.name : normalizeLabelName(input.name);
    const color = input.color === undefined ? current.color : normalizeLabelColor(input.color);
    const duplicate = this.ctx.db.query(
      "SELECT id FROM multiremi_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?) AND id != ?",
    ).get(current.workspaceId, name, id) as Row | null;
    if (duplicate) throw new Error(`Label already exists in workspace: ${name}`);
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issue_labels SET name = ?, color = ?, updated_at = ? WHERE id = ?",
      [name, color, now, id],
    );
    return this.getLabel(id)!;
  }

  deleteLabel(id: string): MultiremiLabel {
    const label = this.getLabel(id);
    if (!label) throw new Error(`Label not found: ${id}`);
    this.ctx.db.run("DELETE FROM multiremi_issue_labels WHERE id = ?", [id]);
    return label;
  }

  listLabelsForIssue(issueId: string): MultiremiLabel[] {
    const issue = this.ctx.db.query("SELECT id FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.ctx.db.query(
      `SELECT l.*
       FROM multiremi_issue_labels l
       JOIN multiremi_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id = ?
       ORDER BY lower(l.name) ASC`,
    ).all(issueId) as Row[];
    return rows.map(toLabel);
  }

  attachLabelToIssue(issueId: string, labelId: string): MultiremiLabel[] {
    const issueRow = this.ctx.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.ctx.db.query(
      "SELECT 1 FROM multiremi_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (existing) return this.listLabelsForIssue(issueId);
    this.ctx.db.run(
      "INSERT OR IGNORE INTO multiremi_issue_to_labels (issue_id, label_id) VALUES (?, ?)",
      [issueId, labelId],
    );
    const now = nowIso();
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_attached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  detachLabelFromIssue(issueId: string, labelId: string): MultiremiLabel[] {
    const issueRow = this.ctx.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.ctx.db.query(
      "SELECT 1 FROM multiremi_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (!existing) return this.listLabelsForIssue(issueId);
    this.ctx.db.run("DELETE FROM multiremi_issue_to_labels WHERE issue_id = ? AND label_id = ?", [issueId, labelId]);
    const now = nowIso();
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_detached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  listInboxItems(memberId?: string | null): MultiremiInboxItem[] {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return [];
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_inbox_items WHERE member_id = ? AND archived = 0 ORDER BY created_at DESC",
    ).all(resolvedMemberId) as Row[];
    return rows.map((row) => {
      const issueId = nullableString(row.issue_id);
      return toInboxItem(row, issueId ? this.getIssue(issueId) : null);
    });
  }

  markInboxItemRead(id: string): MultiremiInboxItem {
    const existing = this.ctx.db.query("SELECT issue_id FROM multiremi_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!existing) throw new Error(`Inbox item not found: ${id}`);
    this.ctx.db.run("UPDATE multiremi_inbox_items SET read = 1 WHERE id = ?", [id]);
    const row = this.ctx.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    const issueId = nullableString(row!.issue_id);
    return toInboxItem(row!, issueId ? this.getIssue(issueId) : null);
  }

  archiveInboxItem(id: string): MultiremiInboxItem {
    const rowBefore = this.ctx.db.query("SELECT issue_id FROM multiremi_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!rowBefore) throw new Error(`Inbox item not found: ${id}`);
    this.ctx.db.run("UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE id = ?", [id]);
    const row = this.ctx.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    const issueId = nullableString(row!.issue_id);
    return toInboxItem(row!, issueId ? this.getIssue(issueId) : null);
  }

  countUnreadInboxItems(memberId?: string | null): number {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const row = this.ctx.db.query(
      "SELECT COUNT(*) AS count FROM multiremi_inbox_items WHERE member_id = ? AND archived = 0 AND read = 0",
    ).get(resolvedMemberId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  markAllInboxItemsRead(memberId?: string | null): number {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const result = this.ctx.db.run(
      "UPDATE multiremi_inbox_items SET read = 1 WHERE member_id = ? AND archived = 0 AND read = 0",
      [resolvedMemberId],
    );
    return result.changes;
  }

  archiveAllInboxItems(memberId?: string | null, mode: "all" | "read" | "completed" = "all"): number {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    if (mode === "read") {
      return this.ctx.db.run(
        "UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE member_id = ? AND archived = 0 AND read = 1",
        [resolvedMemberId],
      ).changes;
    }
    if (mode === "completed") {
      return this.ctx.db.run(
        `UPDATE multiremi_inbox_items
         SET archived = 1, read = 1
         WHERE member_id = ?
           AND archived = 0
           AND issue_id IN (
             SELECT id FROM multiremi_issues WHERE status IN ('done', 'completed', 'closed', 'cancelled')
           )`,
        [resolvedMemberId],
      ).changes;
    }
    return this.ctx.db.run(
      "UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE member_id = ? AND archived = 0",
      [resolvedMemberId],
    ).changes;
  }

  listIssueReactions(issueId: string): MultiremiIssueReaction[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    return this.listReactions(ISSUE_REACTIONS, issueId);
  }

  addIssueReaction(issueId: string, input: ReactionInput): MultiremiIssueReaction {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return this.insertReaction(ISSUE_REACTIONS, issueId, issue.workspaceId, input);
  }

  removeIssueReaction(issueId: string, input: ReactionInput): void {
    this.deleteReaction(ISSUE_REACTIONS, issueId, input);
  }

  listCommentReactions(commentId: string): MultiremiCommentReaction[] {
    if (!this.ctx.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    return this.listReactions(COMMENT_REACTIONS, commentId);
  }

  addCommentReaction(commentId: string, input: ReactionInput): MultiremiCommentReaction {
    const comment = this.ctx.getRawIssueComment(commentId);
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    // Comments carry no workspace of their own, so it is resolved through the parent issue.
    const issue = this.getIssue(comment.issueId);
    return this.insertReaction(COMMENT_REACTIONS, commentId, issue?.workspaceId ?? "local", input);
  }

  removeCommentReaction(commentId: string, input: ReactionInput): void {
    this.deleteReaction(COMMENT_REACTIONS, commentId, input);
  }

  private listReactions<T>(spec: ReactionSpec<T>, parentId: string): T[] {
    const rows = this.ctx.db.query(
      `SELECT * FROM ${spec.table} WHERE ${spec.parentColumn} = ? ORDER BY created_at ASC`,
    ).all(parentId) as Row[];
    return rows.map(spec.hydrate);
  }

  private insertReaction<T>(spec: ReactionSpec<T>, parentId: string, workspaceId: string, input: ReactionInput): T {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.ctx.db.run(
      `INSERT INTO ${spec.table} (id, ${spec.parentColumn}, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(${spec.parentColumn}, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), parentId, workspaceId, actorType, actorId, emoji, nowIso()],
    );
    const row = this.ctx.db.query(
      `SELECT * FROM ${spec.table} WHERE ${spec.parentColumn} = ? AND actor_type = ? AND actor_id = ? AND emoji = ?`,
    ).get(parentId, actorType, actorId, emoji) as Row | null;
    return spec.hydrate(row!);
  }

  private deleteReaction<T>(spec: ReactionSpec<T>, parentId: string, input: ReactionInput): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.ctx.db.run(
      `DELETE FROM ${spec.table} WHERE ${spec.parentColumn} = ? AND actor_type = ? AND actor_id = ? AND emoji = ?`,
      [parentId, actorType, actorId, emoji],
    );
  }

  createAttachment(input: CreateAttachmentInput): MultiremiAttachment {
    if (!input.filename?.trim()) throw new Error("filename is required");
    if (!input.url?.trim()) throw new Error("url is required");
    const issueId = input.issueId ?? input.issue_id ?? null;
    const commentId = input.commentId ?? input.comment_id ?? null;
    const chatSessionId = input.chatSessionId ?? input.chat_session_id ?? null;
    const chatMessageId = input.chatMessageId ?? input.chat_message_id ?? null;
    const issue = issueId ? this.getIssue(issueId) : null;
    const comment = commentId ? this.ctx.getRawIssueComment(commentId) : null;
    const chatSession = chatSessionId ? this.ctx.chat().getChatSession(chatSessionId) : null;
    const chatMessage = chatMessageId ? this.ctx.chat().getChatMessage(chatMessageId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (commentId && !comment) throw new Error(`Comment not found: ${commentId}`);
    if (chatSessionId && !chatSession) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (chatMessageId && !chatMessage) throw new Error(`Chat message not found: ${chatMessageId}`);
    if (chatMessage && chatSessionId && chatMessage.chatSessionId !== chatSessionId) throw new Error(`Chat message belongs to another session: ${chatMessageId}`);
    const workspaceId = input.workspaceId
      ?? input.workspace_id
      ?? issue?.workspaceId
      ?? (comment ? this.getIssue(comment.issueId)?.workspaceId : null)
      ?? chatSession?.workspaceId
      ?? (chatMessage ? this.ctx.chat().getChatSession(chatMessage.chatSessionId)?.workspaceId : null)
      ?? "local";
    const id = input.id ?? createId("att");
    const uploaderType = input.uploaderType ?? input.uploader_type ?? "member";
    const uploaderId = input.uploaderId ?? input.uploader_id ?? "local";
    this.ctx.db.run(
      `INSERT INTO multiremi_attachments (
        id, workspace_id, issue_id, comment_id, chat_session_id, chat_message_id,
        uploader_type, uploader_id, filename, url, content_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        issueId,
        commentId,
        chatSessionId ?? chatMessage?.chatSessionId ?? null,
        chatMessageId,
        uploaderType,
        uploaderId,
        input.filename.trim(),
        input.url.trim(),
        input.contentType ?? input.content_type ?? "application/octet-stream",
        Math.max(0, Number(input.sizeBytes ?? input.size_bytes ?? 0)),
        nowIso(),
      ],
    );
    return this.getAttachment(id)!;
  }

  getAttachment(id: string): MultiremiAttachment | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_attachments WHERE id = ?").get(id) as Row | null;
    return row ? toAttachment(row) : null;
  }

  deleteAttachment(id: string): MultiremiAttachment | null {
    const attachment = this.getAttachment(id);
    if (!attachment) return null;
    this.ctx.db.run("DELETE FROM multiremi_attachments WHERE id = ?", [id]);
    return attachment;
  }

  listAttachmentsForIssue(issueId: string): MultiremiAttachment[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_attachments WHERE issue_id = ? AND comment_id IS NULL ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForComment(commentId: string): MultiremiAttachment[] {
    if (!this.ctx.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_attachments WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForChatMessage(chatMessageId: string): MultiremiAttachment[] {
    if (!this.ctx.chat().getChatMessage(chatMessageId)) throw new Error(`Chat message not found: ${chatMessageId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_attachments WHERE chat_message_id = ? ORDER BY created_at ASC",
    ).all(chatMessageId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForChatMessages(chatMessageIds: string[]): Map<string, MultiremiAttachment[]> {
    const grouped = new Map<string, MultiremiAttachment[]>();
    const ids = [...new Set(chatMessageIds.filter(Boolean))];
    if (!ids.length) return grouped;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_attachments WHERE chat_message_id IN (${placeholders}) ORDER BY created_at ASC`,
    ).all(...ids) as Row[];
    for (const attachment of rows.map(toAttachment)) {
      const messageId = attachment.chatMessageId;
      if (!messageId) continue;
      const list = grouped.get(messageId) ?? [];
      list.push(attachment);
      grouped.set(messageId, list);
    }
    return grouped;
  }

  linkAttachmentsToIssue(issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      this.ctx.db.run(
        "UPDATE multiremi_attachments SET issue_id = ?, workspace_id = ? WHERE id = ? AND issue_id IS NULL",
        [issueId, issue.workspaceId, attachmentId],
      );
    }
  }

  linkAttachmentsToChatMessage(chatSessionId: string, chatMessageId: string, attachmentIds: string[]): void {
    const session = this.ctx.chat().getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    const message = this.ctx.chat().getChatMessage(chatMessageId);
    if (!message) throw new Error(`Chat message not found: ${chatMessageId}`);
    if (message.chatSessionId !== chatSessionId) throw new Error("Chat message belongs to another session");
    if (!attachmentIds.length) return;
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.ctx.db.run(
      `UPDATE multiremi_attachments
       SET chat_message_id = ?
       WHERE chat_session_id = ?
         AND chat_message_id IS NULL
         AND id IN (${placeholders})`,
      [chatMessageId, chatSessionId, ...attachmentIds],
    );
  }

  listIssueMetadata(issueId: string): Record<string, string | number | boolean> {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return issue.metadata;
  }

  setIssueMetadataKey(issueId: string, key: string, value: unknown): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const normalized = validateIssueMetadataValue(value);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    if (!(key in metadata) && Object.keys(metadata).length >= MAX_ISSUE_METADATA_KEYS) {
      throw new Error(`metadata cannot exceed ${MAX_ISSUE_METADATA_KEYS} keys`);
    }
    metadata[key] = normalized;
    validateIssueMetadataSize(metadata);
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_set",
      body: `${key}=${String(normalized)}`,
      data: { key, value: normalized },
    });
    return this.listIssueMetadata(issueId);
  }

  deleteIssueMetadataKey(issueId: string, key: string): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    delete metadata[key];
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_deleted",
      body: key,
      data: { key },
    });
    return this.listIssueMetadata(issueId);
  }

  private validateIssueAssignee(assigneeType: MultiremiAssigneeType | null, assigneeId: string | null): void {
    if (!assigneeType && !assigneeId) return;
    if (!assigneeType || !assigneeId) throw new Error("Assignee type and id are required together");
    if (assigneeType === "agent") {
      const agent = this.ctx.agents().getAgent(assigneeId);
      if (!agent) throw new Error(`Agent not found: ${assigneeId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${assigneeId}`);
    } else if (assigneeType === "member") {
      const member = this.ctx.workspaces().getWorkspaceMember(assigneeId);
      if (!member) throw new Error(`Member not found: ${assigneeId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${assigneeId}`);
    } else if (assigneeType === "squad") {
      const squad = this.ctx.squads().getSquad(assigneeId);
      if (!squad) throw new Error(`Squad not found: ${assigneeId}`);
      if (squad.archivedAt) throw new Error(`Squad is archived: ${assigneeId}`);
    } else {
      throw new Error(`Unsupported assignee type: ${assigneeType}`);
    }
  }

  private validateIssueParent(issueId: string, parentIssueId: string): void {
    if (issueId === parentIssueId) throw new Error("An issue cannot be its own parent");
    let cursor: string | null = parentIssueId;
    const seen = new Set<string>();
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === issueId) throw new Error("Circular parent issue relationship detected");
      if (seen.has(cursor)) throw new Error("Circular parent issue relationship detected");
      seen.add(cursor);
      cursor = this.getIssue(cursor)?.parentIssueId ?? null;
    }
  }

  private cancelActiveIssueTasks(issueId: string, reason: string): number {
    const active = this.ctx.db.query(
      "SELECT * FROM multiremi_tasks WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(issueId) as Row[];
    if (!active.length) return 0;
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_tasks
       SET status = 'cancelled', completed_at = ?, cancelled_at = ?, updated_at = ?
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, now, issueId],
    );
    for (const row of active) {
      this.ctx.appendIssueActivity(issueId, {
        actorType: "system",
        actorId: null,
        type: "task_cancelled",
        body: reason,
        data: { taskId: String(row.id), agentId: nullableString(row.agent_id) },
      });
    }
    return active.length;
  }

  private cancelTasksByTriggerComments(commentIds: string[]): number {
    if (!commentIds.length) return 0;
    const placeholders = commentIds.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT id FROM multiremi_tasks
       WHERE trigger_comment_id IN (${placeholders})
         AND status NOT IN ('completed', 'failed', 'cancelled')`,
    ).all(...commentIds) as Row[];
    for (const row of rows) this.ctx.tasks().cancelTask(String(row.id));
    return rows.length;
  }

  private hydrateIssue(issue: MultiremiIssue): MultiremiIssue {
    return {
      ...issue,
      labels: this.listLabelsForIssue(issue.id),
    };
  }

  private hydrateIssues(issues: MultiremiIssue[]): MultiremiIssue[] {
    if (issues.length === 0) return issues;
    const labelsByIssue = this.labelsForIssues(issues.map((issue) => issue.id));
    return issues.map((issue) => ({ ...issue, labels: labelsByIssue.get(issue.id) ?? [] }));
  }

  private labelsForIssues(issueIds: string[]): Map<string, MultiremiLabel[]> {
    const result = new Map<string, MultiremiLabel[]>();
    if (issueIds.length === 0) return result;
    const placeholders = issueIds.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT il.issue_id AS __issue_id, l.*
       FROM multiremi_issue_labels l
       JOIN multiremi_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id IN (${placeholders})
       ORDER BY lower(l.name) ASC`,
    ).all(...issueIds) as Row[];
    for (const row of rows) {
      const issueId = String(row.__issue_id);
      const list = result.get(issueId) ?? [];
      list.push(toLabel(row));
      result.set(issueId, list);
    }
    return result;
  }

  private hydrateIssueComment(comment: MultiremiIssueComment): MultiremiIssueComment {
    return {
      ...comment,
      reactions: this.listCommentReactions(comment.id),
      attachments: this.listAttachmentsForComment(comment.id),
    };
  }

  private hydrateIssueDependency(dependency: MultiremiIssueDependency): MultiremiIssueDependency {
    return {
      ...dependency,
      issue: this.getIssue(dependency.issueId),
      dependsOnIssue: this.getIssue(dependency.dependsOnIssueId),
    };
  }

  private collectCommentTreeIds(commentId: string): string[] {
    const ids: string[] = [];
    const visit = (id: string) => {
      ids.push(id);
      const rows = this.ctx.db.query("SELECT id FROM multiremi_issue_comments WHERE parent_id = ? ORDER BY created_at ASC").all(id) as Row[];
      for (const row of rows) visit(String(row.id));
    };
    visit(commentId);
    return ids;
  }

  private unresolveThreadRoot(commentId: string): void {
    let current = this.ctx.getRawIssueComment(commentId);
    while (current?.parentId) current = this.ctx.getRawIssueComment(current.parentId);
    if (!current?.resolvedAt) return;
    this.ctx.db.run(
      "UPDATE multiremi_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), current.id],
    );
  }

  private linkAttachmentsToComment(commentId: string, issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      if (attachment.issueId && attachment.issueId !== issueId) throw new Error(`Attachment belongs to another issue: ${attachmentId}`);
      this.ctx.db.run(
        `UPDATE multiremi_attachments
         SET issue_id = ?, comment_id = ?, workspace_id = ?
         WHERE id = ? AND comment_id IS NULL`,
        [issueId, commentId, issue.workspaceId, attachmentId],
      );
    }
  }

  private notifySubscribedMembers(
    issue: MultiremiIssue,
    type: string,
    title: string,
    body: string | null,
    actorType: string,
    actorId: string | null,
    excludedMemberIds: string[] = [],
    details: unknown | null = null,
  ): void {
    const subscribers = this.listIssueSubscribers(issue.id);
    const excluded = new Set(excludedMemberIds);
    for (const subscriber of subscribers) {
      if (subscriber.userType !== "member") continue;
      if (actorType === "member" && actorId === subscriber.userId) continue;
      if (excluded.has(subscriber.userId)) continue;
      this.ctx.createInboxItem({
        issueId: issue.id,
        memberId: subscriber.userId,
        type,
        title: `${issue.key}: ${title}`,
        body,
        actorType,
        actorId,
        details,
      });
    }
  }

  private triggerMemberMentions(issue: MultiremiIssue, comment: MultiremiIssueComment): string[] {
    const targets = this.resolveCommentMemberMentionTargets(comment.body, issue.workspaceId);
    const notified: string[] = [];
    for (const memberId of targets) {
      if (comment.authorType === "member" && comment.authorId === memberId) continue;
      this.addIssueSubscriber(issue.id, memberId, "mentioned");
      this.ctx.createInboxItem({
        issueId: issue.id,
        memberId,
        type: "comment_mention",
        title: `${issue.key}: mentioned you`,
        body: comment.body,
        actorType: comment.authorType,
        actorId: comment.authorId,
        details: {
          comment_id: comment.id,
          issue_session_id: comment.issueSessionId,
        },
      });
      notified.push(memberId);
    }
    return notified;
  }

  private triggerCommentMentions(issue: MultiremiIssue, comment: MultiremiIssueComment): MultiremiTask[] {
    const targets = this.resolveCommentMentionTargets(comment.body, issue.workspaceId);
    if (!targets.length) return [];

    const tasks: MultiremiTask[] = [];
    const seenAgents = new Set<string>();
    for (const target of targets) {
      const agent = this.ctx.resolveRunnableAgentForAssignee(target.assigneeType, target.assigneeId);
      if (!agent || seenAgents.has(agent.id)) continue;
      if (comment.authorType === "agent" && comment.authorId === agent.id) continue;
      seenAgents.add(agent.id);
      const task = this.ctx.tasks().createTask({
        agentId: agent.id,
        issueId: issue.id,
        triggerCommentId: comment.id,
        workspaceId: issue.workspaceId,
        prompt: commentMentionPrompt(comment),
      });
      tasks.push(task);
      this.ctx.appendIssueActivity(issue.id, {
        actorType: "system",
        actorId: null,
        type: "comment_mention_triggered",
        body: `Queued ${agent.name}`,
        data: {
          commentId: comment.id,
          assigneeType: target.assigneeType,
          assigneeId: target.assigneeId,
          agentId: agent.id,
          taskId: task.id,
        },
      });
    }
    return tasks;
  }

  private resolveCommentMentionTargets(body: string, workspaceId: string): Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> {
    const targets: Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> = [];
    const seen = new Set<string>();
    const addTarget = (assigneeType: "agent" | "squad", assigneeId: string) => {
      const key = `${assigneeType}:${assigneeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ assigneeType, assigneeId });
    };

    // A comment can only mention agents/squads in its own workspace — otherwise
    // an explicit mention:// id (or a name collision) would spawn a task for
    // another workspace's agent, and createTask would then reject the
    // cross-workspace issue link anyway.
    const inWorkspaceAgent = (id: string) => this.ctx.agents().getAgent(id)?.workspaceId === workspaceId;
    const inWorkspaceSquad = (id: string) => this.ctx.squads().getSquad(id)?.workspaceId === workspaceId;

    const markdownMention = /mention:\/\/(agent|squad)\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      const kind = match[1] as "agent" | "squad";
      const id = match[2]!;
      if (kind === "agent" ? inWorkspaceAgent(id) : inWorkspaceSquad(id)) addTarget(kind, id);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    for (const agent of this.ctx.agents().listAgents()) {
      if (agent.workspaceId === workspaceId && hasPlainMention(withoutLinks, agent.name)) addTarget("agent", agent.id);
    }
    for (const squad of this.ctx.squads().listSquads()) {
      if (squad.workspaceId === workspaceId && hasPlainMention(withoutLinks, squad.name)) addTarget("squad", squad.id);
    }
    return targets;
  }

  private resolveCommentMemberMentionTargets(body: string, workspaceId: string): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const addTarget = (memberId: string) => {
      if (seen.has(memberId)) return;
      seen.add(memberId);
      targets.push(memberId);
    };

    const markdownMention = /mention:\/\/member\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      const member = this.ctx.workspaces().getWorkspaceMember(match[1]);
      if (member && !member.archivedAt) addTarget(member.id);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    if (/(^|\s)@all(?=$|\s|[.,:;!?])/i.test(withoutLinks)) {
      for (const member of this.ctx.workspaces().listWorkspaceMembers(workspaceId)) addTarget(member.id);
      return targets;
    }

    for (const member of this.ctx.workspaces().listWorkspaceMembers(workspaceId)) {
      if (hasPlainMention(withoutLinks, member.name)) addTarget(member.id);
    }
    return targets;
  }

  private hasActiveTaskForIssueAndAgent(issueId: string, agentId: string): boolean {
    const row = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_tasks
       WHERE issue_id = ? AND agent_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    ).get(issueId, agentId) as { present: number } | null;
    return Boolean(row);
  }

  private nextIssueNumber(workspaceId: string): number {
    const row = this.ctx.db.query(
      "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multiremi_issues WHERE workspace_id = ?",
    ).get(workspaceId) as { next: number } | null;
    return Number(row?.next ?? 1);
  }
}

function formatIssueKey(number: number): string {
  return `MUL-${number}`;
}

function commentMentionPrompt(_comment: MultiremiIssueComment): string {
  return "A teammate mentioned you in an issue comment. Respond to the current triggering comment.";
}

function assigneeCommentPrompt(_comment: MultiremiIssueComment): string {
  return "A teammate commented on an issue assigned to you. Respond to the current triggering comment as the issue's assignee.";
}

function childDoneParentTaskPrompt(comment: MultiremiIssueComment): string {
  return [
    "A sub-issue assigned under this issue was marked done.",
    "",
    "## Platform Comment",
    comment.body,
  ].join("\n");
}

function childDoneSystemCommentBody(input: {
  mentionPrefix: string;
  childKey: string;
  childId: string;
  childTitle: string;
}): string {
  const title = sanitizeChildDoneTitle(input.childTitle);
  return [
    `${input.mentionPrefix}Sub-issue [${input.childKey}](mention://issue/${input.childId}) - "${title}" - is done.`,
    "Before promoting any waiting backlog sub-issue, read each sibling's description and only promote items whose stated dependencies are already satisfied.",
    "If a sibling's description conflicts with the parent breakdown, leave it backlog and post a comment to confirm first.",
  ].join(" ");
}

function sanitizeChildDoneTitle(title: string): string {
  return title.replaceAll("](mention://", "] (mention-stripped://").trim();
}

function sanitizeChildDoneMentionLabel(name: string): string {
  const cleaned = name.replaceAll("]", "").trim();
  return cleaned || "assignee";
}

function childAssigneeIsSquad(child: MultiremiIssue, squadId: string): boolean {
  return child.assigneeType === "squad" && child.assigneeId === squadId;
}

type CommentListValidationInput = {
  rootsOnly: boolean;
  thread: string | null;
  recent: number | null;
  tail: number | null;
  tailSet: boolean;
  before: Date | null;
  beforeId: string | null;
};

type CommentThreadGroup = {
  rootId: string;
  lastActivityMs: number;
  comments: MultiremiIssueComment[];
};

function validateCommentListOptions(input: CommentListValidationInput): void {
  if (input.rootsOnly && input.thread) throw new Error("roots_only and thread are mutually exclusive");
  if (input.rootsOnly && input.recent !== null) throw new Error("roots_only and recent are mutually exclusive");
  if (input.rootsOnly && input.tailSet) throw new Error("roots_only and tail are mutually exclusive");
  if (input.rootsOnly && (input.before || input.beforeId)) throw new Error("roots_only does not support before / before_id");
  if (input.thread && input.recent !== null) throw new Error("thread and recent are mutually exclusive");
  if (input.tailSet && !input.thread) throw new Error("tail requires thread (it is a thread-scoped limit)");
  if (input.recent !== null && (!Number.isFinite(input.recent) || input.recent <= 0)) {
    throw new Error("invalid recent parameter; expected positive integer");
  }
  if (input.tailSet && (input.tail === null || !Number.isFinite(input.tail) || input.tail < 0)) {
    throw new Error("invalid tail parameter; expected non-negative integer");
  }
  if (Boolean(input.before) !== Boolean(input.beforeId)) {
    throw new Error("before and before_id must be set together (composite cursor)");
  }
  if (input.before && input.recent === null && (!input.thread || !input.tailSet)) {
    throw new Error("before / before_id require recent (thread cursor) or thread + tail (reply cursor)");
  }
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  return Math.floor(number);
}

function normalizeCommentString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCommentCursorTime(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const time = new Date(String(value));
  if (!Number.isFinite(time.getTime())) throw new Error("invalid timestamp parameter; expected RFC3339 format");
  return time;
}

function cloneComment(comment: MultiremiIssueComment): MultiremiIssueComment {
  return { ...comment };
}

function withCommentSummary(comment: MultiremiIssueComment): MultiremiIssueComment {
  const cloned = cloneComment(comment);
  const runes = Array.from(cloned.body);
  const truncated = runes.length > COMMENT_SUMMARY_RUNES;
  const body = truncated ? `${runes.slice(0, COMMENT_SUMMARY_RUNES).join("")}…` : cloned.body;
  return {
    ...cloned,
    body,
    content: body,
    contentTruncated: truncated,
    content_truncated: truncated,
  };
}

function commentCreatedAfter(comment: MultiremiIssueComment, since: Date): boolean {
  return Date.parse(comment.createdAt) > since.getTime();
}

function cursorTimestamp(comment: MultiremiIssueComment): string {
  const ms = Date.parse(comment.createdAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : comment.createdAt;
}

function compareCommentCursor(comment: MultiremiIssueComment, before: Date | number, beforeId: string | null): number {
  const left = Date.parse(comment.createdAt);
  const right = before instanceof Date ? before.getTime() : before;
  if (left !== right) return left < right ? -1 : 1;
  if (!beforeId || comment.id === beforeId) return 0;
  return comment.id < beforeId ? -1 : 1;
}

function compareCommentGroupCursor(group: CommentThreadGroup, before: Date | number, beforeId: string | null): number {
  const right = before instanceof Date ? before.getTime() : before;
  if (group.lastActivityMs !== right) return group.lastActivityMs < right ? -1 : 1;
  if (!beforeId || group.rootId === beforeId) return 0;
  return group.rootId < beforeId ? -1 : 1;
}

function commentThreadRootId(comment: MultiremiIssueComment, byId: Map<string, MultiremiIssueComment>): string {
  const seen = new Set<string>();
  let current = comment;
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function commentHasAncestorId(comment: MultiremiIssueComment, ancestorId: string, byId: Map<string, MultiremiIssueComment>): boolean {
  const seen = new Set<string>();
  let parentId = comment.parentId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

function commentThreadGroups(comments: MultiremiIssueComment[]): CommentThreadGroup[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const grouped = new Map<string, MultiremiIssueComment[]>();
  for (const comment of comments) {
    const rootId = commentThreadRootId(comment, byId);
    const group = grouped.get(rootId) ?? [];
    group.push(comment);
    grouped.set(rootId, group);
  }
  return [...grouped.entries()].map(([rootId, groupComments]) => {
    const lastActivityMs = Math.max(...groupComments.map((comment) => Date.parse(comment.createdAt)).filter(Number.isFinite));
    return {
      rootId,
      lastActivityMs: Number.isFinite(lastActivityMs) ? lastActivityMs : 0,
      comments: groupComments.sort((a, b) => compareCommentCursor(a, Date.parse(b.createdAt), b.id)),
    };
  });
}

function withCommentRootStats(
  comment: MultiremiIssueComment,
  allComments: MultiremiIssueComment[],
  byId: Map<string, MultiremiIssueComment>,
): MultiremiIssueComment {
  const descendants = allComments.filter((item) => item.id !== comment.id && commentHasAncestorId(item, comment.id, byId));
  const activityTimes = [comment, ...descendants]
    .map((item) => Date.parse(item.createdAt))
    .filter(Number.isFinite);
  const lastActivityMs = Math.max(...activityTimes);
  const lastActivityAt = Number.isFinite(lastActivityMs) ? new Date(lastActivityMs).toISOString() : comment.createdAt;
  return {
    ...comment,
    replyCount: descendants.length,
    reply_count: descendants.length,
    lastActivityAt,
    last_activity_at: lastActivityAt,
  };
}

function hasPlainMention(body: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,:;!?])`, "i").test(body);
}

function validateIssueMetadataKey(key: string): void {
  if (!key) throw new Error("key is required");
  if (!ISSUE_METADATA_KEY_RE.test(key)) {
    throw new Error("key must match ^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$");
  }
}

function validateIssueMetadataValue(value: unknown): string | number | boolean {
  if (!isIssueMetadataPrimitive(value)) {
    if (value === null) throw new Error("value cannot be null");
    throw new Error("value must be a primitive: string, number, or bool");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("value must be a finite number");
  }
  return value;
}

function isIssueMetadataPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function validateIssueMetadataSize(metadata: Record<string, string | number | boolean>): void {
  if (Buffer.byteLength(toJson(metadata), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
}

function normalizeIssuePriority(value: string | undefined): MultiremiIssuePriority {
  const priority = String(value ?? "none").trim().toLowerCase();
  if (priority === "urgent" || priority === "high" || priority === "medium" || priority === "low" || priority === "none") {
    return priority;
  }
  throw new Error("priority must be one of urgent, high, medium, low, or none");
}

function normalizeIssueDependencyType(value: string | undefined): MultiremiIssueDependencyType {
  const type = String(value ?? "related").trim().toLowerCase();
  if (type === "blocks" || type === "blocked_by" || type === "related") return type;
  throw new Error("dependency type must be one of blocks, blocked_by, or related");
}

function issueMatchesListFilter(issue: MultiremiIssue, input: ListIssuesInput): boolean {
  const workspaceId = input.workspaceId ?? input.workspace_id;
  if (workspaceId && issue.workspaceId !== workspaceId) return false;
  const statuses = normalizeIssueStatusList(input.statuses ?? input.status);
  if (statuses.length && !statuses.includes(issue.status)) return false;
  const priorities = normalizeStringList(input.priorities ?? input.priority);
  if (priorities.length && !priorities.includes(issue.priority)) return false;
  const assigneeTypes = normalizeStringList(input.assigneeTypes ?? input.assignee_types);
  if (assigneeTypes.length && (!issue.assigneeType || !assigneeTypes.includes(issue.assigneeType))) return false;
  const assigneeId = input.assigneeId ?? input.assignee_id;
  if (assigneeId && issue.assigneeId !== assigneeId) return false;
  const assigneeIds = normalizeStringList(input.assigneeIds ?? input.assignee_ids);
  if (assigneeIds.length && (!issue.assigneeId || !assigneeIds.includes(issue.assigneeId))) return false;
  if (input.includeNoAssignee && issue.assigneeId !== null) return false;
  const projectId = input.projectId ?? input.project_id;
  if (projectId && issue.projectId !== projectId) return false;
  const projectIds = normalizeStringList(input.projectIds ?? input.project_ids);
  if (projectIds.length && (!issue.projectId || !projectIds.includes(issue.projectId))) return false;
  if (input.includeNoProject && issue.projectId !== null) return false;
  if (input.metadata) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (issue.metadata[key] !== value) return false;
    }
  }
  return true;
}

// SQL equivalent of issueMatchesListFilter for every column-level filter (metadata, a JSON column,
// stays in JS). Kept in lockstep with issueMatchesListFilter so callers can push filters + pagination
// into SQL without changing results.

function buildIssueListWhere(input: ListIssuesInput): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const inClause = (column: string, values: string[]) => {
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };

  const workspaceId = input.workspaceId ?? input.workspace_id;
  if (workspaceId) {
    clauses.push("workspace_id = ?");
    params.push(workspaceId);
  }
  const statuses = normalizeIssueStatusList(input.statuses ?? input.status);
  if (statuses.length) inClause("status", statuses);
  const priorities = normalizeStringList(input.priorities ?? input.priority);
  if (priorities.length) inClause("priority", priorities);
  const assigneeTypes = normalizeStringList(input.assigneeTypes ?? input.assignee_types);
  if (assigneeTypes.length) inClause("assignee_type", assigneeTypes);
  const assigneeId = input.assigneeId ?? input.assignee_id;
  if (assigneeId) {
    clauses.push("assignee_id = ?");
    params.push(assigneeId);
  }
  const assigneeIds = normalizeStringList(input.assigneeIds ?? input.assignee_ids);
  if (assigneeIds.length) inClause("assignee_id", assigneeIds);
  if (input.includeNoAssignee) clauses.push("(assignee_id IS NULL OR assignee_id = '')");
  const projectId = input.projectId ?? input.project_id;
  if (projectId) {
    clauses.push("project_id = ?");
    params.push(projectId);
  }
  const projectIds = normalizeStringList(input.projectIds ?? input.project_ids);
  if (projectIds.length) inClause("project_id", projectIds);
  if (input.includeNoProject) clauses.push("(project_id IS NULL OR project_id = '')");

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function normalizeStringList(value: string[] | string | undefined | null): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeIssueStatus(value: unknown): string {
  const status = String(value ?? "todo").trim();
  if (status === "open") return "todo";
  return (ISSUE_STATUSES as readonly string[]).includes(status) ? status : "todo";
}

function normalizeIssueStatusList(value: string[] | string | undefined | null): string[] {
  const statuses = normalizeStringList(value).map(normalizeIssueStatus);
  return [...new Set(statuses)];
}

function normalizeListOffset(value: number | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeListLimit(value: number | undefined, fallback = 200, max = 500): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
}

function assigneeGroupId(type: MultiremiAssigneeType | null, id: string | null): string {
  return type && id ? `${type}:${id}` : "none";
}

function assigneeGroupRank(type: MultiremiAssigneeType | null): number {
  if (type === "member") return 0;
  if (type === "agent") return 1;
  if (type === "squad") return 2;
  return 3;
}

function hasIssueMutation(input: UpdateIssueInput): boolean {
  return hasAnyField(
    input,
    "title",
    "description",
    "status",
    "priority",
    "projectId",
    "project_id",
    "workspaceId",
    "workspace_id",
    "parentIssueId",
    "parent_issue_id",
    "assigneeType",
    "assignee_type",
    "assigneeId",
    "assignee_id",
    "position",
    "startDate",
    "start_date",
    "dueDate",
    "due_date",
    "acceptanceCriteria",
    "acceptance_criteria",
    "contextRefs",
    "context_refs",
  );
}

function quickCreateTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? prompt.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function quickCreateTaskPrompt(prompt: string, projectId: string | null): string {
  const projectInstructions = projectId
    ? [
        `The user explicitly selected project ${projectId}.`,
        "Keep the issue in that project; do not infer or move it to another project.",
      ]
    : [
        "The user did not select a project.",
        "Inspect the workspace's existing active projects, choose the best match for this request, and set the issue's project before finishing.",
        "If the workspace has no active projects, leave the issue without a project; do not create a new project.",
      ];
  return [
    "Create one or more new execution issues for the actual work described by this intake request.",
    "Do not treat this intake issue as the execution issue, and do not implement the requested code here.",
    "Create each execution issue with `remi issue create`; the server will link it back to this intake issue.",
    "Read the available project snapshots and exported knowledge under `projects/<project>/` before deciding.",
    ...projectInstructions,
    "",
    prompt,
  ].join("\n");
}

function normalizeIssuePosition(value: number | null | undefined): number {
  const position = Number(value ?? 0);
  if (!Number.isFinite(position)) throw new Error("position must be a finite number");
  return position;
}

function normalizeIssueKind(value: string | null | undefined): MultiremiIssueKind {
  const kind = String(value ?? "execution").trim().toLowerCase();
  if (kind === "execution" || kind === "intake") return kind;
  throw new Error(`Unsupported issue kind: ${value}`);
}

function normalizeIssueDate(value: string | null | undefined, field: string): string | null {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("value must be an array");
  return value;
}

function normalizeLabelName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name) throw new Error("Label name is required");
  if (name.length > 32) throw new Error("Label name cannot exceed 32 characters");
  return name;
}

function normalizeLabelColor(value: string | undefined): string {
  const color = value?.trim() ?? "";
  if (!/^#?[0-9a-fA-F]{6}$/.test(color)) throw new Error("Label color must be a 6-digit hex color");
  return (color.startsWith("#") ? color : `#${color}`).toLowerCase();
}

function toIssue(row: Row): MultiremiIssue {
  const number = Number(row.issue_number ?? 0);
  return {
    id: String(row.id),
    key: String(row.issue_key || (number > 0 ? formatIssueKey(number) : row.id)),
    number,
    title: String(row.title),
    description: nullableString(row.description),
    status: normalizeIssueStatus(row.status),
    priority: normalizeIssuePriority(String(row.priority ?? "none")),
    workspaceId: String(row.workspace_id ?? "local"),
    projectId: nullableString(row.project_id),
    parentIssueId: nullableString(row.parent_issue_id),
    issueKind: normalizeIssueKind(nullableString(row.issue_kind)),
    sourceIssueId: nullableString(row.source_issue_id),
    assigneeType: nullableString(row.assignee_type) as MultiremiIssue["assigneeType"],
    assigneeId: nullableString(row.assignee_id),
    position: Number(row.position ?? 0),
    startDate: nullableString(row.start_date),
    dueDate: nullableString(row.due_date),
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    contextRefs: parseJson(row.context_refs, []),
    metadata: parseIssueMetadata(row.metadata),
    labels: [],
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChildIssueProgress(row: Row): MultiremiIssueChildProgress {
  return {
    parentIssueId: String(row.parent_issue_id),
    total: Number(row.total ?? 0),
    done: Number(row.done ?? 0),
  };
}

function toIssueDependency(row: Row): MultiremiIssueDependency {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: String(row.issue_id),
    dependsOnIssueId: String(row.depends_on_issue_id),
    type: normalizeIssueDependencyType(String(row.type ?? "related")),
    issue: null,
    dependsOnIssue: null,
    createdAt: String(row.created_at),
  };
}

function parseIssueMetadata(value: unknown): Record<string, string | number | boolean> {
  const raw = parseJson<Record<string, unknown>>(value, {});
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (ISSUE_METADATA_KEY_RE.test(key) && isIssueMetadataPrimitive(item)) {
      metadata[key] = item;
    }
  }
  return metadata;
}

function toIssueActivity(row: Row): MultiremiIssueActivity {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    actorType: String(row.actor_type ?? "system"),
    actorId: nullableString(row.actor_id),
    type: String(row.type),
    body: nullableString(row.body),
    data: row.data == null ? null : parseJson(row.data, null),
    createdAt: String(row.created_at),
  };
}

function commentToTimelineEntry(comment: MultiremiIssueComment): MultiremiTimelineEntry {
  return {
    type: "comment",
    id: comment.id,
    issueSessionId: comment.issueSessionId,
    issue_session_id: comment.issueSessionId,
    actorType: comment.authorType,
    actor_type: comment.authorType,
    actorId: comment.authorId,
    actor_id: comment.authorId,
    taskId: comment.taskId,
    task_id: comment.taskId,
    createdAt: comment.createdAt,
    created_at: comment.createdAt,
    content: comment.body,
    parentId: comment.parentId,
    parent_id: comment.parentId,
    updatedAt: comment.updatedAt,
    updated_at: comment.updatedAt,
    commentType: "comment",
    comment_type: "comment",
    reactions: comment.reactions,
    attachments: comment.attachments,
    resolvedAt: comment.resolvedAt,
    resolved_at: comment.resolvedAt,
    resolvedByType: comment.resolvedByType,
    resolved_by_type: comment.resolvedByType,
    resolvedById: comment.resolvedById,
    resolved_by_id: comment.resolvedById,
  };
}

function activityToTimelineEntry(activity: MultiremiIssueActivity): MultiremiTimelineEntry {
  return {
    type: "activity",
    id: activity.id,
    actorType: activity.actorType,
    actor_type: activity.actorType,
    actorId: activity.actorId,
    actor_id: activity.actorId,
    createdAt: activity.createdAt,
    created_at: activity.createdAt,
    action: activity.type,
    details: activity.data ?? (activity.body == null ? null : { body: activity.body }),
  };
}

function toIssueSubscriber(row: Row): MultiremiIssueSubscriber {
  const issueId = String(row.issue_id);
  const userType = normalizeIssueSubscriberUserType(String(row.user_type ?? "member"));
  const userId = String(row.user_id ?? row.member_id);
  const memberId = String(row.member_id ?? userId);
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    issueId,
    issue_id: issueId,
    memberId,
    member_id: memberId,
    userType,
    user_type: userType,
    userId,
    user_id: userId,
    reason: String(row.reason ?? "manual") as MultiremiSubscriptionReason,
    createdAt,
    created_at: createdAt,
  };
}

function normalizeIssueSubscriberUserType(value: string): "member" | "agent" | string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "agent") return "agent";
  if (normalized === "member" || normalized === "") return "member";
  return normalized;
}

function toIssueReaction(row: Row): MultiremiIssueReaction {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toCommentReaction(row: Row): MultiremiCommentReaction {
  return {
    id: String(row.id),
    commentId: String(row.comment_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toAttachment(row: Row): MultiremiAttachment {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    commentId: nullableString(row.comment_id),
    chatSessionId: nullableString(row.chat_session_id),
    chatMessageId: nullableString(row.chat_message_id),
    uploaderType: String(row.uploader_type ?? "member"),
    uploaderId: String(row.uploader_id ?? "local"),
    filename: String(row.filename ?? ""),
    url: String(row.url ?? ""),
    contentType: String(row.content_type ?? "application/octet-stream"),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
  };
}

function toLabel(row: Row): MultiremiLabel {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    color: String(row.color ?? "#6b7280"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
