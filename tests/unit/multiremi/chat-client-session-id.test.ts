import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

/**
 * The Web opens a new chat at its first send under an id it made itself, so
 * the create route takes a client `id`: only in the server's own shape, and
 * only one no chat has ever had.
 */
afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "client-chat-id@example.test", name: "Chat member" });
  const workspace = store.createWorkspace({ name: "Chats", slug: "client-chat-ids" });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: user.id, name: user.name, role: "member" });
  const agent = store.createAgent({ workspaceId: workspace.id, name: "Chat agent", provider: "claude", ownerId: user.id });
  const outsider = store.getOrCreateUser({ email: "client-chat-id-other@example.test", name: "Other member" });
  const other = store.createWorkspace({ name: "Other", slug: "client-chat-ids-other" });
  store.createWorkspaceMember({ workspaceId: other.id, userId: outsider.id, name: outsider.name, role: "member" });
  const otherAgent = store.createAgent({ workspaceId: other.id, name: "Other agent", provider: "claude", ownerId: outsider.id });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "Login", type: "pat", purpose: "session",
  });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-ID": workspace.id };
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const create = (route: string, body: Record<string, unknown>) =>
    app.request(route, { method: "POST", headers, body: JSON.stringify(body) });
  return { store, workspace, agent, other, otherAgent, outsider, create };
}

const routes = ["/api/chat/sessions", "/api/multiremi/chats"];
const MALFORMED = { error: "id must be chat_ followed by 12 lowercase letters or digits" };
const USED = { error: "Chat session id has already been used" };

describe("client-made chat ids on create", () => {
  for (const route of routes) {
    it(`creates the chat under a well-formed id: ${route}`, async () => {
      const { store, agent, create } = await fixture();
      const response = await create(route, { id: "chat_0a1b2c3d4e5f", agent_id: agent.id, title: "First" });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect((body.session ?? body).id).toBe("chat_0a1b2c3d4e5f");
      expect(store.getChatSession("chat_0a1b2c3d4e5f")?.title).toBe("First");
      // Without an id the server still makes one.
      const generated = await create(route, { agent_id: agent.id, id: null });
      expect(generated.status).toBe(201);
      const generatedBody = await generated.json();
      expect((generatedBody.session ?? generatedBody).id).toMatch(/^chat_[0-9a-z]{12}$/);
    });

    it(`refuses a malformed id and creates nothing: ${route}`, async () => {
      const { store, workspace, agent, create } = await fixture();
      const malformed: unknown[] = [
        "", "chat_", "chat_0a1b2c3d4e5", "chat_0a1b2c3d4e5f6", "chat_0A1B2C3D4E5F", "chat-0a1b2c3d4e5f",
        "issue_0a1b2c3d4e", "chat_0a1b2c3d4e5_", "chat_0a1b2c3d4e5f\n", " chat_0a1b2c3d4e5f", "chat_issue_topic_x",
        123, true, {}, ["chat_0a1b2c3d4e5f"],
      ];
      for (const id of malformed) {
        const response = await create(route, { id, agent_id: agent.id });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(MALFORMED);
      }
      expect(store.listChatSessions(workspace.id)).toEqual([]);
    });

    it(`refuses another workspace's chat id the same way and leaves that chat alone: ${route}`, async () => {
      const { store, other, otherAgent, outsider, agent, create } = await fixture();
      const theirs = store.createChatSession({
        id: "chat_0000000000aa", workspaceId: other.id, agentId: otherAgent.id, creatorId: outsider.id, title: "Private",
      });
      const response = await create(route, { id: theirs.id, agent_id: agent.id, title: "Mine" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(USED);
      expect(store.getChatSession(theirs.id)).toMatchObject({ workspaceId: other.id, creatorId: outsider.id, title: "Private" });
      // A caller who may not create there learns nothing about the id.
      const denied = await create(route, { id: theirs.id, agent_id: otherAgent.id });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: "agent not found" });
    });

    it(`refuses the id of a deleted chat, whose log stays behind: ${route}`, async () => {
      const { store, workspace, agent, create } = await fixture();
      const deleted = store.createChatSession({
        id: "chat_0000000000bb", workspaceId: workspace.id, agentId: agent.id, creatorId: "another-user", title: "Gone",
      });
      expect(store.deleteChatSession(deleted.id)).toBe(true);
      expect(store.getChatSession(deleted.id)).toBeNull();
      const response = await create(route, { id: deleted.id, agent_id: agent.id });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(USED);
      expect(store.getChatSession(deleted.id)).toBeNull();
    });
  }
});
