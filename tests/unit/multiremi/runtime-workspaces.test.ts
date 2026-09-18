import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Laptop Codex", provider: "codex", daemonId: "laptop", workspaceId: "local", metadata: { runtime_workspaces: 1 }, maxConcurrency: 4 });
  const workspace = store.runtimeWorkspaces.create(runtime.id, { name: "Local research", root_path: "/home/user/research", cwd: ".", context_paths: ["AGENTS.md"] });
  const agent = store.createAgent({ name: "Researcher", provider: "codex", maxConcurrentTasks: 4 });
  return { store, runtime, workspace, agent };
}

describe("Runtime-owned workspaces", () => {
  it("serializes different Agents sharing a local directory while allowing another directory", () => {
    const { store, runtime, workspace, agent } = fixture();
    const peer = store.createAgent({ name: "Peer", provider: "codex", maxConcurrentTasks: 4 });
    const otherWorkspace = store.runtimeWorkspaces.create(runtime.id, { name: "Other directory", root_path: "/home/user/other" });
    const first = store.createTask({ agentId: agent.id, runtimeWorkspaceId: workspace.id, prompt: "First" });
    const second = store.createTask({ agentId: peer.id, runtimeWorkspaceId: workspace.id, prompt: "Second" });
    const independent = store.createTask({ agentId: peer.id, runtimeWorkspaceId: otherWorkspace.id, prompt: "Independent" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.getTaskQueueBlocker(second.id)?.taskId).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(independent.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.cancelTask(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
  });

  it("keeps side discussions independent from their Issue's runtime workspace", () => {
    const { store, runtime, workspace, agent } = fixture();
    const other = store.registerRuntime({ name: "Discussion host", provider: "codex", daemonId: "discussion-host", workspaceId: "local" });
    const issue = store.createIssue({ title: "Work in local files", runtimeWorkspaceId: workspace.id });
    const mainSession = store.getOrCreateDefaultIssueSession(issue.id);
    const sideSession = store.createIssueSession(issue.id, { title: "Discuss", parentSessionId: mainSession.id });
    const main = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: mainSession.id, prompt: "Implement" });
    const side = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: sideSession.id, prompt: "Explain" });
    expect(main.runtimeWorkspaceId).toBe(workspace.id);
    expect(side.holdsWorkspace).toBe(false);
    expect(side.runtimeWorkspaceId).toBeNull();
    expect(() => store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: sideSession.id,
      runtimeWorkspaceId: workspace.id, prompt: "Cannot attach local files" })).toThrow("without workspace ownership");
    expect(store.claimTask(runtime.id)?.id).toBe(main.id);
    expect(store.claimTask(other.id)?.id).toBe(side.id);
    const sideWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(side.id)!);
    expect(sideWire.runtime_workspace_id).toBeNull();
    expect(sideWire.runtime_workspace).toBeNull();
    store.startTask(side.id);
    store.failTask(side.id, { error: "runtime unavailable", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((task) => task.parentTaskId === side.id)!;
    expect(retry).toBeDefined();
    expect(retry.holdsWorkspace).toBe(false);
    expect(retry.runtimeWorkspaceId).toBeNull();
    expect(store.claimTask(other.id)?.id).toBe(retry.id);
    expect(store.getTask(main.id)?.runtimeWorkspaceId).toBe(workspace.id);
    expect(store.getIssue(issue.id)?.runtimeWorkspaceId).toBe(workspace.id);
  });

  it("lists Runtime directories using workspace slugs and rejects unknown slugs", async () => {
    const { store, workspace } = fixture();
    const app = createMultiremiApp({ store });
    const slug = store.getWorkspace("local")!.slug;
    const response = await app.request("/api/runtime-workspaces", { headers: { "X-Workspace-Slug": slug } });
    expect(response.status).toBe(200);
    expect((await response.json()).workspaces.map((item: { id: string }) => item.id)).toEqual([workspace.id]);
    const missing = await app.request("/api/runtime-workspaces", { headers: { "X-Workspace-Slug": "missing-workspace" } });
    expect(missing.status).toBe(404);
  });

  it("binds a native Issue to a Runtime directory in the workspace selected by its slug", async () => {
    const { store } = fixture();
    const tenant = store.createWorkspace({ name: "Team", slug: "runtime-directory-team" });
    const runtime = store.registerRuntime({ name: "Team machine", provider: "codex", daemonId: "team-machine", workspaceId: tenant.id });
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "Team files", root_path: "/home/user/team" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/multiremi/issues", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Workspace-Slug": tenant.slug },
      body: JSON.stringify({ title: "Use selected team directory", runtimeWorkspaceId: directory.id }),
    });
    expect(response.status).toBe(201);
    expect(store.listIssues({ workspaceId: tenant.id })[0]?.runtimeWorkspaceId).toBe(directory.id);
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
  });

  it("runs independent Chats on the owning daemon and serializes a shared workspace", () => {
    const { store, runtime, workspace, agent } = fixture();
    const other = store.registerRuntime({ name: "Other laptop", provider: "codex", daemonId: "other", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    const first = store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id });
    const second = store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id });
    const t1 = store.sendChatMessage(first.id, { body: "Inspect local context" }).task;
    const t2 = store.sendChatMessage(second.id, { body: "Reuse local dependencies" }).task;
    expect(t1.runtimeWorkspaceId).toBe(workspace.id);
    expect(store.claimTask(other.id)).toBeNull();
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(t1.id);
    expect(claimed.runtimeWorkspace?.rootPath).toBe(workspace.rootPath);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(() => store.runtimeWorkspaces.archive(workspace.id)).toThrow("Finish or cancel tasks");
    store.cancelTask(t1.id);
    expect(store.claimTask(runtime.id)?.id).toBe(t2.id);
    store.cancelTask(t2.id);
    store.deleteChatSession(first.id);
    store.deleteChatSession(second.id);
    expect(store.runtimeWorkspaces.get(workspace.id)?.archivedAt).toBeNull();
    store.runtimeWorkspaces.archive(workspace.id);
    expect(() => store.createTask({ agentId: agent.id, prompt: "run", runtime_workspace_id: workspace.id })).toThrow("archived");
  });

  it("allows another provider on the same daemon but parks work for legacy or missing runtimes", () => {
    const { store, runtime, workspace } = fixture();
    const claude = store.registerRuntime({ name: "Laptop Claude", provider: "claude", daemonId: "laptop", workspaceId: "local" });
    const agent = store.createAgent({ name: "Writer", provider: "claude" });
    const issue = store.createIssue({ title: "Local-only Issue", runtime_workspace_id: workspace.id });
    const task = store.createTask({ issueId: issue.id, agentId: agent.id, prompt: "Inspect" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.claimTask(claude.id)).toBeNull();
    store.registerRuntime({ id: claude.id, name: claude.name, provider: "claude", daemonId: "laptop", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    expect(store.claimTask(claude.id)?.id).toBe(task.id);
    expect(() => store.updateIssue(issue.id, { runtime_workspace_id: null })).toThrow("executed Issue");
    store.cancelTask(task.id);
    store.deleteIssue(issue.id);
    expect(store.runtimeWorkspaces.get(workspace.id)).not.toBeNull();
  });

  it("retains standalone task bindings through infrastructure retries and Runtime replacement", () => {
    const { store, runtime, workspace, agent } = fixture();
    store.registerRuntime({ name: "Laptop Claude", provider: "claude", daemonId: "laptop", workspaceId: "local" });
    const other = store.registerRuntime({ name: "Other", provider: "codex", daemonId: "other", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    const task = store.createTask({ agentId: agent.id, prompt: "Use local context", runtime_workspace_id: workspace.id, maxAttempts: 2 });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(store.recoverOrphans(runtime.id)).toEqual({ orphaned: 1, retried: 1 });
    const retry = store.listTasks().find(t => t.parentTaskId === task.id)!;
    expect(retry.runtimeWorkspaceId).toBe(workspace.id);
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(store.runtimeWorkspaces.get(workspace.id)?.daemonId).toBe("laptop");
    const replacement = store.registerRuntime({ name: "Laptop Codex", provider: "codex", daemonId: "laptop", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    expect(replacement.id).not.toBe(runtime.id);
    expect(store.claimTask(replacement.id)?.id).toBe(retry.id);
  });

  it("rejects cross-tenant bindings and paths outside the configured root", () => {
    const { store, runtime, workspace } = fixture();
    store.createWorkspace({ id: "other", name: "Other", slug: "other" });
    expect(() => store.createIssue({ title: "Wrong tenant", workspaceId: "other", runtime_workspace_id: workspace.id })).toThrow("not found");
    for (const cwd of ["../private", "/etc", "C:\\Windows", "repo/../../private"]) {
      expect(() => store.runtimeWorkspaces.create(runtime.id, { name: "Invalid", root_path: "/local", cwd })).toThrow("inside root_path");
    }
    expect(() => store.runtimeWorkspaces.create(runtime.id, { name: "Relative", root_path: "research" })).toThrow("absolute");
    expect(() => store.runtimeWorkspaces.create(runtime.id, { name: "Duplicate", root_path: workspace.rootPath })).toThrow("already registered");
  });

  it("keeps Issue workspace selection explicit and validates batch binding access", async () => {
    const { store, workspace } = fixture();
    const parent = store.createIssue({ title: "Parent", runtime_workspace_id: workspace.id });
    const child = store.createIssue({ title: "Child", parent_issue_id: parent.id, runtime_workspace_id: null });
    expect(child.runtimeWorkspaceId).toBeNull();
    const foreign = store.registerRuntime({ name: "Private machine", provider: "codex", daemonId: "private", workspaceId: "local", ownerId: "someone-else", visibility: "private" });
    const privateWorkspace = store.runtimeWorkspaces.create(foreign.id, { name: "Private", root_path: "/private" });
    const app = createMultiremiApp({ store });
    for (const prefix of ["/api", "/api/multiremi"]) {
      const request = (id: string | null) => app.request(`${prefix}/issues/batch-update`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_ids: [child.id], updates: { runtime_workspace_id: id } }),
      });
      expect((await request(privateWorkspace.id)).status).toBe(403);
      expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBeNull();
      const bound = await request(workspace.id);
      expect(bound.status).toBe(200);
      expect((await bound.json()).updated).toBe(1);
      expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBe(workspace.id);
      expect((await request(null)).status).toBe(200);
      expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBeNull();
    }
  });

  it("provides Web/CLI registration, listing, Chat/Issue binding and non-destructive archive APIs", async () => {
    const { store, runtime, agent } = fixture();
    const app = createMultiremiApp({ store });
    const request = (path: string, method: string, body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const registered = await request(`/api/runtimes/${runtime.id}/workspaces`, "POST", { name: "Private notes", root_path: "C:\\notes", context_paths: ["AGENTS.md"] });
    expect(registered.status).toBe(201);
    const item = await registered.json();
    expect(item.status).toBe("available");
    expect((await (await request("/api/runtime-workspaces", "GET")).json()).workspaces).toHaveLength(2);
    const chat = await request("/api/chat/sessions", "POST", { agent_id: agent.id, runtime_workspace_id: item.id });
    expect(chat.status).toBe(201);
    expect((await chat.json()).runtime_workspace_id).toBe(item.id);
    const issue = await request("/api/issues", "POST", { title: "No cloud Git", runtime_workspace_id: item.id });
    expect(issue.status).toBe(201);
    expect((await issue.json()).runtime_workspace_id).toBe(item.id);
    expect((await request(`/api/runtime-workspaces/${item.id}`, "PATCH", { root_path: "/changed" })).status).toBe(400);
    expect((await request(`/api/runtime-workspaces/${item.id}`, "DELETE")).status).toBe(200);
    expect(store.runtimeWorkspaces.get(item.id)?.rootPath).toBe("C:\\notes");
  });
});


it("assigns either a project or directory, replaces single-field selections, and preserves execution locks", () => {
  const { store, workspace, agent } = fixture();
  const project = store.createProject({ title: "Remi" });
  const parent = store.createIssue({ title: "Parent", projectId: project.id });
  expect(() => store.createIssue({ title: "Ambiguous", project_id: project.id, runtime_workspace_id: workspace.id })).toThrow("either a project");
  const child = store.createIssue({ title: "Local child", parentIssueId: parent.id, runtime_workspace_id: workspace.id });
  expect(child.projectId).toBeNull();
  expect(store.createIssue({ title: "Independent", parentIssueId: parent.id, project_id: null }).projectId).toBeNull();
  const toProject = store.updateIssue(child.id, { project_id: project.id });
  expect(toProject.runtimeWorkspaceId).toBeNull();
  expect(toProject.projectId).toBe(project.id);
  const toDirectory = store.updateIssue(child.id, { runtime_workspace_id: workspace.id });
  expect(toDirectory.projectId).toBeNull();
  expect(toDirectory.runtimeWorkspaceId).toBe(workspace.id);
  expect(() => store.updateIssue(child.id, { project_id: project.id, runtime_workspace_id: workspace.id })).toThrow("either a project");
  store.createTask({ agentId: agent.id, issueId: child.id, prompt: "Run" });
  expect(() => store.updateIssue(child.id, { project_id: project.id })).toThrow("executed Issue");
  expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBe(workspace.id);
  expect(store.getIssue(child.id)?.projectId).toBeNull();
});

it("quick-creates a local intake and instructs its agent to preserve the directory on execution issues", async () => {
  const { store, workspace, agent, runtime } = fixture();
  const app = createMultiremiApp({ store });
  const response = await app.request("/api/issues/quick-create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agent.id, prompt: "Inspect my local notes", runtime_workspace_id: workspace.id }) });
  expect(response.status).toBe(202);
  const body = await response.json() as { task_id: string; issue: { runtime_workspace_id: string; project_id: string | null } };
  expect(body.issue.runtime_workspace_id).toBe(workspace.id);
  expect(body.issue.project_id).toBeNull();
  const task = store.getTask(body.task_id)!;
  expect(task.runtimeWorkspaceId).toBe(workspace.id);
  expect(task.prompt).toContain(`--runtime-workspace ${workspace.id}`);
  expect(task.prompt).not.toContain("Inspect the workspace's existing active projects");
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
});


it("binds a project's context and device routing to Chat while rejecting Issue binding", async () => {
  const { store, runtime, workspace, agent } = fixture();
  const repoUrl = "https://github.com/example/chat-location.git";
  store.updateWorkspaceRepositories("local", [{ id: "repo_chat_location", name: "chat-location", url: repoUrl, source: "github" }]);
  const project = store.createProject({ title: "Chosen project", resources: [{ resourceType: "github_repo", resourceRef: { url: repoUrl } }] });
  store.createProjectDevice(project.id, { daemonId: "laptop", createdBy: "local" });
  const other = store.registerRuntime({ name: "Other", provider: "codex", daemonId: "other", workspaceId: "local" });
  const otherProject = store.createProject({ title: "Linked issue project" });
  const issue = store.createIssue({ title: "Reference only", projectId: otherProject.id });
  const app = createMultiremiApp({ store });
  const response = await app.request("/api/chat/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agent.id, project_id: project.id, issue_id: issue.id }) });
  expect(response.status).toBe(400);
  const created = await app.request("/api/chat/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agent.id, project_id: project.id }) });
  expect(created.status).toBe(201);
  const chat = await created.json() as { id: string; project_id: string };
  expect(chat.project_id).toBe(project.id);
  const task = store.sendChatMessage(chat.id, { body: "Inspect the selected project" }).task;
  expect(store.getTaskWithAgent(task.id)?.project?.id).toBe(project.id);
  expect(store.getTaskWithAgent(task.id)?.chatAutoCheckoutRepos?.map((repo) => repo.url)).toEqual([repoUrl]);
  expect(store.claimTask(other.id)).toBeNull();
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.cancelTask(task.id);
  expect(() => store.createChatSession({ agentId: agent.id, project_id: project.id, runtime_workspace_id: workspace.id })).toThrow("either a project");
  expect(() => store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id, issueId: issue.id } as any)).toThrow("cannot be bound to an Issue");
  const local = store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id });
  const localTask = store.sendChatMessage(local.id, { body: "Inspect local files" }).task;
  expect(store.getTaskWithAgent(localTask.id)?.project).toBeNull();
  expect(store.getTaskWithAgent(localTask.id)?.projectContexts).toEqual([]);
  const localClaim = store.claimTask(runtime.id)!;
  expect(localClaim.id).toBe(localTask.id);
  expect(localClaim.chatProjectId).toBeNull();
  expect(localClaim.chatAutoCheckoutRepos ?? []).toEqual([]);
  const wire = daemonTaskClaimResponse(store, localClaim);
  expect(wire.runtime_workspace_id).toBe(workspace.id);
  expect(wire.runtime_workspace).toMatchObject({ rootPath: workspace.rootPath });
  expect(wire).not.toHaveProperty("chat_project_id");
  expect(wire).not.toHaveProperty("project");
  expect(wire.chat_auto_checkout_repos ?? []).toEqual([]);
  const changed = await app.request(`/api/chat/sessions/${chat.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: otherProject.id }) });
  expect(changed.status).toBe(400);
  expect(store.getChatSession(chat.id)?.projectId).toBe(project.id);
  store.createWorkspace({ id: "foreign", name: "Foreign", slug: "foreign" });
  const foreign = store.createProject({ title: "Foreign", workspaceId: "foreign" });
  expect(() => store.createChatSession({ agentId: agent.id, projectId: foreign.id })).toThrow("Project must exist");
});
