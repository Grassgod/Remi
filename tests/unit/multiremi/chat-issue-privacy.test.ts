import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  for (const userId of ["alice", "bob"]) {
    store.createWorkspaceMember({ workspaceId: "local", userId, name: userId, role: "member" });
  }
  const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
  const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
  const agent = store.createAgent({ name: "Shared agent", provider: "codex", workspaceId: "local" });
  const issue = store.createIssue({ title: "Team issue", workspaceId: "local", createdBy: "alice" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice", issueId: issue.id });
  const privateTask = store.sendChatMessage(chat.id, { content: "PRIVATE_CHAT_PROMPT" }).task;
  store.appendTaskMessages(privateTask.id, [{ type: "text", content: "PRIVATE_CHAT_TRANSCRIPT" }]);
  const publicTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Public issue work" });
  const app = createMultiremiApp({ store, authToken: "test-root", shareSecret: "test-share-secret" });
  return { store, app, issue, chat, privateTask, publicTask, alice: { Authorization: `Bearer ${alice.token}` }, bob: { Authorization: `Bearer ${bob.token}` } };
}

describe("Chat privacy through linked Issues", () => {
  it("filters private tasks from another member's Issue reads and refuses the nested cancel route", async () => {
    const { store, app, issue, privateTask, publicTask, alice, bob } = await setup();
    for (const path of [
      `/api/multiremi/issues/${issue.id}`,
      `/api/issues/${issue.id}/active-task`,
      `/api/issues/${issue.id}/task-runs`,
    ]) {
      const response = await app.request(path, { headers: bob });
      expect(response.status, path).toBe(200);
      const body = await response.text();
      expect(body, path).not.toContain("PRIVATE_CHAT_PROMPT");
      expect(body, path).not.toContain(privateTask.id);
      expect(body, path).toContain(publicTask.id);
      const own = await app.request(path, { headers: alice });
      expect(await own.text(), path).toContain(privateTask.id);
    }
    const cancelPath = `/api/issues/${issue.id}/tasks/${privateTask.id}/cancel`;
    expect((await app.request(cancelPath, { method: "POST", headers: bob })).status).toBe(403);
    expect(store.getTask(privateTask.id)?.status).toBe("queued");
    expect((await app.request(cancelPath, { method: "POST", headers: alice })).status).toBe(200);
  });

  it("keeps private Chat inputs and transcripts out of signed Issue shares, including after deletion", async () => {
    const { store, app, issue, chat, privateTask, publicTask, alice, bob } = await setup();
    const minted = await app.request(`/api/issues/${issue.id}/share`, { method: "POST", headers: alice });
    expect(minted.status).toBe(201);
    const { share } = await minted.json();
    for (const deleted of [false, true]) {
      if (deleted) store.deleteChatSession(chat.id);
      const response = await app.request(`/api/shares/${share.token}`, { headers: bob });
      expect(response.status).toBe(200);
      const bundle = await response.json();
      const body = JSON.stringify(bundle);
      expect(body).not.toContain("PRIVATE_CHAT_PROMPT");
      expect(body).not.toContain("PRIVATE_CHAT_TRANSCRIPT");
      const sharedTasks = [...bundle.tasks, ...bundle.sessions.flatMap((session: { tasks: { id: string }[] }) => session.tasks)];
      expect(sharedTasks.some((task) => task.id === privateTask.id)).toBe(false);
      expect(body).toContain(publicTask.id);
    }
  });
});
