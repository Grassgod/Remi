import { afterEach, describe, expect, it } from "bun:test";
import { memberRemovedPayload } from "@multiremi/api/wire/workspaces.js";
import type { Context } from "hono";
import { createMultiremiApp } from "@multiremi/api.js";
import { currentWorkspaceMember, currentWorkspaceRoleStrict } from "@multiremi/api/wire/context.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function requestContext(requestUserId: string | null | undefined, userId = requestUserId ?? null): Context {
  return {
    get: (key: string) => key === "multiremiAuth"
      ? { accessToken: null, jwtUserId: null, userId, requestUserId }
      : undefined,
  } as Context;
}

async function login(store: MultiremiStore, name: string) {
  const user = store.getOrCreateUser({ externalId: `ou_${name}`, email: `${name}@example.test`, name });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name, type: "pat", purpose: "session",
  });
  return { user, headers: { Authorization: `Bearer ${token}` } };
}

function seedInbox(store: MultiremiStore, workspaceId: string, memberId: string, body: string) {
  const author = store.createWorkspaceMember({ workspaceId, name: "Notification author" });
  const issue = store.createIssue({ workspaceId, title: "Inbox identity", createdBy: memberId });
  store.createIssueComment(issue.id, { authorType: "member", authorId: author.id, body });
  const item = store.listInboxItems(memberId, workspaceId).find((candidate) => candidate.issueId === issue.id);
  expect(item).toBeDefined();
  return item!;
}

const inboxRoutes = [
  { path: "/api/inbox", memberParameter: "member_id" },
  { path: "/api/multiremi/inbox", memberParameter: "memberId" },
];

async function expectInboxMutationsAllowed(
  app: ReturnType<typeof createMultiremiApp>,
  store: MultiremiStore,
  workspaceId: string,
  memberId: string,
  headers: Record<string, string>,
) {
  for (const route of inboxRoutes) {
    for (const action of ["read", "archive"]) {
      const item = seedInbox(store, workspaceId, memberId, "Own mutable notification");
      expect(store.getInboxItem(item.id)).toMatchObject({ read: false, archived: false });
      const response = await app.request(`${route.path}/${item.id}/${action}`, { method: "POST", headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body.item ?? body).id).toBe(item.id);
      expect(store.getInboxItem(item.id)).toMatchObject({ memberId, read: true, archived: action === "archive" });
    }
  }
}

