import { createHash } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type {
  CreateKnowledgeCompilationRunInput,
  CreateKnowledgeSubmissionInput,
  MultiremiIssue,
  MultiremiKnowledgeCompilationAction,
  MultiremiKnowledgeCompilationOutput,
  MultiremiKnowledgeCompilationRunListInput,
  MultiremiKnowledgeCompilationRun,
  MultiremiKnowledgeCompilationRunSource,
  MultiremiKnowledgeCompilationStatus,
  MultiremiKnowledgeCursorPage,
  MultiremiKnowledgeScope,
  MultiremiKnowledgeSubmission,
  MultiremiKnowledgeSubmissionListInput,
  MultiremiKnowledgeSubmissionStatus,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export type KnowledgeListInput = MultiremiKnowledgeSubmissionListInput;
export type KnowledgeRunListInput = MultiremiKnowledgeCompilationRunListInput;

export interface RecordKnowledgeOutputInput {
  runId: string;
  artifactScope: MultiremiKnowledgeScope;
  docId?: string | null;
  revisionId?: string | null;
  version?: number | null;
  action: MultiremiKnowledgeCompilationAction;
  contentSha256?: string | null;
}

export interface RepositoryMergeKnowledgeEventInput {
  workspaceId: string;
  repositoryId: string;
  changeRequestId: string;
  beforeSha: string;
  afterSha: string;
  changedFiles: string[];
  canonicalEventId: string;
}

export class KnowledgeRepo {
  constructor(private readonly ctx: StoreContext) {}

  createSubmission(input: CreateKnowledgeSubmissionInput): {
    submission: MultiremiKnowledgeSubmission;
    deduplicated: boolean;
  } {
    const scope = normalizeScope(input.scope);
    const sourceType = normalizeSourceType(input.sourceType);
    const projectId = cleanOptionalString(input.projectId);
    const repositoryId = cleanOptionalString(input.repositoryId);
    assertKnowledgeTarget(scope, projectId, repositoryId);
    const proposedPath = cleanOptionalString(input.proposedPath);
    const proposedSlug = cleanOptionalString(input.proposedSlug);
    const body = String(input.body ?? "");
    const patch = cleanOptionalString(input.patch);
    const baseRevision = cleanOptionalString(input.baseRevision);
    const contentSha256 = knowledgeContentSha256({ body, patch, baseRevision });
    const existing = this.findDuplicateSubmission({
      workspaceId: input.workspaceId,
      projectId,
      repositoryId,
      scope,
      sourceType,
      proposedPath,
      proposedSlug,
      contentSha256,
      allStatuses: Boolean(input.dedupeAllStatuses),
    });
    if (existing) return { submission: existing, deduplicated: true };

    const id = createId("ksub");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_knowledge_submissions (
        id, workspace_id, project_id, repository_id, scope, source_type, proposed_path,
        proposed_slug, body, patch, base_revision, source_task_id, source_issue_id,
        source_revision, author_agent_id, content_sha256, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id, input.workspaceId, projectId, repositoryId, scope, sourceType, proposedPath,
        proposedSlug, body, patch, baseRevision, cleanOptionalString(input.sourceTaskId),
        cleanOptionalString(input.sourceIssueId), cleanOptionalString(input.sourceRevision),
        cleanOptionalString(input.authorAgentId), contentSha256, now, now,
      ],
    );
    return { submission: this.getSubmission(id)!, deduplicated: false };
  }

  getSubmission(id: string): MultiremiKnowledgeSubmission | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_knowledge_submissions WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toSubmission(row) : null;
  }

  listSubmissions(input: KnowledgeListInput): MultiremiKnowledgeSubmission[] {
    return this.listSubmissionsPage(input).items;
  }

  listSubmissionsPage(input: KnowledgeListInput): MultiremiKnowledgeCursorPage<MultiremiKnowledgeSubmission> {
    return this.listPage("multiremi_knowledge_submissions", "submission", input, toSubmission);
  }

  updateSubmissionStatus(id: string, status: MultiremiKnowledgeSubmissionStatus): MultiremiKnowledgeSubmission {
    const normalized = normalizeSubmissionStatus(status);
    const result = this.ctx.db.run(
      "UPDATE multiremi_knowledge_submissions SET status = ?, updated_at = ? WHERE id = ?",
      [normalized, nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Knowledge submission not found: ${id}`);
    return this.getSubmission(id)!;
  }

  createRun(input: CreateKnowledgeCompilationRunInput): {
    run: MultiremiKnowledgeCompilationRun;
    deduplicated: boolean;
  } {
    const dedupeKey = cleanOptionalString(input.dedupeKey);
    if (dedupeKey) {
      const existing = this.getRunByDedupe(input.workspaceId, dedupeKey);
      if (existing) return { run: existing, deduplicated: true };
    }
    const id = createId("krun");
    const now = nowIso();
    try {
      this.ctx.db.run(
        `INSERT INTO multiremi_knowledge_compilation_runs (
          id, workspace_id, project_id, repository_id, task_id, agent_id, autopilot_run_id,
          mode, status, result_summary, dedupe_key, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, input.workspaceId, cleanOptionalString(input.projectId), cleanOptionalString(input.repositoryId),
          cleanOptionalString(input.taskId), cleanOptionalString(input.agentId),
          cleanOptionalString(input.autopilotRunId), normalizeCompilationMode(input.mode),
          normalizeCompilationStatus(input.status ?? "preparing"), cleanOptionalString(input.resultSummary),
          dedupeKey, now, null,
        ],
      );
    } catch (error) {
      const existing = dedupeKey ? this.getRunByDedupe(input.workspaceId, dedupeKey) : null;
      if (existing) return { run: existing, deduplicated: true };
      throw error;
    }
    return { run: this.getRun(id)!, deduplicated: false };
  }

  getRun(id: string): MultiremiKnowledgeCompilationRun | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_knowledge_compilation_runs WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toRun(row) : null;
  }

  listRuns(input: KnowledgeRunListInput): MultiremiKnowledgeCompilationRun[] {
    return this.listRunsPage(input).items;
  }

  listRunsPage(input: KnowledgeRunListInput): MultiremiKnowledgeCursorPage<MultiremiKnowledgeCompilationRun> {
    return this.listPage("multiremi_knowledge_compilation_runs", "compilation run", input, toRun);
  }

  completeRun(
    id: string,
    status: MultiremiKnowledgeCompilationStatus,
    resultSummary?: string | null,
  ): MultiremiKnowledgeCompilationRun {
    const normalized = normalizeCompilationStatus(status);
    const completedAt = normalized === "preparing" || normalized === "validating" ? null : nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_knowledge_compilation_runs
       SET status = ?, result_summary = ?, completed_at = ? WHERE id = ?`,
      [normalized, cleanOptionalString(resultSummary), completedAt, id],
    );
    if (result.changes !== 1) throw new Error(`Knowledge compilation run not found: ${id}`);
    return this.getRun(id)!;
  }

  addRunSubmissionSource(runId: string, submissionId: string): MultiremiKnowledgeCompilationRunSource {
    const existing = this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_compilation_run_sources
       WHERE run_id = ? AND submission_id = ?`,
    ).get(runId, submissionId) as Row | null;
    if (existing) return toRunSource(existing);
    if (!this.getRun(runId)) throw new Error(`Knowledge compilation run not found: ${runId}`);
    if (!this.getSubmission(submissionId)) throw new Error(`Knowledge submission not found: ${submissionId}`);
    const id = createId("ksrc");
    this.ctx.db.run(
      `INSERT INTO multiremi_knowledge_compilation_run_sources (
        id, run_id, submission_id, source_type, source_ref, metadata, created_at
      ) VALUES (?, ?, ?, 'submission', NULL, '{}', ?)`,
      [id, runId, submissionId, nowIso()],
    );
    return this.listRunSources(runId).find((source) => source.id === id)!;
  }

  addRunScmSource(
    runId: string,
    sourceRef: string,
    metadata: Record<string, unknown>,
  ): MultiremiKnowledgeCompilationRunSource {
    const existing = this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_compilation_run_sources
       WHERE run_id = ? AND source_type = 'scm_event' AND source_ref = ?`,
    ).get(runId, sourceRef) as Row | null;
    if (existing) return toRunSource(existing);
    const id = createId("ksrc");
    this.ctx.db.run(
      `INSERT INTO multiremi_knowledge_compilation_run_sources (
        id, run_id, submission_id, source_type, source_ref, metadata, created_at
      ) VALUES (?, ?, NULL, 'scm_event', ?, ?, ?)`,
      [id, runId, sourceRef, toJson(metadata), nowIso()],
    );
    return this.listRunSources(runId).find((source) => source.id === id)!;
  }

  listRunSources(runId: string): MultiremiKnowledgeCompilationRunSource[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_compilation_run_sources
       WHERE run_id = ? ORDER BY created_at, id`,
    ).all(runId) as Row[]).map(toRunSource);
  }

  recordOutput(input: RecordKnowledgeOutputInput): MultiremiKnowledgeCompilationOutput {
    if (!this.getRun(input.runId)) throw new Error(`Knowledge compilation run not found: ${input.runId}`);
    const id = createId("kout");
    this.ctx.db.run(
      `INSERT INTO multiremi_knowledge_compilation_outputs (
        id, run_id, artifact_scope, doc_id, revision_id, version, action, content_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.runId, normalizeScope(input.artifactScope), cleanOptionalString(input.docId),
        cleanOptionalString(input.revisionId), input.version == null ? null : Number(input.version),
        normalizeCompilationAction(input.action), cleanOptionalString(input.contentSha256), nowIso(),
      ],
    );
    return this.listRunOutputs(input.runId).find((output) => output.id === id)!;
  }

  linkFormalVersion(input: Omit<RecordKnowledgeOutputInput, "revisionId">): MultiremiKnowledgeCompilationOutput {
    const docId = cleanOptionalString(input.docId);
    const version = input.version == null ? null : Number(input.version);
    let revisionId: string | null = null;
    if (docId && version != null) {
      if (input.artifactScope === "repository_wiki") {
        this.ctx.db.run(
          "UPDATE multiremi_repository_wiki_docs SET compilation_run_id = ? WHERE id = ?",
          [input.runId, docId],
        );
        this.ctx.db.run(
          `UPDATE multiremi_repository_wiki_doc_revisions SET compilation_run_id = ?
           WHERE doc_id = ? AND version = ?`,
          [input.runId, docId, version],
        );
        revisionId = cleanOptionalString((this.ctx.db.query(
          "SELECT id FROM multiremi_repository_wiki_doc_revisions WHERE doc_id = ? AND version = ?",
        ).get(docId, version) as Row | null)?.id);
      } else {
        this.ctx.db.run(
          "UPDATE multiremi_project_docs SET compilation_run_id = ? WHERE id = ?",
          [input.runId, docId],
        );
        this.ctx.db.run(
          `UPDATE multiremi_project_doc_revisions SET compilation_run_id = ?
           WHERE doc_id = ? AND version = ?`,
          [input.runId, docId, version],
        );
        revisionId = cleanOptionalString((this.ctx.db.query(
          "SELECT id FROM multiremi_project_doc_revisions WHERE doc_id = ? AND version = ?",
        ).get(docId, version) as Row | null)?.id);
      }
    }
    return this.recordOutput({ ...input, docId, version, revisionId });
  }

  listRunOutputs(runId: string): MultiremiKnowledgeCompilationOutput[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_compilation_outputs
       WHERE run_id = ? ORDER BY created_at, id`,
    ).all(runId) as Row[]).map(toOutput);
  }

  createIssueCompletionBundle(issue: MultiremiIssue): {
    submission: MultiremiKnowledgeSubmission;
    deduplicated: boolean;
  } | null {
    if (issue.status !== "done") return null;
    const existing = this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_submissions
       WHERE workspace_id = ? AND source_type = 'issue_completion' AND source_issue_id = ?
       ORDER BY created_at LIMIT 1`,
    ).get(issue.workspaceId, issue.id) as Row | null;
    if (existing) return { submission: toSubmission(existing), deduplicated: true };
    const rawIds = (this.ctx.db.query(
      `SELECT id FROM multiremi_knowledge_submissions
       WHERE workspace_id = ? AND source_issue_id = ? AND source_type <> 'issue_completion'
       ORDER BY created_at, id`,
    ).all(issue.workspaceId, issue.id) as Row[]).map((row) => String(row.id));
    const tasks = (this.ctx.db.query(
      `SELECT id, status, result FROM multiremi_tasks
       WHERE issue_id = ? ORDER BY created_at, id`,
    ).all(issue.id) as Row[]).map((row) => ({
      id: String(row.id),
      status: String(row.status),
      result: parseTaskResult(row.result),
    }));
    const sessionIds = (this.ctx.db.query(
      "SELECT id FROM multiremi_issue_sessions WHERE issue_id = ? ORDER BY created_at, id",
    ).all(issue.id) as Row[]).map((row) => String(row.id));
    const body = JSON.stringify({
      type: "issue_completion_bundle",
      issue: { id: issue.id, key: issue.key, title: issue.title, project_id: issue.projectId },
      submission_ids: rawIds,
      tasks,
      session_ids: sessionIds,
    }, null, 2);
    return this.createSubmission({
      workspaceId: issue.workspaceId,
      projectId: issue.projectId,
      scope: issue.projectId ? "project_wiki" : "memory",
      sourceType: "issue_completion",
      proposedPath: `issue-completions/${issue.key}.md`,
      proposedSlug: `issue-${issue.key.toLowerCase()}`,
      body,
      sourceIssueId: issue.id,
    });
  }

  recordRepositoryMergeEvent(input: RepositoryMergeKnowledgeEventInput): {
    submission: MultiremiKnowledgeSubmission;
    run: MultiremiKnowledgeCompilationRun;
    deduplicated: boolean;
  } {
    const dedupeKey = `${input.repositoryId}:${input.afterSha}`;
    const body = JSON.stringify({
      type: "repository_merged",
      repository_id: input.repositoryId,
      change_request_id: input.changeRequestId,
      before_sha: input.beforeSha,
      after_sha: input.afterSha,
      changed_files: [...new Set(input.changedFiles)].sort(),
      canonical_scm_event_id: input.canonicalEventId,
    }, null, 2);
    const submissionResult = this.createSubmission({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      scope: "repository_wiki",
      sourceType: "external",
      proposedPath: `scm-events/${input.afterSha}.json`,
      body,
      sourceRevision: input.afterSha,
      dedupeAllStatuses: true,
    });
    const runResult = this.createRun({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      mode: "repository_update",
      dedupeKey,
    });
    this.addRunSubmissionSource(runResult.run.id, submissionResult.submission.id);
    this.addRunScmSource(runResult.run.id, input.canonicalEventId, JSON.parse(body) as Record<string, unknown>);
    return {
      submission: submissionResult.submission,
      run: runResult.run,
      deduplicated: submissionResult.deduplicated || runResult.deduplicated,
    };
  }

  private getRunByDedupe(workspaceId: string, dedupeKey: string): MultiremiKnowledgeCompilationRun | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_compilation_runs
       WHERE workspace_id = ? AND dedupe_key = ?`,
    ).get(workspaceId, dedupeKey) as Row | null;
    return row ? toRun(row) : null;
  }

  private listPage<T>(
    table: "multiremi_knowledge_submissions" | "multiremi_knowledge_compilation_runs",
    kind: "submission" | "compilation run",
    input: KnowledgeListInput | KnowledgeRunListInput,
    convert: (row: Row) => T,
  ): MultiremiKnowledgeCursorPage<T> {
    const { sql, params } = knowledgeScopeWhere(input);
    const limit = normalizeLimit(input.limit, 100);
    const cursor = cleanOptionalString(input.cursor);
    let pageSql = sql;
    const pageParams = [...params];
    if (cursor) {
      const cursorRow = this.ctx.db.query(
        `SELECT id, created_at FROM ${table} WHERE ${sql} AND id = ?`,
      ).get(...params, cursor) as Row | null;
      if (!cursorRow) {
        throw new Error(`Knowledge ${kind} cursor is invalid or does not match the requested scope`);
      }
      pageSql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      pageParams.push(String(cursorRow.created_at), String(cursorRow.created_at), String(cursorRow.id));
    }
    const rows = this.ctx.db.query(
      `SELECT * FROM ${table} WHERE ${pageSql}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...pageParams, limit + 1) as Row[];
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map(convert),
      nextCursor: rows.length > limit ? String(pageRows.at(-1)!.id) : null,
    };
  }

  private findDuplicateSubmission(input: {
    workspaceId: string;
    projectId: string | null;
    repositoryId: string | null;
    scope: MultiremiKnowledgeScope;
    sourceType: string;
    proposedPath: string | null;
    proposedSlug: string | null;
    contentSha256: string;
    allStatuses: boolean;
  }): MultiremiKnowledgeSubmission | null {
    const conditions = ["workspace_id = ?", "scope = ?", "content_sha256 = ?"];
    const params: unknown[] = [input.workspaceId, input.scope, input.contentSha256];
    nullableEquality(conditions, params, "project_id", input.projectId);
    nullableEquality(conditions, params, "repository_id", input.repositoryId);
    if (input.allStatuses) {
      nullableEquality(conditions, params, "proposed_path", input.proposedPath);
      nullableEquality(conditions, params, "proposed_slug", input.proposedSlug);
      conditions.push("source_type = ?");
      params.push(input.sourceType);
    } else {
      conditions.push("status = 'pending'");
    }
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_knowledge_submissions
       WHERE ${conditions.join(" AND ")} ORDER BY created_at LIMIT 1`,
    ).get(...params) as Row | null;
    return row ? toSubmission(row) : null;
  }
}

