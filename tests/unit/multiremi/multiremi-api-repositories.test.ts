import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import {
  importWorkspaceRepository,
  parseGitRemoteMetadata,
  removeWorkspaceRepository,
  updateWorkspaceRepository,
} from "@multiremi/api/helpers/repositories.js";
import { configureRepositoryWikiAutomation, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  it("builds a repository Wiki from normal Agent, plugin, and automation configuration", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_wiki",
      name: "wiki",
      url: "git@github.com:acme/wiki.git",
      source: "github",
      default_branch: "main",
    }]);
    const { agent, autopilot } = configureRepositoryWikiAutomation(store, { workspaceId: workspace.id });
    const app = createMultiremiApp({ store });
    expect((await app.request(`/api/workspaces/${workspace.id}/repository-wikis/atlas`)).status).toBe(404);
    const build = await app.request(`/api/workspaces/${workspace.id}/repos/repo_wiki/wiki/build`, { method: "POST" });
    expect(build.status).toBe(202);
    const buildBody = await build.json();
    expect(buildBody).toMatchObject({ status: "running" });
    expect(typeof buildBody.run_id).toBe("string");
    expect(typeof buildBody.task_id).toBe("string");
    expect(store.getTask(buildBody.task_id)).toMatchObject({
      workspaceId: workspace.id,
      agentId: agent.id,
      autopilotRunId: expect.any(String),
      prompt: expect.stringContaining("repository LLM Wiki"),
    });
    const buildToken = await store.createTaskAccessToken(store.getTask(buildBody.task_id)!, "local");
    expect(buildToken.scopes).toContain("repository-wiki:maintainer");
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);
  });

  it("does not treat display names as Repository Wiki capability", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_unconfigured",
      name: "unconfigured",
      url: "git@github.com:acme/unconfigured.git",
      source: "github",
      default_branch: "main",
    }]);
    store.createAgent({
      name: "Atlas · LLM Wiki",
      provider: "claude",
      workspaceId: workspace.id,
      role: "maintainer",
    });
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/workspaces/${workspace.id}/repos/repo_unconfigured/wiki/build`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "repository_wiki_automation_required" });
  });

  it("dedupes repository Wiki builds and derives the per-repository build status", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    const plugin = store.importAgentPlugin({
      provider: "claude",
      name: "code-to-wiki",
      manifest: { name: "code-to-wiki", version: "1.0.0" },
      files: [{ path: "skills/code-to-wiki/SKILL.md", content: "# Code to Wiki\n" }],
    });
    store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
    });
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_atlas",
      name: "atlas",
      url: "git@github.com:acme/atlas.git",
      source: "github",
      default_branch: "main",
    }]);
    const runtime = store.registerRuntime({
      name: "wiki-build-runtime",
      provider: "claude",
      metadata: { agent_plugin_protocol: 1 },
    });
    const app = createMultiremiApp({ store });
    const { autopilot } = configureRepositoryWikiAutomation(store, {
      workspaceId: workspace.id,
      plugin,
      runtimeId: runtime.id,
    });
    // Atlas tasks snapshot the code-to-wiki plugin; the runtime must report it
    // ready before it can claim a build task.
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
      retryGeneration: 0,
    });

    // A pre-existing healthy doc must survive every build-state transition.
    const doc = await app.request(`/api/workspaces/${workspace.id}/repos/repo_atlas/wiki`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "overview.md", title: "Overview", body: "Atlas facts" }),
    });
    expect(doc.status).toBe(201);

    const buildPath = `/api/workspaces/${workspace.id}/repos/repo_atlas/wiki/build`;
    const summariesPath = `/api/workspaces/${workspace.id}/repository-wikis`;
    const summary = async () => ((await (await app.request(summariesPath)).json() as any).repositories[0]);

    const first = await app.request(buildPath, { method: "POST" });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({ status: "running" });

    // A second click while the build is in flight returns the existing run.
    const duplicate = await app.request(buildPath, { method: "POST" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: expect.stringContaining("already in progress"),
      code: "repository_wiki_build_in_progress",
      run_id: firstBody.run_id,
      task_id: firstBody.task_id,
    });
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);

    const queued = await summary();
    expect(queued).toMatchObject({
      repository_id: "repo_atlas",
      status: "building",
      page_count: 1,
      build: {
        status: "queued",
        run_id: firstBody.run_id,
        task_id: firstBody.task_id,
        failure_reason: null,
        published: null,
      },
    });

    expect(store.claimTask(runtime.id)?.id).toBe(firstBody.task_id);
    store.startTask(firstBody.task_id);
    const building = await summary();
    expect(building.status).toBe("building");
    expect(building.build.status).toBe("building");

    store.failTask(firstBody.task_id, { error: "clone failed" });
    const failed = await summary();
    expect(failed.status).toBe("failed");
    expect(failed.page_count).toBe(1);
    expect(failed.build).toMatchObject({
      status: "failed",
      run_id: firstBody.run_id,
      failure_reason: "clone failed",
      published: null,
    });

    // A failed build never blocks a retry. (Sleep so the retry gets a strictly
    // newer created_at millisecond than the failed run.)
    await Bun.sleep(2);
    const retry = await app.request(buildPath, { method: "POST" });
    expect(retry.status).toBe(202);
    const retryBody = await retry.json() as any;
    expect(retryBody.run_id).not.toBe(firstBody.run_id);
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(2);

    expect(store.claimTask(runtime.id)?.id).toBe(retryBody.task_id);
    store.startTask(retryBody.task_id);
    store.completeTask(retryBody.task_id, { output: "wiki updated" });
    const healthy = await summary();
    expect(healthy.status).toBe("healthy");
    expect(healthy.page_count).toBe(1);
    expect(healthy.build).toMatchObject({ status: "idle", run_id: retryBody.run_id, published: false });

    // Manual rebuilds target the moving HEAD, so a completed build never blocks one.
    const rebuild = await app.request(buildPath, { method: "POST" });
    expect(rebuild.status).toBe(202);
    expect((await rebuild.json() as any).run_id).not.toBe(retryBody.run_id);
  });

  it("keeps repository Wiki builds unavailable to daemon tokens", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_guarded",
      name: "guarded",
      url: "git@github.com:acme/guarded.git",
      source: "github",
      default_branch: "main",
    }]);
    const daemonToken = await store.createAccessToken({
      workspaceId: workspace.id,
      name: "Build auth daemon",
      type: "daemon",
      purpose: "daemon",
      daemonId: "dmn_build_auth",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const path = `/api/workspaces/${workspace.id}/repos/repo_guarded/wiki/build`;

    const response = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonToken.token}` },
    });
    expect(response.status).toBe(403);
  });

  it("strips server-only repository build scope from public autopilot run routes", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_private",
      name: "private",
      url: "git@github.com:acme/private.git",
      source: "github",
      default_branch: "main",
    }]);
    store.createAgent({ name: "Atlas · LLM Wiki", provider: "claude" });
    const userAgent = store.createAgent({ name: "User Wiki", provider: "claude" });
    const sameTitle = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      workspaceId: workspace.id,
      assigneeId: userAgent.id,
      executionMode: "run_only",
    });
    const runtime = store.registerRuntime({ name: "wiki-injection-runtime", provider: "claude" });
    const app = createMultiremiApp({ store });
    const injectedSnakeCase = {
      source: "api",
      repository_id: "repo_private",
      dedupe_key: "repo_private:incremental_update:abc123",
      payload: { repository_wiki_repository_id: "repo_private" },
    };

    const firstResponse = await app.request(`/api/autopilots/${sameTitle.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(injectedSnakeCase),
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json() as any;
    const firstRun = store.getAutopilotRun(firstBody.id)!;
    expect(firstRun).toMatchObject({ repositoryId: null, dedupeKey: null });

    expect(store.claimTask(runtime.id)?.id).toBe(firstRun.taskId!);
    store.startTask(firstRun.taskId!);
    store.createRepositoryWikiDoc(workspace.id, "repo_private", {
      path: "user-write.md",
      title: "User write",
      sourceTaskId: firstRun.taskId,
    });
    store.completeTask(firstRun.taskId!, { output: "published" });

    const replayResponse = await app.request(`/api/autopilots/${sameTitle.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(injectedSnakeCase),
    });
    expect(replayResponse.status).toBe(200);
    expect((await replayResponse.json() as any).id).not.toBe(firstRun.id);

    const injectedCamelCase = {
      repositoryId: "repo_private",
      dedupeKey: "repo_private:incremental_update:abc123",
    };
    for (const path of [
      `/api/multiremi/autopilots/${sameTitle.id}/run`,
      `/api/multiremi/autopilots/${sameTitle.id}/trigger`,
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(injectedCamelCase),
      });
      expect(response.status).toBe(201);
    }

    const runs = store.listAutopilotRuns(sameTitle.id);
    expect(runs).toHaveLength(4);
    expect(runs.every((run) => run.repositoryId === null && run.dedupeKey === null)).toBe(true);
    const summaries = await app.request(`/api/workspaces/${workspace.id}/repository-wikis`);
    expect(summaries.status).toBe(200);
    expect((await summaries.json() as any).repositories[0].build.run_id).toBeNull();
  });

  it("serves repository-scoped Wiki CRUD and summaries without crossing repository boundaries", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspace(workspace.id, {
      repos: [
        { id: "repo_alpha", name: "alpha", url: "git@github.com:acme/alpha.git", source: "github" },
        { id: "repo_beta", name: "beta", url: "git@github.com:acme/beta.git", source: "github" },
      ],
    });
    const app = createMultiremiApp({ store });
    const root = `/api/workspaces/${workspace.id}/repos/repo_alpha/wiki`;

    const createdResponse = await app.request(root, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "architecture/overview.md",
        title: "Architecture",
        body: "Alpha facts",
        source_revision: "abc123",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json() as any).doc;
    expect(created).toMatchObject({ repository_id: "repo_alpha", path: "architecture/overview.md", version: 1 });

    expect((await (await app.request(root)).json() as any).docs).toMatchObject([{ id: created.id, body: "Alpha facts" }]);
    expect((await app.request(`/api/workspaces/${workspace.id}/repos/repo_beta/wiki/${created.id}`)).status).toBe(404);

    const updatedResponse = await app.request(`${root}/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Alpha facts v2", expected_version: 1, status: "healthy" }),
    });
    expect(updatedResponse.status).toBe(200);
    expect((await updatedResponse.json() as any).doc).toMatchObject({ body: "Alpha facts v2", version: 2 });

    const summaries = await (await app.request(`/api/workspaces/${workspace.id}/repository-wikis`)).json() as any;
    expect(summaries.repositories).toEqual([
      expect.objectContaining({ repository_id: "repo_alpha", status: "healthy", page_count: 1 }),
      expect.objectContaining({ repository_id: "repo_beta", status: "unbuilt", page_count: 0 }),
    ]);
    expect((await (await app.request(`${root}/${created.id}/revisions`)).json() as any).revisions.map((revision: any) => revision.version))
      .toEqual([2, 1]);
  });

  it("preserves scoped task reads while routing repository Wiki writes to Raw", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_task_wiki",
      name: "task-wiki",
      url: "git@github.com:acme/task-wiki.git",
      source: "github",
      default_branch: "main",
    }]);
    configureRepositoryWikiAutomation(store, { workspaceId: workspace.id });
    store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
    });
    const foreignWorkspace = store.createWorkspace({ name: "Foreign Wiki", slug: "foreign-wiki" });
    store.updateWorkspaceRepositories(foreignWorkspace.id, [{
      id: "repo_foreign_wiki",
      name: "foreign-wiki",
      url: "git@github.com:acme/foreign-wiki.git",
      source: "github",
      default_branch: "main",
    }]);
    const agent = store.createAgent({ name: "Wiki task", provider: "claude", workspaceId: workspace.id });
    const project = store.createProject({
      title: "Task Wiki project",
      workspaceId: workspace.id,
      resources: [{ resourceType: "github_repo", resourceRef: { url: "git@github.com:acme/task-wiki.git" } }],
    });
    const issue = store.createIssue({ title: "Publish repository Wiki", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: workspace.id, prompt: "Publish repository Wiki" });
    const credential = await store.createTaskAccessToken(task, "local");
    const auth = { Authorization: `Bearer ${credential.token}` };
    const jsonAuth = { ...auth, "Content-Type": "application/json" };
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const root = `/api/workspaces/${workspace.id}/repos/repo_task_wiki/wiki`;
    const created = store.createRepositoryWikiDoc(workspace.id, "repo_task_wiki", {
      path: "overview.md", title: "Overview", body: "formal v1",
    });
    const createdResponse = await app.request(root, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ path: "overview.md", title: "Overview", body: "v1" }),
    });
    expect(createdResponse.status).toBe(202);
    const createSubmission = store.getKnowledgeSubmission((await createdResponse.json() as any).submission_id)!;
    expect(createSubmission).toMatchObject({ repositoryId: "repo_task_wiki", sourceTaskId: task.id, sourceIssueId: issue.id });

    expect((await app.request(root, { headers: auth })).status).toBe(200);
    expect((await app.request(`${root}/${created.id}`, { headers: auth })).status).toBe(200);
    const updatedResponse = await app.request(`${root}/${created.id}`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ body: "v2", expected_version: 1 }),
    });
    expect(updatedResponse.status).toBe(202);

    for (const path of [
      `/api/workspaces/${workspace.id}/repository-wikis`,
      `${root}/${created.id}/revisions`,
    ]) {
      const response = await app.request(path, { headers: auth });
      expect(response.status, path).toBe(200);
    }
    expect((await app.request(`/api/workspaces/${workspace.id}/repository-wikis/atlas`, {
      headers: auth,
    })).status).toBe(404);
    const build = await app.request(`${root}/build`, { method: "POST", headers: jsonAuth, body: "{}" });
    expect(build.status).toBe(202);

    const foreignRoot = `/api/workspaces/${foreignWorkspace.id}/repos/repo_foreign_wiki/wiki`;
    expect((await app.request(foreignRoot, { headers: auth })).status).toBe(404);
    expect((await app.request(foreignRoot, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ path: "planted.md", title: "Planted", body: "no" }),
    })).status).toBe(404);

    expect((await app.request(`${root}/${created.id}?expected_version=1`, {
      method: "DELETE",
      headers: auth,
    })).status).toBe(202);
    expect(store.getRepositoryWikiDocByRef(workspace.id, "repo_task_wiki", created.id)).toMatchObject({ body: "formal v1", version: 1 });
  });

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
