import {describe,expect,it,spyOn} from 'bun:test';
import {createResponsibleTestIssue,seedHistoricalIssueFacts} from './helpers.js';
import {conversationLogPgAdminUrl,withConversationLogStore,useMigratedConversationLogStores} from './fixtures/conversation-log-store.js';
import type {StoreContext,WorkspaceEvent} from '@multiremi/store/context.js';
import type {MultiremiStore} from '@multiremi/store.js';

useMigratedConversationLogStores();

// D18: a child status notice reaches the direct parent's execution owner. An
// unresolved ancestor above that parent neither skips nor reroutes the notice.
for(const backend of ['sqlite','pg'] as const)describe(`Parent notices above an unresolved ancestor (${backend})`,()=>{
  function family(store:MultiremiStore,parentStatus:'in_review'|'in_progress'='in_review'){
    const owner=store.createAgent({name:'Notice parent owner',provider:'codex'});
    const parent=createResponsibleTestIssue(store,{title:'Notice parent',status:parentStatus,assigneeType:'agent',assigneeId:owner.id});
    const child=createResponsibleTestIssue(store,{title:'Historical closed child',parentIssueId:parent.id,status:'cancelled'});
    seedHistoricalIssueFacts(store,child.id,{status:'done'});
    return {owner,parent,child};
  }
  for(const ancestor of ['foreign','deleted'] as const)it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)(
    `notifies the parent's execution owner despite a ${ancestor} ancestor and leaves that ancestor untouched`,async()=>{
      await withConversationLogStore(backend,(store,db)=>{
        const foreign=store.createWorkspace({name:'Notice foreign',slug:`notice-${backend}-${ancestor}`});
        const grandparent=createResponsibleTestIssue(store,{title:'Notice ancestor',status:'in_review',
          workspaceId:ancestor==='foreign'?foreign.id:'local'});
        const {owner,parent,child}=family(store);
        db.run('UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?',[grandparent.id,parent.id]);
        if(ancestor==='deleted')db.run('DELETE FROM multiremi_issues WHERE id=?',[grandparent.id]);
        expect(store.resolveIssueResponsibility(child.id)).toMatchObject({executionOwner:null,
          chain:[{issueId:child.id,executionOwner:null},{issueId:parent.id,executionOwner:{id:owner.id}}]});
        const before=store.listIssueActivity(grandparent.id);
        const agent=store.createAgent({name:'Notice current executor',provider:'codex'});
        const assigned=store.assignIssue(child.id,{assigneeType:'agent',assigneeId:agent.id});
        expect(assigned.task?.id).toBeDefined();
        expect(store.getIssue(child.id)?.status).toBe('todo');
        expect(store.getIssue(parent.id)?.status).toBe('in_progress');
        // The parent_owner role writes the notice into the parent's Main session.
        const notices=store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)
          .filter(message=>message.message_kind==='status'&&message.metadata.child_issue_id===child.id);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({to_agent_id:owner.id,to_member_id:null,metadata:{child_status:'todo'}});
        expect(notices[0]!.metadata).not.toHaveProperty('responsibility_unresolved');
        expect(store.listIssueActivity(parent.id).filter(entry=>entry.type==='child_done_parent_skipped')).toEqual([]);
        expect(store.listIssueActivity(grandparent.id)).toEqual(before);
      });
    },30_000);
  it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)('addresses no one, without a guessed person, when the parent has no execution owner',async()=>{
    await withConversationLogStore(backend,(store)=>{
      const parent=createResponsibleTestIssue(store,{title:'Unassigned notice parent',status:'in_review'});
      const child=createResponsibleTestIssue(store,{title:'Historical closed child',parentIssueId:parent.id,status:'cancelled'});
      seedHistoricalIssueFacts(store,child.id,{status:'done'});
      const agent=store.createAgent({name:'Notice current executor',provider:'codex'});
      store.assignIssue(child.id,{assigneeType:'agent',assigneeId:agent.id});
      const notice=store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)
        .find(message=>message.message_kind==='status'&&message.metadata.child_issue_id===child.id)!;
      expect(notice).toMatchObject({to_agent_id:null,to_member_id:null,wake_reason:'no_recipient'});
      expect(notice.metadata.responsibility_unresolved).toEqual([{issueId:parent.id,reason:'execution_owner_missing'}]);
      expect(store.getIssue(parent.id)?.status).toBe('in_progress');
      expect(store.listTasksForIssue(parent.id)).toEqual([]);
    });
  },30_000);
  it.skipIf(backend==='pg'&&!conversationLogPgAdminUrl)('rolls the notice, parent re-derivation, assignment and queue back together',async()=>{
    await withConversationLogStore(backend,(store,db)=>{
      const {parent,child}=family(store);
      db.run("UPDATE multiremi_issues SET parent_issue_id='iss_deleted_notice_ancestor' WHERE id=?",[parent.id]);
      const before={child:store.getIssue(child.id),parent:store.getIssue(parent.id),activity:store.listIssueActivity(parent.id),
        tasks:store.listTasksForIssue(parent.id),notices:store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)};
      const ctx=(store as unknown as {ctx:StoreContext}).ctx,append=ctx.appendIssueActivity.bind(ctx);
      const fault=spyOn(ctx,'appendIssueActivity').mockImplementation((...args)=>{
        append(...args);
        if(args[0]===parent.id&&args[1].type==='parent_status_derived')throw new Error('notice rollback');
      });
      const agent=store.createAgent({name:'Notice rollback executor',provider:'codex'});
      const received:WorkspaceEvent[]=[];
      const stop=store.onWorkspaceEvent(event=>received.push(event));
      try{expect(()=>store.assignIssue(child.id,{assigneeType:'agent',assigneeId:agent.id})).toThrow('notice rollback');}
      finally{fault.mockRestore();stop();}
      expect({child:store.getIssue(child.id),parent:store.getIssue(parent.id),activity:store.listIssueActivity(parent.id),
        tasks:store.listTasksForIssue(parent.id),notices:store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)}).toEqual(before);
      expect(store.listTasksForIssue(child.id)).toEqual([]);
      expect(received).toEqual([]);
    });
  },30_000);
});
