import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { MultiremiRepoData } from "../../../src/multiremi/contracts/types.js";
import { createMultiremiApp } from "../../../src/multiremi/api.js";
import { MultiremiStore } from "../../../src/multiremi/store.js";

let db: Database | null = null;

function createStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

afterEach(() => {
  db?.close();
  db = null;
});

function githubResource(url: string) {
  return { resourceType: "github_repo", resourceRef: { url } } as const;
}

function projectRefResource(projectId: string) {
  return { resourceType: "project_ref", resourceRef: { projectId } } as const;
}

// Exercises the private resolveTaskRepos via getTaskWithAgent().repos.
function taskReposForProject(store: MultiremiStore, projectId: string): MultiremiRepoData[] {
  const agent = store.createAgent({ name: `agent-${projectId}`, provider: "codex" });
  const issue = store.createIssue({ title: `issue-${projectId}`, projectId });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
  return store.getTaskWithAgent(task.id)!.repos;
}

describe("Bun Multiremi project_ref resource", () => {
  it("normalizes both casings to a deterministic {projectId, project_id} ref", () => {
    const store = createStore();
    const target = store.createProject({ title: "Target" });
    const snakeOwner = store.createProject({ title: "Snake owner" });
    const camelOwner = store.createProject({ title: "Camel owner" });

    const fromSnake = store.createProjectResource(snakeOwner.id, {
      resourceType: "project_ref",
      resourceRef: { project_id: target.id },
    });
    expect(fromSnake.resourceRef).toEqual({ projectId: target.id, project_id: target.id });

    const fromCamel = store.createProjectResource(camelOwner.id, {
      resourceType: "project_ref",
      resourceRef: { projectId: target.id },
    });
    expect(fromCamel.resourceRef).toEqual({ projectId: target.id, project_id: target.id });

    // Fixed key order in the persisted JSON keeps the UNIQUE index deterministic.
    const storedSnake = db!.query("SELECT resource_ref FROM multiremi_project_resources WHERE id = ?").get(fromSnake.id) as { resource_ref: string };
    const storedCamel = db!.query("SELECT resource_ref FROM multiremi_project_resources WHERE id = ?").get(fromCamel.id) as { resource_ref: string };
    expect(storedSnake.resource_ref).toBe(`{"projectId":"${target.id}","project_id":"${target.id}"}`);
    expect(storedCamel.resource_ref).toBe(storedSnake.resource_ref);
  });

  it("rejects a project_ref that points at its own project", () => {
    const store = createStore();
    const project = store.createProject({ title: "Self" });
    expect(() => store.createProjectResource(project.id, projectRefResource(project.id)))
      .toThrow("project_ref cannot reference its own project");
  });

  it("rejects a project_ref whose target is missing or in another workspace", () => {
    const store = createStore();
    const owner = store.createProject({ title: "Owner" });
    expect(() => store.createProjectResource(owner.id, projectRefResource("prj_ghost")))
      .toThrow("project_ref target project not found: prj_ghost");

    const otherWs = store.createWorkspace({ name: "Other WS", slug: "other-ws" });
    const foreign = store.createProject({ title: "Foreign", workspaceId: otherWs.id });
    expect(() => store.createProjectResource(owner.id, projectRefResource(foreign.id)))
      .toThrow("project_ref target belongs to another workspace");
  });

  it("rejects direct and transitive reference cycles", () => {
    const store = createStore();
    const a = store.createProject({ title: "A" });
    const b = store.createProject({ title: "B" });
    const c = store.createProject({ title: "C" });

    // Direct cycle: A → B is fine, B → A closes the loop.
    store.createProjectResource(a.id, projectRefResource(b.id));
    expect(() => store.createProjectResource(b.id, projectRefResource(a.id)))
      .toThrow("project_ref would introduce a reference cycle");

    // Transitive cycle: A → B → C already exists, C → A closes the loop.
    store.createProjectResource(b.id, projectRefResource(c.id));
    expect(() => store.createProjectResource(c.id, projectRefResource(a.id)))
      .toThrow("project_ref would introduce a reference cycle");
  });

  it("validates a new project_ref even when a referenced project's target is dangling", () => {
    const store = createStore();
    const a = store.createProject({ title: "A" });
    const b = store.createProject({ title: "B" });
    const c = store.createProject({ title: "C" });

    // B → C is validated normally, then C's row is hard-deleted out of band
    // (a TOCTOU state under Postgres). Adding a valid A → B edge must still
    // succeed rather than throw "Project not found" while walking B's graph.
    store.createProjectResource(b.id, projectRefResource(c.id));
    db!.run("DELETE FROM multiremi_projects WHERE id = ?", [c.id]);
    expect(store.getProject(c.id)).toBeNull();

    const created = store.createProjectResource(a.id, projectRefResource(b.id));
    expect(created.resourceType).toBe("project_ref");
    expect(created.resourceRef).toEqual({ projectId: b.id, project_id: b.id });
  });

  it("rejects an invalid project_ref supplied via createProject inline resources", () => {
    const store = createStore();
    expect(() => store.createProject({
      id: "prj_inline_self",
      title: "Inline self",
      resources: [{ resourceType: "project_ref", resourceRef: { projectId: "prj_inline_self" } }],
    })).toThrow("project_ref cannot reference its own project");
    // The transaction rolled back — the project was not created.
    expect(store.getProject("prj_inline_self")).toBeNull();
  });

  it("normalizes casing and catches duplicates over HTTP", async () => {
    const store = createStore();
    const owner = store.createProject({ title: "Owner" });
    const target = store.createProject({ title: "Target" });
    const app = createMultiremiApp({ store });

    const created = await app.request(`/api/projects/${owner.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "project_ref", resource_ref: { projectId: target.id } }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.resource_type).toBe("project_ref");
    expect(createdBody.resource_ref).toEqual({ project_id: target.id });

    // Same target, opposite casing → same normalized ref → UNIQUE conflict → 409.
    const duplicate = await app.request(`/api/projects/${owner.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "project_ref", resource_ref: { project_id: target.id } }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "this resource is already attached to the project" });
  });

  it("surfaces project_ref validation failures as 400s over HTTP", async () => {
    const store = createStore();
    const a = store.createProject({ title: "A" });
    const b = store.createProject({ title: "B" });
    const app = createMultiremiApp({ store });

    const selfRef = await app.request(`/api/projects/${a.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "project_ref", resource_ref: { project_id: a.id } }),
    });
    expect(selfRef.status).toBe(400);
    expect((await selfRef.json()).error).toContain("project_ref");

    await app.request(`/api/projects/${a.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "project_ref", resource_ref: { project_id: b.id } }),
    });
    const cycle = await app.request(`/api/projects/${b.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "project_ref", resource_ref: { project_id: a.id } }),
    });
    expect(cycle.status).toBe(400);
    expect((await cycle.json()).error).toContain("project_ref");
  });

  it("expands referenced project github repos and skips their local directories", () => {
    const store = createStore();
    const lib = store.createProject({
      title: "Lib",
      resources: [
        githubResource("https://github.com/acme/lib"),
        { resourceType: "local_directory", resourceRef: { localPath: "/home/dev/lib", daemonId: "daemon-a" } },
      ],
    });
    const main = store.createProject({
      title: "Main",
      resources: [githubResource("https://github.com/acme/main"), projectRefResource(lib.id)],
    });

    // Own repo + referenced repo, but never the referenced project's local_directory.
    expect(taskReposForProject(store, main.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/main",
      "https://github.com/acme/lib",
    ]);
  });

  it("walks nested project references", () => {
    const store = createStore();
    const leaf = store.createProject({ title: "Leaf", resources: [githubResource("https://github.com/acme/leaf")] });
    const mid = store.createProject({ title: "Mid", resources: [projectRefResource(leaf.id)] });
    const main = store.createProject({
      title: "Main",
      resources: [githubResource("https://github.com/acme/main"), projectRefResource(mid.id)],
    });

    expect(taskReposForProject(store, main.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/main",
      "https://github.com/acme/leaf",
    ]);
  });

  it("dedupes repo urls that appear across references", () => {
    const store = createStore();
    const other = store.createProject({
      title: "Other",
      resources: [githubResource("https://github.com/acme/shared"), githubResource("https://github.com/acme/unique")],
    });
    const main = store.createProject({
      title: "Main",
      resources: [githubResource("https://github.com/acme/shared"), projectRefResource(other.id)],
    });

    expect(taskReposForProject(store, main.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/shared",
      "https://github.com/acme/unique",
    ]);
  });

  it("caps project_ref expansion at a fixed depth", () => {
    const store = createStore();
    // Chain p0 → p1 → … → p6, each carrying its own github repo.
    const projects = Array.from({ length: 7 }, (_, i) => store.createProject({
      title: `P${i}`,
      resources: [githubResource(`https://github.com/acme/p${i}`)],
    }));
    for (let i = 0; i < projects.length - 1; i++) {
      store.createProjectResource(projects[i]!.id, projectRefResource(projects[i + 1]!.id));
    }

    // Depth cap of 5 stops before p6's repo is pulled in.
    expect(taskReposForProject(store, projects[0]!.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/p0",
      "https://github.com/acme/p1",
      "https://github.com/acme/p2",
      "https://github.com/acme/p3",
      "https://github.com/acme/p4",
      "https://github.com/acme/p5",
    ]);
  });

  it("falls back to workspace repos only when the expansion is empty", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", { repos: [{ url: "https://github.com/acme/workspace" }] });

    // Non-empty expansion → workspace repos are NOT mixed in.
    const lib = store.createProject({ title: "Lib", resources: [githubResource("https://github.com/acme/lib")] });
    const withRef = store.createProject({ title: "With ref", resources: [projectRefResource(lib.id)] });
    expect(taskReposForProject(store, withRef.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/lib",
    ]);

    // A dangling project_ref (target row removed) yields an empty expansion → fallback.
    const ghost = store.createProject({ title: "Ghost" });
    const dangling = store.createProject({ title: "Dangling", resources: [projectRefResource(ghost.id)] });
    db!.run("DELETE FROM multiremi_projects WHERE id = ?", [ghost.id]);
    expect(store.getProject(ghost.id)).toBeNull();
    expect(taskReposForProject(store, dangling.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/workspace",
    ]);
  });

  it("terminates on a cycle forced into the database at resolution time", () => {
    const store = createStore();
    const a = store.createProject({ title: "A", resources: [githubResource("https://github.com/acme/a")] });
    const b = store.createProject({ title: "B", resources: [githubResource("https://github.com/acme/b")] });
    // A → B is validated normally; B → A is forced in directly to bypass write-time cycle
    // rejection, mimicking a TOCTOU race under Postgres. Runtime resolution must still halt.
    store.createProjectResource(a.id, projectRefResource(b.id));
    db!.run(
      `INSERT INTO multiremi_project_resources (id, project_id, workspace_id, resource_type, resource_ref, label, position, created_at, created_by)
       VALUES (?, ?, 'local', 'project_ref', ?, NULL, 1, ?, NULL)`,
      ["res_forced_cycle", b.id, `{"projectId":"${a.id}","project_id":"${a.id}"}`, new Date().toISOString()],
    );

    expect(taskReposForProject(store, a.id).map((repo) => repo.url)).toEqual([
      "https://github.com/acme/a",
      "https://github.com/acme/b",
    ]);
  });
});
