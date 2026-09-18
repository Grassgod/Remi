import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
import { configureRepositoryWikiAutomation, createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture(options: { bound?: boolean; publisher?: boolean } = {}) {
  const store = createLocalStore();
  const agent = options.publisher
    ? configureRepositoryWikiAutomation(store).agent
    : store.createAgent({ name: "Chat knowledge contributor", provider: "codex" });
  const project = store.createProject({ title: "Chat Project" });
  const other = store.createProject({ title: "Other Project" });
  const chat = store.createChatSession({
    agentId: agent.id,
    projectId: options.bound === false ? null : project.id,
  });
  const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Record this finding" });
  db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [task.id]);
  const token = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
  const app = createMultiremiApp({ store, authToken: "chat-project-knowledge-test" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { store, agent, project, other, chat, task, app, headers };
}

describe("Chat Project knowledge scope", () => {
  it("exposes the bound Project through CLI context and the agent environment without an Issue", async () => {
    const { store, project, chat, task, app, headers } = await fixture();
    const response = await app.request("/api/cli/context", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).current).toMatchObject({
      chat: { id: chat.id },
      task: { id: task.id, issue_id: null },
      issue: null,
      project: { id: project.id },
    });
    const env = buildTaskEnv(store.getTaskWithAgent(task.id)!, {
      daemonPort: 6200, serverUrl: "https://cli.example.test",
    });
    expect(env.MULTIREMI_PROJECT_ID).toBe(project.id);
    expect(env.MULTIREMI_ISSUE_ID).toBeUndefined();
  });

  it("accepts Memory and Wiki proposals for the bound Project without granting direct publication", async () => {
    const { store, project, task, app, headers } = await fixture();
    for (const kind of ["memory", "wiki"] as const) {
      const response = await app.request(`/api/projects/${project.id}/docs`, {
        method: "POST", headers,
        body: JSON.stringify({ kind, title: `Chat ${kind}`, body: "A project finding" }),
      });
      expect(response.status).toBe(202);
      const result = await response.json();
      expect(store.getKnowledgeSubmission(result.submission_id)).toMatchObject({
        projectId: project.id,
        scope: kind === "wiki" ? "project_wiki" : "memory",
        sourceTaskId: task.id,
        sourceIssueId: null,
        sourceType: "agent",
      });
    }
    expect(store.listProjectDocs(project.id)).toEqual([]);

    const doc = store.createProjectDoc(project.id, { kind: "memory", title: "Existing", body: "Original" });
    const updated = await app.request(`/api/projects/${project.id}/docs/${doc.id}`, {
      method: "PUT", headers, body: JSON.stringify({ body: "Proposed update" }),
    });
    expect(updated.status).toBe(202);
    expect(store.getProjectDocByRef(project.id, doc.id)?.body).toBe("Original");
  });

  it("lets an already-authorized knowledge publisher publish only to its bound Project", async () => {
    const { store, project, other, app, headers } = await fixture({ publisher: true });
    const response = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers,
      body: JSON.stringify({ kind: "memory", slug: "chat-finding", title: "Finding", body: "Approved publisher" }),
    });
    expect(response.status).toBe(201);
    expect(store.getProjectDocByRef(project.id, "chat-finding")?.body).toBe("Approved publisher");

    const denied = await app.request(`/api/projects/${other.id}/docs`, {
      method: "POST", headers,
      body: JSON.stringify({ kind: "memory", title: "Unrelated", body: "Outside the binding" }),
    });
    expect(denied.status).toBe(403);
    expect(store.listProjectDocs(other.id)).toEqual([]);
  });

  it("scopes the raw knowledge submission API to the same Chat binding", async () => {
    const { store, project, other, task, app, headers } = await fixture();
    for (const [projectId, expectedStatus] of [[project.id, 201], [other.id, 403]] as const) {
      const response = await app.request("/api/knowledge/submissions", {
        method: "POST", headers,
        body: JSON.stringify({ scope: "project_wiki", project_id: projectId, body: "Chat source evidence" }),
      });
      expect(response.status).toBe(expectedStatus);
      if (response.status === 201) {
        const result = await response.json();
        expect(store.getKnowledgeSubmission(result.submission.id)).toMatchObject({
          projectId: project.id, sourceTaskId: task.id, sourceIssueId: null,
        });
      }
    }
  });

  it("does not grant an unbound Chat authority from a Project payload or marker alone", async () => {
    const { store, project, task, app, headers } = await fixture({ bound: false });
    const current = store.getTaskWithAgent(task.id)!;
    for (const marker of [undefined, project.id]) {
      const hydrate = spyOn(store, "getTaskWithAgent").mockReturnValue({
        ...current, project, chatProjectId: marker,
      });
      try {
        const response = await app.request(`/api/projects/${project.id}/docs`, {
          method: "POST", headers,
          body: JSON.stringify({ kind: "memory", title: "Unbound", body: "Must remain unscoped" }),
        });
        expect(response.status).toBe(403);
      } finally {
        hydrate.mockRestore();
      }
    }
    expect(store.listProjectDocs(project.id)).toEqual([]);
  });

  it("rechecks the live Chat binding before trusting a hydrated Project marker", async () => {
    const { store, project, other, chat, task, app, headers } = await fixture();
    const current = store.getTaskWithAgent(task.id)!;
    const hydrate = spyOn(store, "getTaskWithAgent").mockReturnValue(current);
    try {
      // Model a stale cached hydration crossing an administrative binding change.
      db!.run("UPDATE multiremi_chat_sessions SET project_id = ? WHERE id = ?", [other.id, chat.id]);
      for (const projectId of [project.id, other.id]) {
        const response = await app.request(`/api/projects/${projectId}/docs`, {
          method: "POST", headers,
          body: JSON.stringify({ kind: "memory", title: "Stale", body: "Must not cross a binding" }),
        });
        expect(response.status).toBe(403);
      }
    } finally {
      hydrate.mockRestore();
    }
  });

  it("rejects cross-workspace or archived Project bindings even if persisted data is inconsistent", async () => {
    const { store, project, chat, app, headers } = await fixture();
    const foreign = store.createWorkspace({ name: "Foreign knowledge", slug: "foreign-chat-knowledge" });
    const foreignProject = store.createProject({ title: "Foreign Project", workspaceId: foreign.id });
    db!.run("UPDATE multiremi_chat_sessions SET project_id = ? WHERE id = ?", [foreignProject.id, chat.id]);
    // Cross-workspace resources are deliberately hidden by the request gate.
    for (const [projectId, expectedStatus] of [[project.id, 403], [foreignProject.id, 404]] as const) {
      const response = await app.request(`/api/projects/${projectId}/docs`, {
        method: "POST", headers,
        body: JSON.stringify({ kind: "memory", title: "Foreign", body: "Must stay in the workspace" }),
      });
      expect(response.status).toBe(expectedStatus);
    }

    db!.run("UPDATE multiremi_chat_sessions SET project_id = ? WHERE id = ?", [project.id, chat.id]);
    store.archiveProject(project.id);
    const archived = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers,
      body: JSON.stringify({ kind: "memory", title: "Archived", body: "Must not revive the Project" }),
    });
    expect(archived.status).toBe(403);
  });
});
