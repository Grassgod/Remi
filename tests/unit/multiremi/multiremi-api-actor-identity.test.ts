import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, signTestJwt, useUploadDir } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ email: "actor-owner@example.test", name: "Owner" });
  const workspace = store.createWorkspace({ name: "Actors", slug: "actors" }, owner.id);
  const users = ["Alice", "Bob"].map((name) => {
    const user = store.getOrCreateUser({ email: `${name.toLowerCase()}@example.test`, name });
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: user.id, name, role: "member" });
    return user;
  });
  const headers = await Promise.all(users.map(async (user) => {
    const { token } = await store.createAccessToken({
      workspaceId: "local", userId: user.id, name: "Web login", type: "pat", purpose: "session",
    });
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug };
  }));
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const issue = store.createIssue({ title: "Actor identity", workspaceId: workspace.id });
  const comment = store.createIssueComment(issue.id, { body: "Thread", authorType: "member", authorId: users[0]!.id });
  return { store, app, workspace, users, headers, issue, comment };
}

describe("authenticated issue mutation actors", () => {
  it("keeps task comment authors and lineage authoritative without removing trusted explicit authors", async () => {
    const { app, store, workspace, issue, users } = await fixture();
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Worker", provider: "claude" });
    const trustedAgent = store.createAgent({ workspaceId: workspace.id, name: "Trusted author", provider: "claude" });
    const task = store.createTask({ workspaceId: workspace.id, issueId: issue.id, agentId: agent.id, prompt: "Work" });
    const taskToken = await store.createTaskAccessToken(task, users[0]!.id);
    for (const entry of [
      { app, token: taskToken.token, expectedId: agent.id, taskId: task.id },
      { app, token: "root-secret", expectedId: trustedAgent.id, taskId: null },
      { app: createMultiremiApp({ store, authToken: null }), token: null, expectedId: trustedAgent.id, taskId: null },
    ]) {
      for (const prefix of ["/api", "/api/multiremi"]) {
        const headers: Record<string, string> = { "Content-Type": "application/json", "X-Agent-ID": trustedAgent.id };
        if (entry.token) headers.Authorization = `Bearer ${entry.token}`;
        const response = await entry.app.request(`${prefix}/issues/${issue.id}/comments`, {
          method: "POST", headers,
          body: JSON.stringify({ content: "Agent comment", authorType: "agent", authorId: trustedAgent.id, taskId: null }),
        });
        expect(response.status).toBe(201);
        const body = await response.json();
        const comment = body.comment ?? body;
        expect(comment.authorId ?? comment.author_id).toBe(entry.expectedId);
        expect(comment.authorType ?? comment.author_type).toBe("agent");
        expect(comment.taskId ?? comment.task_id ?? null).toBe(entry.taskId);
      }
    }
  });

  it("prevents members from forging comment authors through body fields or agent headers", async () => {
    const { app, store, issue, users, headers } = await fixture();
    const session = store.createIssueSession(issue.id, { title: "Discussion" });
    const jwtHeaders = {
      ...headers[0],
      Authorization: `Bearer ${signTestJwt({ sub: users[0]!.id, exp: Math.floor(Date.now() / 1000) + 60 })}`,
    };
    for (const authHeaders of [headers[0], jwtHeaders]) {
      for (const endpoint of [
        `/api/issues/${issue.id}/comments`,
        `/api/multiremi/issues/${issue.id}/comments`,
        `/api/issues/${issue.id}/sessions/${session.id}/messages`,
      ]) {
        for (const author of [{ authorType: "member", authorId: users[1]!.id }, {}]) {
          const response = await app.request(endpoint, {
            method: "POST", headers: { ...authHeaders, "X-Agent-ID": "forged-agent" },
            body: JSON.stringify({ content: "A real member comment", ...author }),
          });
          expect(response.status).toBe(201);
          const body = await response.json();
          const comment = body.comment ?? body;
          expect(comment.authorId ?? comment.author_id).toBe(users[0]!.id);
          expect(comment.authorType ?? comment.author_type).toBe("member");
        }
      }
    }
  });

  it("retains the local actor fallback for master-token and auth-disabled clients", async () => {
    const { store, issue } = await fixture();
    for (const authToken of ["root-secret", null]) {
      const app = createMultiremiApp({ store, authToken });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const reaction = await app.request(`/api/issues/${issue.id}/reactions`, {
        method: "POST", headers, body: JSON.stringify({ emoji: "👍" }),
      });
      expect(reaction.status).toBe(201);
      expect(await reaction.json()).toMatchObject({ actor_type: "member", actor_id: "local" });
      const attachment = await app.request("/api/multiremi/attachments", {
        method: "POST", headers,
        body: JSON.stringify({ workspaceId: issue.workspaceId, filename: "note.txt", url: "https://example.test/note.txt" }),
      });
      expect(attachment.status).toBe(201);
      expect((await attachment.json()).attachment).toMatchObject({ uploaderType: "member", uploaderId: "local" });
    }
  });

  it("preserves task agents and trusted explicit actors while binding JWT callers to their user", async () => {
    const { app, store, workspace, issue, users } = await fixture();
    useUploadDir();
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Worker", provider: "claude" });
    const task = store.createTask({ workspaceId: workspace.id, issueId: issue.id, agentId: agent.id, prompt: "Work" });
    const taskToken = await store.createTaskAccessToken(task, users[0]!.id);
    const cases = [
      { app, token: taskToken.token, expectedType: "agent", expectedId: agent.id },
      { app, token: signTestJwt({ sub: users[0]!.id, exp: Math.floor(Date.now() / 1000) + 60 }), expectedType: "member", expectedId: users[0]!.id },
      { app, token: "root-secret", expectedType: "agent", expectedId: "trusted-agent" },
      { app: createMultiremiApp({ store, authToken: null }), token: null, expectedType: "agent", expectedId: "trusted-agent" },
    ];
    for (const [index, entry] of cases.entries()) {
      const headers: Record<string, string> = { "Content-Type": "application/json", "X-Agent-ID": "forged-agent" };
      if (entry.token) headers.Authorization = `Bearer ${entry.token}`;
      const reaction = await entry.app.request(`/api/multiremi/issues/${issue.id}/reactions`, {
        method: "POST", headers,
        body: JSON.stringify({ emoji: `reaction-${index}`, actorType: "agent", actorId: "trusted-agent" }),
      });
      expect(reaction.status).toBe(201);
      expect((await reaction.json()).reaction).toMatchObject({ actorType: entry.expectedType, actorId: entry.expectedId });
      const comment = store.createIssueComment(issue.id, { body: `Thread ${index}`, authorType: "member", authorId: users[0]!.id });
      const resolved = await entry.app.request(`/api/comments/${comment.id}/resolve`, {
        method: "POST", headers, body: JSON.stringify({ actor_type: "agent", actor_id: "trusted-agent" }),
      });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ resolved_by_type: entry.expectedType, resolved_by_id: entry.expectedId });
      const form = new FormData();
      form.set("file", new File(["note"], `note-${index}.txt`));
      form.set("issue_id", issue.id);
      form.set("uploader_type", "agent");
      form.set("uploader_id", "trusted-agent");
      const uploadHeaders = { ...headers };
      delete uploadHeaders["Content-Type"];
      const upload = await entry.app.request("/api/upload-file", { method: "POST", headers: uploadHeaders, body: form });
      expect(upload.status).toBe(200);
      const attachment = await upload.json();
      expect(attachment).toMatchObject({ uploader_type: entry.expectedType, uploader_id: entry.expectedId });
      const deleted = await entry.app.request(`/api/attachments/${attachment.id}`, {
        method: "DELETE", headers: { ...headers, "X-Agent-ID": entry.expectedId },
      });
      expect(deleted.status).toBe(200);
    }
  });

  it("resolves as the logged-in user and accepts an empty JSON request", async () => {
    const { app, issue, comment, headers, users, store } = await fixture();
    const invalid = await app.request(`/api/comments/${comment.id}/resolve`, {
      method: "POST", headers: headers[0], body: "{",
    });
    expect(invalid.status).toBe(400);
    const response = await app.request(`/api/comments/${comment.id}/resolve`, {
      method: "POST", headers: headers[0],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolved_by_type: "member", resolved_by_id: users[0]!.id });
    for (const prefix of ["/api", "/api/multiremi"]) {
      const thread = store.createIssueComment(issue.id, { body: "Another thread", authorType: "member", authorId: users[0]!.id });
      const forged = await app.request(`${prefix}/comments/${thread.id}/resolve`, {
        method: "POST", headers: { ...headers[1], "X-Agent-ID": "forged-agent" },
        body: JSON.stringify({ actor_type: "agent", actor_id: users[0]!.id, actorType: "agent", actorId: users[0]!.id }),
      });
      expect(forged.status).toBe(200);
      const body = await forged.json();
      const resolved = body.comment ?? body;
      expect(resolved.resolvedById ?? resolved.resolved_by_id).toBe(users[1]!.id);
      expect(resolved.resolvedByType ?? resolved.resolved_by_type).toBe("member");
    }
  });

  it("uses the authenticated uploader for both native attachment creation routes", async () => {
    const { app, issue, workspace, users, headers } = await fixture();
    for (const endpoint of ["/api/multiremi/attachments", `/api/multiremi/issues/${issue.id}/attachments`]) {
      const response = await app.request(endpoint, {
        method: "POST", headers: headers[0],
        body: JSON.stringify({
          workspaceId: workspace.id, filename: "note.txt", url: "https://example.test/note.txt",
          uploaderType: "agent", uploaderId: users[1]!.id,
        }),
      });
      expect(response.status).toBe(201);
      expect((await response.json()).attachment).toMatchObject({ uploaderType: "member", uploaderId: users[0]!.id });
    }
  });

  it("attributes uploads to their authenticated owner, who can delete them", async () => {
    const { app, issue, users, headers } = await fixture();
    useUploadDir();
    const form = new FormData();
    form.set("file", new File(["attachment"], "note.txt", { type: "text/plain" }));
    form.set("issue_id", issue.id);
    form.set("uploader_type", "agent");
    form.set("uploader_id", users[1]!.id);
    const uploaded = await app.request("/api/upload-file", {
      method: "POST", headers: { Authorization: headers[0]!.Authorization, "X-Agent-ID": "forged-agent" }, body: form,
    });
    expect(uploaded.status).toBe(200);
    const attachment = await uploaded.json();
    expect(attachment).toMatchObject({ uploader_type: "member", uploader_id: users[0]!.id });
    const otherDelete = await app.request(`/api/attachments/${attachment.id}`, { method: "DELETE", headers: headers[1] });
    expect(otherDelete.status).toBe(403);
    const ownDelete = await app.request(`/api/attachments/${attachment.id}`, { method: "DELETE", headers: headers[0] });
    expect(ownDelete.status).toBe(200);
    const deleted = await app.request(`/api/attachments/${attachment.id}`, { headers: headers[0] });
    expect(deleted.status).toBe(404);
  });

  it("keeps members' reactions separate and ignores forged actors on add and remove", async () => {
    const { app, issue, comment, headers, users } = await fixture();
    for (const endpoint of [`/api/issues/${issue.id}/reactions`, `/api/comments/${comment.id}/reactions`]) {
      const first = await app.request(endpoint, {
        method: "POST", headers: headers[0], body: JSON.stringify({ emoji: "👍" }),
      });
      expect(first.status).toBe(201);
      const firstReaction = await first.json();
      expect(firstReaction).toMatchObject({ actor_type: "member", actor_id: users[0]!.id });
      const second = await app.request(endpoint, {
        method: "POST", headers: { ...headers[1], "X-Agent-ID": "forged-agent" },
        body: JSON.stringify({ emoji: "👍", actor_type: "agent", actor_id: users[0]!.id, actorType: "agent", actorId: users[0]!.id }),
      });
      expect(second.status).toBe(201);
      const secondReaction = await second.json();
      expect(secondReaction).toMatchObject({ actor_type: "member", actor_id: users[1]!.id });
      expect(secondReaction.id).not.toBe(firstReaction.id);
      const removed = await app.request(endpoint, {
        method: "DELETE", headers: headers[1],
        body: JSON.stringify({ emoji: "👍", actor_type: "member", actor_id: users[0]!.id }),
      });
      expect(removed.status).toBe(204);
      const listEndpoint = endpoint.includes("/comments/") ? endpoint.replace("/api/", "/api/multiremi/") : endpoint;
      const list = await app.request(listEndpoint, { headers: headers[0] });
      expect(list.status).toBe(200);
      const body = await list.json();
      const reactions = Array.isArray(body) ? body : body.reactions;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].id).toBe(firstReaction.id);
    }
  });
});
