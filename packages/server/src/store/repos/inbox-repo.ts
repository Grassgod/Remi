import { createHash } from "node:crypto";
import { envelopePriority, type Envelope, type EnvelopeMetadata } from "@multiremi/contracts/inbox.js";
import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log";
import { createId } from "@multiremi/ids.js";
import type { CommitEventQueue, StoreContext } from "@multiremi/store/context.js";
import { afterCommit } from "@multiremi/store/db/postgres.js";
import type { ChildStatusChangeCollector, PendingTurnResult } from "./tasks-repo.js";

export interface EnvelopeRecipient {
  workspaceId: string;
  agentId: string;
  issueId: string | null;
  issueSessionId: string | null;
  chatSessionId: string | null;
  executionScope: string;
}

export interface EnvelopeDelivery extends PendingTurnResult {
  recipient: EnvelopeRecipient;
  entry: ConversationLogEntry;
  deduplicated: boolean;
}

export class InboxRepo {
  constructor(private ctx: StoreContext) {}

  sendEnvelopeWithinTransaction(
    env: Envelope,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): EnvelopeDelivery[] {
    if (!this.ctx.db.inTransaction) throw new Error("sendEnvelopeWithinTransaction requires an open transaction");
    const recipients = this.resolveRecipients(env);
    const entries = new Map<string, { entry: ConversationLogEntry; deduplicated: boolean }>();
    const deliveries: EnvelopeDelivery[] = [];
    const sourceComment = env.source.commentId ? this.ctx.issues().getIssueComment(env.source.commentId) : null;
    const sourceTask = env.source.taskId ? this.ctx.tasks().getTask(env.source.taskId) : null;
    const { body, ...envelope } = env;
    const metadata: EnvelopeMetadata = { envelope: {
      ...envelope,
      priority: envelopePriority({ ...env, senderType: sourceComment?.authorType,
        lifecycleEvent: sourceTask?.status === "failed" ? "task_failed"
          : sourceTask?.status === "cancelled" ? "task_cancelled" : undefined }),
    } };
    for (const recipient of recipients) {
      const sessionId = recipient.issueSessionId ?? recipient.chatSessionId!;
      if (sourceComment && this.ctx.issueWorkspaceId(sourceComment.issueId) !== recipient.workspaceId
        || sourceTask && sourceTask.workspaceId !== recipient.workspaceId) {
        throw new Error("Envelope source belongs to another workspace");
      }
      let stored = entries.get(sessionId);
      if (!stored) {
        const id = env.dedupeKey !== undefined
          ? `cmt_env_${createHash("sha256").update(`${sessionId}:${env.dedupeKey}`).digest("hex").slice(0, 20)}`
          : createId("cmt_env");
        // Legacy appenders lock the session row before its log head. Keep that
        // order while they coexist with the new writer.
        const sessionTable = recipient.issueSessionId ? "multiremi_issue_sessions" : "multiremi_chat_sessions";
        if (this.ctx.db.run(`UPDATE ${sessionTable} SET updated_at = updated_at WHERE id = ?`, [sessionId]).changes !== 1) {
          throw new Error(`Envelope session is missing: ${sessionId}`);
        }
        if (this.ctx.db.run(`UPDATE multiremi_conversation_heads SET updated_at = updated_at
          WHERE session_id = ?`, [sessionId]).changes !== 1) {
          throw new Error(`Envelope session head is missing: ${sessionId}`);
        }
        const previous = this.ctx.conversationLog().getConversationLogEntryById(id);
        if (previous) {
          if (previous.session_id !== sessionId) throw new Error("Envelope id belongs to another session");
          stored = { entry: previous, deduplicated: true };
        } else {
          if (recipient.issueSessionId) {
            const comment = this.ctx.issues().createSystemIssueCommentWithinTransaction(
              recipient.issueId!, body, { type: "envelope", ...metadata }, deferredEvents,
              null, recipient.issueSessionId, id,
            );
            deferredEvents.workspace.push({ type: "comment:created", workspaceId: recipient.workspaceId,
              actorType: "system", actorId: comment.authorId, payload: { comment } });
          } else {
            const written = this.ctx.chat().createPendingAgentIssueUpdateWithinTransaction(sessionId, body, { id, metadata: { ...metadata } });
            afterCommit(this.ctx.db, () => this.ctx.emitChatEvent(written.session, "chat:message", { message: written.message }, {
              actorType: "system", actorId: null,
            }));
          }
          const entry = this.ctx.conversationLog().getConversationLogEntryById(id);
          if (!entry) throw new Error("Envelope was not appended to the conversation log");
          stored = { entry, deduplicated: false };
        }
        entries.set(sessionId, stored);
      }
      const turn = stored.deduplicated || env.wake === "inbox_only"
        ? { task: null, created: false }
        : this.ctx.tasks().ensurePendingTurnWithinTransaction({
          agentId: recipient.agentId,
          issueSessionId: recipient.issueSessionId,
          chatSessionId: recipient.chatSessionId,
          executionScope: recipient.executionScope,
          entryId: stored.entry.id,
          entrySeq: stored.entry.seq,
          reason: `envelope:${env.kind}`,
          wake: env.wake,
          triggerCommentId: recipient.issueSessionId ? stored.entry.id : null,
          childStatusChanges: collector,
          deferredEvents,
        });
      deliveries.push({ recipient, entry: stored.entry, deduplicated: stored.deduplicated, ...turn });
    }
    return deliveries;
  }

