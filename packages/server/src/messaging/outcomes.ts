import type {
  MultiremiAssigneeType,
  MultiremiInboxItem,
  MultiremiIssue,
} from "@multiremi/contracts/types.js";
import type {
  MessageErrorCode,
  MessageOutcome,
  MessageOutcomeKind,
} from "@multiremi/contracts/messaging.js";
import { nowIso } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { INBOX_ROUTING } from "@multiremi/store/inbox-routing.js";
import type { MessagingRepo } from "@multiremi/store/repos/messaging-repo.js";
import type { StoredCanonicalMessage } from "@multiremi/store/repos/messaging-repo.js";

/**
 * What the outcome service needs from the store beyond the Messaging tables.
 *
 * Deliberately narrow: `MessagingRepo` stays pure persistence over the
 * `multiremi_message_*` tables, and everything that reaches into Inbox or
 * Issues — two subsystems the Core does not own — goes through here.
 */
export type MessagingOutcomeHost = Pick<
  StoreContext,
  "db" | "createInboxItem" | "resolveWorkspaceMemberForNotification" | "isNotificationMuted" | "issues"
>;

export interface MessageRef {
  connectionId: string;
  externalMessageId: string;
}

/**
 * Inbox types the Core writes.
 *
 * These strings are a persisted contract: existing inbox rows, notification
 * mute preferences and the routing table in `inbox-routing.ts` all key on
 * them. They name the channel, not the transport that fed it, so they stay
 * correct after the Personal Automation path is gone. Adding a second channel
 * means adding its own entries here and in the routing table, not renaming
 * these.
 */
const INBOX_TYPE_BY_KIND: Record<"notified" | "reply_drafted" | "issue_proposed", string> = {
  notified: "feishu_message_notification",
  reply_drafted: "feishu_reply_draft",
  issue_proposed: "feishu_issue_proposal",
};

const INBOX_TITLE_BY_KIND: Record<"notified" | "reply_drafted" | "issue_proposed", string> = {
  notified: "飞书消息提醒",
  reply_drafted: "飞书回复草稿",
  issue_proposed: "建议创建 Issue",
};

/** Outcomes a caller may record directly. The rest have a dedicated command. */
const DIRECT_OUTCOME_KINDS = new Set<MessageOutcomeKind>(["ignored", "dismissed"]);

/** Consecutive sync failures before the operator is told. One failure is usually a blip. */
const SOURCE_ALERT_THRESHOLD = 3;

/** Persisted alongside existing rows written by the pre-Core path; do not rename. */
const SOURCE_ALERT_INBOX_TYPE = "feishu_ingest_connection_alert";

/**
 * Every Inbox type the Core can write.
 *
 * The Core picks its type from a table rather than writing a literal at each
 * call, which the static scan in `inbox-routing.test.ts` cannot follow. This
 * list is what that test checks instead — exactly, rather than by regex.
 */
export const MESSAGING_INBOX_TYPES: readonly string[] = [
  ...Object.values(INBOX_TYPE_BY_KIND),
  SOURCE_ALERT_INBOX_TYPE,
];

/**
 * How loudly an Inbox type is written, read from the routing table.
 *
 * Restating the severity here would let the two drift, and the table is the
 * side that other subsystems and the frontend already agree on.
 */
function inboxSeverity(type: string): "info" | "attention" {
  const registered = INBOX_ROUTING[type];
  if (!registered) throw new Error(`Unregistered inbox type: ${type}`);
  return registered.severity;
}

const log = createLogger("multiremi-messaging");

export interface RecordDirectOutcomeInput {
  workspaceId: string;
  outcome: MessageOutcomeKind;
  reason?: string | null;
  taskId?: string | null;
}

export interface MessageInboxOutcomeInput {
  workspaceId: string;
  recipientId: string;
  taskId?: string | null;
  actorType: "agent" | "member";
  actorId: string | null;
  text: string;
}

export interface MessageIssueInput {
  title: string;
  description?: string | null;
  priority?: string | null;
  projectId?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
}

export interface MessageIssueOutcomeInput extends MessageIssueInput {
  workspaceId: string;
  taskId?: string | null;
  createdBy?: string | null;
}