export function knowledgeContentSha256(value: {
  body: string;
  patch?: string | null;
  baseRevision?: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    body: value.body,
    patch: value.patch ?? null,
    base_revision: value.baseRevision ?? null,
  })).digest("hex");
}

function knowledgeScopeWhere(input: KnowledgeListInput | KnowledgeRunListInput): {
  sql: string;
  params: unknown[];
} {
  const conditions = ["workspace_id = ?"];
  const params: unknown[] = [input.workspaceId];
  if (cleanOptionalString(input.projectId)) {
    conditions.push("project_id = ?");
    params.push(cleanOptionalString(input.projectId));
  }
  if (cleanOptionalString(input.repositoryId)) {
    conditions.push("repository_id = ?");
    params.push(cleanOptionalString(input.repositoryId));
  }
  if ("scope" in input && cleanOptionalString(input.scope)) {
    conditions.push("scope = ?");
    params.push(normalizeScope(input.scope));
  }
  if (cleanOptionalString(input.status)) {
    conditions.push("status = ?");
    params.push(cleanOptionalString(input.status));
  }
  return { sql: conditions.join(" AND "), params };
}

function nullableEquality(conditions: string[], params: unknown[], column: string, value: string | null): void {
  if (value === null) conditions.push(`${column} IS NULL`);
  else {
    conditions.push(`${column} = ?`);
    params.push(value);
  }
}