describe("MUL-288: explicit workspace user identity", () => {
  it.each([
    { idShape: "user-id", linkedToOtherUser: false },
    { idShape: "user-id", linkedToOtherUser: true },
    { idShape: "legacy-member-id", linkedToOtherUser: false },
    { idShape: "legacy-member-id", linkedToOtherUser: true },
  ])("rejects forged membership %j", async ({ idShape, linkedToOtherUser }) => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Workspace A" });
    const outsider = await login(store, "outsider");
    const otherUser = store.getOrCreateUser({ email: "other@example.test", name: "Other user" });
    const forged = store.createWorkspaceMember({
      id: idShape === "user-id" ? outsider.user.id : `mem_${workspace.id}_${outsider.user.id}`,
      workspaceId: workspace.id,
      userId: linkedToOtherUser ? otherUser.id : null,
      name: "Forged owner",
      role: "owner",
    });
    const context = requestContext(outsider.user.id);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    expect(store.getWorkspaceMember(forged.id)?.userId).toBe(linkedToOtherUser ? otherUser.id : null);
    expect(store.findWorkspaceMemberForUser(outsider.user.id, workspace.id)).toBeNull();
    expect(store.getUserRoleInWorkspace(outsider.user.id, workspace.id)).toBeNull();
    expect(currentWorkspaceMember(context, store, workspace.id)).toBeNull();
    expect(currentWorkspaceRoleStrict(context, store, workspace.id)).toBeNull();
    expect((await app.request(`/api/workspaces/${workspace.id}`, { headers: outsider.headers })).status).toBe(404);
    expect((await app.request(`/api/workspaces/${workspace.id}/members`, { headers: outsider.headers })).status).toBe(404);
    expect(store.listWorkspacesForUser(outsider.user.id)).toEqual([]);
    if (linkedToOtherUser) {
      expect(store.findWorkspaceMemberForUser(otherUser.id, workspace.id)?.id).toBe(forged.id);
    }
  });

  it.each([null, undefined, "", "   "])("does not resolve an unbound row for empty identity %j", (userId) => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Unbound members" });
    store.createWorkspaceMember({ workspaceId: workspace.id, name: "Unbound", role: "owner" });
    const context = requestContext(userId, null);

    expect(store.findWorkspaceMemberForUser(userId, workspace.id)).toBeNull();
    expect(store.getUserRoleInWorkspace(userId, workspace.id)).toBeNull();
    expect(currentWorkspaceMember(context, store, workspace.id)).toBeNull();
    expect(currentWorkspaceRoleStrict(context, store, workspace.id)).toBeNull();
    expect(currentWorkspaceRoleStrict(context, store, "local")).toBe("owner");
  });

  it("preserves the unauthenticated local owner fallback without a member row", () => {
    const store = createLocalStore();
    const context = requestContext("unbound-local-owner", null);

    expect(currentWorkspaceMember(context, store, "local")).toBeNull();
    expect(currentWorkspaceRoleStrict(context, store, "local")).toBe("owner");
    expect(currentWorkspaceRoleStrict(requestContext("outsider"), store, "local")).toBeNull();
  });

  it("resolves active user links without treating member row ids as user identities", async () => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Linked members" });
    const account = await login(store, "linked");
    const member = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Linked" });
    const context = requestContext(account.user.id);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    expect(store.findWorkspaceMemberForUser(account.user.id, workspace.id)?.id).toBe(member.id);
    expect(store.findWorkspaceMemberForUser(` ${account.user.id} `, workspace.id)?.id).toBe(member.id);
    expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBe("member");
    expect(currentWorkspaceMember(context, store, workspace.id)?.id).toBe(member.id);
    expect(currentWorkspaceRoleStrict(context, store, workspace.id)).toBe("member");
    expect(store.findWorkspaceMemberForUser(member.id, workspace.id)).toBeNull();
    expect(store.findWorkspaceMemberForUser(account.user.id, "local")).toBeNull();
    expect((await app.request(`/api/workspaces/${workspace.id}`, { headers: account.headers })).status).toBe(200);

    store.archiveWorkspaceMember(member.id);
    expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBeNull();
    expect(currentWorkspaceMember(context, store, workspace.id)).toBeNull();
    expect((await app.request(`/api/workspaces/${workspace.id}`, { headers: account.headers })).status).toBe(404);
  });

  it("resolves a local cleanup member by its explicit user link", () => {
    const store = createLocalStore();
    const owner = store.getOrCreateUser({ email: "owner@example.test", name: "Owner" });
    const workspace = store.createWorkspace({ id: "ws_cleanup", name: "Cleanup" }, owner.id);
    const member = store.createWorkspaceMember({
      id: `mem_${workspace.id}_local_cleanup`, workspaceId: workspace.id, userId: "local", name: "Cleanup owner", role: "owner",
    });

    expect(store.findWorkspaceMemberForUser("local", workspace.id)?.id).toBe(member.id);
    expect(store.getUserRoleInWorkspace("local", workspace.id)).toBe("owner");
    expect(currentWorkspaceMember(requestContext("local"), store, workspace.id)?.id).toBe(member.id);
    expect(store.findWorkspaceMemberForUser(member.id, workspace.id)).toBeNull();
  });

  it.each([false, true])("rejects another inbox whose member row id equals the caller user id (linked=%j)", async (linked) => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Inbox ownership" });
    const account = await login(store, "inbox-caller");
    const ownMember = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Caller" });
    const otherUser = store.getOrCreateUser({ email: "inbox-other@example.test", name: "Other user" });
    const forged = store.createWorkspaceMember({
      id: account.user.id, workspaceId: workspace.id, userId: linked ? otherUser.id : null, name: "Other recipient",
    });
    const privateItem = seedInbox(store, workspace.id, forged.id, "Other recipient's private notification");
    const ownItem = seedInbox(store, workspace.id, ownMember.id, "Caller's own notification");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { ...account.headers, "X-Workspace-ID": workspace.id };

    expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBe("member");
    for (const route of inboxRoutes) {
      const denied = await app.request(`${route.path}?${route.memberParameter}=${forged.id}`, { headers });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: "inbox not found" });

      const own = await app.request(`${route.path}?${route.memberParameter}=${ownMember.id}`, { headers });
      expect(own.status).toBe(200);
      const body = await own.json();
      expect((body.items ?? body).map((item: { id: string }) => item.id)).toEqual([ownItem.id]);
    }
    expect(store.getInboxItem(privateItem.id)).toMatchObject({ read: false, archived: false });
  });

  it.each(inboxRoutes.flatMap((route) => ["read", "archive"].map((action) => ({ path: route.path, action }))))(
    "rejects inbox item mutation through a colliding member row id %j",
    async ({ path, action }) => {
      const store = createLocalStore();
      const workspace = store.createWorkspace({ name: "Inbox item ownership" });
      const account = await login(store, "inbox-item-caller");
      const ownMember = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Caller" });
      const otherUser = store.getOrCreateUser({ email: "inbox-item-other@example.test", name: "Other user" });
      const otherMember = store.createWorkspaceMember({
        id: account.user.id, workspaceId: workspace.id, userId: otherUser.id, name: "Other recipient",
      });
      const privateItem = seedInbox(store, workspace.id, otherMember.id, "Other recipient's immutable notification");
      const ownItem = seedInbox(store, workspace.id, ownMember.id, "Caller's mutable notification");
      const app = createMultiremiApp({ store, authToken: "root-secret" });
      const headers = { ...account.headers, "X-Workspace-ID": workspace.id };

      expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBe("member");
      expect(store.getWorkspaceMember(otherMember.id)?.userId).toBe(otherUser.id);
      expect(store.getInboxItem(privateItem.id)).toMatchObject({ read: false, archived: false });
      const denied = await app.request(`${path}/${privateItem.id}/${action}`, { method: "POST", headers });
      const unchanged = store.getInboxItem(privateItem.id);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: "inbox item not found" });
      expect(unchanged).toEqual(privateItem);
      expect(unchanged).toMatchObject({ read: false, archived: false });

      const own = await app.request(`${path}/${ownItem.id}/${action}`, { method: "POST", headers });
      expect(own.status).toBe(200);
      const body = await own.json();
      expect((body.item ?? body).id).toBe(ownItem.id);
      expect(store.getInboxItem(ownItem.id)).toMatchObject({ read: true, archived: action === "archive" });
    },
  );

  it("resolves the caller's inbox through an explicit user link without a member selector", async () => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Self inbox" });
    const account = await login(store, "inbox-self");
    const member = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Self" });
    const item = seedInbox(store, workspace.id, member.id, "Own inbox notification");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { ...account.headers, "X-Workspace-ID": workspace.id };

    for (const route of inboxRoutes) {
      for (const selector of ["", `?${route.memberParameter}=${account.user.id}`, `?${route.memberParameter}=${member.id}`]) {
        const response = await app.request(`${route.path}${selector}`, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((body.items ?? body).map((entry: { id: string }) => entry.id)).toEqual([item.id]);
      }
    }
    await expectInboxMutationsAllowed(app, store, workspace.id, member.id, headers);
  });

  it.each(["master", "open"])("preserves unbound member inbox access in %s mode", async (mode) => {
    const store = createLocalStore();
    const member = store.createWorkspaceMember({ name: "Unbound inbox recipient" });
    const item = seedInbox(store, "local", member.id, "Unbound member notification");
    const app = createMultiremiApp({ store, authToken: mode === "master" ? "root-secret" : "" });
    const headers: Record<string, string> = mode === "master" ? { Authorization: "Bearer root-secret" } : {};

    for (const route of inboxRoutes) {
      const response = await app.request(`${route.path}?${route.memberParameter}=${member.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body.items ?? body).map((entry: { id: string }) => entry.id)).toEqual([item.id]);
    }
    await expectInboxMutationsAllowed(app, store, "local", member.id, headers);
  });

  it("resolves the authenticated local user's cleanup member inbox", async () => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Local cleanup inbox" });
    const member = store.createWorkspaceMember({
      id: `mem_${workspace.id}_local_cleanup`, workspaceId: workspace.id, userId: "local", name: "Cleanup owner", role: "owner",
    });
    const item = seedInbox(store, workspace.id, member.id, "Local cleanup notification");
    const { token } = await store.createAccessToken({
      workspaceId: "local", userId: "local", name: "Local inbox session", type: "pat", purpose: "session",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${token}`, "X-Workspace-ID": workspace.id };

    for (const route of inboxRoutes) {
      for (const selector of ["", `?${route.memberParameter}=${member.id}`]) {
        const response = await app.request(`${route.path}${selector}`, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((body.items ?? body).map((entry: { id: string }) => entry.id)).toEqual([item.id]);
      }
    }
    await expectInboxMutationsAllowed(app, store, workspace.id, member.id, headers);
  });

  it("rejects read and archive of old inbox items after their member moves workspaces", async () => {
    const store = createLocalStore();
    const oldWorkspace = store.createWorkspace({ name: "Old inbox workspace" });
    const selectedWorkspace = store.createWorkspace({ name: "Selected inbox workspace" });
    const account = await login(store, "moved-inbox-item");
    const member = store.createWorkspaceMember({ workspaceId: oldWorkspace.id, userId: account.user.id, name: "Moved recipient" });
    const oldItem = seedInbox(store, oldWorkspace.id, member.id, "Old workspace notification");
    store.updateWorkspaceMember(member.id, { workspaceId: selectedWorkspace.id });
    store.createWorkspaceMember({ workspaceId: oldWorkspace.id, userId: account.user.id, name: "Retained old membership" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headerVariants: Record<string, string>[] = [
      account.headers,
      { ...account.headers, "X-Workspace-ID": oldWorkspace.id },
      { ...account.headers, "X-Workspace-ID": selectedWorkspace.id },
    ];

    expect(store.getUserRoleInWorkspace(account.user.id, oldWorkspace.id)).toBe("member");
    expect(store.getUserRoleInWorkspace(account.user.id, selectedWorkspace.id)).toBe("member");
    expect(store.getWorkspaceMember(member.id)?.workspaceId).toBe(selectedWorkspace.id);
    for (const route of inboxRoutes) {
      for (const action of ["read", "archive"]) {
        for (const headers of headerVariants) {
          const denied = await app.request(`${route.path}/${oldItem.id}/${action}`, { method: "POST", headers });
          expect(denied.status).toBe(404);
          expect(await denied.json()).toEqual({ error: "inbox item not found" });
          expect(store.getInboxItem(oldItem.id)).toEqual(oldItem);
          expect(store.getInboxItem(oldItem.id)).toMatchObject({ read: false, archived: false });
        }
      }
    }
  });

  it.each([false, true])("keeps member-row subscriptions, participants and inbox delivery (linked=%j)", (linked) => {
    const store = createLocalStore();
    const creatorUser = store.getOrCreateUser({ email: "creator@example.test", name: "Creator" });
    const commenterUser = store.getOrCreateUser({ email: "commenter@example.test", name: "Commenter" });
    const creator = store.createWorkspaceMember({ name: "Creator", userId: linked ? creatorUser.id : null });
    const commenter = store.createWorkspaceMember({ name: "Commenter", userId: linked ? commenterUser.id : null });
    const issue = store.createIssue({ title: "Member row collaborators", createdBy: creator.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comment = store.createIssueComment(issue.id, { authorType: "member", authorId: commenter.id, body: "Subscribe me" });

    expect(store.listIssueSubscribers(issue.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: creator.id, reason: "created" }),
      expect.objectContaining({ memberId: commenter.id, reason: "commented" }),
    ]));
    expect(store.listSessionParticipants(session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantType: "member", participantId: linked ? commenterUser.id : commenter.id }),
    ]));
    expect(store.addSessionParticipant(session.id, { participantType: "member", participantId: creator.id }).participantId)
      .toBe(linked ? creatorUser.id : creator.id);
    expect(store.listInboxItems(creator.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: creator.id, type: "comment_created", body: comment.body }),
    ]));
    const reply = store.createIssueComment(issue.id, { authorType: "member", authorId: creator.id, body: "Notification reply" });
    expect(store.listInboxItems(commenter.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: commenter.id, type: "comment_created", body: reply.body }),
    ]));
  });
});

