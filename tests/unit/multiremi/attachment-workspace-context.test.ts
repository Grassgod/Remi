import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "attachment-scope@example.test", name: "Uploader" });
  const workspace = store.createWorkspace({ name: "Allowed", slug: "allowed-attachments" }, user.id);
  const other = store.createWorkspace({ name: "Other", slug: "other-attachments" });
  const agent = store.createAgent({ workspaceId: workspace.id, ownerId: user.id, name: "Worker", provider: "claude" });
  const otherAgent = store.createAgent({ workspaceId: other.id, name: "Other worker", provider: "claude" });
  const issue = store.createIssue({ workspaceId: workspace.id, title: "Allowed issue" });
  const otherIssue = store.createIssue({ workspaceId: other.id, title: "Other issue" });
  const otherComment = store.createIssueComment(otherIssue.id, { body: "Other comment" });
  const otherChat = store.createChatSession({ workspaceId: other.id, agentId: otherAgent.id, creatorId: "local" });
  const otherMessage = store.sendChatMessage(otherChat.id, { body: "Other message" }).message;
  const chat = store.createChatSession({ workspaceId: workspace.id, agentId: agent.id, creatorId: user.id });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Work" });
  const token = await store.createTaskAccessToken(task, user.id);
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { store, app, headers, user, workspace, other, issue, otherIssue, otherComment, otherChat, otherMessage, chat };
}

const file = { filename: "note.txt", url: "https://example.test/note.txt" };

describe("native attachment workspace context", () => {
  for (const reference of ["issue_id", "comment_id"]) {
    it(`rejects an upload joining ${reference} to a chat in another workspace before writing a file`, async () => {
      const { store, app, user, workspace, other, issue } = await fixture();
      const uploads = useUploadDir();
      store.createWorkspaceMember({ workspaceId: other.id, userId: user.id, name: user.name });
      const agent = store.createAgent({ workspaceId: other.id, ownerId: user.id, name: "Other owned agent", provider: "claude" });
      const chat = store.createChatSession({ workspaceId: other.id, agentId: agent.id, creatorId: user.id });
      const comment = store.createIssueComment(issue.id, { body: "Upload here" });
      const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, type: "pat", purpose: "session", name: "Upload login" });
      const form = new FormData();
      form.set("file", new File(["Mixed workspace upload"], "note.txt", { type: "text/plain" }));
      form.set(reference, reference === "issue_id" ? issue.id : comment.id);
      form.set("chat_session_id", chat.id);
      const response = await app.request("/api/upload-file", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug }, body: form,
      });
      expect(response.status).toBe(404);
      expect(readdirSync(uploads)).toEqual([]);
      expect(store.listAttachmentsForIssue(issue.id)).toEqual([]);
      expect(store.listAttachmentsForComment(comment.id)).toEqual([]);
    });
  }

  it("keeps issue attachments in the authorized issue workspace despite conflicting body aliases", async () => {
    const { store, app, headers, workspace, other, issue } = await fixture();
    const response = await app.request(`/api/multiremi/issues/${issue.id}/attachments`, {
      method: "POST", headers,
      body: JSON.stringify({ ...file, workspaceId: other.id, workspace_id: other.id }),
    });
    expect(response.status).toBe(201);
    const { attachment } = await response.json();
    expect(attachment.workspaceId).toBe(workspace.id);
    expect(store.getAttachment(attachment.id)?.workspaceId).toBe(workspace.id);
  });

  it("persists the same cleaned workspace alias it authorized for direct creation", async () => {
    const { app, headers, workspace } = await fixture();
    const response = await app.request("/api/multiremi/attachments", {
      method: "POST", headers,
      body: JSON.stringify({ ...file, workspaceId: "  ", workspace_id: workspace.id }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).attachment.workspaceId).toBe(workspace.id);
  });

  it("rejects foreign issue, comment and chat references before storing an attachment", async () => {
    const { app, headers, workspace, issue, otherIssue, otherComment, otherChat, otherMessage } = await fixture();
    for (const endpoint of ["/api/multiremi/attachments", `/api/multiremi/issues/${issue.id}/attachments`]) {
      const references = [
        { comment_id: otherComment.id },
        { chat_session_id: otherChat.id },
        { chat_message_id: otherMessage.id },
        ...(endpoint === "/api/multiremi/attachments" ? [{ issue_id: otherIssue.id }] : []),
      ];
      for (const reference of references) {
        const response = await app.request(endpoint, {
          method: "POST", headers,
          body: JSON.stringify({ ...file, workspaceId: workspace.id, ...reference }),
        });
        expect(response.status, `${endpoint}: ${JSON.stringify(reference)}`).toBe(404);
      }
    }
  });

  it("allows an attachment to the caller's chat in the authorized workspace", async () => {
    const { app, headers, workspace, chat } = await fixture();
    const response = await app.request("/api/multiremi/attachments", {
      method: "POST", headers,
      body: JSON.stringify({ ...file, workspaceId: workspace.id, chat_session_id: chat.id }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).attachment.chatSessionId).toBe(chat.id);
  });
});