function assertKnowledgeTarget(
  scope: MultiremiKnowledgeScope,
  projectId: string | null,
  repositoryId: string | null,
): void {
  if ((scope === "project_wiki" || scope === "memory") && !projectId) {
    if (scope === "project_wiki") throw new Error("project_id is required for project_wiki submissions");
  }
  if (scope === "repository_wiki" && !repositoryId) {
    throw new Error("repository_id is required for repository_wiki submissions");
  }
}

function normalizeScope(value: unknown): MultiremiKnowledgeScope {
  const scope = String(value ?? "");
  if (scope === "project_wiki" || scope === "repository_wiki" || scope === "memory") return scope;
  throw new Error(`unknown knowledge scope: ${scope}`);
}

function normalizeSourceType(value: unknown): MultiremiKnowledgeSubmission["sourceType"] {
  const source = String(value ?? "");
  if (source === "agent" || source === "issue_completion" || source === "external"
    || source === "legacy_wiki" || source === "legacy_memory") return source;
  throw new Error(`unknown knowledge source type: ${source}`);
}

function normalizeSubmissionStatus(value: unknown): MultiremiKnowledgeSubmissionStatus {
  const status = String(value ?? "");
  if (status === "pending" || status === "processing" || status === "consumed"
    || status === "partial" || status === "rejected" || status === "archived") return status;
  throw new Error(`unknown knowledge submission status: ${status}`);
}

