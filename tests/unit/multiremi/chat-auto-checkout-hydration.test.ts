import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetMultiremiTestEnv(); });

const repoUrl = (name: string) => `https://github.com/chat-auto-checkout/${name}.git`;
const githubResource = (name: string) => ({ resourceType: "github_repo" as const, resourceRef: { url: repoUrl(name) } });
const projectRef = (projectId: string) => ({ resourceType: "project_ref" as const, resourceRef: { projectId } });

function storeWithRepos(names: string[]) {
  const store = createLocalStore();
  store.updateWorkspaceRepositories("local", names.map((name) => ({
    id: `repo_${name}`, name, url: repoUrl(name), source: "github" as const, default_branch: "trunk",
  })));
  return store;
}

function chatTask(store: MultiremiStore, projectId?: string) {
  const agent = store.createAgent({ name: "Checkout worker", provider: "codex" });
  const chat = store.createChatSession({ agentId: agent.id, projectId });
  const task = store.sendChatMessage(chat.id, { body: "Use project" }).task;
  return { chat, task: store.getTaskWithAgent(task.id)! };
}

function forceProjectRef(projectId: string, targetId: string, id: string) {
  db!.run(`INSERT INTO multiremi_project_resources
    (id, project_id, workspace_id, resource_type, resource_ref, position, created_at)
    VALUES (?, ?, 'local', 'project_ref', ?, 99, ?)`,
  [id, projectId, JSON.stringify({ project_id: targetId }), new Date().toISOString()]);
}

describe("Chat explicit automatic checkout catalog", () => {
  it("collects own and recursive Project repos, deduplicates, and uses workspace branch metadata only", () => {
    const store = storeWithRepos(["own", "leaf", "unrelated"]);
    const leaf = store.createProject({ title: "Leaf", resources: [githubResource("leaf")] });
    const middle = store.createProject({ title: "Middle", resources: [projectRef(leaf.id)] });
    const root = store.createProject({ title: "Root", resources: [githubResource("own"), projectRef(middle.id), projectRef(leaf.id)] });
    const { task } = chatTask(store, root.id);
    expect(task.chatAutoCheckoutRepos).toEqual([
      { url: repoUrl("own"), defaultBranch: "trunk" },
      { url: repoUrl("leaf"), defaultBranch: "trunk" },
    ]);
    expect(daemonTaskClaimResponse(store, task).chat_auto_checkout_repos).toEqual([
      { url: repoUrl("own"), default_branch: "trunk" },
      { url: repoUrl("leaf"), default_branch: "trunk" },
    ]);
  });

  it("leaves automatic checkout empty when only the display catalog falls back to workspace repositories", () => {
    const store = storeWithRepos(["workspace"]);
    const empty = store.createProject({ title: "No repository" });
    const parent = store.createProject({ title: "Only project reference", resources: [projectRef(empty.id)] });
    for (const project of [empty, parent]) {
      const { task } = chatTask(store, project.id);
      expect(task.repos).toEqual([{ url: repoUrl("workspace"), defaultBranch: "trunk" }]);
      expect(task.chatAutoCheckoutRepos).toEqual([]);
      expect(daemonTaskClaimResponse(store, task).chat_auto_checkout_repos).toEqual([]);
    }
  });

  it("stops cycles and ignores dangling and cross-workspace project references", () => {
    const store = storeWithRepos(["root", "child", "foreign"]);
    const root = store.createProject({ title: "Root", resources: [githubResource("root")] });
    const child = store.createProject({ title: "Child", resources: [githubResource("child")] });
    store.createProjectResource(root.id, projectRef(child.id));
    const foreignWorkspace = store.createWorkspace({ name: "Foreign", slug: "checkout-foreign" });
    store.updateWorkspaceRepositories(foreignWorkspace.id, [{ id: "repo_foreign_scope", name: "foreign", url: repoUrl("foreign"), source: "github" }]);
    const foreign = store.createProject({ title: "Foreign", workspaceId: foreignWorkspace.id, resources: [githubResource("foreign")] });
    forceProjectRef(child.id, root.id, "res_forced_chat_cycle");
    forceProjectRef(root.id, foreign.id, "res_forced_chat_foreign");
    forceProjectRef(root.id, "prj_missing", "res_forced_chat_missing");
    const { task } = chatTask(store, root.id);
    expect(task.chatAutoCheckoutRepos?.map((repo) => repo.url)).toEqual([repoUrl("root"), repoUrl("child")]);
  });

  it("bounds recursive expansion to five reference hops", () => {
    const names = Array.from({ length: 7 }, (_, i) => `depth${i}`);
    const store = storeWithRepos(names);
    const projects = names.map((name) => store.createProject({ title: name, resources: [githubResource(name)] }));
    for (let index = 0; index < projects.length - 1; index++) {
      store.createProjectResource(projects[index]!.id, projectRef(projects[index + 1]!.id));
    }
    const { task } = chatTask(store, projects[0]!.id);
    expect(task.chatAutoCheckoutRepos?.map((repo) => repo.url)).toEqual(names.slice(0, 6).map(repoUrl));
  });

  it("does not add the field to pure Chat or Issue/topic tasks", () => {
    const store = storeWithRepos(["project"]);
    const project = store.createProject({ title: "Project", resources: [githubResource("project")] });
    const { task: pure } = chatTask(store);
    expect(pure.repos).toEqual([]);
    expect(pure).not.toHaveProperty("chatAutoCheckoutRepos");
    expect(daemonTaskClaimResponse(store, pure)).not.toHaveProperty("chat_auto_checkout_repos");
    const issue = store.createIssue({ title: "Topic Issue", projectId: project.id });
    const agent = store.createAgent({ name: "Issue worker", provider: "codex" });
    const topic = store.createChatSession({ agentId: agent.id, projectId: project.id });
    bindFeishuTopicFixture(store, db!, topic.id, issue.id);
    for (const chatSessionId of [undefined, topic.id]) {
      const created = store.createTask({ agentId: agent.id, issueId: issue.id, chatSessionId, prompt: "Topic work" });
      const task = store.getTaskWithAgent(created.id)!;
      expect(task.issue?.id).toBe(issue.id);
      expect(task.repos.map((repo) => repo.url)).toEqual([repoUrl("project")]);
      expect(task).not.toHaveProperty("chatAutoCheckoutRepos");
      const wire = daemonTaskClaimResponse(store, { ...task, chatAutoCheckoutRepos: [{ url: repoUrl("injected") }] });
      expect(wire.issue).toMatchObject({ id: issue.id });
      expect(wire).not.toHaveProperty("chat_auto_checkout_repos");
    }
  });

  it("clears cached automatic repositories when the marker, Project, workspace, or live binding changes", () => {
    const store = storeWithRepos(["project"]);
    const project = store.createProject({ title: "Project", resources: [githubResource("project")] });
    const other = store.createProject({ title: "Other" });
    const { chat, task } = chatTask(store, project.id);
    for (const changed of [
      { ...task, chatProjectId: other.id },
      { ...task, project: { ...project, id: other.id } },
      { ...task, project: { ...project, workspaceId: "foreign" } },
    ]) {
      expect(daemonTaskClaimResponse(store, changed)).not.toHaveProperty("chat_auto_checkout_repos");
    }
    db!.run("UPDATE multiremi_chat_sessions SET project_id = ? WHERE id = ?", [other.id, chat.id]);
    expect(daemonTaskClaimResponse(store, task)).not.toHaveProperty("chat_auto_checkout_repos");
  });
});

