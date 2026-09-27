import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("Multiremi API - issue sharing", () => {
  it("hard-denies task credentials from minting, reading, extending, or revoking share capabilities", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Share task agent", provider: "codex", workspaceId: "local" });
    const taskIssue = store.createIssue({ title: "Task source", workspaceId: "local", createdBy: "local" });
    const siblingIssue = store.createIssue({ title: "Sibling target", workspaceId: "local", createdBy: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: taskIssue.id,
      workspaceId: "local",
      prompt: "Do not mint shares",
    });
    const taskCredential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret", shareSecret: "test-share-secret" });

    for (const [method, suffix] of [
      ["GET", ""],
      ["POST", ""],
      ["POST", "/extend"],
      ["DELETE", ""],
    ] as const) {
      const response = await app.request(`/api/issues/${siblingIssue.id}/share${suffix}`, {
        method,
        ...bearer(taskCredential.token),
      });
      expect(response.status, `${method} ${suffix || "/"}`).toBe(403);
      expect(await response.json()).toEqual({
        error: "forbidden for task token",
        code: "task_token_hard_denied",
      });
    }
    expect(store.getActiveIssueShare(siblingIssue.id)).toBeNull();
  });

  it("grants a signed, revocable, issue-only read view to a logged-in non-member", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const traceStore = new InMemoryTraceStore();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      shareSecret: "test-share-secret",
      daemonTraceReader: new InMemoryDaemonTraceReader(() => traceStore),
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
    const runtime = store.registerRuntime({
      id: "rt_shared_workspace",
      name: "claude",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-shared-workspace",
      runtimeMode: "local",
      deviceInfo: "share-host · macOS (arm64)",
    });
    store.updateDaemonDisplayName("local", "daemon-shared-workspace", "Shared Mac", "local");
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
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
    const agent = store.createAgent({ name: "Delivery Agent", provider: "claude", workspaceId: "local", visibility: "private", ownerId: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      workspaceId: "local",
      prompt: "Deliver the plan",
    });
    store.appendTaskMessages(task.id, [{ type: "assistant", content: "A visible task message" }]);
    traceStore.append(task.id, [{ type: "text", content: "A visible task message" }]);
    store.markTaskTraceDaemon(task.id, runtime.id);
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
    expect(bundle.sessions[0].tasks[0]).not.toHaveProperty("messages");
    expect(JSON.stringify(bundle)).not.toContain("A visible task message");
    const tracePath = `/api/shares/${encodeURIComponent(share.token)}/tasks/${task.id}/trace`;
    const sharedTrace = await app.request(tracePath, bearer(viewer.token));
    expect(sharedTrace.status).toBe(200);
    expect(await sharedTrace.json()).toMatchObject({ state: "ok", source: "daemon", events: [{ content: "A visible task message" }] });
    traceStore.append(task.id, [
      { type: "text", content: "a".repeat(600_000) },
      { type: "text", content: "b".repeat(600_000) },
    ]);
    for (const [path, credential] of [
      [tracePath, viewer.token],
      [`/api/tasks/${task.id}/trace`, owner.token],
    ]) {
      const response = await app.request(path, bearer(credential));
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(1024 * 1024 + 512);
    }
    // The share deliberately preserves today's private-agent bypass.
    expect((await app.request(`/api/tasks/${task.id}/trace`, bearer(viewer.token))).status).toBe(404);
    expect((await app.request(tracePath)).status).toBe(401);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/tsk_unknown/trace`, bearer(viewer.token))).status).toBe(404);
    const foreignTask = store.createTask({ agentId: agent.id, issueId: otherIssue.id, workspaceId: "local", prompt: "foreign" });
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${foreignTask.id}/trace`, bearer(viewer.token))).status).toBe(404);
    const unscopedTask = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "unscoped" });
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${unscopedTask.id}/trace`, bearer(viewer.token))).status).toBe(200);
    db!.run("UPDATE multiremi_tasks SET chat_session_id = 'chat_share_excluded' WHERE id = ?", [unscopedTask.id]);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${unscopedTask.id}/trace`, bearer(viewer.token))).status).toBe(404);
    const foreignSession = store.createIssueSession(otherIssue.id, { title: "Foreign session" });
    const wrongSessionTask = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "wrong session" });
    db!.run("UPDATE multiremi_tasks SET issue_session_id = ? WHERE id = ?", [foreignSession.id, wrongSessionTask.id]);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${wrongSessionTask.id}/trace`, bearer(viewer.token))).status).toBe(404);
    const shareId = store.getActiveIssueShare(issue.id)!.id;
    db!.run("UPDATE multiremi_issue_shares SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", shareId]);
    expect((await app.request(tracePath, bearer(viewer.token))).status).toBe(404);
    db!.run("UPDATE multiremi_issue_shares SET expires_at = ? WHERE id = ?", [share.expires_at, shareId]);
    expect(bundle.session_results[0].body).toBe("A visible published result");
    expect(bundle.issue_workspace).toMatchObject({
      runtime_id: runtime.id,
      runtime_name: "claude",
      runtime_provider: "claude",
      runtime_mode: "local",
      runtime_device_info: "share-host · macOS (arm64)",
      runtime_daemon_id: "daemon-shared-workspace",
      runtime_machine_name: "Shared Mac",
    });
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
    expect((await app.request(`/api/shares/${encodeURIComponent(tampered)}/tasks/${task.id}/trace`, bearer(viewer.token))).status).toBe(404);

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
    expect((await app.request(tracePath, bearer(viewer.token))).status).toBe(404);
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
