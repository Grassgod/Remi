import { createResponsibleTestIssue } from './helpers.js';
import {it,expect} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
pendingTurnBackendTests('MUL-506 message operations and dispatch',fixture=>{
  function setup(){const {store,db}=fixture();const a=store.createAgent({name:'A',provider:'codex'}),b=store.createAgent({name:'B',provider:'codex'});
    const issue=createResponsibleTestIssue(store, {title:'Conversation',assigneeType:'agent',assigneeId:a.id}),session=store.getOrCreateDefaultIssueSession(issue.id);
    const send=(body:string,to=b.id)=>store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:to},message_kind:'request',wake_requested:'now',body_md:body});
    return {store,db,a,b,issue,session,send};}
  it('stores pair-limit downgrades and resumes the chain after a new member message',()=>{const f=setup();let source=f.send('start',f.a.id).turn_id!,sender=f.a.id,target=f.b.id;
    for(let i=0;i<10;i++){f.db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[source]);
      const result=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:sender},source_turn_id:source,to:{type:'agent',ref:target},body_md:`dispatch ${i}`,message_kind:'request',wake_requested:'now'});
      expect(result.wake_reason).toBe('agent_dispatch');expect(result.turn_id).toBeTruthy();source=result.turn_id!;[sender,target]=[target,sender];}
    f.db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[source]);
    const limited=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:sender},source_turn_id:source,to:{type:'agent',ref:target},body_md:'limit',message_kind:'request',wake_requested:'now'});
    expect(limited.wake_applied).toBe('next_turn');expect(limited.wake_reason).toBe('pair_round_trip_limit');expect(limited.turn_id).toBeUndefined();expect(f.store.getMessage(limited.message.id)?.body_md).toBe('limit');
    f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'intervene'});
    const resumed=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:sender},source_turn_id:source,to:{type:'agent',ref:target},body_md:'resume',message_kind:'request',wake_requested:'now'});
    expect(resumed.wake_reason).toBe('agent_dispatch');});
  it('plain agent dispatch without an Issue source is stored without a new turn',()=>{const f=setup();const result=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:f.a.id},to:{type:'agent',ref:f.b.id},body_md:'no source',message_kind:'request',wake_requested:'now'});
    expect(result.wake_reason).toBe('no_issue_target');expect(result.turn_id).toBeUndefined();expect(f.store.getMessage(result.message.id)).toBeTruthy();});
  it('member inbox count ignores pagination and reads only its own lane',()=>{const f=setup();const source=f.send('work',f.a.id);
    for(const kind of ['decision','status'] as const)f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:f.a.id},source_turn_id:source.turn_id,to:{type:'member',ref:'mem_local_local'},body_md:kind,message_kind:kind,wake_requested:'now'});
    const inbox=f.store.listMessageInbox('mem_local_local','local',{limit:1});expect(inbox.items).toHaveLength(1);expect(inbox.unread_count).toBe(2);expect(inbox.attention_count).toBe(1);
    expect(f.store.readAllMessageInbox('mem_local_local','local')).toBe(1);expect(f.store.listMessageInbox('mem_local_local','local').unread_count).toBe(0);expect(f.store.getSessionAgentReadProgress(f.session.id,f.a.id).seq).toBe(0);
    expect(()=>f.store.readMessageInbox('mem_local_local',f.session.id,999)).toThrow();});
  it('edits and tombstones messages, and reactions are idempotent',()=>{const f=setup();const sent=f.send('draft');
    expect(f.store.editMessage(sent.message.id,{body_md:'edited'}).body_md).toBe('edited');expect(f.store.reactMessage(sent.message.id,{emoji:'👍',actorId:'mem_local_local'})).toHaveLength(1);
    expect(f.store.reactMessage(sent.message.id,{emoji:'👍',actorId:'mem_local_local'})).toHaveLength(1);expect(f.store.reactMessage(sent.message.id,{emoji:'👍',actorId:'mem_local_local',remove:true})).toHaveLength(0);
    expect(f.store.deleteMessage(sent.message.id).deleted_at).toBeTruthy();expect(f.store.listMessages(f.session.id)).toHaveLength(0);});
  it('Chat pending inputs merge into one turn and remain ordered in the log',()=>{const f=setup();const chat=f.store.createChatSession({agentId:f.a.id,workspaceId:'local',creatorId:'local'});
    const first=f.store.sendChatMessage(chat.id,{body:'first'}),second=f.store.sendChatMessage(chat.id,{body:'second'});
    expect(second.task.id).toBe(first.task.id);expect(f.store.listTurns({workspace_id:'local',session_id:chat.id})).toHaveLength(1);expect(f.store.listMessages(chat.id).map(m=>m.body_md)).toEqual(['first','second']);});
  it('questions and permission answers work after physically dropping the three old tables',()=>{const f=setup();for(const table of ['multiremi_task_human_requests','multiremi_issue_decisions','multiremi_task_steer_messages'])f.db.exec(`DROP TABLE ${table}`);
    const sent=f.send('work',f.a.id),turn=f.store.getTurn(sent.turn_id!)!;
    const request=f.store.createTaskHumanRequest({taskId:turn.current_attempt_id!,kind:'permission',payload:{permission:'run'}});
    expect(f.store.getMessage(request.id)?.message_kind).toBe('decision');expect(f.store.respondTaskHumanRequest(request.id,{response:{allow:true},respondedBy:'local'})?.status).toBe('responded');});
  it('Autopilot inputs use one canonical message and independent run lanes',()=>{const f=setup();
    const auto=f.store.createAutopilot({title:'Runs',assigneeId:f.a.id,executionMode:'run_only'});
    const one=f.store.runAutopilot(auto.id,{prompt:'one'}),two=f.store.runAutopilot(auto.id,{prompt:'two'});
    const turns=f.store.listTurns({workspace_id:'local',session_id:`auto_${auto.id}`});
    expect(turns).toHaveLength(2);expect(new Set(turns.map(t=>t.execution_scope)).size).toBe(2);
    expect(f.store.listMessages(`auto_${auto.id}`).filter(m=>m.message_kind==='request').map(m=>m.body_md)).toEqual(['one','two']);
    for(const run of [one,two]){const task=f.store.getTask(run.taskId!)!;
      expect(turns.find(t=>t.current_attempt_id===task.id)?.trigger_message_id).toBeTruthy();}
    const issueAuto=f.store.createAutopilot({title:'Issue run',assigneeId:f.b.id,executionMode:'create_issue'}),run=f.store.runAutopilot(issueAuto.id,{prompt:'Issue request'});
    expect(f.store.listMessages(f.store.getOrCreateDefaultIssueSession(run.issueId!).id)).toHaveLength(1);
    expect(f.store.listMessages(`auto_${issueAuto.id}`)[0]?.message_kind).toBe('request');
    expect(f.store.listMessages(`auto_${issueAuto.id}`)[0]?.body_md).toBe('Issue request');
  });

});
