import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("POST /api/chat/external/resolve", () => {
  it("authenticates an ordinary member and defaults to the workspace concierge", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    const token = await store.createAccessToken({
      name: "Alice Feishu bot",
      type: "pat",
      workspaceId: "local",
      userId: "alice",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const unauthorized = await app.request("/api/chat/external/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "feishu", external_chat_id: "oc_alice" }),
    });
    expect(unauthorized.status).toBe(401);

    const resolve = () => app.request("/api/chat/external/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "feishu", external_chat_id: "oc_alice" }),
    });
    const first = await resolve();
    const second = await resolve();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(firstBody.creator_id).toBe("alice");
    expect(firstBody.agent_id).toBe("agt_concierge_local");
    expect(store.getAgent(firstBody.agent_id)).toMatchObject({
      name: "飞书管家",
      visibility: "workspace",
      maxConcurrentTasks: 20,
    });
    expect(store.listChatSessions("local")).toHaveLength(1);
  });

  it("honors an accessible explicit agent and rejects invalid input", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    const token = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice" });
    const workspaceAgent = store.createAgent({
      name: "Shared helper",
      provider: "codex",
      workspaceId: "local",
      visibility: "workspace",
    });
    const privateAgent = store.createAgent({
      name: "Bob private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "private",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const request = (body: Record<string, unknown>) => app.request("/api/chat/external/resolve", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const explicit = await request({
      source: "feishu",
      external_chat_id: "oc_explicit",
      agent_id: workspaceAgent.id,
    });
    expect(explicit.status).toBe(200);
    expect((await explicit.json()).agent_id).toBe(workspaceAgent.id);
    expect((await request({ source: "slack", external_chat_id: "oc_bad" })).status).toBe(400);
    expect((await request({ source: "feishu" })).status).toBe(400);
    expect((await request({
      source: "feishu",
      external_chat_id: "oc_private",
      agent_id: privateAgent.id,
    })).status).toBe(403);
  });
});