export interface MessageIssueProposalInput extends MessageIssueInput {
  workspaceId: string;
  recipientId: string;
  taskId?: string | null;
  actorType: "agent" | "member";
  actorId: string | null;
}

export interface MessageOutcomeResult {
  message: StoredCanonicalMessage;
  outcome: MessageOutcome;
}

export interface MessageInboxOutcomeResult extends MessageOutcomeResult {
  inboxItem: MultiremiInboxItem | null;
  delivered: boolean;
}

export interface MessageIssueOutcomeResult extends MessageOutcomeResult {
  issue: MultiremiIssue;
  created: boolean;
}

export interface MessageIssueProposalResult extends MessageOutcomeResult {
  proposal: MessageOutcome | null;
  inboxItem: MultiremiInboxItem | null;
  delivered: boolean;
  created: boolean;
}

export interface ResolveMessageProposalResult extends MessageOutcomeResult {
  proposal: MessageOutcome;
  issue: MultiremiIssue | null;
  created: boolean;
}

export class MessagingOutcomeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "MessagingOutcomeError";
  }
}

/**
 * What a human or an agent decided about an ingested message.
 *
 * Sits above `MessagingRepo` rather than inside it: recording an outcome can
 * create an Inbox item or an Issue, and those belong to other subsystems. The
 * repo keeps its `Pick<StoreContext, "db">` boundary; this class holds the
 * orchestration.
 */
export class MessagingOutcomeService {
  constructor(
    private readonly ctx: MessagingOutcomeHost,
    private readonly repo: MessagingRepo,
  ) {}

  /**
   * Tells somebody once a Source has failed enough times in a row.
   *
   * Counting the failure is the repo's job; this reads the count and decides
   * whether it has become a person's problem. The threshold exists because a
   * single failure is usually a blip the next tick fixes, while three in a row
   * is a credential or a dependency that a human has to look at. The alert
   * bypasses mute — a Source that has stopped ingesting is not a notification
   * the operator opted out of, it is the feature being broken.
   */
  alertOnSourceFailure(sourceId: string, errorCode: MessageErrorCode, failedAt: string): MultiremiInboxItem | null {
    return this.ctx.db.transaction(() => {
      const source = this.repo.getSource(sourceId);
      if (!source || source.consecutiveFailures < SOURCE_ALERT_THRESHOLD) return null;
      const status = this.repo.getSourceStatus(sourceId);
      if (status?.alertedAt) return null;
      const recipient = this.ctx.db.query(
        `SELECT id FROM multiremi_workspace_members
         WHERE workspace_id = ? AND archived_at IS NULL
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                  created_at ASC, id ASC
         LIMIT 1`,
      ).get(source.workspaceId) as { id?: unknown } | null;
      if (!recipient?.id) {
        this.failAlertDelivery(sourceId, "alert_recipient_unavailable", failedAt);
        return null;
      }
      const item = this.ctx.createInboxItem({
        workspaceId: source.workspaceId,
        memberId: String(recipient.id),
        severity: inboxSeverity(SOURCE_ALERT_INBOX_TYPE),
        type: SOURCE_ALERT_INBOX_TYPE,
        title: "消息源连接异常",
        body: `消息源 ${source.name} 连续拉取失败，请检查连接状态。`,
        actorType: "system",
        actorId: null,
        details: {
          source_id: sourceId,
          // The sentence above is server-rendered in one language; the name and
          // code repeat as fields so a client can build a localized line.
          source_name: source.name,
          connection_id: source.connectionId,
          error_code: errorCode,
          consecutive_failures: source.consecutiveFailures,
        },
        emitEvent: true,
        bypassMute: true,
      });
      if (!item) {
        this.failAlertDelivery(sourceId, "alert_inbox_create_failed", failedAt);
        return null;
      }
      this.repo.markSourceAlerted(sourceId, failedAt);
      return item;
    })();
  }

  /**
   * An undelivered alert is worse than a failing Source, so it is both stored
   * and logged. The line carries the id and the reason and nothing else: the
   * Source name is operator-supplied and can hold anything.
   */
  private failAlertDelivery(sourceId: string, errorCode: string, failedAt: string): void {
    this.repo.recordSourceAlertDeliveryFailure(sourceId, errorCode, failedAt);
    log.warn(`Message source alert delivery failed for source ${sourceId}: ${errorCode}`);
  }

