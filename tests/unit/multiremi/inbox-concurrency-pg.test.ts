import { createResponsibleTestIssue } from './helpers.js';
import { resolveMigrationReportDirectory } from "@multiremi/store/migration-report-directory.js";
import {it,expect} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const worker=join(import.meta.dir,'fixtures/inbox-concurrency-worker.ts');
pendingTurnBackendTests('MUL-506 PG process concurrency',(fixture,backend)=>{
  if(backend!=='PostgreSQL')return;
  async function concurrent(inputs:Record<string,unknown>[]){const dir=mkdtempSync(join(tmpdir(),'mul506-barrier-')),release=join(dir,'release');
    const processes=inputs.map(input=>{const child=Bun.spawn([process.execPath,worker],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});child.stdin.write(JSON.stringify({...input,release,migrationReportDir:resolveMigrationReportDirectory()}));child.stdin.end();return child;});
    try{
      const readers=processes.map(p=>p.stdout.getReader()),prefix:string[]=[];
      for(const reader of readers){const chunk=await reader.read();const text=new TextDecoder().decode(chunk.value);expect(text.trim()).toBe('ready');prefix.push('');}
      writeFileSync(release,'release');
      const results=await Promise.all(processes.map(async(p,i)=>{let output=prefix[i]!;for(;;){const chunk=await readers[i]!.read();if(chunk.done)break;output+=new TextDecoder().decode(chunk.value);}const error=await new Response(p.stderr).text();expect(await p.exited,error).toBe(0);return JSON.parse(output.trim());}));
      return results;
    }finally{for(const p of processes)p.kill();rmSync(dir,{recursive:true,force:true});}
  }
  function setup(){const f=fixture(),a=f.store.createAgent({name:'PG recipient',provider:'codex'}),issue=createResponsibleTestIssue(f.store, {title:'PG lane',assigneeType:'agent',assigneeId:a.id}),session=f.store.getOrCreateDefaultIssueSession(issue.id);
    return {...f,a,issue,session,message:{session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:a.id},message_kind:'request',wake_requested:'now',body_md:'now'}};}
  it('two server processes sending now messages create only one pending turn',async()=>{const f=setup();const results=await concurrent([1,2].map(i=>({databaseUrl:f.databaseUrl,operation:'send',message:{...f.message,body_md:`now ${i}`}})));
    expect(new Set(results.map(r=>r.turn_id)).size).toBe(1);expect(f.store.listTurns({workspace_id:'local',session_id:f.session.id}).filter(t=>t.status==='pending')).toHaveLength(1);expect(f.store.listMessages(f.session.id)).toHaveLength(2);},30_000);
  it('send and completion racing preserve unread input in the next pending turn',async()=>{const f=setup();f.store.registerRuntime({id:'rt_pg_inbox',daemonId:'daemon_pg_inbox',name:'PG runtime',provider:'codex',workspaceId:'local'});
    const initial=f.store.sendMessage(f.message as any),attempt=f.store.claimTask('rt_pg_inbox')!;f.store.startTask(attempt.id);const offer=f.store.getDaemonTurnBridge().offerInput(f.store.getTaskWithAgent(attempt.id)!);
    const results=await concurrent([{databaseUrl:f.databaseUrl,operation:'send',message:{...f.message,body_md:'interrupt'}},
      {databaseUrl:f.databaseUrl,operation:'complete',scope:{workspaceId:'local',runtimeId:'rt_pg_inbox',daemonId:'daemon_pg_inbox'},complete:{payload:{turn_id:initial.turn_id,attempt_id:attempt.id,input_to_seq:offer.input_to_seq,reply:{body_md:'done',message_kind:'reply'}},completionFields:null}}]);
    expect(results[1].ok).toBe(true);expect(f.store.getMessage(results[0].message.id)?.body_md).toBe('interrupt');expect(f.store.listTurns({workspace_id:'local',session_id:f.session.id}).filter(t=>t.status==='pending')).toHaveLength(1);},30_000);
  it('two repair processes re-ring idempotently',async()=>{const f=setup();const initial=f.store.sendMessage(f.message as any);f.db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[initial.turn_id!]);
    const results=await concurrent([1,2].map(()=>({databaseUrl:f.databaseUrl,operation:'ring',turnId:initial.turn_id})));
    expect(results[0]).toBe(results[1]);expect(f.store.listTurns({workspace_id:'local',session_id:f.session.id}).filter(t=>t.status==='pending')).toHaveLength(1);},30_000);
});
