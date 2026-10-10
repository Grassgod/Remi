import { createResponsibleTestIssue } from './helpers.js';
import {it,expect} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
import {StoreContext,createCommitEventQueue} from '@multiremi/store/context.js';
import {deriveIssueStatusWithinTransaction} from '@multiremi/store/inbox/issue-status.js';
import {foldAgentReadState,FOLD_AGENT_READ_STATE_MIGRATION} from '@multiremi/store/inbox/lane-migration.js';

pendingTurnBackendTests('MUL-506 Issue derivation and read progress',fixture=>{
  function setup(){const {store,db}=fixture(),agent=store.createAgent({name:'Owner',provider:'codex'});
    const issue=store.createIssue({title:'Derived',assigneeType:'agent',assigneeId:agent.id,responsibleMemberId:'mem_local_local'});
    const session=store.getOrCreateDefaultIssueSession(issue.id),ctx=new StoreContext(db,()=>store);
    const sent=store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:agent.id},message_kind:'request',wake_requested:'now',body_md:'work'});
    const derive=()=>db.transaction(()=>{ctx.lockWorkspaceRuntimeLifecycle('local');deriveIssueStatusWithinTransaction(ctx,issue.id,createCommitEventQueue());})();
    return {store,db,agent,issue,session,ctx,sent,derive};}
  for(const [turnStatus,status] of [['running','in_progress'],['awaiting_human','in_review'],['completed','in_review'],['failed','blocked'],['cancelled','todo']] as const){
    it(`derives ${status} from owner ${turnStatus}`,()=>{const f=setup();f.db.run("UPDATE multiremi_issues SET status='todo' WHERE id=?",[f.issue.id]);f.db.run('UPDATE multiremi_turns SET status=? WHERE id=?',[turnStatus,f.sent.turn_id!]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe(status);});}
  it('human and agent_dispatch pending become todo, platform pending preserves status',()=>{const f=setup();expect(f.store.getIssue(f.issue.id)?.status).toBe('todo');
    f.db.run("UPDATE multiremi_issues SET status='blocked' WHERE id=?",[f.issue.id]);f.db.run("UPDATE multiremi_conversation_log SET sender_type='platform',wake_reason='platform_to_owner' WHERE id=?",[f.sent.message.id]);f.db.run("UPDATE multiremi_turns SET wake_source='platform_to_owner' WHERE id=?",[f.sent.turn_id!]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('blocked');
    f.db.run("UPDATE multiremi_conversation_log SET sender_type='agent',wake_reason='agent_dispatch' WHERE id=?",[f.sent.message.id]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('todo');
    // Real writer path from the mixed-pending QA reproduction: do not replace
    // the merged-message trigger with a manually edited original trigger.
    const mergedIssue=f.store.createIssue({title:'Mixed pending',status:'blocked',assigneeType:'agent',assigneeId:f.agent.id,responsibleMemberId:'mem_local_local'});
    const mergedSession=f.store.getOrCreateDefaultIssueSession(mergedIssue.id);
    const base={session_id:mergedSession.id,to:{type:'agent' as const,ref:f.agent.id},wake_requested:'now' as const,body_md:'platform status'};
    const first=f.store.sendMessage({...base,sender:{type:'platform',id:null},message_kind:'status'});
    expect(f.store.getIssue(mergedIssue.id)?.status).toBe('blocked');
    const second=f.store.sendMessage({...base,sender:{type:'member',id:'mem_local_local'},message_kind:'request',body_md:'human starts work'});
    expect(second.turn_id).toBe(first.turn_id);
    expect(f.store.getIssue(mergedIssue.id)?.status).toBe('todo');});
  it('unanswered owner decision derives review, while running takes precedence',()=>{const f=setup();
    const runtime=f.store.registerRuntime({name:'Derivation native host',provider:'codex',daemonId:'derive-native'});
    const attempt=f.store.claimTask(runtime.id)!;f.store.startTask(attempt.id);
    const requested=f.store.getDaemonTurnBridge().rpc('turn.decision',{turn_id:f.sent.turn_id,attempt_id:attempt.id,wait_id:'derive-native-wait',dedupe_key:'derive-question',body_md:'Approve?',options:[],metadata:{kind:'question',questions:[{question:'Approve?'}]}},{runtimeId:runtime.id,daemonId:'derive-native',workspaceId:'local'});
    expect(requested.ok).toBe(true);const questionId=String(requested.message_id);
    expect(f.store.getIssue(f.issue.id)?.status).toBe('in_review');f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[f.sent.turn_id!]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('in_progress');
    f.store.answerMessageDecision(questionId,{sender:{type:'member',id:'mem_local_local'},expected_route_revision:f.store.getQuestion(questionId)!.route_revision,body_md:'Approved',response:{answers:{'Approve?':'Approved'}}});
    expect(f.store.getMessage(questionId)?.resolved_at).not.toBeNull();expect(f.store.getIssue(f.issue.id)?.status).toBe('in_progress');});
  it('attempt mutations never derive Issue status',()=>{const f=setup();f.db.run("UPDATE multiremi_issues SET status='in_progress' WHERE id=?",[f.issue.id]);
    const before=f.store.getIssue(f.issue.id)!;for(const status of ['failed','lost','offered'])f.db.run('UPDATE multiremi_turn_attempts SET status=? WHERE turn_id=?',[status,f.sent.turn_id!]);expect(f.store.getIssue(f.issue.id)?.status).toBe(before.status);expect(f.store.getIssue(f.issue.id)?.updatedAt).toBe(before.updatedAt);});
  it('each child status transition sends its parent execution owner one status message',()=>{const f=setup();const owner=f.store.createAgent({name:'Parent execution owner',provider:'codex'}),parent=f.store.createIssue({title:'Parent',assigneeType:'agent',assigneeId:owner.id,responsibleMemberId:'mem_local_local'});f.store.updateIssue(f.issue.id,{parentIssueId:parent.id});
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[f.sent.turn_id!]);f.derive();const inbox=f.store.listReaderMessageInbox('agent',owner.id,'local').items;
    expect(inbox.filter(m=>m.message_kind==='status'&&m.to_ref==='parent_owner'&&m.metadata.child_issue_id===f.issue.id)).toHaveLength(1);f.derive();expect(f.store.listReaderMessageInbox('agent',owner.id,'local').items).toHaveLength(inbox.length);});
  it('folds maximum lane/read-state sequence and offset exactly once, survives removal',()=>{const f=setup();
    f.db.run('DELETE FROM multiremi_schema_migrations WHERE id=?',[FOLD_AGENT_READ_STATE_MIGRATION]);
    f.db.exec('ALTER TABLE multiremi_session_lanes DROP COLUMN cursor_offset');f.db.exec('ALTER TABLE multiremi_turns DROP COLUMN trigger_message_id');
    f.db.run('UPDATE multiremi_conversation_heads SET agent_read_state=? WHERE session_id=?',[JSON.stringify({[f.agent.id]:{seq:4,offset:19}}),f.session.id]);
    f.db.run("UPDATE multiremi_session_lanes SET cursor_seq=3 WHERE session_id=? AND reader_id=?",[f.session.id,f.agent.id]);foldAgentReadState(f.db);
    expect(f.store.getSessionAgentReadProgress(f.session.id,f.agent.id)).toEqual({seq:4,offset:19});
    f.db.exec('ALTER TABLE multiremi_conversation_heads DROP COLUMN agent_read_state');foldAgentReadState(f.db);
    expect(f.store.getSessionAgentReadProgress(f.session.id,f.agent.id)).toEqual({seq:4,offset:19});});
});
