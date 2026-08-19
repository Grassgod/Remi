import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("Multiremi API - issue sharing", () => {
  it("grants a signed, revocable, issue-only read view to a logged-in non-member", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      shareSecret: "test-share-secret",
    });
    const owner = await store.createAccessToken({
      name: "Owner session",
      workspaceId: "local",
      userId: "local",
      type: "pat",
      purpose: "session",
      expiresInDays: 30,
    });
    const viewerUser = store.getOrCreateUser({
      externalId: "ou_share_viewer",
      email: "viewer@feishu.local",
      name: "Viewer",
    });
    const viewer = await store.createAccessToken({
      name: "Viewer session",
      workspaceId: "local",
      userId: viewerUser.id,
      type: "pat",
      purpose: "session",
      expiresInDays: 30,
    });
    const project = store.createProject({
      title: "Internal delivery project",
      workspaceId: "local",
      instructions: "INTERNAL_AGENT_RULE_DO_NOT_SHARE",
    });
    const issue = store.createIssue({
      title: "Shared launch plan",
      description: "Everything visible on the issue page",
      workspaceId: "local",
      projectId: project.id,
      createdBy: "local",
    });
    const otherIssue = store.createIssue({
      title: "Unrelated confidential issue",
      workspaceId: "local",
      createdBy: "local",
    });
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "local",
      body: "A visible comment",
    });
    const session = store.createIssueSession(issue.id, {
      title: "Delivery",
      createdByType: "member",
      createdById: "local",
    });
    store.appendSessionEvent(session.id, {
      authorType: "member",
      authorId: "local",
      kind: "message",
      body: "A visible session event",
    });
    const agent = store.createAgent({ name: "Delivery Agent", provider: "claude", workspaceId: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      workspaceId: "local",
      prompt: "Deliver the plan",
    });
    store.appendTaskMessages(task.id, [{ type: "assistant", content: "A visible task message" }]);
    store.publishSessionResult(session.id, {
      title: "Release result",
      body: "A visible published result",
      publishedByType: "member",
      publishedById: "local",
    });
    const attachment = store.createAttachment({
      workspaceId: "local",
      issueId: issue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "plan.txt",
      url: "https://example.com/plan.txt",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const unrelatedAttachment = store.createAttachment({
      workspaceId: "local",
      issueId: otherIssue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "secret.txt",
      url: "https://example.com/secret.txt",
      contentType: "text/plain",
      sizeBytes: 18,
    });

    expect((await app.request(`/api/issues/${issue.id}`, bearer(viewer.token))).status).toBe(404);

    const created = await app.request(`/api/issues/${issue.id}/share`, {
      method: "POST",
      ...bearer(owner.token),
    });
    expect(created.status).toBe(201);
    const { share } = await created.json();
    expect(share.token).toStartWith("shr_");
    const durationDays = (Date.parse(share.expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(durationDays).toBeGreaterThan(59.9);
    expect(durationDays).toBeLessThanOrEqual(60);

    const repeated = await app.request(`/api/issues/${issue.id}/share`, {
      method: "POST",
      ...bearer(owner.token),
    });
    expect((await repeated.json()).share.token).toBe(share.token);

    const viewed = await app.request(
      `/api/shares/${encodeURIComponent(share.token)}`,
      bearer(viewer.token),
    );
    expect(viewed.status).toBe(200);
    const bundle = await viewed.json();
    expect(bundle.issue).toMatchObject({
      id: issue.id,
      title: "Shared launch plan",
      description: "Everything visible on the issue page",
    });
    expect(bundle.project).toMatchObject({
      id: project.id,
      title: "Internal delivery project",
    });
    expect(bundle.project).not.toHaveProperty("instructions");
    expect(bundle.project).not.toHaveProperty("instructions_revision");
    expect(bundle.timeline.some((entry: { content?: string }) => entry.content === "A visible comment")).toBe(true);
    expect(bundle.sessions.some((item: { events: Array<{ body?: string }> }) => (
      item.events.some((event) => event.body === "A visible session event")
    ))).toBe(true);
    expect(JSON.stringify(bundle.sessions)).toContain("A visible task message");
    expect(bundle.session_results[0].body).toBe("A visible published result");
    expect(bundle.issue.attachments[0].url).toContain(`/api/shares/${encodeURIComponent(share.token)}/attachments/${attachment.id}/content`);
    expect(JSON.stringify(bundle)).not.toContain(otherIssue.title);
    expect(JSON.stringify(bundle)).not.toContain("viewer@feishu.local");
    expect(JSON.stringify(bundle)).not.toContain("INTERNAL_AGENT_RULE_DO_NOT_SHARE");

    const unrelatedFile = await app.request(
      `/api/shares/${encodeURIComponent(share.token)}/attachments/${unrelatedAttachment.id}/content`,
      bearer(viewer.token),
    );
    expect(unrelatedFile.status).toBe(404);

    const tampered = share.token.slice(0, -1) + (share.token.endsWith("a") ? "b" : "a");
    expect((await app.request(`/api/shares/${encodeURIComponent(tampered)}`, bearer(viewer.token))).status).toBe(404);

    const viewerRevoke = await app.request(`/api/issues/${issue.id}/share`, {
      method: "DELETE",
      ...bearer(viewer.token),
    });
    expect(viewerRevoke.status).toBe(404);

    const revoked = await app.request(`/api/issues/${issue.id}/share`, {
      method: "DELETE",
      ...bearer(owner.token),
    });
    expect(revoked.status).toBe(204);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}`, bearer(viewer.token))).status).toBe(404);
  });

  it("requires a logged-in user even when the share token is valid", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      shareSecret: "test-share-secret",
    });
    const issue = store.createIssue({ title: "Login gate", workspaceId: "local", createdBy: "local" });
    const owner = await store.createAccessToken({
      name: "Owner session",
      workspaceId: "local",
      userId: "local",
      type: "pat",
      purpose: "session",
    });
    const created = await app.request(`/api/issues/${issue.id}/share`, {
      method: "POST",
      ...bearer(owner.token),
    });
    const { share } = await created.json();
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}`)).status).toBe(401);
    expect((await app.request(
      `/api/shares/${encodeURIComponent(share.token)}`,
      bearer("root-secret"),
    )).status).toBe(401);
  });
});