  /**
   * Records an outcome that needs no side effect.
   *
   * `notified`, `reply_drafted`, `issue_proposed` and `issue_created` are
   * refused here: each of them writes somewhere else too, and letting a caller
   * assert one directly would leave an outcome claiming an Inbox item or an
   * Issue that was never created.
   */
  record(ref: MessageRef, input: RecordDirectOutcomeInput): MessageOutcomeResult {
    if (!DIRECT_OUTCOME_KINDS.has(input.outcome)) {
      throw new MessagingOutcomeError(`${input.outcome} outcomes must use their dedicated command`);
    }
    const reason = cleanText(input.reason);
    if (!reason) throw new MessagingOutcomeError(`reason is required for ${input.outcome} outcomes`);
    return this.ctx.db.transaction(() => {
      const message = this.requireMessage(ref, input.workspaceId);
      const taskId = cleanText(input.taskId);
      this.assertTaskWorkspace(taskId, input.workspaceId);
      const createdAt = nowIso();
      const outcome = this.repo.recordOutcome({
        workspaceId: input.workspaceId,
        connectionId: ref.connectionId,
        externalMessageId: ref.externalMessageId,
        outcomeKind: input.outcome,
        reason,
        taskId,
        createdAt,
      });
      return { message: this.markProcessed(ref, message, createdAt), outcome };
    })();
  }

  /** Surfaces a message to a person: a reminder, or a reply for them to send. */
  notify(
    ref: MessageRef,
    kind: "notified" | "reply_drafted",
    input: MessageInboxOutcomeInput,
  ): MessageInboxOutcomeResult {
    const text = requireText(input.text, kind === "notified" ? "summary" : "draft_text");
    return this.ctx.db.transaction(() => {
      const message = this.requireMessage(ref, input.workspaceId);
      const taskId = cleanText(input.taskId);
      this.assertTaskWorkspace(taskId, input.workspaceId);
      const inboxType = INBOX_TYPE_BY_KIND[kind];
      const recipient = this.requireRecipient(input.workspaceId, input.recipientId);
      if (this.ctx.isNotificationMuted(input.workspaceId, recipient, inboxType)) {
        return { ...this.dismissMuted(ref, input.workspaceId, taskId, message), inboxItem: null, delivered: false };
      }
      const inboxItem = this.ctx.createInboxItem({
        workspaceId: input.workspaceId,
        memberId: recipient,
        severity: inboxSeverity(inboxType),
        type: inboxType,
        title: INBOX_TITLE_BY_KIND[kind],
        body: text,
        actorType: input.actorType,
        actorId: input.actorId,
        details: this.inboxDetails(message, kind),
        emitEvent: false,
      });
      if (!inboxItem) {
        // `createInboxItem` returns null both for a mute that landed between
        // the check above and the insert, and for a recipient that became
        // unusable. Re-checking tells the two apart.
        if (this.ctx.isNotificationMuted(input.workspaceId, recipient, inboxType)) {
          return { ...this.dismissMuted(ref, input.workspaceId, taskId, message), inboxItem: null, delivered: false };
        }
        throw new MessagingOutcomeError("Inbox recipient is unavailable");
      }
      const createdAt = nowIso();
      const outcome = this.repo.recordOutcome({
        workspaceId: input.workspaceId,
        connectionId: ref.connectionId,
        externalMessageId: ref.externalMessageId,
        outcomeKind: kind,
        ref: `inbox:${inboxItem.id}`,
        taskId,
        createdAt,
      });
      return {
        message: this.markProcessed(ref, message, createdAt),
        outcome,
        inboxItem,
        delivered: true,
      };
    })();
  }

  /** Creates the Issue directly. Reserved for a human who may approve. */
  createIssue(ref: MessageRef, input: MessageIssueOutcomeInput): MessageIssueOutcomeResult {
    const issueInput = normalizeIssueInput(input);
    return this.ctx.db.transaction(() => this.createIssueWithinTransaction(ref, {
      ...issueInput,
      workspaceId: input.workspaceId,
      taskId: cleanText(input.taskId),
      createdBy: cleanText(input.createdBy),
    }))();
  }

