import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { signIssueShareId } from "@multiremi/api/helpers/issue-share-tokens.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "compat-context@example.test", name: "Compat context" });
  const workspace = store.createWorkspace({ name: "Selected", slug: "compat-selected" }, user.id);
  const other = store.createWorkspace({ name: "Other", slug: "compat-other" }, user.id);
  const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Session", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "fixture-master", shareSecret: "fixture-share", backgroundJobs: false, projectKnowledge: new ProjectKnowledgeService(store, null, "sql") });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug };
  return { store, user, workspace, other, app, headers };
}

const requests = [
  { path: "/api/multiremi/notification-channels", method: "GET", status: 200 },
  { path: "/api/multiremi/notification-deliveries", method: "GET", status: 200 },
  { path: "/api/project-docs", method: "GET", status: 200 },
  { path: "/api/project-knowledge/migration", method: "GET", status: 200 },
  { path: "/api/project-knowledge/migration/backfill", method: "POST", body: { dry_run: true }, status: 200 },
  { path: "/api/project-knowledge/migration/verify", method: "POST", body: {}, status: 503 },
  { path: "/api/project-knowledge/migration/retry-failed", method: "POST", body: {}, status: 503 },
  { path: "/api/cli/context", method: "GET", status: 200 },
  { path: "/api/cli/capabilities", method: "GET", status: 200 },
];

describe("compatibility workspace request context", () => {
  it("scopes daemon runtime context when one machine ID is registered in two workspaces", async () => {
    const { store, user, workspace, other, app } = await fixture();
    const registrations = [];
    for (const [selected, provider] of [[workspace, "claude"], [other, "codex"]] as const) {
      const { token } = await store.createAccessToken({ workspaceId: selected.id, userId: user.id, type: "daemon", daemonId: "dmn_shared_context", name: "Daemon" });
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-Slug": selected.slug };
      const response = await app.request("/api/daemon/register", {
        method: "POST", headers,
        body: JSON.stringify({ workspace_id: selected.id, daemon_id: "dmn_shared_context", runtimes: [{ type: provider, name: `${provider} scoped runtime` }] }),
      });
      expect(response.status).toBe(200);
      registrations.push({ headers, selected, provider });
    }
    for (const { headers, selected, provider } of registrations) {
      const response = await app.request("/api/cli/context", { headers });
      expect(response.status).toBe(200);
      const context = await response.json();
      expect(context.workspace.id).toBe(selected.id);
      expect(context.current.runtimes.map((runtime: { provider: string }) => runtime.provider)).toEqual([provider]);
    }
  });

  for (const input of requests) {
    it(`${input.method} ${input.path} resolves slug and rejects unknown workspaces`, async () => {
      const { app, headers, workspace } = await fixture();
      const request = { method: input.method, ...("body" in input ? { body: JSON.stringify(input.body) } : {}) };
      expect((await app.request(input.path, { ...request, headers })).status).toBe(input.status);
      expect((await app.request(input.path, { ...request, headers: { ...headers, "X-Workspace-Slug": "missing" } })).status).toBe(404);
      expect((await app.request(input.path, { ...request, headers: { ...headers, "X-Workspace-ID": workspace.id, "X-Workspace-Slug": "missing" } })).status).toBe(input.status);
    });
  }

  it("keeps compatibility ID-header precedence and explicit notification body precedence", async () => {
    const { app, headers, workspace, other } = await fixture();
    const response = await app.request(`/api/cli/context?workspace_id=${workspace.id}`, { headers: { ...headers, "X-Workspace-ID": other.id } });
    expect(response.status).toBe(200);
    expect((await response.json()).workspace.id).toBe(other.id);
    const create = (extra: Record<string, unknown>) => app.request("/api/multiremi/notification-channels", {
      method: "POST", headers, body: JSON.stringify({ name: "Context channel", kind: "feishu_group", enabled: false, target: { chatId: "oc_test" }, event_types: ["*"], ...extra }),
    });
    const selected = await create({});
    expect(selected.status).toBe(201);
    expect((await selected.json()).channel.workspaceId).toBe(workspace.id);
    const explicit = await create({ workspaceId: other.id, workspace_id: workspace.id });
    expect(explicit.status).toBe(201);
    expect((await explicit.json()).channel.workspaceId).toBe(other.id);
  });

  it("does not let slug headers expand task or daemon CLI identities", async () => {
    const { store, user, workspace, other, app } = await fixture();
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Worker", provider: "claude" });
    const issue = store.createIssue({ workspaceId: workspace.id, title: "Scoped issue" });
    const task = store.createTask({ workspaceId: workspace.id, agentId: agent.id, issueId: issue.id, prompt: "Scope" });
    const taskToken = await store.createTaskAccessToken(task, user.id);
    const daemon = await store.createAccessToken({ workspaceId: workspace.id, userId: user.id, type: "daemon", daemonId: "dmn_compat_context", name: "Daemon" });
    for (const { token } of [taskToken, daemon]) {
      for (const path of ["/api/cli/context", "/api/cli/capabilities"]) {
        for (const slug of [other.slug, "missing"]) {
          const response = await app.request(path, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug } });
          expect(response.status).toBe(404);
        }
        expect((await app.request(path, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug } })).status).toBe(200);
      }
    }
  });

  it("keeps share CLI context pinned to the shared issue when a slug is supplied", async () => {
    const { store, workspace, other, app } = await fixture();
    const issue = store.createIssue({ workspaceId: workspace.id, title: "Shared issue" });
    const share = store.ensureIssueShare(issue.id, workspace.id, "local", 60);
    const headers = { "X-Remi-Share": signIssueShareId(share.id, "fixture-share") };
    for (const path of ["/api/cli/context", "/api/cli/capabilities"]) {
      expect((await app.request(path, { headers: { ...headers, "X-Workspace-Slug": workspace.slug } })).status).toBe(200);
      for (const slug of [other.slug, "missing"]) expect((await app.request(path, { headers: { ...headers, "X-Workspace-Slug": slug } })).status).toBe(404);
      expect((await app.request(path, { headers: { ...headers, "X-Workspace-ID": workspace.id, "X-Workspace-Slug": "missing" } })).status).toBe(200);
    }
  });
});
