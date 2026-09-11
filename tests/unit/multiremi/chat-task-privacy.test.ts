import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function setup() {
  const store = createStore();
  const agent = store.createAgent({ name: "Shared Chat Agent", provider: "codex", visibility: "workspace" });
  store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
  store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "admin" });
  const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
  const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
  const task = store.sendChatMessage(chat.id, { content: "Alice private Chat input" }).task;
  store.appendTaskMessages(task.id, [{ type: "text", content: "Alice private transcript" }]);
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  return { store, agent, chat, task, app, alice: headers(alice.token), bob: headers(bob.token), headers };
}

function taskIds(value: any): string[] {
  return (Array.isArray(value) ? value : value.tasks).map((task: any) => task.id);
}

describe("Chat task privacy across task APIs", () => {
  it("filters private Chat inputs from task and Agent snapshots while retaining ordinary tasks", async () => {
    const { store, agent, task, app, alice, bob } = await setup();
    const regularAgent = store.createAgent({ name: "Ordinary", provider: "codex", visibility: "workspace" });
    const regular = store.createTask({ agentId: regularAgent.id, prompt: "Ordinary workspace task" });
    for (const path of [
      "/api/multiremi/tasks",
      `/api/multiremi/agents/${agent.id}/tasks`,
      `/api/agents/${agent.id}/tasks`,
      "/api/multiremi/agent-task-snapshot",
      "/api/agent-task-snapshot",
    ]) {
      const owner = await app.request(path, { headers: alice });
      expect(owner.status, path).toBe(200);
      expect(taskIds(await owner.json()), path).toContain(task.id);
      const other = await app.request(path, { headers: bob });
      expect(other.status, path).toBe(200);
      const result = await other.json();
      expect(taskIds(result), path).not.toContain(task.id);
      expect(JSON.stringify(result), path).not.toContain("Alice private");
      if (!path.includes(`/agents/${agent.id}`)) expect(taskIds(result), path).toContain(regular.id);
    }
  });

  it("does not let a workspace admin inspect, steer, or cancel another user's Chat task", async () => {
    const { store, task, app, alice, bob } = await setup();
    for (const prefix of ["/api/multiremi/tasks", "/api/tasks"]) {
      for (const suffix of ["", "/messages", "/steer", "/inspection", "/human-requests"]) {
        if (prefix === "/api/tasks" && suffix === "") continue;
        const path = `${prefix}/${task.id}${suffix}`;
        const owner = await app.request(path, { headers: alice });
        expect(owner.status, path).toBe(200);
        const denied = await app.request(path, { headers: bob });
        expect(denied.status, path).toBe(403);
      }
      for (const suffix of ["/cancel", "/steer", "/redispatch", "/human-requests/not-a-request/respond"]) {
        const path = `${prefix}/${task.id}${suffix}`;
        const denied = await app.request(path, { method: "POST", headers: bob, body: JSON.stringify({ content: "foreign directive", reason: "foreign action", response: {} }) });
        expect(denied.status, path).toBe(403);
      }
    }
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.listTaskSteerMessages(task.id)).toEqual([]);
    expect((await app.request(`/api/tasks/${task.id}/prompt`, { headers: bob })).status).toBe(403);
    expect((await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST", headers: alice })).status).toBe(200);
  });

  it("preserves ordinary task access and daemon routing boundaries", async () => {
    const { store, agent, app, bob, headers } = await setup();
    const ordinary = store.createTask({ agentId: agent.id, prompt: "Workspace work" });
    expect((await app.request(`/api/multiremi/tasks/${ordinary.id}`, { headers: bob })).status).toBe(200);
    expect((await app.request(`/api/tasks/${ordinary.id}/steer`, { method: "POST", headers: bob, body: JSON.stringify({ content: "Finish ordinary work" }) })).status).toBe(201);
    expect((await app.request(`/api/tasks/${ordinary.id}/cancel`, { method: "POST", headers: bob })).status).toBe(200);
    const daemon = await store.createAccessToken({ name: "Daemon", type: "daemon", userId: "bob", workspaceId: "local" });
    expect((await app.request("/health", { headers: headers(daemon.token) })).status).toBe(200);
    expect((await app.request("/api/multiremi/tasks", { headers: headers(daemon.token) })).status).toBe(403);
  });

  it("keeps the executing task capability usable without granting other Runtime-owner tasks access", async () => {
    const { store, agent, task, app, headers } = await setup();
    // Daemon claim mints this token for the Runtime owner, who can differ from
    // the creator when a shared Runtime executes somebody else's Chat.
    const self = await store.createTaskAccessToken(task, "bob");
    const other = store.createTask({ agentId: agent.id, prompt: "Unrelated task" });
    const foreign = await store.createTaskAccessToken(other, "bob");
    const sameOwner = await store.createTaskAccessToken(other, "alice");
    for (const path of [`/api/multiremi/tasks/${task.id}`, `/api/tasks/${task.id}/messages`, `/api/tasks/${task.id}/inspection`]) {
      expect((await app.request(path, { headers: headers(self.token) })).status, path).toBe(200);
      expect((await app.request(path, { headers: headers(foreign.token) })).status, path).toBe(403);
      expect((await app.request(path, { headers: headers(sameOwner.token) })).status, path).toBe(403);
    }
    const steer = await app.request(`/api/tasks/${task.id}/steer`, { method: "POST", headers: headers(self.token), body: JSON.stringify({ content: "Finish this task" }) });
    expect(steer.status).toBe(201);
    const cancelled = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST", headers: headers(self.token) });
    expect(cancelled.status).toBe(200);
  });

  it("keeps retained Chat task records private after deletion, including a capability for the old task", async () => {
    const { store, agent, chat, task, app, alice, bob, headers } = await setup();
    store.deleteChatSession(chat.id);
    expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
    // A stale capability must not grant access to a removed Chat even if a
    // caller were still holding a separately minted token for the same task.
    const stale = await store.createTaskAccessToken(task, "bob");
    for (const identity of [alice, bob, headers(stale.token)]) {
      for (const path of [`/api/multiremi/tasks/${task.id}`, `/api/tasks/${task.id}/messages`, `/api/tasks/${task.id}/inspection`]) {
        expect((await app.request(path, { headers: identity })).status, path).toBe(403);
      }
      const listed = await app.request(`/api/agents/${agent.id}/tasks`, { headers: identity });
      expect(taskIds(await listed.json())).not.toContain(task.id);
      expect((await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST", headers: identity })).status).toBe(403);
    }
  });
});
