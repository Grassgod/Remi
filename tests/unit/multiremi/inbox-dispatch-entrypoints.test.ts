import {it,expect} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
import {createMultiremiApp} from '@multiremi/api.js';

pendingTurnBackendTests('MUL-508 unified dispatch replacements',fixture=>{
  for(const entry of ['task','session','rerun','mention'] as const){
    for(const terminal of ['completed','failed','cancelled'] as const){
    it(`${entry} derives delegation from the request and returns ${terminal} exactly once`,async()=>{
      const {store}=fixture();
      const runtimes=['Sender','Recipient'].map(name=>store.registerRuntime({name,provider:'codex',workspaceId:'local'}));
      const [a,b]=runtimes.map(runtime=>store.createAgent({name:runtime.name,provider:'codex',runtimeId:runtime.id}));
      const sourceIssue=store.createIssue({title:'Source'}),target=store.createIssue({title:'Target',assigneeType:'agent',assigneeId:b!.id});
      const s0=store.createIssueSession(sourceIssue.id,{title:'Return here'}),s1=store.createIssueSession(target.id,{title:'Work here'});
      const source=store.createTask({agentId:a!.id,issueId:sourceIssue.id,issueSessionId:s0.id,prompt:'Coordinate'});
      expect(store.claimTask(runtimes[0]!.id)?.id).toBe(source.id);store.startTask(source.id);
      const app=createMultiremiApp({store,authToken:'fixture-root'}),credential=(await store.createTaskAccessToken(source,'local')).token;
      const session=entry==='rerun'?store.getOrCreateDefaultIssueSession(target.id):s1;
      const response=await app.request(`/api/sessions/${session.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify({
        to:entry==='rerun'?{type:'role',ref:'issue_owner'}:{type:'agent',ref:b!.id},
        message_kind:'request',wake_requested:'now',body_md:entry==='mention'?`Verify [@Recipient](mention://agent/${b!.id})`:'Verify',
      })});
      expect(response.status).toBe(200);
      const child=store.listTasksForIssue(target.id).find(t=>t.agentId===b!.id)!;
      const turn=store.listTurns({workspace_id:'local',issue_id:target.id}).find(t=>t.current_attempt_id===child.id)!;
      expect(turn.delegated_by_agent_id).toBe(a!.id);expect(turn.delegated_from_issue_session_id).toBe(s0.id);
      expect(store.getMessage(turn.trigger_message_id!)?.task_id).toBe(source.id);
      expect(store.getMessage(turn.trigger_message_id!)?.wake_reason).toBe('agent_dispatch');
      store.completeTask(source.id,{output:'Dispatched'});expect(store.claimTask(runtimes[1]!.id)?.id).toBe(child.id);store.startTask(child.id);
      if(entry==='mention'){
        const progress=store.createIssueComment(target.id,{issueSessionId:child.issueSessionId,authorType:'agent',authorId:b!.id,taskId:child.id,body:`Progress [@Sender](mention://agent/${a!.id})`});
        const delivered=store.listMessages(s0.id).find(m=>m.metadata.source_comment_id===progress.id)!;
        expect(delivered.message_kind).toBe('reply');expect(delivered.wake_reason).toBe('member_to_delegator');
        expect(store.listTurns({workspace_id:'local',session_id:s0.id}).filter(t=>t.status==='pending')).toHaveLength(1);
      }
      const deliverable='完整结论'.repeat(6000);
      if(entry==='mention')store.createIssueComment(target.id,{issueSessionId:child.issueSessionId,authorType:'agent',authorId:b!.id,taskId:child.id,body:deliverable});
      const finish=()=>terminal==='completed'?store.completeTask(child.id,{output:deliverable})
        :terminal==='failed'?store.failTask(child.id,{error:'Verification failed'}):store.cancelTask(child.id);
      finish();
      const completed=store.getTurn(turn.id)!;expect(completed.status).toBe(terminal);
      if(terminal==='completed'){expect(store.getMessage(completed.reply_message_id!)?.body_md).toBe(deliverable);expect(store.getMessage(completed.reply_message_id!)?.visibility).toBe('shown');}
      const returned=store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;

      expect(returned.issueSessionId).toBe(s0.id);expect(returned.agentId).toBe(a!.id);
      const bells=store.listMessages(s0.id).filter(m=>m.message_kind==='report'&&(m.metadata.message_source as any)?.taskId===child.id);
      expect(bells).toHaveLength(1);expect(Buffer.byteLength(bells[0]!.body_md)).toBeLessThan(2048);
      expect(bells[0]!.body_md).toContain(`Status: ${terminal}`);
      if(terminal==='completed')expect(bells[0]!.body_md).toContain(completed.reply_message_id!);
      if(terminal==='failed')expect(bells[0]!.body_md).toContain('Verification failed');
      expect(finish).toThrow('Task not found or terminal');
      store.ensureDelegationWakeup({sourceTaskId:child.id,requiredEventSeq:1,terminalStatus:terminal,terminalBody:'Replay'});
      expect(store.listMessages(s0.id).filter(m=>m.message_kind==='report'&&(m.metadata.message_source as any)?.taskId===child.id)).toHaveLength(1);
      expect(store.claimTask(runtimes[0]!.id)?.id).toBe(returned.id);store.startTask(returned.id);store.completeTask(returned.id,{output:'Reviewed'});
      expect(store.listTurns({workspace_id:'local',session_id:s0.id}).filter(t=>t.status==='pending')).toHaveLength(0);
    }, 120_000);
    }
  }
  it('a real dispatch/return chain reaches 2L and all four entrypoints preserve downgraded messages',async()=>{
    const {store}=fixture();const runtimes=['A','B'].map(name=>store.registerRuntime({name,provider:'codex',workspaceId:'local'}));
    const [a,b]=runtimes.map(r=>store.createAgent({name:r.name,provider:'codex',runtimeId:r.id}));
    const issue=store.createIssue({title:'Pair'}),session=store.getOrCreateDefaultIssueSession(issue.id);
    let source=store.createTask({agentId:a!.id,issueId:issue.id,issueSessionId:session.id,prompt:'start'});
    expect(store.claimTask(runtimes[0]!.id)?.id).toBe(source.id);store.startTask(source.id);
    for(let round=0;round<5;round++){
      expect(store.countDelegationPairHops(source,b!.id)).toBe(2*round);
      const dispatch=store.sendMessage({session_id:session.id,sender:{type:'agent',id:a!.id},source_turn_id:source.id,to:{type:'agent',ref:b!.id},message_kind:'request',wake_requested:'now',body_md:`dispatch ${round}`});
      store.completeTask(source.id,{output:'Dispatched'});const child=store.getTurn(dispatch.turn_id!)!;
      expect(store.claimTask(runtimes[1]!.id)?.id).toBe(child.current_attempt_id!);store.startTask(child.current_attempt_id!);store.completeTask(child.current_attempt_id!,{output:'Result'});
      source=store.getTask(store.getTask(child.current_attempt_id!)!.delegationReturnTaskId!)!;
      expect(store.claimTask(runtimes[0]!.id)?.id).toBe(source.id);store.startTask(source.id);
    }
    expect(store.countDelegationPairHops(source,b!.id)).toBe(10);
    const before=store.listTurns({workspace_id:'local'}).length,app=createMultiremiApp({store,authToken:'fixture-root'}),credential=(await store.createTaskAccessToken(source,'local')).token;
    for(const entry of ['task','session','rerun','mention'] as const){
      const marker=`limited ${entry}`;
      const response=await app.request(`/api/sessions/${session.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify({
        to:{type:'agent',ref:b!.id},message_kind:'request',wake_requested:'now',
        body_md:entry==='mention'?`${marker} [@B](mention://agent/${b!.id})`:marker,
      })});
      expect(response.status).toBe(200);
      const result=await response.json() as any;
      expect(result).toMatchObject({wake_applied:'next_turn',wake_reason:'pair_round_trip_limit'});
      expect(result).not.toHaveProperty('turn_id');
      const message=store.listMessages(session.id,{limit:1000}).find(m=>m.body_md.startsWith(marker))!;
      expect(message.wake_reason).toBe('pair_round_trip_limit');expect(message.wake_applied).toBe('next_turn');
      expect(store.listTurns({workspace_id:'local'})).toHaveLength(before);
    }
  }, 120_000);

});
