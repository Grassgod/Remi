import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { PostgresSyncDatabase, type SqlDatabase } from '@multiremi/store/db/postgres.js';
import { bootstrapPreUnifiedSchema } from '@multiremi/store/migrations.js';
import { createId } from '@multiremi/ids.js';

/** Seed an actual historical schema without invoking current runtime writers. */
function historicalWriters(db:SqlDatabase) {
  const at='2026-10-01T00:00:00.000Z';let number=0;
  const insert=(table:string,row:Record<string,unknown>)=>db.run(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row));
  insert('multiremi_workspaces',{id:'local',name:'Local',slug:'local',created_at:at,updated_at:at});
  insert('multiremi_users',{id:'local',name:'Local',email:'local@example.test',created_at:at,updated_at:at});
  insert('multiremi_workspace_members',{id:'mem_local_local',workspace_id:'local',user_id:'local',name:'Local',created_at:at,updated_at:at});
  function getOrCreateDefaultIssueSession(issueId:string) {
    let row=db.query('SELECT id FROM multiremi_issue_sessions WHERE issue_id=? AND is_default=1').get(issueId);
    if(!row){row={id:createId('ises')};insert('multiremi_issue_sessions',{id:row.id,issue_id:issueId,workspace_id:'local',is_default:1,created_at:at,updated_at:at});}
    return row as {id:string};
  }
  function appendConversationLog(input:any) {
    db.run('INSERT INTO multiremi_conversation_heads(session_id,head_seq,log_version,updated_at) VALUES(?,0,0,?) ON CONFLICT(session_id) DO NOTHING',[input.sessionId,at]);
    const head=db.query('UPDATE multiremi_conversation_heads SET head_seq=head_seq+1 WHERE session_id=? RETURNING head_seq').get(input.sessionId);
    insert('multiremi_conversation_log',{session_id:input.sessionId,seq:head.head_seq,id:input.id??createId('cmt'),kind:input.kind,visibility:input.kind==='delegation_report'?'hidden':'shown',author_type:input.authorType,author_id:input.authorId??null,task_id:input.taskId??null,body_md:input.bodyMd??'',metadata:JSON.stringify(input.metadata??{}),created_at:at,updated_at:at});
    return {seq:Number(head.head_seq)};
  }
  return {
    createAgent(input:{name:string;provider:string}) {const id=createId('agt');insert('multiremi_agents',{id,name:input.name,provider:input.provider,created_at:at,updated_at:at});return {id};},
    createIssue(input:{title:string;assigneeType?:string;assigneeId?:string}) {const id=createId('iss');insert('multiremi_issues',{id,title:input.title,issue_number:++number,workspace_id:'local',assignee_type:input.assigneeType??null,assignee_id:input.assigneeId??null,created_at:at,updated_at:at});return {id};},
    createTask(input:any) {
      const id=createId('tsk'),session=input.issueId?getOrCreateDefaultIssueSession(input.issueId):null;
      insert('multiremi_tasks',{id,agent_id:input.agentId,issue_id:input.issueId??null,issue_session_id:session?.id??null,prompt:input.prompt,parent_task_id:input.parentTaskId??null,continued_from_task_id:input.continuedFromTaskId??null,attempt:input.attempt??1,created_at:at,updated_at:at});
      if(session){appendConversationLog({sessionId:session.id,kind:'turn',authorType:'agent',authorId:input.agentId,taskId:id,bodyMd:input.prompt,metadata:{status:'queued'}});
        db.run("INSERT INTO multiremi_session_agent_lanes(session_id,agent_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",[session.id,input.agentId,at,at]);}
      return {id,createdAt:at};
    },getOrCreateDefaultIssueSession,appendConversationLog,
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
