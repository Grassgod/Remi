import { getMessage, sendMessageWithinTransaction } from "../inbox/send-message.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { envelopePriority, type Envelope, type EnvelopeMetadata } from "@multiremi/contracts/inbox.js";
import { RELAY_EXECUTION_SCOPE_PREFIX } from "@multiremi/contracts/task-execution.js";
import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log";
import { createId } from "@multiremi/ids.js";
import { clampEnvelopeBody } from "../envelope-body.js";
import type { CommitEventQueue, StoreContext } from "@multiremi/store/context.js";
import { afterCommit } from "@multiremi/store/db/postgres.js";
import type { ChildStatusChangeCollector, EnsurePendingTurnResult, PendingTurnLane } from "./tasks-repo.js";

export interface EnvelopeRecipient {
  workspaceId: string;
  agentId: string;
  issueId: string | null;
  issueSessionId: string | null;
  chatSessionId: string | null;
  executionScope: string;
}

export interface EnvelopeDelivery extends EnsurePendingTurnResult {
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
    const { body: rawBody, ...envelope } = env;
    const body = clampEnvelopeBody(rawBody);
    const envelopeMetadata: EnvelopeMetadata["envelope"] = {
      ...envelope,
      priority: envelopePriority({ ...env, senderType: sourceComment?.authorType,
        lifecycleEvent: sourceTask?.status === "failed" ? "task_failed"
          : sourceTask?.status === "cancelled" ? "task_cancelled" : undefined }),
    };
    for (const recipient of recipients) {
      const sessionId = recipient.issueSessionId ?? recipient.chatSessionId!;
      if (recipient.issueSessionId) {
        this.ctx.issueSessions().getOrCreateSessionAgentLane(sessionId, recipient.agentId, recipient.executionScope);
      }
      const recipientBody = clampEnvelopeBody(env.to.role === "relay" && recipient.issueId && recipient.chatSessionId
        ? body.replaceAll("{{cursor}}", String(this.ctx.issueSessions().getOrCreateSessionAgentLane(
          this.ctx.issueSessions().getOrCreateDefaultIssueSession(recipient.issueId).id,
          recipient.agentId, `${RELAY_EXECUTION_SCOPE_PREFIX}${recipient.chatSessionId}`,
        ).cursorSeq))
        : body);
      if (sourceComment && this.ctx.issueWorkspaceId(sourceComment.issueId) !== recipient.workspaceId
        || sourceTask && sourceTask.workspaceId !== recipient.workspaceId) {
        throw new Error("Envelope source belongs to another workspace");
      }
      let stored = entries.get(sessionId);
      if (!stored) {
        const id = createId('cmt');
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
        const duplicate=env.dedupeKey===undefined?null:this.ctx.db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? AND dedupe_key=?').get(sessionId,env.dedupeKey);
        const previous = duplicate?this.ctx.conversationLog().getConversationLogEntryById(duplicate.id):null;
        if (previous) {
          if (previous.session_id !== sessionId) throw new Error("Envelope id belongs to another session");
          stored = { entry: previous, deduplicated: true };
        } else {
          const metadata: EnvelopeMetadata = { envelope: {
            ...envelopeMetadata,
            ...(env.to.role === "issue_owner" || env.to.role === "parent_owner" || env.to.role === "delegator"
              ? { recipient_agent_id: recipient.agentId } : {}),
          } };
          if (recipient.issueSessionId) {
            const comment = this.ctx.issues().createSystemIssueCommentWithinTransaction(
              recipient.issueId!, recipientBody, { type: "envelope", ...metadata }, deferredEvents,
              null, recipient.issueSessionId, id,
            );
            deferredEvents.workspace.push({ type: "comment:created", workspaceId: recipient.workspaceId,
              actorType: "system", actorId: comment.authorId, payload: { comment } });
          } else {
            const written = this.ctx.chat().createPendingAgentIssueUpdateWithinTransaction(sessionId, recipientBody, { id, metadata: { ...metadata } });
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
      if (recipient.issueSessionId && stored.entry.metadata.envelope?.wake === "now") {
        // Persist the addressed lane's discovery hint with the envelope. A
        // deduplicated delivery must never move the hint backwards.
        this.ctx.db.run(`UPDATE multiremi_session_lanes
          SET wake_hint_seq = CASE WHEN wake_hint_seq < ? THEN ? ELSE wake_hint_seq END
          WHERE reader_type = 'agent' AND session_id = ? AND reader_id = ? AND execution_scope = ?`,
          [stored.entry.seq, stored.entry.seq, sessionId, recipient.agentId, recipient.executionScope]);
      }
      const lane: PendingTurnLane = recipient.issueSessionId
        ? { kind: "issue", issueSessionId: recipient.issueSessionId, agentId: recipient.agentId,
          executionScope: recipient.executionScope }
        : { kind: "chat", chatSessionId: recipient.chatSessionId!, agentId: recipient.agentId, issueId: recipient.issueId };
      const sourceIssue = env.source.issueId ? this.ctx.issues().getIssue(env.source.issueId) : null;
      const reason = env.to.role === "relay" ? "relay"
        : env.to.role === "delegator" ? "delegation_return"
        : env.source.decisionId ? "decision"
        : env.kind === "lifecycle" ? "dependency"
        : sourceIssue && sourceIssue.id !== recipient.issueId
          ? sourceIssue.parentIssueId === recipient.issueId ? "child_status" : "dependency"
          : `envelope:${env.kind}`;
      const turn: EnsurePendingTurnResult = stored.deduplicated || env.wake === "inbox_only"
        ? { task: null, action: "none" }
        : this.ctx.tasks().ensurePendingTurnWithinTransaction({
          lane,
          wake: { reason, seq: stored.entry.seq, commentId: recipient.issueSessionId ? stored.entry.id : null, mode: env.wake },
          steerBody: recipientBody,
          create: () => {
            return this.ctx.tasks().createTaskWithinWorkspaceLock({
              agentId: recipient.agentId, issueId: recipient.issueId, issueSessionId: recipient.issueSessionId,
              chatSessionId: recipient.chatSessionId, workspaceId: recipient.workspaceId,
              prompt: `读收件箱\n\n${sessionId}:${stored!.entry.seq} (${stored!.entry.id})`,
              parentTaskId: env.to.role === "delegator" ? sourceTask?.id ?? null : null,
              wakeSource: reason, preserveIssueStatus: true,
              triggerCommentId: recipient.issueSessionId ? stored!.entry.id : null,
              ...(env.to.role === "delegator" && sourceTask ? {
                delegationId: sourceTask.delegationId,
                delegatedByAgentId: recipient.agentId,
                priority: sourceTask.priority,
                assignmentAuthorType: "system" as const,
                assignmentAuthorId: null,
              } : {}),
              ...(lane.kind === "chat" ? { holdsWorkspace: false, requestingUserName: "Multiremi" } : {}),
            }, collector, deferredEvents, undefined, recipient.executionScope);
          },
        });
      if (turn.action === "created") deferredEvents.enqueuedTasks.push(turn.task!);
      if (turn.action === "coalesced" && turn.task!.wakeSource === "re_ring") {
        // Replace the recovery range with the concrete entry that just arrived.
        runTurnExecutionMutation(this.ctx.db, "UPDATE multiremi_turn_execution_records SET prompt = ? WHERE id = ? AND status = 'queued'", [
          `读收件箱\n\n${sessionId}:${stored.entry.seq} (${stored.entry.id})`, turn.task!.id,
        ]);
        turn.task = this.ctx.tasks().getTask(turn.task!.id)!;
      }
      deliveries.push({ recipient, entry: stored.entry, deduplicated: stored.deduplicated, ...turn });
    }
    return deliveries;
  }

  getMessage(id:string) { return getMessage(this.ctx,id); }
  sendMessageWithinTransaction(input:import("@multiremi/contracts/unified-model.js").SendMessageInput,events:CommitEventQueue) {
    return sendMessageWithinTransaction(this.ctx,input,events);
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
      case "chat": return [this.chatRecipient(address.chatSessionId, address.agentId)];
      case "delegator": {
        const sourceId = env.source.taskId ?? (this.ctx.db.query(`SELECT id FROM multiremi_turn_execution_records
          WHERE delegation_id = ? AND delegated_from_issue_session_id IS NOT NULL
            AND agent_id <> delegated_by_agent_id ORDER BY created_at DESC, id DESC LIMIT 1`)
          .get(address.delegationId) as { id: string } | null)?.id;
        const source = sourceId ? this.ctx.tasks().getTask(sourceId) : null;
        const sessionId = source?.delegatedFromIssueSessionId ?? source?.issueSessionId;
        if (!source || source.delegationId !== address.delegationId || !source.delegatedByAgentId || !sessionId) {
          throw new Error("Envelope delegation has no return recipient");
        }
        const session = this.ctx.issueSessions().getIssueSession(sessionId);
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
        const bindings = this.ctx.db.query(`SELECT c.id, c.agent_id, b.chat_id
          FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
          WHERE b.issue_id = ? AND b.workspace_id = ? AND c.workspace_id = ? AND c.status <> 'archived'
          ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC`).all(issue.id, issue.workspaceId, issue.workspaceId) as Array<{ id: string; agent_id: string; chat_id: string | null }>;
        const seen = new Set<string>();
        return bindings.filter(binding => {
          const key = binding.chat_id ? `chat:${binding.chat_id}` : `session:${binding.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).map(binding => this.chatRecipient(binding.id, binding.agent_id, issue.id));
      }
    }
  }

  private chatRecipient(chatSessionId: string, agentId: string, expectedIssueId?: string): EnvelopeRecipient {
    const initial = this.ctx.chat().getChatSession(chatSessionId);
    if (!initial) throw new Error("Envelope Chat session not found");
    this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
    const chat = this.ctx.chat().getChatSession(initial.id);
    const agent = this.ctx.agents().getAgent(agentId);
    const issueId = this.ctx.feishuBot().getFeishuIssueIdForChatSession(initial.id);
    if (!chat || chat.status === "archived" || chat.agentId !== agentId || !agent || agent.archivedAt
      || chat.workspaceId !== agent.workspaceId || chat.workspaceId !== initial.workspaceId
      || (expectedIssueId !== undefined && issueId !== expectedIssueId)) {
      throw new Error("Envelope Chat recipient is unavailable");
    }
    return { workspaceId: chat.workspaceId, agentId: agent.id, issueId,
      issueSessionId: null, chatSessionId: chat.id, executionScope: "" };
  }
}
