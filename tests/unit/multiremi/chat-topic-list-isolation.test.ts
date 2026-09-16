import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { prepareFeishuIssueTopic } from "../../fixtures/multiremi-feishu-topic.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Chat list isolation from Feishu Issue topics", () => {
  it("keeps creator-owned topic updates out of Web and CLI conversation lists", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Topic list runtime", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Chat and topic agent", provider: "codex", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Topic only", createdBy: "local" });
    const topic = prepareFeishuIssueTopic(store, { runtimeId: runtime.id, agentId: agent.id, issueId: issue.id });
    expect(topic.creatorId).toBe("local");
    const privateChat = store.createChatSession({ agentId: agent.id, creatorId: "local", title: "Private conversation" });
    const privateTask = store.sendChatMessage(privateChat.id, { body: "Private message" }).task;
    store.sendChatMessage(topic.id, { body: "Topic progress" });
    store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Issue update for the topic" });
    expect(store.flushDueAgentIssueUpdates(new Date(Date.now() + 60_000))).toMatchObject({ delivered: 1 });
    expect(store.listChatMessages(topic.id).some((message) => message.body.startsWith("Bound Issue update:"))).toBe(true);
    expect(store.listChatMessages(privateChat.id).map((message) => message.body)).toEqual(["Private message"]);

    const credential = await store.createAccessToken({ name: "Chat lists", type: "pat", workspaceId: "local", userId: "local" });
    const headers = { Authorization: `Bearer ${credential.token}` };
    const app = createMultiremiApp({ store, authToken: "chat-list-test" });
    for (const prefix of ["/api/chat/sessions", "/api/multiremi/chats"]) {
      for (const query of ["", "?status=all"]) {
        const response = await app.request(`${prefix}${query}`, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        const sessions = Array.isArray(body) ? body : body.sessions;
        expect(sessions.map((session: { id: string }) => session.id)).toEqual([privateChat.id]);
        expect(JSON.stringify(body)).not.toContain("Bound Issue update:");
        if (!Array.isArray(body)) expect(body.total).toBe(1);
      }
    }
    const pending = await app.request("/api/chat/pending-tasks", { headers });
    expect(pending.status).toBe(200);
    expect((await pending.json()).tasks).toEqual([
      { task_id: privateTask.id, status: "queued", chat_session_id: privateChat.id },
    ]);
    // Internal topic auditing and direct topic transport access still work.
    expect(store.listChatSessions("local", { creatorId: "local" }).map((session) => session.id)).toContain(topic.id);
    expect((await app.request(`/api/chat/sessions/${topic.id}`, { headers })).status).toBe(200);
  });
});
