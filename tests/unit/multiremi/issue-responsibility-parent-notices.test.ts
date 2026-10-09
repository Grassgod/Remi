import {describe,expect,it,spyOn} from 'bun:test';
import {createResponsibleTestIssue,seedHistoricalIssueFacts} from './helpers.js';
import {conversationLogPgAdminUrl,withConversationLogStore} from './fixtures/conversation-log-store.js';
import type {StoreContext,WorkspaceEvent} from '@multiremi/store/context.js';

for(const backend of ['sqlite','pg'] as const)describe(`Unresolved parent notices (${backend})`,()=>{
  for(const ancestor of ['foreign','deleted'] as const)it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)(
    `audits a ${ancestor} ancestor without routing or mutating its history`,async()=>{
      await withConversationLogStore(backend,(store,db)=>{
        const foreign=store.createWorkspace({name:'Notice foreign',slug:`notice-${backend}-${ancestor}`});
        const grandparent=createResponsibleTestIssue(store,{title:'Notice ancestor',status:'in_review',
          workspaceId:ancestor==='foreign'?foreign.id:'local'});
        const parent=createResponsibleTestIssue(store,{title:'Notice parent',status:'in_review'});
        const child=createResponsibleTestIssue(store,{title:'Historical closed child',parentIssueId:parent.id,status:'cancelled'});
        seedHistoricalIssueFacts(store,child.id,{status:'done'});
        const memberId=store.resolveIssueResponsibility(parent.id).rootHuman!.id;
        const session=store.getOrCreateDefaultIssueSession(parent.id);
        const parentMessages=store.listMessages(session.id),inbox=store.listInboxItems(memberId);
        db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?',[grandparent.id,parent.id]);
        if(ancestor==='deleted')db.run('DELETE FROM multiremi_issues WHERE id=?',[grandparent.id]);
        const before=store.listIssueActivity(grandparent.id);
        const agent=store.createAgent({name:'Notice current executor',provider:'codex'});
        const assigned=store.assignIssue(child.id,{assigneeType:'agent',assigneeId:agent.id});
        expect(assigned.task?.id).toBeDefined();
        expect(store.getIssue(child.id)?.status).toBe('todo');
        expect(store.getIssue(parent.id)?.status).toBe('in_progress');
        expect(store.listTasksForIssue(parent.id)).toEqual([]);
        expect(store.listMessages(session.id)).toEqual(parentMessages);
        expect(store.listInboxItems(memberId)).toEqual(inbox);
        expect(store.listIssueActivity(grandparent.id)).toEqual(before);
        expect(store.listIssueActivity(parent.id)).toContainEqual(expect.objectContaining({
          type:'child_done_parent_skipped',data:expect.objectContaining({reason:'responsibility_unresolved',child_issue_id:child.id,child_status:'todo'})}));
        expect(()=>store.submitIssueDelivery(child.id,{summary:'Cannot accept an unknown chain'},
          {type:'agent',id:agent.id,taskId:assigned.task!.id})).toThrow('Configure the Issue responsibility chain before delivery');
      });
    },30_000);
  it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)('rolls the notice audit, assignment and queue back together',async()=>{
    await withConversationLogStore(backend,(store,db)=>{
      const parent=createResponsibleTestIssue(store,{title:'Missing notice ancestor',status:'in_review'});
      const child=createResponsibleTestIssue(store,{title:'Historical closed child',parentIssueId:parent.id,status:'cancelled'});
      seedHistoricalIssueFacts(store,child.id,{status:'done'});
      db.run("UPDATE multiremi_issues SET parent_issue_id='iss_deleted_notice_ancestor' WHERE id=?",[parent.id]);
      const before={child:store.getIssue(child.id),parent:store.getIssue(parent.id),activity:store.listIssueActivity(parent.id)};
      const ctx=(store as unknown as {ctx:StoreContext}).ctx,append=ctx.appendIssueActivity.bind(ctx);
      const fault=spyOn(ctx,'appendIssueActivity').mockImplementation((...args)=>{
        append(...args);
        if(args[1].type==='child_done_parent_skipped')throw new Error('notice audit rollback');
      });
      const agent=store.createAgent({name:'Notice rollback executor',provider:'codex'});
      const received:WorkspaceEvent[]=[];
      const stop=store.onWorkspaceEvent(event=>received.push(event));
      try{expect(()=>store.assignIssue(child.id,{assigneeType:'agent',assigneeId:agent.id})).toThrow('notice audit rollback');}
      finally{fault.mockRestore();stop();}
      expect({child:store.getIssue(child.id),parent:store.getIssue(parent.id),activity:store.listIssueActivity(parent.id)}).toEqual(before);
      expect(store.listTasksForIssue(child.id)).toEqual([]);
      expect(store.listTasksForIssue(parent.id)).toEqual([]);
      expect(received).toEqual([]);
    });
  },30_000);
});
