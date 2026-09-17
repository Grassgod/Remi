import { afterEach, describe, expect, it } from "bun:test";
import { ChatConflictError, ChatValidationError } from "@multiremi/store/repos/chat-repo.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { daemonRuntimeId } from "@multiremi/store.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Chat Project binding", () => {
  it("creates optional Project bindings with explicit null taking precedence over the alias", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Project context" });
    const create = (fields = {}) => store.createChatSession({ agentId: agent.id, ...fields });
    expect(create().projectId).toBeNull();
    expect(create({ projectId: project.id }).projectId).toBe(project.id);
    expect(create({ project_id: project.id }).projectId).toBe(project.id);
    expect(create({ projectId: null, project_id: project.id }).projectId).toBeNull();
    expect(store.listChatSessions().filter((chat) => chat.projectId === project.id)).toHaveLength(2);
  });

  it("rejects missing, foreign, archived and malformed Projects", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const other = store.createWorkspace({ name: "Other", slug: "chat-project-other" });
    const foreign = store.createProject({ title: "Foreign", workspaceId: other.id });
    const archived = store.createProject({ title: "Archived" });
    store.archiveProject(archived.id);
    for (const projectId of [foreign.id, archived.id, "missing", "", 123]) {
      expect(() => store.createChatSession({ agentId: agent.id, projectId } as any)).toThrow(ChatValidationError);
    }
  });

  it("binds, rebinds and detaches with a cold provider session, keeping ordinary updates warm", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const first = store.createProject({ title: "First" });
    const second = store.createProject({ title: "Second" });
    const chat = store.createChatSession({ agentId: agent.id });
    for (const projectId of [first.id, second.id, null]) {
      db!.run(`UPDATE multiremi_chat_sessions SET session_id = 'old-session', work_dir = '/tmp/old',
        session_runtime_id = 'rt_old', session_provider = 'codex', session_execution_fingerprint = 'old' WHERE id = ?`, [chat.id]);
      expect(store.updateChatSession(chat.id, { title: "Rename", pinned: true }).sessionId).toBe("old-session");
      expect(store.updateChatSession(chat.id, { projectId: store.getChatSession(chat.id)!.projectId }).sessionId).toBe("old-session");
      const changed = store.updateChatSession(chat.id, { projectId, project_id: first.id });
      expect(changed).toMatchObject({ projectId, sessionId: null, workDir: null,
        sessionRuntimeId: null, sessionProvider: null, sessionExecutionFingerprint: null });
      const next = store.sendChatMessage(chat.id, { body: "New context" });
      expect(next.task).toMatchObject({ sessionId: null, workDir: null, issueId: null, issueSessionId: null });
      expect(store.buildTaskSessionProjection(next.task.id)?.mode).toBe("bootstrap");
      store.cancelTask(next.task.id);
    }
  });

  it("rejects every unfinished task state on rebind or detach, but allows no-op updates", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const first = store.createProject({ title: "First" });
    const second = store.createProject({ title: "Second" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: first.id });
    const task = store.sendChatMessage(chat.id, { body: "Working" }).task;
    for (const status of ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"]) {
      db!.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, task.id]);
      for (const projectId of [second.id, null]) {
        expect(() => store.updateChatSession(chat.id, { projectId })).toThrow(ChatConflictError);
      }
      expect(store.updateChatSession(chat.id, { projectId: first.id, title: "Rename" }).projectId).toBe(first.id);
    }
  });

  it("hydrates only the bound Project and preserves the marker in daemon claims", () => {
    const store = createStore();
    store.updateWorkspaceRepositories("local", [{ id: "repo_chat_project", name: "project", url: "https://github.com/example/project.git", source: "github" }]);
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Context", instructions: "Project rules",
      resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/example/project.git" } }] });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "Describe project" }).task;
    const hydrated = store.getTaskWithAgent(task.id)!;
    expect(hydrated).toMatchObject({ chatProjectId: project.id, project: { id: project.id }, issue: null });
    expect(hydrated.repos.map((repo) => repo.url)).toEqual(["https://github.com/example/project.git"]);
    const wire = daemonTaskClaimResponse(store, hydrated);
    expect(wire.chat_project_id).toBe(project.id);
    expect(wire.project).toMatchObject({ id: project.id, instructions: "Project rules" });
    const stale = daemonTaskClaimResponse(store, { ...hydrated, chatProjectId: "wrong" });
    for (const field of ["project", "project_resources", "repos", "chat_project_id", "squad_context", "issue"]) {
      expect(stale).not.toHaveProperty(field);
    }
    const runtime = store.registerRuntime({ name: "Chat", provider: "codex" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "Finished context" });
    store.updateChatSession(chat.id, { projectId: null });
    const detached = store.getTaskWithAgent(store.sendChatMessage(chat.id, { body: "Pure Chat" }).task.id)!;
    expect(detached).toMatchObject({ project: null, projectResources: [], projectDocs: null, repos: [], chatProjectId: null });
    expect(daemonTaskClaimResponse(store, hydrated)).not.toHaveProperty("project");
  });

  it("pins directory Chat and resume-unsafe retries to its daemon, overriding explicit runtime choices", () => {
    const store = createStore();
    const directory = store.registerRuntime({ id: "rt_directory", name: "directory", provider: "codex", daemonId: "chat-directory" });
    const other = store.registerRuntime({ id: "rt_other", name: "other", provider: "codex", daemonId: "chat-other" });
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Directory", resources: [{ resourceType: "local_directory",
      resourceRef: { local_path: "/abs/chat-project", daemon_id: "chat-directory" } }] });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, runtimeId: other.id, prompt: "Work" });
    expect(task.runtimeId).toBe(directory.id);
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(directory.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.failTask(task.id, { error: "Stale session", failureReason: "agent_error.stale_session", sessionId: "unsafe" });
    const retry = store.listTasks().find((row) => row.parentTaskId === task.id)!;
    expect(retry).toMatchObject({ runtimeId: directory.id, sessionId: null });
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(directory.id)?.id).toBe(retry.id);
  });

  it("waits for a missing directory daemon and preserves its pin across provider changes", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const other = store.registerRuntime({ name: "other", provider: "codex", daemonId: "other" });
    const project = store.createProject({ title: "Offline directory", resources: [{ resourceType: "local_directory",
      resourceRef: { local_path: "/abs/chat-project", daemon_id: "missing" } }] });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "Wait" }).task;
    expect(task.runtimeId).toBe(daemonRuntimeId("missing", "codex"));
    expect(store.claimTask(other.id)).toBeNull();
    store.updateAgent(agent.id, { provider: "claude" });
    expect(store.getTask(task.id)?.runtimeId).toBe(daemonRuntimeId("missing", "claude"));
  });

  it("applies Project device routing to Chat, including dedicated daemons", () => {
    const store = createStore();
    const directory = store.registerRuntime({ id: "rt_device", name: "dedicated", provider: "codex", daemonId: "chat-device" });
    const other = store.registerRuntime({ name: "other", provider: "codex", daemonId: "other" });
    const project = store.createProject({ title: "Device project" });
    store.createProjectDevice(project.id, { daemonId: "chat-device" });
    store.updateDaemonDedicated("local", "chat-device", true, "local");
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "Use device" }).task;
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(directory.id)?.id).toBe(task.id);
  });

  for (const route of ["/api/chat/sessions", "/api/multiremi/chats"]) {
    it(`supports both binding spellings, validation and conflicts through ${route}`, async () => {
      const store = createStore();
      const agent = store.createAgent({ name: "Chat", provider: "codex" });
      const project = store.createProject({ title: "Project" });
      const other = store.createWorkspace({ name: "Other", slug: "foreign-project" });
      const foreign = store.createProject({ title: "Foreign", workspaceId: other.id });
      const app = createMultiremiApp({ store, authToken: "root-secret" });
      const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
      const created = await app.request(route, { method: "POST", headers,
        body: JSON.stringify({ agent_id: agent.id, project_id: project.id }) });
      expect(created.status).toBe(201);
      const raw = await created.json();
      const chat = raw.session ?? raw;
      expect(chat.projectId ?? chat.project_id).toBe(project.id);
      const update = (body: object) => app.request(`${route}/${chat.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
      for (const projectId of [foreign.id, "missing", false, ""]) {
        expect((await update({ projectId })).status).toBe(400);
      }
      const unbound = await update({ project_id: null });
      expect(unbound.status).toBe(200);
      expect(store.getChatSession(chat.id)?.projectId).toBeNull();
      expect((await update({ projectId: project.id })).status).toBe(200);
      store.sendChatMessage(chat.id, { body: "Pending" });
      expect((await update({ projectId: null })).status).toBe(409);
    });
  }
});
