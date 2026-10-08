import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { PostgresSyncDatabase, type SqlDatabase } from '@multiremi/store/db/postgres.js';
import { bootstrapPreUnifiedSchema } from '@multiremi/store/migrations.js';
import { createId } from '@multiremi/ids.js';
import { sessionEventToConversationLog, chatMessageToConversationLog } from '@multiremi/store/conversation-log-mirror.js';
import { conversationLogProjectionEvents } from '@multiremi/store/conversation-log-projection.js';

/** Seed an actual historical schema without invoking current runtime writers. */
export function historicalWriters(db:SqlDatabase) {
  const at='2026-10-01T00:00:00.000Z';let number=0;
  const insert=(table:string,row:Record<string,unknown>)=>db.run(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row));
  insert('multiremi_workspaces',{id:'local',name:'Local',slug:'local',created_at:at,updated_at:at});
  insert('multiremi_users',{id:'local',name:'Local',email:'local@example.test',created_at:at,updated_at:at});
  insert('multiremi_workspace_members',{id:'mem_local_local',workspace_id:'local',user_id:'local',name:'Local',created_at:at,updated_at:at});
  function getOrCreateDefaultIssueSession(issueId:string) {
    let row=db.query('SELECT id FROM multiremi_issue_sessions WHERE issue_id=? AND is_default=1').get(issueId);
    if(!row){row={id:createId('ises')};insert('multiremi_issue_sessions',{id:row.id,issue_id:issueId,workspace_id:'local',is_default:1,created_at:at,updated_at:at});
      const issue=db.query('SELECT title,description FROM multiremi_issues WHERE id=?').get(issueId)!;
      insert('multiremi_conversation_heads',{session_id:row.id,head_seq:0,log_version:0,updated_at:at});
      insert('multiremi_conversation_log',{session_id:row.id,seq:0,id:`head_${row.id}`,kind:'head',visibility:'shown',author_type:'system',body_md:issue.description?.trim()?`${issue.title}\n\n${issue.description.trim()}`:issue.title,metadata:JSON.stringify({title:issue.title}),created_at:at,updated_at:at});
    }
    return hydrate(db.query('SELECT * FROM multiremi_issue_sessions WHERE id=?').get(row.id));
  }
  function appendConversationLog(input:any) {
    db.run('INSERT INTO multiremi_conversation_heads(session_id,head_seq,log_version,updated_at) VALUES(?,0,0,?) ON CONFLICT(session_id) DO NOTHING',[input.sessionId,at]);
    const head=input.seq===undefined?db.query('UPDATE multiremi_conversation_heads SET head_seq=head_seq+1 WHERE session_id=? RETURNING head_seq').get(input.sessionId):{head_seq:input.seq};
    if(input.seq!==undefined)db.run('UPDATE multiremi_conversation_heads SET head_seq=CASE WHEN head_seq<? THEN ? ELSE head_seq END WHERE session_id=?',[input.seq,input.seq,input.sessionId]);
    insert('multiremi_conversation_log',{session_id:input.sessionId,seq:input.seq??head.head_seq,id:input.id??createId('cmt'),kind:input.kind,visibility:input.kind==='delegation_report'?'hidden':'shown',author_type:input.authorType,author_id:input.authorId??null,task_id:input.taskId??null,body_md:input.bodyMd??'',parent_id:input.parentId??null,metadata:JSON.stringify(input.metadata??{}),created_at:input.createdAt??at,updated_at:input.createdAt??at});
    return getConversationLogEntryById(input.id??String(db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? AND seq=?').get(input.sessionId,input.seq??head.head_seq).id));
  }
  const hydrate=(row:any):any=>row?Object.fromEntries(Object.entries(row).flatMap(([key,value])=>[[key,value],[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]])):null;
  const getTask=(id:string)=>{
    // Historical DDL probes alter the row shape; keep prepared queries tied to that shape.
    const columns=db.query('PRAGMA table_info(multiremi_tasks)').all().map(row=>String(row.name));
    return hydrate(db.query(`SELECT ${columns.join(',')} FROM multiremi_tasks WHERE id=?`).get(id));
  };
  function createTask(input:any) {
    const id=createId('tsk'),session=input.issueSessionId?{id:input.issueSessionId}:input.issueId&&!input.chatSessionId?getOrCreateDefaultIssueSession(input.issueId):null;
    insert('multiremi_tasks',{id,agent_id:input.agentId,issue_id:input.issueId??null,issue_session_id:input.issueSessionId??session?.id??null,
      chat_session_id:input.chatSessionId??null,prompt:input.prompt,status:input.status??'queued',
      parent_task_id:input.parentTaskId??null,continued_from_task_id:input.continuedFromTaskId??null,attempt:input.attempt??1,
      delegation_id:input.delegationId??null,delegated_by_agent_id:input.delegatedByAgentId??null,
      execution_scope:input.delegatedByAgentId&&input.agentId!==input.delegatedByAgentId?input.delegationId??'':'',
      wake_source:input.wakeSource??null,trigger_comment_id:input.triggerCommentId??null,created_at:at,updated_at:at});
    if(session){appendSessionEvent(session.id,{kind:'task_assigned',authorType:'agent',authorId:input.agentId,taskId:id,body:input.prompt,metadata:{status:'queued'}});
      db.run("INSERT INTO multiremi_session_agent_lanes(session_id,agent_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",[session.id,input.agentId,at,at]);}
    return getTask(id);
  }
  function createChatSession(input:any) {
    const id=createId('chat');insert('multiremi_chat_sessions',{id,workspace_id:'local',agent_id:input.agentId,creator_id:input.creatorId??'local',title:input.title??'Historical chat',created_at:at,updated_at:at});return hydrate(db.query('SELECT * FROM multiremi_chat_sessions WHERE id=?').get(id));
  }
  function sendChatMessage(chatId:string,input:any) {
    const chat=db.query('SELECT * FROM multiremi_chat_sessions WHERE id=?').get(chatId);
    const binding=db.query('SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id=?').get(chatId);
    const task=createTask({agentId:chat.agent_id,chatSessionId:chatId,issueId:binding?.issue_id??null,prompt:input.content});
    const id=createId('msg'),seq=Number(db.query('SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM multiremi_chat_messages WHERE chat_session_id=?').get(chatId).seq);
    insert('multiremi_chat_messages',{id,chat_session_id:chatId,task_id:task.id,role:'user',body:input.content,sequence:seq,created_at:at});
    const message=db.query('SELECT * FROM multiremi_chat_messages WHERE id=?').get(id);
    appendConversationLog(chatMessageToConversationLog(message as any,{id:chatId,creatorId:chat.creator_id}));
    return {task,message:hydrate(message)};
  }
  function createIssueComment(issueId:string,input:any) {
    const id=createId('cmt'),session=getOrCreateDefaultIssueSession(issueId);
    insert('multiremi_issue_comments',{id,issue_id:issueId,issue_session_id:session.id,author_type:input.authorType??'member',author_id:input.authorId??null,task_id:input.taskId??null,body:input.body,type:input.type??'comment',parent_id:input.parentId??null,created_at:at,updated_at:at});
    appendSessionEvent(session.id,{authorType:input.authorType??'member',authorId:input.authorId??null,taskId:input.taskId??null,sourceCommentId:id,kind:input.type==='system'?'system':'message',body:input.body,metadata:{parent_comment_id:input.parentId??null}});
    return hydrate(db.query('SELECT * FROM multiremi_issue_comments WHERE id=?').get(id));
  }
  function getConversationLogEntryById(id:string):any {
    const row=db.query('SELECT * FROM multiremi_conversation_log WHERE id=?').get(id);
    return row?{...row,seq:Number(row.seq),revision:Number(row.revision),metadata:JSON.parse(String(row.metadata))}:null;
  }
  function listLog(id:string):any[] {return db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(id).map(row=>getConversationLogEntryById(String(row.id)));}
  function appendSessionEvent(sessionId:string,input:any):any {
    db.run('INSERT INTO multiremi_conversation_heads(session_id,head_seq,log_version,updated_at) VALUES(?,0,0,?) ON CONFLICT DO NOTHING',[sessionId,at]);
    const id=createId('eve'),seq=Number(db.query('SELECT head_seq+1 AS seq FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId).seq);
    const row={id,session_id:sessionId,seq,kind:input.kind??'message',author_type:input.authorType??'member',author_id:input.authorId??null,task_id:input.taskId??null,source_comment_id:input.sourceCommentId??null,body:input.body??'',metadata:JSON.stringify(input.metadata??{}),created_at:input.createdAt??at};
    insert('multiremi_session_events',row);
    const mirrored=sessionEventToConversationLog(row, input.sourceCommentId ? input.taskId??null : null);
    if(mirrored){if(typeof mirrored.metadata.comment_id==='string'){const target=getConversationLogEntryById(mirrored.metadata.comment_id);if(target)mirrored.metadata.target_seq=target.seq;}appendConversationLog(mirrored);}
    return hydrate({...row,metadata:input.metadata??{}});
  }
  function updateIssueComment(id:string,input:any):any {
    const comment=db.query('SELECT * FROM multiremi_issue_comments WHERE id=?').get(id)!;
    db.run('UPDATE multiremi_issue_comments SET body=?,updated_at=? WHERE id=?',[input.body,at,id]);
    db.run('UPDATE multiremi_conversation_log SET body_md=?,revision=revision+1 WHERE id=?',[input.body,id]);
    appendSessionEvent(String(comment.issue_session_id),{kind:'message_edited',authorType:comment.author_type,authorId:comment.author_id,body:input.body,metadata:{comment_id:id}});
    return hydrate(db.query('SELECT * FROM multiremi_issue_comments WHERE id=?').get(id));
  }
  function deleteIssueComment(id:string):void {
    const comment=db.query('SELECT * FROM multiremi_issue_comments WHERE id=?').get(id)!;
    db.run('DELETE FROM multiremi_issue_comments WHERE id=?',[id]);
    db.run("UPDATE multiremi_conversation_log SET body_md='',task_id=NULL,deleted_at=?,metadata=? WHERE id=?",[at,JSON.stringify({deleted_body:comment.body}),id]);
    appendSessionEvent(String(comment.issue_session_id),{kind:'message_deleted',authorType:comment.author_type,authorId:comment.author_id,body:'',metadata:{comment_id:id}});
  }
  function resolveIssueComment(id:string,input:any={},resolved=true):void {
    const comment=db.query('SELECT * FROM multiremi_issue_comments WHERE id=?').get(id)!;
    db.run('UPDATE multiremi_issue_comments SET resolved_at=?,resolved_by_type=?,resolved_by_id=? WHERE id=?',[resolved?at:null,resolved?input.actorType??'member':null,resolved?input.actorId??null:null,id]);
    db.run('UPDATE multiremi_conversation_log SET resolved_at=?,resolved_by_type=?,resolved_by_id=? WHERE id=?',[resolved?at:null,resolved?input.actorType??'member':null,resolved?input.actorId??null:null,id]);
    appendSessionEvent(String(comment.issue_session_id),{kind:resolved?'thread_resolved':'thread_unresolved',authorType:input.actorType??'member',authorId:input.actorId??null,metadata:{comment_id:id},body:''});
  }
  return {
    createAgent(input:{name:string;provider:string}) {const id=createId('agt');insert('multiremi_agents',{id,name:input.name,provider:input.provider,created_at:at,updated_at:at});return {id};},
    createIssue(input:{title:string;assigneeType?:string;assigneeId?:string}) {const id=createId('iss');insert('multiremi_issues',{id,title:input.title,issue_number:++number,workspace_id:'local',assignee_type:input.assigneeType??null,assignee_id:input.assigneeId??null,description:(input as any).description??'',created_at:at,updated_at:at});return hydrate(db.query('SELECT * FROM multiremi_issues WHERE id=?').get(id));},
    createTask,getTask,createChatSession,sendChatMessage,createIssueComment,appendSessionEvent,updateIssueComment,deleteIssueComment,resolveIssueComment,
    unresolveIssueComment:(id:string)=>resolveIssueComment(id,{},false),
    createTaskFailureSystemComment:(issueId:string,sessionId:string,taskId:string,body:string)=>createIssueComment(issueId,{issueSessionId:sessionId,taskId,body,type:'system',authorType:'system'}),
    getConversationLogEntryById,getConversationLogEntry:(id:string,seq:number)=>listLog(id).find(row=>row.seq===seq)??null,
    listConversationLogEntries:(id:string)=>listLog(id).filter(row=>row.visibility==='shown'),
    conversationLog:{listAll:listLog},
    getConversationLogHead:(id:string)=>hydrate(db.query('SELECT * FROM multiremi_conversation_heads WHERE session_id=?').get(id)),
    getChatSession:(id:string)=>hydrate(db.query('SELECT * FROM multiremi_chat_sessions WHERE id=?').get(id)),
    listIssueSessions:(id:string)=>db.query('SELECT * FROM multiremi_issue_sessions WHERE issue_id=?').all(id).map(hydrate),
    getIssueComment:(id:string)=>hydrate(db.query('SELECT * FROM multiremi_issue_comments WHERE id=?').get(id)),
    listSessionEvents:(id:string,input:any={})=>conversationLogProjectionEvents(listLog(id)).filter(row=>row.seq>(input.sinceSeq??0)&&row.seq<=(input.toSeq??Infinity)),
    ensureLocalWorkspace:()=>undefined,setAgentIssueUpdateSubscription:()=>undefined,
    listTasksForIssue:(id:string)=>db.query('SELECT * FROM multiremi_tasks WHERE issue_id=?').all(id).map(hydrate),
    getOrCreateDefaultIssueSession,appendConversationLog,
  };
}
export function unifiedModelBackendTests(name:string,tests:(fixture:()=>{db:SqlDatabase;store:ReturnType<typeof historicalWriters>})=>void):void {
  for(const backend of ['SQLite','PostgreSQL']) {
    const adminUrl=process.env.MULTIREMI_TEST_POSTGRES_URL;
    describe.skipIf(backend==='PostgreSQL'&&!adminUrl)(`${name} (${backend})`,()=>{
      let admin:Bun.SQL|undefined,database:string|undefined,current:{db:SqlDatabase;store:ReturnType<typeof historicalWriters>};
      beforeAll(async()=>{if(backend==='PostgreSQL'){if(!['127.0.0.1','localhost','[::1]'].includes(new URL(adminUrl!).hostname))throw new Error('Requires local PostgreSQL');admin=new Bun.SQL(adminUrl!,{max:1});await admin`SELECT 1`;}});
      beforeEach(async()=>{
        let db:SqlDatabase;
        if(backend==='PostgreSQL'){database=`mul505_${process.pid}_${crypto.randomUUID().replaceAll('-','')}`;await admin!.unsafe(`CREATE DATABASE ${database}`);const url=new URL(adminUrl!);url.pathname=`/${database}`;db=new PostgresSyncDatabase(url.toString());}
        else db=openSqliteDatabase(':memory:') as unknown as SqlDatabase;
        bootstrapPreUnifiedSchema(db);current={db,store:historicalWriters(db)};
      },30_000);
      afterEach(async()=>{current?.db.close();if(database){await admin!.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);database=undefined;}});
      afterAll(async()=>{await admin?.end();});tests(()=>current);
    });
  }
}
