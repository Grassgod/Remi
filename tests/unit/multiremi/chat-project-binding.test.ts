import { afterEach, describe, expect, it } from "bun:test";
import { ChatValidationError } from "@multiremi/store/repos/chat-repo.js";
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

  it("keeps the creation-time Project and provider lineage through ordinary updates", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    for (const projectId of [project.id, null]) {
      const chat = store.createChatSession({ agentId: agent.id, projectId });
      db!.run(`UPDATE multiremi_chat_sessions SET session_id = 'old-session', work_dir = '/tmp/old',
        session_runtime_id = 'rt_old', session_provider = 'codex', session_execution_fingerprint = 'old' WHERE id = ?`, [chat.id]);
      expect(store.updateChatSession(chat.id, { title: "Rename", pinned: true })).toMatchObject({
        title: "Rename", pinned: true, projectId, sessionId: "old-session", workDir: "/tmp/old",
        sessionRuntimeId: "rt_old", sessionProvider: "codex", sessionExecutionFingerprint: "old",
      });
      const before = store.getChatSession(chat.id);
      for (const field of ["projectId", "project_id"]) {
        for (const value of [project.id, null, "missing"]) {
          expect(() => store.updateChatSession(chat.id, { [field]: value, title: "Rejected" } as any))
            .toThrow("A Chat Project can only be selected when creating the session");
          expect(store.getChatSession(chat.id)).toEqual(before);
        }
      }
    }
  });

  it("allows ordinary updates and still cancels all unfinished states when archiving", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    for (const status of ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"]) {
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const task = store.sendChatMessage(chat.id, { body: "Working" }).task;
      db!.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, task.id]);
      expect(store.updateChatSession(chat.id, { title: "Rename", pinned: true })).toMatchObject({
        title: "Rename", pinned: true, projectId: project.id,
      });
      expect(store.updateChatSession(chat.id, { status: "archived" }).projectId).toBe(project.id);
      expect(store.getTask(task.id)?.status).toBe("cancelled");
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
    const plainChat = store.createChatSession({ agentId: agent.id });
    const plain = store.getTaskWithAgent(store.sendChatMessage(plainChat.id, { body: "Pure Chat" }).task.id)!;
    expect(plain).toMatchObject({ project: null, projectResources: [], projectDocs: null, repos: [], chatProjectId: null });
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

  for (const unavailable of ["archived", "deleted"] as const) {
    it(`falls back to pure Chat when its fixed Project is ${unavailable}, including stale claims and directory routing`, () => {
      const store = createStore();
      const directory = store.registerRuntime({ name: "Directory", provider: "codex", daemonId: "project-directory" });
      const available = store.registerRuntime({ name: "Available", provider: "codex", daemonId: "available" });
      const agent = store.createAgent({ name: "Chat", provider: "codex" });
      store.updateWorkspaceRepositories("local", [{ id: "repo_chat_fixed", name: "project", url: "https://github.com/example/project.git", source: "github" }]);
      const project = store.createProject({ title: "Fixed Project", resources: [
        { resourceType: "github_repo", resourceRef: { url: "https://github.com/example/project.git" } },
        { resourceType: "local_directory", resourceRef: { local_path: "/abs/project", daemon_id: "project-directory" } },
      ] });
      store.createProjectDevice(project.id, { daemonId: "project-directory" });
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const task = store.sendChatMessage(chat.id, { body: "Queued before Project is unavailable" }).task;
      expect(task.runtimeId).toBe(directory.id);
      const retained = store.getTaskWithAgent(task.id)!;
      if (unavailable === "archived") store.archiveProject(project.id);
      else db!.run("DELETE FROM multiremi_projects WHERE id = ?", [project.id]);
      expect(store.getChatSession(chat.id)?.projectId).toBe(project.id);
      const hydrated = store.getTaskWithAgent(task.id)!;
      expect(hydrated).toMatchObject({ project: null, projectResources: [], projectDocs: null, repos: [] });
      expect(hydrated.chatAutoCheckoutRepos ?? []).toEqual([]);
      for (const candidate of [retained, hydrated]) {
        const wire = daemonTaskClaimResponse(store, candidate);
        for (const field of ["project", "project_resources", "chat_project_id", "chat_auto_checkout_repos", "repos"]) {
          expect(wire).not.toHaveProperty(field);
        }
      }
      expect(store.claimTask(available.id)).toMatchObject({ id: task.id, project: null, repos: [] });
      store.startTask(task.id);
      store.completeTask(task.id, { output: "Chat continues" });
      const next = store.sendChatMessage(chat.id, { body: "Still usable" }).task;
      expect(next.runtimeId).toBeNull();
      expect(store.claimTask(available.id)?.id).toBe(next.id);
      // Provider changes also consult the shared directory-affinity helper.
      store.updateAgent(agent.id, { provider: "claude" });
    });
  }

  for (const unavailable of ["archived", "deleted"] as const) {
    for (const source of ["local_directory", "dedicated_runtime"] as const) {
      it(`starts cold once after a completed ${source} Chat loses its ${unavailable} Project, then resumes pure Chat`, () => {
        const store = createStore();
        const previous = store.registerRuntime({ name: "Project runtime", provider: "codex", daemonId: "project-owner" });
        const available = store.registerRuntime({ name: "Pool runtime", provider: "codex", daemonId: "chat-pool" });
        const agent = store.createAgent({ name: "Chat", provider: "codex" });
        const project = store.createProject({ title: "Project", resources: source === "local_directory" ? [
          { resourceType: "local_directory", resourceRef: { local_path: "/abs/user-project", daemon_id: "project-owner" } },
        ] : [] });
        store.createProjectDevice(project.id, { daemonId: "project-owner" });
        if (source === "dedicated_runtime") store.updateDaemonDedicated("local", "project-owner", true, "local");
        const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
        const first = store.sendChatMessage(chat.id, { body: "Work with the Project" }).task;
        expect(store.claimTask(previous.id)?.id).toBe(first.id);
        store.startTask(first.id);
        const previousWorkDir = source === "local_directory" ? "/abs/user-project" : `/old-platform/workspaces/chats/${chat.id}`;
        store.completeTask(first.id, { output: "Project work", sessionId: "project-provider-session", workDir: previousWorkDir });
        expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: "project-provider-session", workDir: previousWorkDir });
        if (unavailable === "archived") store.archiveProject(project.id);
        else db!.run("DELETE FROM multiremi_projects WHERE id = ?", [project.id]);

        const second = store.sendChatMessage(chat.id, { body: "Continue as pure Chat" }).task;
        expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: null, workDir: null,
          sessionRuntimeId: null, sessionProvider: null, sessionExecutionFingerprint: null });
        // A dedicated Project machine cannot claim projectless work. A pool
        // machine must be able to claim this turn without inheriting its path.
        if (source === "dedicated_runtime") expect(store.claimTask(previous.id)).toBeNull();
        const fallback = store.claimTask(available.id);
        expect(fallback).toMatchObject({ id: second.id, project: null, sessionId: null, workDir: null, repos: [] });
        expect(fallback?.projectResources).toEqual([]);
        store.startTask(second.id);
        const managedWorkDir = `/chat-pool/workspaces/chats/${chat.id}`;
        store.completeTask(second.id, { output: "Pure Chat", sessionId: "pure-provider-session", workDir: managedWorkDir });

        const third = store.sendChatMessage(chat.id, { body: "Keep this pure context" }).task;
        expect(third).toMatchObject({ sessionId: "pure-provider-session", workDir: managedWorkDir, runtimeId: available.id });
        const resumed = store.claimTask(available.id);
        expect(resumed).toMatchObject({ id: third.id, project: null, sessionId: "pure-provider-session", workDir: managedWorkDir });
        expect(store.getChatSession(chat.id)?.projectId).toBe(project.id);
      });
    }
  }

  it("clears legacy workDir-only lineage and does not promote a late Project completion", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const first = store.sendChatMessage(chat.id, { body: "First" }).task;
    store.claimTask(runtime.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "First", sessionId: "legacy-project-session", workDir: "/abs/user-project" });
    const second = store.sendChatMessage(chat.id, { body: "Still working" }).task;
    const retained = store.claimTask(runtime.id)!;
    store.startTask(second.id);
    db!.run("UPDATE multiremi_chat_sessions SET session_id = NULL, session_execution_fingerprint = NULL WHERE id = ?", [chat.id]);
    store.archiveProject(project.id);
    const staleWire = daemonTaskClaimResponse(store, retained);
    expect(staleWire).not.toHaveProperty("prior_work_dir");
    expect(staleWire).not.toHaveProperty("session_id");
    store.completeTask(second.id, { output: "Late result", sessionId: "late-project-session", workDir: "/abs/user-project" });
    expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: null, workDir: null,
      sessionRuntimeId: null, sessionProvider: null, sessionExecutionFingerprint: null });
    const fallback = store.sendChatMessage(chat.id, { body: "Pure Chat" }).task;
    expect(fallback).toMatchObject({ sessionId: null, workDir: null, runtimeId: null });
    expect(store.claimTask(runtime.id)).toMatchObject({ id: fallback.id, sessionId: null, workDir: null });
  });

  it("drops an old retained claim's cwd after the same dispatched task is reclaimed in fallback mode", () => {
    const store = createStore();
    const previous = store.registerRuntime({ name: "Previous", provider: "codex", daemonId: "project-owner" });
    const replacement = store.registerRuntime({ name: "Replacement", provider: "codex", daemonId: "chat-pool" });
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Project", resources: [
      { resourceType: "local_directory", resourceRef: { local_path: "/abs/user-project", daemon_id: "project-owner" } },
    ] });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const first = store.sendChatMessage(chat.id, { body: "First" }).task;
    store.claimTask(previous.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "First", sessionId: "old-session", workDir: "/abs/user-project" });
    const second = store.sendChatMessage(chat.id, { body: "Queued" }).task;
    const retained = store.claimTask(previous.id)!;
    expect(retained).toMatchObject({ id: second.id, sessionId: "old-session", workDir: "/abs/user-project" });
    store.archiveProject(project.id);
    // Fresh dispatches are already leased: another poll must not relabel an
    // in-flight execution. Only the existing stale-claim recovery window can.
    expect(store.claimTask(replacement.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({ status: "dispatched", runtimeId: previous.id,
      executionFingerprint: retained.executionFingerprint, sessionId: "old-session", workDir: "/abs/user-project" });
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", second.id]);
    const fallback = store.claimTask(replacement.id)!;
    expect(fallback).toMatchObject({ id: second.id, sessionId: null, workDir: null, project: null });
    expect(fallback.executionFingerprint).not.toBe(retained.executionFingerprint);
    const wire = daemonTaskClaimResponse(store, retained);
    for (const field of ["prior_work_dir", "session_id", "prior_session_id", "project", "project_resources"]) {
      expect(wire).not.toHaveProperty(field);
    }
  });

  for (const target of ["same_runtime", "new_runtime"] as const) {
    it(`preserves frozen Plugins while a fallback retry selects credentials for ${target}`, () => {
      const store = createStore();
      const metadata = { codex_profiles: 1, agent_plugin_protocol: 1 };
      const previous = store.registerRuntime({ name: "Previous", provider: "codex", daemonId: "project-owner", metadata });
      const replacement = store.registerRuntime({ name: "Replacement", provider: "codex", daemonId: "chat-pool", metadata });
      const profile = { name: "old", base_url: "http://127.0.0.1:8001/v1", model: "test-model", env_key: "REMI_CODEX_TEST_PROFILE", auth_mode: "env" as const };
      const newProfile = { ...profile, name: "new", base_url: "http://127.0.0.1:8002/v1" };
      store.setRuntimeCodexProfile(previous.id, profile);
      store.setRuntimeCodexProfile(replacement.id, newProfile);
      const agent = store.createAgent({ name: "Chat", provider: "codex" });
      const project = store.createProject({ title: "Project" });
      store.createProjectDevice(project.id, { daemonId: "project-owner" });
      if (target === "new_runtime") store.updateDaemonDedicated("local", "project-owner", true, "local");
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const first = store.sendChatMessage(chat.id, { body: "First" }).task;
      const frozen = store.claimTask(previous.id)!;
      store.startTask(first.id);
      store.failTask(first.id, { error: "Temporary outage", failureReason: "runtime_offline", sessionId: "old-session", workDir: "/abs/old" });
      const retry = store.listTasks().find((candidate) => candidate.parentTaskId === first.id)!;
      expect(retry.codexProfile).toEqual(profile);
      const plugin = store.importAgentPlugin({ provider: "codex", manifest: { name: "later-plugin", version: "1.0.0" },
        files: [{ path: "skills/later-plugin/SKILL.md", content: "# Later plugin" }] });
      store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
      expect(store.resolveAgentPluginSnapshot(agent.id)).toHaveLength(1);
      // Mutable same-runtime configuration must not overwrite a frozen retry.
      store.setRuntimeCodexProfile(previous.id, { ...profile, name: "changed", model: "changed-model" });
      store.archiveProject(project.id);
      const selected = target === "same_runtime" ? previous : replacement;
      const claimed = store.claimTask(selected.id)!;
      expect(claimed).toMatchObject({ id: retry.id, provider: "codex", sessionId: null, workDir: null });
      expect(claimed.pluginSnapshot).toEqual(frozen.pluginSnapshot);
      expect(claimed.pluginSnapshot).toEqual([]);
      expect(claimed.codexProfile).toEqual(target === "same_runtime" ? profile : newProfile);
      expect(claimed.executionFingerprint).not.toBe(frozen.executionFingerprint);
    });
  }

  for (const route of ["/api/chat/sessions", "/api/multiremi/chats"]) {
    it(`allows binding only at creation and rejects both update spellings through ${route}`, async () => {
      const store = createStore();
      const agent = store.createAgent({ name: "Chat", provider: "codex" });
      const project = store.createProject({ title: "Project" });
      const other = store.createWorkspace({ name: "Other", slug: "foreign-project" });
      const foreign = store.createProject({ title: "Foreign", workspaceId: other.id });
      const app = createMultiremiApp({ store, authToken: "root-secret" });
      const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
      for (const createField of ["projectId", "project_id"]) {
        const created = await app.request(route, { method: "POST", headers,
          body: JSON.stringify({ agent_id: agent.id, [createField]: project.id }) });
        expect(created.status).toBe(201);
        const raw = await created.json();
        const chat = raw.session ?? raw;
        expect(chat.projectId ?? chat.project_id).toBe(project.id);
        const update = (body: object) => app.request(`${route}/${chat.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
        const before = store.getChatSession(chat.id);
        for (const updateField of ["projectId", "project_id"]) {
          for (const value of [project.id, foreign.id, "missing", false, "", null]) {
            const response = await update({ [updateField]: value, title: "Rejected" });
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: "A Chat Project can only be selected when creating the session" });
            expect(store.getChatSession(chat.id)).toEqual(before);
          }
        }
        const pending = store.sendChatMessage(chat.id, { body: "Pending" }).task;
        for (const status of ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"]) {
          db!.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, pending.id]);
          expect((await update({ project_id: null })).status).toBe(400);
          expect((await update({ title: "Rename", pinned: true })).status).toBe(200);
        }
        expect((await update({ status: "archived" })).status).toBe(200);
        expect(store.getTask(pending.id)?.status).toBe("cancelled");
        expect(store.getChatSession(chat.id)?.projectId).toBe(project.id);
      }
      for (const projectId of [foreign.id, "missing", false, ""]) {
        const invalid = await app.request(route, { method: "POST", headers,
          body: JSON.stringify({ agent_id: agent.id, project_id: projectId }) });
        expect(invalid.status).toBe(400);
      }
    });
  }
});
