import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MultiremiStore } from '@multiremi/store.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { PostgresSyncDatabase, type SqlDatabase } from '@multiremi/store/db/postgres.js';
import { createMultiremiApp } from '@multiremi/api.js';
import { createCommitEventQueue, StoreContext } from '@multiremi/store/context.js';
import { IssueDeliveryError } from '@multiremi/store/issue-deliveries.js';

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
for (const backend of ['sqlite','postgres'] as const) describe.skipIf(backend === 'postgres' && !adminUrl)(`Issue responsibility and formal delivery (${backend})`, () => {
  let db: SqlDatabase | undefined;
  let store: MultiremiStore;
  let admin: Bun.SQL | null;
  let name: string;
  let created: boolean;
  let databaseUrl: string | undefined;
  // Cold schema/report bootstrap belongs to isolated fixture setup, not the
  // test body's unchanged 5s budget. Business assertions retain their bounds.
  beforeEach(async () => {
    admin = backend === 'postgres' ? new Bun.SQL(adminUrl!,{max:1}) : null;
    name = `responsibility_${process.pid}_${crypto.randomUUID().replaceAll('-','')}`;
    created = false;
    databaseUrl = undefined;
    if (admin) { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; const url = new URL(adminUrl!); url.pathname = `/${name}`; databaseUrl=url.toString(); db = new PostgresSyncDatabase(databaseUrl); }
    else db = openSqliteDatabase(':memory:') as unknown as SqlDatabase;
    store = new MultiremiStore(db); store.ensureLocalWorkspace();
    // Match the store's transaction/afterCommit adapter on both backends.
    db=(store as unknown as {db:SqlDatabase}).db;
  });
  afterEach(async () => {
    db?.close();
    if (created) await admin!.unsafe(`DROP DATABASE ${name}`);
    await admin?.end();
  });
  async function run(check: (store: MultiremiStore, db: SqlDatabase, restart: () => {store:MultiremiStore;db:SqlDatabase}) => void | Promise<void>) {
    await check(store,db!,() => {
      if (databaseUrl) {db!.close();db=new PostgresSyncDatabase(databaseUrl);}
      return {store:new MultiremiStore(db!),db:db!};
    });
  }
  function fixture(store: MultiremiStore, suffix='') {
    const human = store.createWorkspaceMember({id:`human_responsible${suffix}`,name:'Responsible human'});
    const other = store.createWorkspaceMember({id:`human_other${suffix}`,name:'Other human'});
    const owner = store.createAgent({name:'Issue owner',provider:'claude'});
    const worker = store.createAgent({name:'Worker',provider:'claude'});
    const root = store.createIssue({title:'Root',responsibleMemberId:human.id,assigneeType:'agent',assigneeId:owner.id});
    const child = store.createIssue({title:'Child',parentIssueId:root.id,assigneeType:'agent',assigneeId:worker.id});
    const ownerTask = store.createTask({agentId:owner.id,issueId:root.id,prompt:'Coordinate'});
    const workerTask = store.createTask({agentId:worker.id,issueId:child.id,prompt:'Deliver'});
    return {human,other,owner,worker,root,child,ownerActor:{type:'agent' as const,id:owner.id,taskId:ownerTask.id},workerActor:{type:'agent' as const,id:worker.id,taskId:workerTask.id}};
  }
  it('uses current Main sequence for latest acceptance and authorization despite clock rollback', () => run((store,db) => {
    const f = fixture(store);
    store.updateIssue(f.child.id,{status:'cancelled'});
    const first = store.submitIssueDelivery(f.root.id,{summary:'Earlier receipt'},f.ownerActor);
    const second = store.submitIssueDelivery(f.root.id,{summary:'Later durable sequence'},f.ownerActor);
    // Represent two real writers whose clocks differ, while preserving durable sequence.
    db.run('UPDATE multiremi_conversation_log SET created_at=? WHERE id=?',['2038-01-01T00:00:00.000Z',first.id]);
    db.run('UPDATE multiremi_conversation_log SET created_at=? WHERE id=?',['2037-01-01T00:00:00.000Z',second.id]);
    const human = {type:'member' as const,id:f.human.id};
    expect(store.listIssueDeliveries(f.root.id,{limit:1})[0]).toMatchObject({id:first.id,isLatest:false});
    expect(store.listIssueDeliveries(f.root.id,{limit:1,before:first.id})[0]).toMatchObject({id:second.id,isLatest:true});
    expect(() => store.authorizeIssueDelivery(f.root.id,first.id,f.owner.id,first.responsibilityRevision,human)).toThrow('latest pending');
    expect(() => store.respondIssueDelivery(f.root.id,first.id,{action:'accept',revision:first.responsibilityRevision},human)).toThrow('latest delivery');
    store.authorizeIssueDelivery(f.root.id,second.id,f.owner.id,second.responsibilityRevision,human);
    expect(store.respondIssueDelivery(f.root.id,second.id,{action:'accept',revision:second.responsibilityRevision},f.ownerActor).status).toBe('accepted');
    expect(store.getIssue(f.root.id)?.status).toBe('done');
  }));
  for (const fact of ['human','execution','leader','agent_restore','human_workspace'] as const) it(`permanently invalidates a pending delivery and proxy grant after ${fact} ABA`, () => run((store) => {
    const f = fixture(store);
    store.updateIssue(f.child.id,{status:'cancelled'});
    const team = fact === 'leader' ? store.createSquad({name:'Delivery team',leaderId:f.owner.id,memberIds:[f.owner.id,f.worker.id]}) : null;
    if (team) store.updateIssue(f.root.id,{assigneeType:'squad',assigneeId:team.id});
    const delivery = store.submitIssueDelivery(f.root.id,{summary:'Original receipt'},f.ownerActor);
    const human = {type:'member' as const,id:f.human.id};
    store.authorizeIssueDelivery(f.root.id,delivery.id,f.owner.id,delivery.responsibilityRevision,human);
    const transfer = (id:string) => store.updateIssue(f.root.id,fact === 'human'
      ? {responsibleMemberId:id,actorType:'member',actorId:f.human.id}
      : {assigneeType:'agent',assigneeId:id,actorType:'member',actorId:f.human.id});
    if (fact === 'human') { transfer(f.other.id); transfer(f.human.id); }
    if (fact === 'execution') { transfer(f.worker.id); transfer(f.owner.id); }
    if (fact === 'leader') { store.updateSquad(team!.id,{leaderId:f.worker.id}); store.updateSquad(team!.id,{leaderId:f.owner.id}); }
    if (fact === 'agent_restore') { store.archiveAgent(f.owner.id); store.restoreAgent(f.owner.id); }
    if (fact === 'human_workspace') {
      const foreign = store.createWorkspace({id:'delivery-human-foreign',name:'Foreign',slug:'delivery-human-foreign'});
      store.updateWorkspaceMember(f.human.id,{workspaceId:foreign.id});
      store.updateWorkspaceMember(f.human.id,{workspaceId:'local'});
    }
    expect(store.resolveIssueResponsibility(f.root.id).revision).toBe(delivery.responsibilityRevision);
    const invalidated = store.listIssueDeliveries(f.root.id)[0]!;
    expect(invalidated.invalidatedAt).toBeString();
    expect(invalidated.status).toBe('pending');
    expect(invalidated.authorization?.agentId).toBe(f.owner.id);
    expect(() => store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('Responsibility changed');
    expect(() => store.respondIssueDelivery(f.root.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},human)).toThrow('Responsibility changed');
    expect(() => store.authorizeIssueDelivery(f.root.id,delivery.id,f.owner.id,delivery.responsibilityRevision,human)).toThrow('Responsibility changed');
    expect(store.listIssueActivity(f.root.id).filter(row=>row.type==='issue_delivery_invalidated')).toHaveLength(1);
    const fresh = store.submitIssueDelivery(f.root.id,{summary:'Fresh explicit review'},f.ownerActor);
    expect(store.respondIssueDelivery(f.root.id,fresh.id,{action:'accept',revision:fresh.responsibilityRevision},human).status).toBe('accepted');
  }));
  it('invalidates descendant receipts atomically and preserves grants on rollback or ordinary edits', () => run((store,db) => {
    const f = fixture(store);
    store.updateIssue(f.child.id,{status:'cancelled'});
    const rootDelivery = store.submitIssueDelivery(f.root.id,{summary:'Root receipt'},f.ownerActor);
    store.updateIssue(f.child.id,{status:'in_progress'});
    const childDelivery = store.submitIssueDelivery(f.child.id,{summary:'Child receipt'},f.workerActor);
    store.authorizeIssueDelivery(f.root.id,rootDelivery.id,f.owner.id,rootDelivery.responsibilityRevision,{type:'member',id:f.human.id});
    const before = store.listIssueDeliveries(f.root.id)[0];
    store.updateIssue(f.root.id,{title:'Ordinary edit'});
    expect(store.listIssueDeliveries(f.root.id)[0]).toEqual(before);
    expect(() => db.transaction(() => {
      store.updateIssue(f.root.id,{responsibleMemberId:f.other.id,actorType:'member',actorId:f.human.id});
      expect(store.listIssueDeliveries(f.child.id)[0]?.invalidatedAt).toBeString();
      throw new Error('rollback responsibility and receipt');
    })()).toThrow('rollback responsibility and receipt');
    expect(store.listIssueDeliveries(f.root.id)[0]).toEqual(before);
    expect(store.listIssueDeliveries(f.child.id)[0]?.invalidatedAt).toBeUndefined();
    expect(store.listIssueActivity(f.root.id).filter(row=>row.type==='issue_delivery_invalidated')).toHaveLength(0);
    store.updateIssue(f.root.id,{responsibleMemberId:f.other.id,actorType:'member',actorId:f.human.id});
    store.updateIssue(f.root.id,{responsibleMemberId:f.human.id,actorType:'member',actorId:f.other.id});
    expect(store.listIssueDeliveries(f.root.id)[0]?.invalidatedAt).toBeString();
    expect(store.listIssueDeliveries(f.child.id)[0]?.invalidatedAt).toBeString();
    expect(() => store.respondIssueDelivery(f.child.id,childDelivery.id,{action:'accept',revision:childDelivery.responsibilityRevision},f.ownerActor)).toThrow('Responsibility changed');
    expect(store.listIssueActivity(f.child.id).filter(row=>row.type==='issue_delivery_invalidated')).toHaveLength(1);
  }));
  it('does not invalidate foreign pending receipts through a corrupt historical parent link', () => run((store,db) => {
    const f = fixture(store);
    const childDelivery = store.submitIssueDelivery(f.child.id,{summary:'Normal descendant'},f.workerActor);
    const workspace = store.createWorkspace({id:'foreign-delivery-ws',name:'Foreign delivery',slug:'foreign-delivery-ws'});
    const human = store.createWorkspaceMember({id:'foreign-delivery-human',name:'Foreign human',workspaceId:workspace.id});
    const agent = store.createAgent({name:'Foreign executor',provider:'claude',workspaceId:workspace.id});
    const foreign = store.createIssue({title:'Foreign pending receipt',workspaceId:workspace.id,responsibleMemberId:human.id,assigneeType:'agent',assigneeId:agent.id});
    const task = store.createTask({agentId:agent.id,issueId:foreign.id,prompt:'Foreign delivery'});
    const delivery = store.submitIssueDelivery(foreign.id,{summary:'Foreign result'},{type:'agent',id:agent.id,taskId:task.id});
    db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?',[f.root.id,foreign.id]);
    expect(store.resolveIssueResponsibility(foreign.id).unresolved.some(item=>item.reason==='workspace_mismatch')).toBeTrue();
    const before = {message:store.getMessage(delivery.id),activity:store.listIssueActivity(foreign.id)};
    expect(() => db.transaction(() => {
      store.updateIssue(f.root.id,{responsibleMemberId:f.other.id,actorType:'member',actorId:f.human.id});
      throw new Error('rollback cross-workspace responsibility');
    })()).toThrow('rollback cross-workspace responsibility');
    expect(store.listIssueDeliveries(f.child.id)[0]?.invalidatedAt).toBeUndefined();
    expect({message:store.getMessage(delivery.id),activity:store.listIssueActivity(foreign.id)}).toEqual(before);
    store.updateIssue(f.root.id,{responsibleMemberId:f.other.id,actorType:'member',actorId:f.human.id});
    expect(store.listIssueDeliveries(f.child.id)[0]).toMatchObject({id:childDelivery.id,invalidatedAt:expect.any(String)});
    expect({message:store.getMessage(delivery.id),activity:store.listIssueActivity(foreign.id)}).toEqual(before);
    expect(store.listIssueDeliveries(foreign.id)[0]?.invalidatedAt).toBeUndefined();
  }));
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
  it('rejects delivery authorization across corrupt parent chains even if a local execution owner still exists', () => run((store,db) => {
    const f=fixture(store);const delivery=store.submitIssueDelivery(f.child.id,{summary:'Before corruption'},f.workerActor);
    db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?',[f.child.id,f.root.id]);
    expect(store.resolveIssueResponsibility(f.child.id).unresolved).toContainEqual({issueId:f.child.id,reason:'parent_cycle'});
    expect(()=>store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('responsibility chain');
    db.run('UPDATE multiremi_issues SET parent_issue_id=NULL WHERE id=?',[f.root.id]);
    db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?',['missing-parent',f.child.id]);
    expect(store.resolveIssueResponsibility(f.child.id).executionOwner?.id).toBe(f.worker.id);
    expect(()=>store.submitIssueDelivery(f.child.id,{summary:'Broken chain'},f.workerActor)).toThrow('responsibility chain');
    expect(store.listIssueDeliveries(f.child.id)[0]?.status).toBe('pending');
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
    expect(()=>store.quickCreateIssue({prompt:'Dispatch without Leader',squadId:team.id,responsibleMemberId:f.human.id})).toThrow('No runnable agent');
    const report=db.transaction(()=>store.sendEnvelopeWithinTransaction({to:{role:'issue_owner',issueId:f.child.id},kind:'report',wake:'now',body:'Owner unavailable',source:{}},[],createCommitEventQueue()))()[0]!;
    expect(store.getMessage(report.entry.id)?.to_member_id).toBe(f.human.id);
    expect(store.getMessage(report.entry.id)?.to_agent_id).toBeNull();
    expect(report.entry.metadata.responsibility_unresolved).toContainEqual({issueId:f.child.id,reason:'leader_missing'});
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
  for (const parentState of ['done','cancelled','archived'] as const) it(`persists a late formal delivery without waking its ${parentState} parent`, () => run((store,db) => {
    const f = fixture(store);
    store.updateIssue(f.child.id,{status:'cancelled'});
    const rootDelivery = store.submitIssueDelivery(f.root.id,{summary:'Original settled root result'},f.ownerActor);
    const rootReceipt = store.respondIssueDelivery(f.root.id,rootDelivery.id,{action:'accept',revision:rootDelivery.responsibilityRevision},{type:'member',id:f.human.id});
    if (parentState === 'cancelled') store.updateIssue(f.root.id,{status:'cancelled'});
    if (parentState === 'archived') store.archiveEligibleIssues(new Date(Date.now()+8*24*60*60*1000));
    const lateChild = store.createIssue({title:'Late child',parentIssueId:f.root.id,assigneeType:'agent',assigneeId:f.worker.id});
    const task = store.createTask({agentId:f.worker.id,issueId:lateChild.id,prompt:'Persist the late result'});
    const parentSession = store.getOrCreateDefaultIssueSession(f.root.id);
    const countParentTurns = () => Number(db.query('SELECT COUNT(*) AS total FROM multiremi_turns WHERE issue_id=?').get(f.root.id)?.total);
    const turnsBefore = countParentTurns();
    const messagesBefore = store.listMessages(parentSession.id).map(message=>message.id);
    const delivery = store.submitIssueDelivery(lateChild.id,{summary:'Late verified result'},{type:'agent',id:f.worker.id,taskId:task.id});
    const reason = parentState === 'archived' ? 'review_issue_archived' : 'review_issue_closed';
    expect(delivery.reviewUnavailableReason).toBe(reason);
    expect(delivery.sourceSessionId).toBe(task.issueSessionId!);
    expect(store.listIssueDeliveries(lateChild.id)[0]).toEqual(delivery);
    expect(store.getIssue(lateChild.id)?.status).toBe('in_review');
    expect(store.getIssue(f.root.id)?.status).toBe(parentState === 'cancelled' ? 'cancelled' : 'done');
    expect(store.listIssueDeliveries(f.root.id)[0]?.status).toBe('accepted');
    expect(store.listIssueDeliveries(f.root.id)[0]?.responseMessageId).toBe(rootReceipt.responseMessageId);
    expect(countParentTurns()).toBe(turnsBefore);
    expect(store.listMessages(parentSession.id).map(message=>message.id)).toEqual(messagesBefore);
    const activity = store.listIssueActivity(f.root.id).filter(entry=>entry.type==='issue_delivery_review_unavailable');
    expect(activity).toHaveLength(1);
    expect(activity[0]?.data).toMatchObject({childIssueId:lateChild.id,deliveryId:delivery.id,reason});
    expect(()=>store.respondIssueDelivery(lateChild.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('Reopen the parent');
    expect(()=>store.respondIssueDelivery(lateChild.id,delivery.id,{action:'return',body:'Review later',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('Reopen the parent');
    expect(store.listIssueDeliveries(lateChild.id)[0]?.responseMessageId).toBeNull();
    if (parentState !== 'archived') {
      store.updateIssue(f.root.id,{status:'in_progress'});
      expect(store.listIssueDeliveries(lateChild.id)[0]?.reviewUnavailableReason).toBeUndefined();
      expect(store.respondIssueDelivery(lateChild.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor).status).toBe('accepted');
    }
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
  it('migrates unknown legacy human ownership additively and idempotently without changing message references', () => run((store,db,restart) => {
    const f=fixture(store);
    const delivery=store.submitIssueDelivery(f.child.id,{summary:'Historical delivery'},f.workerActor);
    const count=Number(db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log').get()?.total);
    db.exec('ALTER TABLE multiremi_issues DROP COLUMN responsible_member_id');
    const migrated=restart();
    expect(migrated.store.getIssue(f.root.id)?.responsibleMemberId).toBeNull();
    expect(migrated.store.resolveIssueResponsibility(f.child.id).unresolved).toContainEqual({issueId:f.root.id,reason:'human_missing'});
    expect(migrated.store.listIssueDeliveries(f.child.id)[0]?.sourceSessionId).toBe(delivery.sourceSessionId);
    const again=restart();
    expect(again.store.getMessage(delivery.id)?.session_id).toBe(delivery.sourceSessionId);
    expect(Number(again.db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log').get()?.total)).toBe(count);
  }));
  it('rolls back answer, delivery receipt and status when the final status write fails', () => run((store,db) => {
    const f=fixture(store);const delivery=store.submitIssueDelivery(f.child.id,{summary:'Transactional acceptance'},f.workerActor);
    const originalRun=db.run;
    db.run=function(sql:string,parameters?:unknown[]) {
      if (/UPDATE multiremi_issues SET\s+title =/.test(sql)) return originalRun.call(db,'INSERT INTO responsibility_fault_missing_table(id) VALUES (?)',['failure']);
      return originalRun.call(db,sql,parameters);
    };
    try { expect(()=>store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow(); }
    finally { db.run=originalRun; }
    expect(store.getIssue(f.child.id)?.status).toBe('in_review');
    expect(store.listIssueDeliveries(f.child.id)[0]?.status).toBe('pending');
    expect(store.listIssueDeliveries(f.child.id)[0]?.responseMessageId).toBeNull();
    expect(Number(db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log WHERE reply_to_id=?').get(delivery.id)?.total)).toBe(0);
  }));
  it('keeps acceptance follow-ups inside the outermost commit boundary', () => run((store,db) => {
    const f=fixture(store);const delivery=store.submitIssueDelivery(f.child.id,{summary:'Outer atomicity'},f.workerActor);
    const events:string[]=[];const off=store.onWorkspaceEvent(event=>events.push(event.type));
    try {
      expect(()=>db.transaction(()=>{
        store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor);
        expect(events).toEqual([]);
        throw new Error('outer rollback');
      })()).toThrow('outer rollback');
      expect(events).toEqual([]);
      expect(store.getIssue(f.child.id)?.status).toBe('in_review');
      expect(store.listIssueDeliveries(f.child.id)[0]?.status).toBe('pending');
      expect(Number(db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log WHERE reply_to_id=?').get(delivery.id)?.total)).toBe(0);
    } finally {off();}
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
  it('rejects batch closure before any row changes and ignores body acceptance options on both HTTP surfaces', () => run(async (store,db) => {
    const f=fixture(store);store.updateIssue(f.child.id,{status:'cancelled'});
    const submitted=store.submitIssueDelivery(f.root.id,{summary:'Legitimate settled root'},f.ownerActor);
    const receipt=store.respondIssueDelivery(f.root.id,submitted.id,{action:'accept',revision:submitted.responsibilityRevision},{type:'member',id:f.human.id});
    const token=await store.createAccessToken({name:'Batch test member',type:'pat',workspaceId:'local',userId:'local'});
    const app=createMultiremiApp({store,authToken:'batch-test'});
    const headers={Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'};
    const activityCount=()=>Number(db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log').get()?.total);
    const events:string[]=[];const off=store.onWorkspaceEvent(event=>events.push(event.type));
    try {
      for(const surface of ['/api/issues','/api/multiremi/issues'])for(const injected of [
        {},{force:true},{acceptedDeliveryId:receipt.id},{accepted_delivery_id:receipt.id},
        {options:{acceptedDeliveryId:receipt.id,allowParentStatusGuardBypass:true}},
      ]) {
        const before=activityCount();
        const response=await app.request(`${surface}/batch-update`,{method:'POST',headers,
          body:JSON.stringify({issue_ids:[f.root.id,f.child.id],updates:{status:'done',title:'Must not partially write',...injected}})});
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe('issue_delivery_acceptance_required');
        expect(store.getIssue(f.root.id)).toMatchObject({status:'done',title:'Root'});
        expect(store.getIssue(f.child.id)).toMatchObject({status:'cancelled',title:'Child'});
        expect(activityCount()).toBe(before);
        expect(events).toEqual([]);
        expect(store.listIssueDeliveries(f.root.id)[0]?.responseMessageId).toBe(receipt.responseMessageId);
      }
      for(const surface of ['/api/issues','/api/multiremi/issues']) {
        const response=await app.request(`${surface}/batch-update`,{method:'POST',headers,
          body:JSON.stringify({issue_ids:[f.root.id],updates:{status:'done'}})});
        expect(response.status).toBe(200);
        expect((await response.json()).updated).toBe(1);
      }
    } finally {off();}
  }));
  it('rolls back earlier batch rows and deferred events when a per-row delivery guard changes after preflight', () => run(async (store,db) => {
    const f=fixture(store);store.updateIssue(f.child.id,{status:'cancelled'});
    const first=store.submitIssueDelivery(f.root.id,{summary:'First settled result'},f.ownerActor);
    store.respondIssueDelivery(f.root.id,first.id,{action:'accept',revision:first.responsibilityRevision},{type:'member',id:f.human.id});
    const second=store.createIssue({title:'Second root',responsibleMemberId:f.human.id,assigneeType:'agent',assigneeId:f.owner.id});
    const task=store.createTask({agentId:f.owner.id,issueId:second.id,prompt:'Settle the second root'});
    const delivered=store.submitIssueDelivery(second.id,{summary:'Second settled result'},{type:'agent',id:f.owner.id,taskId:task.id});
    store.respondIssueDelivery(second.id,delivered.id,{action:'accept',revision:delivered.responsibilityRevision},{type:'member',id:f.human.id});
    const app=createMultiremiApp({store,authToken:'batch-test'});
    const token=await store.createAccessToken({name:'Batch race member',type:'pat',workspaceId:'local',userId:'local'});
    for(const surface of ['/api/issues','/api/multiremi/issues']) {
      const before=Number(db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log').get()?.total);
      const events:string[]=[];const off=store.onWorkspaceEvent(event=>events.push(event.type));
      const append=StoreContext.prototype.appendIssueActivity;let fired=false;
      StoreContext.prototype.appendIssueActivity=function(issueId,input,...rest) {
        if(issueId===second.id&&input.type==='issue_updated') {
          expect(this.db.inTransaction).toBeTrue();
          expect(this.issues().getIssue(f.root.id)?.title).toBe('Batch title');
          fired=true;throw new IssueDeliveryError('issue_delivery_revision_stale','Competing responsibility change');
        }
        return append.call(this,issueId,input,...rest);
      };
      try {
        const response=await app.request(`${surface}/batch-update`,{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},
          body:JSON.stringify({issue_ids:[f.root.id,second.id],updates:{status:'done',title:'Batch title'}})});
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe('issue_delivery_revision_stale');
      } finally {StoreContext.prototype.appendIssueActivity=append;off();}
      expect(fired).toBeTrue();
      expect(store.getIssue(f.root.id)?.title).toBe('Root');
      expect(store.getIssue(second.id)?.title).toBe('Second root');
      expect(Number(db.query('SELECT COUNT(*) AS total FROM multiremi_conversation_log').get()?.total)).toBe(before);
      expect(events).toEqual([]);
      expect(store.listIssueDeliveries(f.root.id)[0]?.status).toBe('accepted');
      expect(store.listIssueDeliveries(second.id)[0]?.status).toBe('accepted');
    }
  }));
  it('uses the actual source human for task-created roots and never the Runtime owner or a forged creator', () => run(async (store,db) => {
    const f=fixture(store);const app=createMultiremiApp({store,authToken:'test-root'});
    const sourceToken=await store.createTaskAccessToken(store.getTask(f.workerActor.taskId)!,'local');
    const create=async (path:string,token:string) => app.request(path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({title:'Root from real source',created_by:'local',createdBy:'local'})});
    for(const path of ['/api/issues','/api/multiremi/issues']) {
      const response=await create(path,sourceToken.token);expect(response.status).toBe(201);
      const body=await response.json();const id=body.issue?.id??body.id;
      expect(store.getIssue(id)?.responsibleMemberId).toBe(f.human.id);
      expect(store.getIssue(id)?.createdBy).not.toBe('local');
    }
    const chat=store.createChatSession({agentId:f.worker.id,creatorId:f.other.id});
    const task=store.createTask({agentId:f.worker.id,chatSessionId:chat.id,prompt:'Create from Chat'});
    const chatToken=await store.createTaskAccessToken(task,'local');
    const response=await create('/api/issues',chatToken.token);expect(response.status).toBe(201);
    const body=await response.json();expect(store.getIssue(body.issue?.id??body.id)?.responsibleMemberId).toBe(f.other.id);
    db.run('UPDATE multiremi_chat_sessions SET creator_id=? WHERE id=?',['unknown-legacy-human',chat.id]);
    const missing=await create('/api/issues',chatToken.token);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).toContain('explicit responsible_member_id');
  }));
  it('uses only the actual active automation run and freezes its explicit human on new roots', () => run(async (store,db) => {
    const f=fixture(store);const app=createMultiremiApp({store,authToken:'test-root'});
    const automation=store.createAutopilot({title:'Configured run source',assigneeId:f.worker.id,executionMode:'run_only',responsibleMemberId:f.human.id});
    const scheduled=store.runAutopilot(automation.id,{source:'api'});
    const task=store.getTask(scheduled.taskId!)!;
    const token=await store.createTaskAccessToken(task,'local');
    const headers={Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'};
    const createdIds:string[]=[];
    for(const path of ['/api/issues','/api/multiremi/issues']) {
      const response=await app.request(path,{method:'POST',headers,body:JSON.stringify({title:'Automation child root',created_by:'local',
        responsibilitySourceAudit:{kind:'autopilot_run',taskId:'forged',runId:'forged',autopilotId:'forged',responsibleMemberId:f.other.id},
        responsibility_source_audit:{taskId:'forged-snake'}})});
      expect(response.status).toBe(201);const body=await response.json();const id=body.issue?.id??body.id;
      createdIds.push(id);expect(store.getIssue(id)?.responsibleMemberId).toBe(f.human.id);
      expect(store.listIssueActivity(id).find(entry=>entry.type==='issue_created')?.data).toMatchObject({responsibilitySource:{
        kind:'autopilot_run',taskId:task.id,runId:scheduled.id,autopilotId:automation.id,responsibleMemberId:f.human.id}});
    }
    const unrelated=store.createTask({agentId:f.worker.id,prompt:'No verified source'});
    const unrelatedToken=await store.createTaskAccessToken(unrelated,'local');
    const forged=await app.request('/api/issues',{method:'POST',headers:{...headers,Authorization:`Bearer ${unrelatedToken.token}`},
      body:JSON.stringify({title:'Forged source',autopilotRunId:scheduled.id,autopilot_run_id:scheduled.id,created_by:'local'})});
    expect(forged.status).toBe(409);
    const ordinary=await app.request('/api/multiremi/issues',{method:'POST',headers:{...headers,Authorization:'Bearer test-root'},
      body:JSON.stringify({title:'Human source is not a run',responsibilitySourceAudit:{kind:'autopilot_run',taskId:task.id,runId:scheduled.id,autopilotId:automation.id,responsibleMemberId:f.human.id}})});
    expect(ordinary.status).toBe(201);const ordinaryBody=await ordinary.json();
    expect(store.listIssueActivity(ordinaryBody.issue?.id??ordinaryBody.id).find(entry=>entry.type==='issue_created')?.data).not.toHaveProperty('responsibilitySource');
    store.updateAutopilot(automation.id,{responsibleMemberId:f.other.id});
    for(const id of createdIds)expect(store.getIssue(id)?.responsibleMemberId).toBe(f.human.id);
    const next=await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Current authorized configuration'})});
    expect(next.status).toBe(201);expect(store.getIssue((await next.json()).id)?.responsibleMemberId).toBe(f.other.id);
    store.updateAutopilot(automation.id,{status:'paused'});
    expect((await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Inactive source'})})).status).toBe(409);
    store.updateAutopilot(automation.id,{status:'active'});
    db.run('UPDATE multiremi_turns SET execution_scope=? WHERE current_attempt_id=?',['unrelated-scope',task.id]);
    expect((await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Wrong run scope'})})).status).toBe(409);
  }));
  it('preserves verified formal Agent source taint through HTTP acceptance and system-event dispatch', () => run(async (store,db) => {
    const human=store.findWorkspaceMemberForUser('local','local')!;
    const restricted=store.createAgent({name:'Restricted formal owner',provider:'claude',issueCreationRequiresProposal:true});
    const worker=store.createAgent({name:'Automation worker',provider:'claude'});
    const project=store.createProject({title:'Formal source project'});
    const issue=store.createIssue({title:'Formal tainted result',responsibleMemberId:human.id,assigneeType:'agent',assigneeId:restricted.id,projectId:project.id});
    const source=store.createTask({agentId:restricted.id,issueId:issue.id,prompt:'Deliver restricted result'});
    const innocent=store.createTask({agentId:worker.id,prompt:'Unrelated source'});
    const auto=store.createAutopilot({title:'Clean event configuration',responsibleMemberId:human.id,assigneeId:worker.id,executionMode:'trigger_issue',projectId:project.id});
    store.createAutopilotTrigger(auto.id,{kind:'system_event',eventConfig:{resource:'issue',event:'status_changed',conditions:[{field:'status',operator:'becomes',value:'done'}],projectId:project.id}});
    const app=createMultiremiApp({store,authToken:'test-root'});const credential=await store.createTaskAccessToken(source,'local');
    const headers={Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json'};
    const submission=await app.request(`/api/issues/${issue.id}/deliveries`,{method:'POST',headers,body:JSON.stringify({summary:'Verified formal result',parentTaskId:innocent.id})});
    expect(submission.status).toBe(201);const {delivery}=await submission.json();
    const authorized=await app.request(`/api/issues/${issue.id}/deliveries/${delivery.id}/authorize`,{method:'POST',headers:{...headers,Authorization:'Bearer test-root'},
      body:JSON.stringify({agentId:restricted.id,revision:delivery.responsibilityRevision})});
    expect(authorized.status).toBe(200);
    const accepted=await app.request(`/api/issues/${issue.id}/deliveries/${delivery.id}/respond`,{method:'POST',headers,
      body:JSON.stringify({action:'accept',revision:delivery.responsibilityRevision,parentTaskId:innocent.id,parent_task_id:innocent.id})});
    expect(accepted.status).toBe(200);
    const event=db.query("SELECT payload FROM multiremi_system_events WHERE resource_id=? AND event='status_changed'").all(issue.id)
      .find(row=>JSON.parse(row.payload).status==='done')!;
    expect(JSON.parse(event.payload).automation_source_task_id).toBe(source.id);
    const [dispatched]=store.dispatchPendingSystemEvents();expect(dispatched).toBeDefined();
    const task=store.getTask(dispatched!.taskId!)!;expect(task.issueCreationRestricted).toBe(true);
    const dispatchedCredential=await store.createTaskAccessToken(task,'local');
    const denied=await app.request('/api/issues',{method:'POST',headers:{...headers,Authorization:`Bearer ${dispatchedCredential.token}`},body:JSON.stringify({title:'Proxy does not relax creation policy'})});
    expect(denied.status).toBe(403);expect(await denied.json()).toMatchObject({code:'issue_creation_requires_proposal'});
  }));
  it('assigns and updates through real HTTP surfaces at depth one and rolls back dispatch failures with every fact', () => run(async (store,db) => {
    for(const [surface,method,suffix] of [['/api/multiremi/issues','POST','/assign'],['/api/multiremi/issues','PATCH',''],['/api/issues','PATCH','']] as const) {
      const f=fixture(store,`_${method}_${surface.includes('multiremi')?'native':'compat'}`);const next=store.createAgent({name:'Atomic assignment target',provider:'claude'});
      const runtime=store.registerRuntime({name:'Atomic assignment source',provider:'codex',daemonId:'atomic-assignment',maxConcurrency:8});
      store.updateAgent(f.worker.id,{provider:'codex',runtimeId:runtime.id});
      const source=store.claimTask(runtime.id)!;store.startTask(source.id);
      expect(source.id).toBe(f.workerActor.taskId);
      const turn=store.getTurnForAttempt(source.id)!;
      const question=store.getDaemonTurnBridge().rpc('turn.decision',{turn_id:turn.id,attempt_id:source.id,dedupe_key:'atomic-question',body_md:'Review assignment?',
        options:[{label:'Yes',value:'yes'}],metadata:{kind:'question'},timeout_ms:1000},{runtimeId:runtime.id,daemonId:'atomic-assignment',workspaceId:'local'});
      expect(question.ok).toBeTrue();const questionId=String(question.message_id);
      db.run('UPDATE multiremi_conversation_log SET card_token_hash=?,card_token_recipient=? WHERE id=?',['old-card-token','old-recipient',questionId]);
      const beforeQuestion=store.getQuestion(questionId);
      const app=createMultiremiApp({store,authToken:'test-root'});
      const before=store.getIssue(f.child.id)!;
      const taskFacts=store.listTasksForIssue(f.child.id).map(task=>({id:task.id,status:task.status}));
      const activities=store.listIssueActivity(f.child.id).map(entry=>entry.id);
      const emitted:boolean[]=[];const unsubscribe=store.onWorkspaceEvent(()=>emitted.push(db.inTransaction===true));
      if(db.dialect==='postgres') {
        db.run(`CREATE FUNCTION reject_assignment_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_id='${next.id}' THEN RAISE EXCEPTION 'assignment dispatch rejected'; END IF; RETURN NEW; END $$`);
        db.exec('CREATE TRIGGER reject_assignment_turn BEFORE INSERT ON multiremi_turns FOR EACH ROW EXECUTE FUNCTION reject_assignment_turn()');
      } else db.exec(`CREATE TRIGGER reject_assignment_turn BEFORE INSERT ON multiremi_turns WHEN NEW.agent_id='${next.id}' BEGIN SELECT RAISE(ABORT,'assignment dispatch rejected'); END`);
      const request=()=>app.request(`${surface}/${f.child.id}${suffix}`,{method,headers:{Authorization:'Bearer test-root','Content-Type':'application/json'},
        body:JSON.stringify({assignee_type:'agent',assignee_id:next.id})});
      try {
        const failed=await request();expect(failed.status).toBe(500);
        expect(store.getIssue(f.child.id)).toEqual(before);
        expect(store.listTasksForIssue(f.child.id).map(task=>({id:task.id,status:task.status}))).toEqual(taskFacts);
        expect(store.listIssueActivity(f.child.id).map(entry=>entry.id)).toEqual(activities);
        expect(store.getQuestion(questionId)).toEqual(beforeQuestion);
        expect(db.query('SELECT card_token_hash FROM multiremi_conversation_log WHERE id=?').get(questionId)?.card_token_hash).toBe('old-card-token');
        expect(emitted).toEqual([]);
      } finally {
        db.exec('DROP TRIGGER reject_assignment_turn'+(db.dialect==='postgres'?' ON multiremi_turns':''));
        if(db.dialect==='postgres')db.exec('DROP FUNCTION reject_assignment_turn()');
      }
      if(db instanceof PostgresSyncDatabase)db.resetTransactionDepthStats();
      const assigned=await request();expect(assigned.status).toBe(200);
      expect(store.getIssue(f.child.id)?.assigneeId).toBe(next.id);
      expect(store.getIssue(f.child.id)?.status).toBe('todo');
      expect(store.listTasksForIssue(f.child.id).filter(task=>task.agentId===next.id)).toHaveLength(1);
      expect(store.listIssueActivity(f.child.id).filter(entry=>entry.type==='issue_assigned')).toHaveLength(1);
      expect(store.getQuestion(questionId)?.route_revision).toBe(beforeQuestion!.route_revision+1);
      expect(db.query('SELECT card_token_hash FROM multiremi_conversation_log WHERE id=?').get(questionId)?.card_token_hash).toBeNull();
      expect(emitted.length).toBeGreaterThan(0);expect(emitted.every(inTransaction=>!inTransaction)).toBeTrue();
      if(db instanceof PostgresSyncDatabase)expect(db.maxTransactionDepth).toBe(1);
      unsubscribe();
    }
  }),60_000);
  it('rejects formal submission and acceptance from an independent non-default session through real task HTTP credentials', () => run(async store => {
    const f = fixture(store);
    const childSide = store.createIssueSession(f.child.id, { title: 'Independent execution discussion' });
    const parentSide = store.createIssueSession(f.root.id, { title: 'Independent review discussion' });
    expect(childSide).toMatchObject({ isDefault: false, inheritMode: 'none' });
    expect(parentSide).toMatchObject({ isDefault: false, inheritMode: 'none' });
    const childTask = store.createSessionTask(childSide.id, { agentId: f.worker.id, prompt: 'Independent execution' });
    const parentTask = store.createSessionTask(parentSide.id, { agentId: f.owner.id, prompt: 'Independent review' });
    const childAccess = await store.createTaskAccessToken(childTask, 'local');
    const parentAccess = await store.createTaskAccessToken(parentTask, 'local');
    const app = createMultiremiApp({ store, authToken: 'independent-session-test' });
    const request = (path: string, token: string, body: unknown) => app.request(path, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const submit = await request(`/api/issues/${f.child.id}/deliveries`, childAccess.token, { summary: 'Forbidden independent report' });
    expect(submit.status).toBe(403);
    expect(await submit.json()).toMatchObject({ code: 'issue_delivery_side_session_forbidden' });
    expect(store.listIssueDeliveries(f.child.id)).toEqual([]);
    const delivery = store.submitIssueDelivery(f.child.id, { summary: 'Actual Main result' }, f.workerActor);
    const accept = await request(`/api/issues/${f.child.id}/deliveries/${delivery.id}/respond`, parentAccess.token,
      { action: 'accept', expected_revision: delivery.responsibilityRevision });
    expect(accept.status).toBe(403);
    expect(await accept.json()).toMatchObject({ code: 'issue_delivery_side_session_forbidden' });
    expect(store.listIssueDeliveries(f.child.id)[0]).toMatchObject({ status: 'pending', responseMessageId: null });
    expect(store.getIssue(f.child.id)?.status).toBe('in_review');
  }));
  it('ignores malformed historical report metadata without discarding valid deliveries', () => run((store, db) => {
    const f = fixture(store);
    const delivery = store.submitIssueDelivery(f.child.id, { summary: 'Valid delivery among historical reports' }, f.workerActor);
    const session = store.getOrCreateDefaultIssueSession(f.child.id);
    for (const metadata of ['not-json', '{"issue_delivery":', JSON.stringify({ unrelated: '\u0000' })]) {
      const message = store.sendMessage({ session_id: session.id, sender: { type: 'platform', id: null }, to: { type: 'none' },
        message_kind: 'report', wake_requested: 'inbox_only', body_md: 'Historical report' }).message;
      db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [metadata, message.id]);
    }
    expect(store.listIssueDeliveries(f.child.id).map(item => item.id)).toEqual([delivery.id]);
    const accepted = store.respondIssueDelivery(f.child.id, delivery.id, { action: 'accept', revision: delivery.responsibilityRevision }, f.ownerActor);
    expect(accepted.status).toBe('accepted');
    expect(store.getIssue(f.child.id)?.status).toBe('done');
  }));
  it('keeps human responsibility separate from execution and refuses side-session delivery or acceptance', () => run((store,db) => {
    const f=fixture(store);
    expect(()=>store.createIssue({title:'Human execution',assigneeType:'member',assigneeId:f.human.id,responsibleMemberId:f.human.id})).toThrow('Agent or team Leader');
    expect(()=>store.updateIssue(f.child.id,{assigneeType:'member',assigneeId:f.human.id})).toThrow('Agent or team Leader');
    const childMain=store.getOrCreateDefaultIssueSession(f.child.id);
    const side=store.createIssueSession(f.child.id,{parentSessionId:childMain.id});
    const sideTask=store.createSessionTask(side.id,{agentId:f.worker.id,prompt:'Discuss'});
    expect(()=>store.submitIssueDelivery(f.child.id,{summary:'Side delivery'},{type:'agent',id:f.worker.id,taskId:sideTask.id})).toThrow('main responsibility');
    expect(()=>store.submitIssueDelivery(f.child.id,{summary:'Redirect delivery',sessionId:side.id},f.workerActor)).toThrow('main session');
    const delivery=store.submitIssueDelivery(f.child.id,{summary:'Main delivery'},f.workerActor);
    const parentSide=store.createIssueSession(f.root.id,{parentSessionId:store.getOrCreateDefaultIssueSession(f.root.id).id});
    const parentTask=store.createSessionTask(parentSide.id,{agentId:f.owner.id,prompt:'Discuss review'});
    expect(()=>store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},{type:'agent',id:f.owner.id,taskId:parentTask.id})).toThrow('main responsibility');
    store.updateIssue(f.child.id,{status:'cancelled'});
    expect(()=>store.respondIssueDelivery(f.child.id,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},f.ownerActor)).toThrow('Reopen');
    expect(store.listIssueDeliveries(f.child.id)[0]?.status).toBe('pending');
    db.run("UPDATE multiremi_issues SET assignee_type='member',assignee_id=? WHERE id=?",[f.human.id,f.child.id]);
    expect(store.resolveIssueResponsibility(f.child.id).executionOwner).toBeNull();
  }));
  it('pages only formal reports and loads the referenced delivery precisely despite ordinary comments', () => run(async (store,db) => {
    const f=fixture(store);
    const first=store.submitIssueDelivery(f.child.id,{summary:'First'},f.workerActor);
    store.createIssueComment(f.child.id,{body:'An ordinary comment'});
    const second=store.submitIssueDelivery(f.child.id,{summary:'Second'},f.workerActor);
    store.createIssueComment(f.child.id,{body:'Another ordinary comment'});
    expect(store.listIssueDeliveries(f.child.id,{limit:1})[0]?.id).toBe(second.id);
    expect(store.listIssueDeliveries(f.child.id,{limit:1,before:second.id})[0]?.id).toBe(first.id);
    expect(store.listIssueDeliveries(f.child.id,{limit:1,before:first.id})).toEqual([]);
    const app=createMultiremiApp({store,authToken:'test-root'});
    const headers={Authorization:'Bearer test-root'};
    const page=await app.request(`/api/issues/${f.child.id}/deliveries?limit=1`,{headers});
    const body=await page.json();expect(body.deliveries[0].id).toBe(second.id);expect(body.nextCursor).toBe(second.id);
    const next=await app.request(`/api/issues/${f.child.id}/deliveries?limit=1&before=${body.nextCursor}`,{headers});
    expect((await next.json()).nextCursor).toBeNull();
    const originalQuery=db.query;const statements:string[]=[];
    db.query=function(sql:string){statements.push(sql);return originalQuery.call(db,sql);};
    try {expect(()=>store.respondIssueDelivery(f.child.id,first.id,{action:'accept',revision:first.responsibilityRevision},f.ownerActor)).toThrow('latest delivery');}
    finally {db.query=originalQuery;}
    const reads=statements.filter(sql=>sql.includes('SELECT m.id,m.created_at,m.metadata'));
    expect(reads.length).toBe(2);
    expect(reads.every(sql=>sql.includes('m.id=?')||sql.includes('LIMIT ?'))).toBeTrue();
  }));
});
