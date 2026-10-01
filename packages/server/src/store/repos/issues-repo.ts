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
  resolveCamelOrSnakeString,
  searchMatch,
  searchRank,
  toJson,
} from "@multiremi/store/helpers.js";
import {
  type CommitEventQueue,
  type CreatedIssueComment,
  type StoreContext,
  type WorkspaceEvent,
  createCommitEventQueue,
  toInboxItem,
  toIssueComment,
} from "@multiremi/store/context.js";
import type { ChildStatusChange, ChildStatusChangeCollector } from "./tasks-repo.js";
import type { Envelope } from "@multiremi/contracts/inbox.js";
import { RuntimeWorkspaceError, RuntimeWorkspacesRepo } from "./runtime-workspaces-repo.js";
import { assertQuestionCardToken, hashQuestionCardToken, QuestionCardTokenError, type QuestionCardCredential } from "@multiremi/store/question-card-token.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { lockIssueRowWithinTransaction, lockIssueRowsWithinTransaction } from "../issue-row-lock.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { numberAllocationLockKey } from "@multiremi/store/advisory-locks.js";
import { advisoryXactLock, afterCommit } from "@multiremi/store/db/postgres.js";
import { createLogger } from "@shared/logger.js";
import { resolveIssueArchiveSettings } from "@multiremi/store/issue-archive.js";
import { INBOX_LEDGER_TYPES, isInboxLedgerType } from "@multiremi/contracts";
import { attachmentIdsFromText } from "@multiremi/contracts/attachments.js";
import type {
  AssignIssueInput,
  AssignIssueOptions,
  AssignIssueResult,
  AnswerIssueDecisionInput,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateAttachmentInput,
  CreateTaskInput,
  CreateIssueCommentInput,
  CreateIssueDependencyInput,
  CreateIssueInput,
  CreateIssueDecisionInput,
  IssueDecisionActor,
  CreateLabelInput,
  ListIssueCommentsInput,
  ListIssueCommentsResult,
  ListIssuesInput,
  IssueStatusPages,
  MultiremiAgent,
  MultiremiAssigneeFrequencyEntry,
  MultiremiAssigneeType,
  MultiremiAttachment,
  MultiremiCommentReaction,
  MultiremiInboxItem,
  MultiremiInboxPage,
  MultiremiInboxSummary,
  MultiremiIssue,
  MultiremiIssueDecision,
  MultiremiIssueDecisionAnswer,
  MultiremiIssueDecisionEntry,
  MultiremiIssueDecisionKind,
  MultiremiIssueDecisionList,
  MultiremiIssueAutoTitleMetadata,
  MultiremiIssueActivity,
  MultiremiIssueAssigneeGroup,
  MultiremiIssueChildProgress,
  MultiremiIssueComment,
  MultiremiIssueDependency,
  MultiremiIssueDependencyType,
  MultiremiIssueDependencyView,
  MultiremiIssuePrerequisite,
  MultiremiIssueWaitingOn,
  MultiremiIssueKind,
  MultiremiIssueParentDoneGrant,
  MultiremiIssuePriority,
  MultiremiIssueReaction,
  MultiremiIssueSearchResult,
  MultiremiIssueSubscriber,
  MultiremiIssueWithTasks,
  MultiremiIssueWorkspaceStatus,
  MultiremiLabel,
  MultiremiSubscriptionReason,
  MultiremiSystemEvent,
  MultiremiTask,
  MultiremiTaskStatus,
  MultiremiTimelineEntry,
  QuickCreateIssueInput,
  QuickCreateIssueResult,
  UpdateIssueCommentInput,
  UpdateIssueInput,
  UpdateIssueOptions,
  UpdateLabelInput,
} from "@multiremi/contracts/types.js";

/** Q-B: a human comment joins the earliest queued turn in its lane. */
export const HUMAN_COMMENT_JOINS_QUEUED_ROUND = true;

import {
  dependencyFailureCommands,
  dependencyGateEnabled,
  findDependencyCyclePath,
  isPrerequisiteSatisfied,
  IssueDependencyError,
  type IssueDependencyUnmetRef,
} from "@multiremi/store/repos/issue-dependencies.js";

const log = createLogger("multiremi-store");

type Row = Record<string, unknown>;

export interface DependencyForceStartedInput {
  source: "status" | "comment" | "mention" | "rerun";
  status: string;
  previousStatus: string;
  unmet: IssueDependencyUnmetRef[];
  actorType: string;
  actorId: string | null;
  commentId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  assigneeDispatched?: boolean;
  parentTaskId?: string | null;
}

/**
 * MUL-400 E1 kill switch. The parent-status guards ship enabled; flipping this
 * to a false-y value restores the pre-MUL-400 passthrough for an emergency
 * without redeploying an older image.
 */
function parentStatusGuardEnabled(): boolean {
  const raw = (process.env.MULTIREMI_PARENT_STATUS_GUARD ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "disabled";
}

/**
 * MUL-400 E2: which of the four child endings reached the parent. `failed` is
 * distinguished from a human `blocked` because the caller tells us which write
 * path produced it (task terminal vs. a status edit).
 */
export type ChildTerminalOutcome = "done" | "failed" | "blocked" | "cancelled";

export type SquadLeaderDelegationDecision =
  | { ok: true; delegatedFromIssueSessionId: string | null }
  | { ok: false; reason: "source_not_issue_task" | "source_side_session" | "source_not_squad_leader"
      | "target_not_squad_member" | "cross_issue_no_lineage" | "self_dispatch" | null };

const DELEGATION_TREE_MAX_DEPTH = 16;

/** `null` for statuses that are not a child ending. */
function childTerminalOutcome(status: string): ChildTerminalOutcome | null {
  switch (status) {
    case "done": return "done";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "failed": return "failed";
    default: return null;
  }
}

/**
 * MUL-400 E3: the dependency gate's refusal. A 409 for an unmet prerequisite
 * (`dependencies_unmet`) or for a rejected dependency write (the cycle and
 * ancestor codes), carrying the machine-readable list the API surfaces.
 */
export { IssueDependencyError } from "@multiremi/store/repos/issue-dependencies.js";

/**
 * MUL-400 S1c (A4): why an agent was refused `done` on a parent it does not (or
 * no longer does) hold an effective grant for. The wire response repeats it so
 * a run can tell "ask a member to authorize me" apart from "the grant lapsed".
 */
export type ParentDoneGrantRefusalReason =
  | "grant_missing"
  | "not_owner_agent"
  | "assignee_changed"
  | "owner_not_agent"
  | "force_requires_member"
  | "final_summary_missing"
  | "children_open";

/** 409/403 for a held parent transition; the route maps it to the API error code. */
export class ParentStatusGuardError extends Error {
  constructor(
    readonly code: "issue_status_held" | "final_summary_missing" | "parent_done_requires_member",
    message: string,
    readonly details: {
      openChildren?: number;
      lastChildClosedAt?: string | null;
      reason?: ParentDoneGrantRefusalReason;
    } = {},
  ) {
    super(message);
  }
}

/**
 * MUL-400 S1 batch pre-flight. A batch update is all-or-nothing for the guard:
 * if any row would be refused the whole batch is refused *before* the first
 * write, and the response names the rows that failed. Per-row guards still run
 * during the write, so a concurrent writer can still reject a row in the window
 * between the pre-flight and the write (documented in ADR 0003).
 */
export class BatchParentStatusGuardError extends ParentStatusGuardError {
  readonly rejectedIssueIds: string[];
  constructor(cause: ParentStatusGuardError, rejectedIssueIds: string[]) {
    super(cause.code, cause.message, cause.details);
    this.rejectedIssueIds = rejectedIssueIds;
  }
}

export interface IssueWorkspaceMoveRelations {
  parent: string | null;
  children: string[];
  dependencies: Array<{ id: string; key: string; type: MultiremiIssueDependencyType }>;
  /** Active tasks keep writing to the Issue from their own workspace. */
  tasks: Array<{ id: string; status: MultiremiTaskStatus }>;
  issue_workspace: { status: MultiremiIssueWorkspaceStatus; runtime_id: string | null } | null;
  hidden: number;
}

/** 409: explicitly detach relationships before moving an issue to another workspace. */
export class IssueWorkspaceMoveError extends Error {
  readonly code = "workspace_move_blocked";
  constructor(
    readonly relations: IssueWorkspaceMoveRelations,
    readonly issueIds?: string[],
  ) {
    super("Detach parent, child and dependency relationships, cancel or finish its tasks, and clean or abandon its Issue workspace before moving an issue to another workspace");
  }
}

/**
 * 409, ADR 0003 #8: after its locks the transaction needs an Issue row it did
 * not lock (the parent or terminal status changed while it waited).
 */
export class IssueLockSetStaleError extends Error {
  readonly code = "issue_relation_changed";
  constructor() {
    super("Issue parent or status changed while waiting for its lock; retry");
  }
}

/** The transaction owner rolls a stale lock set back and retries exactly once. */
function retryOnceOnStaleLockSet<T>(attempt: () => T): T {
  try {
    return attempt();
  } catch (err) {
    if (!(err instanceof IssueLockSetStaleError)) throw err;
    return attempt();
  }
}

export class ParentDoneGrantOwnerError extends Error {
  readonly code = "parent_done_grant_owner_not_agent";
}

/** Statuses a parent with unfinished children must not enter. */
function statusNeedsChildGuard(status: string): boolean {
  return status === "in_review" || status === "done";
}

/** A4: closing a parent with children is a member decision. */
function statusIsMemberOnlyParentTerminal(status: string): boolean {
  return status === "done";
}

/**
 * The status a held write was asked for. `status` is optional on the input, so a
 * caller that only wants to hold reads the normalized request; the target status
 * is the fallback when the input carried no status at all.
 */
function requestedStatusForHold(input: UpdateIssueInput, fallback: string): string {
  return hasAnyField(input, "status") ? normalizeIssueStatus(input.status) : fallback;
}

function emptyChildIssueProgress(parentIssueId: string): MultiremiIssueChildProgress {
  return { parentIssueId, total: 0, done: 0, cancelled: 0, blocked: 0, waiting: 0, active: 0 };
}

/**
 * Buckets for `GET /api/issues/child-progress` (MUL-400 E1/E3).
 *
 * `waiting` counts children parked in `backlog` with at least one unmet
 * `blocked_by` prerequisite — "the platform is holding this one for me". The
 * subquery mirrors {@link IssuesRepo.listUnmetPrerequisites} for the whole
 * workspace in one statement instead of hydrating every child.
 * MUL-476: relation reads treat parents, children and dependencies in another
 * workspace as absent. Move integrity checks deliberately use the raw rows.
 */
const CHILD_PROGRESS_SELECT = `SELECT child.parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN child.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN child.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN child.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN child.status = 'backlog' AND child.id IN (
                    SELECT CASE WHEN d.type = 'blocks' THEN d.depends_on_issue_id ELSE d.issue_id END
                    FROM multiremi_issue_dependencies d
                    JOIN multiremi_issues prereq ON prereq.id = CASE
                      WHEN d.type = 'blocks' THEN d.issue_id
                      ELSE d.depends_on_issue_id
                    END
                    JOIN multiremi_issues dependent ON dependent.id = CASE
                      WHEN d.type = 'blocks' THEN d.depends_on_issue_id ELSE d.issue_id
                    END
                    WHERE d.type IN ('blocked_by', 'blocks') AND prereq.status <> 'done'
                      AND d.workspace_id = dependent.workspace_id
                      AND prereq.workspace_id = dependent.workspace_id
                  ) THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN child.status IN ('todo', 'in_progress', 'in_review') THEN 1 ELSE 0 END) AS active
       FROM multiremi_issues child
       JOIN multiremi_issues parent
         ON parent.id = child.parent_issue_id
        AND parent.workspace_id = child.workspace_id`;

/** `result` is stored JSON; "has a result" means non-empty output text. */
function storedTaskResultHasOutput(value: unknown): boolean {
  const raw = nullableString(value);
  if (raw == null) return false;
  const parsed = parseJson<unknown>(raw, null);
  if (typeof parsed === "string") return parsed.trim().length > 0;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const output = (parsed as Record<string, unknown>).output;
    return typeof output === "string" && output.trim().length > 0;
  }
  return false;
}

export interface IssueMutationActivityContext {
  actorType?: string;
  actorId?: string | null;
  sourceTaskId?: string | null;
}

export interface IssueTimelineCursor {
  createdAt: string;
  id: string;
}

export interface IssueTimelinePageResult {
  entries: MultiremiTimelineEntry[];
  hasMore: boolean;
}

function sourceTaskActivityData(sourceTaskId: string | null | undefined): Record<string, string> {
  return sourceTaskId ? { sourceTaskId, source_task_id: sourceTaskId } : {};
}

const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
const CLOSED_ISSUE_STATUSES = new Set(["done", "completed", "closed", "cancelled", "failed"]);
const SYSTEM_AUTHOR_ID = "00000000-0000-0000-0000-000000000000";
const MAX_ISSUE_METADATA_KEYS = 50;
const ISSUE_METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const COMMENT_HARD_CAP = 2000;
const COMMENT_SUMMARY_RUNES = 200;
const DECISION_KINDS = new Set<MultiremiIssueDecisionKind>(["permission", "merge", "production_change", "question", "criteria", "other"]);
const DECISION_KIND_ORDER: Record<MultiremiIssueDecisionKind, number> = {
  permission: 0, merge: 1, production_change: 2, question: 3, criteria: 4, other: 5,
};
/** "Recently answered" window for the parent page; applied in SQL by answered_at. */
const DECISION_ANSWERED_LIMIT = 50;

export class IssueDecisionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

/**
 * MUL-412. `idempotent` marks the Feishu card path, where a replayed callback
 * or a double tap must return the settled row instead of writing a second
 * answer. The HTTP answer route leaves it off: a member re-answering from the
 * web or CLI is a deliberate revision (S4).
 */
export interface AnswerIssueDecisionOptions {
  idempotent?: boolean;
  cardCredential?: QuestionCardCredential;
}

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
/**
 * MUL-409 (QA round 4, blocker 1): what the in-transaction forced start decided.
 *
 * `skipped` is set when the owner cannot run the work (no owner, a member
 * owner, an archived assignee, a squad with no runnable agent). The status
 * change still commits — the member asked for it — and the reason is recorded
 * in the same transaction as a `dispatch_skipped` activity.
 */
interface ForcedStartOutcome {
  skipped: { reason: string; error: string } | null;
}

interface IssueCreationTransactionOwner {
  childStatusChanges: ChildStatusChangeCollector;
  deferredEvents: CommitEventQueue;
}

/**
 * The public types keep ordinary callers honest, but API adapters and tests can
 * still reach these methods through `any`. Reject a partial owner before the
 * first SQL statement so a rollback cannot leave queued in-memory events that
 * describe rows which never committed.
 */
function assertIssueCreationTransactionOwner(
  value: unknown,
): asserts value is IssueCreationTransactionOwner {
  if (!value || typeof value !== "object") {
    throw new Error("issue creation inside a transaction requires a transaction owner");
  }
  const owner = value as Partial<IssueCreationTransactionOwner>;
  if (!Array.isArray(owner.childStatusChanges)) {
    throw new Error("issue creation transaction owner requires childStatusChanges");
  }
  const queue = owner.deferredEvents as Partial<CommitEventQueue> | undefined;
  if (!queue || typeof queue !== "object") {
    throw new Error("issue creation transaction owner requires deferredEvents");
  }
  for (const field of ["workspace", "enqueuedTasks", "issueActivities"] as const) {
    if (!Array.isArray(queue[field])) {
      throw new Error(`issue creation deferredEvents requires ${field}`);
    }
  }
}

interface ReactionInput {
  actorType?: string;
  actorId?: string | null;
  emoji: string;
}

/**
 * MUL-400 S1 (QA round 4): the union makes the queue mandatory exactly when the
 * write happens inside a caller-owned transaction. A caller that only sets
 * `withinTransaction: true` no longer compiles, so no comment push can escape
 * before COMMIT and no `?? createCommitEventQueue()` fallback can swallow it.
 */
