// Pinned shortcuts, issue/project search, issue subscribers and the member inbox.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — pins, search, and inbox", () => {
  it("serves pinned item endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Pinned API issue", workspaceId: "local" });
    const project = store.createProject({ title: "Pinned API project", workspaceId: "local" });

    const issuePin = await app.request("/api/multiremi/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemType: "issue", itemId: issue.id, workspaceId: "local", userId: "local" }),
    });
    expect(issuePin.status).toBe(201);
    const issuePinBody = await issuePin.json();
    expect(issuePinBody.pin.itemType).toBe("issue");

    const projectPin = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_type: "project", item_id: project.id, workspace_id: "local", user_id: "local" }),
    });
    expect(projectPin.status).toBe(201);
    const projectPinBody = await projectPin.json();
    expect(projectPinBody).toMatchObject({
      item_type: "project",
      item_id: project.id,
      workspace_id: "local",
      user_id: "local",
      position: 2,
    });
    expect(projectPinBody.itemType).toBeUndefined();

    const camelPin = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemType: "project", itemId: project.id, workspaceId: "local", userId: "local" }),
    });
    expect(camelPin.status).toBe(400);
    expect(await camelPin.json()).toEqual({ error: "item_type must be 'issue' or 'project'" });

    const listed = await app.request("/api/multiremi/pins?workspaceId=local&userId=local");
    expect((await listed.json()).pins).toHaveLength(2);

    const compatibilityList = await app.request("/api/pins?workspace_id=local&user_id=local");
    const compatibilityListBody = await compatibilityList.json();
    expect(compatibilityListBody).toHaveLength(2);
    expect(compatibilityListBody[0].workspaceId).toBeUndefined();

    const reordered = await app.request("/api/pins/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        user_id: "local",
        items: [
          { id: issuePinBody.pin.id, position: 2 },
          { id: projectPinBody.id, position: 1 },
        ],
      }),
    });
    expect((await reordered.json()).map((pin: any) => pin.id)).toEqual([projectPinBody.id, issuePinBody.pin.id]);

    const deleted = await app.request(`/api/pins/project/${project.id}?workspace_id=local&user_id=local`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(store.listPinnedItems("local", "local")).toHaveLength(1);
  });

  it("serves issue and project search endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Searchable API issue", description: "Has api needle context", workspaceId: "local" });
    const closedIssue = store.createIssue({ title: "Closed API issue", description: "closed needle", workspaceId: "local" });
    store.updateIssue(closedIssue.id, { status: "done" });
    const commentedIssue = store.createIssue({ title: "Comment API issue", description: "No matching body", workspaceId: "local", createdBy: "api-user" });
    store.createIssueComment(commentedIssue.id, { authorType: "member", body: "Fresh comment needle context" });
    const remoteIssue = store.createIssue({ title: "Remote Issue Needle", description: "Remote issue needle", workspaceId: "remote" });
    store.createProject({ title: "Searchable API project", description: "No needle", workspaceId: "local" });
    store.createProject({ title: "Other project", description: "Project needle context", workspaceId: "local" });
    const closedProject = store.createProject({ title: "Closed Project", description: "Closed project needle", status: "cancelled", workspaceId: "local" });
    const remoteProject = store.createProject({ title: "Remote Project Needle", description: "Remote project needle", workspaceId: "remote" });

    const byTitle = await app.request("/api/multiremi/issues/search?q=searchable%20api&workspaceId=local");
    expect(byTitle.status).toBe(200);
    const byTitleBody = await byTitle.json();
    expect(byTitleBody.issues[0].id).toBe(issue.id);
    expect(byTitleBody.issues[0].matchSource).toBe("title");

    const invalidIssueSearch = await app.request("/api/issues/search?workspace_id=local");
    expect(invalidIssueSearch.status).toBe(400);
    expect(await invalidIssueSearch.json()).toEqual({ error: "q parameter is required" });

    const compatIssueSearch = await app.request("/api/issues/search?q=comment%20needle&workspace_id=local&include_closed=true&limit=1");
    const compatIssueBody = await compatIssueSearch.json();
    expect(compatIssueBody.issues).toHaveLength(1);
    expect(compatIssueSearch.headers.get("X-Total-Count")).toBe(String(compatIssueBody.total));
    expect(compatIssueBody.total).toBe(1);
    expect(compatIssueBody.issues[0]).toMatchObject({
      id: commentedIssue.id,
      workspace_id: "local",
      identifier: commentedIssue.key,
      creator_type: "member",
      creator_id: "api-user",
      match_source: "comment",
    });
    expect(compatIssueBody.issues[0].matched_snippet).toContain("needle");
    expect(compatIssueBody.issues[0].matched_comment_snippet).toContain("needle");
    expect(compatIssueBody.issues[0].workspaceId).toBeUndefined();
    expect(compatIssueBody.issues[0].matchSource).toBeUndefined();
    expect(compatIssueBody.issues[0].matchedCommentSnippet).toBeUndefined();

    const camelClosedIssueSearch = await app.request("/api/issues/search?q=closed%20needle&workspace_id=local&includeClosed=true");
    expect((await camelClosedIssueSearch.json()).total).toBe(0);
    const snakeClosedIssueSearch = await app.request("/api/issues/search?q=closed%20needle&workspace_id=local&include_closed=true");
    const snakeClosedIssueBody = await snakeClosedIssueSearch.json();
    expect(snakeClosedIssueBody.issues[0].id).toBe(closedIssue.id);

    const camelRemoteIssueSearch = await app.request("/api/issues/search?q=remote%20issue%20needle&workspaceId=remote");
    expect((await camelRemoteIssueSearch.json()).total).toBe(0);
    const snakeRemoteIssueSearch = await app.request("/api/issues/search?q=remote%20issue%20needle&workspace_id=remote");
    const snakeRemoteIssueBody = await snakeRemoteIssueSearch.json();
    expect(snakeRemoteIssueBody.issues[0].id).toBe(remoteIssue.id);

    const invalidProjectSearch = await app.request("/api/projects/search?workspace_id=local");
    expect(invalidProjectSearch.status).toBe(400);
    expect(await invalidProjectSearch.json()).toEqual({ error: "q parameter is required" });

    const projectSearch = await app.request("/api/projects/search?q=project%20needle&workspace_id=local");
    const projectBody = await projectSearch.json();
    expect(projectSearch.headers.get("X-Total-Count")).toBe(String(projectBody.total));
    expect(projectBody.projects[0].match_source).toBe("description");
    expect(projectBody.projects[0].matched_snippet).toContain("needle");
    expect(projectBody.projects[0].workspace_id).toBe("local");
    expect(projectBody.projects[0].matchSource).toBeUndefined();
    expect(projectBody.projects[0].matchedSnippet).toBeUndefined();

    const camelClosedProjectSearch = await app.request("/api/projects/search?q=closed%20project%20needle&workspace_id=local&includeClosed=true");
    expect((await camelClosedProjectSearch.json()).total).toBe(0);
    const snakeClosedProjectSearch = await app.request("/api/projects/search?q=closed%20project%20needle&workspace_id=local&include_closed=true");
    const snakeClosedProjectBody = await snakeClosedProjectSearch.json();
    expect(snakeClosedProjectBody.projects[0].id).toBe(closedProject.id);

    const camelRemoteProjectSearch = await app.request("/api/projects/search?q=remote%20project%20needle&workspaceId=remote");
    expect((await camelRemoteProjectSearch.json()).total).toBe(0);
    const snakeRemoteProjectSearch = await app.request("/api/projects/search?q=remote%20project%20needle&workspace_id=remote");
    const snakeRemoteProjectBody = await snakeRemoteProjectSearch.json();
    expect(snakeRemoteProjectBody.projects[0].id).toBe(remoteProject.id);
  });

  it("serves issue subscribers and member inbox endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorType?: string; actorId?: string | null }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const alice = store.createWorkspaceMember({ name: "Alice API" });
    const bob = store.createWorkspaceMember({ name: "Bob API" });
    const issue = store.createIssue({ title: "Inbox API", createdBy: alice.id });

    const subscribed = await app.request(`/api/multiremi/issues/${issue.id}/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: bob.id, reason: "manual" }),
    });
    expect(subscribed.status).toBe(201);
    expect((await subscribed.json()).subscriber.memberId).toBe(bob.id);

    const subscribers = await app.request(`/api/multiremi/issues/${issue.id}/subscribers`);
    expect((await subscribers.json()).subscribers.map((subscriber: any) => subscriber.memberId).sort()).toEqual([
      alice.id,
      bob.id,
    ].sort());
    const compatibilitySubscribers = await app.request(`/api/issues/${issue.id}/subscribers`);
    const compatibilitySubscribersBody = await compatibilitySubscribers.json();
    expect(compatibilitySubscribersBody.map((subscriber: any) => subscriber.user_id).sort()).toEqual([
      alice.id,
      bob.id,
    ].sort());
    expect(compatibilitySubscribersBody[0].memberId).toBeUndefined();
    expect(compatibilitySubscribersBody[0]).toMatchObject({
      issue_id: issue.id,
      user_type: "member",
    });

    const charlie = store.createWorkspaceMember({ name: "Charlie API" });
    const camelSubscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: charlie.id, userType: "member" }),
    });
    expect(camelSubscribe.status).toBe(403);
    expect(await camelSubscribe.json()).toEqual({ error: "target user is not a member of this workspace" });
    const afterCamelSubscribe = await (await app.request(`/api/issues/${issue.id}/subscribers`)).json();
    expect(afterCamelSubscribe.some((subscriber: any) =>
      subscriber.user_id === charlie.id && subscriber.user_type === "member"
    )).toBe(false);

    const goSubscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: charlie.id, user_type: "member" }),
    });
    expect(await goSubscribe.json()).toEqual({ subscribed: true });
    const goSubscribers = await (await app.request(`/api/issues/${issue.id}/subscribers`)).json();
    expect(goSubscribers.some((subscriber: any) => subscriber.user_id === charlie.id && subscriber.user_type === "member")).toBe(true);
    expect(events.some((event) =>
      event.type === "subscriber:added"
      && event.payload.issue_id === issue.id
      && event.payload.user_type === "member"
      && event.payload.user_id === charlie.id
    )).toBe(true);

    const runtime = store.registerRuntime({ id: "rt_subscriber_agent", provider: "codex", name: "Subscriber agent runtime" });
    const agent = store.createAgent({ name: "Subscriber Agent", provider: "codex", runtimeId: runtime.id });
    const agentSubscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: agent.id, user_type: "agent" }),
    });
    expect(agentSubscribe.status).toBe(200);
    expect(await agentSubscribe.json()).toEqual({ subscribed: true });
    const typedSubscribers = await (await app.request(`/api/issues/${issue.id}/subscribers`)).json();
    const agentSubscriber = typedSubscribers.find((subscriber: any) => subscriber.user_id === agent.id);
    expect(agentSubscriber).toMatchObject({
      issue_id: issue.id,
      user_type: "agent",
      user_id: agent.id,
      reason: "manual",
    });
    expect(agentSubscriber.memberId).toBeUndefined();
    expect(store.listIssueSubscribers(issue.id).find((subscriber) => subscriber.userId === agent.id)?.userType).toBe("agent");

    const unsupportedSubscriber = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "agt_missing_subscriber", user_type: "agent" }),
    });
    expect(unsupportedSubscriber.status).toBe(403);
    expect(await unsupportedSubscriber.json()).toEqual({ error: "target user is not a member of this workspace" });
    const unsupportedSquadSubscriber = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "sqd_subscriber", user_type: "squad" }),
    });
    expect(unsupportedSquadSubscriber.status).toBe(403);
    expect(await unsupportedSquadSubscriber.json()).toEqual({ error: "target user is not a member of this workspace" });
    const goAgentUnsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: agent.id, user_type: "agent" }),
    });
    expect(await goAgentUnsubscribe.json()).toEqual({ subscribed: false });
    expect((await (await app.request(`/api/issues/${issue.id}/subscribers`)).json()).some((subscriber: any) =>
      subscriber.user_id === agent.id && subscriber.user_type === "agent"
    )).toBe(false);
    expect(events.some((event) =>
      event.type === "subscriber:removed"
      && event.payload.issue_id === issue.id
      && event.payload.user_type === "agent"
      && event.payload.user_id === agent.id
    )).toBe(true);
    const goUnsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: charlie.id, user_type: "member" }),
    });
    expect(await goUnsubscribe.json()).toEqual({ subscribed: false });

    const commented = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorType: "member", authorId: alice.id, body: "Can you check this?" }),
    });
    expect(commented.status).toBe(201);

    const inbox = await app.request(`/api/multiremi/inbox?memberId=${encodeURIComponent(bob.id)}`);
    const inboxBody = await inbox.json();
    expect(inboxBody.unread).toBe(1);
    expect(inboxBody.items[0].issue.key).toBe(issue.key);

    const read = await app.request(`/api/multiremi/inbox/${inboxBody.items[0].id}/read`, { method: "POST" });
    expect((await read.json()).item.read).toBe(true);

    const archived = await app.request(`/api/multiremi/inbox/${inboxBody.items[0].id}/archive`, { method: "POST" });
    expect((await archived.json()).item.archived).toBe(true);

    const afterArchive = await app.request(`/api/multiremi/inbox?memberId=${encodeURIComponent(bob.id)}`);
    expect((await afterArchive.json()).items).toHaveLength(0);
  });

  // Regression (MUL-38): the web client authenticates as a USER id, but inbox
  // rows are keyed by member-table ids. The compat routes must resolve the
  // user id to the member id — querying with the raw user id used to return a
  // permanently empty inbox while notifications piled up.
  it("resolves a user id to the member id on the compat inbox routes", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const reviewer = store.createWorkspaceMember({ name: "Reviewer", userId: "user-rev" });
    const author = store.createWorkspaceMember({ name: "Author", userId: "user-author" });
    const issue = store.createIssue({ title: "Inbox identity", createdBy: reviewer.id });
    store.createIssueComment(issue.id, { authorType: "member", authorId: author.id, body: "ping subscribers" });

    // Sanity: the notification row exists under the member id.
    const byMemberId = await app.request(`/api/inbox?member_id=${encodeURIComponent(reviewer.id)}`);
    expect(await byMemberId.json()).toHaveLength(1);

    // A user id must find the same rows instead of silently matching nothing.
    const byUserId = await app.request("/api/inbox?member_id=user-rev");
    const items = await byUserId.json();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("comment_created");

    const count = await app.request("/api/inbox/unread-count?member_id=user-rev");
    expect((await count.json()).count).toBe(1);

    const markAll = await app.request("/api/inbox/mark-all-read?member_id=user-rev", { method: "POST" });
    expect((await markAll.json()).count).toBe(1);
    const afterRead = await app.request("/api/inbox/unread-count?member_id=user-rev");
    expect((await afterRead.json()).count).toBe(0);
  });

  it("paginates the compat inbox and returns grouped counts without loading every item", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const reviewer = store.createWorkspaceMember({ name: "Paged Reviewer", userId: "user-page" });
    const author = store.createWorkspaceMember({ name: "Paged Author", userId: "user-page-author" });
    for (const title of ["First page issue", "Second page issue", "Third page issue"]) {
      const issue = store.createIssue({ title, createdBy: reviewer.id });
      store.createIssueComment(issue.id, {
        authorType: "member",
        authorId: author.id,
        body: `Notification for ${title}`,
      });
    }

    const firstResponse = await app.request("/api/inbox/page?member_id=user-page&limit=2");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.items).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBeTruthy();
    expect(first.items.every((item: any) => item.issue?.title)).toBe(true);

    const secondResponse = await app.request(
      `/api/inbox/page?member_id=user-page&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
    );
    const second = await secondResponse.json();
    expect(second.items).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(3);

    const summaryResponse = await app.request("/api/inbox/summary?member_id=user-page&timezone_offset=-480");
    expect(summaryResponse.status).toBe(200);
    expect(await summaryResponse.json()).toEqual({ unread: 3, attention: 0 });
  });
});
