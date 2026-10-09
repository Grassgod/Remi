import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';

function setup(f:PendingTurnTestFixture,transport=false,creatorId='local') {
  const {store,db}=f;
  const runtime=store.registerRuntime({name:'Chat responsibility host',provider:'codex',daemonId:'chat-mutation-host',maxConcurrency:8});
  store.heartbeatRuntime(runtime.id,{supportsFeishuBotConfig:true});
  const agent=store.createAgent({name:'Chat execution',provider:'codex'});
  const chat=store.createChatSession({agentId:agent.id,creatorId,title:'Actual Chat source'});
  if(transport)db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings(id,workspace_id,app_id,agent_id,external_session_key,chat_session_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`,['source_transport','local','cli_chat_mutation',agent.id,'oc_mutation',chat.id,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z']);
  const task=store.createTask({agentId:agent.id,chatSessionId:chat.id,prompt:'Ask in original Chat'});
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);store.startTask(task.id);
  const turn=store.getTurnForAttempt(task.id)!;
  const result=store.getDaemonTurnBridge().rpc('turn.decision',{turn_id:turn.id,attempt_id:task.id,wait_id:`native_chat_${task.id}`,dedupe_key:'actual-chat-mutation',body_md:'Which approach?',options:[{label:'A',value:'A'}],metadata:{kind:'question'},timeout_ms:1000},
    {runtimeId:runtime.id,daemonId:'chat-mutation-host',workspaceId:'local'});
  expect(result.ok).toBeTrue();const id=String(result.message_id);
  return {...f,get store(){return f.store;},get db(){return f.db;},runtime,agent,chat,task,id};
}
function encryption<T>(run:()=>T):T {
  const prior=process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=Buffer.alloc(32,11).toString('base64');
  try{return run();}finally{if(prior===undefined)delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=prior;}
}
pendingTurnBackendTests('real Chat responsibility mutation hooks',fixture=>{
  it('refreshes transport Q during config mutation, ignores secret changes, and rolls config/card/route back together',()=>encryption(()=>{
    const f=setup(fixture(),true);const {store,db}=f;
    const human=store.createWorkspaceMember({name:'Explicit transport human'});
    const input={agentId:f.agent.id,runtimeId:f.runtime.id,appId:'cli_chat_mutation',appSecretOp:'set' as const,appSecret:'synthetic-chat-mutation-secret',domain:'feishu' as const,enabled:false,responsibleMemberId:human.id,actor:'local'};
    expect(store.getQuestion(f.id)?.current_handler).toBeNull();
    store.upsertFeishuBotConfig('local',input);
    expect(store.getQuestion(f.id)?.current_handler).toEqual({type:'member',id:human.id});expect(store.getQuestion(f.id)?.route_revision).toBe(2);
    expect(store.getQuestion(f.id)?.history.findLast(e=>e.type==='transfer'&&e.reason==='chat_responsibility_transferred')?.actor).toEqual({type:'member',id:'mem_local_local'});
    db.run('UPDATE multiremi_conversation_log SET card_token_hash=?,card_token_recipient=? WHERE id=?',['old-card','old-member',f.id]);
    store.upsertFeishuBotConfig('local',{...input,appSecret:'different-synthetic-secret',domain:'lark'});
    expect(store.getQuestion(f.id)?.route_revision).toBe(2);expect(store.getMessage(f.id)?.card_token_hash).toBe('old-card');
    const events:string[]=[];const off=store.onWorkspaceEvent(event=>events.push(event.type));
    try {
      expect(()=>f.transaction(()=>{
        store.upsertFeishuBotConfig('local',{...input,responsibleMemberId:'mem_local_local'});
        expect(store.getQuestion(f.id)?.current_handler?.id).toBe('mem_local_local');
        throw new Error('rollback Chat responsibility mutation');
      })).toThrow('rollback Chat responsibility mutation');
      expect(store.getFeishuBotConfig('local')?.responsibleMemberId).toBe(human.id);expect(store.getQuestion(f.id)?.route_revision).toBe(2);expect(store.getMessage(f.id)?.card_token_hash).toBe('old-card');expect(events).toEqual([]);
    } finally {off();}
    store.deleteFeishuBotConfig('local','local');
    expect(store.getQuestion(f.id)).toMatchObject({current_handler:null,route_revision:3,route_reason:'explicit_human_responsibility_required'});expect(store.getMessage(f.id)?.card_token_hash).toBeNull();
    f.reopen();expect(f.store.getQuestion(f.id)?.route_revision).toBe(3);expect(f.store.getMessage(f.id)?.session_id).toBe(f.chat.id);
  }));
  it('invalidates ordinary Chat responsibility on actual member archive without guessing another owner',()=>{
    const f=setup(fixture());
    const user=f.store.getOrCreateUser({email:'other-chat-owner@example.test',name:'Other owner'});
    f.store.createWorkspaceMember({userId:user.id,name:'Other owner',role:'owner'});
    f.db.run('UPDATE multiremi_conversation_log SET card_token_hash=? WHERE id=?',['old-card',f.id]);
    f.store.archiveWorkspaceMember('mem_local_local');
    expect(f.store.getQuestion(f.id)).toMatchObject({current_handler:null,route_revision:2,route_reason:'explicit_human_responsibility_required'});
    expect(f.store.getMessage(f.id)?.card_token_hash).toBeNull();expect(f.store.getMessage(f.id)?.session_id).toBe(f.chat.id);
  });
  it('refreshes old and new workspaces when a named Chat human moves',()=>{
    const f=fixture();const human=f.store.createWorkspaceMember({name:'Original named Chat human'});
    const h=setup(f,false,human.id);const target=h.store.createWorkspace({name:'Other workspace',slug:'chat-responsibility-other'},'local');
    h.store.updateWorkspaceMember(human.id,{workspaceId:target.id});
    expect(h.store.getQuestion(h.id)).toMatchObject({current_handler:null,route_revision:2,route_reason:'explicit_human_responsibility_required'});
    expect(h.store.getMessage(h.id)?.session_id).toBe(h.chat.id);
  });
  it('refreshes Q when its source Agent is archived/restored and preserves the original native source',()=>{
    const f=setup(fixture());const source=f.store.getQuestion(f.id)!;
    f.store.archiveAgent(f.agent.id);
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(2);expect(f.store.getQuestion(f.id)?.current_handler).toEqual(source.current_handler);
    f.store.restoreAgent(f.agent.id);
    expect(f.store.getQuestion(f.id)?.route_revision).toBe(3);expect(f.store.getQuestion(f.id)?.source_turn_id).toBe(source.source_turn_id);expect(f.store.getMessage(f.id)?.session_id).toBe(f.chat.id);expect(f.store.getMessage(f.id)?.task_id).toBe(source.source_turn_id);
    expect(f.store.getQuestion(f.id)?.original_questions).toEqual(source.original_questions);
  });
});
