import type { MultiremiStore } from '@multiremi/store.js';
import type { AppendConversationLogInput } from '@multiremi/store/repos/conversation-log-repo.js';
import type { MessageKind, MessageSenderType } from '@multiremi/contracts/unified-model.js';
import type { Envelope } from '@multiremi/contracts/inbox.js';

/** Live fixtures enter through the message writer; metadata.envelope is migration input only. */
export function appendCanonicalInboxInput(store: MultiremiStore, input: AppendConversationLogInput) {
  const { envelope, ...metadata } = input.metadata as Record<string, any>;
  const address = envelope.to as Envelope['to'];
  let agentId = envelope.recipient_agent_id ?? (address as any).agentId;
  if (!agentId && (address.role === 'issue_owner' || address.role === 'parent_owner')) {
    const issueId = address.role === 'issue_owner' ? address.issueId : store.getIssue(address.childIssueId)?.parentIssueId;
    const issue = issueId ? store.getIssue(issueId) : null;
    agentId = issue?.assigneeType === 'agent' ? issue.assigneeId : issue?.assigneeType === 'squad' ? store.getSquad(issue.assigneeId!)?.leaderId : null;
  }
  if (!agentId && address.role === 'delegator') agentId = store.getTask(envelope.source?.taskId)?.delegatedByAgentId;
  const type: MessageSenderType = input.authorType === 'system' || input.authorType === 'external' ? 'platform' : input.authorType as MessageSenderType;
  const source = input.taskId ?? envelope.source?.taskId;
  return store.sendMessage({ session_id: input.sessionId, sender: { type, id: type === 'platform' ? null : input.authorId ?? null },
    source_turn_id: source ? store.getTurnForAttempt(source)?.id : undefined,
    to: agentId ? { type: 'agent', ref: agentId } : { type: 'none' },
    message_kind: (envelope.kind === 'decision_needed' ? 'decision' : envelope.kind === 'lifecycle' ? 'status' : envelope.kind) as MessageKind,
    wake_requested: envelope.wake, body_md: input.bodyMd ?? '', dedupe_key: envelope.dedupeKey,
    execution_scope: typeof metadata.execution_scope === 'string' ? metadata.execution_scope : undefined,
    metadata, visibility: input.visibility,
  }).message;
}
