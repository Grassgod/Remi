import { expect, it, spyOn } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { acceptTestIssueDelivery } from './helpers.js';

pendingTurnBackendTests('explicit responsibility migration and authenticated sources', fixture => {
  it('provides explicit synthetic fixtures without changing production defaults or negative cases',()=>{
    const {store,createIssue}=fixture();
    const agent=store.createAgent({name:'Explicit execution',provider:'codex'});
    const issue=createIssue({title:'Explicit synthetic responsibility',assigneeType:'agent',assigneeId:agent.id});
    expect(store.resolveIssueResponsibility(issue.id).rootHuman?.id).toBe('test_root_human_local');
    expect(()=>store.createIssue({title:'Production unresolved'})).toThrow('explicit responsible_member_id');
    expect(()=>createIssue({title:'Negative explicit null',responsibleMemberId:null})).toThrow('explicit responsible_member_id');
    expect(createIssue({title:'Unassigned fixture'}).assigneeId).toBeNull();
    expect(acceptTestIssueDelivery(store,issue.id).status).toBe('done');
  });
  it('lists legacy facts and credible candidates without backfilling or rewriting historical evidence',()=>{
    const f=fixture();const {store,db}=f;
    const candidate=store.createWorkspaceMember({name:'Historical human'});
    const old=f.createIssue({title:'Legacy member assignment',createdBy:candidate.id});
    const unknown=f.createIssue({title:'Unknown legacy source'});
    store.createIssueComment(old.id,{body:'Preserved historical evidence'});
    db.run("UPDATE multiremi_issues SET responsible_member_id=NULL,assignee_type='member',assignee_id=? WHERE id=?",[candidate.id,old.id]);
    db.run('UPDATE multiremi_issues SET responsible_member_id=NULL,created_by=NULL WHERE id=?',[unknown.id]);
    const before=store.listIssueTimeline(old.id);
    const list=store.listIssueResponsibilityMigration('local',{limit:1});
    expect(list.total).toBe(2);expect(list.rootCount).toBe(2);expect(list.legacyMemberExecutionCount).toBe(1);expect(list.nextOffset).toBe(1);
    const entry=store.listIssueResponsibilityMigration('local').items.find(item=>item.issueId===old.id)!;
    expect(entry.assigneeType).toBe('member');expect(entry.createdById).toBe(candidate.id);
    expect(entry.candidates.map(item=>item.source).sort()).toEqual(['historical_creator','legacy_member_assignee']);
    expect(store.listIssueResponsibilityMigration('local').items.find(item=>item.issueId===unknown.id)?.candidates).toEqual([]);
    expect(store.getIssue(old.id)?.responsibleMemberId).toBeNull();expect(store.listIssueTimeline(old.id)).toEqual(before);
    f.reopen();expect(f.store.listIssueResponsibilityMigration('local').total).toBe(2);
    expect(f.store.getIssue(unknown.id)?.responsibleMemberId).toBeNull();expect(f.store.listIssueTimeline(old.id)).toEqual(before);
  });
  it('maps only explicit root/member/revision choices and rolls an invalid batch back completely',()=>{
    const f=fixture();const {store,db}=f;
    const first=f.createIssue({title:'First legacy'}),second=f.createIssue({title:'Second legacy'});
    const human=store.createWorkspaceMember({name:'Verified responsible human'});
    db.run('UPDATE multiremi_issues SET responsible_member_id=NULL WHERE id IN (?,?)',[first.id,second.id]);
    const mappings=store.listIssueResponsibilityMigration('local').items.map(item=>({issueId:item.issueId,memberId:human.id,revision:item.revision}));
    expect(()=>store.mapIssueResponsibility('local',{reason:'Verified explicit assignment',mappings:[mappings[0]!,{...mappings[1]!,revision:'stale'}]},{type:'member',id:'mem_local_local'})).toThrow('changed');
    expect(store.getIssue(first.id)?.responsibleMemberId).toBeNull();expect(store.getIssue(second.id)?.responsibleMemberId).toBeNull();
    expect(store.listIssueActivity(first.id).some(item=>(item.data as {migration?:boolean})?.migration)).toBeFalse();
    expect(store.mapIssueResponsibility('local',{reason:'Verified from source request',mappings},{type:'member',id:'mem_local_local'}).mappedIssueIds.sort()).toEqual([first.id,second.id].sort());
    expect(store.listIssueResponsibilityMigration('local').total).toBe(0);
    expect(store.listIssueActivity(first.id).find(item=>(item.data as {migration?:boolean})?.migration)?.body).toBe('Verified from source request');
    f.reopen();expect(f.store.getIssue(first.id)?.responsibleMemberId).toBe(human.id);
    expect(f.store.listIssueResponsibilityMigration('local').total).toBe(0);
  });
  it('uses authenticated human identity for root and child HTTP writes and rejects task migration',async()=>{
    const f=fixture();const {store}=f;
    const user=store.getOrCreateUser({email:'responsibility-admin@example.test',name:'Verified human'});
    const member=store.createWorkspaceMember({userId:user.id,name:'Verified human',role:'admin'});
    const other=store.createWorkspaceMember({name:'Different human'});
    const pat=await store.createAccessToken({userId:user.id,name:'Human login',type:'pat',purpose:'session'});
    const app=createMultiremiApp({store,authToken:'test-secret'});
    const headers={Authorization:`Bearer ${pat.token}`,'Content-Type':'application/json'};
    const rootResponse=await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Human root',created_by:other.id})});
    expect(rootResponse.status).toBe(201);const root=await rootResponse.json();
    expect(store.getIssue(root.id)?.responsibleMemberId).toBe(member.id);expect(store.getIssue(root.id)?.createdBy).toBe(user.id);
    const child=await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Inherited child',parent_issue_id:root.id,responsible_member_id:other.id})});
    expect(child.status).toBe(400);expect(await child.text()).toContain('inherited');
    const validChild=await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Inherited child',parent_issue_id:root.id})});
    expect(validChild.status).toBe(201);const childBody=await validChild.json();expect(store.getIssue(childBody.id)?.responsibleMemberId).toBeNull();
    expect(store.resolveIssueResponsibility(childBody.id).rootHuman?.id).toBe(member.id);
    const agent=store.createAgent({name:'Task migration caller',provider:'codex'});
    const task=store.createTask({agentId:agent.id,issueId:root.id,prompt:'Try mapping'});
    const token=await store.createTaskAccessToken(task,user.id);
    const denied=await app.request('/api/workspaces/local/issue-responsibility-migration/map',{method:'POST',headers:{...headers,Authorization:`Bearer ${token.token}`},body:JSON.stringify({reason:'Borrow human',mappings:[]})});
    expect(denied.status).toBe(403);
    store.updateIssue(root.id,{assigneeType:'agent',assigneeId:agent.id});
    const taskHeaders={...headers,Authorization:`Bearer ${token.token}`};
    for(const path of ['/api/issues','/api/multiremi/issues']) {
      const wrong=await app.request(path,{method:'POST',headers:taskHeaders,body:JSON.stringify({title:'Forged responsibility',responsible_member_id:other.id,createdByType:'member',created_by_type:'member',created_by:'local'})});
      expect(wrong.status).toBe(403);
      const same=await app.request(path,{method:'POST',headers:taskHeaders,body:JSON.stringify({title:'Same verified responsibility',responsible_member_id:member.id,createdByType:'member',created_by_type:'member',created_by:'local'})});
      expect(same.status).toBe(201);const body=await same.json();expect(store.getIssue(body.issue?.id??body.id)?.responsibleMemberId).toBe(member.id);expect(store.getIssue(body.issue?.id??body.id)?.createdBy).not.toBe('local');
    }
    const changed=await app.request(`/api/issues/${root.id}`,{method:'PATCH',headers:taskHeaders,body:JSON.stringify({responsible_member_id:other.id})});expect(changed.status).toBe(403);
    const taskChild=await app.request('/api/issues',{method:'POST',headers:taskHeaders,body:JSON.stringify({title:'Task child inherited',parent_issue_id:root.id,responsible_member_id:null})});
    expect(taskChild.status).toBe(201);const taskChildBody=await taskChild.json();expect(store.resolveIssueResponsibility(taskChildBody.id).rootHuman?.id).toBe(member.id);
    const review=await app.request('/api/workspaces/local/issue-responsibility-migration?limit=101',{headers});expect(review.status).toBe(400);
  });
  it('keeps native and compat reassignment transactional and rolls dispatch failures back',async()=>{
    const f=fixture();const {store}=f;
    const a=store.createAgent({name:'Previous execution',provider:'codex'}),b=store.createAgent({name:'Next execution',provider:'codex'});
    const issue=f.createIssue({title:'Reassign with pending work',assigneeType:'agent',assigneeId:a.id});
    const old=store.createTask({agentId:a.id,issueId:issue.id,prompt:'Pending work'});
    const app=createMultiremiApp({store,authToken:'test-secret'}),headers={Authorization:'Bearer test-secret','Content-Type':'application/json'};
    const assigned=await app.request(`/api/multiremi/issues/${issue.id}/assign`,{method:'POST',headers,body:JSON.stringify({assignee_type:'agent',assignee_id:b.id})});
    expect(assigned.status).toBe(200);expect(store.getIssue(issue.id)?.assigneeId).toBe(b.id);
    const compat=await app.request('/api/issues',{method:'POST',headers,body:JSON.stringify({title:'Compat dispatch',responsible_member_id:'mem_local_local',assignee_type:'agent',assignee_id:b.id})});
    expect(compat.status).toBe(201);const compatBody=await compat.json();expect(compatBody.dispatch_status).toBe('dispatched');expect(store.getTask(compatBody.task_id)?.agentId).toBe(b.id);
    expect(store.getTask(old.id)?.status).toBe('cancelled');
    const active=store.listTasks().find(item=>item.issueId===issue.id&&!['completed','cancelled','failed'].includes(item.status))!;
    const taskRepo=(store as unknown as {tasks:{createTask:(input:unknown)=>unknown}}).tasks;
    const fault=spyOn(taskRepo,'createTask').mockImplementation(()=>{throw new Error('dispatch failure');});
    try {
      const response=await app.request(`/api/multiremi/issues/${issue.id}/assign`,{method:'POST',headers,body:JSON.stringify({assignee_type:'agent',assignee_id:a.id})});
      expect(response.status).toBe(500);expect(await response.text()).toContain('dispatch failure');expect(store.getIssue(issue.id)?.assigneeId).toBe(b.id);expect(store.getTask(active.id)?.status).toBe(active.status);
    } finally {fault.mockRestore();}
  });
  it('requires explicit automation responsibility and never infers historical creator during a run',async()=>{
    const f=fixture();const {store}=f;
    const agent=store.createAgent({name:'Automation execution',provider:'codex'});
    const human=store.createWorkspaceMember({name:'Explicit automation human'});
    const legacy=store.createAutopilot({title:'Historical automation',assigneeId:agent.id,executionMode:'create_issue',createdByType:'member',createdById:'local'});
    expect(()=>store.runAutopilot(legacy.id)).toThrow('explicit responsible_member_id');
    expect(store.listIssues().some(issue=>issue.title==='Historical automation')).toBeFalse();
    store.updateAutopilot(legacy.id,{responsibleMemberId:human.id});
    const run=store.runAutopilot(legacy.id);
    expect(store.getIssue(run.issueId!)?.responsibleMemberId).toBe(human.id);expect(store.getIssue(run.issueId!)?.assigneeId).toBe(agent.id);
    f.reopen();expect(f.store.getAutopilot(legacy.id)?.responsibleMemberId).toBe(human.id);
    const user=f.store.getOrCreateUser({email:'autopilot-human@example.test',name:'Authenticated human'});
    const member=f.store.createWorkspaceMember({userId:user.id,name:'Authenticated human',role:'admin'});
    const pat=await f.store.createAccessToken({userId:user.id,name:'Human login',type:'pat',purpose:'session'});
    const app=createMultiremiApp({store:f.store,authToken:'test-secret'});
    for(const path of ['/api/autopilots','/api/multiremi/autopilots']) {
      const response=await app.request(path,{method:'POST',headers:{Authorization:`Bearer ${pat.token}`,'Content-Type':'application/json'},body:JSON.stringify({title:'Verified creator',assignee_id:agent.id,assigneeId:agent.id,created_by_id:'local',createdById:'local',execution_mode:'create_issue'})});
      expect(response.status).toBe(201);const body=await response.json();const id=body.autopilot?.id??body.id;
      expect(f.store.getAutopilot(id)?.createdById).toBe(user.id);expect(f.store.getAutopilot(id)?.responsibleMemberId).toBe(member.id);
    }
  });
  it('retains unconfigured Feishu groups as Chat and requires explicit private transport responsibility',async()=>{
    const f=fixture();const {store,db}=f;
    const oldKey=process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=Buffer.alloc(32,11).toString('base64');
    try {
      const agent=store.createAgent({name:'Feishu execution',provider:'codex'});
      store.registerRuntime({id:'rt_source',name:'Feishu source',provider:'codex',daemonId:'source-daemon'});
      store.heartbeatRuntime('rt_source',{supportsFeishuBotConfig:true});
      const config=store.upsertFeishuBotConfig('local',{agentId:agent.id,runtimeId:'rt_source',appId:'cli_source',appSecretOp:'set',appSecret:'synthetic-test-secret',domain:'feishu',enabled:true});
      store.updateWorkspace('local',{settings:{issueTopics:{enabled:true,chatId:'oc_source'}}});
      const inbound=store.submitFeishuBotMessage('local','rt_source',{revision:config.revision,externalSessionKey:'oc_source',chatType:'group',chatId:'oc_source',externalMessageId:'om_missing_human',senderOpenId:'ou_unmapped_external',text:'Keep my request and show responsibility gap'});
      expect(inbound.responsibilityUnavailableReason).toContain('root human');
      expect(store.getChatSession(inbound.chatSessionId)).not.toBeNull();expect(store.getFeishuIssueIdForChatSession(inbound.chatSessionId)).toBeNull();expect(store.listIssues()).toHaveLength(0);
      expect(db.query("SELECT 1 AS present FROM multiremi_conversation_log WHERE session_id=? AND message_kind='status'").get(inbound.chatSessionId)).not.toBeNull();
      const privateInbound=store.submitFeishuBotMessage('local','rt_source',{revision:config.revision,externalSessionKey:'oc_private_source',chatType:'p2p',chatId:'oc_private_source',externalMessageId:'om_private_source',senderOpenId:'ou_unmapped_external',text:'Private request'});
      // Even a transport Chat carrying the Runtime owner's member id is technical attribution.
      db.run('UPDATE multiremi_chat_sessions SET creator_id=? WHERE id=?',['mem_local_local',privateInbound.chatSessionId]);
      const token=await store.createTaskAccessToken(store.getTask(privateInbound.taskId)!,'local');
      const app=createMultiremiApp({store,authToken:'test-secret'});
      const request=()=>app.request('/api/issues',{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body:JSON.stringify({title:'Root from technical Chat'})});
      const denied=await request();expect(denied.status).toBe(409);expect(await denied.text()).toContain('explicit responsible_member_id');
      const human=store.createWorkspaceMember({name:'Verified external responsibility'});
      store.upsertFeishuBotConfig('local',{...config,appSecretOp:'keep',responsibleMemberId:human.id});
      const created=await request();expect(created.status).toBe(201);const body=await created.json();expect(store.getIssue(body.id)?.responsibleMemberId).toBe(human.id);
      f.reopen();expect(f.store.getFeishuBotConfig('local')?.responsibleMemberId).toBe(human.id);
    } finally {
      if(oldKey===undefined)delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=oldKey;
    }
  });
  it('upgrades already-unified snapshots additively and retains unknown historical ownership',()=>{
    const f=fixture();const issue=f.createIssue({title:'Snapshot history',createdBy:'local'});
    const comment=f.store.createIssueComment(issue.id,{body:'Snapshot evidence'});
    f.db.exec('ALTER TABLE multiremi_issues DROP COLUMN responsible_member_id');
    // Starting a new Store also exercises SQLite's same-connection upgrade.
    f.reopen();
    const upgraded=f.databaseUrl?f.store:new (f.store.constructor as typeof import('@multiremi/store.js').MultiremiStore)(f.db);
    expect(upgraded.getIssue(issue.id)?.responsibleMemberId).toBeNull();
    expect(upgraded.listIssueResponsibilityMigration('local').items[0]?.candidates).toContainEqual({memberId:'mem_local_local',name:'Local User',source:'historical_creator',available:true});
    expect(upgraded.getIssueComment(comment.id)?.body).toBe('Snapshot evidence');
    expect(upgraded.listIssueResponsibilityMigration('local').total).toBe(1);
  });
});
