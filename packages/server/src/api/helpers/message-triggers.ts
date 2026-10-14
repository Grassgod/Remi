import type { MessageTriggerSource } from '@multiremi/contracts/conversation-log.js';
import type { Context } from 'hono';
import type { MultiremiStore } from '@multiremi/store/store.js';
import { messageTriggerSource, triggerVisibilityEntry, type TriggerEntry } from '@multiremi/store/message-trigger-source.js';
import { conversationEntryVisibility, loadConversation } from './conversations.js';

/** Batch enrichment for HTTP/SSR. Private or deleted triggers reveal no actor or link. */
export function withMessageTriggers<T extends TriggerEntry>(c: Context, store: MultiremiStore, entries: T[]) {
  const facts = store.readMessageTriggerFacts(entries), sources = new Map<string, MessageTriggerSource>(), sessions = new Map<string, boolean>();
  const visible = conversationEntryVisibility(c, store);
  for (const fact of facts) {
    if (fact.source_visibility !== 'shown' || fact.source_deleted) continue;
    if (!sessions.has(fact.source_session)) {
      const conversation = loadConversation(c, store, fact.source_session);
      sessions.set(fact.source_session, !(conversation instanceof Response) && conversation.workspaceId === fact.workspace_id);
    }
    if (sessions.get(fact.source_session) && visible(triggerVisibilityEntry(fact))) sources.set(fact.entry_id, messageTriggerSource(fact));
  }
  return entries.map(entry => ({ ...entry, trigger_source: sources.get(entry.id) ?? null }));
}
