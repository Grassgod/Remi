import { InboxOperations } from "../inbox/operations.js";
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
  readonly operations:InboxOperations;
  constructor(private ctx: StoreContext) { this.operations=new InboxOperations(ctx); }

  sendEnvelopeWithinTransaction(
    env: Envelope,
    collector: ChildStatusChangeCollector,
    deferredEvents: CommitEventQueue,
  ): EnvelopeDelivery[] {
    if(!this.ctx.db.inTransaction)throw new Error('Envelope producer requires a transaction');
    const address=env.to;
    const members=(address.role==='issue_owner'||address.role==='parent_owner')?(()=>{
      const issueId=address.role==='issue_owner'?address.issueId:this.ctx.issues().getIssue(address.childIssueId)?.parentIssueId;
      const issue=issueId?this.ctx.issues().getIssue(issueId):null;
      const child=address.role==='parent_owner'?this.ctx.issues().getIssue(address.childIssueId):null;
      if(child && issue && child.workspaceId!==issue.workspaceId)throw new Error('Envelope parent Issue belongs to another workspace');
      const responsibility=issue?this.ctx.resolveIssueResponsibility(issue.id):null;
      if(!issue||responsibility?.executionOwner||!responsibility?.rootHuman)return [];
      const session=this.ctx.issueSessions().getOrCreateDefaultIssueSessionWithinTransaction(issue.id);
      return [{workspaceId:issue.workspaceId,agentId:'',issueId:issue.id,issueSessionId:session.id,chatSessionId:null,executionScope:'',
        memberId:responsibility.rootHuman.id,unresolved:responsibility.unresolved}];
    })():[];
    const recipients=members.length?members:this.resolveRecipients(env);
    const source=env.source.taskId?this.ctx.tasks().getTask(env.source.taskId):null;
    const deliveries:EnvelopeDelivery[]=[];
    for(const recipient of recipients){
      const sessionId=recipient.issueSessionId??recipient.chatSessionId!;
      const before=env.dedupeKey?this.ctx.db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? AND dedupe_key=?').get(sessionId,env.dedupeKey):null;
      const member=members.find(item=>item.issueId===recipient.issueId)?.memberId;
      const reply=env.replyTo?this.getMessage(env.replyTo):null;
      const activeBefore=this.ctx.db.query("SELECT id FROM multiremi_turns WHERE session_id=? AND agent_id=? AND execution_scope=? AND status IN ('pending','running','awaiting_human')").get(sessionId,recipient.agentId,recipient.executionScope);
      const sourceTurn=source?this.ctx.db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(source.id):null;
      const result=sendMessageWithinTransaction(this.ctx,{session_id:sessionId,sender:{type:'platform',id:null},source_turn_id:sourceTurn?.turn_id??null,
        to:member?{type:'member',ref:member}:{type:'agent',ref:recipient.agentId},message_kind:env.kind==='lifecycle'?'status':env.kind==='decision_needed'?'decision':env.kind,
        wake_requested:env.wake,body_md:env.body,dedupe_key:env.dedupeKey,
        reply_to_id:reply?.session_id===sessionId?reply.id:null,execution_scope:recipient.executionScope,
        metadata:{message_source:env.source,message_outcome:env.outcome,priority:envelopePriority(env),address_context:env.to,
          ...(member?{responsibility_unresolved:members[0]!.unresolved}:{})},
      },deferredEvents,{issueId:recipient.issueId,...(env.to.role==='delegator'&&source?{
        delegationId:source.delegationId,delegatedByAgentId:recipient.agentId,delegatedFromIssueSessionId:source.delegatedFromIssueSessionId,
        priority:source.priority,parentTaskId:null,wakeSource:'delegation_return',
      }:{})});
      const turn=result.turn_id?this.ctx.db.query('SELECT current_attempt_id FROM multiremi_turns WHERE id=?').get(result.turn_id):null;
      const task=turn?this.ctx.tasks().getTask(turn.current_attempt_id):null;
      const entry=this.ctx.conversationLog().getConversationLogEntryById(result.message.id)!;
      deliveries.push({recipient,entry,deduplicated:!!before,task,action:before||!task?'none':task.status==='queued'?activeBefore?'coalesced':'created':'steered'});
    }
    return deliveries;
  }

  getMessage(id:string) { return getMessage(this.ctx,id); }
  sendMessageWithinTransaction(input:import("@multiremi/contracts/unified-model.js").SendMessageInput,events:CommitEventQueue,
    authorizeRecipient?:(agent:import("@multiremi/contracts/types.js").MultiremiAgent)=>void) {
    return sendMessageWithinTransaction(this.ctx,input,events,{},authorizeRecipient);
  }

  private issueRecipient(issueId: string, agentId?: string, issueSessionId?: string, executionScope = ""): EnvelopeRecipient {
    const initial = this.ctx.issues().getIssue(issueId);
    if (!initial) throw new Error(`Envelope Issue not found: ${issueId}`);
    this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue || issue.workspaceId !== initial.workspaceId) throw new Error("Envelope Issue moved or was removed");
    const responsibility = !agentId ? this.ctx.resolveIssueResponsibility(issue.id) : null;
    if (responsibility?.unresolved.length) throw new Error('Envelope Issue responsibility is unresolved; repair its owner and root human');
    const ownerId = agentId ?? responsibility?.executionOwner?.id;
    const agent = ownerId ? this.ctx.agents().getAgent(ownerId) : null;
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
        const parent=this.ctx.issues().getIssue(child.parentIssueId);
        if(!parent || parent.workspaceId!==child.workspaceId)throw new Error('Envelope parent Issue is missing or belongs to another workspace');
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
        let parent=this.ctx.db.query(`SELECT p.* FROM multiremi_turns child
          JOIN multiremi_conversation_log request ON request.id=child.trigger_message_id
          JOIN multiremi_turns p ON p.id=request.task_id WHERE child.current_attempt_id=?`).get(source.id);
        const seen=new Set<string>();
        // A recovered turn is triggered by a downstream report. Walk the frozen
        // source chain to the upstream lane, with a cycle bound for corrupt data.
        while(parent && parent.agent_id!==source.delegatedByAgentId && !seen.has(parent.id) && seen.size<32){
          seen.add(parent.id);
          parent=this.ctx.db.query(`SELECT p.* FROM multiremi_conversation_log request
            JOIN multiremi_turns p ON p.id=request.task_id WHERE request.id=?`).get(parent.trigger_message_id);
        }
        const scope=parent?.agent_id===source.delegatedByAgentId&&parent.session_id===session.id?parent.execution_scope:'';
        return [this.issueRecipient(session.issueId, source.delegatedByAgentId, session.id, scope)];
      }
      case "relay": {
        const issue = this.ctx.issues().getIssue(address.issueId);
        if (!issue) throw new Error("Envelope relay Issue not found");
        this.ctx.lockWorkspaceRuntimeLifecycle(issue.workspaceId);
        const bindings = this.ctx.db.query(`SELECT c.id, c.agent_id, b.id AS binding_id
          FROM multiremi_feishu_bot_chat_bindings b JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
          WHERE b.issue_id = ? AND b.workspace_id = ? AND c.workspace_id = ? AND c.status <> 'archived'
          ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC`).all(issue.id, issue.workspaceId, issue.workspaceId) as Array<{ id: string; agent_id: string; binding_id: string }>;
        const seen = new Set<string>();
        return bindings.filter(binding => {
          const key = binding.binding_id;
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
