import { it, expect } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';

function setup(f: PendingTurnTestFixture) {
  const {store,db}=f;
  const runtime=store.registerRuntime({name:'Question runtime',provider:'codex',daemonId:'responsibility-hooks',maxConcurrency:8});
  const owner=store.createAgent({name:'Current owner',provider:'codex'});
  const next=store.createAgent({name:'Next owner',provider:'codex'});
  const worker=store.createAgent({name:'Question source',provider:'codex'});
  const root=store.createIssue({title:'Root',responsibleMemberId:'mem_local_local',assigneeType:'agent',assigneeId:owner.id});
  const task=store.createTask({agentId:worker.id,issueId:root.id,prompt:'Ask'});
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);store.startTask(task.id);
  const turn=store.getTurnForAttempt(task.id)!;
  const created=store.getDaemonTurnBridge().rpc('turn.decision',{turn_id:turn.id,attempt_id:task.id,dedupe_key:'transfer-question',body_md:'Which route?',
    options:[{label:'A',value:'A'}],metadata:{kind:'question'},timeout_ms:1000},{runtimeId:runtime.id,daemonId:'responsibility-hooks',workspaceId:'local'});
  expect(created.ok).toBeTrue(); const id=String(created.message_id);
  db.run('UPDATE multiremi_conversation_log SET card_token_hash=?,card_token_recipient=? WHERE id=?',['old-token','old-recipient',id]);
  return {...f,root,owner,next,worker,id};
}
pendingTurnBackendTests('explicit responsibility mutation hooks',fixture => {
  it('reassigns a deep child with an escalated pending Q atomically and preserves the parent handler',async()=>{
    const f=setup(fixture());
    const parentOwner=f.store.createAgent({name:'Parent execution',provider:'codex'});
    const grand=f.store.createIssue({id:'a_deep_root',title:'Grand root',responsibleMemberId:'mem_local_local',assigneeType:'agent',assigneeId:parentOwner.id});
    const parent=f.store.createIssue({id:'b_deep_parent',title:'Direct parent',parentIssueId:grand.id,assigneeType:'agent',assigneeId:parentOwner.id});
    f.store.updateIssue(f.root.id,{parentIssueId:parent.id,actorType:'member',actorId:'mem_local_local'});
    const ownerTurn=f.db.query("SELECT id FROM multiremi_turns WHERE agent_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(f.owner.id)!;
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[ownerTurn.id]);
    const q=f.store.getQuestion(f.id)!;
    f.store.escalateQuestion(f.id,{expected_route_revision:q.route_revision,reason:'Parent review needed'},{type:'agent',id:f.owner.id},String(ownerTurn.id));
    expect(f.store.getQuestion(f.id)?.current_handler?.id).toBe(parentOwner.id);
    const app=createMultiremiApp({store:f.store,authToken:'test-secret'});
    const response=await app.request(`/api/multiremi/issues/${f.root.id}/assign`,{method:'POST',headers:{Authorization:'Bearer test-secret','Content-Type':'application/json'},body:JSON.stringify({assignee_type:'agent',assignee_id:f.next.id})});
    expect(response.status).toBe(200);expect(f.store.getIssue(f.root.id)?.assigneeId).toBe(f.next.id);
    expect(f.store.getQuestion(f.id)?.current_handler?.id).toBe(parentOwner.id);
    expect(f.store.getQuestion(f.id)?.status).toBe('pending');
    expect(f.store.getIssue(grand.id)?.status).not.toBe('done');expect(f.store.getIssue(parent.id)?.status).not.toBe('done');
  });
  it('changes a pending Q handler in the same Issue mutation and invalidates its old card',()=>{
    const f=setup(fixture());
    f.store.updateIssue(f.root.id,{assigneeType:'agent',assigneeId:f.next.id,actorType:'member',actorId:'mem_local_local'});
    const q=f.store.getQuestion(f.id)!;
    expect(q.current_handler?.id).toBe(f.next.id);expect(q.route_revision).toBe(2);
    expect(q.history.filter(event=>event.type==='transfer' && event.reason === 'issue_responsibility_transferred')).toHaveLength(1);
    expect(f.db.query('SELECT card_token_hash FROM multiremi_conversation_log WHERE id=?').get(f.id)?.card_token_hash).toBeNull();
    expect(f.store.getMessage(f.id)?.to_agent_id).toBe(f.owner.id);
  });
  it('rolls back Issue assignment, question route and token invalidation together',()=>{
    const f=setup(fixture());
    expect(()=>f.db.transaction(()=>{
      f.store.updateIssue(f.root.id,{assigneeType:'agent',assigneeId:f.next.id});
      throw new Error('rollback owner transfer');
    })()).toThrow('rollback owner transfer');
    expect(f.store.getIssue(f.root.id)?.assigneeId).toBe(f.owner.id);
    expect(f.store.getQuestion(f.id)?.current_handler?.id).toBe(f.owner.id);
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(1);
    expect(f.db.query('SELECT card_token_hash FROM multiremi_conversation_log WHERE id=?').get(f.id)?.card_token_hash).toBe('old-token');
  });
  it('refreshes a Q when its assigned team Leader changes, without changing frozen recipients',()=>{
    const f=setup(fixture()); const team=f.store.createSquad({name:'Execution team',leaderId:f.owner.id});
    f.store.updateIssue(f.root.id,{assigneeType:'squad',assigneeId:team.id});
    const before=f.store.getQuestion(f.id)!.route_revision;
    f.store.updateSquad(team.id,{leaderId:f.next.id});
    expect(f.store.getQuestion(f.id)?.current_handler?.id).toBe(f.next.id);
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(before+1);
    expect(f.store.getMessage(f.id)?.to_agent_id).toBe(f.owner.id);
  });
  it('routes unavailable execution responsibility to the explicit human and re-routes on restore',()=>{
    const f=setup(fixture());
    f.store.archiveAgent(f.owner.id);
    expect(f.store.getQuestion(f.id)?.current_handler).toEqual({type:'member',id:'mem_local_local'});
    expect(f.store.resolveIssueResponsibility(f.root.id).unresolved).toContainEqual({issueId:f.root.id,reason:'agent_unavailable'});
    f.store.restoreAgent(f.owner.id);
    expect(f.store.getQuestion(f.id)?.current_handler?.id).toBe(f.owner.id);
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(3);
  });
  it('moves human-required pending Q to the new explicit root human',()=>{
    const f=setup(fixture());const human=f.store.createWorkspaceMember({id:'new-root-human',name:'New human'});
    const ownerTurn=f.db.query("SELECT id FROM multiremi_turns WHERE agent_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(f.owner.id)!;
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[ownerTurn.id]);
    f.store.escalateQuestion(f.id,{expected_route_revision:1,reason:'Need human'},{type:'agent',id:f.owner.id},String(ownerTurn.id));
    f.store.updateIssue(f.root.id,{responsibleMemberId:human.id,actorType:'member',actorId:'mem_local_local'});
    const q=f.store.getQuestion(f.id)!;
    // Transfer re-evaluates the existing Q against the current responsibility facts.
    expect(q.current_handler).toEqual({type:'member',id:human.id});
    expect(q.history.filter(event=>event.type==='transfer' && event.reason === 'issue_responsibility_transferred')).toHaveLength(1);
    expect(q.route_revision).toBe(3);
  });
  it('does not rotate a Q for unchanged responsibility and rotates once when the same Agent owns two ancestors',()=>{
    const f=setup(fixture());
    f.store.updateIssue(f.root.id,{responsibleMemberId:'mem_local_local',assigneeType:'agent',assigneeId:f.owner.id,actorType:'member',actorId:'mem_local_local'});
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(1);
    const ancestor=f.store.createIssue({title:'Ancestor',responsibleMemberId:'mem_local_local',assigneeType:'agent',assigneeId:f.owner.id});
    f.store.updateIssue(f.root.id,{parentIssueId:ancestor.id,actorType:'member',actorId:'mem_local_local'});
    const before=f.store.getQuestion(f.id)!.route_revision;
    f.store.archiveAgent(f.owner.id);
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(before+1);
  });
  it('makes an archived root human visibly unavailable without substituting a workspace owner',()=>{
    const f=setup(fixture());const human=f.store.createWorkspaceMember({id:'human-to-archive',name:'Specific human'});
    f.store.updateIssue(f.root.id,{responsibleMemberId:human.id,actorType:'member',actorId:'mem_local_local'});
    f.store.archiveWorkspaceMember(human.id);
    const responsibility=f.store.resolveIssueResponsibility(f.root.id);
    expect(responsibility.rootHuman).toBeNull();
    expect(responsibility.unresolved).toContainEqual({issueId:f.root.id,reason:'human_unavailable'});
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(3);
    expect(f.db.query('SELECT card_token_hash FROM multiremi_conversation_log WHERE id=?').get(f.id)?.card_token_hash).toBeNull();
  });
});
