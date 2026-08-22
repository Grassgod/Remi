import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import {
  importWorkspaceRepository,
  parseGitRemoteMetadata,
  removeWorkspaceRepository,
  updateWorkspaceRepository,
} from "@multiremi/api/helpers/repositories.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const inspectGitRemoteRepository = async (url: string) => {
  if (url.includes("github.com")) {
    return { default_branch: "main", branches: ["main", "release"] };
  }
  if (url.includes("personal_automation")) {
    return { default_branch: "main", branches: ["main"] };
  }
  if (url.includes("code.byted.org")) {
    return { default_branch: "develop", branches: ["develop", "main"] };
  }
  return { default_branch: "trunk", branches: ["trunk"] };
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Multiremi API - workspace repositories", () => {
  it("rejects repository writes through generic workspace update routes", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspace(workspace.id, {
      repos: [{ id: "repo_existing", name: "existing", url: "git@github.com:acme/existing.git", source: "github" }],
    });
    const app = createMultiremiApp({ store });

    for (const method of ["PUT", "PATCH"] as const) {
      const response = await app.request(`/api/workspaces/${workspace.id}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bypassed update", repos: [] }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "repositories can only be changed through the workspace repository API",
      });
      expect(store.getWorkspace(workspace.id)).toMatchObject({
        name: workspace.name,
        repos: [expect.objectContaining({ id: "repo_existing" })],
      });
    }
  });

  it("repairs default connection bindings when a prior repository write was interrupted", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    const connection = store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
    });
    store.updateWorkspace(workspace.id, {
      repos: [{
        id: "repo_interrupted",
        name: "interrupted",
        url: "git@github.com:acme/interrupted.git",
        source: "github",
        default_branch: "main",
      }],
    });
    expect(store.listScmRepositoryBindings({ connectionId: connection.id })).toEqual([]);

    const app = createMultiremiApp({ store, inspectGitRemoteRepository });
    const response = await app.request(`/api/workspaces/${workspace.id}/repos`);

    expect(response.status).toBe(200);
    expect(store.listScmRepositoryBindings({ connectionId: connection.id })).toContainEqual(
      expect.objectContaining({
        repositoryId: "repo_interrupted",
        assignmentOrigin: "default",
      }),
    );
  });

  it("removes orphaned bindings when repository reconciliation repairs an interrupted write", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspace(workspace.id, {
      repos: [{
        id: "repo_orphaned",
        name: "orphaned",
        url: "git@github.com:acme/orphaned.git",
        source: "github",
        default_branch: "main",
      }],
    });
    const connection = store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
    });
    expect(store.getScmRepositoryBinding(connection.id, "repo_orphaned")).not.toBeNull();

    // Simulate the old two-step writer crashing after the workspace JSON write.
    store.updateWorkspace(workspace.id, { repos: [] });
    const app = createMultiremiApp({ store, inspectGitRemoteRepository });
    const response = await app.request(`/api/workspaces/${workspace.id}/repos`);

    expect(response.status).toBe(200);
    expect(store.listScmRepositoryBindings({ connectionId: connection.id })).toEqual([]);
  });

  it("rolls back repository import, update, and deletion when binding persistence fails", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    const connection = store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
    });

    db!.exec(`
      CREATE TRIGGER fail_repository_binding_insert
      BEFORE INSERT ON multiremi_scm_repository_bindings
      BEGIN
        SELECT RAISE(ABORT, 'injected binding insert failure');
      END
    `);
    await expect(importWorkspaceRepository(
      store,
      workspace.id,
      { url: "git@github.com:acme/atomic.git" },
      inspectGitRemoteRepository,
    )).rejects.toThrow("injected binding insert failure");
    expect(store.getWorkspace(workspace.id)?.repos).toEqual([]);
    expect(store.listScmRepositoryBindings({ connectionId: connection.id })).toEqual([]);
    db!.exec("DROP TRIGGER fail_repository_binding_insert");

    const imported = await importWorkspaceRepository(
      store,
      workspace.id,
      { url: "git@github.com:acme/atomic.git" },
      inspectGitRemoteRepository,
    );
    const repositoryId = imported.repository.id;
    expect(store.getScmRepositoryBinding(connection.id, repositoryId)?.defaultBranch).toBe("main");

    db!.exec(`
      CREATE TRIGGER fail_repository_binding_update
      BEFORE UPDATE ON multiremi_scm_repository_bindings
      BEGIN
        SELECT RAISE(ABORT, 'injected binding update failure');
      END
    `);
    await expect(updateWorkspaceRepository(
      store,
      workspace.id,
      repositoryId,
      { default_branch: "release" },
      inspectGitRemoteRepository,
    )).rejects.toThrow("injected binding update failure");
    expect(store.getWorkspace(workspace.id)?.repos).toContainEqual(
      expect.objectContaining({ id: repositoryId, default_branch: "main" }),
    );
    expect(store.getScmRepositoryBinding(connection.id, repositoryId)?.defaultBranch).toBe("main");
    db!.exec("DROP TRIGGER fail_repository_binding_update");

    db!.exec(`
      CREATE TRIGGER fail_repository_binding_delete
      BEFORE DELETE ON multiremi_scm_repository_bindings
      BEGIN
        SELECT RAISE(ABORT, 'injected binding delete failure');
      END
    `);
    expect(() => removeWorkspaceRepository(store, workspace.id, repositoryId))
      .toThrow("injected binding delete failure");
    expect(store.getWorkspace(workspace.id)?.repos).toContainEqual(
      expect.objectContaining({ id: repositoryId }),
    );
    expect(store.getScmRepositoryBinding(connection.id, repositoryId)).not.toBeNull();
  });

  it("merges concurrent repository imports instead of replacing a stale workspace snapshot", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    let inspections = 0;
    const inspect = async () => {
      inspections += 1;
      if (inspections === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return { default_branch: "main", branches: ["main"] };
    };

    const first = importWorkspaceRepository(
      store,
      "local",
      { url: "https://github.com/acme/first.git" },
      inspect,
    );
    await firstStarted.promise;
    const second = importWorkspaceRepository(
      store,
      "local",
      { url: "https://github.com/acme/second.git" },
      inspect,
    );
    await secondStarted.promise;
    releaseFirst.resolve();
    await first;
    releaseSecond.resolve();
    await second;

    expect(store.getWorkspace("local")?.repos).toEqual([
      expect.objectContaining({ name: "first" }),
      expect.objectContaining({ name: "second" }),
    ]);
  });

  it("patches and deletes against the latest repository list", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const target = await importWorkspaceRepository(
      store,
      "local",
      { url: "https://github.com/acme/target.git" },
      inspectGitRemoteRepository,
    );
    const updateStarted = deferred<void>();
    const releaseUpdate = deferred<void>();
    const update = updateWorkspaceRepository(
      store,
      "local",
      target.repository.id,
      { default_branch: "release" },
      async () => {
        updateStarted.resolve();
        await releaseUpdate.promise;
        return { default_branch: "main", branches: ["main", "release"] };
      },
    );
    await updateStarted.promise;
    const concurrent = await importWorkspaceRepository(
      store,
      "local",
      { url: "https://github.com/acme/concurrent.git" },
      inspectGitRemoteRepository,
    );
    releaseUpdate.resolve();
    await update;

    removeWorkspaceRepository(store, "local", target.repository.id);
    expect(store.getWorkspace("local")?.repos).toEqual([
      expect.objectContaining({ id: concurrent.repository.id, name: "concurrent" }),
    ]);
  });

  it("inspects, imports, updates, lists, and removes Git repositories", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const githubConnection = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "poll",
    });
    let inspectionCount = 0;
    const app = createMultiremiApp({
      store,
      inspectGitRemoteRepository: async (url) => {
        inspectionCount += 1;
        return inspectGitRemoteRepository(url);
      },
    });

    const inspected = await app.request("/api/workspaces/local/repos/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/multimira-ai/remi.git" }),
    });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toEqual({
      metadata: {
        url: "https://github.com/multimira-ai/remi.git",
        name: "remi",
        default_branch: "main",
        branches: ["main", "release"],
      },
    });

    const github = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/multimira-ai/remi.git",
        source: "codebase",
        description: "Main product repository",
        default_branch: "release",
      }),
    });
    expect(github.status).toBe(201);
    const githubBody = await github.json();
    const importedRepositoryId = String(githubBody.repository.id);
    expect(githubBody).toMatchObject({
      repository: {
        id: expect.stringMatching(/^repo_/),
        name: "remi",
        url: "https://github.com/multimira-ai/remi.git",
        source: "github",
        description: "Main product repository",
        default_branch: "release",
      },
    });
    expect(store.listScmRepositoryBindings({ connectionId: githubConnection.id })).toContainEqual(
      expect.objectContaining({
        repositoryId: importedRepositoryId,
        assignmentOrigin: "default",
        defaultBranch: "release",
      }),
    );

    const codebase = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "git@code.byted.org:dev/agent-platform.git",
        source: "github",
      }),
    });
    expect(codebase.status).toBe(201);
    const codebaseBody = await codebase.json();
    expect(codebaseBody.repository).toMatchObject({
      name: "agent-platform",
      source: "codebase",
      default_branch: "develop",
    });

    const generic = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "ssh://git@git.example.test/team/service.git",
      }),
    });
    expect(generic.status).toBe(201);
    expect(await generic.json()).toMatchObject({
      repository: {
        name: "service",
        source: "unknown",
        default_branch: "trunk",
      },
    });

    const inspectionCountBeforeDescriptionUpdate = inspectionCount;
    const described = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "  Internal agent platform  " }),
      },
    );
    expect(described.status).toBe(200);
    expect((await described.json()).repository.description).toBe("Internal agent platform");
    expect(inspectionCount).toBe(inspectionCountBeforeDescriptionUpdate);

    const clearedDescription = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "   " }),
      },
    );
    expect(clearedDescription.status).toBe(200);
    expect((await clearedDescription.json()).repository.description).toBeNull();
    expect(inspectionCount).toBe(inspectionCountBeforeDescriptionUpdate);

    const longDescription = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "x".repeat(201) }),
      },
    );
    expect(longDescription.status).toBe(400);
    expect(await longDescription.json()).toEqual({
      error: "repository description must be 200 characters or fewer",
    });
    expect(inspectionCount).toBe(inspectionCountBeforeDescriptionUpdate);

    const emptyUpdate = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(emptyUpdate.status).toBe(400);
    expect(await emptyUpdate.json()).toEqual({ error: "repository update is empty" });

    const updated = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_branch: "main" }),
      },
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).repository.default_branch).toBe("main");

    const invalidBranch = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_branch: "missing" }),
      },
    );
    expect(invalidBranch.status).toBe(400);
    expect(await invalidBranch.json()).toEqual({
      error: "default branch does not exist in repository",
    });

    const listed = await app.request("/api/workspaces/local/repos");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(3);
    expect(listedBody.repositories.map((repo: { source: string }) => repo.source)).toEqual([
      "github",
      "codebase",
      "unknown",
    ]);

    const duplicate = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/multimira-ai/remi/",
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "repository is already imported" });

    const invalid = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-git-remote" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid git repository URL" });

    const removed = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).workspace.repos).toHaveLength(2);
  });

  it("only lets project creation attach repositories already imported into the workspace", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, inspectGitRemoteRepository });

    const imported = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/multimira-ai/remi.git",
      }),
    });
    const importedBody = await imported.json();

    const localDirectory = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Local project",
        resources: [{
          resource_type: "local_directory",
          resource_ref: { local_path: "/tmp/remi", daemon_id: "daemon-1" },
        }],
      }),
    });
    expect(localDirectory.status).toBe(400);
    expect(await localDirectory.json()).toEqual({
      error: "projects can only use imported git repositories",
    });

    const unimported = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Unknown repository",
        resources: [{
          resource_type: "github_repo",
          resource_ref: { url: "https://github.com/multimira-ai/unknown.git" },
        }],
      }),
    });
    expect(unimported.status).toBe(400);
    expect(await unimported.json()).toEqual({
      error: "repository must be imported before it can be added to a project",
    });

    const created = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Imported repository",
        resources: [{
          resource_type: "github_repo",
          resource_ref: { url: "https://github.com/multimira-ai/remi" },
        }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.resource_count).toBe(1);

    const inUse = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(importedBody.repository.id)}`,
      { method: "DELETE" },
    );
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toEqual({
      error: "repository is used by 1 project",
    });
  });

  it("backfills default branches for repositories imported before inspection", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{
        url: "git@code.byted.org:taoze/personal_automation.git",
        name: "personal_automation",
        source: "codebase",
        default_branch: null,
      }],
    });
    const app = createMultiremiApp({ store, inspectGitRemoteRepository });

    const response = await app.request("/api/workspaces/local/repos");
    expect(response.status).toBe(200);
    expect((await response.json()).repositories[0].default_branch).toBe("main");
    expect(store.ensureLocalWorkspace().repos[0]).toMatchObject({
      default_branch: "main",
    });
  });

  it("parses a symbolic remote HEAD and all branch names", () => {
    expect(parseGitRemoteMetadata([
      "ref: refs/heads/main\tHEAD",
      "63cc7f87bfddd869bbdab0b2079c9f41ad7f36c0\tHEAD",
      "63cc7f87bfddd869bbdab0b2079c9f41ad7f36c0\trefs/heads/main",
      "2f0478cf900449dbc03307fd11416785f018228f\trefs/heads/release/v2",
    ].join("\n"))).toEqual({
      default_branch: "main",
      branches: ["main", "release/v2"],
    });
  });
});
