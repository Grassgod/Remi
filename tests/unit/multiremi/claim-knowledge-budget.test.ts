import { afterEach, describe, expect, it } from "bun:test";
import { hydrateClaimKnowledge } from "@multiremi/project-knowledge/claim-hydration.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Budget runtime", provider: "codex", workspaceId: "local" });
  const agent = store.createAgent({ name: "Budget agent", provider: "codex", workspaceId: "local" });
  const issue = store.createIssue({ title: "Budget", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Work" });
  const project = new ProjectKnowledgeService(store, null, "sql");
  const repository = new RepositoryWikiService(store, null, "sql");
  return { store, runtime, task: store.getTaskWithAgent(task.id)!, project, repository };
}

describe("claim knowledge budget", () => {
  it("bounds stalled hydration, cancels requests, and warns on both prompt modes", async () => {
    const { task, project, repository } = fixture();
    let signal: AbortSignal | undefined;
    project.hydrateTaskKnowledge = async (_, s) => { signal = s; return new Promise(() => {}); };
    const start = Date.now();
    const hydrated = await hydrateClaimKnowledge(task, project, repository, 30);
    expect(Date.now() - start).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
    expect(hydrated.knowledgeWarnings).toHaveLength(2);
    expect(hydrated.projectWikiDocs).toEqual([]);
    for (const mode of ["bootstrap", "delta"]) {
      const prompt = buildTaskPrompt({ ...hydrated, sessionProjection: { mode, jsonl: "" } } as any);
      expect(prompt).toContain("Knowledge Availability Warnings");
      expect(prompt).toContain("not loaded");
    }
  });

  it("retains the completed knowledge stage if the next stage times out", async () => {
    const { task, project, repository } = fixture();
    const docs = { memory: [], wiki: [], schema: "verified project knowledge" };
    project.hydrateTaskKnowledge = async t => ({ ...t, projectDocs: docs });
    repository.hydrateTaskWiki = async () => new Promise(() => {});
    const result = await hydrateClaimKnowledge(task, project, repository, 30);
    expect(result.projectDocs).toBe(docs);
    expect(result.knowledgeWarnings).toHaveLength(1);
  });

  it("coalesces concurrent runtime claims and does not deliver a cancelled task", async () => {
    const { store, runtime, task, project, repository } = fixture();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    project.hydrateTaskKnowledge = async t => { calls++; await gate.promise; return t; };
    const app = createMultiremiApp({ store, projectKnowledge: project, repositoryWiki: repository });
    const requests = [0, 1].map(() => app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" }));
    await Bun.sleep(10);
    expect(calls).toBe(1);
    store.cancelTask(task.id);
    gate.resolve();
    for (const response of await Promise.all(requests)) expect(await response.json()).toEqual({ task: null });
    expect(store.listTasks()).toHaveLength(1);
  });
});
