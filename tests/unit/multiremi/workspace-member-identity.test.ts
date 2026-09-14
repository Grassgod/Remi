import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { createMultiremiApp } from "@multiremi/api.js";
import { currentWorkspaceMember, currentWorkspaceRoleStrict } from "@multiremi/api/wire/context.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

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
