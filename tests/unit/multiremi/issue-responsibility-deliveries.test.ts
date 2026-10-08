import { describe, expect, it } from 'bun:test';
import { MultiremiStore } from '@multiremi/store.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { PostgresSyncDatabase, type SqlDatabase } from '@multiremi/store/db/postgres.js';
import { createMultiremiApp } from '@multiremi/api.js';

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
for (const backend of ['sqlite','postgres'] as const) describe.skipIf(backend === 'postgres' && !adminUrl)(`Issue responsibility and formal delivery (${backend})`, () => {
  async function run(check: (store: MultiremiStore, db: SqlDatabase) => void | Promise<void>) {
    let db: SqlDatabase | undefined;
    const admin = backend === 'postgres' ? new Bun.SQL(adminUrl!,{max:1}) : null;
    const name = `responsibility_${process.pid}_${crypto.randomUUID().replaceAll('-','')}`;
    let created = false;
    try {
      if (admin) { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; const url = new URL(adminUrl!); url.pathname = `/${name}`; db = new PostgresSyncDatabase(url.toString()); }
      else db = openSqliteDatabase(':memory:') as unknown as SqlDatabase;
      const store = new MultiremiStore(db); store.ensureLocalWorkspace();
      await check(store,db);
    } finally { db?.close(); if (created) await admin!.unsafe(`DROP DATABASE ${name}`); await admin?.end(); }
  }
  function fixture(store: MultiremiStore) {
    const human = store.createWorkspaceMember({id:'human_responsible',name:'Responsible human'});
    const other = store.createWorkspaceMember({id:'human_other',name:'Other human'});
    const owner = store.createAgent({name:'Issue owner',provider:'claude'});
    const worker = store.createAgent({name:'Worker',provider:'claude'});
    const root = store.createIssue({title:'Root',responsibleMemberId:human.id,assigneeType:'agent',assigneeId:owner.id});
    const child = store.createIssue({title:'Child',parentIssueId:root.id,assigneeType:'agent',assigneeId:worker.id});
    const ownerTask = store.createTask({agentId:owner.id,issueId:root.id,prompt:'Coordinate'});
    const workerTask = store.createTask({agentId:worker.id,issueId:child.id,prompt:'Deliver'});
    return {human,other,owner,worker,root,child,ownerActor:{type:'agent' as const,id:owner.id,taskId:ownerTask.id},workerActor:{type:'agent' as const,id:worker.id,taskId:workerTask.id}};
  }
  it('requires an explicit human source and exposes unresolved legacy roots without guessing', () => run((store,db) => {
    expect(() => store.createIssue({title:'No responsibility'})).toThrow('explicit responsible_member_id');
    const f = fixture(store);
    db.run('UPDATE multiremi_issues SET responsible_member_id=NULL WHERE id=?',[f.root.id]);
    const resolution = store.resolveIssueResponsibility(f.child.id);
    expect(resolution.rootHuman).toBeNull();
    expect(resolution.unresolved).toContainEqual({issueId:f.root.id,reason:'human_missing'});
    expect(() => store.submitIssueDelivery(f.child.id,{summary:'Delivered'},f.workerActor)).toThrow('responsibility chain');
  }));
  it('derives parent review and root human only from the Issue tree; comments do not change revision', () => run((store) => {
    const f = fixture(store);
    const resolution = store.resolveIssueResponsibility(f.child.id);
    expect(resolution.executionOwner?.id).toBe(f.worker.id);
    expect(resolution.reviewOwner?.id).toBe(f.owner.id);
    expect(resolution.rootHuman?.id).toBe(f.human.id);
    store.createIssueComment(f.root.id,{body:'Ordinary context'});
    expect(store.resolveIssueResponsibility(f.child.id).revision).toBe(resolution.revision);
    expect(store.getIssue(f.child.id)?.responsibleMemberId).toBeNull();
  }));
  it('never uses a normal team member or sender first team when the assigned Leader is absent', () => run((store,db) => {
    const f = fixture(store);
    const team = store.createSquad({name:'Assigned team',leaderId:f.owner.id});
    store.updateIssue(f.child.id,{assigneeType:'squad',assigneeId:team.id});
    expect(store.resolveIssueResponsibility(f.child.id).executionOwner?.id).toBe(f.owner.id);
    db.run('UPDATE multiremi_squads SET leader_id=NULL WHERE id=?',[team.id]);
    const resolved = store.resolveIssueResponsibility(f.child.id);
    expect(resolved.executionOwner).toBeNull();
    expect(resolved.unresolved).toContainEqual({issueId:f.child.id,reason:'leader_missing'});
  }));
  it('accepts a specific child delivery only from its parent execution owner and preserves the same reply reference', () => run((store) => {
    const f = fixture(store);
    const delivery = store.submitIssueDelivery(f.child.id,{summary:'Implementation and checks complete'},f.workerActor);
    expect(store.getIssue(f.child.id)?.status).toBe('in_review');
    expect(delivery.reviewOwner.id).toBe(f.owner.id);
    expect(() => store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.workerActor)).toThrow('designated');
    const accepted = store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor);
    expect(store.getIssue(f.child.id)?.status).toBe('done');
    expect(store.getMessage(accepted.responseMessageId!)?.reply_to_id).toBe(delivery.id);
    expect(store.listIssueDeliveries(f.child.id)).toHaveLength(1);
    expect(store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toEqual(accepted);
  }));
  it('requires the root designated human; force, task completion and ordinary members cannot substitute', () => run((store) => {
    const f = fixture(store);
    expect(() => store.updateIssue(f.root.id,{status:'done',force:true,actorType:'member',actorId:f.other.id})).toThrow('specific delivery');
    store.updateIssue(f.child.id,{status:'cancelled'});
    const delivery = store.submitIssueDelivery(f.root.id,{summary:'Final root result'},f.ownerActor);
    expect(() => store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('designated');
    expect(() => store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},{type:'member',id:f.other.id})).toThrow('designated');
    const accepted = store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},{type:'member',id:f.human.id});
    expect(accepted.status).toBe('accepted');
    expect(store.getIssue(f.root.id)?.status).toBe('done');
    store.updateIssue(f.root.id,{status:'todo'});
    expect(() => store.updateIssue(f.root.id,{status:'done',actorType:'member',actorId:f.human.id})).toThrow('specific delivery');
  }));
  it('returns with a referenced reason, keeps the Issue open, and makes an old responsibility revision ineffective', () => run((store) => {
    const f = fixture(store);
    const delivery = store.submitIssueDelivery(f.child.id,{summary:'First delivery'},f.workerActor);
    const returned = store.respondIssueDelivery(f.child.id,delivery.id,{action:'return',body:'Missing verification',revision:delivery.responsibilityRevision},f.ownerActor);
    expect(returned.responseBody).toBe('Missing verification');
    expect(store.getIssue(f.child.id)?.status).toBe('todo');
    const returnNotice = store.listConversationLogEntries(delivery.sourceSessionId).find(entry => entry.metadata.issue_delivery_id === delivery.id && entry.metadata.response_message_id === returned.responseMessageId);
    expect(returnNotice).toBeDefined();
    expect(store.getMessage(returnNotice!.id)?.wake_applied).toBe('now');
    const next = store.submitIssueDelivery(f.child.id,{summary:'Second delivery'},f.workerActor);
    store.updateIssue(f.root.id,{responsibleMemberId:f.other.id,actorType:'member',actorId:f.human.id});
    expect(() => store.respondIssueDelivery(f.child.id,next.id,{action:'accept',revision:next.responsibilityRevision},f.ownerActor)).toThrow('Responsibility changed');
    expect(store.listIssueDeliveries(f.child.id)[0]?.status).toBe('pending');
  }));
  it('binds human proxy authority to the concrete delivery and revision, with explicit revocation', () => run((store) => {
    const f = fixture(store); store.updateIssue(f.child.id,{status:'cancelled'});
    const delivery = store.submitIssueDelivery(f.root.id,{summary:'Proxy-reviewed output'},f.ownerActor);
    const human = {type:'member' as const,id:f.human.id};
    expect(() => store.authorizeIssueDelivery(f.root.id,delivery.id,f.owner.id,delivery.responsibilityRevision,{type:'member',id:f.other.id})).toThrow('designated');
    store.authorizeIssueDelivery(f.root.id,delivery.id,f.owner.id,delivery.responsibilityRevision,human);
    store.authorizeIssueDelivery(f.root.id,delivery.id,null,delivery.responsibilityRevision,human);
    expect(() => store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('designated');
    store.authorizeIssueDelivery(f.root.id,delivery.id,f.owner.id,delivery.responsibilityRevision,human);
    const accepted = store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor);
    expect(accepted.authorization?.grantedBy).toBe(f.human.id);
    expect(store.getMessage(accepted.responseMessageId!)?.sender_id).toBe(f.owner.id);
    expect(store.getIssue(f.root.id)?.status).toBe('done');
  }));
  it('rolls back response and status when a parent still has unfinished children', () => run((store) => {
    const f = fixture(store);
    expect(() => store.submitIssueDelivery(f.root.id,{summary:'Premature final'},f.ownerActor)).toThrow('unfinished');
    expect(store.listIssueDeliveries(f.root.id)).toEqual([]);
  }));
  it('protects frozen delivery content and acceptance receipts from ordinary message mutation', () => run((store) => {
    const f = fixture(store);
    const delivery = store.submitIssueDelivery(f.child.id,{summary:'Immutable review content'},f.workerActor);
    expect(() => store.editMessage(delivery.id,{body_md:'Different unreviewed content'})).toThrow('immutable');
    expect(() => store.deleteMessage(delivery.id)).toThrow('immutable');
    expect(store.getMessage(delivery.id)?.body_md).toBe('Immutable review content');
    const accepted = store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor);
    expect(() => store.deleteMessage(accepted.responseMessageId!)).toThrow('immutable');
  }));
  it('preserves responsibility across restart and discovers every persisted delivery', () => run((store,db) => {
    const f = fixture(store);
    const delivery = store.submitIssueDelivery(f.child.id,{summary:'Persisted result',dedupeKey:'one-delivery'},f.workerActor);
    expect(store.submitIssueDelivery(f.child.id,{summary:'Persisted result',dedupeKey:'one-delivery'},f.workerActor).id).toBe(delivery.id);
    const restarted = new MultiremiStore(db);
    expect(restarted.resolveIssueResponsibility(f.child.id).rootHuman?.id).toBe(f.human.id);
    expect(restarted.listIssueDeliveries(f.child.id)).toHaveLength(1);
    expect(restarted.listIssueDeliveries(f.child.id)[0]?.id).toBe(delivery.id);
  }));
  it('exposes responsibility and deliveries API, and rejects anonymous/foreign acceptance', () => run(async (store) => {
    const f = fixture(store); const app = createMultiremiApp({store,authToken:'test-root'});
    const headers = {Authorization:'Bearer test-root','Content-Type':'application/json'};
    const response = await app.request(`/api/issues/${f.child.id}/responsibility`,{headers});
    expect(response.status).toBe(200); expect((await response.json()).reviewOwner.id).toBe(f.owner.id);
    const token = await store.createTaskAccessToken(store.getTask(f.workerActor.taskId)!, 'local');
    const submitted = await app.request(`/api/issues/${f.child.id}/deliveries`,{method:'POST',headers:{...headers,Authorization:`Bearer ${token.token}`},body:JSON.stringify({summary:'API delivery'})});
    expect(submitted.status).toBe(201);
    const list = await app.request(`/api/issues/${f.child.id}/deliveries`,{headers});
    expect((await list.json()).deliveries).toHaveLength(1);
  }));
});
