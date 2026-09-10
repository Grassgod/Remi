import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "skill-context@example.test", name: "Skill member" });
  const workspace = store.createWorkspace({ name: "Skills", slug: "selected-skills" });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: user.id, name: user.name, role: "member" });
  const other = store.createWorkspace({ name: "Other", slug: "other-skills" });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "Login", type: "pat", purpose: "session",
  });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return { store, user, workspace, other, headers, app };
}

const routes = ["/api/skills", "/api/multiremi/skills"];

describe("skill workspace request context", () => {
  for (const route of routes) {
    for (const selector of ["slug", "id"]) {
      it(`creates, lists and searches the selected workspace through ${selector}: ${route}`, async () => {
        const { store, workspace, user, headers, app } = await fixture();
        const selected = { ...headers, ...(selector === "slug"
          ? { "X-Workspace-Slug": workspace.slug }
          : { "X-Workspace-ID": workspace.id }) };
        store.createSkill({ workspaceId: "local", name: "Local skill" });
        expect(store.getUserRoleInWorkspace(user.id, "local")).toBeNull();
        const created = await app.request(route, {
          method: "POST", headers: selected, body: JSON.stringify({ name: "Team skill", content: "# Team" }),
        });
        expect(created.status).toBe(201);
        const result = await created.json();
        const skill = result.skill ?? result;
        expect(skill.workspaceId ?? skill.workspace_id).toBe(workspace.id);
        expect(skill.createdBy ?? skill.created_by).toBe(user.id);
        const listed = await app.request(route, { headers: selected });
        expect(listed.status).toBe(200);
        const list = await listed.json();
        expect((list.skills ?? list).map((item: { name: string }) => item.name)).toEqual(["Team skill"]);
        const searched = await app.request(`${route}/search?q=skill`, { headers: selected });
        expect(searched.status).toBe(200);
        const search = await searched.json();
        expect((search.skills ?? search).map((item: { name: string }) => item.name)).toEqual(["Team skill"]);
      });
    }

    it(`does not expose other workspaces' skill summaries: ${route}`, async () => {
      const { store, other, headers, app } = await fixture();
      store.createSkill({ workspaceId: "local", name: "Local secret", description: "Private summary" });
      store.createSkill({ workspaceId: other.id, name: "Other secret", description: "Foreign summary" });
      const contexts: Record<string, string>[] = [{}, { "X-Workspace-Slug": other.slug }, { "X-Workspace-ID": other.id }];
      for (const context of contexts) {
        const response = await app.request(`${route}/search?q=secret`, { headers: { ...headers, ...context } });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "workspace not found" });
      }
      const explicit = await app.request(`${route}/search?q=secret&workspace_id=${other.id}`, { headers });
      expect(explicit.status).toBe(404);
      expect(await explicit.json()).toEqual({ error: "workspace not found" });
    });

    it(`authorizes existing skills from their resource workspace: ${route}`, async () => {
      const { store, workspace, other, user, headers, app } = await fixture();
      const skill = store.createSkill({ workspaceId: workspace.id, name: "Existing", createdBy: user.id });
      const contexts: Record<string, string>[] = [{}, { "X-Workspace-Slug": "missing" }, { "X-Workspace-ID": other.id }];
      for (const context of contexts) {
        const response = await app.request(`${route}/${skill.id}`, { headers: { ...headers, ...context } });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect((result.skill ?? result).id).toBe(skill.id);
      }
      for (const field of ["workspaceId", "workspace_id"]) {
        const mismatch = await app.request(`${route}/${skill.id}?${field}=${other.id}`, { headers });
        expect(mismatch.status).toBe(404);
        expect(await mismatch.json()).toEqual({ error: "skill not found" });
      }
      const updated = await app.request(`${route}/${skill.id}`, {
        method: "PUT", headers, body: JSON.stringify({ description: "Edited", workspace_id: other.id }),
      });
      expect(updated.status).toBe(200);
      const result = await updated.json();
      expect((result.skill ?? result).workspaceId ?? result.workspace_id).toBe(workspace.id);
      expect((result.skill ?? result).description).toBe("Edited");
      const deleted = await app.request(`${route}/${skill.id}`, { method: "DELETE", headers });
      expect(deleted.status).toBe(route === "/api/skills" ? 204 : 200);
      expect((await app.request(`${route}/${skill.id}`, { headers })).status).toBe(404);
    });

    it(`imports into the selected workspace with either header: ${route}`, async () => {
      const { workspace, headers, app } = await fixture();
      mockFetch((url) => {
        if (url === "https://api.github.com/repos/example/skills/commits/main/review-helper") return new Response("not found", { status: 404 });
        if (url === "https://api.github.com/repos/example/skills/commits/main") return new Response("sha");
        if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md") {
          return new Response("---\nname: review-helper\ndescription: Imported review\n---\n# Review");
        }
        if (url === "https://api.github.com/repos/example/skills/contents/review-helper?ref=main") {
          return jsonResponse([{ name: "SKILL.md", path: "review-helper/SKILL.md", type: "file" }]);
        }
        throw new Error(`unexpected import fetch: ${url}`);
      });
      const contexts: Record<string, string>[] = [{ "X-Workspace-Slug": workspace.slug }, { "X-Workspace-ID": workspace.id }];
      for (const context of contexts) {
        const name = "X-Workspace-Slug" in context ? "Imported slug" : "Imported ID";
        const response = await app.request(`${route}/import`, {
          method: "POST", headers: { ...headers, ...context },
          body: JSON.stringify({ url: "https://github.com/example/skills/tree/main/review-helper", name }),
        });
        expect(response.status).toBe(201);
        const result = await response.json();
        expect((result.skill ?? result).workspaceId ?? result.workspace_id).toBe(workspace.id);
        expect((result.skill ?? result).content).toContain("# Review");
      }
    });

    it(`rejects unknown slugs before reads, writes or import fetches: ${route}`, async () => {
      const { headers, app } = await fixture();
      const stale = { ...headers, Authorization: "Bearer root-secret", "X-Workspace-Slug": "missing" };
      let fetched = false;
      mockFetch(() => { fetched = true; throw new Error("unexpected import fetch"); });
      const requests = [
        ["GET", route, undefined],
        ["GET", `${route}/search?q=skill`, undefined],
        ["POST", route, { name: "Wrong workspace" }],
        ["POST", `${route}/import`, { url: "https://github.com/example/skills" }],
      ] as const;
      for (const [method, path, body] of requests) {
        const response = await app.request(path, { method, headers: stale, body: body && JSON.stringify(body) });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "workspace not found" });
      }
      expect(fetched).toBe(false);
      const local = await app.request("/api/skills?workspace_id=local", { headers: { Authorization: "Bearer root-secret" } });
      expect(await local.json()).toEqual([]);
    });

    it(`preserves explicit body and query workspace precedence: ${route}`, async () => {
      const { workspace, other, headers, app } = await fixture();
      const cases = [
        { query: `workspaceId=${other.id}`, fields: { workspaceId: workspace.id, workspace_id: other.id } },
        { query: `workspaceId=${other.id}`, fields: { workspace_id: workspace.id } },
        { query: `workspaceId=${workspace.id}&workspace_id=${other.id}`, fields: {} },
        { query: `workspace_id=${workspace.id}`, fields: {} },
      ];
      for (const [index, entry] of cases.entries()) {
        const response = await app.request(`${route}?${entry.query}`, {
          method: "POST", headers: { ...headers, "X-Workspace-ID": other.id, "X-Workspace-Slug": "missing" },
          body: JSON.stringify({ name: `Explicit ${index}`, ...entry.fields }),
        });
        expect(response.status).toBe(201);
        const result = await response.json();
        expect((result.skill ?? result).workspaceId ?? result.workspace_id).toBe(workspace.id);
      }
    });

    it(`keeps task, ownerless PAT and daemon credentials scoped: ${route}`, async () => {
      const { store, workspace, other, user, headers, app } = await fixture();
      store.createWorkspaceMember({ workspaceId: other.id, userId: user.id, name: user.name, role: "member" });
      const agent = store.createAgent({ workspaceId: workspace.id, name: "Task agent", provider: "claude" });
      const issue = store.createIssue({ workspaceId: workspace.id, title: "Task" });
      const task = store.createTask({ workspaceId: workspace.id, agentId: agent.id, issueId: issue.id, prompt: "Work" });
      const taskToken = await store.createTaskAccessToken(task, user.id);
      const pat = await store.createAccessToken({ workspaceId: workspace.id, name: "Scoped PAT", type: "pat" });
      const daemon = await store.createAccessToken({ workspaceId: workspace.id, name: "Daemon", type: "daemon", daemonId: "dmn_skills", userId: user.id });
      const foreign = store.createSkill({ workspaceId: other.id, name: "Other secret", createdBy: user.id });
      const contexts: Record<string, string>[] = [{ "X-Workspace-Slug": other.slug }, { "X-Workspace-ID": other.id }];
      for (const credential of [taskToken, pat, daemon]) {
        const auth = { ...headers, Authorization: `Bearer ${credential.token}` };
        for (const context of contexts) {
          for (const path of [route, `${route}/search?q=secret`, `${route}/${foreign.id}`]) {
            const response = await app.request(path, { headers: { ...auth, ...context } });
            expect([403, 404]).toContain(response.status);
          }
          const created = await app.request(route, {
            method: "POST", headers: { ...auth, ...context }, body: JSON.stringify({ name: "Unauthorized" }),
          });
          expect([403, 404]).toContain(created.status);
        }
        const inScope = await app.request(route, { headers: auth });
        expect(inScope.status).toBe(credential === daemon ? 403 : 200);
      }
      const foreignList = await app.request(`${route}?workspace_id=${other.id}`, { headers });
      const result = await foreignList.json();
      expect((result.skills ?? result).map((item: { name: string }) => item.name)).toEqual(["Other secret"]);
    });
  }

  it("manages skill files using the authorized skill resource without workspace selectors", async () => {
    const { store, workspace, user, headers, app } = await fixture();
    const skill = store.createSkill({ workspaceId: workspace.id, name: "Files", createdBy: user.id });
    const created = await app.request(`/api/skills/${skill.id}/files`, {
      method: "PUT", headers, body: JSON.stringify({ path: "notes.md", content: "Team notes" }),
    });
    expect(created.status).toBe(200);
    const file = await created.json();
    const listed = await app.request(`/api/skills/${skill.id}/files`, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).map((item: { content: string }) => item.content)).toEqual(["Team notes"]);
    const deleted = await app.request(`/api/skills/${skill.id}/files/${file.id}`, { method: "DELETE", headers });
    expect(deleted.status).toBe(204);
  });
});
