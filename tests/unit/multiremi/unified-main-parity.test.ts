import { expect, it, spyOn } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { IssuesRepo } from '@multiremi/store/repos/issues-repo.js';
import { TasksRepo } from '@multiremi/store/repos/tasks-repo.js';
import { CHAT_ATTACHMENT_MAX_BYTES } from '@multiremi/contracts/attachments.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('MUL-508 main parity', fixture => {
  async function scaffold() {
    const {store,db}=fixture();
    const worker=store.createAgent({name:'Worker',provider:'codex',visibility:'workspace'});
    const controller=store.createAgent({name:'Controller',provider:'codex',visibility:'workspace'});
    const parent=store.createIssue({title:'Parent',assigneeType:'agent',assigneeId:controller.id});
    const child=store.createIssue({title:'Child',parentIssueId:parent.id,assigneeType:'agent',assigneeId:worker.id});
    const patrol=store.createTask({agentId:controller.id,issueId:parent.id,prompt:'Patrol'});
    const task=store.createTask({agentId:worker.id,issueId:child.id,prompt:'Work'});
    const turn=store.getTurnForAttempt(task.id)!;
    const token=await store.createTaskAccessToken(patrol,'local');
    const app=createMultiremiApp({store,authToken:'parity-master'});
    const request=async (path:string,body?:unknown,credential=token.token)=>{
      const response=await app.request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,data:await response.json() as any};
    };
    const status=(value:string)=>{db.run('UPDATE multiremi_turns SET status=? WHERE id=?',[value,turn.id]);db.run('UPDATE multiremi_turn_attempts SET status=? WHERE id=?',[value==='pending'?'offered':value,task.id]);};
    return {store,db,worker,controller,parent,child,patrol,task,turn,token,app,request,status};
  }

  for(const relation of ['parent','leader'] as const) for(const state of ['pending','running','failed'] as const)
    it(`#5: ${relation} retries ${state} work with a stable turn and committed disclosure`,async()=>{
      const f=await scaffold();f.status(state);
      if(relation==='leader'){
        f.store.updateIssue(f.child.id,{parentIssueId:null});
        f.store.createSquad({name:'Team',leaderId:f.controller.id,memberIds:[f.worker.id]});
      }
      expect((await f.request(`/api/turns/${f.turn.id}/retry`,{})).data.code).toBe('organizer_report_only');
      f.store.updateWorkspace('local',{settings:{organizer:{mode:'act'}}});
      const result=await f.request(`/api/turns/${f.turn.id}/retry`,{reason:'Resume assigned work',cold:true});
      expect(result.status,JSON.stringify(result.data)).toBe(200);expect(result.data.turn.id).toBe(f.turn.id);
      expect(result.data.turn.current_attempt_id).not.toBe(f.task.id);
      expect(f.store.listTurnAttempts(f.turn.id)).toHaveLength(2);
      expect(result.data.organizer_action).toMatchObject({supervisorAgentId:f.controller.id,targetTaskId:f.task.id,action:'redispatch',reportIssueId:f.parent.id});
      expect(f.store.getIssueComment(result.data.comment_id)?.body).toContain(result.data.organizer_action.id);
      expect(f.store.listOrganizerActionsForTask(f.task.id)).toHaveLength(1);
    });

  for(const cold of [false,true])it(`#5: retry cold=${cold} preserves or clears the provider cache`,async()=>{
    const f=await scaffold();f.status('failed');
    f.store.updateWorkspace('local',{settings:{organizer:{mode:'act'}}});
    f.db.run("UPDATE multiremi_turn_attempts SET session_id='provider-warm' WHERE id=?",[f.task.id]);
    const result=await f.request(`/api/turns/${f.turn.id}/retry`,{cold});
    expect(result.status,JSON.stringify(result.data)).toBe(200);
    expect(f.store.getTask(result.data.turn.current_attempt_id)?.sessionId).toBe(cold?null:'provider-warm');
    expect(result.data.turn.id).toBe(f.turn.id);
  });

  it('#5: related wrap-up/cancel work; unrelated agents cannot control the turn',async()=>{
    const f=await scaffold();f.status('running');
    const outsider=f.store.createAgent({name:'Outsider',provider:'codex',visibility:'workspace'});
    const other=f.store.createTask({agentId:outsider.id,issueId:f.parent.id,prompt:'Other'});
    const credential=await f.store.createTaskAccessToken(other,'local');
    for(const action of ['cancel','wrap-up','retry'])expect((await f.request(`/api/turns/${f.turn.id}/${action}`,{},credential.token)).status).toBe(403);
    expect((await f.request(`/api/turns/${f.turn.id}/wrap-up`,{})).data.turn.wrap_up_requested_at).toBeString();
    expect((await f.request(`/api/turns/${f.turn.id}/cancel`,{})).data.turn.status).toBe('cancelled');
  });

  it('#3/#9: one dispatch message keeps dynamic status and a completed worker immediately wakes its delegator',async()=>{
    const f=await scaffold();f.store.cancelTask(f.task.id);
    const parentTurn=f.store.getTurnForAttempt(f.patrol.id)!;
    const dispatched=await f.request(`/api/sessions/${f.turn.session_id}/messages`,{
      body_md:'Delegated request',message_kind:'request',to:{type:'agent',ref:f.worker.id}});
    expect(dispatched.status,JSON.stringify(dispatched.data)).toBe(200);
    const child=f.store.getTurn(dispatched.data.turn_id)!;
    expect(dispatched.data.message.task_id).toBe(parentTurn.id);
    expect(f.store.listMessages(child.session_id).filter(m=>m.body_md==='Delegated request')).toHaveLength(1);
    expect(f.store.getTask(child.current_attempt_id!)?.delegatedByAgentId).toBe(f.controller.id);
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[child.id]);
    f.db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?",[child.current_attempt_id]);
    const blocked=f.store.createIssue({title:"Delegator blocker",status:"todo"});
    f.store.createIssueDependency(f.parent.id,{dependsOnIssueId:blocked.id,type:"blocked_by"});
    f.store.updateIssue(f.parent.id,{status:"backlog"});
    expect(f.store.listUnmetPrerequisites(f.parent.id)).toHaveLength(1);
    f.store.completeTask(child.current_attempt_id!,{output:'Worker delivered'});
    expect(f.store.getTurn(child.id)?.status).toBe('completed');
    const report=f.store.listMessages(parentTurn.session_id).find(m=>
      (m.metadata.message_source as any)?.taskId===child.current_attempt_id && m.message_kind==='report');
    expect(report).toBeDefined();expect(report!.wake_applied).toBe('now');
    expect(report!.to_agent_id).toBe(f.controller.id);
    expect(f.store.getTurn(parentTurn.id)?.status).toBe('pending');
    expect(f.store.getMessage(dispatched.data.message.id)?.task_id).toBe(parentTurn.id);
    expect(f.store.listMessages(child.session_id).filter(m=>m.id===dispatched.data.message.id)).toHaveLength(1);
  });

  it('#5: an audit failure rolls back replacement, comments and events',async()=>{
    const f=await scaffold();f.store.updateWorkspace('local',{settings:{organizer:{mode:'act'}}});
    const before=f.store.getConversationLogHead(f.patrol.issueSessionId!)!.headSeq;
    const events:string[]=[];const off=f.store.onWorkspaceEvent(event=>events.push(event.type));
    const fault=spyOn(TasksRepo.prototype,'recordOrganizerAction').mockImplementation(()=>{throw new Error('audit fault');});
    try{
      const response=await f.request(`/api/turns/${f.turn.id}/retry`,{});
      expect(response.status).toBe(500);expect(f.store.listTurnAttempts(f.turn.id)).toHaveLength(1);
      expect(f.store.getTurn(f.turn.id)?.status).toBe('pending');
      expect(f.store.getConversationLogHead(f.patrol.issueSessionId!)!.headSeq).toBe(before);
      expect(events).toEqual([]);
    }finally{fault.mockRestore();off();}
  });

  it('#6: orphan history is readable and deleted Chat remains forbidden',async()=>{
    const f=await scaffold();
    const orphan=f.store.createTask({agentId:f.worker.id,prompt:'Historical orphan'});
    const id=f.store.getTurnForAttempt(orphan.id)!.id;
    expect((await f.request(`/api/turns/${id}`,undefined,'parity-master')).status).toBe(200);
    expect((await f.request('/api/turns?limit=500',undefined,'parity-master')).data.turns.map((row:any)=>row.id)).toContain(id);
    const chat=f.store.createChatSession({agentId:f.worker.id,creatorId:'local'});
    const chatTask=f.store.createTask({agentId:f.worker.id,chatSessionId:chat.id,prompt:'Private Chat'});
    const retained=f.store.getTurnForAttempt(chatTask.id)!;
    f.db.run('DELETE FROM multiremi_chat_sessions WHERE id=?',[chat.id]);
    expect((await f.request(`/api/turns/${retained.id}`,undefined,'parity-master')).status).toBe(403);
    expect((await f.request('/api/turns?limit=500',undefined,'parity-master')).data.turns.map((row:any)=>row.id)).not.toContain(retained.id);
  });

  it('#6/#9: master compatibility without a member publishes a complete message before any patch',async()=>{
    const {store,db}=fixture();
    const workspace=store.createWorkspace({name:'Trusted empty workspace',slug:'empty-'+Date.now()+'-'+Math.floor(Math.random()*1e9)});
    db.run('DELETE FROM multiremi_workspace_members WHERE workspace_id=?',[workspace.id]);
    const issue=store.createIssue({title:'Empty workspace',workspaceId:workspace.id});
    const session=store.getOrCreateDefaultIssueSession(issue.id);
    const app=createMultiremiApp({store,authToken:'root'});
    const events:Array<{kind:string;seq:number}>=[];
    const stop=store.subscribeConversationLog({onEntry:(_session,row)=>{
      if(_session===session.id)events.push({kind:'seq' in row?'entry':'patch',seq:'seq' in row?row.seq:row.target_seq});
    }});
    const response=await app.request(`/api/sessions/${session.id}/messages`,{method:'POST',headers:{Authorization:'Bearer root','Content-Type':'application/json'},
      body:JSON.stringify({body_md:'Trusted internal write',to:{type:'none'}})});
    stop();expect(response.status).toBe(200);
    const result=await response.json();expect(result.message).toMatchObject({sender_type:'platform',body_md:'Trusted internal write',metadata:{execution_scope:''},revision:1});
    expect(events).toEqual([{kind:'entry',seq:result.message.seq}]);
  });

  it('#6: trusted explicit author survives; human HTTP credentials override spoofed authors',async()=>{
    const f=await scaffold();const session=f.store.getOrCreateDefaultIssueSession(f.child.id);
    const path=`/api/sessions/${session.id}/messages`;
    const input={body_md:'Author audit',message_kind:'report',authorType:'agent',authorId:f.controller.id,to:{type:'none'}};
    expect((await f.request(path,input,'parity-master')).data.message).toMatchObject({sender_type:'agent',sender_id:f.controller.id});
    const user=f.store.getOrCreateUser({externalId:'parity-member',name:'Member'});
    const member=f.store.createWorkspaceMember({userId:user.id,name:user.name,role:'member'});
    const pat=await f.store.createAccessToken({type:'pat',name:'Member',workspaceId:'local',userId:user.id,purpose:'session'});
    expect((await f.request(path,input,pat.token)).data.message).toMatchObject({sender_type:'member',sender_id:member.id});
  });

  it('#6: private agent metadata stays readable while its input and trace stay protected',async()=>{
    const f=await scaffold();f.store.updateAgent(f.worker.id,{visibility:'private',ownerId:'another-user'});
    const user=f.store.getOrCreateUser({externalId:'reader',name:'Reader'});
    f.store.createWorkspaceMember({userId:user.id,name:user.name,role:'member'});
    const pat=await f.store.createAccessToken({type:'pat',name:'Reader',workspaceId:'local',userId:user.id,purpose:'session'});
    expect((await f.request(`/api/turns/${f.turn.id}`,undefined,pat.token)).status).toBe(200);
    expect((await f.request(`/api/turns/${f.turn.id}?input=true`,undefined,pat.token)).status).toBe(403);
    expect((await f.request(`/api/turns/${f.turn.id}/trace`,undefined,pat.token)).status).toBe(404);
    expect((await f.request('/api/turns?limit=500',undefined,pat.token)).data.turns.map((row:any)=>row.id)).toContain(f.turn.id);
  });

  it('#10: runtime/all serve turn traces while the UI role retains 421',async()=>{
    const f=await scaffold();
    for(const apiRole of ['runtime','all','ui'] as const){
      const app=createMultiremiApp({store:f.store,authToken:'parity-master',apiRole});
      const response=await app.request(`/api/turns/${f.turn.id}/trace`,{headers:{Authorization:'Bearer parity-master'}});
      expect(response.status).toBe(apiRole==='ui'?421:200);
      if(apiRole!=='ui')expect(await response.json()).toMatchObject({turn_id:f.turn.id,attempt_id:f.task.id,events:[]});
    }
  });

  it('#2: forced owner comments merge once and failed audit rolls back the whole message',async()=>{
    const f=await scaffold();f.store.cancelTask(f.task.id);
    const blocker=f.store.createIssue({title:'Blocker',status:'in_progress'});
    const waiting=f.store.createIssue({title:'Waiting',status:'backlog',blockedBy:[blocker.id],assigneeType:'agent',assigneeId:f.worker.id});
    const session=f.store.getOrCreateDefaultIssueSession(waiting.id);
    const path=`/api/sessions/${session.id}/messages`;
    const input={body_md:'Start explicitly',to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now'};
    const fault=spyOn(IssuesRepo.prototype,'recordDependencyForceStarted').mockImplementation(()=>{throw new Error('force fault');});
    const before=f.store.listMessages(session.id).length;
    try{expect((await f.request(path,input,'parity-master')).status).toBe(400);expect(f.store.listMessages(session.id)).toHaveLength(before);}finally{fault.mockRestore();}
    const first=await f.request(path,input,'parity-master');expect(first.status).toBe(200);
    const next=await f.request(path,input,'parity-master');expect(next.data.turn_id).toBe(first.data.turn_id);
    expect(f.store.listIssueActivity(waiting.id).filter(event=>event.type==='dependency_force_started')).toHaveLength(1);
    expect(f.store.getIssue(waiting.id)?.status).toBe('todo');
  });

  it('#6/#8: archived Chat rejects writes before attachment or delivery side effects',async()=>{
    const f=await scaffold();const chat=f.store.createChatSession({agentId:f.worker.id,creatorId:'local'});
    f.store.updateChatSession(chat.id,{status:'archived'});
    const before=f.store.getConversationLogHead(chat.id)!.headSeq;
    const result=await f.request(`/api/sessions/${chat.id}/messages`,{body_md:'Rejected',to:{type:'agent',ref:f.worker.id}},'parity-master');
    expect(result.status).toBe(409);expect(f.store.getConversationLogHead(chat.id)?.headSeq).toBe(before);
    expect(f.store.listMessages(chat.id)).toEqual([]);expect(f.store.listTasks().filter(task=>task.chatSessionId===chat.id)).toEqual([]);
  });

  it('#8: attachment size boundaries preserve 413 and reject empty files atomically',async()=>{
    const f=await scaffold();const chat=f.store.createChatSession({agentId:f.worker.id,creatorId:'local'});
    const path=`/api/sessions/${chat.id}/messages`,previous=process.env.MULTIREMI_UPLOAD_DIR;
    const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
    const root=mkdtempSync(join(tmpdir(),'mul508-parity-'));process.env.MULTIREMI_UPLOAD_DIR=root;
    try{
      for(const size of [CHAT_ATTACHMENT_MAX_BYTES-1,CHAT_ATTACHMENT_MAX_BYTES,CHAT_ATTACHMENT_MAX_BYTES+1,0]){
        const form=new FormData();form.set('message',JSON.stringify({body_md:'',message_kind:'report'}));form.append('file',new File([new Uint8Array(size)],'报告.txt'));
        const before=Number(f.db.query('SELECT COUNT(*) AS n FROM multiremi_attachments').get().n);
        const response=await f.app.request(path,{method:'POST',headers:{Authorization:'Bearer parity-master'},body:form});
        expect(response.status).toBe(size===0?400:size>CHAT_ATTACHMENT_MAX_BYTES?413:200);
        if(response.status===200){const result=await response.json() as any;expect(result.message.attachments[0]).toMatchObject({filename:'报告.txt',sizeBytes:size,chatSessionId:chat.id,chatMessageId:result.message.id});}
        else expect(Number(f.db.query('SELECT COUNT(*) AS n FROM multiremi_attachments').get().n)).toBe(before);
      }
    }finally{if(previous===undefined)delete process.env.MULTIREMI_UPLOAD_DIR;else process.env.MULTIREMI_UPLOAD_DIR=previous;rmSync(root,{recursive:true,force:true});}
  });

  it('#6/#7: Chat read cursors clear unread only after all visible replies and preserve failure sidecars', async () => {
    const {store}=fixture();
    const worker=store.createAgent({name:'Chat worker',provider:'codex',visibility:'workspace'});
    const runtime=store.registerRuntime({name:'Chat runtime',provider:'codex'});
    const chat=store.createChatSession({agentId:worker.id,creatorId:'local'});
    const task=store.createTask({agentId:worker.id,chatSessionId:chat.id,prompt:'Request',maxAttempts:1});
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);store.startTask(task.id);
    store.completeTask(task.id,{output:'First reply'});
    const rows=store.listMessages(chat.id),reply=rows.find(message=>message.sender_type==='agent')!;
    const app=createMultiremiApp({store,authToken:'chat-master'});
    const read=async(to_seq:number)=>app.request('/api/inbox/read',{method:'POST',headers:{Authorization:'Bearer chat-master','Content-Type':'application/json'},body:JSON.stringify({session_id:chat.id,to_seq})});
    expect(store.getChatSession(chat.id)?.hasUnread).toBe(true);
    expect((await read(rows[0]!.seq)).status).toBe(200);expect(store.getChatSession(chat.id)?.hasUnread).toBe(true);
    expect((await read(reply.seq)).status).toBe(200);expect(store.getChatSession(chat.id)?.hasUnread).toBe(false);
    expect((await (await read(0)).json()).cursor_seq).toBe(reply.seq);
    const next=store.createTask({agentId:worker.id,chatSessionId:chat.id,prompt:'Failure',maxAttempts:1});
    expect(store.claimTask(runtime.id)?.id).toBe(next.id);store.startTask(next.id);
    store.failTask(next.id,{error:'Failure detail',failureReason:'unknown'});
    const failed=store.listChatMessagesFromLog(chat.id).at(-1)!;
    expect(failed.failureReason).toBe('unknown');expect(failed.elapsedMs).toBeGreaterThanOrEqual(0);
    const other=store.getOrCreateUser({name:'Other reader',email:'other-chat@example.test'});
    store.createWorkspaceMember({name:'Other reader',userId:other.id});
    const token=await store.createAccessToken({name:'Other reader',type:'pat',workspaceId:'local',userId:other.id});
    const denied=await app.request('/api/inbox/read',{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body:JSON.stringify({session_id:chat.id})});
    expect(denied.status).toBe(403);
  });

  it('#6: restricted delegation inherits the source Turn even when a pending lane already exists',async()=>{
    const f=await scaffold();
    f.db.run('UPDATE multiremi_turns SET issue_creation_restricted=1 WHERE id=?',[f.store.getTurnForAttempt(f.patrol.id)!.id]);
    const sent=await f.request(`/api/sessions/${f.turn.session_id}/messages`,{body_md:'Restricted dispatch',message_kind:'request',to:{type:'agent',ref:f.worker.id}});
    expect(sent.status).toBe(200);
    const task=f.store.getTask(f.store.getTurn(sent.data.turn_id)!.current_attempt_id!)!;
    expect(task.issueCreationRestricted).toBe(true);
    const credential=await f.store.createTaskAccessToken(task,'local');
    expect((await f.request('/api/issues',{title:'Must not bypass source policy'},credential.token)).status).toBe(403);
  });

  it('#6/#8: an orphan interruption has an empty sidecar and unavailable parent owners retain skip audits',async()=>{
    const {store}=fixture();const agent=store.createAgent({name:'Legacy worker',provider:'codex'});
    const runtime=store.registerRuntime({name:'Orphan runtime',provider:'codex'});
    const task=store.createTask({agentId:agent.id,prompt:'Historical orphan'});
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);store.startTask(task.id);
    expect(store.createTaskSteerMessage({taskId:task.id,kind:'steer',content:'Follow up'}).attachments).toEqual([]);
    const parent=store.createIssue({title:'Unavailable parent',assigneeType:'agent',assigneeId:agent.id});
    const child=store.createIssue({title:'Child',parentIssueId:parent.id,status:'in_progress'});
    store.archiveAgent(agent.id);store.updateIssue(child.id,{status:'done'});
    expect(store.listIssueActivity(parent.id).find(row=>row.type==='child_done_parent_skipped')?.data).toMatchObject({reason:'agent_unavailable',outcome:'done'});
  });

});