  /** Asks a person to approve creating an Issue, without creating one yet. */
  proposeIssue(ref: MessageRef, input: MessageIssueProposalInput): MessageIssueProposalResult {
    const issueInput = normalizeIssueInput(input);
    return this.ctx.db.transaction(() => {
      const message = this.requireMessage(ref, input.workspaceId);
      const taskId = cleanText(input.taskId);
      this.assertTaskWorkspace(taskId, input.workspaceId);
      this.lockMessage(ref);
      const existing = this.findOutcome(ref, "issue_proposed");
      if (existing) {
        // Proposing twice is a retry, not a second proposal: returning the
        // first one keeps a re-sent request from asking a human the same
        // question again.
        return {
          message: this.requireMessage(ref, input.workspaceId),
          outcome: existing,
          proposal: existing,
          inboxItem: null,
          delivered: true,
          created: false,
        };
      }
      const inboxType = INBOX_TYPE_BY_KIND.issue_proposed;
      const recipient = this.requireRecipient(input.workspaceId, input.recipientId);
      const muted = (): MessageIssueProposalResult => ({
        ...this.dismissMuted(ref, input.workspaceId, taskId, message),
        proposal: null,
        inboxItem: null,
        delivered: false,
        created: true,
      });
      if (this.ctx.isNotificationMuted(input.workspaceId, recipient, inboxType)) return muted();
      const createdAt = nowIso();
      const outcome = this.repo.recordOutcome({
        workspaceId: input.workspaceId,
        connectionId: ref.connectionId,
        externalMessageId: ref.externalMessageId,
        outcomeKind: "issue_proposed",
        taskId,
        createdAt,
        proposalPayload: { ...issueInput },
        proposalStatus: "pending",
      });
      const inboxItem = this.ctx.createInboxItem({
        workspaceId: input.workspaceId,
        memberId: recipient,
        severity: inboxSeverity(inboxType),
        type: inboxType,
        title: INBOX_TITLE_BY_KIND.issue_proposed,
        body: issueInput.title,
        actorType: input.actorType,
        actorId: input.actorId,
        details: {
          proposal_id: outcome.id,
          proposed_issue: issueInput,
          ...this.inboxDetails(message, "issue_proposed"),
        },
        emitEvent: false,
      });
      if (!inboxItem) {
        if (this.ctx.isNotificationMuted(input.workspaceId, recipient, inboxType)) return muted();
        throw new MessagingOutcomeError("Inbox recipient is unavailable");
      }
      this.repo.attachOutcomeRef(outcome.id, `inbox:${inboxItem.id}`);
      const stored = this.repo.getOutcome(outcome.id)!;
      return {
        message: this.markProcessed(ref, message, createdAt),
        outcome: stored,
        proposal: stored,
        inboxItem,
        delivered: true,
        created: true,
      };
    })();
  }

  approveProposal(proposalId: string, input: { workspaceId: string; approvedBy: string }): ResolveMessageProposalResult {
    return this.ctx.db.transaction(() => {
      const proposal = this.requireProposal(proposalId, input.workspaceId);
      const ref = { connectionId: proposal.connectionId, externalMessageId: proposal.externalMessageId };
      this.lockMessage(ref);
      const current = this.requireProposal(proposalId, input.workspaceId);
      if (current.proposalStatus === "rejected") {
        throw new MessagingOutcomeError("Proposal is already rejected", 409);
      }
      const result = this.createIssueWithinTransaction(ref, {
        ...normalizeIssueInput(current.proposalPayload),
        workspaceId: input.workspaceId,
        taskId: null,
        createdBy: input.approvedBy,
      });
      this.repo.resolveProposal({
        id: proposalId,
        workspaceId: input.workspaceId,
        status: "approved",
        resolvedBy: input.approvedBy,
      });
      this.markProposalInboxHandled(current.ref);
      return { ...result, proposal: this.requireProposal(proposalId, input.workspaceId) };
    })();
  }

