import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "chat-context@example.test", name: "Chat member" });
  const workspace = store.createWorkspace({ name: "Chats", slug: "selected-chats" });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: user.id, name: user.name, role: "member" });
  const other = store.createWorkspace({ name: "Other", slug: "other-chats" });
  const agent = store.createAgent({ workspaceId: workspace.id, name: "Chat agent", provider: "claude", ownerId: user.id });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "Login", type: "pat", purpose: "session",
  });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return { store, user, workspace, other, agent, headers, app };
}

const routes = ["/api/chat/sessions", "/api/multiremi/chats"];

describe("chat workspace request context", () => {
  for (const route of routes) {
    for (const selector of ["slug", "id"]) {
      it(`creates, lists and tracks chats in the selected workspace through ${selector}: ${route}`, async () => {
        const { store, user, workspace, agent, headers, app } = await fixture();
        const selected = { ...headers, ...(selector === "slug"
          ? { "X-Workspace-Slug": workspace.slug }
          : { "X-Workspace-ID": workspace.id }) };
        expect(store.getUserRoleInWorkspace(user.id, "local")).toBeNull();
        const created = await app.request(route, {
          method: "POST", headers: selected, body: JSON.stringify({ agent_id: agent.id, title: "Team chat" }),
        });
        expect(created.status).toBe(201);
        const result = await created.json();
        const session = result.session ?? result;
        expect(session.workspaceId ?? session.workspace_id).toBe(workspace.id);
        expect(session.creatorId ?? session.creator_id).toBe(user.id);
        const listed = await app.request(route, { headers: selected });
        expect(listed.status).toBe(200);
        const list = await listed.json();
        expect((list.sessions ?? list).map((item: { id: string }) => item.id)).toEqual([session.id]);
        const sent = await app.request(`${route}/${session.id}/messages`, {
          method: "POST", headers, body: JSON.stringify({ content: "Hello" }),
        });
        expect(sent.status).toBe(201);
        const pending = await app.request("/api/chat/pending-tasks", { headers: selected });
        expect(pending.status).toBe(200);
        expect((await pending.json()).tasks.map((item: { chat_session_id: string }) => item.chat_session_id)).toEqual([session.id]);
      });
    }

    it(`rejects unknown and inaccessible workspace selectors: ${route}`, async () => {
      const { workspace, other, agent, headers, app } = await fixture();
      const contexts = [
        { ...headers, "X-Workspace-Slug": other.slug },
        { ...headers, "X-Workspace-ID": other.id },
        { ...headers, "X-Workspace-ID": "missing" },
        { ...headers, Authorization: "Bearer root-secret", "X-Workspace-Slug": "missing" },
      ];
      for (const context of contexts) {
        for (const path of [route, "/api/chat/pending-tasks"]) {
          const response = await app.request(path, { headers: context });
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: "workspace not found" });
        }
        const response = await app.request(route, {
          method: "POST", headers: context, body: JSON.stringify({ agent_id: agent.id }),
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "workspace not found" });
      }
      const local = await app.request("/api/chat/sessions?workspace_id=local", { headers: { Authorization: "Bearer root-secret" } });
      expect(await local.json()).toEqual([]);
      const selected = await app.request(`${route}?workspace_id=${workspace.id}`, { headers });
      expect(selected.status).toBe(200);
      const result = await selected.json();
      expect(result.sessions ?? result).toEqual([]);
    });

    it(`preserves explicit body and query workspace precedence: ${route}`, async () => {
      const { workspace, other, agent, headers, app } = await fixture();
      const cases = [
        { query: `workspaceId=${other.id}`, fields: { workspaceId: workspace.id, workspace_id: other.id } },
        { query: `workspaceId=${other.id}`, fields: { workspace_id: workspace.id } },
        { query: `workspaceId=${workspace.id}&workspace_id=${other.id}`, fields: {} },
        { query: `workspace_id=${workspace.id}`, fields: {} },
      ];
      for (const entry of cases) {
        const response = await app.request(`${route}?${entry.query}`, {
          method: "POST", headers: { ...headers, "X-Workspace-ID": other.id, "X-Workspace-Slug": "missing" },
          body: JSON.stringify({ agent_id: agent.id, ...entry.fields }),
        });
        expect(response.status).toBe(201);
        const result = await response.json();
        expect((result.session ?? result).workspaceId ?? result.workspace_id).toBe(workspace.id);
      }
    });

    it(`keeps session resources bound to their workspace and creator: ${route}`, async () => {
      const { store, workspace, other, agent, user, headers, app } = await fixture();
      const session = store.createChatSession({ workspaceId: workspace.id, agentId: agent.id, creatorId: user.id });
      const contexts: Record<string, string>[] = [{}, { "X-Workspace-Slug": "missing" }, { "X-Workspace-ID": other.id }];
      for (const context of contexts) {
        const response = await app.request(`${route}/${session.id}`, { headers: { ...headers, ...context } });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect((result.session ?? result).id).toBe(session.id);
      }
      const someoneElse = store.createChatSession({ workspaceId: workspace.id, agentId: agent.id, creatorId: "another-user" });
      const denied = await app.request(`${route}/${someoneElse.id}`, { headers });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "not your chat session" });
    });

    it(`keeps task, ownerless PAT and daemon credentials scoped: ${route}`, async () => {
      const { store, workspace, other, user, agent, headers, app } = await fixture();
      store.createWorkspaceMember({ workspaceId: other.id, userId: user.id, name: user.name, role: "member" });
      const issue = store.createIssue({ workspaceId: workspace.id, title: "Task" });
      const task = store.createTask({ workspaceId: workspace.id, agentId: agent.id, issueId: issue.id, prompt: "Work" });
      const taskToken = await store.createTaskAccessToken(task, user.id);
      const pat = await store.createAccessToken({ workspaceId: workspace.id, name: "Scoped PAT", type: "pat" });
      const daemon = await store.createAccessToken({ workspaceId: workspace.id, name: "Daemon", type: "daemon", daemonId: "dmn_chats", userId: user.id });
      const foreignAgent = store.createAgent({ workspaceId: other.id, name: "Other agent", provider: "claude", ownerId: user.id });
      const foreignSession = store.createChatSession({ workspaceId: other.id, agentId: foreignAgent.id, creatorId: user.id });
      const contexts: Record<string, string>[] = [{ "X-Workspace-Slug": other.slug }, { "X-Workspace-ID": other.id }];
      for (const credential of [taskToken, pat, daemon]) {
        const auth = { ...headers, Authorization: `Bearer ${credential.token}` };
        for (const context of contexts) {
          for (const path of [route, "/api/chat/pending-tasks", `${route}/${foreignSession.id}`]) {
            const response = await app.request(path, { headers: { ...auth, ...context } });
            expect([403, 404]).toContain(response.status);
          }
          const created = await app.request(route, {
            method: "POST", headers: { ...auth, ...context }, body: JSON.stringify({ agent_id: foreignAgent.id }),
          });
          expect([403, 404]).toContain(created.status);
        }
        const inScope = await app.request(route, { headers: auth });
        expect(inScope.status).toBe(credential === daemon ? 403 : 200);
      }
      const otherList = await app.request(`${route}?workspace_id=${other.id}`, { headers });
      const result = await otherList.json();
      expect((result.sessions ?? result).map((item: { id: string }) => item.id)).toEqual([foreignSession.id]);
    });
  }
});
