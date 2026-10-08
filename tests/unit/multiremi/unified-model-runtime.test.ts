import { expect, it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { MultiremiStore } from '@multiremi/store.js';
import { TasksRepo } from '@multiremi/store/repos/tasks-repo.js';
import { StoreContext } from '@multiremi/store/context.js';
import { createCommitEventQueue } from '@multiremi/store/context.js';
import { reconcileUnifiedModel } from '@multiremi/store/unified-model-migration.js';

pendingTurnBackendTests('MUL-505 canonical runtime',fixture=>{
  it('starts empty, writes only the log and reopens without recreating legacy tables',()=>{
    const {store,db}=fixture();
    // The writes must still work when the database itself rejects any mutation
    // of retired storage, including UPDATE/DELETE statements on empty tables.
    if(db.dialect==='postgres')db.exec("CREATE FUNCTION mul505_reject_retired_write() RETURNS trigger AS 'BEGIN RAISE EXCEPTION ''retired conversation write''; END;' LANGUAGE plpgsql");
    for(const table of ['session_events','issue_comments','chat_messages']){
      if(db.dialect==='postgres')db.exec(`CREATE TRIGGER reject_retired BEFORE INSERT OR UPDATE OR DELETE ON multiremi_${table} FOR EACH STATEMENT EXECUTE FUNCTION mul505_reject_retired_write()`);
      else for(const verb of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER reject_${table}_${verb} BEFORE ${verb} ON multiremi_${table} BEGIN SELECT RAISE(ABORT,'retired conversation write'); END`);
    }
    const agent=store.createAgent({name:'Worker',provider:'codex'});
    const issue=store.createIssue({title:'Canonical',assigneeType:'member',assigneeId:'mem_local_local'});
    const comment=store.createIssueComment(issue.id,{body:'hello',authorType:'member',authorId:'mem_local_local'});
    expect(store.getIssueComment(comment.id)?.body).toBe('hello');
    const chat=store.createChatSession({agentId:agent.id,creatorId:'local'});
    const sent=store.sendChatMessage(chat.id,{body:'chat input'});
    expect(store.listChatMessages(chat.id).map(m=>m.body)).toContain('chat input');
    expect(store.getMessage(sent.message.id)).toMatchObject({sender_type:'member',message_kind:'request',body_md:'chat input'});
    expect(store.findTurnEntry(sent.task.id)?.metadata.status).toBe('queued');
    expect(store.findTurnEntry(sent.task.id)?.body_md).toBe('');
    expect(store.findTurnEntry(sent.task.id)?.visibility).toBe('hidden');
    expect(store.findTurnEntry(sent.task.id)?.metadata.assignee_agent_id).toBe(agent.id);
    for(const table of ['session_events','issue_comments','chat_messages'])expect(Number(db.query(`SELECT COUNT(*) AS n FROM multiremi_${table}`).get().n)).toBe(0);
    db.exec('DROP TABLE multiremi_issue_comments; DROP TABLE multiremi_chat_messages; DROP TABLE multiremi_session_events');
    const reopened=new MultiremiStore(db);reopened.ensureLocalWorkspace();
    expect(reopened.getIssueComment(comment.id)?.body).toBe('hello');
    expect(reopened.listChatMessages(chat.id).map(m=>m.body)).toContain('chat input');
    expect(reconcileUnifiedModel(db).mismatches).toEqual([]);
  });
  it('retry, redispatch and recovery replace attempts without changing work identity or Issue state',()=>{
    const {store,db}=fixture();
    const agent=store.createAgent({name:'Worker',provider:'codex',maxConcurrentTasks:4});
    const runtime=store.registerRuntime({name:'test',provider:'codex',maxConcurrency:4});
    const issue=store.createIssue({title:'Recovery',assigneeType:'agent',assigneeId:agent.id});
    const task=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'input'});
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);store.startTask(task.id);
    db.run("UPDATE multiremi_issues SET status='in_review' WHERE id=?",[issue.id]);
    const seq=db.query('SELECT seq FROM multiremi_turns WHERE id=?').get(task.id).seq;
    expect(store.recoverOrphans(runtime.id)).toEqual({orphaned:1,retried:1});
    const second=db.query('SELECT current_attempt_id FROM multiremi_turns WHERE id=?').get(task.id).current_attempt_id;
    expect(db.query('SELECT status FROM multiremi_turn_attempts WHERE id=?').get(task.id).status).toBe('lost');
    db.transaction(()=>new TasksRepo(new StoreContext(db,()=>store)).redispatchTaskWithinTransaction(second,[],createCommitEventQueue()))();
    const third=db.query('SELECT current_attempt_id FROM multiremi_turns WHERE id=?').get(task.id).current_attempt_id;
    expect(third).not.toBe(second);
    expect(db.query('SELECT status FROM multiremi_issues WHERE id=?').get(issue.id).status).toBe('in_review');
    expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_turns').get().n)).toBe(1);
    expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_turn_attempts WHERE turn_id=?').get(task.id).n)).toBe(3);
    expect(db.query('SELECT seq FROM multiremi_turns WHERE id=?').get(task.id).seq).toBe(seq);
    expect(db.query("SELECT metadata,body_md FROM multiremi_conversation_log WHERE kind='turn'").get()).toEqual({metadata:'{}',body_md:''});
    expect(reconcileUnifiedModel(db).mismatches).toEqual([]);
  });
  it('run-only automation writes a timer request in its own conversation and links the ledger to its turn',()=>{
    const {store,db}=fixture();
    const agent=store.createAgent({name:'Worker',provider:'codex'});
    const auto=store.createAutopilot({title:'Automation',assigneeType:'agent',assigneeId:agent.id,executionMode:'run_only',description:'do work'});
    const run=store.runAutopilot(auto.id);expect(run.taskId).toBeTruthy();
    const session=db.query('SELECT session_id FROM multiremi_autopilots WHERE id=?').get(auto.id).session_id;
    expect(session).toBe(`auto_${auto.id}`);
    const turn=db.query('SELECT turn_id FROM multiremi_autopilot_runs WHERE id=?').get(run.id).turn_id;
    expect(db.query('SELECT session_id FROM multiremi_turns WHERE id=?').get(turn).session_id).toBe(session);
    expect(db.query("SELECT sender_type,to_agent_id FROM multiremi_conversation_log WHERE session_id=? AND message_kind='request'").get(session)).toEqual({sender_type:'timer',to_agent_id:agent.id});
    for(const column of ['task_id','status','result'])expect(db.query('PRAGMA table_info(multiremi_autopilot_runs)').all().map((r:any)=>r.name)).not.toContain(column);
    expect(store.getAutopilotRun(run.id)?.status).toBe('running');
  });
  it('queues consecutive run_only invocations in independent lanes and completes each once', () => {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: 'Concurrent auto', provider: 'codex' });
    const runtime = store.registerRuntime({ name: 'auto host', provider: 'codex' });
    const auto = store.createAutopilot({ title: 'Repeat', assigneeId: agent.id, executionMode: 'run_only' });
    const first = store.runAutopilot(auto.id);
    const second = store.runAutopilot(auto.id);
    expect(second.id).not.toBe(first.id);
    expect(second.taskId).not.toBe(first.taskId);
    const turns = db.query('SELECT session_id,execution_scope,status FROM multiremi_turns WHERE session_id=?').all(`auto_${auto.id}`);
    expect(turns).toHaveLength(2);
    expect(new Set(turns.map(t => t.execution_scope)).size).toBe(2);
    expect(turns.every(t => t.status === 'pending')).toBeTrue();
    for (let i = 0; i < 2; i++) {
      const task = store.claimTask(runtime.id)!;
      expect([first.taskId, second.taskId]).toContain(task.id);
      store.startTask(task.id);
      store.completeTask(task.id, { output: `answer ${i}` });
    }
    expect(store.getAutopilotRun(first.id)?.status).toBe('completed');
    expect(store.getAutopilotRun(second.id)?.status).toBe('completed');
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_turns WHERE session_id=?').get(`auto_${auto.id}`).n)).toBe(2);
  });
  it('completes create_issue automation without re-ringing its own timer input', () => {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: 'Issue auto', provider: 'codex' });
    const runtime = store.registerRuntime({ name: 'auto host', provider: 'codex' });
    const auto = store.createAutopilot({ title: 'Create Issue', assigneeId: agent.id, executionMode: 'create_issue' });
    const run = store.runAutopilot(auto.id);
    // The original timer request uses the unified platform wake policy.
    expect(db.query('SELECT id,wake_source FROM multiremi_turns WHERE issue_id=?').all(run.issueId)).toEqual([
      { id: run.taskId, wake_source: 'platform_to_owner' },
    ]);
    store.updateIssue(run.issueId!, { status: 'in_progress' });
    expect(store.claimTask(runtime.id)?.id).toBe(run.taskId!);
    store.startTask(run.taskId!);
    store.completeTask(run.taskId!, { output: 'fixed' });
    expect(store.getAutopilotRun(run.id)?.status).toBe('completed');
    expect(store.getIssue(run.issueId!)).toMatchObject({assigneeType:null,assigneeId:null,status:'in_progress'});
    expect(db.query('SELECT id,status,wake_source FROM multiremi_turns WHERE issue_id=?').all(run.issueId)).toEqual([
      { id: run.taskId, status: 'completed', wake_source: 'platform_to_owner' },
    ]);
    expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE session_id=? AND message_kind='reply' AND kind='message'")
      .get(store.getTask(run.taskId!)!.issueSessionId!).n)).toBe(1);
    expect(store.claimTask(runtime.id)).toBeNull();
  });
  it('publishes one completion reply and derives the card and automation outcome from it',()=>{
    const {store,db}=fixture();const agent=store.createAgent({name:'Worker',provider:'codex'});
    const runtime=store.registerRuntime({name:'test',provider:'codex'});
    const chat=store.createChatSession({agentId:agent.id,creatorId:'local'});
    const sent=store.sendChatMessage(chat.id,{body:'question'});
    expect(store.claimTask(runtime.id)?.id).toBe(sent.task.id);store.startTask(sent.task.id);
    store.completeTask(sent.task.id,{output:'chat answer'});
    expect(store.listChatMessages(chat.id).filter(m=>m.role==='assistant').map(m=>m.body)).toEqual(['chat answer']);
    const card=store.findTurnEntry(sent.task.id)!;expect(card.metadata.final_reply_md).toBe('chat answer');
    expect(card.body_md).toBe('chat answer');
    expect(card.visibility).toBe('shown');
    expect(db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_conversation_log WHERE session_id=? AND sender_type='agent' AND kind='message'").get(chat.id).n).toBe(1);
    const auto=store.createAutopilot({title:'Completion',assigneeType:'agent',assigneeId:agent.id,executionMode:'run_only',description:'input'});
    const run=store.runAutopilot(auto.id);expect(store.claimTask(runtime.id)?.id).toBe(run.taskId!);store.startTask(run.taskId!);
    store.completeTask(run.taskId!,{output:'auto answer'});
    expect(store.getAutopilotRun(run.id)?.status).toBe('completed');
    expect(store.findTurnEntry(run.taskId!)?.metadata.final_entry_id).toBeTruthy();
    expect(db.query("SELECT body_md FROM multiremi_conversation_log WHERE session_id=? AND message_kind='reply'").get(`auto_${auto.id}`).body_md).toBe('auto answer');
  });
  it('keeps old attempt statistics independent and emits projected creation and update frames',()=>{
    const {store,db}=fixture();const agent=store.createAgent({name:'Worker',provider:'codex'});
    const runtime=store.registerRuntime({name:'test',provider:'codex'});
    const issue=store.createIssue({title:'Statistics'});const frames:any[]=[];
    store.subscribeConversationLog({onEntry:(_session,entry)=>{frames.push(entry);}});
    const first=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'input'});
    expect(frames.find(f=>f.kind==='turn')?.metadata.current_attempt_id).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);store.startTask(first.id);
    store.recoverOrphans(runtime.id);
    const current=db.query('SELECT current_attempt_id FROM multiremi_turns WHERE id=?').get(first.id).current_attempt_id;
    const fields={trace:{event_count:7,head:7,closed:true as const,tool_call_count:2,type_histogram:[{type:'tool_use',tool:'Read',count:2}]},model:{provider:'codex',model:'new-model'},final_reply_md:null};
    db.transaction(()=>store.recordTurnCardCompletionFieldsWithinTransaction(current,fields))();
    db.transaction(()=>store.recordTurnCardCompletionFieldsWithinTransaction(first.id,{...fields,trace:{...fields.trace,event_count:3},model:{provider:'claude',model:'old-model'}}))();
    expect(store.findTurnEntry(first.id)?.metadata.event_count).toBe(7);
    expect(store.findTurnEntry(first.id)?.metadata.model).toEqual({provider:'codex',model:'new-model'});
    expect(Number(db.query('SELECT event_count FROM multiremi_turn_attempts WHERE id=?').get(first.id).event_count)).toBe(3);
    const revision=store.findTurnEntry(current)!.revision;
    expect(db.transaction(()=>store.recordTurnCardCompletionFieldsWithinTransaction(current,fields))()).toBe(false);
    expect(store.findTurnEntry(current)!.revision).toBe(revision);
    expect(frames.filter(f=>f.target_seq!=null).at(-1)?.fields.metadata.event_count).toBe(7);
    expect(db.query('SELECT metadata,body_md FROM multiremi_conversation_log WHERE id=?').get(first.id)).toEqual({metadata:'{}',body_md:''});
  });

});
