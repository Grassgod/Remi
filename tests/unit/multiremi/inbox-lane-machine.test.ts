import { expect,it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { StoreContext,createCommitEventQueue } from '@multiremi/store/context.js';
import { acknowledgeInput,reRingAfterTurnEnd } from '@multiremi/store/inbox/lane-machine.js';
pendingTurnBackendTests('MUL-506 canonical inbox',fixture=>{
  it('coalesces pending messages, deduplicates and preserves the resolved header',()=>{
    const {store,db}=fixture();const agent=store.createAgent({name:'Worker',provider:'codex'});
    const issue=store.createIssue({title:'Inbox',assigneeType:'member',assigneeId:'mem_local_local'});
    const session=store.getOrCreateDefaultIssueSession(issue.id);
    const input={session_id:session.id,sender:{type:'member' as const,id:'mem_local_local'},to:{type:'agent' as const,ref:agent.id},message_kind:'request' as const,wake_requested:'now' as const,body_md:'one',dedupe_key:'one'};
    const one=store.sendMessage(input),two=store.sendMessage({...input,body_md:'two',dedupe_key:'two'});
    expect(one.wake_reason).toBe('human_sender');expect(two.turn_id).toBe(one.turn_id);
    expect(store.sendMessage(input).message.id).toBe(one.message.id);
    expect(store.sendMessage({...input,body_md:'two',dedupe_key:'two'}).turn_id).toBe(two.turn_id);
    expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_turns WHERE session_id=?').get(session.id).n)).toBe(1);
    expect(db.query('SELECT trigger_message_id FROM multiremi_turns WHERE id=?').get(one.turn_id!).trigger_message_id).toBe(one.message.id);
  });
  it('delivers running input without creating another turn and re-rings exactly once at the end',()=>{
    const {store,db}=fixture();const agent=store.createAgent({name:'Worker',provider:'codex'});
    const issue=store.createIssue({title:'Running',assigneeType:'member',assigneeId:'mem_local_local'}),session=store.getOrCreateDefaultIssueSession(issue.id);
    const input={session_id:session.id,sender:{type:'member' as const,id:'mem_local_local'},to:{type:'agent' as const,ref:agent.id},message_kind:'request' as const,wake_requested:'now' as const,body_md:'start'};
    const first=store.sendMessage(input),ctx=new StoreContext(db,()=>store);
    db.transaction(()=>{ctx.lockWorkspaceRuntimeLifecycle('local');db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[first.turn_id!]);acknowledgeInput(ctx,first.turn_id!,0,first.message.seq);})();
    const next=store.sendMessage({...input,body_md:'interrupt'});expect(next.turn_id).toBe(first.turn_id);
    db.transaction(()=>{ctx.lockWorkspaceRuntimeLifecycle('local');db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[first.turn_id!]);const events=createCommitEventQueue();
      const ring=reRingAfterTurnEnd(ctx,first.turn_id!,events);expect(ring).toBeTruthy();expect(reRingAfterTurnEnd(ctx,first.turn_id!,events)).toBe(ring);
    })();
    expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_turns WHERE status='pending'").get().n)).toBe(1);
  });
  it('keeps downgraded messages and rejects a gap in input acknowledgement',()=>{
    const {store,db}=fixture();const agent=store.createAgent({name:'Worker',provider:'codex'});
    const issue=store.createIssue({title:'Gap'}),session=store.getOrCreateDefaultIssueSession(issue.id);
    const sent=store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:agent.id},body_md:'start',message_kind:'request',wake_requested:'now'});
    expect(()=>db.transaction(()=>acknowledgeInput(new StoreContext(db,()=>store),sent.turn_id!,sent.message.seq,sent.message.seq))()).toThrow('contiguous');
    const quiet=store.sendMessage({session_id:session.id,sender:{type:'agent',id:agent.id},to:{type:'agent',ref:agent.id},body_md:'self',message_kind:'request',wake_requested:'now'});
    expect(quiet.wake_reason).toBe('self');expect(quiet.turn_id).toBeUndefined();expect(store.getMessage(quiet.message.id)?.body_md).toBe('self');
  });
});
