import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API - workspace repositories", () => {
  it("imports, lists, deduplicates, and removes GitHub and Codebase repositories", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store });

    const github = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/multimira-ai/remi.git",
        source: "github",
        description: "Main product repository",
        default_branch: "main",
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
        default_branch: "main",
      },
    });

    const codebase = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "git@code.byted.org:dev/agent-platform.git",
        source: "codebase",
      }),
    });
    expect(codebase.status).toBe(201);
    const codebaseBody = await codebase.json();
    expect(codebaseBody.repository).toMatchObject({
      name: "agent-platform",
      source: "codebase",
      default_branch: null,
    });

    const listed = await app.request("/api/workspaces/local/repos");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(2);
    expect(listedBody.repositories.map((repo: { source: string }) => repo.source)).toEqual([
      "github",
      "codebase",
    ]);

    const duplicate = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/multimira-ai/remi/",
        source: "github",
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "repository is already imported" });

    const invalid = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-git-remote", source: "codebase" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid git repository URL" });

    const removed = await app.request(
      `/api/workspaces/local/repos/${encodeURIComponent(codebaseBody.repository.id)}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).workspace.repos).toHaveLength(1);
  });

  it("only lets project creation attach repositories already imported into the workspace", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store });

    const imported = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/multimira-ai/remi.git",
        source: "github",
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
});