type CreateIssueCommentOptions =
  | {
    deferAgentMentionDispatch?: boolean;
    deferDispatch?: boolean;
    splitAssigneeDispatch?: boolean;
    withinTransaction?: false;
    deferredEvents?: CommitEventQueue;
  }
  | {
    deferAgentMentionDispatch?: boolean;
    deferDispatch?: boolean;
    splitAssigneeDispatch?: boolean;
    /**
     * The caller already owns a database transaction (the organizer action
     * facade). Every write inside must use the `WithinTransaction` flavour:
     * a nested `transaction()` is only a SAVEPOINT (B1, MUL-426), so a
     * standalone wrapper would publish and dispatch before the caller's COMMIT.
     */
    withinTransaction: true;
    /**
     * Where a caller-owned transaction puts the events this write would
     * otherwise publish immediately. `comment:created` is a realtime push to
     * open Issue pages, so sending it before the COMMIT shows a comment that a
     * later ROLLBACK erases. The owner flushes the queue after it commits.
     */
    deferredEvents: CommitEventQueue;
    childStatusChanges?: ChildStatusChangeCollector;
  };

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

  /**
   * MUL-400 E3 gate 3. The whole creation — the issue row, its number, its
   * dependencies and the cycle/ancestor checks — is one transaction, so a
   * rejected dependency leaves nothing behind: no orphan issue, no consumed
   * number. Dispatch is the caller's business and happens after this commits.
   *
   * The body runs through {@link createIssueWithinTransaction}; the wrapper only
   * decides whether it owns the transaction, because callers such as Feishu
   * ingestion and autopilots already hold one, and nested its `transaction()`
   * would only be a SAVEPOINT (B1, MUL-426) that publishes before their COMMIT.
   *
   * MUL-405: the body also allocates `issue_number` under the per-workspace
   * number advisory lock (W -> N -> D, see `store/advisory-locks.ts`), so a peer
   * blocks instead of reading a maximum this transaction is about to consume.
   * The `(workspace_id, issue_number)` unique index is the second line of
   * defense, not the mechanism.
   */
  createIssue(input: CreateIssueInput, transaction?: IssueCreationTransactionOwner): MultiremiIssue {
    // The whole creation is one transaction, and every realtime push it causes
    // (the `issue_created` activity, the parent re-derivation) has to wait for
    // that COMMIT — a browser must never render a row a ROLLBACK would erase.
    // A caller that already owns a transaction keeps its own queue.
    if (transaction !== undefined) assertIssueCreationTransactionOwner(transaction);
    if (this.ctx.db.inTransaction) {
      assertIssueCreationTransactionOwner(transaction);
      return this.createIssueWithinTransaction(input, transaction.childStatusChanges, transaction.deferredEvents);
    }
    const commitEvents = createCommitEventQueue();
    const childStatusChanges: ChildStatusChangeCollector = [];
    const issue = this.ctx.db.transaction(() =>
      this.createIssueWithinTransaction(input, childStatusChanges, commitEvents))();
    this.ctx.emitCommitEvents(commitEvents);
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChanges);
    return issue;
  }

  private decisionOwner(issue: MultiremiIssue): MultiremiAgent | null {
    const id = issue.assigneeType === "agent" ? issue.assigneeId
      : issue.assigneeType === "squad" && issue.assigneeId
        ? this.ctx.squads().getSquad(issue.assigneeId)?.leaderId ?? null : null;
    const agent = id ? this.ctx.agents().getAgent(id) : null;
    return agent && !agent.archivedAt && agent.workspaceId === issue.workspaceId ? agent : null;
  }

  private decisionTaskActorAllowed(actor: IssueDecisionActor, issue: MultiremiIssue, owner: MultiremiAgent | null): boolean {
    if (actor.type !== "agent" || !actor.taskId || !owner || actor.id !== owner.id) return false;
    const task = this.ctx.tasks().getTask(actor.taskId);
    return !!task && task.agentId === actor.id && task.issueId === issue.id && task.workspaceId === issue.workspaceId;
  }

  getIssueDecision(issueId: string, decisionId: string): MultiremiIssueDecision | null {
    const row = this.ctx.db.query(
      `SELECT d.* FROM multiremi_issue_decisions d
       JOIN multiremi_issues target ON target.id = d.issue_id AND target.workspace_id = d.workspace_id
       JOIN multiremi_issues source ON source.id = d.source_issue_id AND source.workspace_id = d.workspace_id
       WHERE d.id = ? AND d.issue_id = ?`,
    ).get(decisionId, issueId) as Row | null;
    return row ? toIssueDecision(row) : null;
  }

  /**
   * A decision by its own id (MUL-412). The Feishu decision-card lane is keyed
   * by decision id alone — a bot host is told the decision, not the parent
   * Issue, and resolving the Issue from the row is what makes the workspace
   * check possible. Same relation rule as {@link getIssueDecision} (MUL-476):
   * a row whose source or target Issue left its workspace does not exist.
   */
  getIssueDecisionAnywhere(decisionId: string): MultiremiIssueDecision | null {
    const row = this.ctx.db.query(
      `SELECT d.* FROM multiremi_issue_decisions d
       JOIN multiremi_issues target ON target.id = d.issue_id AND target.workspace_id = d.workspace_id
       JOIN multiremi_issues source ON source.id = d.source_issue_id AND source.workspace_id = d.workspace_id
       WHERE d.id = ?`,
    ).get(decisionId) as Row | null;
    return row ? toIssueDecision(row) : null;
  }

  /**
   * Whether `workspaceId` recorded the decision row `decisionId` on `issueId`,
   * wherever that Issue lives now (MUL-476). Deliberately unscoped and
   * content-free: the daemon card transport asks it only after the Issue guard
   * has refused `issueId` as foreign to that same workspace, and that pair is
   * exactly a decision whose target left the workspace that recorded it — a
   * decision that does not exist, so the callback gets 404 instead of 403.
   */
  isIssueDecisionRecordedInWorkspace(workspaceId: string, issueId: string, decisionId: string): boolean {
    return this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_issue_decisions
       WHERE id = ? AND issue_id = ? AND workspace_id = ?`,
    ).get(decisionId, issueId, workspaceId) != null;
  }

  countPendingIssueDecisions(issueId: string): number {
    const row = this.ctx.db.query(
      `SELECT
        (SELECT COUNT(*) FROM multiremi_issue_decisions d
          JOIN multiremi_issues target ON target.id = d.issue_id AND target.workspace_id = d.workspace_id
          JOIN multiremi_issues source ON source.id = d.source_issue_id AND source.workspace_id = d.workspace_id
          WHERE d.issue_id = ? AND d.status = 'escalated') +
        (SELECT COUNT(*) FROM multiremi_task_human_requests h
          JOIN multiremi_tasks t ON t.id = h.task_id
          JOIN multiremi_issues i ON i.id = t.issue_id
          WHERE h.status = 'pending' AND (i.id = ? OR i.parent_issue_id = ?)
            AND i.workspace_id = (SELECT workspace_id FROM multiremi_issues WHERE id = ?)) AS total`,
    ).get(issueId, issueId, issueId, issueId) as { total: number } | null;
    return Number(row?.total ?? 0);
  }

  listIssueDecisions(issueId: string): MultiremiIssueDecisionList {
    // Each bucket is queried by status so the "recently answered" window is
    // applied in SQL. QA round 1: slicing an all-statuses list by created_at
    // dropped just-answered old rows; the window must follow answered_at.
    const open = (status: "pending" | "escalated") => (this.ctx.db.query(
      `SELECT d.* FROM multiremi_issue_decisions d
       JOIN multiremi_issues target ON target.id = d.issue_id AND target.workspace_id = d.workspace_id
       JOIN multiremi_issues source ON source.id = d.source_issue_id AND source.workspace_id = d.workspace_id
       WHERE d.issue_id = ? AND d.status = ? ORDER BY d.created_at DESC, d.id DESC`,
    ).all(issueId, status) as Row[]).map(toIssueDecision);
    const answered = (this.ctx.db.query(
      `SELECT d.* FROM multiremi_issue_decisions d
       JOIN multiremi_issues target ON target.id = d.issue_id AND target.workspace_id = d.workspace_id
       JOIN multiremi_issues source ON source.id = d.source_issue_id AND source.workspace_id = d.workspace_id
       WHERE d.issue_id = ? AND d.status = 'answered'
       ORDER BY d.answered_at DESC NULLS LAST, d.id DESC LIMIT ?`,
    ).all(issueId, DECISION_ANSWERED_LIMIT) as Row[]).map(toIssueDecision);
    const requests = this.ctx.db.query(
      `SELECT h.id, h.kind, h.payload, h.status, h.created_at, t.issue_id, t.id AS task_id
       FROM multiremi_task_human_requests h
       JOIN multiremi_tasks t ON t.id = h.task_id
       JOIN multiremi_issues i ON i.id = t.issue_id
       WHERE h.status = 'pending' AND (i.id = ? OR i.parent_issue_id = ?)
         AND i.workspace_id = (SELECT workspace_id FROM multiremi_issues WHERE id = ?)`,
    ).all(issueId, issueId, issueId) as Row[];
    const waiting_on_human: MultiremiIssueDecisionEntry[] = open("escalated")
      .map((decision) => decisionEntry(decision, "waiting_on_human"));
    for (const row of requests) {
      const payload = parseJson<Record<string, unknown>>(nullableString(row.payload), {});
      const kind = String(row.kind) === "permission" ? "permission" : "question";
      const title = String(payload.title ?? payload.message ?? (kind === "permission" ? "Permission request" : "Question"));
      waiting_on_human.push({
        id: String(row.id), bucket: "waiting_on_human", type: "human_request", kind,
        title, body: typeof payload.message === "string" ? payload.message : null,
        status: String(row.status), issueId, sourceIssueId: String(row.issue_id),
        sourceTaskId: String(row.task_id), options: null, payload, answer: null,
        createdAt: String(row.created_at), updatedAt: String(row.created_at),
      });
    }
    const pending_owner = open("pending")
      .map((decision) => decisionEntry(decision, "pending_owner"));
    const answered_entries = answered.map((decision) => decisionEntry(decision, "answered"));
    for (const group of [waiting_on_human, pending_owner, answered_entries]) group.sort(compareDecisionEntries);
    return { waiting_on_human, owner_and_answered: { pending: pending_owner, answered: answered_entries }, count: waiting_on_human.length };
  }

  createIssueDecision(sourceIssueId: string, input: CreateIssueDecisionInput, actor: IssueDecisionActor): MultiremiIssueDecision {
    const source = this.getIssue(sourceIssueId);
    if (!source) throw new IssueDecisionError(404, "source issue not found");
    if (actor.type === "agent") {
      const task = actor.taskId ? this.ctx.tasks().getTask(actor.taskId) : null;
      if (!task || task.issueId !== source.id || task.agentId !== actor.id || task.workspaceId !== source.workspaceId) {
        throw new IssueDecisionError(403, "task does not belong to the source issue");
      }
    }
    const kind = String(input.kind ?? "") as MultiremiIssueDecisionKind;
    const title = String(input.title ?? "").trim();
    if (!DECISION_KINDS.has(kind) || !title || title.length > 500) throw new IssueDecisionError(400, "valid kind and title are required");
    if (input.options != null && (!Array.isArray(input.options) || input.options.some((option) => typeof option !== "string"))) {
      throw new IssueDecisionError(400, "options must be a list of strings");
    }
    const events = createCommitEventQueue();
    const changes: ChildStatusChangeCollector = [];
    const created = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(source.workspaceId);
      const currentSource = this.getIssue(source.id)!;
      const parent = this.sameWorkspaceParent(currentSource);
      const target = parent ?? currentSource;
      const owner = parent ? this.decisionOwner(parent) : null;
      const status = !parent || !owner || kind === "production_change" ? "escalated" : "pending";
      const id = createId("dcs");
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_issue_decisions
         (id, workspace_id, issue_id, source_issue_id, source_task_id, kind, title, body, options,
          status, owner_agent_id, created_by_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, source.workspaceId, target.id, currentSource.id, actor.type === "agent" ? actor.taskId : null,
          kind, title, String(input.body ?? ""), input.options == null ? null : toJson(input.options),
          status, owner?.id ?? null, actor.type === "agent" ? actor.id : null, now, now],
      );
      const decision = this.getIssueDecision(target.id, id)!;
      this.decisionEvent(events, "decision:created", decision);
      if (status === "pending") this.ctx.inbox().sendEnvelopeWithinTransaction({
        to: { role: "issue_owner", issueId: target.id }, kind: "decision_needed", wake: "now",
        dedupeKey: `decision_request:${id}`, replyTo: id,
        body: `Decision ${id} (${kind}): ${title}\nReview the request on ${target.key}. Answer with a reason and how a human can overturn it, or escalate it.`,
        source: { issueId: currentSource.id, taskId: decision.sourceTaskId ?? undefined, decisionId: id },
      }, changes, events);
      else {
        this.ctx.appendIssueActivity(target.id, {
          actorType: "system", actorId: SYSTEM_AUTHOR_ID, type: "decision_escalated",
          body: title, data: { decision_id: id, kind, direct: true },
        }, events);
        this.notifyDecisionRequested(target, decision, events);
        // A3: only the two "a person must decide this" cases get a card. A row
        // the parent's owner agent answers itself stays in the web workbench.
        this.ctx.feishuBot().prepareIssueDecisionCardWithinTransaction(target, decision, events);
      }
      return decision;
    })();
    this.ctx.tasks().runCollectedChildStatusChanges(changes);
    this.ctx.emitCommitEvents(events);
    return created;
  }

  answerIssueDecision(
    issueId: string,
    decisionId: string,
    input: AnswerIssueDecisionInput,
    actor: IssueDecisionActor,
    options: AnswerIssueDecisionOptions = {},
  ): MultiremiIssueDecision {
    const answer = String(input.answer ?? "").trim();
    const reason = String(input.reason ?? "").trim();
    const overturn = String(input.overturn ?? "").trim();
    if (!answer) throw new IssueDecisionError(400, "answer is required");
    if (actor.type === "agent" && (!reason || !overturn)) throw new IssueDecisionError(400, "agent answers require reason and overturn instructions");
    const events = createCommitEventQueue();
    const changes: ChildStatusChangeCollector = [];
    const updated = this.ctx.db.transaction(() => {
      const parent = this.getIssue(issueId);
      if (!parent) throw new IssueDecisionError(404, "decision not found");
      this.ctx.lockWorkspaceRuntimeLifecycle(parent.workspaceId);
      const decision = this.getIssueDecision(issueId, decisionId);
      if (!decision) throw new IssueDecisionError(404, "decision not found");
      const credential = options.cardCredential;
      if (credential) {
        const row = this.ctx.db.query("SELECT * FROM multiremi_issue_decisions WHERE id = ?").get(decisionId) as Row | null;
        assertQuestionCardToken(row, credential, "escalated");
        const context = this.ctx.feishuBot().getFeishuIssueDecisionCardContext(parent.workspaceId, decisionId);
        if (!context || context.recipientOpenId !== credential.operatorOpenId) {
          throw Object.assign(new IssueDecisionError(403, "please answer from the card addressed to you"), { code: "decision_operator_mismatch" });
        }
        const operator = this.ctx.feishuBot().resolveFeishuDecisionOperatorMember(parent.workspaceId, context.appId, credential.operatorOpenId);
        if (operator.status !== "resolved") {
          const code = operator.status === "ambiguous" ? "decision_member_ambiguous" : "decision_member_unmapped";
          throw Object.assign(new IssueDecisionError(403, code), { code });
        }
        actor = { type: "member", id: operator.member.id, taskId: null };
      }
      const owner = this.decisionOwner(parent);
      if (actor.type === "agent" && (!this.decisionTaskActorAllowed(actor, parent, owner)
        || decision.status !== "pending" || decision.kind === "production_change")) {
        throw new IssueDecisionError(403, "only the parent owner task can answer a pending decision");
      }
      if (decision.status === "withdrawn") throw new IssueDecisionError(409, "decision was withdrawn");
      // A card click is a single-shot interaction: Feishu redelivers callbacks,
      // a person can double-tap, and the card is still on screen after the web
      // answered it. Replaying one must not append a second history entry, a
      // second activity or a second wakeup. A deliberate re-answer from the web
      // or CLI keeps the documented member-overturns-agent behavior, so the
      // guard lives on the card path only.
      if (options.idempotent && decision.status === "answered") return decision;
      const record: MultiremiIssueDecisionAnswer = {
        answererType: actor.type, answererId: actor.id, answer, reason,
        overturn: actor.type === "agent" ? overturn : null, answeredAt: nowIso(),
      };
      const result = this.ctx.db.run(
        `UPDATE multiremi_issue_decisions
         SET status = 'answered', answer = ?, answered_by_member_id = ?, answered_at = ?, history = ?, updated_at = ?
           ${credential ? ", token_consumed_at = ?" : ""}
         WHERE id = ?
           ${credential ? "AND status = 'escalated' AND token_hash = ? AND token_recipient = ? AND token_consumed_at IS NULL" : ""}`,
        [toJson(record), actor.type === "member" ? actor.id : null,
          record.answeredAt, toJson([...decision.history, record]), record.answeredAt,
          ...(credential ? [record.answeredAt] : []), decision.id,
          ...(credential ? [hashQuestionCardToken(credential.token), credential.operatorOpenId] : [])],
      );
      if (credential && result.changes === 0) {
        assertQuestionCardToken(this.ctx.db.query("SELECT * FROM multiremi_issue_decisions WHERE id = ?")
          .get(decisionId) as Row | null, credential, "escalated");
        throw new QuestionCardTokenError("token_invalid");
      }
      const answered = this.getIssueDecision(issueId, decisionId)!;
      this.ctx.appendIssueActivity(parent.id, {
        actorType: actor.type, actorId: actor.id, type: "decision_answered",
        body: `${decision.title}: ${answer}`,
        data: { decision_id: decision.id, kind: decision.kind, answer, reason, overturn: record.overturn, answerer_type: actor.type },
      }, events);
      this.ctx.appendIssueActivity(decision.sourceIssueId, {
        actorType: actor.type, actorId: actor.id, type: "decision_received",
        body: `${decision.title}: ${answer}`,
        data: { decision_id: decision.id, parent_issue_id: parent.id, answerer_type: actor.type },
      }, events);
      const source = this.getIssue(decision.sourceIssueId)!;
      const body = `Decision ${decision.id} (${decision.kind}) was answered by ${actor.type} ${actor.id}:\n${answer}\nFor subsequent actions cite decision:${decision.id}.`;
      const sourceOwner = this.decisionOwner(source);
      if (sourceOwner) this.ctx.inbox().sendEnvelopeWithinTransaction({
        to: { role: "issue_owner", issueId: source.id }, kind: "reply", wake: "now",
        dedupeKey: `decision_answer:${decision.id}:${answered.history.length}`, replyTo: decision.id, body,
        source: { issueId: parent.id, decisionId: decision.id },
      }, changes, events);
      if (actor.type === "member" && decision.answer?.answererType === "agent" && owner) {
        this.ctx.inbox().sendEnvelopeWithinTransaction({
          to: { role: "issue_owner", issueId: parent.id }, kind: "reply", wake: "now",
          dedupeKey: `decision_overturn:${decision.id}:${answered.history.length}`, replyTo: decision.id,
          body: `A member changed your answer to decision ${decision.id} (${decision.kind}):\n${answer}\nSee the decision history on ${parent.key}.`,
          source: { issueId: source.id, decisionId: decision.id },
        }, changes, events);
      }
      this.decisionEvent(events, "decision:updated", answered);
      // In-place terminal rewrite. The delivery row is written inside this
      // transaction so a rollback leaves neither an answer nor a patch, and the
      // realtime event is queued rather than emitted mid-transaction.
      this.ctx.feishuBot().enqueueIssueDecisionCardPatchWithinTransaction(answered, events);
      return answered;
    })();
    this.ctx.tasks().runCollectedChildStatusChanges(changes);
    this.ctx.emitCommitEvents(events);
    return updated;
  }

  escalateIssueDecision(issueId: string, decisionId: string, actor: IssueDecisionActor): MultiremiIssueDecision {
    const events = createCommitEventQueue();
    const updated = this.ctx.db.transaction(() => {
      const parent = this.getIssue(issueId);
      if (!parent) throw new IssueDecisionError(404, "decision not found");
      this.ctx.lockWorkspaceRuntimeLifecycle(parent.workspaceId);
      const decision = this.getIssueDecision(issueId, decisionId);
      if (!decision) throw new IssueDecisionError(404, "decision not found");
      if (actor.type === "agent" && !this.decisionTaskActorAllowed(actor, parent, this.decisionOwner(parent))) {
        throw new IssueDecisionError(403, "only the parent owner task can escalate");
      }
      if (decision.status !== "pending") throw new IssueDecisionError(409, "only pending decisions can be escalated");
      this.ctx.db.run("UPDATE multiremi_issue_decisions SET status = 'escalated', updated_at = ? WHERE id = ?", [nowIso(), decision.id]);
      const result = this.getIssueDecision(issueId, decisionId)!;
      this.ctx.appendIssueActivity(parent.id, {
        actorType: actor.type, actorId: actor.id, type: "decision_escalated",
        body: decision.title, data: { decision_id: decision.id, kind: decision.kind },
      }, events);
      this.notifyDecisionRequested(parent, result, events);
      this.decisionEvent(events, "decision:updated", result);
      // S5b: the escalation is what turns a web-only decision into a card.
      this.ctx.feishuBot().prepareIssueDecisionCardWithinTransaction(parent, result, events);
      return result;
    })();
    this.ctx.emitCommitEvents(events);
    return updated;
  }

  withdrawIssueDecision(issueId: string, decisionId: string, actor: IssueDecisionActor): MultiremiIssueDecision {
    const events = createCommitEventQueue();
    const updated = this.ctx.db.transaction(() => {
      const issue = this.getIssue(issueId);
      if (!issue) throw new IssueDecisionError(404, "decision not found");
      this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
      const decision = this.getIssueDecision(issueId, decisionId);
      if (!decision) throw new IssueDecisionError(404, "decision not found");
      if (actor.type === "agent") {
        const task = actor.taskId ? this.ctx.tasks().getTask(actor.taskId) : null;
        if (!task || task.issueId !== decision.sourceIssueId || task.agentId !== actor.id || decision.createdByAgentId !== actor.id) {
          throw new IssueDecisionError(403, "only the requesting agent task can withdraw");
        }
      }
      if (decision.status === "withdrawn") return decision;
      if (decision.status === "answered") throw new IssueDecisionError(409, "answered decisions cannot be withdrawn");
      this.ctx.db.run("UPDATE multiremi_issue_decisions SET status = 'withdrawn', updated_at = ? WHERE id = ?", [nowIso(), decision.id]);
      const result = this.getIssueDecision(issueId, decisionId)!;
      this.decisionEvent(events, "decision:updated", result);
      // A withdrawn decision is a terminal state of its own (E4 has no expiry),
      // so the card on screen is rewritten rather than left actionable.
      this.ctx.feishuBot().enqueueIssueDecisionCardPatchWithinTransaction(result, events);
      return result;
    })();
    this.ctx.emitCommitEvents(events);
    return updated;
  }

  private decisionEvent(events: CommitEventQueue, type: "decision:created" | "decision:updated", decision: MultiremiIssueDecision): void {
    events.workspace.push({
      type, workspaceId: decision.workspaceId, actorType: "system",
      payload: { issue_id: decision.issueId, decision },
    });
  }

  private notifyDecisionRequested(parent: MultiremiIssue, decision: MultiremiIssueDecision, events: CommitEventQueue): void {
    const recipients = new Set<string>();
    // Only members that actually resolve in this workspace count as an
    // audience: an unresolvable `owner_id`, a member of another workspace or an
    // archived subscriber must not swallow the escalation.
    const add = (id: string | null | undefined) => {
      const member = id ? this.ctx.resolveWorkspaceMemberForNotification(parent.workspaceId, id) : null;
      if (member && !member.archivedAt) recipients.add(member.id);
    };
    if (parent.assigneeType === "member") add(parent.assigneeId);
    add(this.decisionOwner(parent)?.ownerId);
    for (const subscriber of this.listIssueSubscribers(parent.id)) {
      if (subscriber.userType === "member") add(subscriber.userId);
    }
    // QA round 1: an escalated decision whose explicit audience resolves to
    // nobody reached no inbox at all, so it silently left the human queue. Fall
    // back to the issue creator, then to the workspace owners (a workspace
    // always keeps at least one owner).
    if (recipients.size === 0) {
      for (const memberId of this.decisionFallbackRecipients(parent)) recipients.add(memberId);
    }
    for (const memberId of recipients) {
      const item = this.ctx.createInboxItem({
        issueId: parent.id, memberId, type: "decision_requested", severity: "action",
        title: `${parent.key}: ${decision.title}`, body: decision.body,
        actorType: "system", details: { decision_id: decision.id, kind: decision.kind },
      });
      if (item) events.workspace.push({
        type: "inbox:new", workspaceId: parent.workspaceId, actorType: "system", payload: { item },
      });
    }
  }

  /**
   * Fallback audience for an escalated decision nobody explicit owns: the
   * Issue creator when it resolves to a live member of this workspace, else
   * every workspace owner. Returns at most one group so the first hit wins.
   */
  private decisionFallbackRecipients(parent: MultiremiIssue): string[] {
    const workspaces = this.ctx.workspaces();
    const createdBy = parent.createdBy;
    if (createdBy) {
      // Same resolution as createIssue: an agent or unknown id resolves to null.
      const creator = workspaces.getWorkspaceMember(createdBy) ?? workspaces.findWorkspaceMemberForUser(createdBy, parent.workspaceId);
      if (creator && creator.workspaceId === parent.workspaceId && !creator.archivedAt) return [creator.id];
    }
    return workspaces.listWorkspaceMembers(parent.workspaceId)
      .filter((member) => member.role === "owner" && !member.archivedAt)
      .map((member) => member.id);
  }

  /**
   * Caller owns the transaction (see {@link createIssue}).
   *
   * The child-status collector and the commit-event queue are both required and
   * have no defaults: a caller that already holds a transaction must be able to
   * replay the parent re-derivation this creation triggers, and every realtime
   * push it produces has to wait for that caller's COMMIT.
   */
  createIssueWithinTransaction(
    input: CreateIssueInput,
    childStatusChanges: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): MultiremiIssue {
    assertIssueCreationTransactionOwner({ childStatusChanges, deferredEvents });
    const blockedBy = normalizeIssueRefList(input.blockedBy ?? input.blocked_by);
    const parentRef = input.parentIssueId ?? input.parent_issue_id ?? null;
    const explicitWorkspaceId = input.workspaceId ?? input.workspace_id ?? null;
    const workspaceId = explicitWorkspaceId ?? "local";
    // Global lock order (MUL-405, see store/advisory-locks.ts): W then N, before
    // any domain row lock. Callers that already took them (Feishu ingest,
    // messaging outcomes, Autopilot create_issue) re-take the same locks for
    // free inside their transaction; callers that did not (the plain API path)
    // get them here. N is taken before the MAX(issue_number) read below.
    this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
    advisoryXactLock(this.ctx.db, numberAllocationLockKey(`issue:${workspaceId}`));
    const parentIssueId = parentRef ? this.resolveIssueRelationRef(parentRef, workspaceId) ?? parentRef : null;
    const blockedByIds = blockedBy.map((ref) => this.resolveIssueRelationRef(ref, workspaceId)
      ?? this.resolveIssueRelationRef(ref, null) ?? ref);
    const sourceIssueId = cleanOptionalString(input.sourceIssueId ?? input.source_issue_id) ?? null;
    // Child membership and guarded parent decisions serialize on the parent row.
    lockIssueRowsWithinTransaction(this.ctx.db, [parentIssueId, sourceIssueId, ...blockedByIds]);
    const parent = parentIssueId ? this.getIssue(parentIssueId) : null;
    if (parentIssueId && !parent) throw new Error(`Parent issue not found: ${parentIssueId}`);
    if (parent && parent.workspaceId !== workspaceId) throw new Error("Parent issue belongs to another workspace");

    const runtimeWorkspaceId = input.runtimeWorkspaceId ?? input.runtime_workspace_id ?? null;
    // A local directory is a complete work location, including for a child issue.
    // Explicit null also opts out of the parent's project.
    const projectId = resolveOptionalStringField(input, "projectId", "project_id", runtimeWorkspaceId ? null : parent?.projectId ?? null);
    if (projectId && runtimeWorkspaceId) throw new RuntimeWorkspaceError("Choose either a project or a runtime workspace");
    if (runtimeWorkspaceId) new RuntimeWorkspacesRepo(this.ctx).require(runtimeWorkspaceId, workspaceId);
    if (projectId) {
      const project = this.ctx.projects().getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    const issueKind = normalizeIssueKind(input.issueKind ?? input.issue_kind);
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
    const status = normalizeIssueStatus(input.status);
    const completedAt = isTerminalIssueStatus(status) ? now : null;
    this.ctx.db.run(
      `INSERT INTO multiremi_issues (
        runtime_workspace_id, id, issue_number, issue_key, title, description, status, priority, workspace_id, project_id,
        parent_issue_id, issue_kind, source_issue_id, assignee_type, assignee_id, position, start_date, due_date,
        acceptance_criteria, context_refs, created_by, completed_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runtimeWorkspaceId,
        id,
        issueNumber,
        issueKey,
        input.title,
        input.description ?? null,
        status,
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
        completedAt,
        null,
        now,
        now,
      ],
    );
    this.linkReferencedAttachmentsToIssue(id, input.description);
    for (const otherId of blockedByIds) {
      this.createIssueDependencyWithLockedEndpoints(id, otherId, { dependsOnIssueId: otherId, type: "blocked_by" }, {
        actorType: "system",
        actorId: createdBy,
      }, deferredEvents);
    }
    if (projectId) {
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    }
    this.ctx.appendIssueActivity(id, {
      actorType: "system",
      actorId: createdBy,
      type: "issue_created",
      body: input.title,
      data: { projectId, parentIssueId, issueKind, sourceIssueId, priority, startDate, dueDate },
    }, deferredEvents);
    // MUL-400 E1 re-derivation: a child created under an in_review parent puts
    // that parent back to in_progress. `createIssue` is the third entry point
    // the plan names alongside status change and re-parenting. The caller
    // replays its derived transition and queue after the insert commits.
    if (parentIssueId && parentStatusGuardEnabled()) {
      const child = this.getIssue(id)!;
      const parent = this.sameWorkspaceParent(child);
      if (parent) {
        // The hops this produces are replayed by the owner of the transaction
        // after it commits (see `createIssue`); running them here would open a
        // nested transaction whose work a rollback could still erase.
        this.rederiveParentStatus(parent, child, childStatusChanges, deferredEvents);
      }
    }
    if (sourceIssueId) {
      this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, sourceIssueId]);
      this.ctx.appendIssueActivity(sourceIssueId, {
        actorType: "agent",
        actorId: null,
        type: "issue_generated",
        body: input.title,
        data: { issueId: id, issueKey, projectId },
      }, deferredEvents);
    }
    if (createdBy) {
      const creator = this.ctx.workspaces().getWorkspaceMember(createdBy) ?? this.ctx.workspaces().findWorkspaceMemberForUser(createdBy, workspaceId);
      if (creator && creator.workspaceId === workspaceId && !creator.archivedAt) {
        this.addIssueSubscriber(id, creator.id, "created");
      }
    }
    this.ctx.issueSessions().getOrCreateDefaultIssueSession(id, createdBy);
    const created = this.getIssue(id)!;
    if (blockedBy.length && dependencyGateEnabled() && created.status !== "backlog") {
      // The requested status is ignored on purpose: an issue that cannot be
      // dispatched must not look startable on any surface.
      if (this.listUnmetPrerequisites(id).length > 0) {
        this.ctx.db.run(
          "UPDATE multiremi_issues SET status = 'backlog', completed_at = NULL, archived_at = NULL, updated_at = ? WHERE id = ?",
          [now, id],
        );
        this.ctx.appendIssueActivity(id, {
          actorType: "system",
          actorId: createdBy,
          type: "dependency_waiting",
          body: `backlog (requested ${created.status})`,
          data: {
            requestedStatus: created.status,
            requested_status: created.status,
            status: "backlog",
            blockedBy: this.listUnmetPrerequisites(id).map((row) => row.key),
          },
        }, deferredEvents);
        return this.getIssue(id)!;
      }
    }
    return created;
  }

  getIssue(id: string): MultiremiIssue | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssue(toIssue(row)) : null;
  }

  /**
   * Existence probe for callers that only need to know the row is there.
   * `getIssue` also hydrates labels (an extra join) which such callers never
   * read, and several of them are about to load the issue themselves anyway.
   */
  hasIssue(id: string): boolean {
    return this.ctx.db.query("SELECT id FROM multiremi_issues WHERE id = ?").get(id) != null;
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
    const resolved = this.resolveListHierarchyFilter(input);
    const { where, params } = buildIssueListWhere(resolved);
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
      .filter((issue) => issueMatchesListFilter(issue, resolved, (ref) => this.getIssueByRef(ref, this.listIssuesWorkspaceId(resolved))?.id ?? null))
      .slice(offset, offset + limit);
    return this.hydrateIssues(issues);
  }

  /**
   * MUL-400 E3: `parentId` accepts a key or an id. Callers that already
   * resolved it (the HTTP list routes do) pass an id and this is a no-op.
   */
  private resolveListHierarchyFilter(input: ListIssuesInput): ListIssuesInput {
    const parentId = input.parentId ?? input.parent_id;
    if (!parentId) return input;
    const resolved = this.getIssueByRef(parentId, this.listIssuesWorkspaceId(input))?.id;
    if (!resolved || resolved === parentId) return input;
    return { ...input, parentId: resolved, parent_id: resolved };
  }

  private listIssuesWorkspaceId(input: ListIssuesInput): string | null {
    return input.workspaceId ?? input.workspace_id ?? null;
  }

  countIssues(input: ListIssuesInput = {}): number {
    const unpaginated = { ...input, limit: undefined, offset: undefined };
    const hasMetadata = Boolean(input.metadata) && Object.keys(input.metadata!).length > 0;
    if (hasMetadata) return this.listIssues(unpaginated).length;
    const { where, params } = buildIssueListWhere(this.resolveListHierarchyFilter(unpaginated));
    const row = this.ctx.db.query(
      `SELECT COUNT(*) AS total FROM multiremi_issues ${where}`,
    ).get(...params) as Row | null;
    return Number(row?.total ?? 0);
  }

  /** First page per status, including counts and labels from one read snapshot. */
  listIssueStatusPages(input: ListIssuesInput = {}, includeArchivedTotal = false): IssueStatusPages {
    if (this.ctx.db.inTransaction) throw new Error("status pages require their own read snapshot");
    return this.ctx.db.transaction(() => {
      if (this.ctx.db.dialect === "postgres") {
        this.ctx.db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      }
      const resolved = this.resolveListHierarchyFilter(input);
      const requested = normalizeIssueStatusList(input.statuses ?? input.status);
      const statuses = requested.length ? requested : [...ISSUE_STATUSES];
      const limit = normalizeListLimit(input.limit, 50);
      const hasMetadata = Boolean(input.metadata) && Object.keys(input.metadata!).length > 0;
      const groups: IssueStatusPages["groups"] = {};
      const params: unknown[] = [];
      // Keep the exact single-status SELECT and its ordering. A partitioned
      // window sort can choose different winners for tied updated_at values.
      const selects = statuses.map((status) => {
        groups[status] = { issues: [], total: 0, has_more: false };
        const filter = buildIssueListWhere({ ...resolved, statuses: [status] });
        params.push(...filter.params);
        if (!hasMetadata) params.push(limit, 0);
        return `SELECT * FROM (SELECT * FROM multiremi_issues ${filter.where}
          ORDER BY updated_at DESC ${hasMetadata ? "" : "LIMIT ? OFFSET ?"}) AS status_page`;
      });
      const rows = this.ctx.db.query(selects.join(" UNION ALL ")).all(...params) as Row[];
      let issues = rows.map((row) => toIssue(row));
      if (hasMetadata) {
        issues = issues.filter((issue) => issueMatchesListFilter(issue, resolved));
        for (const issue of issues) groups[issue.status]!.total += 1;
        const used = new Map<string, number>();
        issues = issues.filter((issue) => {
          const index = used.get(issue.status) ?? 0;
          used.set(issue.status, index + 1);
          return index < limit;
        });
      } else {
        const filter = buildIssueListWhere({ ...resolved, statuses });
        const counts = this.ctx.db.query(`SELECT status, COUNT(*) AS total
          FROM multiremi_issues ${filter.where} GROUP BY status`).all(...filter.params) as Row[];
        for (const row of counts) groups[String(row.status)]!.total = Number(row.total);
      }
      for (const issue of this.hydrateIssues(issues)) groups[issue.status]!.issues.push(issue);
      for (const group of Object.values(groups)) group.has_more = group.issues.length < group.total;
      return {
        groups,
        ...(includeArchivedTotal ? {
          archived_total: this.countIssues({ workspaceId: this.listIssuesWorkspaceId(resolved), archivedOnly: true }),
        } : {}),
      };
    })();
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

  batchUpdateIssues(input: BatchUpdateIssuesInput): {
    updated: number;
    issues: MultiremiIssue[];
    skipped: Array<{ issueId: string; error: string; code: string | null }>;
  } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    const updates = input.updates ?? {};
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    if (!hasIssueMutation(updates)) return { updated: 0, issues: [], skipped: [] };
    // Pre-flight the whole batch so a refusal cannot leave half the rows
    // written while the caller sees a refusal (MUL-400 S1, QA round 2).
    this.preflightBatchUpdateIssues(issueIds, updates);
    const issues: MultiremiIssue[] = [];
    const skipped: Array<{ issueId: string; error: string; code: string | null }> = [];
    // MUL-400 E3 (QA round 2, blocker 5): batch is not a second way across the
    // dependency gate. The request's `force` is moved to a server-internal
    // option that only the parent-status guard reads, so a waiting issue in a
    // batch stays parked and no `dependency_force_started` is written. S1's
    // member override for a parent with open children keeps working.
    const batchOptions: UpdateIssueOptions = updates.force === true ? { parentStatusForce: true } : {};
    const rowUpdates: UpdateIssueInput = updates.force === true ? { ...updates, force: undefined } : updates;
    for (const issueId of issueIds) {
      try {
        issues.push(this.updateIssue(issueId, rowUpdates, batchOptions));
      } catch (err) {
        if (err instanceof IssueWorkspaceMoveError) {
          throw new IssueWorkspaceMoveError(err.relations, [issueId]);
        }
        // The per-row guard stays armed: a concurrent writer can still move an
        // Issue into a guarded state after the pre-flight above.
        if (err instanceof ParentStatusGuardError) {
          throw new BatchParentStatusGuardError(err, [issueId]);
        }
        // MUL-400 E3: a dependency refusal is reported per row instead of failing
        // the whole batch, matching the "skip invalid rows" shape callers
        // already handle. The row stays parked and no override is recorded.
        if (err instanceof IssueDependencyError) {
          skipped.push({ issueId, error: err.message, code: err.code });
          continue;
        }
        // Match Multiremi's batch behavior: skip invalid or inaccessible rows.
      }
    }
    return { updated: issues.length, issues, skipped };
  }

  /**
   * Evaluate guard A (A1 and A4 included) for every row before any of them is
   * written. Rows that do not exist are left to the write loop's historic
   * "skip invalid rows" behaviour; only a would-be guard refusal stops the
   * batch, and it does so with the refused issue ids.
   */
  private preflightBatchUpdateIssues(issueIds: string[], updates: UpdateIssueInput): void {
    if (hasAnyField(updates, "workspaceId", "workspace_id")) {
      const rejected: string[] = [];
      let firstError: IssueWorkspaceMoveError | null = null;
      for (const issueId of issueIds) {
        const current = this.getIssue(issueId);
        if (!current) continue;
        try {
          this.assertIssueWorkspaceMoveAllowed(current, updates);
        } catch (err) {
          if (!(err instanceof IssueWorkspaceMoveError)) throw err;
          rejected.push(issueId);
          firstError ??= err;
        }
      }
      if (firstError) throw new IssueWorkspaceMoveError(firstError.relations, rejected);
    }
    if (!parentStatusGuardEnabled()) return;
    if (!hasAnyField(updates, "status")) return;
    const rejected: string[] = [];
    let firstError: ParentStatusGuardError | null = null;
    for (const issueId of issueIds) {
      const current = this.getIssue(issueId);
      if (!current) continue;
      const nextStatus = normalizeIssueStatus(updates.status);
      if (nextStatus === current.status) continue;
      try {
        this.assertParentStatusAllowed(issueId, current, nextStatus, updates);
      } catch (err) {
        if (!(err instanceof ParentStatusGuardError)) throw err;
        rejected.push(issueId);
        firstError ??= err;
      }
    }
    if (firstError) throw new BatchParentStatusGuardError(firstError, rejected);
  }

  private assertIssueWorkspaceMoveAllowed(current: MultiremiIssue, input: UpdateIssueInput): void {
    const nextWorkspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", current.workspaceId) ?? "local";
    if (nextWorkspaceId === current.workspaceId) return;
    const parent = current.parentIssueId ? this.getIssue(current.parentIssueId) : null;
    // Raw edges must block a move even when hidden by the read views, or a
    // legacy foreign edge could become visible again in the target workspace.
    const children = this.ctx.db.query(
      `SELECT id, issue_key, workspace_id FROM multiremi_issues
       WHERE parent_issue_id = ? ORDER BY id`,
    ).all(current.id) as Row[];
    const issueWorkspace = this.ctx.db.query(
      "SELECT workspace_id, status, runtime_id FROM multiremi_issue_workspaces WHERE issue_id = ?",
    ).get(current.id) as Row | null;
    const uncleanedWorkspace = issueWorkspace && issueWorkspace.status !== "cleaned" ? issueWorkspace : null;
    const dependencies = this.ctx.db.query(
      `SELECT d.id, d.type, other.issue_key AS other_key
       FROM multiremi_issue_dependencies d
       LEFT JOIN multiremi_issues other ON other.id =
         CASE WHEN d.issue_id = ? THEN d.depends_on_issue_id ELSE d.issue_id END
         AND other.workspace_id = ?
       WHERE d.issue_id = ? OR d.depends_on_issue_id = ?
       ORDER BY d.id`,
    ).all(current.id, current.workspaceId, current.id, current.id) as Row[];
    // Same predicate as cancelActiveIssueTasks, so unassigning unblocks the move.
    // Task creation locks this row first, so none can commit behind this read.
    const tasks = this.ctx.db.query(
      `SELECT id, status, workspace_id FROM multiremi_tasks
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
       ORDER BY id`,
    ).all(current.id) as Row[];
    const visibleChildren = children.filter((row) => String(row.workspace_id) === current.workspaceId);
    const visibleDependencies = dependencies.filter((row) => row.other_key != null);
    const visibleTasks = tasks.filter((row) => String(row.workspace_id) === current.workspaceId);
    const visibleParent = parent?.workspaceId === current.workspaceId ? parent.key : null;
    const relations: IssueWorkspaceMoveRelations = {
      parent: visibleParent,
      children: visibleChildren.map((row) => String(row.issue_key)),
      dependencies: visibleDependencies.map((row) => ({
        id: String(row.id), key: String(row.other_key), type: String(row.type) as MultiremiIssueDependencyType,
      })),
      tasks: visibleTasks.map((row) => ({ id: String(row.id), status: String(row.status) as MultiremiTaskStatus })),
      issue_workspace: uncleanedWorkspace?.workspace_id === current.workspaceId
        ? { status: String(uncleanedWorkspace.status) as MultiremiIssueWorkspaceStatus,
          runtime_id: nullableString(uncleanedWorkspace.runtime_id) }
        : null,
      hidden: (current.parentIssueId && !visibleParent ? 1 : 0)
        + children.length - visibleChildren.length
        + dependencies.length - visibleDependencies.length
        + tasks.length - visibleTasks.length
        + (uncleanedWorkspace && uncleanedWorkspace.workspace_id !== current.workspaceId ? 1 : 0),
    };
    if (current.parentIssueId || children.length || dependencies.length || tasks.length || uncleanedWorkspace) {
      throw new IssueWorkspaceMoveError(relations);
    }
  }

  deleteIssue(id: string): boolean {
    const issue = this.getIssue(id);
    if (!issue) return false;
    const deferredEvents = createCommitEventQueue();
    const deleted = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
      this.ctx.lockIssueArchiveLifecycle(id);
      const current = this.getIssue(id);
      if (!current || current.workspaceId !== issue.workspaceId) return false;
      if (this.issueDeletionBlockWithinLifecycleLock(id)) return false;
      this.ctx.db.run(
        "UPDATE multiremi_issues SET lifecycle_state = 'deleting' WHERE id = ?",
        [id],
      );
      return this.deleteIssueRowsWithinLifecycleLock(current, deferredEvents);
    })();
    this.ctx.emitCommitEvents(deferredEvents);
    return deleted;
  }

  /** Delete every fenced Issue in one control-plane transaction. */
  deleteIssuesAtomically(ids: string[]): { deleted: number } {
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length === 0) return { deleted: 0 };
    const initial = uniqueIds
      .map((id) => this.getIssue(id))
      .filter((issue): issue is MultiremiIssue => Boolean(issue));
    const deferredEvents = createCommitEventQueue();
    const result = this.ctx.db.transaction(() => {
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
        if (this.deleteIssueRowsWithinLifecycleLock(issue, deferredEvents)) deleted++;
      }
      return { deleted };
    })();
    this.ctx.emitCommitEvents(deferredEvents);
    return result;
  }

  private deleteIssueRowsWithinLifecycleLock(issue: MultiremiIssue, deferredEvents: CommitEventQueue): boolean {
    const id = issue.id;
    this.cancelActiveIssueTasks(id, "issue_deleted", deferredEvents);
    this.ctx.db.run("UPDATE multiremi_autopilot_runs SET status = 'failed', completed_at = ?, failure_reason = ? WHERE issue_id = ? AND completed_at IS NULL", [
      nowIso(),
      "issue deleted",
      id,
    ]);
    this.ctx.db.run("UPDATE multiremi_autopilot_runs SET issue_id = NULL WHERE issue_id = ?", [id]);
    // Detach ledger rows first so the delete below only sweeps the actionable
    // notifications left behind. An empty registry would render `IN ()`, which
    // Postgres rejects — skipping the update then means "no ledger to keep".
    if (INBOX_LEDGER_TYPES.length > 0) {
      const inboxLedgerPlaceholders = INBOX_LEDGER_TYPES.map(() => "?").join(", ");
      this.ctx.db.run(
        `UPDATE multiremi_inbox_items SET issue_id = NULL WHERE issue_id = ? AND type IN (${inboxLedgerPlaceholders})`,
        [id, ...INBOX_LEDGER_TYPES],
      );
    }
    this.ctx.db.run("DELETE FROM multiremi_inbox_items WHERE issue_id = ?", [id]);
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
       FROM multiremi_issue_workspaces WHERE issue_id = ? AND workspace_id = ?`,
    ).get(id, this.getIssue(id)!.workspaceId) as { status?: unknown } | null;
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
    // cmt_v70r9qrr49uc: global evidence keeps the deletion gate unchanged by a move.
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
         OR EXISTS (SELECT 1 FROM multiremi_conversation_log e WHERE e.session_id = s.id AND e.kind <> 'head' AND e.seq > 0)
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
    const rows = this.listIssues({ includeArchived: true }).map((issue) => ({
      issue,
      matchedCommentSnippet: includeCommentBodies
        ? this.searchIssueCommentSnippet(issue.id, query)
        : null,
    })).filter(({ issue, matchedCommentSnippet }) => {
      if (issue.workspaceId !== workspaceId) return false;
      if (!includeClosed && CLOSED_ISSUE_STATUSES.has(issue.status) && !issue.archivedAt) return false;
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

  private sameWorkspaceParent(issue: MultiremiIssue): MultiremiIssue | null {
    const parent = issue.parentIssueId ? this.getIssue(issue.parentIssueId) : null;
    return parent?.workspaceId === issue.workspaceId ? parent : null;
  }

  listChildIssues(parentIssueId: string): MultiremiIssue[] {
    if (!this.hasIssue(parentIssueId)) throw new Error(`Issue not found: ${parentIssueId}`);
    const rows = this.ctx.db.query(
      `SELECT child.* FROM multiremi_issues child
       JOIN multiremi_issues parent ON parent.id = child.parent_issue_id AND parent.workspace_id = child.workspace_id
       WHERE child.parent_issue_id = ? ORDER BY child.position ASC, child.created_at DESC`,
    ).all(parentIssueId) as Row[];
    return rows.map((row) => this.hydrateIssue(toIssue(row)));
  }

  listChildIssueProgress(workspaceId = "local"): MultiremiIssueChildProgress[] {
    const rows = this.ctx.db.query(
      `${CHILD_PROGRESS_SELECT}
       WHERE child.workspace_id = ? AND child.parent_issue_id IS NOT NULL
       GROUP BY child.parent_issue_id
       ORDER BY child.parent_issue_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(toChildIssueProgress);
  }

  getChildIssueProgress(parentIssueId: string): MultiremiIssueChildProgress {
    const row = this.ctx.db.query(
      `${CHILD_PROGRESS_SELECT}
       WHERE child.parent_issue_id = ?
       GROUP BY child.parent_issue_id`,
    ).get(parentIssueId) as Row | null;
    return row ? toChildIssueProgress(row) : emptyChildIssueProgress(parentIssueId);
  }

  /**
   * MUL-400 E1: the number of children that still count as unfinished. `done`
   * and `cancelled` are terminal; `blocked` and everything else keep the parent
   * open, because a parked child is exactly the case the human must rule on.
   */
  countOpenChildIssues(parentIssueId: string): number {
    const row = this.ctx.db.query(
      `SELECT COUNT(*) AS open_children FROM multiremi_issues child
       JOIN multiremi_issues parent ON parent.id = child.parent_issue_id AND parent.workspace_id = child.workspace_id
       WHERE child.parent_issue_id = ? AND child.status NOT IN ('done', 'cancelled')`,
    ).get(parentIssueId) as { open_children?: unknown } | null;
    return Number(row?.open_children ?? 0);
  }

  /**
   * MUL-400 E1 guard A. Runs inside {@link updateIssueWithOutcome}'s row lock so
   * a user terminal write and a child status change cannot both derive from the
   * same stale child set.
   *
   * Only a status edit that actually CHANGES the Issue is guarded. The callers
   * that touch other fields — the auto-retitle service, the merge-completion
   * effect and every title/description/priority edit in the UI — are not status
   * decisions and must keep working on parents that already have children.
   *
   * MUL-400 S1c (A4): a task identity may close a parent when a member has
   * authorized THIS issue's owner agent — see {@link parentDoneGrantStatus}.
   */
  private assertParentStatusAllowed(
    id: string,
    current: MultiremiIssue,
    nextStatus: string,
    input: UpdateIssueInput,
  ): void {
    if (!statusNeedsChildGuard(nextStatus)) return;
    const force = input.force === true;
    const hasChildren = this.hasChildIssues(id);
    if (!hasChildren) return;
    // A4: a task identity may never close a parent issue at all, force or not —
    // unless a member has authorized exactly this agent on this parent (S1c).
    if (statusIsMemberOnlyParentTerminal(nextStatus) && input.actorType === "agent") {
      const grant = this.parentDoneGrantStatus(current);
      if (!grant.effective || grant.agentId !== input.actorId) {
        throw new ParentStatusGuardError(
          "parent_done_requires_member",
          `Task ${input.parentTaskId ?? "unknown"} cannot set ${current.key} to ${nextStatus}; only a member, or the owner agent a member has authorized on this issue, can close an issue that has children`,
          { reason: grant.effective ? "not_owner_agent" : grant.reason ?? "grant_missing" },
        );
      }
      if (force) {
        throw new ParentStatusGuardError(
          "parent_done_requires_member",
          `Only a member can force ${current.key} to ${nextStatus}; the owner agent must finish the children and publish a summary`,
          { reason: "force_requires_member" },
        );
      }
    }
    if (force) return;
    const openChildren = this.countOpenChildIssues(id);
    if (openChildren > 0) {
      throw new ParentStatusGuardError(
        "issue_status_held",
        `${current.key} still has ${openChildren} unfinished child issue(s); finish or cancel them, or repeat the request with force`,
        { openChildren, reason: "children_open" },
      );
    }
    if (nextStatus === "done") {
      // A1. The authorized owner agent (S1c D2) may satisfy it either with a
      // finished result-bearing round or with a summary comment it posted after
      // the last child closed; every other caller keeps the original rule.
      const grant = input.actorType === "agent" ? this.parentDoneGrantStatus(current) : null;
      const acceptCommentBy = grant?.effective && grant.agentId === input.actorId ? input.actorId : null;
      const summary = this.finalSummaryAfterLastChild(id, { acceptCommentBy });
      if (!summary.satisfied) {
        throw new ParentStatusGuardError(
          "final_summary_missing",
          acceptCommentBy
            ? `Post a summary comment on ${current.key} after the last child finished, then set it to done`
            : `${current.key} cannot be closed before its owner publishes a result after the last child finished`,
          { lastChildClosedAt: summary.lastChildClosedAt, reason: "final_summary_missing" },
        );
      }
    }
  }

  /**
   * MUL-400 S1c (A4): does this Issue have any children at all? `countOpenChildIssues`
   * answers a different question (unfinished children), and the grant rules key
   * off "has children", not "has open children".
   */
  hasChildIssues(issueId: string): boolean {
    return this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_issues child
       JOIN multiremi_issues parent ON parent.id = child.parent_issue_id AND parent.workspace_id = child.workspace_id
       WHERE child.parent_issue_id = ? LIMIT 1`,
    ).get(issueId) != null;
  }

  /**
   * MUL-400 S1c (A4): the ONE place that decides whether the stored grant still
   * authorizes the CURRENT owner agent. Read by guard A (inside its row lock),
   * the SCM merge effect and the detail routes, so all three agree.
   *
   * The effective agent is re-resolved from the Issue's assignee on every read
   * (`resolveRunnableAgentForAssignee`: agent -> itself, squad -> its leader).
   * A grant records the agent that was the owner when the member granted it, so
   * re-assigning the parent makes the grant ineffective (`assignee_changed`,
   * D1) instead of silently following the new owner.
   */
  parentDoneGrantStatus(issue: MultiremiIssue): {
    granted: boolean;
    grantedAt: string | null;
    grantedBy: string | null;
    agentId: string | null;
    ownerAgentId: string | null;
    effective: boolean;
    reason: ParentDoneGrantRefusalReason | null;
  } {
    const grantedAt = issue.parentDoneGrantAt ?? null;
    const grantedBy = issue.parentDoneGrantBy ?? null;
    const agentId = issue.parentDoneGrantAgentId ?? null;
    const granted = grantedAt != null && agentId != null;
    if (!granted) {
      return { granted: false, grantedAt, grantedBy, agentId, ownerAgentId: null, effective: false, reason: "grant_missing" };
    }
    const ownerAgentId = issue.assigneeType && issue.assigneeId
      ? this.ctx.resolveRunnableAgentForAssignee(issue.assigneeType, issue.assigneeId)?.id ?? null
      : null;
    const effective = granted && ownerAgentId != null && ownerAgentId === agentId;
    const reason: ParentDoneGrantRefusalReason | null = effective
      ? null
      : !granted
        ? "grant_missing"
        : ownerAgentId == null
          ? "owner_not_agent"
          : "assignee_changed";
    return { granted, grantedAt, grantedBy, agentId, ownerAgentId, effective, reason };
  }

  /**
   * The wire shape for `issue.parent_done_grant` (S7 / MUL-414 renders the
   * toggle from it). `null` means "no grant was ever recorded"; a recorded but
   * ineffective grant still returns its data with `effective: false` so the UI
   * can say "re-authorize" instead of pretending nothing happened.
   */
  issueParentDoneGrantView(issue: MultiremiIssue): MultiremiIssueParentDoneGrant | null {
    const status = this.parentDoneGrantStatus(issue);
    if (!status.granted || status.grantedAt == null || status.grantedBy == null || status.agentId == null) return null;
    return {
      granted_at: status.grantedAt,
      granted_by: status.grantedBy,
      agent_id: status.agentId,
      effective: status.effective,
      ineffective_reason: status.effective ? null : status.reason === "assignee_changed" ? "assignee_changed" : "owner_not_agent",
    };
  }

  /**
   * A1: the parent owner owes a result-bearing round that finished after the last
   * child closed. Skipped for member owners — a human closing the issue is the
   * summary. The signal is the owner's task set on the parent: a `completed` task
   * with a non-empty result and `completed_at` at or after the last child's
   * terminal timestamp.
   *
   * An authorized owner agent may also satisfy A1 with its own non-empty
   * comment after the final child closes. SCM checks the same signal before
   * bypassing guard A; member closure keeps the original completed-task rule.
   */
  finalSummaryAfterLastChild(parentIssueId: string, options: { acceptCommentBy?: string | null } = {}): { satisfied: boolean; lastChildClosedAt: string | null } {
    const parent = this.getIssue(parentIssueId);
    if (!parent) return { satisfied: false, lastChildClosedAt: null };
    if (parent.assigneeType === "member") return { satisfied: true, lastChildClosedAt: null };
    const lastChild = this.ctx.db.query(
      `SELECT MAX(COALESCE(child.completed_at, child.updated_at)) AS closed_at
       FROM multiremi_issues child
       JOIN multiremi_issues parent ON parent.id = child.parent_issue_id AND parent.workspace_id = child.workspace_id
       WHERE child.parent_issue_id = ? AND child.status IN ('done', 'cancelled')`,
    ).get(parentIssueId) as { closed_at?: unknown } | null;
    const lastChildClosedAt = nullableString(lastChild?.closed_at);
    const openChildren = this.countOpenChildIssues(parentIssueId);
    if (openChildren > 0) return { satisfied: false, lastChildClosedAt };
    const parentAgentId = parent.assigneeType && parent.assigneeId
      ? this.ctx.resolveRunnableAgentForAssignee(parent.assigneeType, parent.assigneeId)?.id ?? null
      : null;
    if (!parentAgentId) return { satisfied: false, lastChildClosedAt };
    if (options.acceptCommentBy === parentAgentId) {
      const comments = this.ctx.db.query(
        `SELECT log.body_md AS body FROM multiremi_conversation_log log
         JOIN multiremi_issue_sessions session ON session.id = log.session_id
         WHERE session.issue_id = ? AND log.author_type = 'agent' AND log.author_id = ? AND log.kind = 'message'
           AND SUBSTR(log.id, 1, 4) = 'cmt_' AND log.deleted_at IS NULL
           ${lastChildClosedAt ? "AND log.created_at >= ?" : ""}`,
      ).all(...(lastChildClosedAt ? [parentIssueId, parentAgentId, lastChildClosedAt] : [parentIssueId, parentAgentId])) as Row[];
      if (comments.some((row) => String(row.body ?? "").trim().length > 0)) {
        return { satisfied: true, lastChildClosedAt };
      }
    }
    // `result` is a JSON blob written by completeTask; "has a result" means the
    // stored payload carries non-empty output text, so evaluate it in JS rather
    // than pattern-matching the serialized column in SQL.
    const rows = this.ctx.db.query(
      `SELECT result FROM multiremi_tasks
       WHERE issue_id = ? AND agent_id = ? AND status = 'completed'
         AND result IS NOT NULL AND completed_at IS NOT NULL
         ${lastChildClosedAt ? "AND completed_at >= ?" : ""}
       ORDER BY completed_at DESC`,
    ).all(...(lastChildClosedAt ? [parentIssueId, parentAgentId, lastChildClosedAt] : [parentIssueId, parentAgentId])) as Row[];
    const satisfied = rows.some((row) => storedTaskResultHasOutput(row.result));
    return { satisfied, lastChildClosedAt };
  }

  /**
   * MUL-400 E3: prerequisites of `issueId` that are not `done` yet.
   *
   * Only direct prerequisites count. A prerequisite that is itself waiting is
   * still unmet (nothing cascades until the head of the chain finishes), and
   * `in_review`, `blocked` and `cancelled` all count as unmet by design: the
   * gate exists so a sibling never starts on a half-finished dependency.
   */
  listUnmetPrerequisites(issueId: string): IssueDependencyUnmetRef[] {
    return this.listPrerequisites(issueId).filter((row) => !isPrerequisiteSatisfied(row.status));
  }

  /**
   * Every direct prerequisite of `issueId`, met or not, in creation order.
   *
   * Both stored spellings are considered, because the reverse reading of a
   * legacy `blocks` row is part of the semantics and there is no migration:
   * a `blocked_by` row names the waiter in `issue_id`, while a `blocks` row
   * names it in `depends_on_issue_id`.
   */
  private listPrerequisites(issueId: string): IssueDependencyUnmetRef[] {
    const rows = this.ctx.db.query(
      `SELECT d.id AS dependency_id,
              CASE WHEN d.type = 'blocks' THEN d.depends_on_issue_id ELSE d.issue_id END AS dependent_issue_id,
              prereq.id AS prerequisite_issue_id,
              prereq.issue_key,
              prereq.title,
              prereq.status
       FROM multiremi_issue_dependencies d
       JOIN multiremi_issues prereq ON prereq.id = CASE
         WHEN d.type = 'blocks' THEN d.issue_id
         ELSE d.depends_on_issue_id
       END
       JOIN multiremi_issues dependent ON dependent.id = CASE
         WHEN d.type = 'blocks' THEN d.depends_on_issue_id ELSE d.issue_id
       END
       WHERE d.type IN ('blocked_by', 'blocks')
         AND CASE WHEN d.type = 'blocks' THEN d.depends_on_issue_id ELSE d.issue_id END = ?
         AND d.workspace_id = dependent.workspace_id
         AND prereq.workspace_id = dependent.workspace_id
       ORDER BY d.created_at ASC, d.id ASC`,
    ).all(issueId) as Row[];
    return rows.map((row) => ({
      issueId: String(row.dependent_issue_id),
      dependsOnIssueId: String(row.prerequisite_issue_id),
      key: String(row.issue_key ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? "todo"),
      dependencyId: String(row.dependency_id),
    }));
  }

  /** MUL-400 E3: page data for the detail surface. */
  getIssueWaitingOn(issueId: string): MultiremiIssueWaitingOn {
    const prerequisites = this.listPrerequisites(issueId);
    return {
      unmet: prerequisites.filter((row) => !isPrerequisiteSatisfied(row.status)),
      prerequisites,
    };
  }

  grantParentDone(issueId: string, memberId: string): MultiremiIssue {
    const deferredEvents = createCommitEventQueue();
    const issue = this.ctx.db.transaction(() => {
      if (!lockIssueRowWithinTransaction(this.ctx.db, issueId)) throw new Error(`Issue not found: ${issueId}`);
      const current = this.getIssue(issueId)!;
      const ownerAgentId = current.assigneeType && current.assigneeId
        ? this.ctx.resolveRunnableAgentForAssignee(current.assigneeType, current.assigneeId)?.id ?? null
        : null;
      if (!ownerAgentId) throw new ParentDoneGrantOwnerError("Assign an agent or squad owner before granting parent closure");
      if (current.parentDoneGrantAt && current.parentDoneGrantAgentId === ownerAgentId) return current;
      const now = nowIso();
      this.ctx.db.run(
        "UPDATE multiremi_issues SET parent_done_grant_at = ?, parent_done_grant_by = ?, parent_done_grant_agent_id = ?, updated_at = ? WHERE id = ?",
        [now, memberId, ownerAgentId, now, issueId],
      );
      this.ctx.appendIssueActivity(issueId, {
        actorType: "member", actorId: memberId, type: "parent_done_grant_created",
        data: {
          agentId: ownerAgentId, agent_id: ownerAgentId, memberId, member_id: memberId,
          previousAgentId: current.parentDoneGrantAgentId, previous_agent_id: current.parentDoneGrantAgentId,
          grantedAt: now, granted_at: now,
        },
      }, deferredEvents);
      return this.getIssue(issueId)!;
    })();
    this.ctx.emitCommitEvents(deferredEvents);
    return issue;
  }

  revokeParentDone(issueId: string, memberId: string): MultiremiIssue {
    const deferredEvents = createCommitEventQueue();
    const issue = this.ctx.db.transaction(() => {
      if (!lockIssueRowWithinTransaction(this.ctx.db, issueId)) throw new Error(`Issue not found: ${issueId}`);
      const current = this.getIssue(issueId)!;
      if (!current.parentDoneGrantAt) return current;
      this.ctx.db.run(
        "UPDATE multiremi_issues SET parent_done_grant_at = NULL, parent_done_grant_by = NULL, parent_done_grant_agent_id = NULL, updated_at = ? WHERE id = ?",
        [nowIso(), issueId],
      );
      this.ctx.appendIssueActivity(issueId, {
        actorType: "member", actorId: memberId, type: "parent_done_grant_revoked",
        data: { agentId: current.parentDoneGrantAgentId, agent_id: current.parentDoneGrantAgentId, memberId, member_id: memberId },
      }, deferredEvents);
      return this.getIssue(issueId)!;
    })();
    this.ctx.emitCommitEvents(deferredEvents);
    return issue;
  }

  listIssueDependencies(issueId: string): MultiremiIssueDependencyView[] {
    if (!this.hasIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    return this.listIssueDependencyViews(issueId);
  }

  private listIssueDependencyViews(issueId: string): MultiremiIssueDependencyView[] {
    const rows = this.ctx.db.query(
      `SELECT d.* FROM multiremi_issue_dependencies d
       JOIN multiremi_issues a ON a.id = d.issue_id AND a.workspace_id = d.workspace_id
       JOIN multiremi_issues b ON b.id = d.depends_on_issue_id AND b.workspace_id = a.workspace_id
       WHERE d.issue_id = ? OR d.depends_on_issue_id = ?
       ORDER BY d.created_at ASC, d.id ASC`,
    ).all(issueId, issueId) as Row[];
    return rows.map((row) => this.issueDependencyView(
      this.hydrateIssueDependency(toIssueDependency(row)),
      issueId,
    ));
  }

  /**
   * The stored row read from one issue's point of view.
   *
   * `issue_id` and `depends_on_issue_id` stay the stored columns — a `blocks`
   * row really is "(issue_id) blocks (depends_on_issue_id)" — and `direction`
   * says which side the caller is on: `blocked_by` means the caller waits for
   * the other issue, `blocks` means the other issue waits for the caller.
   */
  private issueDependencyView(
    dependency: MultiremiIssueDependency,
    perspectiveIssueId: string,
  ): MultiremiIssueDependencyView {
    // `related` is neither a prerequisite nor a dependent, so inventing a
    // direction for it would let a client render "waits for" on a peer link.
    if (dependency.type === "related") return { ...dependency, direction: null };
    const callerIsIssue = dependency.issueId === perspectiveIssueId;
    const callerWaits = dependency.type === "blocks" ? !callerIsIssue : callerIsIssue;
    return {
      ...dependency,
      direction: callerWaits ? "blocked_by" : "blocks",
    };
  }

  createIssueDependency(
    issueId: string,
    input: CreateIssueDependencyInput,
    activity: IssueMutationActivityContext = {},
  ): MultiremiIssueDependencyView {
    const deferredEvents = createCommitEventQueue();
    const dependency = this.ctx.db.transaction(() =>
      this.createIssueDependencyWithinTransaction(issueId, input, activity, deferredEvents))();
    this.ctx.emitCommitEvents(deferredEvents);
    return dependency;
  }

  /**
   * Caller owns the transaction: issue creation adds its prerequisites in the
   * same transaction as the row itself, so a rejected cycle leaves no issue
   * behind.
   *
   * Writes are normalized to a single direction before they are stored. Asking
   * for `blocks` (A blocks B) is the same statement as B waiting on A, so the
   * pair is flipped and one `blocked_by` row is written. `depends_on_issue_id`
   * accepts a key (`MUL-12`) or an id.
   */
  createIssueDependencyWithinTransaction(
    issueId: string,
    input: CreateIssueDependencyInput,
    activity: IssueMutationActivityContext,
    deferredEvents: CommitEventQueue,
  ): MultiremiIssueDependencyView {
    const dependsOnRef = String(input.dependsOnIssueId ?? input.depends_on_issue_id ?? "").trim();
    // The workspace is only a hint for ref -> id resolution. All validation
    // uses fresh rows after the complete, ordered lock set has been acquired.
    const hint = this.ctx.db.query("SELECT workspace_id FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    const otherId = this.resolveIssueRelationRef(dependsOnRef, hint ? String(hint.workspace_id) : null)
      ?? this.resolveIssueRelationRef(dependsOnRef, null) ?? dependsOnRef;
    lockIssueRowsWithinTransaction(this.ctx.db, [issueId, otherId]);
    return this.createIssueDependencyWithLockedEndpoints(issueId, otherId, input, activity, deferredEvents);
  }

  private createIssueDependencyWithLockedEndpoints(
    issueId: string,
    otherId: string,
    input: CreateIssueDependencyInput,
    activity: IssueMutationActivityContext,
    deferredEvents: CommitEventQueue,
  ): MultiremiIssueDependencyView {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const requestedOther = this.getIssue(otherId);
    if (!requestedOther) throw new Error(`Dependent issue not found: ${input.dependsOnIssueId ?? input.depends_on_issue_id}`);
    if (requestedOther.workspaceId !== issue.workspaceId) throw new Error("Issue dependency must stay within a workspace");
    const requestedType = normalizeIssueDependencyType(input.type);

    // `related` carries no direction and is stored as asked. `blocked_by` and
    // `blocks` both resolve to "the dependent waits for the prerequisite".
    const waiter = requestedType === "blocks" ? requestedOther : issue;
    const prerequisite = requestedType === "blocks" ? issue : requestedOther;
    if (requestedType === "related") {
      if (issue.id === requestedOther.id) throw new Error("An issue cannot depend on itself");
      const existing = this.findIssueDependencyRow(issue.id, requestedOther.id, "related");
      if (existing) return this.issueDependencyView(this.hydrateIssueDependency(toIssueDependency(existing)), issue.id);
      return this.insertIssueDependencyRow(issue.id, requestedOther.id, "related", input, activity, issue.id, deferredEvents);
    }
    if (waiter.id === prerequisite.id) throw new Error("An issue cannot depend on itself");
    // The pair may already be recorded (the CLI adds dependencies idempotently).
    // Answer with the stored row before the cycle walk: an existing edge is the
    // relation being requested, not a cycle through it.
    const existing = this.findIssueDependencyRow(waiter.id, prerequisite.id, "blocked_by");
    if (existing) return this.issueDependencyView(this.hydrateIssueDependency(toIssueDependency(existing)), issue.id);
    this.assertDependencyAllowed(waiter, prerequisite);
    return this.insertIssueDependencyRow(waiter.id, prerequisite.id, "blocked_by", input, activity, issue.id, deferredEvents);
  }

  /** Resolve identity only; workspaces and relationship state are checked after locking. */
  private resolveIssueRelationRef(ref: string, workspaceId: string | null): string | null {
    const value = ref.trim();
    const filter = workspaceId ? " AND workspace_id = ?" : "";
    const workspaceParams = workspaceId ? [workspaceId] : [];
    const exact = this.ctx.db.query(`SELECT id FROM multiremi_issues WHERE id = ?${filter}`)
      .get(value, ...workspaceParams) as Row | null;
    if (exact) return String(exact.id);
    const numeric = /^\d+$/.test(value);
    const rows = this.ctx.db.query(
      `SELECT id FROM multiremi_issues WHERE (lower(issue_key) = lower(?)${numeric ? " OR issue_number = ?" : ""})${filter} LIMIT 2`,
    ).all(value, ...(numeric ? [Number(value)] : []), ...workspaceParams) as Row[];
    return rows.length === 1 ? String(rows[0]!.id) : null;
  }

  private findIssueDependencyRow(
    issueId: string,
    dependsOnIssueId: string,
    type: MultiremiIssueDependencyType,
  ): Row | null {
    return this.ctx.db.query(
      `SELECT * FROM multiremi_issue_dependencies
       WHERE issue_id = ? AND depends_on_issue_id = ? AND type = ?`,
    ).get(issueId, dependsOnIssueId, type) as Row | null;
  }

  private insertIssueDependencyRow(
    issueId: string,
    dependsOnIssueId: string,
    type: MultiremiIssueDependencyType,
    input: CreateIssueDependencyInput,
    activity: IssueMutationActivityContext,
    perspectiveIssueId: string,
    deferredEvents: CommitEventQueue,
  ): MultiremiIssueDependencyView {
    const id = input.id ?? createId("dep");
    const now = nowIso();
    const existing = this.findIssueDependencyRow(issueId, dependsOnIssueId, type);
    if (existing) {
      return this.issueDependencyView(
        this.hydrateIssueDependency(toIssueDependency(existing)),
        perspectiveIssueId,
      );
    }
    const workspaceId = this.getIssue(issueId)?.workspaceId ?? "local";
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_dependencies (
        id, workspace_id, issue_id, depends_on_issue_id, type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, issueId, dependsOnIssueId, type, now],
    );
    const dependsOnIssue = this.getIssue(dependsOnIssueId);
    this.ctx.appendIssueActivity(issueId, {
      actorType: activity.actorType ?? input.actorType ?? input.actor_type ?? "system",
      actorId: activity.actorId ?? input.actorId ?? input.actor_id ?? null,
      type: "issue_dependency_added",
      body: dependsOnIssue ? `blocked_by ${dependsOnIssue.key}` : type,
      data: {
        dependencyId: id,
        dependsOnIssueId,
        type,
        ...sourceTaskActivityData(
          activity.sourceTaskId ?? resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
        ),
      },
    }, deferredEvents);
    const stored = this.getIssueDependency(id)!;
    return this.issueDependencyView(stored, perspectiveIssueId);
  }

  /**
   * MUL-400 E3 cycle and ancestor checks, both bounded:
   *
   * - a cycle closes when the prerequisite already (transitively) waits on the
   *   dependent, found by a depth-first walk over the same-direction graph with
   *   a 200-node bound;
   * - depending on an ancestor is the hierarchy version of the same mistake and
   *   is refused outright, because a parent always finishes after its children.
   */
  private assertDependencyAllowed(waiter: MultiremiIssue, prerequisite: MultiremiIssue): void {
    // Ancestry is a subset of the dependency graph once the platform's own
    // parent-is-later ordering is considered, and an ancestor relationship is
    // the more specific diagnosis, so it is reported first.
    const ancestorChain = this.issueAncestorChain(waiter.id);
    const ancestorIndex = ancestorChain.findIndex((ancestor) => ancestor.id === prerequisite.id);
    if (ancestorIndex >= 0) {
      // Nearest ancestor first, which is the order the chain is discovered in.
      const chain = [...ancestorChain.slice(0, ancestorIndex + 1)];
      throw new IssueDependencyError(
        "dependency_on_ancestor",
        `${waiter.key} cannot depend on its ancestor ${prerequisite.key}; a parent always finishes after its children`,
        { path: [waiter.key, ...chain.map((ancestor) => ancestor.key)] },
      );
    }
    // The walk follows "waits for" edges from the proposed prerequisite: the
    // new edge closes a cycle exactly when that prerequisite already waits,
    // directly or transitively, on the dependent.
    const cyclePath = findDependencyCyclePath(prerequisite.id, waiter.id, (id) => this.directPrerequisitesOf(id));
    if (cyclePath) {
      throw new IssueDependencyError(
        "dependency_cycle",
        `Dependency would create a cycle: ${cyclePath.map((id) => this.getIssue(id)?.key ?? id).join(" -> ")}`,
        { path: cyclePath.map((id) => this.getIssue(id)?.key ?? id) },
      );
    }
  }

  /**
   * The ids `issueId` waits for, covering both stored spellings of the same
   * relation: a `blocked_by` row names the prerequisite in its second column,
   * while a `blocks` row names it in the first.
   */
  private directPrerequisitesOf(issueId: string): string[] {
    const rows = this.ctx.db.query(
      `SELECT d.issue_id, d.depends_on_issue_id, d.type FROM multiremi_issue_dependencies d
       JOIN multiremi_issues a ON a.id = d.issue_id AND a.workspace_id = d.workspace_id
       JOIN multiremi_issues b ON b.id = d.depends_on_issue_id AND b.workspace_id = a.workspace_id
       WHERE d.depends_on_issue_id = ? OR d.issue_id = ?`,
    ).all(issueId, issueId) as Row[];
    const prerequisites = new Set<string>();
    for (const row of rows) {
      const type = String(row.type);
      if (type === "related") continue;
      const waiterId = type === "blocks" ? String(row.depends_on_issue_id) : String(row.issue_id);
      const prerequisiteId = type === "blocks" ? String(row.issue_id) : String(row.depends_on_issue_id);
      if (waiterId === issueId && prerequisiteId !== issueId) prerequisites.add(prerequisiteId);
    }
    return [...prerequisites];
  }

  /** Ancestors of `issueId`, nearest parent first. Bounded and cycle-safe. */
  private issueAncestorChain(issueId: string): MultiremiIssue[] {
    const ancestors: MultiremiIssue[] = [];
    const seen = new Set<string>();
    const issue = this.getIssue(issueId);
    let parent = issue ? this.sameWorkspaceParent(issue) : null;
    while (parent && !seen.has(parent.id) && ancestors.length < 200) {
      seen.add(parent.id);
      ancestors.push(parent);
      parent = this.sameWorkspaceParent(parent);
    }
    return ancestors;
  }

  getIssueDependency(id: string): MultiremiIssueDependency | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issue_dependencies WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueDependency(toIssueDependency(row)) : null;
  }

  deleteIssueDependency(
    issueId: string,
    dependencyId: string,
    activity: IssueMutationActivityContext = {},
  ): void {
    const dependency = this.getIssueDependency(dependencyId);
    if (!dependency) return;
    if (dependency.issueId !== issueId && dependency.dependsOnIssueId !== issueId) {
      throw new Error(`Dependency not found for issue: ${issueId}`);
    }
    this.ctx.db.run("DELETE FROM multiremi_issue_dependencies WHERE id = ?", [dependencyId]);
    this.ctx.appendIssueActivity(issueId, {
      actorType: activity.actorType ?? "system",
      actorId: activity.actorId ?? null,
      type: "issue_dependency_removed",
      body: dependency.type,
      data: {
        dependencyId,
        issueId: dependency.issueId,
        dependsOnIssueId: dependency.dependsOnIssueId,
        type: dependency.type,
        ...sourceTaskActivityData(activity.sourceTaskId),
      },
    });
  }

  updateIssue(id: string, input: UpdateIssueInput, options: UpdateIssueOptions = {}): MultiremiIssue {
    return this.updateIssueWithOutcome(id, input, options).issue;
  }

  updateIssueWithOutcome(
    id: string,
    input: UpdateIssueInput,
    options: UpdateIssueOptions = {},
  ): {
    issue: MultiremiIssue;
    cancelledTasks: number;
    /**
     * MUL-409 (QA round 4, blocker 1): this request was a `force` that tried to
     * leave `backlog`, and the store already made the dispatch decision inside
     * the write transaction. That is true whether or not the gate was still
     * closed when the row lock was taken, so the route's assign-on-update step
     * must skip it either way — dispatching there would cancel the round the
     * store just queued and queue a second one.
     *
     * (Before the round-4 ruling the flag meant "a
     * `dependency_force_started` was recorded", which left the already-open case
     * dispatching twice.)
     */
    handledForcedStart: boolean;
    dependencyCheckEventId: string | null;
    /**
     * The Issue as it was observed INSIDE the write transaction, after the row
     * lock. Callers that decide "did this request move the issue?" from a
     * pre-read can be stale — a concurrent writer (the automatic start, another
     * PATCH) may have committed in between — and acting on that stale answer
     * dispatches a second round. This snapshot is the one the write itself used.
     */
    previous: MultiremiIssue;
  } {
    // MUL-400 S1c (QA round 1): the row write and its audit activities are one
    // transaction, and every outbound event waits for COMMIT. The write lives in
    // {@link updateIssueWithinTransaction} so the SCM merge effect can join the
    // same transaction and roll the status back together with its bookkeeping.
    // A stale lock set rolls back and retries once with fresh queues.
    const ownsTransaction = !this.ctx.db.inTransaction;
    const update = () => {
      const collector: ChildStatusChangeCollector = [];
      const deferredEvents = createCommitEventQueue();
      const write = () => this.updateIssueWithinTransaction(
        id,
        input,
        options,
        collector,
        deferredEvents,
      );
      const result = ownsTransaction ? this.ctx.db.transaction(write)() : write();
      return { result, collector, deferredEvents };
    };
    const { result, collector, deferredEvents } = ownsTransaction ? retryOnceOnStaleLockSet(update) : update();
    afterCommit(this.ctx.db, () => this.runIssueUpdatePostCommit(result, input, collector, deferredEvents));
    return result;
  }

  /**
   * MUL-400 S1c (QA round 1): the caller owns the transaction.
   *
   * The row update, `issue_updated`, `issue_status_forced` and
   * `parent_done_grant_used` commit together, so an exception after any of them
   * leaves nothing behind. `collector`/`deferredEvents` are mandatory: only the
   * caller's COMMIT makes the write durable (a nested `transaction()` is a
   * SAVEPOINT since B1, MUL-426), so this method never opens a transaction and
   * never emits a workspace event directly. The caller must run
   * {@link runIssueUpdatePostCommit} after its COMMIT.
   */
  updateIssueWithinTransaction(
    id: string,
    input: UpdateIssueInput,
    options: UpdateIssueOptions,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): {
    issue: MultiremiIssue;
    previous: MultiremiIssue;
    cancelledTasks: number;
    handledForcedStart: boolean;
    dependencyCheckEventId: string | null;
  } {
    let cancelledTasks = 0;
    // Every `force` that tries to leave `backlog`, whether or not the gate was
    // still closed when the row lock was taken. The dispatch decision belongs to
    // this transaction (see the `forceStartAttempt` block below).
    let forceStartAttempt = false;
    // Written inside the transaction closure below; declared here so the
    // post-commit report can read the decision.
    let dispatchOutcome: ForcedStartOutcome | null = null;
    // A forced start may create a task, so take the workspace lock before the
    // Issue row lock just like every other task-creation path.
    {
      const initial = this.ctx.db.query("SELECT workspace_id FROM multiremi_issues WHERE id = ?")
        .get(id) as { workspace_id: string } | null;
      if (initial) {
        // Match Task creation's workspace-before-Issue lock order so a
        // first execution cannot race a directory change on Postgres.
        const targetWorkspace = input.workspaceId ?? input.workspace_id ?? initial.workspace_id;
        for (const workspaceId of [...new Set([initial.workspace_id, targetWorkspace])].sort()) {
          this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
        }
      }
    }
    // A no-op UPDATE is a portable write lock: Postgres locks this Issue row
    // until commit, while SQLite serializes the writer transaction. Re-read
    // only after acquiring it so a user terminal transition and a worker
    // lifecycle transition can never derive writes from the same stale row.
    // ADR 0003 #8: one unlocked hint picks every Issue row to lock, they are
    // locked once in id order, and no row is added after the re-read.
    const hasParentField = hasAnyField(input, "parentIssueId", "parent_issue_id");
    const parentRef = hasParentField
      ? resolveOptionalStringField(input, "parentIssueId", "parent_issue_id", null) : null;
    const requestedStatus = hasAnyField(input, "status") ? normalizeIssueStatus(input.status) : null;
    const mayReopen = requestedStatus !== null && !isTerminalIssueStatus(requestedStatus);
    const hasWorkspaceField = hasAnyField(input, "workspaceId", "workspace_id");
    const hint = parentRef || (mayReopen && !hasParentField) || hasWorkspaceField
      ? this.ctx.db.query("SELECT workspace_id, parent_issue_id, status FROM multiremi_issues WHERE id = ?").get(id) as Row | null
      : null;
    // A move takes a number in its target workspace (the MUL-405 unique index
    // rejects the old one there), so it takes that workspace's number lock (N)
    // before any Issue row (D). No workspace lock is added for it.
    const hintedTarget = hint && hasWorkspaceField
      ? resolveOptionalStringField(input, "workspaceId", "workspace_id", null) ?? "local" : null;
    const numberLockWorkspaceId = hintedTarget !== null && hintedTarget !== String(hint!.workspace_id) ? hintedTarget : null;
    if (numberLockWorkspaceId) advisoryXactLock(this.ctx.db, numberAllocationLockKey(`issue:${numberLockWorkspaceId}`));
    const parentId = parentRef
      ? this.resolveIssueRelationRef(parentRef, input.workspaceId ?? input.workspace_id ?? (hint ? String(hint.workspace_id) : null)) ?? parentRef
      : null;
    // A child reopened without a parent field changes its current parent's
    // unfinished-child count.
    const reopenedChildParent = !hasParentField && mayReopen && hint?.parent_issue_id
      && isTerminalIssueStatus(String(hint.status)) ? String(hint.parent_issue_id) : null;
    const lockedRows = lockIssueRowsWithinTransaction(this.ctx.db, [id, parentId, reopenedChildParent]);
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const nextWorkspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", current.workspaceId) ?? "local";
    const moving = nextWorkspaceId !== current.workspaceId;
    // The Issue moved while this transaction waited, so the number lock it did
    // not take is now needed; it is never taken after an Issue row.
    if (moving && numberLockWorkspaceId !== nextWorkspaceId) throw new IssueLockSetStaleError();
    let nextProjectId = resolveOptionalStringField(input, "projectId", "project_id", current.projectId);
    const nextParentIssueId = parentId ?? resolveOptionalStringField(input, "parentIssueId", "parent_issue_id", current.parentIssueId);
    const nextStatus = requestedStatus ?? current.status;
    // A new membership (even a closed child) changes A4; reopening changes the
    // unfinished-child count as well. Both need the parent row locked above.
    if (nextParentIssueId && (nextParentIssueId !== current.parentIssueId
      || (isTerminalIssueStatus(current.status) && !isTerminalIssueStatus(nextStatus)))) {
      if (!lockedRows.has(nextParentIssueId)) throw new IssueLockSetStaleError();
      if (!lockedRows.get(nextParentIssueId)) throw new Error(`Parent issue not found: ${nextParentIssueId}`);
    }
    this.assertIssueWorkspaceMoveAllowed(current, input);
    let nextRuntimeWorkspaceId = resolveOptionalStringField(input, "runtimeWorkspaceId", "runtime_workspace_id", current.runtimeWorkspaceId ?? null);
    const picksProject = hasAnyField(input, "projectId", "project_id") && Boolean(nextProjectId);
    const picksDirectory = hasAnyField(input, "runtimeWorkspaceId", "runtime_workspace_id") && Boolean(nextRuntimeWorkspaceId);
    if (picksProject && picksDirectory) throw new RuntimeWorkspaceError("Choose either a project or a runtime workspace");
    if (picksDirectory) nextProjectId = null;
    if (picksProject) nextRuntimeWorkspaceId = null;
    if (nextRuntimeWorkspaceId !== (current.runtimeWorkspaceId ?? null)) {
    new RuntimeWorkspacesRepo(this.ctx).assertIssueBindingChange(id, nextRuntimeWorkspaceId, nextWorkspaceId);
    } else if (nextRuntimeWorkspaceId && nextWorkspaceId !== current.workspaceId) {
    new RuntimeWorkspacesRepo(this.ctx).require(nextRuntimeWorkspaceId, nextWorkspaceId);
    }
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
    if (nextParentIssueId && hasAnyField(input, "parentIssueId", "parent_issue_id")) {
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

    const updatedAt = nowIso();
    // MUL-400 E3 gate 2: dependency and parent-grant guards are both decided
    // while the same Issue row lock is held.
    this.assertDependenciesMetForStatus(id, current, nextStatus, input, deferredEvents);
    forceStartAttempt = input.force === true
      && current.status === "backlog"
      && (nextStatus === "todo" || nextStatus === "in_progress");
    // MUL-400 E1 guard A, inside the Issue row lock: a parent with unfinished
    // children cannot be parked in review or closed, and only a member may
    // override. Runs before the write so a rejected request changes nothing.
    // Field-only edits are never status decisions, so the guard stays out of
    // their way even for a task identity.
    const statusChanged = nextStatus !== current.status;
    // MUL-400 E1 `holdParentStatus`: a system writer (the SCM merge effect) must
    // not decide a guarded parent transition, and must not fail either — it
    // records why the request was held and leaves the status to the human. The
    // hold replaces the guard rather than tripping it, and the write below is
    // skipped entirely, so nothing about the Issue moves.
    const holdParentStatus = options.holdParentStatus === true;
    if (holdParentStatus) {
      this.recordHeldParentStatus(id, requestedStatusForHold(input, nextStatus), options.holdParentStatusData ?? null, deferredEvents);
    } else if (parentStatusGuardEnabled() && statusChanged && !options.allowParentStatusGuardBypass) {
      this.assertParentStatusAllowed(id, current, nextStatus, {
        ...input,
        // Batch updates carry their member override in a server-only option; it
        // must not become a second dependency-gate bypass.
        force: input.force === true || options.parentStatusForce === true,
      });
    }
    const enteringTerminal = !isTerminalIssueStatus(current.status) && isTerminalIssueStatus(nextStatus);
    const leavingTerminal = isTerminalIssueStatus(current.status) && !isTerminalIssueStatus(nextStatus);
    const nextCompletedAt = enteringTerminal
      ? updatedAt
      : leavingTerminal
        ? null
        : current.completedAt;
    const nextArchivedAt = leavingTerminal ? null : current.archivedAt;
    // A held transition writes nothing at all: the request is audited as held
    // and the Issue keeps its current status.
    if (holdParentStatus) {
      return {
        issue: current,
        previous: current,
        cancelledTasks: 0,
        handledForcedStart: false,
        dependencyCheckEventId: null,
      };
    }
    // Read under the target's number lock taken above. The number and the
    // workspace change in one statement so the unique index never sees the
    // row with the old number in either workspace.
    const movedNumber = moving ? this.nextIssueNumber(nextWorkspaceId) : null;
    this.ctx.db.run(
      `UPDATE multiremi_issues SET
      title = ?,
      description = ?,
      status = ?,
      priority = ?,
      workspace_id = ?,
      issue_number = COALESCE(?, issue_number),
      issue_key = COALESCE(?, issue_key),
      project_id = ?,
      runtime_workspace_id = ?,
      parent_issue_id = ?,
      assignee_type = ?,
      assignee_id = ?,
      position = ?,
      start_date = ?,
      due_date = ?,
      acceptance_criteria = ?,
      context_refs = ?,
      completed_at = ?,
      archived_at = ?,
      updated_at = ?
     WHERE id = ?`,
    [
      input.title ?? current.title,
      input.description === undefined ? current.description : input.description,
      nextStatus,
      normalizeIssuePriority(input.priority ?? current.priority),
      nextWorkspaceId,
      movedNumber,
      movedNumber === null ? null : formatIssueKey(movedNumber),
      nextProjectId,
      nextRuntimeWorkspaceId,
      nextParentIssueId,
      nextAssigneeType,
      nextAssigneeId,
      input.position === undefined || input.position === null ? current.position : normalizeIssuePosition(input.position),
      nextStartDate,
      nextDueDate,
      toJson(nextAcceptanceCriteria),
      toJson(nextContextRefs),
      nextCompletedAt,
      nextArchivedAt,
      updatedAt,
      id,
      ],
    );
    if (moving) {
      this.ctx.db.run(
        `UPDATE multiremi_issue_workspaces
         SET workspace_id = ?, issue_key = ?, runtime_id = NULL, root_path = '', branch_name = '',
             repos = '[]', last_task_id = NULL, updated_at = ?
         WHERE issue_id = ? AND status = 'cleaned'`,
        [nextWorkspaceId, formatIssueKey(movedNumber!), updatedAt, id],
      );
    }
    if (hasAnyField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id")
      && !nextAssigneeType && !nextAssigneeId && current.assigneeId) {
      cancelledTasks = this.unassignIssueWithinTransaction(id, {
        actorType: input.actorType ?? "system",
        actorId: input.actorId ?? null,
        parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
      }, deferredEvents);
    }
    if (forceStartAttempt) {
      dispatchOutcome = this.startForcedIssueWithinTransaction({
        current,
        ownerType: nextAssigneeType,
        ownerId: nextAssigneeId,
        actorType: input.actorType ?? "member",
        actorId: input.actorId ?? null,
        parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
      }, collector, deferredEvents);
    }
    const next = this.getIssue(id)!;
    this.linkReferencedAttachmentsToIssue(id, next.description);
    if ((input.title !== undefined && input.title !== current.title)
      || (input.description !== undefined && (input.description ?? null) !== (current.description ?? null))) {
      this.syncIssueHeads(next, updatedAt);
    }
    const { event: statusEvent, dependencyCheckEventId } = this.ctx.autopilots().enqueueIssueStatusChangedEvent({
      issue: next,
      previousStatus: current.status,
      actorType: "system",
      actorId: null,
      automationSourceTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
    });
    // MUL-400 S1c (QA round 1): every audit row below commits with the status
    // write above. The events go on the caller's queue, so a rollback leaves
    // neither rows nor listeners behind.
    this.ctx.appendIssueActivity(id, {
      actorType: "system",
      actorId: null,
      type: "issue_updated",
      body: null,
      data: input,
    }, deferredEvents);
    if (dispatchOutcome?.skipped) {
      this.recordForcedStartSkipped(next, dispatchOutcome.skipped, input, deferredEvents);
    }
    // MUL-400 E1: a member override has to be auditable next to the write it
    // allowed, including the child count it overrode at the time.
    if (
      current.status !== next.status
      && (input.force === true || options.parentStatusForce === true)
      && statusNeedsChildGuard(next.status)
    ) {
      this.ctx.appendIssueActivity(id, {
        actorType: input.actorType ?? "member",
        actorId: input.actorId ?? null,
        type: "issue_status_forced",
        body: next.status,
        data: {
          status: next.status,
          previousStatus: current.status,
          previous_status: current.status,
          openChildren: this.countOpenChildIssues(id),
          open_children: this.countOpenChildIssues(id),
          ...sourceTaskActivityData(resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id")),
        },
      }, deferredEvents);
    }
    if (current.status !== "done" && next.status === "done" && input.actorType === "agent") {
      const grant = this.parentDoneGrantStatus(next);
      if (grant.effective && grant.agentId === input.actorId && this.hasChildIssues(id)) {
        this.ctx.appendIssueActivity(id, {
          actorType: "agent", actorId: input.actorId, type: "parent_done_grant_used",
          data: {
            source: options.parentDoneGrantSource ?? "api",
            agentId: grant.agentId,
            grantedBy: grant.grantedBy,
            grantedAt: grant.grantedAt,
            ...(options.parentDoneGrantData ?? {}),
          },
        }, deferredEvents);
      }
    }
    if (current.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [updatedAt, current.projectId]);
    if (next.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [updatedAt, next.projectId]);
    if (current.status !== "done" && next.status === "done") {
      this.ctx.knowledge().createIssueCompletionKnowledgeBundle(next);
    }
    this.notifyChildStatusChangeWithinTransaction(current, next,
      resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"), collector, deferredEvents,
      { statusChangeEventId: statusEvent?.id });
    return {
      issue: next,
      previous: current,
      cancelledTasks,
      handledForcedStart: forceStartAttempt,
      dependencyCheckEventId,
    };
  }

  /**
   * MUL-400 S1c: the post-COMMIT half of {@link updateIssueWithinTransaction}.
   *
   * Publishes the committed events, then runs the durable E3 automatic-start
   * replay. State, reports and pending turns were written by the owner above.
   */
  runIssueUpdatePostCommit(
    result: {
      issue: MultiremiIssue;
      previous: MultiremiIssue;
      cancelledTasks: number;
      handledForcedStart: boolean;
      dependencyCheckEventId: string | null;
    },
    input: UpdateIssueInput,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): void {
    const updated = result.issue;
    const previous = result.previous;
    // The write is durable: publish its audit rows (the `issue_updated` line,
    // the member force record, the grant-use row, a hold) before the hook runs.
    // The hook gets its OWN queue, so a hook failure cannot retroactively
    // publish events for rows its rolled-back transaction just erased.
    this.ctx.emitCommitEvents(deferredEvents);
    if (updated === previous) return;
    const hookEvents = createCommitEventQueue();
    // Reports already committed with the status. Automatic starts and the old
    // family's E1 re-derivation run after the originating locks are released.
    try {
      this.notifyChildStatusChange(
        previous,
        updated,
        resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
        collector,
        { dependencyCheckEventId: result.dependencyCheckEventId },
      );
      // Re-parenting retains MUL-471's post-commit E1 boundary for the old family.
      if (parentStatusGuardEnabled() && previous.parentIssueId && previous.parentIssueId !== updated.parentIssueId) {
        const oldParent = this.sameWorkspaceParent(previous);
        if (oldParent) this.ctx.db.transaction(() =>
          this.rederiveParentStatus(oldParent, updated, collector, hookEvents))();
      }
    } catch (err) {
      log.warn(
        `child status hook failed for ${updated.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    this.ctx.tasks().runCollectedChildStatusChanges(collector);
    this.ctx.emitCommitEvents(hookEvents);
  }

  /**
   * MUL-409 (QA round 4, blocker 1): the member's forced start is one
   * transaction.
   *
   * The status write, `dependency_force_started`, `issue_assigned` and the round
   * all commit together, so a process that dies between the status write and the
   * dispatch can no longer leave a `todo` with nothing queued — no automatic
   * path looks at `todo`, because both the gate and the automatic start only
   * scan `backlog`.
   *
   * Lock order matches `createTaskWithinTransaction`: the workspace row first
   * (taken here, inside the caller's transaction), then the Issue row, which
   * `updateIssueWithOutcome` already write-locked before calling in. Taking the
   * Issue lock first and the workspace lock second is what would deadlock a
   * concurrent `createTask`, so the order is not negotiable.
   *
   * Two outcomes, both durable inside this transaction:
   *   - a dispatchable owner gets the round, plus `issue_assigned` and (when the
   *     gate was genuinely still closed) `dependency_force_started`;
   *   - an owner that cannot run (none at all, a member, an archived assignee,
   *     a squad with no runnable agent) keeps the status change and records
   *     `dispatch_skipped`. That matches the previous behaviour: the member's
   *     request is honoured, the reason is visible, and nothing is rolled back.
   *
   * Any unexpected failure throws, so the caller's transaction rolls back to
   * `backlog` with no round and no force activity.
   */
  private startForcedIssueWithinTransaction(
    context: {
      current: MultiremiIssue;
      ownerType: MultiremiAssigneeType | null;
      ownerId: string | null;
      actorType: string;
      actorId: string | null;
      parentTaskId: string | null;
    },
    childStatusChanges: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): ForcedStartOutcome {
    const { current, ownerType, ownerId, actorType, actorId, parentTaskId } = context;
    // The caller took the workspace row lock before the Issue row (see
    // `updateIssueWithOutcome`), so `createTaskWithinTransaction` can take it
    // again inside this transaction without inverting the order.

    if (!ownerType || !ownerId) {
      return {
        skipped: {
          reason: "no_assignee",
          error: "Issue has no assignee",
        },
      };
    }
    if (ownerType === "member") {
      return {
        skipped: {
          reason: "member_assignee",
          error: "Member assignees do not run tasks",
        },
      };
    }

    const taskAgent = this.ctx.resolveRunnableAgentForAssignee(ownerType, ownerId);
    if (!taskAgent) {
      // Decided before any INSERT, so the skip and the status change commit
      // together and the issue is internally consistent.
      log.warn(`dependency force-start dispatch skipped for ${current.id}: no runnable agent for ${ownerType}:${ownerId}`);
      return {
        skipped: {
          reason: "no_runnable_agent",
          error: `No runnable agent for ${ownerType}: ${ownerId}`,
        },
      };
    }

    const task = this.ctx.tasks().createTaskWithinTransaction({
      agentId: taskAgent.id,
      issueId: current.id,
      workspaceId: current.workspaceId,
      prompt: current.title,
      parentTaskId,
    }, childStatusChanges, deferredEvents);
    deferredEvents.enqueuedTasks.push(task);
    this.ctx.appendIssueActivity(current.id, {
      actorType,
      actorId,
      type: "issue_assigned",
      body: `Queued ${taskAgent.name}`,
      data: {
        assigneeType: ownerType,
        assignee_type: ownerType,
        assigneeId: ownerId,
        assignee_id: ownerId,
        toType: ownerType,
        to_type: ownerType,
        toId: ownerId,
        to_id: ownerId,
        taskId: task.id,
        task_id: task.id,
        ...sourceTaskActivityData(parentTaskId),
        cancelled: 0,
      },
    }, deferredEvents);
    if (current.projectId) {
      this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [nowIso(), current.projectId]);
    }
    return { skipped: null };
  }

  /**
   * The `dispatch_skipped` row for a forced start that could not run. The owner
   * calls this before COMMIT so the status change and the reason cannot split.
   */
  private recordForcedStartSkipped(
    issue: MultiremiIssue,
    skipped: { reason: string; error: string },
    input: UpdateIssueInput,
    deferredEvents: CommitEventQueue,
  ): void {
    this.ctx.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "dispatch_skipped",
      body: skipped.error,
      data: {
        reason: skipped.reason,
        error: skipped.error,
        assigneeType: issue.assigneeType,
        assignee_type: issue.assigneeType,
        assigneeId: issue.assigneeId,
        assignee_id: issue.assigneeId,
        ...sourceTaskActivityData(resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id")),
      },
    }, deferredEvents);
  }

  /**
   * Mirror the Issue title and description into the head row of each of its
   * sessions. The rows are updated in place, so the seq axis does not shift and
   * a reader sees the new text through `revision` / `log_version`.
   */
  private syncIssueHeads(issue: MultiremiIssue, at?: string): void {
    const sessions = this.ctx.db.query(
      "SELECT id FROM multiremi_issue_sessions WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issue.id) as Row[];
    for (const session of sessions) {
      this.ctx.conversationLog().syncIssueHeadWithinTransaction(String(session.id), {
        title: issue.title,
        description: issue.description,
      }, at);
    }
  }

  restoreIssue(id: string): MultiremiIssue {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    if (!current.archivedAt && !current.completedAt) return current;
    this.ctx.db.run(
      "UPDATE multiremi_issues SET completed_at = NULL, archived_at = NULL WHERE id = ?",
      [id],
    );
    return this.getIssue(id)!;
  }

  archiveEligibleIssues(now: Date = new Date()): MultiremiIssue[] {
    const archived: MultiremiIssue[] = [];
    const archivedAt = now.toISOString();
    this.ctx.db.transaction(() => {
      for (const workspace of this.ctx.workspaces().listWorkspaces()) {
        const { ttlMs } = resolveIssueArchiveSettings(workspace.settings);
        const cutoff = new Date(now.getTime() - ttlMs).toISOString();
        const rows = this.ctx.db.query(
          `SELECT id FROM multiremi_issues
           WHERE workspace_id = ?
             AND archived_at IS NULL
             AND completed_at IS NOT NULL
             AND completed_at <= ?
             AND status IN ('done', 'cancelled')`,
        ).all(workspace.id, cutoff) as Row[];
        for (const row of rows) {
          const id = String(row.id);
          const result = this.ctx.db.run(
            `UPDATE multiremi_issues SET archived_at = ?
             WHERE id = ?
               AND archived_at IS NULL
               AND completed_at IS NOT NULL
               AND completed_at <= ?
               AND status IN ('done', 'cancelled')`,
            [archivedAt, id, cutoff],
          );
          if (result.changes !== 1) continue;
          const issue = this.getIssue(id);
          if (issue) archived.push(issue);
        }
      }
    })();
    for (const issue of archived) {
      this.ctx.emitWorkspaceEvent({
        type: "issue:updated",
        workspaceId: issue.workspaceId,
        actorType: "system",
        actorId: null,
        payload: {
          issue: {
            id: issue.id,
            completed_at: issue.completedAt,
            archived_at: issue.archivedAt,
          },
          status_changed: false,
        },
      });
    }
    return archived;
  }

  issueArchiveSweepIntervalMs(): number {
    const intervals = this.ctx.workspaces().listWorkspaces().map(
      (workspace) => resolveIssueArchiveSettings(workspace.settings).sweepIntervalMs,
    );
    return intervals.length > 0
      ? Math.min(...intervals)
      : resolveIssueArchiveSettings(null).sweepIntervalMs;
  }

  /** Post-commit E3 automatic starts; notification writes use the inline hook. */
  notifyChildStatusChange(
    previous: MultiremiIssue,
    issue: MultiremiIssue,
    parentTaskId: string | null,
    _collector: ChildStatusChangeCollector,
    options: {
      taskTerminalStatus?: "completed" | "failed" | "cancelled";
      dependencyCheckEventId?: string | null;
      seen?: Set<string>;
    } = {},
  ): void {
    // MUL-452's durable automatic-start replay remains post-commit. Reports
    // and pending turns have already committed with the originating write.
    if (!dependencyGateEnabled() || previous.status === issue.status || issue.status !== "done"
      || !options.dependencyCheckEventId) return;
    for (const dependent of this.listDependencyDependents(issue.id)) {
      if (dependent.status !== "backlog" || this.listUnmetPrerequisites(dependent.id).length
        || !dependent.assigneeId || !["agent", "squad"].includes(dependent.assigneeType ?? "")) continue;
      try {
        this.autoStartDependent(dependent, issue, parentTaskId, { dependencyCheckEventId: options.dependencyCheckEventId });
      } catch (error) {
        log.warn(`dependency auto-start failed for ${dependent.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  notifyChildStatusChangeWithinTransaction(
    previous: MultiremiIssue,
    issue: MultiremiIssue,
    parentTaskId: string | null,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
    options: { taskTerminalStatus?: "completed" | "failed" | "cancelled"; statusChangeEventId?: string | null } = {},
  ): void {
    if (!this.ctx.db.inTransaction) throw new Error("Child status notifications require an open transaction");
    const changed = previous.status !== issue.status;
    const eventId = options.statusChangeEventId ?? `${issue.id}:${previous.status}:${issue.status}:${parentTaskId ?? ""}`;
    const readinessLines: string[] = [];
    if (dependencyGateEnabled() && changed && ["done", "cancelled", "blocked", "failed"].includes(issue.status)) {
      for (const dependent of this.listDependencyDependents(issue.id)) {
        if (dependent.status !== "backlog") continue;
        const unmet = this.listUnmetPrerequisites(dependent.id);
        if (issue.status === "done" && unmet.length === 0) {
          if (dependent.assigneeId && ["agent", "squad"].includes(dependent.assigneeType ?? "")) continue;
          this.ctx.appendIssueActivity(dependent.id, {
            actorType: "system", actorId: SYSTEM_AUTHOR_ID, type: "dependency_satisfied", body: issue.key,
            data: { satisfiedBy: issue.id, satisfied_by: issue.id, satisfiedByKey: issue.key,
              satisfied_by_key: issue.key, assigneeType: dependent.assigneeType, assignee_type: dependent.assigneeType,
              assigneeId: dependent.assigneeId, assignee_id: dependent.assigneeId, autoStarted: false, auto_started: false },
          }, deferredEvents);
          const line = this.reportDependencyReady(dependent, issue, collector, deferredEvents, eventId);
          if (line) readinessLines.push(line);
        } else if (issue.status !== "done") {
          this.recordPrerequisiteFailure(dependent, issue, unmet, parentTaskId, collector, deferredEvents, eventId);
        }
      }
    }
    const parent = this.sameWorkspaceParent(issue);
    if (!parent) return;
    const reported = changed ? childTerminalOutcome(issue.status) : null;
    const outcome = reported === "blocked" && options.taskTerminalStatus === "failed" ? "failed" : reported;
    if (parent.status === "done" || parent.status === "cancelled") {
      if (outcome) this.recordChildStatusAfterParentClosed(parent, issue, outcome, deferredEvents);
      return;
    }
    if (outcome) this.notifyParentOfChildOutcome(parent, issue, outcome, parentTaskId,
      readinessLines, collector, deferredEvents, eventId);
    if (parentStatusGuardEnabled()) this.rederiveParentStatus(parent, issue, collector, deferredEvents);
  }

  /** Best-effort live update for a system comment that is already committed. */
  private broadcastSystemComment(issueId: string, comment: MultiremiIssueComment): void {
    try {
      // Plain read, no savepoint (Senior ruling cmt_96e1yqxgifms §2). B1's
      // bridge-failure classification is what lets this drop the wrapper: a
      // failed bridge reply no longer aborts the surrounding transaction, so
      // what reaches the catch below is a real SQL error.
      const workspaceId = this.ctx.issueWorkspaceId(issueId);
      if (!workspaceId) return;
      this.ctx.emitWorkspaceEvent({
        type: "comment:created",
        workspaceId,
        actorType: "system",
        actorId: SYSTEM_AUTHOR_ID,
        payload: { comment },
      });
    } catch (err) {
      log.warn(`comment:created broadcast skipped for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * MUL-400 E2: a child that ends while its parent is already `done`/`cancelled`.
   * The parent's status is settled and must not move, and nothing may be filed
   * against a closed parent — but the ending itself is still auditable.
   */
  private recordChildStatusAfterParentClosed(
    parent: MultiremiIssue,
    child: MultiremiIssue,
    outcome: ChildTerminalOutcome,
    deferredEvents: CommitEventQueue,
  ): void {
    this.ctx.appendIssueActivity(parent.id, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "child_status_after_parent_closed",
      body: `${child.key} ${outcome}`,
      data: {
        childIssueId: child.id,
        child_issue_id: child.id,
        childIssueKey: child.key,
        child_issue_key: child.key,
        childStatus: child.status,
        child_status: child.status,
        outcome,
        parentStatus: parent.status,
        parent_status: parent.status,
      },
    }, deferredEvents);
  }

  /**
   * MUL-400 E3 hook body.
   *
   * - The prerequisite reached `done`: every dependent still parked in
   *   `backlog` whose own prerequisites are now all satisfied starts itself when
   *   its owner is an agent or a squad, and is only reported when the owner is a
   *   human (or nobody). Idempotent by construction: a second `done` finds no
   *   `backlog` dependent left, and the gate inside `assignIssue` refuses a
   *   start that is not actually unblocked.
   * - The prerequisite ended `cancelled` or `blocked`: each dependent that is
   *   still waiting gets a `dependency_prerequisite_failed` record and the
   *   report that reaches its owner carries the three concrete ways out.
   */

  /**
   * MUL-400 E3 readiness report for a dependent that has no agent to start it.
   *
   * Returns a line for the shared-parent case (the caller folds it into the
   * prerequisite's E2 report, so the parent owner still gets one round); for
   * every other case the report is delivered here and `null` comes back. The
   * plan's wording is "the parent owner's next round", so an owner with no
   * queued round is not given a new one — only an existing one is extended.
   */
  private reportDependencyReady(
    dependent: MultiremiIssue,
    satisfiedBy: MultiremiIssue,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
    eventId: string,
  ): string | null {
    const parent = this.sameWorkspaceParent(dependent);
    const line = `${dependent.key}: all prerequisites are done (${satisfiedBy.key}); it has no agent owner, so assign one or move it to todo to run it.`;
    if (parent && parent.id === satisfiedBy.parentIssueId) {
      // Same parent as the prerequisite: the dependent already carries the
      // `dependency_satisfied` activity, and the line rides along in the
      // prerequisite's E2 report. No second comment and no round of its own.
      this.markDependencySatisfiedMerged(dependent, satisfiedBy, parent, deferredEvents);
      return line;
    }
    if (parent) {
      // A different parent (or a prerequisite with none): keep the report on
      // that parent as an activity and extend its owner's queued round if one
      // is already waiting.
      this.ctx.appendIssueActivity(parent.id, {
        actorType: "system",
        actorId: SYSTEM_AUTHOR_ID,
        type: "dependency_satisfied",
        body: dependent.key,
        data: {
          dependentIssueId: dependent.id,
          dependent_issue_id: dependent.id,
          dependentKey: dependent.key,
          dependent_key: dependent.key,
          satisfiedBy: satisfiedBy.id,
          satisfied_by: satisfiedBy.id,
          satisfiedByKey: satisfiedBy.key,
          satisfied_by_key: satisfiedBy.key,
        },
      }, deferredEvents);
      if (this.parentNotificationAgent(parent)) this.ctx.inbox().sendEnvelopeWithinTransaction({
        to: { role: "issue_owner", issueId: parent.id }, kind: "lifecycle", wake: "next_turn",
        dedupeKey: `dependency_ready:${eventId}:${dependent.id}`, body: line,
        source: { issueId: satisfiedBy.id },
      }, collector, deferredEvents);
      return null;
    }
    // No parent at all: the dependent's own owner (or its subscribers) hears
    // about it, exactly as before.
    for (const memberId of this.dependentReportRecipients(dependent)) {
      this.ctx.createInboxItem({
        issueId: dependent.id,
        memberId,
        type: "dependency_satisfied",
        title: `${dependent.key}: all prerequisites are done`,
        body: `${dependent.key} is ready to start.`,
        actorType: "system",
        actorId: null,
        details: {
          dependentIssueId: dependent.id,
          dependent_issue_id: dependent.id,
          satisfiedBy: satisfiedBy.id,
          satisfied_by: satisfiedBy.id,
        },
      });
    }
    return null;
  }

  /**
   * Record on the dependent that its readiness line was folded into the
   * prerequisite's report rather than delivered on its own. The activity type
   * stays `dependency_satisfied` (the report is still what the plan asks for);
   * the flag is what makes the merge auditable.
   */
  private markDependencySatisfiedMerged(
    dependent: MultiremiIssue,
    satisfiedBy: MultiremiIssue,
    parent: MultiremiIssue,
    deferredEvents: CommitEventQueue,
  ): void {
    this.ctx.appendIssueActivity(dependent.id, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "dependency_satisfied",
      body: satisfiedBy.key,
      data: {
        satisfiedBy: satisfiedBy.id,
        satisfied_by: satisfiedBy.id,
        satisfiedByKey: satisfiedBy.key,
        satisfied_by_key: satisfiedBy.key,
        parentIssueId: parent.id,
        parent_issue_id: parent.id,
        mergedIntoPrerequisiteReport: true,
        merged_into_prerequisite_report: true,
      },
    }, deferredEvents);
  }

  /**
   * MUL-400 E1: a guarded system writer asked to move a parent but will not
   * decide the transition itself. Record why and leave the status untouched.
   * `holdParentStatus` callers mark their own effect processed afterwards, so a
   * held merge is a settled outcome rather than something to retry.
   */
  private recordHeldParentStatus(
    issueId: string,
    requested: string,
    extra: Record<string, unknown> | null,
    deferredEvents: CommitEventQueue,
  ): void {
    const openChildren = this.countOpenChildIssues(issueId);
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "parent_status_held",
      body: "in_progress",
      data: {
        requested,
        openChildren,
        open_children: openChildren,
        status: "in_progress",
        reason: "children_open",
        ...(extra ?? {}),
      },
    }, deferredEvents);
  }

  /**
   * Extend the parent owner's already-queued round with one line. Nothing is
   * created when no round is waiting, and the guarded UPDATE means a round that
   * stopped being queued between the read and the write is simply left alone.
   */

  /**
   * The issues that wait on `issueId`, with the dependency row that links them,
   * read from the single stored direction. Rows stored as `blocks` relate the
   * same two issues the other way round, so they are included as well.
   */
  private listDependencyDependents(issueId: string): MultiremiIssue[] {
    const rows = this.ctx.db.query(
      `SELECT d.id, d.issue_id, d.depends_on_issue_id, d.type FROM multiremi_issue_dependencies d
       JOIN multiremi_issues a ON a.id = d.issue_id AND a.workspace_id = d.workspace_id
       JOIN multiremi_issues b ON b.id = d.depends_on_issue_id AND b.workspace_id = a.workspace_id
       WHERE (d.depends_on_issue_id = ? OR d.issue_id = ?) AND d.type IN ('blocked_by', 'blocks')
       ORDER BY d.created_at ASC, d.id ASC`,
    ).all(issueId, issueId) as Row[];
    const seen = new Set<string>();
    const dependents: MultiremiIssue[] = [];
    for (const row of rows) {
      const storedIssueId = String(row.issue_id);
      const storedDependsOnId = String(row.depends_on_issue_id);
      // For `blocked_by` the dependent is `issue_id`; for the reversed `blocks`
      // row the dependent is the other column.
      const dependentId = String(row.type) === "blocks" ? storedDependsOnId : storedIssueId;
      if (dependentId === issueId) continue;
      if (seen.has(dependentId)) continue;
      const dependent = this.getIssue(dependentId);
      if (!dependent) continue;
      seen.add(dependentId);
      dependents.push(dependent);
    }
    return dependents;
  }

  /** Recover only E3 automatic starts; notifications commit with their source status. */
  replayDependencyAutoStart(event: MultiremiSystemEvent): void {
    if (!dependencyGateEnabled()) return;
    const prerequisite = this.getIssue(event.resourceId);
    if (!prerequisite || prerequisite.status !== "done") return;
    for (const dependent of this.listDependencyDependents(prerequisite.id)) {
      if (dependent.status !== "backlog" || this.listUnmetPrerequisites(dependent.id).length > 0) continue;
      if (!dependent.assigneeId || (dependent.assigneeType !== "agent" && dependent.assigneeType !== "squad")) continue;
      this.autoStartDependent(dependent, prerequisite, cleanOptionalString(event.payload.automation_source_task_id), {
        dependencyCheckEventId: event.id,
        replayed: true,
      });
    }
  }

  /**
   * MUL-400 E3 automatic start. The dependent becomes a real `todo` with a
   * queued round for its owner. The waiting predicate is rechecked while
   * holding the workspace and issue row locks.
   */
  private autoStartDependent(
    dependent: MultiremiIssue,
    satisfiedBy: MultiremiIssue,
    parentTaskId: string | null,
    options: { dependencyCheckEventId: string; replayed?: boolean },
  ): string | null {
    const ownerType = dependent.assigneeType;
    if (!ownerType || !dependent.assigneeId || ownerType === "member") return null;
    // MUL-400 E3 (QA round 3, blockers 1+2): the claim, the status write and the
    // round are ONE transaction. The previous shape committed
    // `backlog -> todo` first and only then called `assignIssue`, which left two
    // durable holes: a process that died in between stranded the issue at `todo`
    // with no round and no path back, and a failure *after* the round was
    // inserted "released" it into `backlog` while the round was still queued.
    //
    // Lock order — this is the order the rest of the codebase uses, and it is
    // required to avoid deadlocking a writer that holds the workspace lock and
    // is waiting for this Issue row:
    //   1. `multiremi_workspaces` row (`lockWorkspaceRuntimeLifecycle`), the same
    //      lock `createTaskWithinTransaction` takes for task creation;
    //   2. `multiremi_issues` row for the dependent, through the conditional
    //      UPDATE below.
    // `createTaskWithinTransaction` is called while both are held, and it takes
    // the workspace lock itself — re-entrant here because we already own it and
    // no other writer can be between them.
    //
    // Arbitration stays the conditional UPDATE: only the transaction that flips
    // `backlog -> todo` runs the dispatch, so a second prerequisite completing
    // concurrently, or a member's forced start, cannot queue a second round.
    // Captured after the member/no-owner guard above: the closure cannot rely on
    // property narrowing, and this id is what every write in it uses.
    const ownerId = dependent.assigneeId;
    // S1's commit-time queue: the round's wakeup and the realtime status event
    // must not reach a client until the COMMIT that made them true. The queue is
    // drained by `ctx.emitCommitEvents` after the transaction below.
    const deferredEvents: CommitEventQueue = createCommitEventQueue();
    const nested: ChildStatusChangeCollector = [];
    const outcome = this.ctx.db.transaction((): { task: MultiremiTask | null; dispatched: boolean } | null => {
        this.ctx.lockWorkspaceRuntimeLifecycle(dependent.workspaceId);
        if (this.ctx.db instanceof PostgresSyncDatabase) {
          this.ctx.db.query("SELECT id FROM multiremi_issues WHERE id = ? FOR UPDATE").get(dependent.id);
        }
        const current = this.getIssue(dependent.id);
        if (!current || current.status !== "backlog") return null;
        if (this.listUnmetPrerequisites(dependent.id).length > 0) return null;
        // A structurally exempt active round means this issue is not eligible
        // for an automatic claim. Its own start will derive `in_progress`.
        const existingRound = this.ctx.tasks().listTasksForIssue(dependent.id)
          .find((task) => isActiveTaskStatus(task.status));
        if (existingRound) return null;
        const skipped = this.ctx.db.query(
          `SELECT 1 FROM multiremi_issue_activity
           WHERE issue_id = ? AND type = 'dependency_auto_start_skipped'
             AND data LIKE ? ESCAPE '\\' LIMIT 1`,
        ).get(dependent.id, `%"dependency_check_event_id":"${escapeDependencyCheckEventIdForLike(options.dependencyCheckEventId)}"%`);
        if (skipped) return null;
        const taskAgent = this.ctx.resolveRunnableAgentForAssignee(ownerType, ownerId);
        if (!taskAgent) {
          const message = `No runnable agent for ${ownerType}: ${ownerId}`;
          this.ctx.appendIssueActivity(dependent.id, {
            actorType: "system",
            actorId: SYSTEM_AUTHOR_ID,
            type: "dependency_auto_start_skipped",
            body: message,
            data: {
              satisfiedBy: satisfiedBy.id,
              satisfied_by: satisfiedBy.id,
              satisfiedByKey: satisfiedBy.key,
              satisfied_by_key: satisfiedBy.key,
              reason: "dispatch_failed",
              error: message,
              dependencyCheckEventId: options.dependencyCheckEventId,
              dependency_check_event_id: options.dependencyCheckEventId,
            },
          }, deferredEvents);
          return { task: null, dispatched: false };
        }
        const flipped = this.ctx.db.run(
          `UPDATE multiremi_issues
           SET status = 'todo', completed_at = NULL, archived_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'backlog'`,
          [nowIso(), dependent.id],
        );
        if (flipped.changes !== 1) return null;
        // Required parent reports share this transaction; automatic-start replay
        // is collected for after COMMIT.
        const task = this.ctx.tasks().createTaskWithinTransaction({
          agentId: taskAgent.id,
          issueId: dependent.id,
          workspaceId: current.workspaceId,
          prompt: current.title,
          parentTaskId,
        }, nested, deferredEvents);
        deferredEvents.enqueuedTasks.push(task);
        this.ctx.appendIssueActivity(dependent.id, {
          actorType: "system",
          actorId: SYSTEM_AUTHOR_ID,
          type: "issue_assigned",
          body: `Queued ${taskAgent.name}`,
          data: {
            assigneeType: ownerType,
            assignee_type: ownerType,
            assigneeId: ownerId,
            assignee_id: ownerId,
            toType: ownerType,
            to_type: ownerType,
            toId: ownerId,
            to_id: ownerId,
            taskId: task.id,
            task_id: task.id,
            ...sourceTaskActivityData(parentTaskId),
            cancelled: 0,
          },
        }, deferredEvents);
        this.ctx.appendIssueActivity(dependent.id, {
          actorType: "system",
          actorId: SYSTEM_AUTHOR_ID,
          type: "dependency_auto_started",
          body: satisfiedBy.key,
          data: {
            satisfiedBy: satisfiedBy.id,
            satisfied_by: satisfiedBy.id,
            satisfiedByKey: satisfiedBy.key,
            satisfied_by_key: satisfiedBy.key,
            autoStarted: true,
            auto_started: true,
            dependencyCheckEventId: options.dependencyCheckEventId,
            dependency_check_event_id: options.dependencyCheckEventId,
            ...(options.replayed ? { replayed: true } : {}),
            taskId: task.id,
            task_id: task.id,
            ...sourceTaskActivityData(parentTaskId),
          },
        }, deferredEvents);
        if (current.projectId) {
          this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [nowIso(), current.projectId]);
        }
        return { task, dispatched: true };
    })();
    if (!outcome) return null;
    if (!outcome.dispatched) {
      this.ctx.emitCommitEvents(deferredEvents);
      return null;
    }
    // Post-commit only: the wakeup listener and the realtime status event both
    // describe committed state. A crash between COMMIT and here therefore loses
    // only the live notification — a client that refreshes reads `todo` with its
    // queued round, and the claim is already durable.
    const started = this.getIssue(dependent.id);
    if (started) {
      this.ctx.autopilots().enqueueIssueStatusChangedEvent({
        issue: started,
        previousStatus: "backlog",
        actorType: "system",
        actorId: null,
        automationSourceTaskId: outcome.task?.id ?? null,
      });
      // Blocker 4: the frontend only re-buckets an issue from `issue:updated`
      // (frontend/packages/core/realtime/sync/issues.ts). Without it an open
      // list/detail keeps rendering the pre-start status. It rides the same
      // commit-time queue as the wakeup, so a rollback can never emit it.
      deferredEvents.workspace.push({
        type: "issue:updated",
        workspaceId: started.workspaceId,
        actorType: "system",
        actorId: null,
        payload: {
          issue: {
            id: started.id,
            status: started.status,
            completed_at: null,
            archived_at: null,
            updated_at: started.updatedAt,
          },
          status_changed: true,
          prev_status: "backlog",
        },
      });
    }
    // Everything here describes committed state.
    this.ctx.emitCommitEvents(deferredEvents);
    this.ctx.tasks().runCollectedChildStatusChanges(nested);
    return null;
  }

  /**
   * MUL-400 E3 prerequisite failure. The dependent stays parked (only a human
   * can decide between re-planning, cancelling and dropping the dependency),
   * so the record is the deliverable: it names the dead prerequisite and the
   * three concrete commands.
   */
  private recordPrerequisiteFailure(
    dependent: MultiremiIssue,
    prerequisite: MultiremiIssue,
    unmet: IssueDependencyUnmetRef[],
    parentTaskId: string | null,
    nested: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
    eventId: string,
  ): void {
    const row = unmet.find((candidate) => candidate.dependsOnIssueId === prerequisite.id);
    const dependencyId = row?.dependencyId ?? "";
    const commands = dependencyFailureCommands({
      dependentKey: dependent.key,
      prerequisiteKey: prerequisite.key,
      dependencyId,
    });
    this.ctx.appendIssueActivity(dependent.id, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "dependency_prerequisite_failed",
      body: prerequisite.key,
      data: {
        prerequisiteIssueId: prerequisite.id,
        prerequisite_issue_id: prerequisite.id,
        prerequisiteKey: prerequisite.key,
        prerequisite_key: prerequisite.key,
        prerequisiteStatus: prerequisite.status,
        prerequisite_status: prerequisite.status,
        dependencyId,
        dependency_id: dependencyId,
        commands,
        ...sourceTaskActivityData(parentTaskId),
      },
    }, deferredEvents);
    this.reportPrerequisiteFailureToOwner(dependent, prerequisite, commands, nested, deferredEvents, eventId);
  }

  /**
   * Failing prerequisites are exactly the case the parent owner must act on, so
   * the report lands in the same place as every other child outcome: the
   * parent's round for an agent/squad owner, the owner's inbox for a member,
   * and the dependent's own subscribers when the human fan-out has nobody to
   * reach.
   */
  private reportPrerequisiteFailureToOwner(
    dependent: MultiremiIssue,
    prerequisite: MultiremiIssue,
    commands: string[],
    nested: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
    eventId: string,
  ): void {
    const parent = this.sameWorkspaceParent(dependent);
    const summary = `${dependent.key}: ${prerequisite.key} ${prerequisiteStatusSentence(prerequisite.status)}`;
    const details = {
      prerequisiteIssueId: prerequisite.id,
      prerequisite_issue_id: prerequisite.id,
      prerequisiteKey: prerequisite.key,
      prerequisite_key: prerequisite.key,
      dependentIssueId: dependent.id,
      dependent_issue_id: dependent.id,
      commands,
    };
    if (parent) {
      const body = [
        `Prerequisite [${prerequisite.key}](mention://issue/${prerequisite.id}) for ${dependent.key} ${prerequisiteStatusSentence(prerequisite.status)}.`,
        `${dependent.key} stays in backlog until a human decides.`,
        ...commands.map((command) => `- ${command}`),
      ].join("\n");
      if (this.parentNotificationAgent(parent)) {
        this.ctx.inbox().sendEnvelopeWithinTransaction({
          to: { role: "issue_owner", issueId: parent.id }, kind: "report", wake: "now",
          outcome: prerequisite.status === "cancelled" ? "cancelled" : "failed",
          dedupeKey: `dependency_failed:${eventId}:${dependent.id}`, body,
          source: { issueId: prerequisite.id },
        }, nested, deferredEvents);
      } else {
        const comment = this.createSystemIssueCommentWithinTransaction(parent.id, body, {
          type: "dependency_prerequisite_failed", ...details,
        }, deferredEvents);
        if (parent.assigneeType !== "member") this.recordChildDoneParentSkipped(parent, comment,
          !parent.assigneeId ? "no_assignee" : parent.assigneeType === "squad" ? "squad_leader_unavailable" : "agent_unavailable",
          { outcome: "failed" }, deferredEvents);
      }
      return;
    }
    for (const memberId of this.dependentReportRecipients(dependent)) {
      this.ctx.createInboxItem({
        issueId: dependent.id,
        memberId,
        type: "dependency_prerequisite_failed",
        title: summary,
        body: `${dependent.key} is parked in backlog. ${commands[0]}`,
        actorType: "system",
        actorId: null,
        details,
      });
    }
  }

  /**
   * The human recipients of a dependent's report: its member owner when it has
   * one, otherwise its subscribers. Severity stays with `INBOX_ROUTING`.
   */
  private dependentReportRecipients(dependent: MultiremiIssue): string[] {
    const recipients = dependent.assigneeType === "member" && dependent.assigneeId
      ? [dependent.assigneeId]
      : this.listIssueSubscribers(dependent.id)
        .filter((subscriber) => subscriber.userType === "member")
        .map((subscriber) => subscriber.userId);
    return [...new Set(recipients)];
  }

  /**
   * MUL-400 E1 guard B. The task-terminal path derives `in_review` (a finished
   * round) or `done` (an intake issue with generated children) for the Issue the
   * task ran on; when that Issue is itself a parent with unfinished children it
   * must stay `in_progress` instead. Returns the status to write, and records
   * `parent_status_held` when it overrode the request.
   *
   * Deliberately not applied to `createTaskHumanRequest`: while an owner is
   * waiting for an answer the Issue legitimately parks at `in_review`, and the
   * resume path puts it back.
   */
  holdParentStatusForOpenChildren(
    issueId: string,
    requested: string,
    options: { exempt?: boolean; deferredEvents: CommitEventQueue },
  ): string {
    if (options.exempt) return requested;
    if (!parentStatusGuardEnabled()) return requested;
    if (!statusNeedsChildGuard(requested)) return requested;
    const issue = this.getIssue(issueId);
    if (!issue) return requested;
    // A settled Issue is a human decision that the task path must not reopen.
    // Bailing out before the audit write also keeps `done`/`cancelled` parents
    // free of `parent_status_held` noise for a transition that never happened.
    if (issue.status === "done" || issue.status === "cancelled") return requested;
    const openChildren = this.countOpenChildIssues(issueId);
    if (openChildren === 0) return requested;
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "parent_status_held",
      body: "in_progress",
      data: {
        requested,
        openChildren,
        open_children: openChildren,
        status: "in_progress",
      },
    }, options.deferredEvents);
    return "in_progress";
  }

  /**
   * MUL-400 E1 re-derivation: a parent parked at `in_review` whose children are
   * still open goes back to `in_progress`. Deliberately narrow — `done` and
   * `cancelled` parents never move, and any other parent status is left alone so
   * this hook cannot fight a human editing the parent concurrently.
   */
  private rederiveParentStatus(
    parent: MultiremiIssue,
    child: MultiremiIssue,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): void {
    if (parent.status !== "in_review") return;
    // No parent row lock before counting (MUL-471). The conditional UPDATE below
    // takes that lock and re-checks `in_review` after any wait, so a concurrent
    // parent decision turns it into a no-op. A child added or reopened after
    // this count is a child event of its own, and closing a child never takes
    // the lock, so an earlier lock would not make the count below any more
    // current.
    const openChildren = this.countOpenChildIssues(parent.id);
    if (openChildren === 0) return;
    const now = nowIso();
    const updated = this.ctx.db.run(
      `UPDATE multiremi_issues
       SET status = 'in_progress', completed_at = NULL, archived_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'in_review'`,
      [now, parent.id],
    );
    if (updated.changes === 0) return;
    this.ctx.appendIssueActivity(parent.id, {
      actorType: "system",
      actorId: null,
      type: "parent_status_derived",
      body: "in_progress",
      data: {
        status: "in_progress",
        previousStatus: "in_review",
        previous_status: "in_review",
        openChildren,
        open_children: openChildren,
        childIssueId: child.id,
        child_issue_id: child.id,
        childStatus: child.status,
        child_status: child.status,
      },
    }, deferredEvents);
    const { event: statusEvent } = this.ctx.autopilots().enqueueIssueStatusChangedEvent({
      issue: this.getIssue(parent.id) ?? parent,
      previousStatus: "in_review",
      actorType: "system",
      actorId: null,
    });
    // Same rule as the comment push: this runs inside a caller-owned
    // transaction, so the realtime patch goes on the owner's queue and is only
    // published once that transaction commits.
    deferredEvents.workspace.push({
      type: "issue:updated",
      workspaceId: parent.workspaceId,
      actorType: "system",
      actorId: null,
      payload: {
        issue: { id: parent.id, status: "in_progress", completed_at: null, archived_at: null, updated_at: now },
        status_changed: true,
        prev_status: "in_review",
      },
    } satisfies WorkspaceEvent);
    // The grandparent's required report uses the same transaction.
    const nextParent = this.getIssue(parent.id) ?? { ...parent, status: "in_progress", completedAt: null, archivedAt: null };
    this.notifyChildStatusChangeWithinTransaction(parent, nextParent, null, collector, deferredEvents,
      { statusChangeEventId: statusEvent?.id });
    collector.push({
      previous: { ...parent, status: "in_review" },
      issue: nextParent,
      taskId: `rederive:${child.id}:${parent.id}`,
    });
  }

  /** Write the parent's report and wake atomically; publish through the owner's queue. */
  private notifyParentOfChildOutcome(
    parent: MultiremiIssue,
    child: MultiremiIssue,
    outcome: ChildTerminalOutcome,
    parentTaskId: string | null,
    readinessLines: string[],
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
    eventId: string,
  ): void {
    if (parent.assigneeType === "member" && parent.assigneeId) {
      this.notifyParentMemberOfChildOutcome(parent, child, outcome);
      return;
    }
    if (!parent.assigneeType || !parent.assigneeId) {
      const comment = this.notifyParentSubscribersOfChildOutcome(parent, child, outcome, deferredEvents);
      this.broadcastSystemComment(parent.id, comment);
      return;
    }
    const body = childStatusSystemCommentBody({
      mentionPrefix: this.parentAssigneeMentionPrefix(parent), childKey: child.key, childId: child.id,
      childTitle: child.title, outcome, childStatus: child.status, readinessLines,
    });
    const issueSessionId = this.childDoneReturnSessionId(parent.id, parentTaskId);
    const agent = this.parentNotificationAgent(parent);
    if (!agent) {
      const comment = this.createSystemIssueCommentWithinTransaction(parent.id, body, {
        type: "child_status_parent_notification", childIssueId: child.id, child_issue_id: child.id,
        outcome, childStatus: child.status, child_status: child.status,
      }, deferredEvents, null, issueSessionId);
      this.recordChildDoneParentSkipped(parent, comment,
        parent.assigneeType === "squad" ? "squad_leader_unavailable" : "agent_unavailable", { outcome }, deferredEvents);
      this.broadcastSystemComment(parent.id, comment);
      return;
    }
    const to: Envelope["to"] = issueSessionId
      ? { role: "agent", agentId: agent.id, issueSessionId }
      : { role: "parent_owner", childIssueId: child.id };
    const delivered = this.ctx.inbox().sendEnvelopeWithinTransaction({
      to, kind: "report", wake: "now", outcome, dedupeKey: `child_status:${eventId}`, body,
      source: { issueId: child.id, taskId: parentTaskId ?? undefined },
    }, collector, deferredEvents)[0]!;
    if (delivered.action === "created") this.ctx.appendIssueActivity(parent.id, {
      actorType: "system", actorId: SYSTEM_AUTHOR_ID, type: "child_done_parent_triggered",
      body: `Queued ${agent.name}`, data: { commentId: delivered.entry.id, comment_id: delivered.entry.id,
        outcome, assigneeType: parent.assigneeType, assignee_type: parent.assigneeType,
        assigneeId: parent.assigneeId, assignee_id: parent.assigneeId, agentId: agent.id,
        agent_id: agent.id, taskId: delivered.task!.id, task_id: delivered.task!.id },
    }, deferredEvents);
  }

  private parentNotificationAgent(parent: MultiremiIssue): MultiremiAgent | null {
    let id: string | null = parent.assigneeType === "agent" ? parent.assigneeId : null;
    if (parent.assigneeType === "squad" && parent.assigneeId) {
      const squad = this.ctx.squads().getSquad(parent.assigneeId);
      if (!squad || squad.archivedAt || squad.workspaceId !== parent.workspaceId) return null;
      id = squad.leaderId;
    }
    const agent = id ? this.ctx.agents().getAgent(id) : null;
    return agent && !agent.archivedAt && agent.workspaceId === parent.workspaceId ? agent : null;
  }

  /** MUL-400 E2: a human-owned parent hears about every child terminal state. */
  private notifyParentMemberOfChildOutcome(
    parent: MultiremiIssue,
    child: MultiremiIssue,
    outcome: ChildTerminalOutcome,
  ): void {
    const actor = this.ctx.agents().getAgent(child.assigneeId ?? "");
    this.ctx.createInboxItem({
      issueId: parent.id,
      memberId: parent.assigneeId!,
      type: "child_issue_terminal",
      severity: outcome === "failed" || outcome === "blocked" ? "warning" : "info",
      title: `${parent.key}: ${child.key} ${childOutcomeLabel(outcome)}`,
      body: childStatusInboxBody(child, outcome),
      actorType: actor ? "agent" : "system",
      actorId: actor?.id ?? null,
      details: {
        childIssueId: child.id,
        child_issue_id: child.id,
        childIssueKey: child.key,
        child_issue_key: child.key,
        childStatus: child.status,
        child_status: child.status,
        outcome,
      },
    });
  }

  /**
   * No assignee to wake. Keep the historic system comment and skip record, and
   * additionally reach the parent's subscribers so a child failure is not lost
   * just because nobody owns the parent yet.
   */
  private notifyParentSubscribersOfChildOutcome(
    parent: MultiremiIssue,
    child: MultiremiIssue,
    outcome: ChildTerminalOutcome,
    deferredEvents: CommitEventQueue,
  ): MultiremiIssueComment {
    const comment = this.createSystemIssueCommentWithinTransaction(parent.id, childStatusSystemCommentBody({
      mentionPrefix: "",
      childKey: child.key,
      childId: child.id,
      childTitle: child.title,
      outcome,
      childStatus: child.status,
      readinessLines: [],
    }), {
      type: "child_status_parent_notification",
      childIssueId: child.id,
      child_issue_id: child.id,
      outcome,
      childStatus: child.status,
      child_status: child.status,
    }, deferredEvents);
    this.recordChildDoneParentSkipped(parent, comment, "no_assignee", { outcome }, deferredEvents);
    for (const subscriber of this.listIssueSubscribers(parent.id)) {
      if (subscriber.userType !== "member") continue;
      this.ctx.createInboxItem({
        issueId: parent.id,
        memberId: subscriber.userId,
        type: "child_issue_terminal",
        severity: outcome === "failed" || outcome === "blocked" ? "warning" : "info",
        title: `${parent.key}: ${child.key} ${childOutcomeLabel(outcome)}`,
        body: childStatusInboxBody(child, outcome),
        actorType: "system",
        actorId: null,
        details: {
          childIssueId: child.id,
          child_issue_id: child.id,
          childIssueKey: child.key,
          child_issue_key: child.key,
          childStatus: child.status,
          child_status: child.status,
          outcome,
          noAssignee: true,
          no_assignee: true,
        },
      });
    }
    return comment;
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

  createTaskFailureSystemComment(
    issueId: string,
    issueSessionId: string | null,
    taskId: string,
    body: string,
  ): MultiremiIssueComment {
    return this.createSystemIssueComment(issueId, body, {
      type: "task_failure",
      taskId,
      task_id: taskId,
      sourceTaskId: taskId,
      source_task_id: taskId,
    }, taskId, issueSessionId);
  }

  /**
   * MUL-400 E1/E2 atomicity: the comment row and its Session event are one unit,
   * so this wrapper owns the transaction when the caller has none (see
   * {@link createSystemIssueCommentWithinTransaction}).
   */
  private createSystemIssueComment(
    issueId: string,
    body: string,
    data: Record<string, unknown>,
    taskId: string | null = null,
    issueSessionId: string | null = null,
  ): MultiremiIssueComment {
    // Join a caller-owned transaction without adding a frame; both forms own
    // a queue whose publication waits for the outermost COMMIT.
    const deferredEvents = createCommitEventQueue();
    const write = () => this.createSystemIssueCommentWithinTransaction(issueId, body, data, deferredEvents, taskId, issueSessionId);
    const comment = this.ctx.db.inTransaction ? write() : this.ctx.db.transaction(write)();
    // Same live-update contract as createIssueComment — system comments are
    // store-internal and never pass through the HTTP layer. Best-effort, and
    // only after the row is committed.
    this.ctx.emitCommitEvents(deferredEvents);
    this.broadcastSystemComment(issueId, comment);
    return comment;
  }

  /**
   * Caller already owns a transaction (the E2 hook runs inside the round's
   * transaction). The comment, its Session event and its activity commit with
   * the caller's transaction: the Session event uses the `WithinTransaction`
   * append (the standalone one would only add a SAVEPOINT since B1, MUL-426),
   * and the activity's realtime push waits on the caller's queue.
   */
  createSystemIssueCommentWithinTransaction(
    issueId: string,
    body: string,
    data: Record<string, unknown>,
    deferredEvents: CommitEventQueue,
    taskId: string | null = null,
    issueSessionId: string | null = null,
    entryId?: string,
  ): MultiremiIssueComment {
    const id = entryId ?? createId("cmt");
    const now = nowIso();
    const issueSession = issueSessionId
      ? this.ctx.issueSessions().getIssueSession(issueSessionId)
      : this.ctx.issueSessions().getOrCreateDefaultIssueSession(issueId);
    if (!issueSession || issueSession.issueId !== issueId) {
      throw new Error(`Issue session not found for system comment: ${issueSessionId}`);
    }
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_comments (
         id, issue_id, issue_session_id, author_type, author_id, task_id, parent_id, body, type, created_at, updated_at
       ) VALUES (?, ?, ?, 'system', ?, ?, NULL, ?, 'system', ?, ?)`,
      [id, issueId, issueSession.id, SYSTEM_AUTHOR_ID, taskId, body, now, now],
    );
    this.ctx.issueSessions().appendSessionEventWithinTransaction(issueSession.id, {
      authorType: "system",
      authorId: SYSTEM_AUTHOR_ID,
      kind: "system",
      body,
      sourceCommentId: id,
      metadata: data,
      createdAt: now,
    });
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    // Caller-owned transaction: the activity row commits with it, so its
    // realtime push waits on the caller's queue.
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "comment_created",
      body,
      data: { commentId: id, comment_id: id, ...data },
    }, deferredEvents);
    return this.getIssueComment(id)!;
  }

  private childDoneReturnSessionId(parentIssueId: string, triggeringTaskId: string | null): string {
    const triggering = triggeringTaskId ? this.ctx.tasks().getTask(triggeringTaskId) : null;
    const delegatedSessionId = triggering?.delegatedFromIssueSessionId;
    const delegatedSession = delegatedSessionId
      ? this.ctx.issueSessions().getIssueSession(delegatedSessionId) : null;
    return delegatedSession?.issueId === parentIssueId
      ? delegatedSession.id
      // Both callers are `WithinTransaction` flavours owned by the child-status
      // transaction, so ask for the within-transaction flavour explicitly
      // instead of letting the public entry point add a nested frame
      // (Senior ruling cmt_96e1yqxgifms §2).
      : this.ctx.issueSessions().getOrCreateDefaultIssueSessionWithinTransaction(parentIssueId, null).id;
  }

  private recordChildDoneParentSkipped(
    parent: MultiremiIssue,
    systemComment: MultiremiIssueComment,
    reason: "no_assignee" | "agent_unavailable" | "squad_leader_unavailable",
    details: Record<string, unknown>,
    deferredEvents: CommitEventQueue,
  ): void {
    this.ctx.appendIssueActivity(parent.id, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "child_done_parent_skipped",
      body: `Child-done parent wakeup skipped: ${reason}`,
      data: {
        reason,
        commentId: systemComment.id,
        comment_id: systemComment.id,
        assigneeType: parent.assigneeType,
        assignee_type: parent.assigneeType,
        assigneeId: parent.assigneeId,
        assignee_id: parent.assigneeId,
        ...details,
      },
    }, deferredEvents);
  }

  private unassignIssueWithinTransaction(id: string, input: {
    actorType: string;
    actorId: string | null;
    parentTaskId?: string | null;
  }, deferredEvents: CommitEventQueue): number {
    const cancelled = this.cancelActiveIssueTasks(id, "issue_unassigned", deferredEvents);
    this.ctx.db.run(
      "UPDATE multiremi_issues SET assignee_type = NULL, assignee_id = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), id],
    );
    this.ctx.appendIssueActivity(id, {
      actorType: input.actorType,
      actorId: input.actorId,
      type: "issue_unassigned",
      body: null,
      data: { cancelled, ...sourceTaskActivityData(input.parentTaskId) },
    }, deferredEvents);
    return cancelled;
  }

  assignIssue(id: string, input: AssignIssueInput, options: AssignIssueOptions = {}): AssignIssueResult {
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
      const deferredEvents = createCommitEventQueue();
      const cancelledTasks = this.ctx.db.transaction(() => this.unassignIssueWithinTransaction(id, {
        actorType,
        actorId,
        parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
      }, deferredEvents))();
      this.ctx.emitCommitEvents(deferredEvents);
      return { issue: this.getIssue(id)!, task: null, cancelledTasks };
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
    // MUL-400 E3 gate 1. Every "start this issue" call funnels through here, so
    // this is where an unmet prerequisite stops one: the owner is recorded and
    // the skip is visible, but the status and the task queue stay untouched.
    // Server-internal only: a request body can never set this (see
    // AssignIssueOptions), so an override is always paired with the member-only
    // status write that recorded `dependency_force_started`.
    const forcedDispatch = options.force === true;
    const unmetDependencies = this.dependenciesBlockDispatch(current, forcedDispatch);
    if (unmetDependencies) {
      this.ctx.db.run(
        "UPDATE multiremi_issues SET assignee_type = ?, assignee_id = ?, updated_at = ? WHERE id = ?",
        [assigneeType, assigneeId, now, id],
      );
      if (assigneeType === "member") {
        // A human owner is told about the assignment even though the work is
        // held: otherwise the issue looks unassigned on every surface.
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
        body: null,
        data: {
          assigneeType,
          assignee_type: assigneeType,
          assigneeId,
          assignee_id: assigneeId,
          toType: assigneeType,
          to_type: assigneeType,
          toId: assigneeId,
          to_id: assigneeId,
          taskId: null,
          task_id: null,
          deferred: true,
          ...sourceTaskActivityData(resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id")),
          cancelled: 0,
        },
      });
      this.recordDependencyDispatchSkipped(
        { ...current, assigneeType, assigneeId },
        unmetDependencies,
        { actorType, actorId, parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id") },
      );
      if (current.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
      return { issue: this.getIssue(id)!, task: null, cancelledTasks: 0 };
    }
    const deferredEvents = createCommitEventQueue();
    const cancelled = this.cancelActiveIssueTasks(id, "issue_reassigned", deferredEvents);
    this.ctx.emitCommitEvents(deferredEvents);
    const writeAssignment = (assignmentChanges: ChildStatusChangeCollector, assignmentEvents: CommitEventQueue) => {
      if (taskAgent) this.ctx.lockWorkspaceRuntimeLifecycle(current.workspaceId);
      // Agent assignment also reopens a settled Issue, independently of PATCH.
      // ADR 0003 #8: a fresh unlocked hint (not `current`, read before the
      // cancellation committed) picks the rows; both are locked once in id order.
      const hint = taskAgent
        ? this.ctx.db.query("SELECT parent_issue_id, status FROM multiremi_issues WHERE id = ?").get(id) as Row | null
        : null;
      const reopenedChildParent = hint?.parent_issue_id && isTerminalIssueStatus(String(hint.status))
        ? String(hint.parent_issue_id) : null;
      // Re-derivation can propagate through in_review ancestors. Discover that
      // relation chain before taking D, then lock every possible written row
      // once in id order; an altered chain is a stale set, never a late lock.
      const assignmentRows = new Set<string>([id]);
      for (let parentId = reopenedChildParent; parentId;) {
        if (assignmentRows.has(parentId)) throw new Error("Issue parent cycle detected");
        assignmentRows.add(parentId);
        const parentHint = this.ctx.db.query(
          "SELECT parent_issue_id FROM multiremi_issues WHERE id = ? AND workspace_id = ?",
        ).get(parentId, current.workspaceId) as Row | null;
        // A missing or foreign ancestor must not silently end the lock chain.
        if (!parentHint) throw new Error(`Parent issue not found in workspace: ${parentId}`);
        parentId = parentHint.parent_issue_id ? String(parentHint.parent_issue_id) : null;
      }
      const lockedRows = lockIssueRowsWithinTransaction(this.ctx.db, [...assignmentRows]);
      if (!lockedRows.get(id)) throw new Error(`Issue not found: ${id}`);
      const locked = this.getIssue(id)!;
      // The Issue moved while this waited: resolve the assignee where it now
      // lives, which throws exactly what a sequential assign would, before any write.
      if (locked.workspaceId !== current.workspaceId) {
        this.ctx.squads().resolveAssigneeRef(assigneeType, assigneeId, locked.workspaceId);
      }
      if (taskAgent && locked.parentIssueId && isTerminalIssueStatus(locked.status)) {
        const checked = new Set<string>([id]);
        for (let parentId: string | null = locked.parentIssueId; parentId;) {
          if (checked.has(parentId)) throw new Error("Issue parent cycle detected");
          checked.add(parentId);
          if (!lockedRows.has(parentId)) throw new IssueLockSetStaleError();
          if (!lockedRows.get(parentId)) throw new Error(`Parent issue not found: ${parentId}`);
          parentId = this.getIssue(parentId)!.parentIssueId;
        }
      }
      this.ctx.db.run(
        `UPDATE multiremi_issues
         SET assignee_type = ?, assignee_id = ?, status = ?, updated_at = ?
         WHERE id = ?`,
        [assigneeType, assigneeId, taskAgent ? "todo" : locked.status, now, id],
      );
      if (taskAgent && isTerminalIssueStatus(locked.status)) {
        this.notifyChildStatusChangeWithinTransaction(
          locked, this.getIssue(id)!, resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
          assignmentChanges, assignmentEvents,
        );
      }
    };
    // Only the transaction owner can roll back a stale lock set and retry once.
    const assignWithinTransaction = () => {
      const assignmentChanges: ChildStatusChangeCollector = [];
      const assignmentEvents = createCommitEventQueue();
      writeAssignment(assignmentChanges, assignmentEvents);
      return { assignmentChanges, assignmentEvents };
    };
    const assignment = this.ctx.db.inTransaction ? assignWithinTransaction()
      : retryOnceOnStaleLockSet(() => this.ctx.db.transaction(assignWithinTransaction)());
    this.ctx.emitCommitEvents(assignment.assignmentEvents);
    afterCommit(this.ctx.db, () => this.ctx.tasks().runCollectedChildStatusChanges(assignment.assignmentChanges));

    let task: MultiremiTask | null = null;
    if (taskAgent) {
      task = this.ctx.tasks().createTask({
        agentId: taskAgent.id,
        issueId: id,
        workspaceId: current.workspaceId,
        prompt: input.prompt?.trim() || current.title,
        // Same authoritative-camelCase read as the other task-creation paths.
        parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
      });
    }
    if (assigneeType === "member") {
      this.addIssueSubscriber(id, assigneeId, "assigned");
      this.ctx.createInboxItem({
        issueId: id,
        memberId: assigneeId,
        type: "issue_assigned",
        severity: "info",
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
        ...sourceTaskActivityData(resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id")),
        cancelled,
      },
    });
    if (current.projectId) this.ctx.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    return { issue: this.getIssue(id)!, task, cancelledTasks: cancelled };
  }

  /**
   * MUL-400 E3 gate 2: an issue that still waits on a prerequisite cannot leave
   * `backlog` through a direct status write. Without this, the issue would sit
   * at `todo` with nothing running, because the dispatch path refuses too.
   *
   * A member may override with `force` (the routes already refuse a task
   * identity before it gets here); the dependency rows stay in place so the
   * page still explains what was skipped.
   */
  private assertDependenciesMetForStatus(
    id: string,
    current: MultiremiIssue,
    nextStatus: string,
    input: UpdateIssueInput,
    deferredEvents: CommitEventQueue,
  ): void {
    if (!dependencyGateEnabled()) return;
    if (current.status !== "backlog") return;
    if (nextStatus !== "todo" && nextStatus !== "in_progress") return;
    const unmet = this.listUnmetPrerequisites(id);
    if (!unmet.length) return;
    if (input.force === true) {
      // The override and its dispatch decision are part of the caller's owner
      // transaction. Runnable agent/squad owners get a round; member, missing,
      // or unavailable owners get `dispatch_skipped` with the requested status.
      this.recordDependencyForceStarted(id, {
        source: "status",
        status: nextStatus,
        previousStatus: current.status,
        unmet,
        actorType: input.actorType ?? "member",
        actorId: input.actorId ?? null,
        parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
      }, deferredEvents);
      return;
    }
    throw new IssueDependencyError(
      "dependencies_unmet",
      `${current.key} is waiting on ${unmet.length} unfinished prerequisite issue(s): ${unmet.map((row) => row.key).join(", ")}; finish them, or repeat the request with force`,
      { unmet },
    );
  }

  recordDependencyForceStarted(
    issueId: string,
    input: DependencyForceStartedInput,
    deferredEvents: CommitEventQueue,
  ): void {
    const unmet = input.unmet.map((row) => ({
      issueId: row.dependsOnIssueId,
      issue_id: row.dependsOnIssueId,
      dependsOnIssueId: row.dependsOnIssueId,
      depends_on_issue_id: row.dependsOnIssueId,
      dependencyId: row.dependencyId,
      dependency_id: row.dependencyId,
      key: row.key,
      status: row.status,
    }));
    this.ctx.appendIssueActivity(issueId, {
      actorType: input.actorType,
      actorId: input.actorId,
      type: "dependency_force_started",
      body: input.source,
      data: {
        source: input.source,
        status: input.status,
        previousStatus: input.previousStatus,
        previous_status: input.previousStatus,
        unmet,
        unmetPrerequisites: unmet,
        unmet_prerequisites: unmet,
        actor: `${input.actorType}:${input.actorId ?? ""}`,
        ...(input.commentId
          ? { commentId: input.commentId, comment_id: input.commentId }
          : {}),
        ...(input.taskId
          ? { taskId: input.taskId, task_id: input.taskId }
          : {}),
        ...(input.agentId
          ? { agentId: input.agentId, agent_id: input.agentId }
          : {}),
        ...(input.assigneeDispatched !== undefined
          ? {
              assigneeDispatched: input.assigneeDispatched,
              assignee_dispatched: input.assigneeDispatched,
            }
          : {}),
        ...sourceTaskActivityData(input.parentTaskId),
      },
    }, deferredEvents);
  }

  /**
   * MUL-400 E3 gate 1, at the top of the dispatch path.
   *
   * `assignIssue` is the single funnel for every "start this issue" call —
   * create-with-assignee, a changed assignee, `backlog -> todo` through
   * `maybeDispatchOnUpdate`, and an explicit assign.
   *
   * The gate only holds an issue that is **waiting**: `status = backlog` with an
   * unmet prerequisite. That is the definition the plan gives "waiting for a
   * prerequisite", and it is what keeps the gate from strangling work that is
   * already moving — an issue that is `todo`/`in_progress` and merely has a
   * dependency recorded on it carries information, not a hold, so re-assigning
   * it (or dispatching it) is allowed to proceed.
   *
   * A member may override with `force`; the rows stay so the page still shows
   * the unmet prerequisite.
   */
  private dependenciesBlockDispatch(issue: MultiremiIssue, force = false): IssueDependencyUnmetRef[] | null {
    if (!dependencyGateEnabled()) return null;
    if (issue.status !== "backlog") return null;
    if (force) return null;
    const unmet = this.listUnmetPrerequisites(issue.id);
    return unmet.length ? unmet : null;
  }

  private recordDependencyDispatchSkipped(
    issue: MultiremiIssue,
    unmet: IssueDependencyUnmetRef[],
    actor: {
      actorType?: string;
      actorId?: string | null;
      parentTaskId?: string | null;
      /** Set when the skip came from a comment-driven dispatch. */
      commentId?: string | null;
    },
    deferredEvents?: CommitEventQueue,
  ): void {
    const data = {
      reason: "dependencies_unmet",
      error: null,
      unmet: unmet.map((row) => ({
        issueId: row.dependsOnIssueId,
        issue_id: row.dependsOnIssueId,
        key: row.key,
        status: row.status,
      })),
      assigneeType: issue.assigneeType,
      assignee_type: issue.assigneeType,
      assigneeId: issue.assigneeId,
      assignee_id: issue.assigneeId,
      ...(actor.commentId
        ? { commentId: actor.commentId, comment_id: actor.commentId }
        : {}),
      ...sourceTaskActivityData(actor.parentTaskId ?? null),
    };
    this.ctx.appendIssueActivity(issue.id, {
      actorType: actor.actorType ?? "system",
      actorId: actor.actorId ?? null,
      type: "dispatch_skipped",
      body: null,
      data,
    }, deferredEvents);
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
      runtimeWorkspaceId: input.runtimeWorkspaceId ?? input.runtime_workspace_id ?? null,
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
      prompt: quickCreateTaskPrompt(prompt, projectId, input.runtimeWorkspaceId ?? input.runtime_workspace_id ?? null),
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

  createIssueComment(
    issueId: string,
    input: CreateIssueCommentInput,
    options: CreateIssueCommentOptions = {},
  ): MultiremiIssueComment {
    // The comment, its Session event and its log row commit together (B1).
    // Mention envelopes and pending turns share the comment's transaction (D1),
    // including standalone comments. Automatic replies defer mention dispatch
    // until after COMMIT (402 F1), keeping the reply on dispatch failure; the
    // split assignee auto-response and member notifications also follow COMMIT.
    // The automatic-reply and split-assignee commit gaps remain follow-ups.
    // Realtime pushes always follow the owning COMMIT.
    //
    // Frame ownership (Senior ruling cmt_96e1yqxgifms §2): this entry point is
    // also reached from a caller that already owns a transaction — the
    // Organizer action transaction that passes `withinTransaction` — so it
    // opens a BEGIN only when it is called from outside one. (The automatic
    // reply owns its frame and calls the two halves directly; see
    // `postAgentReplyComment`.) A second frame there would be a pure
    // savepoint wrapper over the same writes and would push a guarded path past
    // the single BEGIN the depth probes assert. When we do own the frame, we
    // also own the queue; `emitCommitEvents` binds it to the outermost COMMIT,
    // so a caller-owned rollback still drops every push either way.
    const commitEvents = options.deferredEvents ? null : createCommitEventQueue();
    const deferredEvents = commitEvents ?? options.deferredEvents;
    const childStatusChanges = options.withinTransaction ? options.childStatusChanges ?? [] : [];
    const ownsTransaction = !this.ctx.db.inTransaction;
    const run = () => this.createIssueCommentWithinTransaction(issueId, input, {
      ...options,
      splitAssigneeDispatch: ownsTransaction,
      ...(deferredEvents ? { deferredEvents } : {}),
    }, childStatusChanges);
    const created = this.ctx.db.inTransaction ? run() : this.ctx.db.transaction(run)();
    if (commitEvents) this.ctx.emitCommitEvents(commitEvents);
    afterCommit(this.ctx.db, () => {
      this.runIssueCommentPostCommit(created, input, options);
      if (!options.withinTransaction || !options.childStatusChanges) this.ctx.tasks().runCollectedChildStatusChanges(childStatusChanges);
    });
    return created.comment;
  }

  /**
   * Post-COMMIT half of {@link createIssueCommentWithinTransaction}: member
   * notifications, then explicitly deferred dispatch (including split assignee
   * replies). A caller-owned transaction schedules this after its COMMIT.
   */
  runIssueCommentPostCommit(
    created: CreatedIssueComment,
    input: CreateIssueCommentInput,
    options: { deferAgentMentionDispatch?: boolean } = {},
  ): void {
    const { issue, comment, body, authorType, issueSessionId, sessionEventSeq } = created;
    const mentionedMemberIds = this.triggerMemberMentions(issue, comment);
    this.notifySubscribedMembers(
      issue,
      "New comment",
      body,
      authorType,
      input.authorId ?? null,
      mentionedMemberIds,
      { comment_id: comment.id, issue_session_id: issueSessionId },
    );
    if (options.deferAgentMentionDispatch || created.dispatchHandled) return;
    const mentionTasks = this.triggerCommentMentions(issue, comment, sessionEventSeq);
    this.triggerAssigneeAutoResponse(issue, comment, mentionTasks.length > 0 || mentionedMemberIds.length > 0);
  }

  createIssueCommentWithinTransaction(
    issueId: string,
    input: CreateIssueCommentInput,
    options: CreateIssueCommentOptions,
    childStatusChanges: ChildStatusChangeCollector = [],
  ): CreatedIssueComment {
    const rawBody = input.body ?? input.content ?? "";
    if (!rawBody.trim()) throw new Error("Comment body is required");
    // Take W in the first statement: a prior SELECT could leave SQLite with
    // a stale read snapshot that cannot be upgraded while another writer commits.
    this.ctx.db.run(`UPDATE multiremi_workspaces SET updated_at = updated_at
      WHERE id = (SELECT workspace_id FROM multiremi_issues WHERE id = ?)`, [issueId]);
    const workspaceId = this.ctx.issueWorkspaceId(issueId);
    if (!workspaceId) throw new Error(`Issue not found: ${issueId}`);
    // Lock before reading Issue/session state so concurrent first comments can
    // both reach the shared seq allocator on SQLite's deferred transactions.
    if (!lockIssueRowWithinTransaction(this.ctx.db, issueId)) {
      throw new Error(`Issue not found: ${issueId}`);
    }
    const authorType = input.authorType ?? "member";
    if (options.deferAgentMentionDispatch && authorType !== "agent") {
      throw new Error("Only agent comment mentions can be deferred");
    }
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    if (issue.workspaceId !== workspaceId) throw new Error("Issue moved to another workspace during comment creation");
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
    this.linkReferencedAttachmentsToComment(id, issueId, body);
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    if (parentId) this.unresolveThreadRoot(parentId);
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
    const sessionEvents = this.ctx.issueSessions();
    // Always the within-transaction flavour: the public entry point, or the
    // caller that runs this half directly, guarantees a frame is open around
    // every write below.
    const commentEvent = sessionEvents.appendSessionEventWithinTransaction(issueSessionId, {
      authorType,
      authorId: input.authorId ?? null,
      kind: "message",
      body,
      sourceCommentId: id,
      metadata: { parent_comment_id: parentId },
      createdAt: now,
    });
    if (authorType === "member" && input.authorId) {
      // Member authors may use a member row id or a request user id. Resolve
      // explicitly for subscriptions without broadening authorization lookup.
      const authorMember = this.ctx.workspaces().getWorkspaceMember(input.authorId) ?? this.ctx.workspaces().findWorkspaceMemberForUser(input.authorId, issue.workspaceId);
      if (authorMember && authorMember.workspaceId === issue.workspaceId && !authorMember.archivedAt) {
        this.addIssueSubscriber(issueId, authorMember.id, "commented");
      }
    }
    // A caller-owned transaction defers this activity's realtime push too, so a
    // rollback cannot leave a timeline row on clients that the database lost.
    this.ctx.appendIssueActivity(issueId, {
      actorType: authorType,
      actorId: input.authorId ?? null,
      type: "comment_created",
      body,
      data: { commentId: id, ...(taskId ? { sourceTaskId: taskId } : {}) },
    }, options.deferredEvents);
    const comment = this.getIssueComment(id)!;
    // Live-update open issue pages. Emitted from the store (not the HTTP
    // layer) because agent replies and system comments are created directly
    // through the store and would otherwise never reach the browser. A
    // caller-owned transaction defers the push until it commits, so a rollback
    // cannot leave clients showing a comment that does not exist.
    const commentCreatedEvent: WorkspaceEvent = {
      type: "comment:created",
      workspaceId: issue.workspaceId,
      actorType: authorType,
      actorId: input.authorId ?? null,
      payload: { comment },
    };
    if (options.deferredEvents) options.deferredEvents.workspace.push(commentCreatedEvent);
    else this.ctx.emitWorkspaceEvent(commentCreatedEvent);
    const mentionedMemberIds = this.resolveCommentMemberMentionTargets(body, issue.workspaceId);
    // Decide under the comment's W/session locks, without opening another frame
    // or taking a pre-lock SQLite read snapshot.
    const splitAssigneeDispatch = options.splitAssigneeDispatch && authorType === "member"
      && (issue.assigneeType === "agent" || issue.assigneeType === "squad")
      && this.resolveCommentMentionTargets(body, issue.workspaceId).length === 0
      && mentionedMemberIds.length === 0;
    if (options.deferAgentMentionDispatch || options.deferDispatch || splitAssigneeDispatch) {
      return { issue, comment, body, authorType, issueSessionId, sessionEventSeq: commentEvent.seq, dispatchHandled: false };
    }
    const mentionTasks = this.triggerCommentMentions(issue, comment, commentEvent.seq, options.deferredEvents, childStatusChanges);
    this.triggerAssigneeAutoResponse(
      issue, comment, mentionTasks.length > 0 || mentionedMemberIds.length > 0, options.deferredEvents, childStatusChanges,
    );
    return { issue, comment, body, authorType, issueSessionId, sessionEventSeq: commentEvent.seq, dispatchHandled: true };
  }

  /**
   * Dispatch mentions for an agent comment that was persisted by an outer
   * transaction. Task enqueue notifications happen only after that caller
   * commits, even though nested database writes now use savepoints.
   */
  dispatchDeferredAgentCommentMentions(commentId: string): MultiremiTask[] {
    const comment = this.ctx.getLogIssueComment(commentId);
    if (!comment || comment.authorType !== "agent") {
      throw new Error(`Deferred agent comment not found: ${commentId}`);
    }
    const issue = this.getIssue(comment.issueId);
    if (!issue) throw new Error(`Issue not found: ${comment.issueId}`);
    const event = this.ctx.db.query(
      `SELECT seq FROM multiremi_conversation_log
       WHERE session_id = ? AND id = ? AND kind = 'message'
       ORDER BY seq DESC LIMIT 1`,
    ).get(comment.issueSessionId, comment.id) as { seq: number } | null;
    if (!event) throw new Error(`Session event not found for comment: ${comment.id}`);
    return this.triggerCommentMentions(issue, comment, Number(event.seq));
  }

  /**
   * Un-mentioned human comments route to the issue's assigned agent (squad →
   * leader) so the assignee keeps the conversation without an explicit @
   * (MUL-35). Any explicit mention — agent, squad or member — suppresses this:
   * the author already addressed someone. Agent/system comments never trigger
   * it, so an agent's own replies cannot re-queue itself. Agent-to-agent
   * dispatch is reserved for a Squad leader's rich mention of a teammate;
   * ordinary agent comments are messages only. Each human comment dispatches
   * individually (no batching, by request).
   */
  private triggerAssigneeAutoResponse(
    issue: MultiremiIssue,
    comment: MultiremiIssueComment,
    hasExplicitMentions: boolean,
    deferredEvents?: CommitEventQueue,
    childStatusChanges?: ChildStatusChangeCollector,
  ): MultiremiTask | null {
    if (comment.authorType !== "member") return null;
    if (hasExplicitMentions) return null;
    if (issue.assigneeType !== "agent" && issue.assigneeType !== "squad") return null;
    if (!issue.assigneeId) return null;
    const agent = this.ctx.resolveRunnableAgentForAssignee(issue.assigneeType, issue.assigneeId);
    if (!agent) return null;
    let task: MultiremiTask;
    try {
      task = this.dispatchHumanCommentRound(issue, comment, agent, {
        agentId: agent.id,
        issueId: issue.id,
        triggerCommentId: comment.id,
        workspaceId: issue.workspaceId,
        prompt: assigneeCommentPrompt(comment),
        dependencyForce: {
          source: "comment",
          actorMemberId: comment.authorId ?? "local",
          commentId: comment.id,
        },
      }, deferredEvents, childStatusChanges);
    } catch (err) {
      // MUL-400 E3 gate 3: the comment still lands (it was persisted before the
      // dispatch), but a waiting issue does not get a first round from it. The
      // skip is recorded so the author sees that the platform held the round
      // rather than silently doing nothing.
      if (!(err instanceof IssueDependencyError)) throw err;
      this.recordDependencyDispatchSkipped(issue, this.listUnmetPrerequisites(issue.id), {
        actorType: "system",
        actorId: null,
        parentTaskId: null,
        commentId: comment.id,
      }, deferredEvents);
      return null;
    }
    if (task.triggerCommentId === comment.id) this.ctx.appendIssueActivity(issue.id, {
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
    const deferredEvents = createCommitEventQueue();
    const { comment, changed, issueId } = this.ctx.db.transaction(() => this.updateIssueCommentWithinTransaction(id, input, deferredEvents))();
    this.ctx.emitCommitEvents(deferredEvents);
    // Keep the comment and its log revision atomic. Trigger cancellation can
    // wait on a workspace lock, so it follows that commit rather than holding
    // the comment row invisible for the entire wait.
    if (changed) this.cancelTasksByTriggerComments(issueId, [id]);
    return comment;
  }

  private updateIssueCommentWithinTransaction(id: string, input: UpdateIssueCommentInput, deferredEvents: CommitEventQueue): {
    comment: MultiremiIssueComment; changed: boolean; issueId: string;
  } {
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
    this.linkReferencedAttachmentsToComment(id, current.issueId, body);
    this.ctx.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    if (current.issueSessionId && current.body !== body) {
      // The edit lands in place on the comment's own row and bumps `revision`;
      // the hidden marker records what it replaced, for projections and the
      // browser replica's change feed.
      this.ctx.conversationLog().updateWithinTransaction(current.issueSessionId, this.commentLogSeq(current.id), {
        fields: {
          body_md: body,
          updated_at: now,
          metadata: {
            ...this.commentLogMetadata(current.id),
            body,
            previous_body: current.body,
          },
        },
      });
      this.ctx.issueSessions().appendSessionEventWithinTransaction(current.issueSessionId, {
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
    }, deferredEvents);
    return { comment: this.getIssueComment(id)!, changed: current.body !== body, issueId: current.issueId };
  }

  deleteIssueComment(id: string): void {
    const deferredEvents = createCommitEventQueue();
    const { issueId, commentIds } = this.ctx.db.transaction(() => this.deleteIssueCommentWithinTransaction(id, deferredEvents))();
    this.ctx.emitCommitEvents(deferredEvents);
    this.cancelTasksByTriggerComments(issueId, commentIds);
  }

  private deleteIssueCommentWithinTransaction(id: string, deferredEvents: CommitEventQueue): { issueId: string; commentIds: string[] } {
    const current = this.ctx.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const ids = this.collectCommentTreeIds(id);
    const deletedComments = ids
      .map((commentId) => this.ctx.getRawIssueComment(commentId))
      .filter((comment): comment is MultiremiIssueComment => comment !== null);
    const now = nowIso();
    for (const commentId of ids) {
      this.ctx.db.run("DELETE FROM multiremi_comment_reactions WHERE comment_id = ?", [commentId]);
      this.ctx.db.run("DELETE FROM multiremi_attachments WHERE comment_id = ?", [commentId]);
    }
    for (const commentId of ids.slice().reverse()) {
      this.ctx.db.run("DELETE FROM multiremi_issue_comments WHERE id = ?", [commentId]);
    }
    for (const comment of deletedComments) {
      if (!comment.issueSessionId) continue;
      // Tombstone: the row stays on the axis with `deleted_at` set, its body
      // cleared and the text preserved under `metadata.deleted_body`. Display
      // windows filter it out; agent projections still see the marker.
      const seq = this.commentLogSeq(comment.id);
      const existing = this.ctx.conversationLog().getConversationLogEntry(comment.issueSessionId, seq);
      if (existing) {
        this.ctx.conversationLog().updateWithinTransaction(comment.issueSessionId, seq, {
          fields: {
            body_md: "",
            task_id: null,
            deleted_at: now,
            updated_at: now,
            metadata: { ...existing.metadata, deleted_body: comment.body },
          },
        });
      }
      this.ctx.issueSessions().appendSessionEventWithinTransaction(comment.issueSessionId, {
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
    }, deferredEvents);
    return { issueId: current.issueId, commentIds: ids };
  }

  resolveIssueComment(id: string, input: { actorType?: string; actorId?: string | null } = {}): MultiremiIssueComment {
    const deferredEvents = createCommitEventQueue();
    const comment = this.ctx.db.transaction(() => this.resolveIssueCommentWithinTransaction(id, input, deferredEvents))();
    this.ctx.emitCommitEvents(deferredEvents);
    return comment;
  }

  private resolveIssueCommentWithinTransaction(id: string, input: { actorType?: string; actorId?: string | null }, deferredEvents: CommitEventQueue): MultiremiIssueComment {
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
      // The log resolves in place with `revision++`; the browser replica learns
      // the new state from the patch's three resolved columns.
      this.ctx.conversationLog().updateWithinTransaction(current.issueSessionId, this.commentLogSeq(id), {
        fields: {
          resolved_at: now,
          resolved_by_type: input.actorType ?? "member",
          resolved_by_id: input.actorId ?? "local",
          updated_at: now,
        },
      });
      this.ctx.issueSessions().appendSessionEventWithinTransaction(current.issueSessionId, {
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
    }, deferredEvents);
    return this.getIssueComment(id)!;
  }

  unresolveIssueComment(id: string): MultiremiIssueComment {
    const deferredEvents = createCommitEventQueue();
    const comment = this.ctx.db.transaction(() => this.unresolveIssueCommentWithinTransaction(id, deferredEvents))();
    this.ctx.emitCommitEvents(deferredEvents);
    return comment;
  }

  private unresolveIssueCommentWithinTransaction(id: string, deferredEvents: CommitEventQueue): MultiremiIssueComment {
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
      // Unresolve clears all three columns on the same row and bumps `revision`.
      this.ctx.conversationLog().updateWithinTransaction(current.issueSessionId, this.commentLogSeq(id), {
        fields: {
          resolved_at: null,
          resolved_by_type: null,
          resolved_by_id: null,
          updated_at: now,
        },
      });
      this.ctx.issueSessions().appendSessionEventWithinTransaction(current.issueSessionId, {
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
    }, deferredEvents);
    return this.getIssueComment(id)!;
  }

  getIssueComment(id: string): MultiremiIssueComment | null {
    const row = this.ctx.db.query(
      `SELECT cmt.*, log.id AS log_id, log.body_md AS log_body_md,
         log.updated_at AS log_updated_at, log.resolved_at AS log_resolved_at,
         log.resolved_by_type AS log_resolved_by_type, log.resolved_by_id AS log_resolved_by_id
       FROM multiremi_issue_comments cmt
       LEFT JOIN multiremi_conversation_log log ON log.id = cmt.id
       WHERE cmt.id = ?`,
    ).get(id) as Row | null;
    return row ? this.hydrateIssueComment(this.commentFromLogRow(row)) : null;
  }

  listIssueComments(issueId: string): MultiremiIssueComment[] {
    const rows = this.ctx.db.query(
      `SELECT cmt.*, log.id AS log_id, log.body_md AS log_body_md,
         log.updated_at AS log_updated_at, log.resolved_at AS log_resolved_at,
         log.resolved_by_type AS log_resolved_by_type, log.resolved_by_id AS log_resolved_by_id
       FROM multiremi_issue_comments cmt
       LEFT JOIN multiremi_conversation_log log ON log.id = cmt.id
       WHERE cmt.issue_id = ? ORDER BY cmt.created_at ASC`,
    ).all(issueId) as Row[];
    return this.hydrateIssueComments(rows.map((row) => this.commentFromLogRow(row)));
  }

  private commentFromLogRow(row: Row): MultiremiIssueComment {
    // B7 backfills historical comments. Until then, a missing log row retains
    // the legacy wire while every newly mirrored comment reads its log revision.
    if (row.log_id == null) return toIssueComment(row);
    return toIssueComment({
      ...row,
      body: row.log_body_md,
      updated_at: row.log_updated_at,
      resolved_at: row.log_resolved_at,
      resolved_by_type: row.log_resolved_by_type,
      resolved_by_id: row.log_resolved_by_id,
    });
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

  // Assign-on-create could not queue a task. Persist the reason as a visible
  // activity so the issue page can explain why nothing is running, instead of
  // the outcome living only in server logs.
  recordDispatchSkipped(issueId: string, input: {
    reason: string;
    error?: string | null;
    assigneeType?: string | null;
    assigneeId?: string | null;
  }): MultiremiIssueActivity {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    // Via appendIssueActivity (not a raw INSERT) so browsers get the
    // activity:created broadcast and the timeline updates live.
    this.ctx.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "dispatch_skipped",
      body: input.error ?? null,
      data: {
        reason: input.reason,
        error: input.error ?? null,
        assignee_type: input.assigneeType ?? null,
        assignee_id: input.assigneeId ?? null,
      },
    });
    return this.listIssueActivity(issue.id).findLast((activity) => activity.type === "dispatch_skipped")!;
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

  listIssueTimelinePage(issueId: string, options: {
    issueSessionId?: string | null;
    before?: IssueTimelineCursor | null;
    limit: number;
    /**
     * The caller already proved the issue exists and that `issueSessionId`
     * belongs to it, so skip the repeat reads. Validation semantics are
     * unchanged by default; pass this only from a caller that ran the same
     * checks on the same ids in the same request.
     */
    skipExistenceChecks?: boolean;
  }): IssueTimelinePageResult {
    if (!options.skipExistenceChecks) {
      if (!this.hasIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
      const requestedSessionId = cleanOptionalString(options.issueSessionId);
      if (requestedSessionId) {
        const session = this.ctx.issueSessions().getIssueSession(requestedSessionId);
        if (!session || session.issueId !== issueId) {
          throw new Error(`Issue session not found for issue: ${requestedSessionId}`);
        }
      }
    }
    const sessionId = cleanOptionalString(options.issueSessionId);

    const rowLimit = options.limit + 1;
    const commentWhere = ["issue_id = ?"];
    const commentParams: unknown[] = [issueId];
    if (sessionId) {
      commentWhere.push("issue_session_id = ?");
      commentParams.push(sessionId);
    }
    if (options.before) {
      commentWhere.push("(created_at < ? OR (created_at = ? AND id < ?))");
      commentParams.push(options.before.createdAt, options.before.createdAt, options.before.id);
    }
    commentParams.push(rowLimit);
    const commentRows = this.ctx.db.query(
      `SELECT * FROM multiremi_issue_comments
       WHERE ${commentWhere.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(...commentParams) as Row[];

    const activityRows = sessionId
      ? []
      : this.ctx.db.query(
        `SELECT * FROM multiremi_issue_activity
         WHERE issue_id = ?
           ${options.before ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).all(...(
        options.before
          ? [issueId, options.before.createdAt, options.before.createdAt, options.before.id, rowLimit]
          : [issueId, rowLimit]
      )) as Row[];

    const merged = [
      ...commentRows.map((row) => ({ kind: "comment" as const, row })),
      ...activityRows.map((row) => ({ kind: "activity" as const, row })),
    ].sort((left, right) => {
      const createdAt = String(right.row.created_at).localeCompare(String(left.row.created_at));
      return createdAt || String(right.row.id).localeCompare(String(left.row.id));
    });
    const selected = merged.slice(0, options.limit);
    const hydratedComments = new Map(
      this.hydrateIssueComments(
        selected.filter((item) => item.kind === "comment").map((item) => toIssueComment(item.row)),
      ).map((comment) => [comment.id, comment]),
    );
    const entries = selected.reverse().map((item) => item.kind === "comment"
      ? commentToTimelineEntry(hydratedComments.get(String(item.row.id))!)
      : activityToTimelineEntry(toIssueActivity(item.row)));
    return { entries, hasMore: merged.length > options.limit };
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
    if (!this.hasIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    return this.listLabelsForExistingIssue(issueId);
  }

  /** `listLabelsForIssue` for a caller that already proved the issue exists. */
  listLabelsForExistingIssue(issueId: string): MultiremiLabel[] {
    const rows = this.ctx.db.query(
      `SELECT l.*
       FROM multiremi_issue_labels l
       JOIN multiremi_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id = ?
       ORDER BY lower(l.name) ASC`,
    ).all(issueId) as Row[];
    return rows.map(toLabel);
  }

  attachLabelToIssue(
    issueId: string,
    labelId: string,
    activity: IssueMutationActivityContext = {},
  ): MultiremiLabel[] {
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
      actorType: activity.actorType ?? "system",
      actorId: activity.actorId ?? null,
      type: "label_attached",
      body: label.name,
      data: { labelId, color: label.color, ...sourceTaskActivityData(activity.sourceTaskId) },
    });
    return this.listLabelsForIssue(issueId);
  }

  detachLabelFromIssue(
    issueId: string,
    labelId: string,
    activity: IssueMutationActivityContext = {},
  ): MultiremiLabel[] {
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
      actorType: activity.actorType ?? "system",
      actorId: activity.actorId ?? null,
      type: "label_detached",
      body: label.name,
      data: { labelId, color: label.color, ...sourceTaskActivityData(activity.sourceTaskId) },
    });
    return this.listLabelsForIssue(issueId);
  }

  getInboxItem(id: string): MultiremiInboxItem | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    if (!row) return null;
    return this.hydrateInboxRows([row])[0] ?? null;
  }

  listInboxItems(memberId?: string | null, workspaceId?: string): MultiremiInboxItem[] {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return [];
    const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
    const params = workspaceId === undefined ? [resolvedMemberId] : [resolvedMemberId, workspaceId];
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_inbox_items WHERE member_id = ?${workspaceFilter} AND archived = 0 ORDER BY created_at DESC`,
    ).all(...params) as Row[];
    return this.hydrateInboxRows(rows);
  }

  listInboxItemsPage(
    memberId?: string | null,
    options: { limit?: number; cursor?: string | null } = {},
    workspaceId?: string,
  ): MultiremiInboxPage {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    const requestedLimit = Math.floor(options.limit ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 50;
    if (!resolvedMemberId) return { items: [], limit, hasMore: false, nextCursor: null };

    const cursor = cleanOptionalString(options.cursor);
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      const decoded = decodeInboxCursor(cursor);
      cursorCreatedAt = decoded.createdAt;
      cursorId = decoded.id;
    }

    const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
    const params = workspaceId === undefined ? [resolvedMemberId] : [resolvedMemberId, workspaceId];
    const rows = cursorCreatedAt
      ? this.ctx.db.query(
          `SELECT * FROM multiremi_inbox_items
           WHERE member_id = ?${workspaceFilter} AND archived = 0
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        ).all(...params, cursorCreatedAt, cursorCreatedAt, cursorId, limit + 1) as Row[]
      : this.ctx.db.query(
          `SELECT * FROM multiremi_inbox_items
           WHERE member_id = ?${workspaceFilter} AND archived = 0
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        ).all(...params, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: this.hydrateInboxRows(pageRows),
      limit,
      hasMore,
      nextCursor: hasMore && pageRows.length > 0 ? encodeInboxCursor(pageRows[pageRows.length - 1]!) : null,
    };
  }

  getInboxSummary(
    memberId?: string | null,
    timezoneOffsetMinutes = 0,
    workspaceId?: string,
  ): MultiremiInboxSummary {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return { unread: 0, attention: 0 };
    const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
    const params = workspaceId === undefined ? [resolvedMemberId] : [resolvedMemberId, workspaceId];

    // MUL-473: the counts come back as one aggregate instead of pulling every
    // unarchived row across the bridge to count it in JavaScript.
    //
    // A row belongs to a *selection key*: all of one Issue's rows collapse into
    // a single candidate unless the type is an inbox ledger entry or the row has
    // no Issue, in which case the key is the row itself. Only the newest row per
    // key is visible. The window function ranks inside the key and the outer
    // aggregate counts the winners; no Issue body, title or message column is
    // read here.
    const ledgerTypes = INBOX_LEDGER_TYPES.map((type) => `'${type.replace(/'/g, "''")}'`).join(", ");
    const selectionKey = `CASE WHEN type IN (${ledgerTypes}) OR NULLIF(issue_id, '') IS NULL
                          THEN 'item:' || id ELSE 'issue:' || issue_id END`;
    const totals = this.ctx.db.query(
      `WITH ranked AS (
         SELECT read, severity, type,
                ${selectionKey} AS selection_key,
                ROW_NUMBER() OVER (PARTITION BY ${selectionKey} ORDER BY created_at DESC, id DESC) AS selection_rank
         FROM multiremi_inbox_items
         WHERE member_id = ?${workspaceFilter} AND archived = 0
       ),
       visible AS (SELECT read, severity, type, selection_key FROM ranked WHERE selection_rank = 1)
       SELECT
         COUNT(DISTINCT CASE WHEN read = 0 AND (severity = 'attention' OR severity = 'action_required')
                             THEN selection_key END) AS attention,
         COUNT(DISTINCT CASE WHEN read = 0 AND type != 'autopilot_run_completed'
                             THEN selection_key END) AS unread_plain
       FROM visible`,
    ).get(...params) as Row | null;
    const attention = Number(totals?.attention ?? 0);
    let unread = Number(totals?.unread_plain ?? 0);

    // Successful automation runs are the one type the UI merges by autopilot
    // within a day bucket, so they are the only rows whose payload this route
    // still reads. Ledger rows are already keyed by row id, so "one row per
    // selection" is simply "every row" for this type; the filter keeps the
    // bridge payload proportional to the completed runs, not to the inbox.
    const runRows = this.ctx.db.query(
      `SELECT read, created_at, details FROM multiremi_inbox_items
       WHERE member_id = ?${workspaceFilter} AND archived = 0 AND type = 'autopilot_run_completed'
       ORDER BY created_at DESC, id DESC`,
    ).all(...params) as Row[];
    const now = new Date();
    const mergedSuccessfulRuns = new Map<string, { unread: boolean }>();
    for (const row of runRows) {
      const isUnread = Number(row.read ?? 0) === 0;
      const details = parseJson<Record<string, unknown> | null>(row.details, null);
      const autopilotId = typeof details?.autopilot_id === "string" ? details.autopilot_id : null;
      // A completed run without an autopilot id has nothing to merge with, so it
      // counts as its own unread row — the same branch the old loop took.
      if (!autopilotId) {
        if (isUnread) unread += 1;
        continue;
      }
      const mergeKey = `${inboxDateGroup(String(row.created_at), now, timezoneOffsetMinutes)}:${autopilotId}`;
      const merged = mergedSuccessfulRuns.get(mergeKey);
      if (merged) merged.unread ||= isUnread;
      else mergedSuccessfulRuns.set(mergeKey, { unread: isUnread });
    }
    unread += [...mergedSuccessfulRuns.values()].filter((entry) => entry.unread).length;
    return { unread, attention };
  }

  markInboxItemRead(id: string): MultiremiInboxItem {
    const existing = this.ctx.db.query("SELECT issue_id FROM multiremi_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!existing) throw new Error(`Inbox item not found: ${id}`);
    this.ctx.db.run("UPDATE multiremi_inbox_items SET read = 1 WHERE id = ?", [id]);
    const row = this.ctx.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    return this.hydrateInboxRows([row!])[0]!;
  }

  archiveInboxItem(id: string): MultiremiInboxItem {
    const rowBefore = this.ctx.db.query("SELECT issue_id FROM multiremi_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!rowBefore) throw new Error(`Inbox item not found: ${id}`);
    this.ctx.db.run("UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE id = ?", [id]);
    const row = this.ctx.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    return this.hydrateInboxRows([row!])[0]!;
  }

  countUnreadInboxItems(memberId?: string | null, workspaceId?: string): number {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
    const params = workspaceId === undefined ? [resolvedMemberId] : [resolvedMemberId, workspaceId];
    const row = this.ctx.db.query(
      `SELECT COUNT(*) AS count FROM multiremi_inbox_items WHERE member_id = ?${workspaceFilter} AND archived = 0 AND read = 0`,
    ).get(...params) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  markAllInboxItemsRead(memberId?: string | null, workspaceId?: string): number {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
    const params = workspaceId === undefined ? [resolvedMemberId] : [resolvedMemberId, workspaceId];
    const result = this.ctx.db.run(
      `UPDATE multiremi_inbox_items SET read = 1 WHERE member_id = ?${workspaceFilter} AND archived = 0 AND read = 0`,
      params,
    );
    return result.changes;
  }

  archiveAllInboxItems(memberId?: string | null, mode: "all" | "read" | "completed" = "all", workspaceId?: string): number {
    const resolvedMemberId = memberId ?? this.ctx.workspaces().listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const workspaceFilter = workspaceId === undefined ? "" : " AND workspace_id = ?";
    const params = workspaceId === undefined ? [resolvedMemberId] : [resolvedMemberId, workspaceId];
    if (mode === "read") {
      return this.ctx.db.run(
        `UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE member_id = ?${workspaceFilter} AND archived = 0 AND read = 1`,
        params,
      ).changes;
    }
    if (mode === "completed") {
      return this.ctx.db.run(
        `UPDATE multiremi_inbox_items
         SET archived = 1, read = 1
         WHERE member_id = ?${workspaceFilter}
           AND archived = 0
           AND issue_id IN (
             SELECT id FROM multiremi_issues WHERE status IN ('done', 'completed', 'closed', 'cancelled')
           )`,
        params,
      ).changes;
    }
    return this.ctx.db.run(
      `UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE member_id = ?${workspaceFilter} AND archived = 0`,
      params,
    ).changes;
  }

  listIssueReactions(issueId: string): MultiremiIssueReaction[] {
    if (!this.hasIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    return this.listReactions(ISSUE_REACTIONS, issueId);
  }

  /** `listIssueReactions` for a caller that already proved the issue exists. */
  listIssueReactionsForExistingIssue(issueId: string): MultiremiIssueReaction[] {
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
    const rows = this.ctx.db.query(
      `SELECT reactions.*, comments.id AS __comment_exists
       FROM multiremi_issue_comments comments
       LEFT JOIN multiremi_comment_reactions reactions ON reactions.comment_id = comments.id
       WHERE comments.id = ?
       ORDER BY reactions.created_at ASC`,
    ).all(commentId) as Row[];
    if (!rows.length) throw new Error(`Comment not found: ${commentId}`);
    return rows.filter((row) => row.id != null).map(toCommentReaction);
  }

  listCommentReactionsForComments(commentIds: string[]): Map<string, MultiremiCommentReaction[]> {
    const grouped = new Map<string, MultiremiCommentReaction[]>();
    const ids = [...new Set(commentIds.filter(Boolean))];
    if (!ids.length) return grouped;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_comment_reactions
       WHERE comment_id IN (${placeholders})
       ORDER BY created_at ASC`,
    ).all(...ids) as Row[];
    for (const reaction of rows.map(toCommentReaction)) {
      const list = grouped.get(reaction.commentId) ?? [];
      list.push(reaction);
      grouped.set(reaction.commentId, list);
    }
    return grouped;
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
    if (!this.hasIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    return this.listAttachmentsForExistingIssue(issueId);
  }

  /** `listAttachmentsForIssue` for a caller that already proved the issue exists. */
  listAttachmentsForExistingIssue(issueId: string): MultiremiAttachment[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_attachments WHERE issue_id = ? AND comment_id IS NULL ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForComment(commentId: string): MultiremiAttachment[] {
    const rows = this.ctx.db.query(
      `SELECT attachments.*, comments.id AS __comment_exists
       FROM multiremi_issue_comments comments
       LEFT JOIN multiremi_attachments attachments ON attachments.comment_id = comments.id
       WHERE comments.id = ?
       ORDER BY attachments.created_at ASC`,
    ).all(commentId) as Row[];
    if (!rows.length) throw new Error(`Comment not found: ${commentId}`);
    return rows.filter((row) => row.id != null).map(toAttachment);
  }

  listAttachmentsForComments(commentIds: string[]): Map<string, MultiremiAttachment[]> {
    const grouped = new Map<string, MultiremiAttachment[]>();
    const ids = [...new Set(commentIds.filter(Boolean))];
    if (!ids.length) return grouped;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_attachments
       WHERE comment_id IN (${placeholders})
       ORDER BY created_at ASC`,
    ).all(...ids) as Row[];
    for (const attachment of rows.map(toAttachment)) {
      if (!attachment.commentId) continue;
      const list = grouped.get(attachment.commentId) ?? [];
      list.push(attachment);
      grouped.set(attachment.commentId, list);
    }
    return grouped;
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

  private linkReferencedAttachmentsToIssue(issueId: string, text: string | null | undefined): void {
    const attachmentIds = attachmentIdsFromText(text).filter((attachmentId) => {
      const attachment = this.getAttachment(attachmentId);
      return attachment !== null && (attachment.issueId === null || attachment.issueId === issueId);
    });
    if (attachmentIds.length) this.linkAttachmentsToIssue(issueId, attachmentIds);
  }

  private linkReferencedAttachmentsToComment(commentId: string, issueId: string, text: string): void {
    const attachmentIds = attachmentIdsFromText(text).filter((attachmentId) => {
      const attachment = this.getAttachment(attachmentId);
      return attachment !== null
        && attachment.commentId === null
        && (attachment.issueId === null || attachment.issueId === issueId);
    });
    if (attachmentIds.length) this.linkAttachmentsToComment(commentId, issueId, attachmentIds);
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

  setIssueMetadataKey(
    issueId: string,
    key: string,
    value: unknown,
    activity: IssueMutationActivityContext = {},
  ): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    validatePublicIssueMetadataKey(key);
    const normalized = validateIssueMetadataValue(value);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const row = this.ctx.db.query("SELECT metadata FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    const metadata = parseJson<Record<string, unknown>>(row?.metadata, {});
    const publicMetadata = parseIssueMetadata(metadata);
    if (!(key in publicMetadata) && Object.keys(publicMetadata).length >= MAX_ISSUE_METADATA_KEYS) {
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
      actorType: activity.actorType ?? "system",
      actorId: activity.actorId ?? null,
      type: "issue_metadata_set",
      body: `${key}=${String(normalized)}`,
      data: { key, value: normalized, ...sourceTaskActivityData(activity.sourceTaskId) },
    });
    return this.listIssueMetadata(issueId);
  }

  setIssueAutoTitleMetadata(
    issueId: string,
    value: MultiremiIssueAutoTitleMetadata,
  ): MultiremiIssue {
    const row = this.ctx.db.query("SELECT metadata FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!row) throw new Error(`Issue not found: ${issueId}`);
    const metadata: Record<string, unknown> = {
      ...parseJson<Record<string, unknown>>(row.metadata, {}),
      auto_title: { ...value },
    };
    validateIssueMetadataSize(metadata);
    this.ctx.db.run(
      "UPDATE multiremi_issues SET metadata = ? WHERE id = ?",
      [toJson(metadata), issueId],
    );
    return this.getIssue(issueId)!;
  }

  getIssueAutoTitleMetadata(issueId: string): MultiremiIssueAutoTitleMetadata {
    const row = this.ctx.db.query("SELECT metadata FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!row) throw new Error(`Issue not found: ${issueId}`);
    const raw = parseJson<Record<string, unknown>>(row.metadata, {}).auto_title;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? sanitizeAutoTitleMetadata(raw as Record<string, unknown>)
      : {};
  }

  appendIssueActivity(issueId: string, input: {
    actorType: string;
    actorId?: string | null;
    type: string;
    body?: string | null;
    data?: unknown | null;
  }, deferredEvents?: CommitEventQueue): void {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    this.ctx.appendIssueActivity(issueId, input, deferredEvents);
  }

  deleteIssueMetadataKey(
    issueId: string,
    key: string,
    activity: IssueMutationActivityContext = {},
  ): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    validatePublicIssueMetadataKey(key);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const row = this.ctx.db.query("SELECT metadata FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    const metadata = parseJson<Record<string, unknown>>(row?.metadata, {});
    delete metadata[key];
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.ctx.appendIssueActivity(issueId, {
      actorType: activity.actorType ?? "system",
      actorId: activity.actorId ?? null,
      type: "issue_metadata_deleted",
      body: key,
      data: { key, ...sourceTaskActivityData(activity.sourceTaskId) },
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

  private cancelActiveIssueTasks(issueId: string, reason: string, deferredEvents: CommitEventQueue): number {
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
      this.ctx.tasks().cancelPendingHumanRequestsWithinTransaction(String(row.id), now);
      this.ctx.appendIssueActivity(issueId, {
        actorType: "system",
        actorId: null,
        type: "task_cancelled",
        body: reason,
        data: { taskId: String(row.id), agentId: nullableString(row.agent_id) },
      }, deferredEvents);
    }
    return active.length;
  }

  private cancelTasksByTriggerComments(issueId: string, commentIds: string[]): number {
    const issue = this.getIssue(issueId);
    if (!issue || !commentIds.length) return 0;
    return this.ctx.tasks().cancelTasksByTriggerComments(issue.workspaceId, commentIds);
  }

  private hydrateIssue(issue: MultiremiIssue): MultiremiIssue {
    return {
      ...issue,
      labels: this.listLabelsForExistingIssue(issue.id),
    };
  }

  private hydrateIssues(issues: MultiremiIssue[]): MultiremiIssue[] {
    if (issues.length === 0) return issues;
    const labelsByIssue = this.labelsForIssues(issues.map((issue) => issue.id));
    return issues.map((issue) => ({ ...issue, labels: labelsByIssue.get(issue.id) ?? [] }));
  }

  private hydrateInboxRows(rows: Row[]): MultiremiInboxItem[] {
    const scopedKey = (workspaceId: string, issueId: string) => `${workspaceId}\0${issueId}`;
    const issueIdsByWorkspace = new Map<string, Set<string>>();
    for (const row of rows) {
      const issueId = nullableString(row.issue_id);
      if (!issueId) continue;
      const workspaceId = String(row.workspace_id ?? "local");
      const ids = issueIdsByWorkspace.get(workspaceId) ?? new Set<string>();
      ids.add(issueId);
      issueIdsByWorkspace.set(workspaceId, ids);
    }
    const issuesByScope = new Map<string, MultiremiIssue>();
    // Keep below SQLite's default bind-variable limit. PostgreSQL benefits from the same bounded queries.
    for (const [workspaceId, issueIds] of issueIdsByWorkspace) {
      const ids = [...issueIds];
      for (let offset = 0; offset < ids.length; offset += 400) {
        const chunk = ids.slice(offset, offset + 400);
        const placeholders = chunk.map(() => "?").join(", ");
        const issueRows = this.ctx.db.query(
          `SELECT * FROM multiremi_issues WHERE workspace_id = ? AND id IN (${placeholders})`,
        ).all(workspaceId, ...chunk) as Row[];
        for (const issue of this.hydrateIssues(issueRows.map((row) => toIssue(row)))) {
          issuesByScope.set(scopedKey(workspaceId, issue.id), issue);
        }
      }
    }
    const parentIdsByWorkspace = new Map<string, Set<string>>();
    for (const issue of issuesByScope.values()) {
      if (!issue.parentIssueId) continue;
      const ids = parentIdsByWorkspace.get(issue.workspaceId) ?? new Set<string>();
      ids.add(issue.parentIssueId);
      parentIdsByWorkspace.set(issue.workspaceId, ids);
    }
    const parentsByScope = new Map<string, Pick<MultiremiIssue, "id" | "key" | "title">>();
    for (const [workspaceId, parentIds] of parentIdsByWorkspace) {
      const ids = [...parentIds];
      for (let offset = 0; offset < ids.length; offset += 400) {
        const chunk = ids.slice(offset, offset + 400);
        const placeholders = chunk.map(() => "?").join(", ");
        const parentRows = this.ctx.db.query(
          `SELECT id, issue_key, title FROM multiremi_issues WHERE workspace_id = ? AND id IN (${placeholders})`,
        ).all(workspaceId, ...chunk) as Row[];
        for (const row of parentRows) {
          const id = String(row.id);
          parentsByScope.set(scopedKey(workspaceId, id), { id, key: String(row.issue_key), title: String(row.title) });
        }
      }
    }
    return rows.map((row) => {
      const workspaceId = String(row.workspace_id ?? "local");
      const issueId = nullableString(row.issue_id);
      const issue = issueId ? issuesByScope.get(scopedKey(workspaceId, issueId)) ?? null : null;
      const parent = issue?.parentIssueId
        ? parentsByScope.get(scopedKey(workspaceId, issue.parentIssueId)) ?? null
        : (row.type === "child_issue_terminal" || row.type === "decision_requested") ? issue : null;
      return toInboxItem(row, issue, parent);
    });
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
    return this.hydrateIssueComments([comment])[0]!;
  }

  private hydrateIssueComments(comments: MultiremiIssueComment[]): MultiremiIssueComment[] {
    if (!comments.length) return comments;
    const ids = comments.map((comment) => comment.id);
    const reactions = this.listCommentReactionsForComments(ids);
    const attachments = this.listAttachmentsForComments(ids);
    return comments.map((comment) => ({
      ...comment,
      reactions: reactions.get(comment.id) ?? [],
      attachments: attachments.get(comment.id) ?? [],
    }));
  }

  private hydrateIssueDependency(dependency: MultiremiIssueDependency): MultiremiIssueDependency {
    return {
      ...dependency,
      issue: this.getIssue(dependency.issueId),
      dependsOnIssue: this.getIssue(dependency.dependsOnIssueId),
    };
  }

  /**
   * Comment ids are log row ids; edits, deletes and resolves keep their seq.
   */
  private commentLogSeq(commentId: string): number {
    const row = this.ctx.db.query(
      `SELECT seq FROM multiremi_conversation_log
       WHERE id = ? AND kind IN ('message', 'system')
       LIMIT 1`,
    ).get(commentId) as { seq?: number } | null;
    if (row?.seq == null) throw new Error(`Conversation log entry not found for comment: ${commentId}`);
    return Number(row.seq);
  }

  /** The comment log row's current metadata, for a metadata update that replaces it. */
  private commentLogMetadata(commentId: string): Record<string, unknown> {
    const row = this.ctx.db.query(
      "SELECT metadata FROM multiremi_conversation_log WHERE id = ? LIMIT 1",
    ).get(commentId) as { metadata?: string } | null;
    return row ? parseJson<Record<string, unknown>>(row.metadata, {}) : {};
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
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [now, current.id],
    );
    const entry = this.ctx.conversationLog().getConversationLogEntryById(current.id);
    if (entry && current.issueSessionId) {
      this.ctx.conversationLog().updateWithinTransaction(current.issueSessionId, entry.seq, {
        fields: { resolved_at: null, resolved_by_type: null, resolved_by_id: null, updated_at: now },
      });
    }
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

  /**
   * Disclose a supervisor's cross-task disposal to the patrol issue's subscribers.
   * The audit comment itself is agent-authored, and agent comments only route to
   * the inbox while the issue is workbench-visible (INBOX_ROUTING R2) — so the
   * disclosure gets its own ledger type rather than riding on `comment_created`.
   */
  notifyOrganizerAction(
    issue: MultiremiIssue,
    body: string,
    actorType: string,
    actorId: string | null,
    details: unknown | null = null,
  ): void {
    for (const subscriber of this.listIssueSubscribers(issue.id)) {
      if (subscriber.userType !== "member") continue;
      this.ctx.createInboxItem({
        issueId: issue.id,
        memberId: subscriber.userId,
        type: "organizer_action",
        title: `${issue.key}: Organizer action`,
        body,
        actorType,
        actorId,
        details,
        issueStatus: issue.status,
      });
    }
  }

  private notifySubscribedMembers(
    issue: MultiremiIssue,
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
        type: "comment_created",
        title: `${issue.key}: ${title}`,
        body,
        actorType,
        actorId,
        details,
        issueStatus: issue.status,
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

  private triggerCommentMentions(
    issue: MultiremiIssue,
    comment: MultiremiIssueComment,
    requiredEventSeq: number,
    deferredEvents?: CommitEventQueue,
    childStatusChanges?: ChildStatusChangeCollector,
  ): MultiremiTask[] {
    const targets = this.resolveCommentMentionTargets(comment.body, issue.workspaceId);
    if (!targets.length) return [];

    const session = comment.issueSessionId
      ? this.ctx.issueSessions().getIssueSession(comment.issueSessionId) : null;
    const sourceTask = comment.taskId ? this.ctx.tasks().getTask(comment.taskId) : null;
    const sourceSession = sourceTask?.issueSessionId
      ? this.ctx.issueSessions().getIssueSession(sourceTask.issueSessionId) : null;
    // The user can still ask any agent a question in a side conversation;
    // only model-authored dispatch is forbidden, including deferred mentions.
    if (comment.authorType === "agent" && (
      (session && session.inheritMode !== "none")
      || (sourceSession && sourceSession.inheritMode !== "none")
    )) {
      for (const target of targets) {
        const agent = this.ctx.resolveRunnableAgentForAssignee(target.assigneeType, target.assigneeId);
        this.recordCommentMentionSkipped(issue, comment, agent, target, "side_session_delegation_blocked");
      }
      return [];
    }

    const tasks: MultiremiTask[] = [];
    const seenAgents = new Set<string>();
    const taskAuthoredByCommentAgent = comment.authorType === "agent"
      && !!comment.authorId
      && sourceTask?.agentId === comment.authorId
      && sourceTask.issueId === issue.id
      && sourceTask.issueSessionId === comment.issueSessionId;
    for (const target of targets) {
      const agent = this.ctx.resolveRunnableAgentForAssignee(target.assigneeType, target.assigneeId);
      if (!agent) {
        if (comment.authorType === "agent") {
          this.recordCommentMentionSkipped(issue, comment, null, target, "target_unavailable");
        }
        continue;
      }
      if (seenAgents.has(agent.id)) continue;
      if (comment.authorType === "agent" && comment.authorId === agent.id) {
        this.recordCommentMentionSkipped(issue, comment, agent, target, "self_mention");
        continue;
      }
      seenAgents.add(agent.id);

      const leaderDelegation = this.isSquadLeaderDelegation({
        issue,
        sourceTask,
        authorAgentId: comment.authorType === "agent" ? comment.authorId : null,
        targetAgentId: agent.id,
        issueSessionId: comment.issueSessionId,
      });
      const delegationReturn = comment.authorType === "agent"
        && taskAuthoredByCommentAgent
        && !!sourceTask?.delegationId
        && sourceTask.delegatedByAgentId === agent.id;
      if (delegationReturn) {
        const wakeInput = {
          sourceTaskId: sourceTask!.id,
          requiredEventSeq,
          triggerCommentId: comment.id,
        };
        const wakeup = deferredEvents && childStatusChanges
          ? this.ctx.tasks().ensureDelegationWakeupWithinTransaction(wakeInput, childStatusChanges, deferredEvents)
          : this.ctx.tasks().ensureDelegationWakeup(wakeInput);
        if (wakeup.task) tasks.push(wakeup.task);
        continue;
      }
      if (comment.authorType === "agent" && !leaderDelegation.ok) {
        this.recordCommentMentionSkipped(
          issue,
          comment,
          agent,
          target,
          taskAuthoredByCommentAgent ? "unsupported_direction" : "unlinked_agent_comment",
        );
        continue;
      }


      // A rich mention is the same leader talking to the same teammate again.
      // Continue the lane that teammate already owns in this Session so it
      // keeps one provider conversation and receives a delta; a teammate that
      // has never been delegated to still gets a fresh lane, and `remi task
      // create` remains the explicit way to start an independent one.
      const continuedDelegation = leaderDelegation.ok
        ? this.latestDelegatedTaskForAgent(issue.id, agent.id, comment.authorId, comment.issueSessionId)
        : null;
      const delegationId = leaderDelegation.ok
        ? continuedDelegation?.delegationId ?? createId("dlg")
        : null;
      let task: MultiremiTask;
      try {
        const createInput: CreateTaskInput = {
          agentId: agent.id,
          issueId: issue.id,
          triggerCommentId: comment.id,
          workspaceId: issue.workspaceId,
          prompt: commentMentionPrompt(comment),
          delegationId,
          delegatedByAgentId: delegationId ? comment.authorId : null,
          assignmentAuthorType: comment.authorType,
          assignmentAuthorId: comment.authorId,
          dependencyForce: comment.authorType === "member"
            ? {
                source: "mention",
                actorMemberId: comment.authorId ?? "local",
                commentId: comment.id,
              }
            : undefined,
        };
        task = comment.authorType === "member"
          ? this.dispatchHumanCommentRound(issue, comment, agent, createInput, deferredEvents, childStatusChanges)
          : this.dispatchCommentPendingTurn(issue, comment, agent, createInput, "mention", deferredEvents, childStatusChanges);
      } catch (err) {
        // MUL-400 E3 gate 3: the mention is persisted either way; on a waiting
        // issue the platform records the hold instead of starting a round, and
        // the mention's own skip activity says so.
        if (!(err instanceof IssueDependencyError)) throw err;
        this.recordCommentMentionSkipped(issue, comment, agent, target, "dependencies_unmet", deferredEvents);
        continue;
      }
      tasks.push(task);
      if (task.triggerCommentId !== comment.id) continue;
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
          delegationId,
          delegatedByAgentId: delegationId ? comment.authorId : null,
        },
      });
    }
    return tasks;
  }

  private recordCommentMentionSkipped(
    issue: MultiremiIssue,
    comment: MultiremiIssueComment,
    agent: MultiremiAgent | null,
    target: { assigneeType: "agent" | "squad"; assigneeId: string },
    reason:
      | "self_mention"
      | "unsupported_direction"
      | "unlinked_agent_comment"
      | "target_unavailable"
      | "side_session_delegation_blocked"
      | "dependencies_unmet",
    deferredEvents?: CommitEventQueue,
  ): void {
    this.ctx.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "comment_mention_skipped",
      body: `Skipped agent mention for ${agent?.name ?? target.assigneeId}`,
      data: {
        reason,
        commentId: comment.id,
        sourceTaskId: comment.taskId,
        assigneeType: target.assigneeType,
        assigneeId: target.assigneeId,
        agentId: agent?.id ?? null,
      },
    }, deferredEvents);
  }

  private dispatchHumanCommentRound(
    issue: MultiremiIssue,
    comment: MultiremiIssueComment,
    agent: MultiremiAgent,
    createInput: CreateTaskInput,
    deferredEvents?: CommitEventQueue,
    childStatusChanges?: ChildStatusChangeCollector,
  ): MultiremiTask {
    if (!HUMAN_COMMENT_JOINS_QUEUED_ROUND) return this.createCommentTriggeredTask(createInput, deferredEvents, childStatusChanges);
    return this.dispatchCommentPendingTurn(issue, comment, agent, createInput, null, deferredEvents, childStatusChanges);
  }

  private dispatchCommentPendingTurn(
    issue: MultiremiIssue,
    comment: MultiremiIssueComment,
    agent: MultiremiAgent,
    createInput: CreateTaskInput,
    wakeSource: "mention" | null,
    deferredEvents?: CommitEventQueue,
    childStatusChanges?: ChildStatusChangeCollector,
  ): MultiremiTask {
    const events = deferredEvents ?? createCommitEventQueue();
    const changes = childStatusChanges ?? [];
    const dispatch = () => {
      this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
      const entry = this.ctx.conversationLog().getConversationLogEntryById(comment.id);
      if (!entry || !comment.issueSessionId) throw new Error("Comment wake requires its conversation log entry");
      const result = this.ctx.tasks().ensurePendingTurnWithinTransaction({
        lane: { kind: "issue", issueSessionId: comment.issueSessionId, agentId: agent.id,
          executionScope: wakeSource ? createInput.delegationId ?? "" : "" },
        wake: { reason: createInput.dependencyForce?.source === "comment" ? "comment" : "mention",
          seq: entry.seq, commentId: comment.id },
        create: () => this.ctx.tasks().createTaskWithinWorkspaceLock({ ...createInput,
          issueSessionId: comment.issueSessionId, wakeSource,
        }, changes, events),
      });
      if (result.action === "created") events.enqueuedTasks.push(result.task!);
      return result.task!;
    };
    if (deferredEvents && childStatusChanges) return dispatch();
    const task = this.ctx.db.inTransaction ? dispatch() : this.ctx.db.transaction(dispatch)();
    afterCommit(this.ctx.db, () => {
      this.ctx.tasks().runCollectedChildStatusChanges(changes);
      this.ctx.emitCommitEvents(events);
    });
    return task;
  }

  private createCommentTriggeredTask(
    input: CreateTaskInput,
    deferredEvents?: CommitEventQueue,
    childStatusChanges?: ChildStatusChangeCollector,
  ): MultiremiTask {
    if (!deferredEvents || !childStatusChanges) return this.ctx.tasks().createTask(input);
    const task = this.ctx.tasks().createTaskWithinTransaction(input, childStatusChanges, deferredEvents);
    deferredEvents.enqueuedTasks.push(task);
    return task;
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

    return targets;
  }

  /**
   * MUL-400 E2b: is a task-token dispatch a squad-leader delegation, and where
   * does its terminal report return?
   *
   * The same-issue branch is the pre-E2b rule, byte for byte: the leader's own
   * task, its own Session, a squad-owned issue, and a teammate. A dispatch to a
   * *different* issue is the E2b extension: the delegator's issue must still be
   * the squad's, its task must carry a main Session, and the target issue must
   * sit in the delegator's own subtree or in the subtree of its parent (child,
   * grandchild, sibling, sibling's descendant), walking up at most 16 levels
   * with a visited set. The return always lands on the delegator's Issue
   * Session, never on the child issue's Session.
   *
   * A failed cross-issue judgement returns a reason that the task carries to
   * its terminal hook, so the silence that hid MUL-383 becomes auditable. The
   * same-issue branch returns `reason: null`: its behaviour is deliberately
   * unchanged, so a non-delegating same-issue dispatch stays exactly as quiet as
   * it is today.
   */
  isSquadLeaderDelegation(input: {
    issue: MultiremiIssue;
    sourceTask: MultiremiTask | null;
    authorAgentId: string | null;
    targetAgentId: string;
    issueSessionId: string | null;
  }): SquadLeaderDelegationDecision {
    const { issue, sourceTask, authorAgentId, targetAgentId, issueSessionId } = input;
    if (!authorAgentId || !sourceTask || sourceTask.agentId !== authorAgentId) {
      return { ok: false, reason: null };
    }
    if (sourceTask.issueId === issue.id) {
      if (
        sourceTask.issueSessionId !== issueSessionId
        || issue.assigneeType !== "squad"
        || !issue.assigneeId
      ) return { ok: false, reason: null };
      const squad = this.ctx.squads().getSquad(issue.assigneeId);
      if (!squad || squad.archivedAt || squad.leaderId !== authorAgentId) return { ok: false, reason: null };
      const teammate = this.ctx.squads().listSquadMembers(squad.id).some((member) =>
        member.memberType === "agent"
        && member.memberId === targetAgentId
        && member.memberId !== authorAgentId
      );
      if (!teammate) return { ok: false, reason: null };
      return { ok: true, delegatedFromIssueSessionId: sourceTask.issueSessionId! };
    }

    if (!sourceTask.issueId || !sourceTask.issueSessionId) {
      return { ok: false, reason: "source_not_issue_task" };
    }
    const sourceIssue = this.getIssue(sourceTask.issueId);
    if (!sourceIssue || sourceIssue.workspaceId !== issue.workspaceId) {
      return { ok: false, reason: "cross_issue_no_lineage" };
    }
    const sourceSession = this.ctx.issueSessions().getIssueSession(sourceTask.issueSessionId);
    if (!sourceSession || sourceSession.inheritMode !== "none") {
      return { ok: false, reason: "source_side_session" };
    }
    if (sourceIssue.assigneeType !== "squad" || !sourceIssue.assigneeId) {
      return { ok: false, reason: "source_not_squad_leader" };
    }
    const squad = this.ctx.squads().getSquad(sourceIssue.assigneeId);
    if (!squad || squad.archivedAt || squad.leaderId !== authorAgentId) {
      return { ok: false, reason: "source_not_squad_leader" };
    }
    if (targetAgentId === authorAgentId) return { ok: false, reason: "self_dispatch" };
    const teammate = this.ctx.squads().listSquadMembers(squad.id).some((member) =>
      member.memberType === "agent" && member.memberId === targetAgentId
    );
    if (!teammate) return { ok: false, reason: "target_not_squad_member" };
    if (!this.isIssueInDelegationTree(sourceIssue, issue)) {
      return { ok: false, reason: "cross_issue_no_lineage" };
    }
    return { ok: true, delegatedFromIssueSessionId: sourceTask.issueSessionId };
  }

  /**
   * MUL-400 E2b scope rule: the target issue is the delegator's own issue, a
   * descendant of it, or a descendant of its parent (which covers siblings and
   * their subtrees). Bounded to 16 hops with a visited set, so a malformed
   * parent chain cannot loop and a deep tree cannot cost unbounded reads.
   */
  private isIssueInDelegationTree(sourceIssue: MultiremiIssue, targetIssue: MultiremiIssue): boolean {
    if (sourceIssue.id === targetIssue.id) return true;
    const allowedRoots = new Set<string>([sourceIssue.id]);
    const sourceParent = this.sameWorkspaceParent(sourceIssue);
    if (sourceParent) allowedRoots.add(sourceParent.id);
    const seen = new Set<string>();
    let cursor: string | null = targetIssue.id;
    for (let depth = 0; cursor && depth <= DELEGATION_TREE_MAX_DEPTH; depth += 1) {
      if (allowedRoots.has(cursor)) return true;
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const current = this.getIssue(cursor);
      cursor = current ? this.sameWorkspaceParent(current)?.id ?? null : null;
    }
    return false;
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

  /**
   * The most recent task this delegator handed to this agent in the same Issue
   * Session. A rich mention continues that delegation instead of starting a new
   * lane, so re-mentioning a teammate resumes its provider conversation rather
   * than cold-bootstrapping the whole Issue again.
   */
  private latestDelegatedTaskForAgent(
    issueId: string,
    agentId: string,
    delegatedByAgentId: string | null,
    issueSessionId: string | null,
  ): MultiremiTask | null {
    if (!delegatedByAgentId) return null;
    const sessionClause = issueSessionId === null
      ? "issue_session_id IS NULL"
      : "issue_session_id = ?";
    const params: unknown[] = issueSessionId === null
      ? [issueId, agentId, delegatedByAgentId]
      : [issueId, agentId, delegatedByAgentId, issueSessionId];
    const row = this.ctx.db.query(
      `SELECT id FROM multiremi_tasks
       WHERE issue_id = ? AND agent_id = ? AND delegated_by_agent_id = ?
         AND delegation_id IS NOT NULL
         AND ${sessionClause}
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(...params) as { id: string } | null;
    return row ? this.ctx.tasks().getTask(row.id) : null;
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

function escapeDependencyCheckEventIdForLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function toIssueDecision(row: Row): MultiremiIssueDecision {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), issueId: String(row.issue_id),
    sourceIssueId: String(row.source_issue_id), sourceTaskId: nullableString(row.source_task_id),
    kind: String(row.kind) as MultiremiIssueDecisionKind, title: String(row.title), body: String(row.body ?? ""),
    options: parseJson<string[] | null>(nullableString(row.options), null),
    status: String(row.status) as MultiremiIssueDecision["status"],
    answer: parseJson<MultiremiIssueDecisionAnswer | null>(nullableString(row.answer), null),
    answeredByMemberId: nullableString(row.answered_by_member_id),
    answeredAt: nullableString(row.answered_at),
    history: parseJson<MultiremiIssueDecisionAnswer[]>(nullableString(row.history), []),
    ownerAgentId: nullableString(row.owner_agent_id), createdByAgentId: nullableString(row.created_by_agent_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function decisionEntry(decision: MultiremiIssueDecision, bucket: MultiremiIssueDecisionEntry["bucket"]): MultiremiIssueDecisionEntry {
  return {
    id: decision.id, bucket, type: "decision", kind: decision.kind, title: decision.title,
    body: decision.body, status: decision.status, issueId: decision.issueId,
    sourceIssueId: decision.sourceIssueId, sourceTaskId: decision.sourceTaskId,
    options: decision.options, answer: decision.answer,
    // MUL-414 (S7) renders "the owner already decided" from the whole trail, so
    // the entry carries every answer. Human requests have no such trail.
    history: decision.history,
    createdAt: decision.createdAt, updatedAt: decision.updatedAt,
  };
}

function compareDecisionEntries(a: MultiremiIssueDecisionEntry, b: MultiremiIssueDecisionEntry): number {
  return DECISION_KIND_ORDER[a.kind] - DECISION_KIND_ORDER[b.kind]
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function commentMentionPrompt(_comment: MultiremiIssueComment): string {
  return "A teammate mentioned you in an issue comment. Respond to the current triggering comment.";
}

function assigneeCommentPrompt(_comment: MultiremiIssueComment): string {
  return "A teammate commented on an issue assigned to you. Respond to the current triggering comment as the issue's assignee.";
}


/**
 * MUL-400 E2 system comment. The old body told the parent owner to read every
 * sibling description and promote backlog items by hand; dependency-declared
 * children start themselves (S2), so this notification only asks for a review.
 */
function childStatusSystemCommentBody(input: {
  mentionPrefix: string;
  childKey: string;
  childId: string;
  childTitle: string;
  outcome: ChildTerminalOutcome;
  childStatus: string;
  /** MUL-400 E3: dependents that became startable because of this child. */
  readinessLines?: string[];
}): string {
  const title = sanitizeChildDoneTitle(input.childTitle);
  const verb = childOutcomeSentence(input.outcome);
  return [
    `${input.mentionPrefix}Sub-issue [${input.childKey}](mention://issue/${input.childId}) - "${title}" - ${verb}.`,
    `Its status is now ${input.childStatus}; a platform round was queued for the owner of this issue.`,
    "Children whose dependencies are declared as `blocked_by` are promoted automatically, so this report only needs a review of the outcome.",
    ...(input.readinessLines?.length
      ? [`Dependencies satisfied: ${input.readinessLines.join(" ")}`]
      : []),
  ].join(" ");
}

function childOutcomeSentence(outcome: ChildTerminalOutcome): string {
  switch (outcome) {
    case "failed": return "failed";
    case "blocked": return "is blocked";
    case "cancelled": return "was cancelled";
    default: return "is done";
  }
}

function childOutcomeLabel(outcome: ChildTerminalOutcome): string {
  switch (outcome) {
    case "failed": return "failed";
    case "blocked": return "is blocked";
    case "cancelled": return "was cancelled";
    default: return "is done";
  }
}

function childStatusInboxBody(child: MultiremiIssue, outcome: ChildTerminalOutcome): string {
  return `${child.key} ${childOutcomeLabel(outcome)}: ${sanitizeChildDoneTitle(child.title)}`;
}

function sanitizeChildDoneTitle(title: string): string {
  return title.replaceAll("](mention://", "] (mention-stripped://").trim();
}

function sanitizeChildDoneMentionLabel(name: string): string {
  const cleaned = name.replaceAll("]", "").trim();
  return cleaned || "assignee";
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

function validatePublicIssueMetadataKey(key: string): void {
  if (key === "auto_title") throw new Error("auto_title is reserved for system metadata");
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

function validateIssueMetadataSize(metadata: Record<string, unknown>): void {
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

/** MUL-400 E3: `blocked_by` accepts keys or ids, in either spelling. */
function normalizeIssueRefList(value: unknown): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    const ref = String(item ?? "").trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

function prerequisiteStatusSentence(status: string): string {
  if (status === "cancelled") return "was cancelled";
  if (status === "blocked") return "is blocked";
  if (status === "failed") return "failed";
  return `is ${status}`;
}

function normalizeIssueDependencyType(value: string | undefined): MultiremiIssueDependencyType {
  const type = String(value ?? "related").trim().toLowerCase();
  if (type === "blocks" || type === "blocked_by" || type === "related") return type;
  throw new Error("dependency type must be one of blocks, blocked_by, or related");
}

function issueMatchesListFilter(
  issue: MultiremiIssue,
  input: ListIssuesInput,
  parentResolver?: (ref: string) => string | null,
): boolean {
  const archivedOnly = input.archivedOnly ?? input.archived_only ?? false;
  const includeArchived = input.includeArchived ?? input.include_archived ?? false;
  if (archivedOnly ? !issue.archivedAt : !includeArchived && issue.archivedAt) return false;
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
  if (input.topLevelOnly ?? input.top_level_only ?? false) {
    if (issue.parentIssueId !== null && (!parentResolver || parentResolver(issue.parentIssueId) !== null)) return false;
  } else {
    const parentId = input.parentId ?? input.parent_id;
    if (parentId) {
      const parent = parentResolver?.(parentId) ?? parentId;
      if (issue.parentIssueId !== parent) return false;
      if (parentResolver && issue.parentIssueId && parentResolver(issue.parentIssueId) === null) return false;
    }
  }
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

  const archivedOnly = input.archivedOnly ?? input.archived_only ?? false;
  const includeArchived = input.includeArchived ?? input.include_archived ?? false;
  if (archivedOnly) clauses.push("archived_at IS NOT NULL");
  else if (!includeArchived) clauses.push("archived_at IS NULL");

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
  // MUL-400 E3: hierarchy filters. `top_level_only` wins over `parent_id` so a
  // caller can pass both without ambiguity.
  if (input.topLevelOnly ?? input.top_level_only ?? false) {
    clauses.push(`(parent_issue_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM multiremi_issues parent
      WHERE parent.id = multiremi_issues.parent_issue_id
        AND parent.workspace_id = multiremi_issues.workspace_id
    ))`);
  } else {
    const parentId = input.parentId ?? input.parent_id;
    if (parentId) {
      clauses.push(`parent_issue_id = ? AND EXISTS (
        SELECT 1 FROM multiremi_issues parent
        WHERE parent.id = multiremi_issues.parent_issue_id
          AND parent.workspace_id = multiremi_issues.workspace_id
      )`);
      params.push(parentId);
    }
  }

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

function isTerminalIssueStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
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
    "runtimeWorkspaceId",
    "runtime_workspace_id",
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

function quickCreateTaskPrompt(prompt: string, projectId: string | null, runtimeWorkspaceId: string | null): string {
  const projectInstructions = runtimeWorkspaceId
    ? [
        `The user explicitly selected runtime workspace ${runtimeWorkspaceId} as the work location.`,
        `Create each execution issue with --runtime-workspace ${runtimeWorkspaceId}. Leave project_id unset; do not assign a project.`,
        "Use the existing local directory and its context; no project checkout is needed.",
      ]
    : projectId
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
    ...(runtimeWorkspaceId ? [] : ["Read the available project snapshots and exported knowledge under `projects/<project>/` before deciding."]),
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

function inboxDateGroup(
  createdAt: string,
  now: Date,
  timezoneOffsetMinutes: number,
): "today" | "yesterday" | "this_week" | "earlier" {
  const localTimestamp = (value: Date) => value.getTime() - timezoneOffsetMinutes * 60_000;
  const shiftedNow = new Date(localTimestamp(now));
  const startToday = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
  );
  const startYesterday = startToday - 86_400_000;
  const daySinceMonday = (shiftedNow.getUTCDay() + 6) % 7;
  const startWeek = startToday - daySinceMonday * 86_400_000;
  const timestamp = localTimestamp(new Date(createdAt));
  if (timestamp >= startToday) return "today";
  if (timestamp >= startYesterday) return "yesterday";
  if (timestamp >= startWeek) return "this_week";
  return "earlier";
}

function encodeInboxCursor(row: Row): string {
  return Buffer.from(JSON.stringify([String(row.created_at), String(row.id)]), "utf8").toString("base64url");
}

function decodeInboxCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(value)
      || value.length !== 2
      || value.some((part) => typeof part !== "string" || !part)
      || !Number.isFinite(Date.parse(String(value[0])))
    ) {
      throw new Error("invalid payload");
    }
    return { createdAt: value[0] as string, id: value[1] as string };
  } catch {
    throw new Error("Invalid inbox cursor");
  }
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
    runtimeWorkspaceId: nullableString(row.runtime_workspace_id),
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
    parentDoneGrantAt: nullableString(row.parent_done_grant_at),
    parentDoneGrantBy: nullableString(row.parent_done_grant_by),
    parentDoneGrantAgentId: nullableString(row.parent_done_grant_agent_id),
    createdBy: nullableString(row.created_by),
    completedAt: nullableString(row.completed_at),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChildIssueProgress(row: Row): MultiremiIssueChildProgress {
  return {
    parentIssueId: String(row.parent_issue_id),
    total: Number(row.total ?? 0),
    done: Number(row.done ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    blocked: Number(row.blocked ?? 0),
    waiting: Number(row.waiting ?? 0),
    active: Number(row.active ?? 0),
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

function sanitizeAutoTitleMetadata(raw: Record<string, unknown>): MultiremiIssueAutoTitleMetadata {
  const source = raw.source === "auto" || raw.source === "manual" ? raw.source : undefined;
  return {
    ...(raw.locked === true ? { locked: true } : {}),
    ...(typeof raw.generated_at === "string" ? { generated_at: raw.generated_at } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(source ? { source } : {}),
    ...(typeof raw.content_hash === "string" ? { content_hash: raw.content_hash } : {}),
    ...(typeof raw.count === "number" && Number.isFinite(raw.count) ? { count: raw.count } : {}),
  };
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
