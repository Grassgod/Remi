import { createResponsibleTestIssue } from './helpers.js';
import { describe, expect, it } from 'bun:test';
import { PostgresSyncDatabase } from '@multiremi/store/db/postgres.js';
import { conversationLogPgAdminUrl, withConversationLogStore } from './fixtures/conversation-log-store.js';

describe('Canonical mention and delegation inputs',()=>{
  for(const backend of ['sqlite','pg'] as const){
    it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)(`${backend}: mention dispatch and projection roll back with their caller`,async()=>{
      await withConversationLogStore(backend,(store,db)=>{
        const leader=store.createAgent({name:'Leader',provider:'codex'});
        const worker=store.createAgent({name:'Worker',provider:'codex'});
        const issue=createResponsibleTestIssue(store, {title:'Canonical dispatch',assigneeType:'agent',assigneeId:leader.id});
        const session=store.getOrCreateDefaultIssueSession(issue.id);
        const parent=store.createSessionTask(session.id,{agentId:leader.id,prompt:'Coordinate'});
        const runtime=store.registerRuntime({id:'rt_rules',name:'Rules',provider:'codex',workspaceId:'local'});
        expect(store.claimTask(runtime.id)?.id).toBe(parent.id);store.startTask(parent.id);
        const before=store.listConversationLogEntries(session.id);
        const queued:string[]=[];const unsubscribe=store.onTaskEnqueued(task=>queued.push(task.id));
        if(db instanceof PostgresSyncDatabase)db.resetTransactionDepthStats();
        const rollback=new Error('rollback dispatch');
        try{
          expect(()=>(store as unknown as {db:typeof db}).db.transaction(()=>{
            const comment=store.createIssueComment(issue.id,{authorType:'agent',authorId:leader.id,taskId:parent.id,body:`[@Worker](mention://agent/${worker.id}) Review`});
            const child=store.listTasksForIssue(issue.id).find(task=>task.agentId===worker.id)!;
            expect(store.getMessage(comment.id)?.task_id).toBe(parent.turn_id);
            expect(child.triggerCommentId).toBe(comment.id);
            expect(store.getMessage(comment.id)?.to_agent_id).toBe(worker.id);
            const input=store.buildTaskSessionProjection(child.id)!;
            expect(input.toSeq).toBeGreaterThanOrEqual(store.getMessage(comment.id)!.seq);
            expect(db.inTransaction).toBe(true);
            throw rollback;
          })()).toThrow('rollback dispatch');
          expect(store.listConversationLogEntries(session.id)).toEqual(before);
          expect(store.listTasksForIssue(issue.id).map(task=>task.id)).toEqual([parent.id]);
          expect(queued).toEqual([]);
          expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_session_events').get()?.n)).toBe(0);
          if(db instanceof PostgresSyncDatabase)expect(db.maxTransactionDepth).toBe(1);
        }finally{unsubscribe();}
      });
    },60_000);
  }
});