describe("workspace member response identity", () => {
  it("matches a password owner's member identity to /api/me for permission checks", async () => {
    const store = createStore();
    const email = "member-identity@example.test";
    const password = `test-only-${crypto.randomUUID()}`;
    const { user } = await store.configurePasswordAccount({ email, password });
    const session = await store.loginWithPassword(email, password);
    const app = createMultiremiApp({ store, authToken: "test-member-identity-master" });
    const headers = { Authorization: `Bearer ${session!.token}` };
    const storedMember = store.findWorkspaceMemberForUser(user.id, "local")!;
    expect(storedMember.id).not.toBe(`mem_local_${user.id}`);

    const meResponse = await app.request("/api/me", { headers });
    expect(meResponse.status).toBe(200);
    const me = await meResponse.json();
    expect(me.id).toBe(user.id);
    const membersResponse = await app.request("/api/workspaces/local/members", { headers });
    expect(membersResponse.status).toBe(200);
    const members = await membersResponse.json() as Array<{ id: string; user_id: string; role: string }>;
    expect(members.find((member) => member.user_id === me.id)).toMatchObject({
      id: storedMember.id,
      user_id: user.id,
      role: "owner",
    });
    expect(memberRemovedPayload(storedMember)).toMatchObject({
      member_id: storedMember.id,
      user_id: user.id,
    });
  });

  it("prefers an explicit user link while preserving legacy member identities", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const explicit = store.createWorkspaceMember({
      id: "mem_local_usr_old",
      userId: "usr_current",
      name: "Explicit identity",
    });
    const legacy = store.createWorkspaceMember({ id: "mem_local_usr_legacy", name: "Legacy identity" });
    const unlinked = store.createWorkspaceMember({ id: "mem_unlinked", name: "Unlinked member" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/workspaces/local/members");
    expect(response.status).toBe(200);
    const members = await response.json() as Array<{ id: string; user_id: string }>;
    const identities = new Map(members.map((member) => [member.id, member.user_id]));
    expect(identities.get(explicit.id)).toBe("usr_current");
    expect(identities.get(legacy.id)).toBe("usr_legacy");
    expect(identities.get(unlinked.id)).toBe(unlinked.id);
    expect(identities.get("mem_local_local")).toBe("local");
    expect(memberRemovedPayload(legacy)).toMatchObject({ user_id: "usr_legacy" });
  });
});