describe("Chat automatic checkout claim client", () => {
  async function claim(raw: object) {
    globalThis.fetch = (async () => Response.json({ task: raw })) as unknown as typeof fetch;
    return new MultiremiDaemonClient("https://remi.example", "test-token").claimTask("runtime-checkout");
  }
  const task = {
    id: "tsk_checkout", prompt: "Work", agent_id: "agt_checkout", status: "dispatched",
    workspace_id: "local", chat_session_id: "chat_checkout", chat_project_id: "prj_checkout",
    project: { id: "prj_checkout", workspace_id: "local", title: "Checkout" },
  };

  it.each(["snake", "camel"] as const)("normalizes the explicit list using the %s transport spelling", async (spelling) => {
    const list = [{ url: repoUrl("explicit"), default_branch: "release" }];
    const claimed = await claim({ ...task, ...(spelling === "snake"
      ? { chat_auto_checkout_repos: list } : { chatAutoCheckoutRepos: list }) });
    expect(claimed.chatAutoCheckoutRepos).toEqual([{ url: repoUrl("explicit"), defaultBranch: "release" }]);
    expect(claimed).not.toHaveProperty("chat_auto_checkout_repos");
  });

  it("rejects mismatched, missing, foreign, malformed, and topic payloads without retaining a snake alias", async () => {
    for (const overrides of [
      { chat_project_id: null },
      { chat_project_id: "prj_wrong" },
      { project: { ...task.project, workspace_id: "foreign" } },
      { project: null },
      { chat_session_id: null },
      { issue_id: "iss_topic" },
      { issue: { id: "iss_topic" } },
      { chat_auto_checkout_repos: null },
      { chat_auto_checkout_repos: {} },
    ]) {
      const claimed = await claim({ ...task, chat_auto_checkout_repos: [{ url: repoUrl("explicit") }], ...overrides });
      expect(claimed.chatAutoCheckoutRepos).toEqual([]);
      expect(claimed).not.toHaveProperty("chat_auto_checkout_repos");
    }
  });

  it("does not infer automatic repositories from an older server's display catalog", async () => {
    const claimed = await claim({ ...task, repos: [{ url: repoUrl("workspace") }] });
    expect(claimed).not.toHaveProperty("chatAutoCheckoutRepos");
    expect(claimed.repos).toEqual([{ url: repoUrl("workspace") }]);
  });
});
