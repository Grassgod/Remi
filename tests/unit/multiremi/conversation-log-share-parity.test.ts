import { describe, expect, it } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { signIssueShareId } from '@multiremi/api/helpers/issue-share-tokens.js';
import { conversationLogPgAdminUrl, withConversationLogStore } from './fixtures/conversation-log-store.js';

describe('Canonical shared conversation bundle',()=>{
  for(const backend of ['sqlite','pg'] as const){
    it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)(`${backend}: shares current comments, tombstones and projected turns without legacy writes`,async()=>{
      await withConversationLogStore(backend,async(store,db)=>{
        const agent=store.createAgent({name:'Shared author',provider:'codex'});
        const issue=store.createIssue({title:'Shared canonical history'});
        const session=store.getOrCreateDefaultIssueSession(issue.id);
        const edited=store.createIssueComment(issue.id,{body:'Original'});
        store.updateIssueComment(edited.id,{body:'Current shared wording'});
        const deleted=store.createIssueComment(issue.id,{body:'Deleted shared wording'});store.deleteIssueComment(deleted.id);
        const task=store.createSessionTask(session.id,{agentId:agent.id,prompt:'Reply'});
        const runtime=store.registerRuntime({id:'rt_share',name:'Share',provider:'codex',workspaceId:'local'});
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);store.startTask(task.id);store.completeTask(task.id,{output:'Shared final reply'});
        const secret='synthetic-share-secret';const share=store.ensureIssueShare(issue.id,'local','local');
        const token=signIssueShareId(share.id,secret);
        const app=createMultiremiApp({store,authToken:'synthetic-share-auth',shareSecret:secret});
        const response=await app.request(`/api/shares/${token}`,{headers:{'X-Remi-Share':token}});
        expect(response.status).toBe(200);
        const bundle=await response.json() as {sessions:Array<{id:string;events:Array<{id:string;kind:string;body:string;metadata:Record<string,unknown>}>}>};
        const events=bundle.sessions.find(s=>s.id===session.id)!.events;
        expect(store.getMessage(edited.id)?.body_md).toBe('Current shared wording');
        expect(events.some(e=>e.kind==='message_edited'&&e.body==='Current shared wording')).toBe(true);
        expect(store.getMessage(deleted.id)?.deleted_at).toBeTruthy();
        expect(events.some(e=>e.body==='Shared final reply')).toBe(true);
        expect(events.filter(e=>e.kind==='turn')).toHaveLength(1);
        expect(events.some(e=>e.kind==='message_deleted')).toBe(true);
        expect(db.query('SELECT COUNT(*) AS n FROM multiremi_session_events').get()?.n).toBe(0);
        expect(db.query('SELECT COUNT(*) AS n FROM multiremi_issue_comments').get()?.n).toBe(0);
      });
    },60_000);
  }
});
