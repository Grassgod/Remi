import { afterEach, describe, expect, it } from "bun:test";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture(bound = true) {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Chat Wiki", provider: "codex" });
  const project = store.createProject({ title: "Project" });
  const wiki = store.createProjectDoc(project.id, {
    kind: "wiki", slug: "guide", title: "Guide", body: "# Guide\nProject-specific facts.",
  });
  const memory = store.createProjectDoc(project.id, {
    kind: "memory", slug: "memory", title: "Memory", body: "Retrieve this on demand.",
  });
  const chat = store.createChatSession({ agentId: agent.id, projectId: bound ? project.id : null });
  const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Read the guide" });
  return { store, project, wiki, memory, task: store.getTaskWithAgent(task.id)! };
}

describe("SQL Chat Project Wiki hydration", () => {
  it("loads the bound Project's Wiki bodies without embedding Memory", async () => {
    const { store, project, wiki, memory, task } = fixture();
    const other = store.createProject({ title: "Other" });
    store.createProjectDoc(other.id, { kind: "wiki", title: "Other guide", body: "Unrelated" });
    const hydrated = await new ProjectKnowledgeService(store, null, "sql").hydrateTaskKnowledge(task);
    expect(hydrated.projectWikiDocs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: wiki.id, projectId: project.id, body: wiki.body, kind: "wiki" }),
    ]));
    expect(hydrated.projectWikiDocs?.every((doc) => doc.projectId === project.id && doc.kind === "wiki")).toBe(true);
    expect(hydrated.projectWikiDocs?.some((doc) => doc.id === memory.id)).toBe(false);
    expect(hydrated.projectDocs).toBe(task.projectDocs);
    expect(task.projectWikiDocs).toBeUndefined();
  });

  it("leaves pure Chat and SQL Issue tasks unchanged", async () => {
    const { store, project, task } = fixture(false);
    const service = new ProjectKnowledgeService(store, null, "sql");
    expect(await service.hydrateTaskKnowledge(task)).toBe(task);
    expect(task.projectWikiDocs).toBeUndefined();
    const issue = store.createIssue({ title: "Issue", projectId: project.id });
    const issueTask = store.createTask({ agentId: task.agentId, issueId: issue.id, prompt: "Existing behavior" });
    const hydratedIssue = store.getTaskWithAgent(issueTask.id)!;
    expect(await service.hydrateTaskKnowledge(hydratedIssue)).toBe(hydratedIssue);
  });

  it("requires a matching explicit Project marker and workspace", async () => {
    const { store, project, task } = fixture();
    const service = new ProjectKnowledgeService(store, null, "sql");
    for (const candidate of [
      { ...task, chatProjectId: null },
      { ...task, chatProjectId: "different-project" },
      { ...task, project: { ...project, workspaceId: "different-workspace" } },
    ]) {
      expect(await service.hydrateTaskKnowledge(candidate)).toBe(candidate);
      expect(candidate.projectWikiDocs).toBeUndefined();
    }
  });
});