  rejectProposal(proposalId: string, input: { workspaceId: string; rejectedBy: string }): ResolveMessageProposalResult {
    return this.ctx.db.transaction(() => {
      const proposal = this.requireProposal(proposalId, input.workspaceId);
      const ref = { connectionId: proposal.connectionId, externalMessageId: proposal.externalMessageId };
      this.lockMessage(ref);
      const current = this.requireProposal(proposalId, input.workspaceId);
      if (current.proposalStatus === "approved") {
        throw new MessagingOutcomeError("Proposal is already approved", 409);
      }
      const message = this.requireMessage(ref, input.workspaceId);
      const existing = this.repo
        .listOutcomes(ref.connectionId, ref.externalMessageId)
        .find((entry) => entry.outcomeKind === "dismissed" && entry.reason === "proposal_rejected");
      const createdAt = nowIso();
      const outcome = existing ?? this.repo.recordOutcome({
        workspaceId: input.workspaceId,
        connectionId: ref.connectionId,
        externalMessageId: ref.externalMessageId,
        outcomeKind: "dismissed",
        reason: "proposal_rejected",
        createdAt,
      });
      this.repo.resolveProposal({
        id: proposalId,
        workspaceId: input.workspaceId,
        status: "rejected",
        resolvedBy: input.rejectedBy,
        resolvedAt: createdAt,
      });
      this.markProposalInboxHandled(current.ref);
      return {
        message: this.markProcessed(ref, message, createdAt),
        outcome,
        proposal: this.requireProposal(proposalId, input.workspaceId),
        issue: null,
        created: !existing,
      };
    })();
  }

  private createIssueWithinTransaction(
    ref: MessageRef,
    input: MessageIssueInput & { workspaceId: string; taskId: string | null; createdBy: string | null },
  ): MessageIssueOutcomeResult {
    const message = this.requireMessage(ref, input.workspaceId);
    this.assertTaskWorkspace(input.taskId, input.workspaceId);
    this.lockMessage(ref);
    const existing = this.findOutcome(ref, "issue_created");
    if (existing) {
      const issueId = existing.ref?.startsWith("issue:") ? existing.ref.slice("issue:".length) : "";
      const issue = issueId ? this.ctx.issues().getIssue(issueId) : null;
      if (!issue || issue.workspaceId !== input.workspaceId) {
        throw new MessagingOutcomeError("Existing issue outcome points at a missing Issue", 409);
      }
      return { message, outcome: existing, issue, created: false };
    }
    const issue = this.ctx.issues().createIssue({
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? undefined,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      assigneeType: input.assigneeType ?? null,
      assigneeId: input.assigneeId ?? null,
      contextRefs: [{
        type: "message",
        connection_id: ref.connectionId,
        external_message_id: ref.externalMessageId,
        source_id: message.sourceId,
        external_conversation_id: message.externalConversationId,
        message_url: message.url,
      }],
      createdBy: input.createdBy,
    });
    const createdAt = nowIso();
    const outcome = this.repo.recordOutcome({
      workspaceId: input.workspaceId,
      connectionId: ref.connectionId,
      externalMessageId: ref.externalMessageId,
      outcomeKind: "issue_created",
      ref: `issue:${issue.id}`,
      taskId: input.taskId,
      createdAt,
    });
    return { message: this.markProcessed(ref, message, createdAt), outcome, issue, created: true };
  }

  private dismissMuted(
    ref: MessageRef,
    workspaceId: string,
    taskId: string | null,
    message: StoredCanonicalMessage,
  ): MessageOutcomeResult {
    const createdAt = nowIso();
    const outcome = this.repo.recordOutcome({
      workspaceId,
      connectionId: ref.connectionId,
      externalMessageId: ref.externalMessageId,
      outcomeKind: "dismissed",
      reason: "recipient_muted",
      taskId,
      createdAt,
    });
    return { message: this.markProcessed(ref, message, createdAt), outcome };
  }

  private inboxDetails(message: StoredCanonicalMessage, outcomeKind: MessageOutcomeKind): Record<string, unknown> {
    return {
      connection_id: message.connectionId,
      external_message_id: message.externalMessageId,
      source_id: message.sourceId,
      external_conversation_id: message.externalConversationId,
      // Repeated as a field so the inbox row can name the conversation without
      // resolving the id against a list the reader may not have.
      conversation_name: message.conversationName,
      message_url: message.url,
      outcome_kind: outcomeKind,
    };
  }

