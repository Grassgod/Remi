import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const originalEncryptionKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Multiremi API — JIT Git credentials", () => {
  it("authorizes daemon and active task credentials without exposing other repositories", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    const repositoryUrl = "git@github.com:example/private.git";
    const otherRepositoryUrl = "git@github.com:example/other.git";
    store.updateWorkspace("local", {
      repos: [
        { id: "repo_private", name: "private", url: repositoryUrl, defaultBranch: "main" },
        { id: "repo_other", name: "other", url: otherRepositoryUrl, defaultBranch: "main" },
      ],
    });
    store.createScmConnection({
      id: "scm_github",
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "poll",
      accessToken: "github-short-lived-token",
      repositoryIds: ["repo_private", "repo_other"],
    });

    const daemon = await store.createAccessToken({
      name: "Daemon",
      type: "daemon",
      purpose: "daemon",
      workspaceId: "local",
      userId: "local",
      daemonId: "daemon_local",
    });
    const agent = store.createAgent({ name: "Git Agent", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Private project", workspaceId: "local" });
    store.createProjectResource(project.id, {
      resourceType: "github_repo",
      resourceRef: { url: repositoryUrl },
    });
    const issue = store.createIssue({ title: "Use private repo", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "push" });
    const runtime = store.registerRuntime({ id: "rt_git", name: "codex", provider: "codex" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const taskCredential = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
    const pat = await store.createAccessToken({
      name: "Human",
      type: "pat",
      purpose: "personal",
      workspaceId: "local",
      userId: "local",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const requestCredential = (token: string, repo: string, workspaceId = "local") => app.request(
      "/api/daemon/scm/git-credentials",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, repositoryUrl: repo }),
      },
    );

    const daemonResponse = await requestCredential(daemon.token, repositoryUrl);
    expect(daemonResponse.status).toBe(200);
    expect(daemonResponse.headers.get("cache-control")).toBe("no-store");
    expect(await daemonResponse.json()).toMatchObject({
      repositoryId: "repo_private",
      repositoryUrl,
      cloneUrl: "https://github.com/example/private.git",
      username: "x-access-token",
      password: "github-short-lived-token",
    });

    const taskResponse = await requestCredential(taskCredential.token, repositoryUrl);
    expect(taskResponse.status).toBe(200);
    expect((await taskResponse.json()).password).toBe("github-short-lived-token");
    expect((await requestCredential(taskCredential.token, otherRepositoryUrl)).status).toBe(404);
    expect((await requestCredential(taskCredential.token, repositoryUrl, "another-workspace")).status).toBe(403);
    expect((await requestCredential(pat.token, repositoryUrl)).status).toBe(403);

    store.completeTask(task.id, { output: "done" });
    const terminal = await requestCredential(taskCredential.token, repositoryUrl);
    // Completion revokes the task token before the route can issue anything.
    expect(terminal.status).toBe(401);
  });
});
