import { beforeEach, expect, it } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { createBrowserLogProjection } from '@multiremi/api/hub/browser-log-projection.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { createResponsibleTestIssue, createResponsibleTestAutopilot } from './helpers.js';
import { readMessageTriggerFacts } from '@multiremi/store/message-trigger-source.js';
import type { MultiremiStore } from '@multiremi/store.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';

pendingTurnBackendTests('message trigger provenance', fixture => {
  let store: MultiremiStore, db: SqlDatabase, app: ReturnType<typeof createMultiremiApp>;
  let agent: ReturnType<MultiremiStore['createAgent']>, session: ReturnType<MultiremiStore['getOrCreateDefaultIssueSession']>;
  let issue: ReturnType<MultiremiStore['createIssue']>;
  beforeEach(() => {
    ({ store, db } = fixture());
    agent = store.createAgent({ name: 'Worker', provider: 'codex', visibility: 'workspace' });
    issue = createResponsibleTestIssue(store, { title: 'Work', assigneeType: 'agent', assigneeId: agent.id });
    session = store.getOrCreateDefaultIssueSession(issue.id);
    app = createMultiremiApp({ store });
  });
  function start(sender = { type: 'member' as const, id: 'mem_local_local' }) {
    return store.sendMessage({ session_id: session.id, sender, to: { type: 'agent', ref: agent.id },
      message_kind: 'request', wake_requested: 'now', body_md: 'Original trigger' });
  }
  function output(turnId: string, targetSession = session.id, worker = agent) {
    return store.sendMessage({ session_id: targetSession, sender: { type: 'agent', id: worker.id },
      to: { type: 'none' }, source_turn_id: turnId, message_kind: 'reply', wake_requested: 'inbox_only', body_md: 'Result' }).message;
  }
  async function window(id = session.id) {
    const response = await app.request(`/api/sessions/${id}/log`);
    expect(response.status).toBe(200);
    return (await response.json() as any).entries;
  }
  it('keeps the initiating member after merged inputs and reassignment', async () => {
    const initial = start();
    const later = store.createWorkspaceMember({ name: 'Later person', role: 'member' });
    start({ type: 'member', id: later.id });
    const result = output(initial.turn_id!);
    const other = store.createAgent({ name: 'New owner', provider: 'codex', visibility: 'workspace' });
    store.updateIssue(issue.id, { assigneeType: 'agent', assigneeId: other.id });
    const row = (await window()).find((e: any) => e.id === result.id);
    expect(row.trigger_source.message_id).toBe(initial.message.id);
    expect(row.trigger_source.actor_id).toBe('mem_local_local');
    expect(row.trigger_source.actor_name).not.toBe('New owner');
    const canonical = await app.request(`/api/messages/${result.id}`);
    expect((await canonical.json() as any).message.trigger_source).toEqual(row.trigger_source);
  });
  it('identifies parent Issue dispatch by the actual sender', async () => {
    const initial = start();
    const child = createResponsibleTestIssue(store, { title: 'Child', parentIssueId: issue.id, assigneeType: 'agent', assigneeId: agent.id });
    const childSession = store.getOrCreateDefaultIssueSession(child.id);
    const worker = store.createAgent({ name: 'Child worker', provider: 'codex', visibility: 'workspace' });
    const dispatch = store.sendMessage({ session_id: childSession.id, sender: { type: 'agent', id: agent.id },
      source_turn_id: initial.turn_id, to: { type: 'agent', ref: worker.id }, message_kind: 'request', wake_requested: 'now', body_md: 'Parent dispatch' });
    const turn = store.getTurn(dispatch.turn_id!)!;
    const result = output(turn.id, turn.session_id, worker);
    const row = (await window(turn.session_id)).find((e: any) => e.id === result.id);
    expect(row.trigger_source.actor_name).toBe('Worker');
    expect(row.trigger_source.issue_id).toBe(child.id);
    expect(row.trigger_source.parent_issue_key).toBe(issue.key);
    expect(row.trigger_source.parent_issue).toBe(true);
  });
  it('resolves a named timer without attributing it to the agent', async () => {
    const auto = createResponsibleTestAutopilot(store, { title: 'Daily release check', assigneeType: 'agent', assigneeId: agent.id });
    const initial = store.sendMessage({ session_id: session.id, sender: { type: 'timer', id: auto.id }, to: { type: 'agent', ref: agent.id },
      message_kind: 'request', wake_requested: 'now', body_md: 'Scheduled check' });
    const result = output(initial.turn_id!);
    expect((await window()).find((e: any) => e.id === result.id).trigger_source).toMatchObject({ actor_type: 'timer', actor_name: 'Daily release check' });
  });
  it('does not expose deleted or hidden source information', async () => {
    const initial = start(), result = output(initial.turn_id!);
    db.run("UPDATE multiremi_conversation_log SET visibility='hidden' WHERE id=?", [initial.message.id]);
    expect((await window()).find((e: any) => e.id === result.id).trigger_source).toBeNull();
    db.run("UPDATE multiremi_conversation_log SET visibility='shown',deleted_at=? WHERE id=?", [new Date().toISOString(), initial.message.id]);
    expect((await window()).find((e: any) => e.id === result.id).trigger_source).toBeNull();
  });
  it('redacts a private Chat trigger from public Issue output in HTTP and live frames', async () => {
    const owner = store.getOrCreateUser({ externalId: 'private-source-owner', name: 'Private initiator', email: 'private@trigger.test' });
    const human = store.createWorkspaceMember({ userId: owner.id, name: owner.name, role: 'member' });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: owner.id });
    const initial = store.sendMessage({ session_id: chat.id, sender: { type: 'member', id: human.id }, to: { type: 'agent', ref: agent.id },
      message_kind: 'request', wake_requested: 'now', body_md: 'Private cause' });
    const result = output(initial.turn_id!);
    const viewer = store.getCurrentUser();
    const pat = await store.createAccessToken({ type: 'pat', name: 'Source viewer', userId: viewer.id, workspaceId: 'local' });
    const guarded = createMultiremiApp({ store, authToken: 'test-master' });
    const response = await guarded.request(`/api/sessions/${session.id}/log`, { headers: { Authorization: `Bearer ${pat.token}` } });
    expect(response.status).toBe(200);
    const rows = (await response.json() as any).entries;
    expect(rows.find((e: any) => e.id === result.id).trigger_source).toBeNull();
    const row = store.getConversationLogEntryById(result.id)!;
    const frames = await createBrowserLogProjection(store, null)({ data: { kind: 'browser', authenticated: true, userId: viewer.id, workspaceId: 'local' } } as any,
      session.id, [{ seq: row.seq, kind: 'entry', payload: row }]);
    expect((frames[0]!.payload as any).trigger_source).toBeNull();
  });
  it('keeps unknown historical output unknown and ignores injected provenance', async () => {
    const result = store.sendMessage({ session_id: session.id, sender: { type: 'agent', id: agent.id }, to: { type: 'none' },
      message_kind: 'status', wake_requested: 'inbox_only', body_md: 'Historical', metadata: { trigger_source: { actor_name: 'Forged' } } }).message;
    expect((await window()).find((e: any) => e.id === result.id).trigger_source).toBeNull();
  });
  it('reads the entire displayed batch with one bounded source query', () => {
    const initial = start();
    const entries = Array.from({ length: 12 }, () => store.getConversationLogEntryById(output(initial.turn_id!).id)!);
    let queries = 0;
    const wrapper = { query(sql: string) { queries++; return db.query(sql); } } as SqlDatabase;
    expect(readMessageTriggerFacts(wrapper, entries)).toHaveLength(12);
    expect(queries).toBe(1);
    expect(readMessageTriggerFacts(wrapper, [])).toHaveLength(0);
    expect(queries).toBe(1);
  });
  it('projects the same source onto live browser entries', async () => {
    const initial = start(), result = output(initial.turn_id!), row = store.getConversationLogEntryById(result.id)!;
    const project = createBrowserLogProjection(store, null);
    const frames = await project({ data: { kind: 'browser', authenticated: true, userId: store.getCurrentUser().id, workspaceId: 'local' } } as any,
      session.id, [{ seq: row.seq, kind: 'entry', payload: row }]);
    expect((frames[0]!.payload as any).trigger_source.message_id).toBe(initial.message.id);
  });
});