  private issueRecipient(issueId: string, agentId?: string, issueSessionId?: string, executionScope = ""): EnvelopeRecipient {
    const initial = this.ctx.issues().getIssue(issueId);
    if (!initial) throw new Error(`Envelope Issue not found: ${issueId}`);
    this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue || issue.workspaceId !== initial.workspaceId) throw new Error("Envelope Issue moved or was removed");
    const agent = agentId ? this.ctx.agents().getAgent(agentId)
      : issue.assigneeType && issue.assigneeId
        ? this.ctx.resolveRunnableAgentForAssignee(issue.assigneeType, issue.assigneeId) : null;
    if (!agent || agent.archivedAt || agent.workspaceId !== issue.workspaceId) {
      throw new Error("Envelope Issue has no runnable owner in its workspace");
    }
    const session = issueSessionId ? this.ctx.issueSessions().getIssueSession(issueSessionId)
      : this.ctx.issueSessions().getOrCreateDefaultIssueSession(issue.id);
    if (!session || session.issueId !== issue.id || session.workspaceId !== issue.workspaceId) {
      throw new Error("Envelope Issue session does not belong to the recipient Issue");
    }
    return { workspaceId: issue.workspaceId, agentId: agent.id, issueId: issue.id,
      issueSessionId: session.id, chatSessionId: null, executionScope };
  }

  private resolveRecipients(env: Envelope): EnvelopeRecipient[] {
    const address = env.to;
    switch (address.role) {
      case "issue_owner": return [this.issueRecipient(address.issueId)];
      case "parent_owner": {
        const child = this.ctx.issues().getIssue(address.childIssueId);
        if (!child?.parentIssueId) throw new Error("Envelope child Issue has no parent");
        return [this.issueRecipient(child.parentIssueId)];
      }
      case "agent": {
        const session = this.ctx.issueSessions().getIssueSession(address.issueSessionId);
        if (!session) throw new Error("Envelope Issue session not found");
        return [this.issueRecipient(session.issueId, address.agentId, session.id)];
      }
      case "chat": {
        const initial = this.ctx.chat().getChatSession(address.chatSessionId);
        if (!initial) throw new Error("Envelope Chat session not found");
        this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
        const chat = this.ctx.chat().getChatSession(initial.id);
        const agent = this.ctx.agents().getAgent(address.agentId);
        if (!chat || chat.status === "archived" || chat.agentId !== address.agentId || !agent
          || agent.archivedAt || chat.workspaceId !== agent.workspaceId || chat.workspaceId !== initial.workspaceId) {
          throw new Error("Envelope Chat recipient is unavailable");
        }
        return [{ workspaceId: chat.workspaceId, agentId: agent.id, issueId: null,
          issueSessionId: null, chatSessionId: chat.id, executionScope: "" }];
      }
      case "delegator": {
        const sourceId = env.source.taskId ?? (this.ctx.db.query(`SELECT id FROM multiremi_tasks
          WHERE delegation_id = ? AND delegated_from_issue_session_id IS NOT NULL
            AND agent_id <> delegated_by_agent_id ORDER BY created_at DESC, id DESC LIMIT 1`)
          .get(address.delegationId) as { id: string } | null)?.id;
        const source = sourceId ? this.ctx.tasks().getTask(sourceId) : null;
        if (!source || source.delegationId !== address.delegationId || !source.delegatedByAgentId || !source.delegatedFromIssueSessionId) {
          throw new Error("Envelope delegation has no return recipient");
        }
        const session = this.ctx.issueSessions().getIssueSession(source.delegatedFromIssueSessionId);
        if (!session) throw new Error("Envelope delegation return session not found");
        const parent = source.parentTaskId ? this.ctx.tasks().getTask(source.parentTaskId) : null;
        const scope = parent?.agentId === source.delegatedByAgentId && parent.issueSessionId === session.id
          ? parent.execution_scope ?? "" : "";
        return [this.issueRecipient(session.issueId, source.delegatedByAgentId, session.id, scope)];
      }
      case "relay": {
        const issue = this.ctx.issues().getIssue(address.issueId);
        if (!issue) throw new Error("Envelope relay Issue not found");
        this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
        const bindings = this.ctx.db.query(`SELECT DISTINCT c.id, c.agent_id
          FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
          WHERE b.issue_id = ? AND b.workspace_id = ? AND c.workspace_id = ? AND c.status <> 'archived'
          ORDER BY c.id`).all(issue.id, issue.workspaceId, issue.workspaceId) as Array<{ id: string; agent_id: string }>;
        return bindings.map(binding => this.issueRecipient(issue.id, binding.agent_id, undefined, `relay:${binding.id}`));
      }
    }
  }
}
