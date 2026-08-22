// The issue domain at store level: assignment, keys, GitHub links, hierarchy,
// dependencies, mentions, notifications/inbox, comment threads and reactions,
// attachments, labels, pinned shortcuts, and search.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — issues, comments, labels, and inbox", () => {
  it("assigns issues to members, agents, and squads", () => {
    const store = createStore();
    const codex = store.createAgent({ name: "Codex", provider: "codex" });
    const leader = store.createAgent({ name: "Squad lead", provider: "claude" });
    const member = store.createWorkspaceMember({ name: "Human reviewer", email: "human@example.com", role: "member" });
    const squad = store.createSquad({ name: "Feature squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Implement assignment" });

    const memberAssigned = store.assignIssue(issue.id, { assigneeType: "member", assigneeId: member.id });
    expect(memberAssigned.issue.assigneeType).toBe("member");
    expect(memberAssigned.task).toBeNull();

    const agentAssigned = store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: codex.id, prompt: "Run codex" });
    expect(agentAssigned.issue.assigneeType).toBe("agent");
    expect(agentAssigned.task?.agentId).toBe(codex.id);
    expect(agentAssigned.task?.prompt).toBe("Run codex");

    const squadAssigned = store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: squad.id });
    expect(squadAssigned.issue.assigneeId).toBe(squad.id);
    expect(squadAssigned.task?.agentId).toBe(leader.id);
    expect(store.getTask(agentAssigned.task!.id)?.status).toBe("cancelled");

    const fuzzyIssue = store.createIssue({ title: "Assign by fuzzy refs", assigneeId: "human@example.com" });
    expect(fuzzyIssue.assigneeType).toBe("member");
    expect(fuzzyIssue.assigneeId).toBe(member.id);
    const fuzzyAgent = store.assignIssue(fuzzyIssue.id, { assigneeId: "cod", prompt: "Run fuzzy Codex" });
    expect(fuzzyAgent.issue.assigneeType).toBe("agent");
    expect(fuzzyAgent.issue.assigneeId).toBe(codex.id);
    expect(fuzzyAgent.task?.agentId).toBe(codex.id);
    const fuzzySquad = store.assignIssue(fuzzyIssue.id, { assigneeId: "feature" });
    expect(fuzzySquad.issue.assigneeType).toBe("squad");
    expect(fuzzySquad.issue.assigneeId).toBe(squad.id);
    expect(fuzzySquad.task?.agentId).toBe(leader.id);
    const quick = store.quickCreateIssue({ agentId: "codex", prompt: "Fuzzy quick create" });
    expect(quick.issue.assigneeId).toBe(codex.id);
    expect(quick.task.agentId).toBe(codex.id);

    const unassigned = store.assignIssue(issue.id, {});
    expect(unassigned.issue.assigneeType).toBeNull();
    expect(unassigned.task).toBeNull();
    expect(store.getTask(squadAssigned.task!.id)?.status).toBe("cancelled");
  });

  it("tells the creator agent whether to keep or infer the issue project", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "PM", provider: "codex" });
    const project = store.createProject({ title: "Web" });

    const targeted = store.quickCreateIssue({
      agentId: agent.id,
      projectId: project.id,
      prompt: "Fix the upload flow",
    });
    expect(targeted.issue.projectId).toBe(project.id);
    expect(targeted.task.prompt).toContain(`explicitly selected project ${project.id}`);
    expect(targeted.task.prompt).toContain("do not infer or move it to another project");

    const inferred = store.quickCreateIssue({
      agentId: agent.id,
      prompt: "Investigate the mobile crash",
    });
    expect(inferred.issue.projectId).toBeNull();
    expect(inferred.task.prompt).toContain("did not select a project");
    expect(inferred.task.prompt).toContain("choose the best match");
    expect(inferred.task.prompt).toContain("do not create a new project");
  });

  it("aggregates assignee frequency from created issues and assignment activity", () => {
    const store = createStore();
    const alice = store.createWorkspaceMember({ name: "Alice", role: "member" });
    const bob = store.createWorkspaceMember({ name: "Bob", role: "member" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const created = store.createIssue({
      title: "Created with assignee",
      createdBy: alice.id,
      assigneeType: "member",
      assigneeId: bob.id,
    });
    const reassigned = store.createIssue({ title: "Reassigned later", createdBy: alice.id });

    store.assignIssue(reassigned.id, {
      assignee_type: "member",
      assignee_id: bob.id,
      actorType: "member",
      actorId: alice.id,
    });
    store.assignIssue(created.id, {
      assigneeType: "agent",
      assigneeId: agent.id,
      actor_type: "member",
      actor_id: alice.id,
    });

    const frequency = store.listAssigneeFrequency({ memberId: alice.id });

    expect(frequency.find((entry) => entry.assigneeId === bob.id)).toMatchObject({
      assigneeType: "member",
      assignee_type: "member",
      assigneeId: bob.id,
      assignee_id: bob.id,
      frequency: 2,
    });
    expect(frequency.find((entry) => entry.assigneeId === agent.id)?.frequency).toBe(2);
  });

  it("assigns human-readable issue keys per workspace", () => {
    const store = createStore();
    const first = store.createIssue({ title: "First issue" });
    const second = store.createIssue({ title: "Second issue" });
    const legacyOpen = store.createIssue({ title: "Legacy open input", status: "open" });

    expect(first.key).toBe("MUL-1");
    expect(first.number).toBe(1);
    expect(second.key).toBe("MUL-2");
    expect(first.status).toBe("todo");
    expect(legacyOpen.status).toBe("todo");
  });

  it("manages issue hierarchy, priority, scheduling, and planning fields", () => {
    const store = createStore();
    const project = store.createProject({ title: "Hierarchy project" });
    const parent = store.createIssue({
      title: "Parent issue",
      projectId: project.id,
      priority: "high",
      dueDate: "2026-06-10T12:00:00+08:00",
      acceptanceCriteria: ["parent done"],
      contextRefs: [{ type: "doc", url: "https://example.com/spec" }],
    });
    const child = store.createIssue({
      title: "Child issue",
      parent_issue_id: parent.id,
      position: 2.5,
      start_date: "2026-06-04T09:00:00+08:00",
    });

    expect(parent.priority).toBe("high");
    expect(parent.dueDate).toBe("2026-06-10T04:00:00.000Z");
    expect(parent.acceptanceCriteria).toEqual(["parent done"]);
    expect(parent.contextRefs[0]).toEqual({ type: "doc", url: "https://example.com/spec" });
    expect(child.parentIssueId).toBe(parent.id);
    expect(child.projectId).toBe(project.id);
    expect(child.position).toBe(2.5);
    expect(store.listChildIssues(parent.id).map((item) => item.id)).toEqual([child.id]);
    expect(store.getIssueWithTasks(parent.id)?.children[0]?.id).toBe(child.id);

    store.updateIssue(child.id, { status: "done" });
    expect(store.getChildIssueProgress(parent.id)).toEqual({ parentIssueId: parent.id, total: 1, done: 1 });
    expect(store.listChildIssueProgress("local")).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);

    const sibling = store.createIssue({ title: "Sibling", parentIssueId: parent.id, priority: "urgent", position: 1 });
    expect(store.listChildIssues(parent.id).map((item) => item.id)).toEqual([sibling.id, child.id]);

    expect(() => store.updateIssue(parent.id, { parentIssueId: child.id })).toThrow("Circular parent");
    expect(() => store.updateIssue(parent.id, { parentIssueId: parent.id })).toThrow("own parent");
    expect(() => store.createIssue({ title: "Bad priority", priority: "must" })).toThrow("priority");

    const remoteParent = store.createIssue({ title: "Remote parent", workspaceId: "remote" });
    expect(() => store.createIssue({ title: "Cross workspace", parentIssueId: remoteParent.id, workspaceId: "local" })).toThrow("another workspace");
  });

  it("posts Go-style system comments when child issues transition to done", () => {
    const store = createStore();
    const parent = store.createIssue({ title: "Child-done parent", status: "in_progress" });
    const child = store.createIssue({
      title: "Child with [@spoof](mention://agent/agt_spoof)",
      parentIssueId: parent.id,
      status: "in_progress",
    });

    store.updateIssue(child.id, { status: "done" });
    let comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.type).toBe("system");
    expect(comments[0]?.authorId).toBe("00000000-0000-0000-0000-000000000000");
    expect(comments[0]?.parentId).toBeNull();
    expect(comments[0]?.body).toContain(child.key);
    expect(comments[0]?.body).toContain(`mention://issue/${child.id}`);
    expect(comments[0]?.body).not.toContain("mention://agent/agt_spoof");
    expect(comments[0]?.body).not.toContain("mention://member/");
    expect(comments[0]?.body).not.toContain("mention://squad/");

    store.updateIssue(child.id, { status: "done" });
    comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(1);

    store.updateIssue(child.id, { status: "in_progress" });
    store.updateIssue(child.id, { status: "done" });
    comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(2);

    const doneParent = store.createIssue({ title: "Already done parent", status: "done" });
    const doneChild = store.createIssue({ title: "Done child", parentIssueId: doneParent.id, status: "in_progress" });
    store.updateIssue(doneChild.id, { status: "done" });
    expect(store.listIssueComments(doneParent.id).filter((comment) => comment.authorType === "system")).toHaveLength(0);
  });

  it("triggers parent assignee tasks for child-done system comments", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Parent] Agent", provider: "codex" });
    const parent = store.createIssue({
      title: "Agent parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Agent child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    store.updateIssue(child.id, { status: "done" });
    const comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`mention://agent/${agent.id}`);
    expect(comments[0]?.body).toContain("@Parent Agent");
    const tasks = store.listTasksForIssue(parent.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agentId).toBe(agent.id);
    expect(tasks[0]?.triggerCommentId).toBe(comments[0]?.id);
    expect(tasks[0]?.prompt).toContain("A sub-issue assigned under this issue was marked done.");

    const member = store.createWorkspaceMember({ name: "Human parent", role: "member" });
    const memberParent = store.createIssue({
      title: "Member parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });
    const memberChild = store.createIssue({ title: "Member child", parentIssueId: memberParent.id, status: "in_progress" });
    store.updateIssue(memberChild.id, { status: "done" });
    expect(store.listIssueComments(memberParent.id).filter((comment) => comment.authorType === "system")).toHaveLength(0);

    const leader = store.createAgent({ name: "Squad leader", provider: "claude" });
    const squad = store.createSquad({ name: "Parent Squad", leaderId: leader.id });
    const squadParent = store.createIssue({
      title: "Squad parent",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const squadChild = store.createIssue({ title: "Squad child", parentIssueId: squadParent.id, status: "in_progress" });
    store.updateIssue(squadChild.id, { status: "done" });
    const squadComments = store.listIssueComments(squadParent.id).filter((comment) => comment.authorType === "system");
    expect(squadComments).toHaveLength(1);
    expect(squadComments[0]?.body).toContain(`mention://squad/${squad.id}`);
    expect(store.listTasksForIssue(squadParent.id).map((task) => task.agentId)).toEqual([leader.id]);

    const guardedParent = store.createIssue({
      title: "Same squad parent",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const guardedChild = store.createIssue({
      title: "Same squad child",
      parentIssueId: guardedParent.id,
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    store.updateIssue(guardedChild.id, { status: "done" });
    expect(store.listIssueComments(guardedParent.id).filter((comment) => comment.authorType === "system")).toHaveLength(1);
    expect(store.listTasksForIssue(guardedParent.id)).toHaveLength(0);
  });

  it("manages issue dependencies with workspace and duplicate guards", () => {
    const store = createStore();
    const blocker = store.createIssue({ title: "Blocker" });
    const blocked = store.createIssue({ title: "Blocked" });

    const dependency = store.createIssueDependency(blocked.id, {
      depends_on_issue_id: blocker.id,
      type: "blocked_by",
    });
    expect(dependency.issueId).toBe(blocked.id);
    expect(dependency.dependsOnIssueId).toBe(blocker.id);
    expect(dependency.type).toBe("blocked_by");
    expect(dependency.issue?.title).toBe("Blocked");
    expect(dependency.dependsOnIssue?.title).toBe("Blocker");
    expect(store.listIssueDependencies(blocked.id)).toHaveLength(1);
    expect(store.listIssueDependencies(blocker.id)).toHaveLength(1);

    const duplicate = store.createIssueDependency(blocked.id, {
      dependsOnIssueId: blocker.id,
      type: "blocked_by",
    });
    expect(duplicate.id).toBe(dependency.id);
    expect(store.listIssueDependencies(blocked.id)).toHaveLength(1);

    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: blocked.id })).toThrow("itself");
    const remote = store.createIssue({ title: "Remote", workspaceId: "remote" });
    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: remote.id })).toThrow("within a workspace");
    expect(() => store.createIssueDependency(blocked.id, { dependsOnIssueId: blocker.id, type: "must" })).toThrow("dependency type");

    store.deleteIssueDependency(blocked.id, dependency.id);
    expect(store.listIssueDependencies(blocked.id)).toEqual([]);
  });

  it("queues comment mentions without changing issue assignee", () => {
    const store = createStore();
    const reviewer = store.createAgent({ name: "Review Bot", provider: "codex" });
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Frontend Squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Mention routing" });

    store.createIssueComment(issue.id, {
      body: `Please inspect this [@Review Bot](mention://agent/${reviewer.id}) and @Frontend Squad`,
    });

    const tasks = store.listTasks();
    expect(tasks.map((task) => task.agentId).sort()).toEqual([leader.id, reviewer.id].sort());
    expect(store.getIssue(issue.id)?.assigneeId).toBeNull();
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(store.listIssueActivity(issue.id).filter((item) => item.type === "comment_mention_triggered")).toHaveLength(2);
  });

  it("routes un-mentioned human comments to the issue's assigned agent or squad leader", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Ops Squad", leaderId: leader.id });
    const issue = store.createIssue({ title: "Auto respond", assigneeType: "squad", assigneeId: squad.id, status: "backlog" });

    const comment = store.createIssueComment(issue.id, { body: "How is this going?" });

    const tasks = store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agentId).toBe(leader.id);
    expect(tasks[0]?.triggerCommentId).toBe(comment.id);
    const activity = store.listIssueActivity(issue.id).filter((item) => item.type === "comment_assignee_triggered");
    expect(activity).toHaveLength(1);

    // Each human comment dispatches individually — no batching.
    store.createIssueComment(issue.id, { body: "One more thing." });
    expect(store.listTasks()).toHaveLength(2);
  });

  it("suppresses assignee auto-response when the comment addresses someone explicitly", () => {
    const store = createStore();
    const assignee = store.createAgent({ name: "Assignee Bot", provider: "claude" });
    const other = store.createAgent({ name: "Other Bot", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Human Reviewer" });
    const issue = store.createIssue({ title: "Explicit wins", assigneeType: "agent", assigneeId: assignee.id, status: "backlog" });

    // @another agent → only the mention dispatch, no auto-response for the assignee.
    store.createIssueComment(issue.id, { body: `Take a look [@Other Bot](mention://agent/${other.id})` });
    expect(store.listTasks().map((task) => task.agentId)).toEqual([other.id]);

    // @a human member → addressed to a person, agent stays quiet.
    store.createIssueComment(issue.id, { body: `Your call [@Human Reviewer](mention://member/${member.id})` });
    expect(store.listTasks()).toHaveLength(1);

    // Agent-authored comment without mentions → never auto-triggers (no loops).
    store.createIssueComment(issue.id, { authorType: "agent", authorId: assignee.id, body: "Done, see above." });
    expect(store.listTasks()).toHaveLength(1);
  });

  it("skips assignee auto-response for unassigned or member-assigned issues", () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ name: "Human Owner" });
    const unassigned = store.createIssue({ title: "Nobody yet" });
    store.createIssueComment(unassigned.id, { body: "Thoughts?" });

    const humanOwned = store.createIssue({ title: "Human owned", assigneeType: "member", assigneeId: member.id });
    store.createIssueComment(humanOwned.id, { body: "Ping" });

    expect(store.listTasks()).toHaveLength(0);
  });

  it("notifies subscribed members through inbox items", () => {
    const store = createStore();
    const alice = store.createWorkspaceMember({ name: "Alice Reviewer" });
    const bob = store.createWorkspaceMember({ name: "Bob Approver" });
    const carol = store.createWorkspaceMember({ name: "Carol Owner" });
    const issue = store.createIssue({ title: "Notify people", createdBy: alice.id });

    expect(store.listIssueSubscribers(issue.id).map((subscriber) => subscriber.memberId)).toEqual([alice.id]);

    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: bob.id });
    expect(store.listInboxItems(bob.id).some((item) => item.type === "issue_assigned")).toBe(true);

    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: carol.id,
      body: `Please review [@Bob Approver](mention://member/${bob.id}) and @Alice Reviewer`,
    });

    expect(store.listIssueSubscribers(issue.id).map((subscriber) => subscriber.memberId).sort()).toEqual([
      alice.id,
      bob.id,
      carol.id,
    ].sort());
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "comment_mention")).toHaveLength(1);
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "comment_created")).toHaveLength(0);
    expect(store.listInboxItems(alice.id).some((item) => item.type === "comment_mention")).toBe(true);

    const item = store.listInboxItems(bob.id)[0]!;
    expect(store.markInboxItemRead(item.id).read).toBe(true);
    expect(store.archiveInboxItem(item.id).archived).toBe(true);
    expect(store.listInboxItems(bob.id).some((inboxItem) => inboxItem.id === item.id)).toBe(false);
  });

  it("honors notification preferences when creating inbox items", () => {
    const store = createStore();
    const bob = store.createWorkspaceMember({ name: "Bob Approver" });
    const issue = store.createIssue({ title: "Quiet assignment" });

    store.updateNotificationPreferences({
      preferences: { assignments: "muted" },
    });
    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: bob.id });

    expect(store.getNotificationPreferences().preferences.assignments).toBe("muted");
    expect(store.listInboxItems(bob.id).filter((item) => item.type === "issue_assigned")).toHaveLength(0);
  });

  it("tracks comment threads, reactions, and attachments", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Collaborate with context" });
    const issueAttachment = store.createAttachment({
      issueId: issue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "spec.md",
      url: "https://example.com/spec.md",
      contentType: "text/markdown",
      sizeBytes: 42,
    });
    const root = store.createIssueComment(issue.id, { body: "Root question" });
    const replyAttachment = store.createAttachment({
      uploaderType: "member",
      uploaderId: "local",
      filename: "reply.txt",
      url: "https://example.com/reply.txt",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const reply = store.createIssueComment(issue.id, {
      body: "Thread reply",
      parentId: root.id,
      attachmentIds: [replyAttachment.id],
    });

    expect(reply.parentId).toBe(root.id);
    expect(store.listAttachmentsForIssue(issue.id)[0]?.id).toBe(issueAttachment.id);
    expect(store.listAttachmentsForComment(reply.id)[0]?.id).toBe(replyAttachment.id);

    expect(store.addIssueReaction(issue.id, { actorType: "member", actorId: "local", emoji: "👍" }).emoji).toBe("👍");
    store.addIssueReaction(issue.id, { actorType: "member", actorId: "local", emoji: "👍" });
    expect(store.listIssueReactions(issue.id)).toHaveLength(1);

    expect(store.addCommentReaction(reply.id, { actorType: "agent", actorId: "agt-test", emoji: "👀" }).emoji).toBe("👀");
    expect(store.getIssueWithTasks(issue.id)?.reactions).toHaveLength(1);
    expect(store.listIssueComments(issue.id).find((comment) => comment.id === reply.id)?.attachments).toHaveLength(1);
    expect(store.listIssueComments(issue.id).find((comment) => comment.id === reply.id)?.reactions).toHaveLength(1);
  });

  it("serves Go-style issue comment list windows and cursors", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Long discussion" });
    const base = Date.parse("2025-01-01T00:00:00.000Z");
    const stamp = (id: string, minutes: number) => {
      const at = new Date(base + minutes * 60_000).toISOString();
      (store as any).db.run("UPDATE multiremi_issue_comments SET created_at = ?, updated_at = ? WHERE id = ?", [at, at, id]);
      return at;
    };
    const root1 = store.createIssueComment(issue.id, { body: "x".repeat(500) });
    const r1a = store.createIssueComment(issue.id, { body: "r1a", parentId: root1.id });
    const r1b = store.createIssueComment(issue.id, { body: "r1b", parentId: root1.id });
    const r1b1 = store.createIssueComment(issue.id, { body: "r1b1", parentId: r1b.id });
    const root2 = store.createIssueComment(issue.id, { body: "root2" });
    const r2a = store.createIssueComment(issue.id, { body: "r2a", parentId: root2.id });
    const r2b = store.createIssueComment(issue.id, { body: "r2b", parentId: root2.id });
    stamp(root1.id, 0);
    stamp(r1a.id, 1);
    stamp(r1b.id, 2);
    stamp(r1b1.id, 3);
    stamp(root2.id, 10);
    stamp(r2a.id, 11);
    stamp(r2b.id, 12);

    const ids = (rows: any[]) => rows.map((comment) => comment.id);
    const getComments = async (query: string) => {
      const response = await app.request(`/api/issues/${issue.id}/comments${query ? `?${query}` : ""}`);
      return { response, rows: await response.json() as any[] };
    };

    const roots = await getComments("roots_only=true&summary=true");
    expect(ids(roots.rows)).toEqual([root1.id, root2.id]);
    expect(roots.rows[0].reply_count).toBe(3);
    expect(roots.rows[0].last_activity_at).toBe("2025-01-01T00:03:00.000Z");
    expect(roots.rows[0].content_truncated).toBe(true);
    expect(roots.rows[0].content.endsWith("…")).toBe(true);
    expect(roots.rows[0].body).toBeUndefined();
    expect(roots.rows[0].parentId).toBeUndefined();

    const nestedThread = await getComments(`thread=${encodeURIComponent(r1b1.id)}`);
    expect(ids(nestedThread.rows)).toEqual([root1.id, r1a.id, r1b.id, r1b1.id]);

    const recent = await getComments("recent=1");
    expect(ids(recent.rows)).toEqual([root2.id, r2a.id, r2b.id]);
    expect(recent.response.headers.get("X-Multiremi-Next-Before-Id")).toBe(root2.id);
    expect(recent.response.headers.get("X-Multimira-Next-Before-Id")).toBeNull();
    const nextThread = new URLSearchParams({
      recent: "1",
      before: recent.response.headers.get("X-Multiremi-Next-Before")!,
      before_id: recent.response.headers.get("X-Multiremi-Next-Before-Id")!,
    });
    const olderThread = await getComments(nextThread.toString());
    expect(ids(olderThread.rows)).toEqual([root1.id, r1a.id, r1b.id, r1b1.id]);

    const tail = await getComments(`thread=${encodeURIComponent(root1.id)}&tail=1`);
    expect(ids(tail.rows)).toEqual([root1.id, r1b1.id]);
    expect(tail.response.headers.get("X-Multiremi-Next-Before-Id")).toBe(r1b1.id);
    expect(tail.response.headers.get("X-Multimira-Next-Before-Id")).toBeNull();
    const nextReply = new URLSearchParams({
      thread: root1.id,
      tail: "1",
      before: tail.response.headers.get("X-Multiremi-Next-Before")!,
      before_id: tail.response.headers.get("X-Multiremi-Next-Before-Id")!,
    });
    const olderReply = await getComments(nextReply.toString());
    expect(ids(olderReply.rows)).toEqual([root1.id, r1b.id]);

    const invalid = await app.request(`/api/issues/${issue.id}/comments?roots_only=true&thread=${root1.id}`);
    expect(invalid.status).toBe(400);
  });

  it("updates, deletes, resolves, and reopens comment threads", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Comment lifecycle" });
    const root = store.createIssueComment(issue.id, { body: "Root thread" });
    const reply = store.createIssueComment(issue.id, { body: "Reply", parentId: root.id });

    const updated = store.updateIssueComment(reply.id, { content: "Edited reply" });
    expect(updated.body).toBe("Edited reply");
    expect(store.listIssueActivity(issue.id).some((item) => item.type === "comment_updated")).toBe(true);

    const resolved = store.resolveIssueComment(root.id, { actorType: "member", actorId: "local" });
    expect(resolved.resolvedAt).toBeString();
    expect(resolved.resolvedByType).toBe("member");
    expect(() => store.resolveIssueComment(reply.id)).toThrow("Only root comments");

    const reopenedReply = store.createIssueComment(issue.id, { body: "Reopen thread", parentId: root.id });
    expect(reopenedReply.parentId).toBe(root.id);
    expect(store.getIssueComment(root.id)?.resolvedAt).toBeNull();

    const resolvedAgain = store.resolveIssueComment(root.id);
    expect(resolvedAgain.resolvedAt).toBeString();
    expect(store.unresolveIssueComment(root.id).resolvedAt).toBeNull();

    store.deleteIssueComment(root.id);
    expect(store.getIssueComment(root.id)).toBeNull();
    expect(store.getIssueComment(reply.id)).toBeNull();
    expect(store.getIssueComment(reopenedReply.id)).toBeNull();
    expect(store.listIssueActivity(issue.id).some((item) => item.type === "comment_deleted")).toBe(true);
  });

  it("manages issue labels with workspace scoping", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Needs labels", workspaceId: "local" });
    const label = store.createLabel({ name: "Bug", color: "FF3333", workspaceId: "local" });

    expect(label.color).toBe("#ff3333");
    expect(store.listLabels("local").map((item) => item.name)).toEqual(["Bug"]);
    expect(() => store.createLabel({ name: "bug", color: "#00ff00", workspaceId: "local" })).toThrow("Label already exists");
    expect(() => store.createLabel({ name: "bad-color", color: "red", workspaceId: "local" })).toThrow("6-digit hex");

    expect(store.attachLabelToIssue(issue.id, label.id).map((item) => item.id)).toEqual([label.id]);
    store.attachLabelToIssue(issue.id, label.id);
    expect(store.listLabelsForIssue(issue.id)).toHaveLength(1);
    expect(store.getIssue(issue.id)?.labels[0]?.name).toBe("Bug");
    expect(store.listIssues()[0]?.labels[0]?.color).toBe("#ff3333");

    const updated = store.updateLabel(label.id, { name: "Regression", color: "#22AA66" });
    expect(updated.color).toBe("#22aa66");
    expect(store.getIssueWithTasks(issue.id)?.labels[0]?.name).toBe("Regression");

    const otherWorkspaceLabel = store.createLabel({ name: "Remote", color: "#111111", workspaceId: "remote" });
    expect(() => store.attachLabelToIssue(issue.id, otherWorkspaceLabel.id)).toThrow("another workspace");

    expect(store.detachLabelFromIssue(issue.id, label.id)).toEqual([]);
    store.deleteLabel(label.id);
    expect(store.listLabelsForIssue(issue.id)).toEqual([]);
  });

  it("manages pinned issue and project shortcuts", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Pinned issue", workspaceId: "local" });
    const project = store.createProject({ title: "Pinned project", workspaceId: "local" });

    const issuePin = store.createPinnedItem({ itemType: "issue", itemId: issue.id, workspaceId: "local", userId: "local" });
    const projectPin = store.createPinnedItem({ item_type: "project", item_id: project.id, workspace_id: "local", user_id: "local" });

    expect(issuePin.position).toBe(1);
    expect(projectPin.position).toBe(2);
    expect(store.listPinnedItems("local", "local").map((pin) => pin.itemType)).toEqual(["issue", "project"]);
    expect(() => store.createPinnedItem({ itemType: "issue", itemId: issue.id })).toThrow("already pinned");
    expect(() => store.createPinnedItem({ itemType: "issue", itemId: issue.id, workspaceId: "remote" })).toThrow("Issue not found");
    expect(() => store.createPinnedItem({ itemType: "agent", itemId: issue.id })).toThrow("item_type");

    const reordered = store.reorderPinnedItems("local", "local", [
      { id: issuePin.id, position: 20 },
      { id: projectPin.id, position: 10 },
    ]);
    expect(reordered.map((pin) => pin.id)).toEqual([projectPin.id, issuePin.id]);

    store.deletePinnedItem("local", "local", "project", project.id);
    expect(store.listPinnedItems("local", "local").map((pin) => pin.id)).toEqual([issuePin.id]);
  });

  it("searches issues and projects with ranking and snippets", () => {
    const store = createStore();
    store.createIssue({ title: "Alpha title", description: "No special details", workspaceId: "local" });
    const descIssue = store.createIssue({ title: "Other title", description: "Contains needle phrase inside a longer issue description", workspaceId: "local" });
    store.updateIssue(descIssue.id, { status: "done" });
    store.createProject({ title: "Project Alpha", description: "No details", workspaceId: "local" });
    store.createProject({ title: "Project Other", description: "Contains project needle phrase", workspaceId: "local" });

    const issues = store.searchIssues({ q: "alpha", workspaceId: "local" });
    expect(issues.total).toBe(1);
    expect(issues.issues[0]?.matchSource).toBe("title");

    const withoutClosed = store.searchIssues({ q: "needle", workspaceId: "local" });
    expect(withoutClosed.total).toBe(0);
    const withClosed = store.searchIssues({ q: "needle", workspaceId: "local", includeClosed: true });
    expect(withClosed.issues[0]?.matchSource).toBe("description");
    expect(withClosed.issues[0]?.matchedDescriptionSnippet).toContain("needle");

    const commentIssue = store.createIssue({ title: "Comment search", description: "No comment target here", workspaceId: "local" });
    store.createIssueComment(commentIssue.id, { body: "Fresh discussion needle in a comment" });
    const commentMatch = store.searchIssues({ q: "discussion needle", workspaceId: "local" });
    expect(commentMatch.issues[0]?.id).toBe(commentIssue.id);
    expect(commentMatch.issues[0]?.matchSource).toBe("comment");
    expect(commentMatch.issues[0]?.matchedSnippet).toContain("needle");
    expect(commentMatch.issues[0]?.matchedCommentSnippet).toContain("needle");

    const projects = store.searchProjects({ q: "needle", workspaceId: "local" });
    expect(projects.projects[0]?.matchSource).toBe("description");
    expect(projects.projects[0]?.matchedSnippet).toContain("needle");
  });

  it("skips agent self-mentions", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Loop Guard", provider: "codex" });
    const issue = store.createIssue({ title: "No recursion" });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: `I already handled this [@Loop Guard](mention://agent/${agent.id})`,
    });

    expect(store.listTasks()).toHaveLength(0);
  });

  it("skips archived agents when resolving squad autopilots", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "codex" });
    const backup = store.createAgent({ name: "Backup", provider: "codex" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [leader.id, backup.id] });
    const autopilot = store.createAutopilot({
      title: "Resolve squad",
      assigneeType: "squad",
      assigneeId: squad.id,
      issueTitleTemplate: "Use active member",
    });

    store.archiveAgent(leader.id);
    const run = store.runAutopilot(autopilot.id);
    expect(run.status).toBe("running");
    expect(store.getTask(run.taskId!)?.agentId).toBe(backup.id);

    store.archiveAgent(backup.id);
    const skipped = store.runAutopilot(autopilot.id);
    expect(skipped.status).toBe("skipped");
    expect(skipped.failureReason).toBe("No runnable agent");
    expect(() => store.addSquadMember(squad.id, { memberType: "agent", memberId: backup.id })).toThrow("Agent is archived");
  });
});
