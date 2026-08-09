import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseGitRemoteMetadata } from "@multiremi/api/helpers/repositories.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

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

describe("Multiremi API - workspace repositories", () => {
  it("inspects, imports, updates, lists, and removes Git repositories", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
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
    expect(await github.json()).toMatchObject({
      repository: {
        id: expect.stringMatching(/^repo_/),
        name: "remi",
        url: "https://github.com/multimira-ai/remi.git",
        source: "github",
        description: "Main product repository",
        default_branch: "release",
      },
    });

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