function normalizeCompilationMode(value: unknown): MultiremiKnowledgeCompilationRun["mode"] {
  const mode = String(value ?? "");
  if (mode === "issue_ingest" || mode === "repository_update" || mode === "memory_curate"
    || mode === "lint" || mode === "legacy_migration" || mode === "manual_edit") return mode;
  throw new Error(`unknown knowledge compilation mode: ${mode}`);
}

function normalizeCompilationStatus(value: unknown): MultiremiKnowledgeCompilationStatus {
  const status = String(value ?? "");
  if (status === "preparing" || status === "validating" || status === "published"
    || status === "published_with_warnings" || status === "failed" || status === "noop") return status;
  throw new Error(`unknown knowledge compilation status: ${status}`);
}

function normalizeCompilationAction(value: unknown): MultiremiKnowledgeCompilationAction {
  const action = String(value ?? "");
  if (action === "create" || action === "update" || action === "merge" || action === "split"
    || action === "reject" || action === "noop") return action;
  throw new Error(`unknown knowledge compilation action: ${action}`);
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, Math.floor(parsed))) : fallback;
}

function toSubmission(row: Row): MultiremiKnowledgeSubmission {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: cleanOptionalString(row.project_id),
    repositoryId: cleanOptionalString(row.repository_id),
    scope: normalizeScope(row.scope),
    sourceType: normalizeSourceType(row.source_type),
    proposedPath: cleanOptionalString(row.proposed_path),
    proposedSlug: cleanOptionalString(row.proposed_slug),
    body: String(row.body ?? ""),
    patch: cleanOptionalString(row.patch),
    baseRevision: cleanOptionalString(row.base_revision),
    sourceTaskId: cleanOptionalString(row.source_task_id),
    sourceIssueId: cleanOptionalString(row.source_issue_id),
    sourceRevision: cleanOptionalString(row.source_revision),
    authorAgentId: cleanOptionalString(row.author_agent_id),
    contentSha256: String(row.content_sha256),
    status: normalizeSubmissionStatus(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRun(row: Row): MultiremiKnowledgeCompilationRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: cleanOptionalString(row.project_id),
    repositoryId: cleanOptionalString(row.repository_id),
    taskId: cleanOptionalString(row.task_id),
    agentId: cleanOptionalString(row.agent_id),
    autopilotRunId: cleanOptionalString(row.autopilot_run_id),
    mode: normalizeCompilationMode(row.mode),
    status: normalizeCompilationStatus(row.status),
    resultSummary: cleanOptionalString(row.result_summary),
    dedupeKey: cleanOptionalString(row.dedupe_key),
    createdAt: String(row.created_at),
    completedAt: cleanOptionalString(row.completed_at),
  };
}

function toRunSource(row: Row): MultiremiKnowledgeCompilationRunSource {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    submissionId: cleanOptionalString(row.submission_id),
    sourceType: row.source_type === "scm_event" ? "scm_event" : "submission",
    sourceRef: cleanOptionalString(row.source_ref),
    metadata: parseJson(String(row.metadata ?? "{}"), {}),
    createdAt: String(row.created_at),
  };
}

function toOutput(row: Row): MultiremiKnowledgeCompilationOutput {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    artifactScope: normalizeScope(row.artifact_scope),
    docId: cleanOptionalString(row.doc_id),
    revisionId: cleanOptionalString(row.revision_id),
    version: row.version == null ? null : Number(row.version),
    action: normalizeCompilationAction(row.action),
    contentSha256: cleanOptionalString(row.content_sha256),
    createdAt: String(row.created_at),
  };
}

function parseTaskResult(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  return parseJson(value, value);
}