  private requireMessage(ref: MessageRef, workspaceId: string): StoredCanonicalMessage {
    const message = this.repo.getMessage(ref.connectionId, ref.externalMessageId);
    if (!message || message.workspaceId !== workspaceId) {
      throw new MessagingOutcomeError("Message not found", 404);
    }
    return message;
  }

  private requireProposal(proposalId: string, workspaceId: string): MessageOutcome {
    const outcome = this.repo.getOutcome(proposalId);
    if (!outcome || outcome.workspaceId !== workspaceId || outcome.outcomeKind !== "issue_proposed") {
      throw new MessagingOutcomeError("Proposal not found", 404);
    }
    return outcome;
  }

  private requireRecipient(workspaceId: string, recipientId: string): string {
    const member = this.ctx.resolveWorkspaceMemberForNotification(workspaceId, recipientId);
    if (!member || member.archivedAt) throw new MessagingOutcomeError("Inbox recipient is unavailable");
    return member.id;
  }

  private findOutcome(ref: MessageRef, kind: MessageOutcomeKind): MessageOutcome | null {
    return this.repo
      .listOutcomes(ref.connectionId, ref.externalMessageId)
      .find((outcome) => outcome.outcomeKind === kind) ?? null;
  }

  private markProcessed(
    ref: MessageRef,
    message: StoredCanonicalMessage,
    processedAt: string,
  ): StoredCanonicalMessage {
    if (message.processedAt) return message;
    return this.repo.updateMessageProcessingState({ ...ref, processedAt }) ?? message;
  }

  private lockMessage(ref: MessageRef): void {
    // A no-op UPDATE: it exists to take a row lock on Postgres so two callers
    // racing on the same message serialize instead of both creating an Issue.
    this.ctx.db.run(
      `UPDATE multiremi_message_messages SET processed_at = processed_at
       WHERE connection_id = ? AND external_message_id = ?`,
      [ref.connectionId, ref.externalMessageId],
    );
  }

  private markProposalInboxHandled(outcomeRef: string | null): void {
    if (!outcomeRef?.startsWith("inbox:")) return;
    this.ctx.db.run(
      "UPDATE multiremi_inbox_items SET read = 1, archived = 1 WHERE id = ?",
      [outcomeRef.slice("inbox:".length)],
    );
  }

  private assertTaskWorkspace(taskId: string | null, workspaceId: string): void {
    if (!taskId) return;
    const row = this.ctx.db.query(
      "SELECT workspace_id FROM multiremi_tasks WHERE id = ?",
    ).get(taskId) as { workspace_id?: unknown } | null;
    if (!row || String(row.workspace_id ?? "") !== workspaceId) {
      throw new MessagingOutcomeError("task_id must reference a task in this workspace");
    }
  }
}

/**
 * Validates an Issue draft.
 *
 * Takes a loose record rather than {@link MessageIssueInput} because it is also
 * how a stored proposal payload is read back at approval time: that payload is
 * JSON that was written before the reviewer looked at it, so it earns the same
 * checks as a fresh request instead of a cast.
 */
function normalizeIssueInput(input: Record<string, unknown> | MessageIssueInput): MessageIssueInput {
  const description = cleanText(input.description);
  if (description && description.length > 20_000) {
    throw new MessagingOutcomeError("description must not exceed 20000 characters");
  }
  return {
    title: requireText(input.title, "title"),
    description,
    priority: cleanText(input.priority),
    projectId: cleanText(input.projectId),
    assigneeType: readAssigneeType(input.assigneeType),
    assigneeId: cleanText(input.assigneeId),
  };
}

function readAssigneeType(value: unknown): MultiremiAssigneeType | null {
  return value === "agent" || value === "member" || value === "squad" ? value : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requireText(value: unknown, field: string): string {
  const cleaned = cleanText(value);
  if (!cleaned) throw new MessagingOutcomeError(`${field} is required`);
  return cleaned;
}
