import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { signIssueShareId } from "@multiremi/api/helpers/issue-share-tokens.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const ROOT_CREDENTIAL = "root-cli-secret";
const SHARE_SECRET = "share-signing-secret";

describe("Multiremi API - CLI context and capabilities", () => {
  it("enforces the Human/Task/Daemon/Share/Anonymous matrix on both endpoints", async () => {
    const fixture = await cliFixture();
    const identities = [
      { name: "human", headers: bearer(fixture.human), status: 200, type: "human" },
      { name: "task", headers: bearer(fixture.task), status: 200, type: "task" },
      { name: "daemon", headers: bearer(fixture.daemon), status: 200, type: "daemon" },
      { name: "share", headers: { "X-Remi-Share": fixture.share }, status: 200, type: "share" },
      { name: "anonymous", headers: {}, status: 401, type: null },
    ];

    for (const path of ["/api/cli/context", "/api/cli/capabilities"]) {
      for (const identity of identities) {
        const response = await fixture.app.request(path, { headers: identity.headers });
        expect(response.status, `${identity.name} ${path}`).toBe(identity.status);
        if (identity.type) {
          const body = await response.json();
          const responseType = typeof body.identity === "string" ? body.identity : body.identity?.type;
          expect(responseType, `${identity.name} ${path}`).toBe(identity.type);
        }
      }
    }

    const invalidShare = await fixture.app.request("/api/cli/context", {
      headers: { "X-Remi-Share": `${fixture.share}x` },
    });
    expect(invalidShare.status).toBe(401);

    const remoteWorkspace = fixture.store.createWorkspace({ id: "ws_shared", name: "Shared", slug: "shared" }, "local");
    const remoteIssue = fixture.store.createIssue({ title: "Remote share", workspaceId: remoteWorkspace.id });
    const remoteShare = fixture.store.ensureIssueShare(remoteIssue.id, remoteWorkspace.id, "local", 60);
    const remoteShareValue = signIssueShareId(remoteShare.id, SHARE_SECRET);
    const remoteContext = await fixture.app.request("/api/cli/context", {
      headers: { "X-Remi-Share": remoteShareValue },
    });
    expect(remoteContext.status).toBe(200);
    expect((await remoteContext.json()).workspace.id).toBe(remoteWorkspace.id);
  });

  it("returns only safe directory and current-task fields without serialized secrets", async () => {
    const fixture = await cliFixture();
    const requests = [
      ["/api/cli/context", bearer(fixture.human)],
      ["/api/cli/context", bearer(fixture.task)],
      ["/api/cli/context", bearer(fixture.daemon)],
      ["/api/cli/context", { "X-Remi-Share": fixture.share }],
      ["/api/cli/capabilities", bearer(fixture.human)],
      ["/api/cli/capabilities", bearer(fixture.task)],
      ["/api/cli/capabilities", bearer(fixture.daemon)],
      ["/api/cli/capabilities", { "X-Remi-Share": fixture.share }],
    ] as const;
    const bodies: Record<string, unknown>[] = [];
    for (const [path, headers] of requests) {
      const response = await fixture.app.request(path, { headers });
      expect(response.status).toBe(200);
      bodies.push(await response.json() as Record<string, unknown>);
    }

    for (const body of bodies) {
      expect(sensitiveFieldPaths(body)).toEqual([]);
      const serialized = JSON.stringify(body);
      for (const secret of fixture.secrets) expect(serialized).not.toContain(secret);
      expect(serialized).not.toMatch(/Bearer\s+\S+/i);
    }

    const taskContext = bodies[1] as any;
    expect(taskContext.current).toMatchObject({
      task: { id: fixture.taskId, status: "queued" },
      issue: { id: fixture.issueId, title: "CLI context issue" },
      bound_issue: null,
      project: { id: fixture.projectId, name: "CLI context project" },
      agent: { id: fixture.agentId, name: "CLI Agent" },
    });
    expect(taskContext.catalog.projects).toEqual([
      expect.objectContaining({ id: fixture.projectId, repository_ids: [fixture.repositoryId] }),
    ]);
    expect(taskContext.catalog.repositories).toEqual([
      expect.objectContaining({
        id: fixture.repositoryId,
        url: "https://example.com/org/remi.git",
        default_branch: "main",
      }),
    ]);
    expect(taskContext.current.task).not.toHaveProperty("prompt");
    expect(taskContext.current.agent).not.toHaveProperty("instructions");

    const daemonContext = bodies[2] as any;
    expect(daemonContext.catalog).toEqual({ projects: [], repositories: [], next_cursor: null });
    expect(daemonContext.current.runtimes).toEqual([
      expect.objectContaining({ id: fixture.runtimeId, name: "CLI Runtime" }),
    ]);

    const shareContext = bodies[3] as any;
    expect(shareContext.current.issue).toEqual(expect.objectContaining({ id: fixture.issueId }));
    expect(shareContext.catalog).toEqual({ projects: [], repositories: [], next_cursor: null });
  });

  it("exposes a chat session's bound Issue without changing the task-owned Issue", async () => {
    const fixture = await cliFixture();
    const chat = fixture.store.createChatSession({
      agentId: fixture.agentId,
      workspaceId: "local",
      title: "Bound Issue topic",
    });
    const chatTask = fixture.store.sendChatMessage(chat.id, { body: "How is this going?" }).task;
    fixture.store.updateChatSession(chat.id, { issueId: fixture.issueId });
    const taskCredential = await fixture.store.createTaskAccessToken(chatTask, "local");

    const response = await fixture.app.request("/api/cli/context", {
      headers: bearer(taskCredential.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;

    expect(body.current).toMatchObject({
      task: {
        id: chatTask.id,
        issue_id: null,
        chat_id: chat.id,
      },
      chat: {
        id: chat.id,
        issue_id: fixture.issueId,
      },
      issue: null,
      bound_issue: {
        id: fixture.issueId,
        key: fixture.store.getIssue(fixture.issueId)!.key,
        title: "CLI context issue",
      },
    });
  });

  it("gives task tokens owner parity inside their workspace while hard-denying identity and lifecycle operations", async () => {
    const fixture = await cliFixture();
    const taskHeaders = bearer(fixture.task);

    expect((await fixture.app.request("/api/workspaces/local", { headers: taskHeaders })).status).toBe(200);
    expect((await fixture.app.request("/api/workspaces/local", {
      method: "PATCH",
      headers: { ...taskHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated by owner task" }),
    })).status).toBe(200);

    for (const [method, path, body] of [
      ["POST", "/api/tokens", { name: "No" }],
      ["GET", "/api/multiremi/members", undefined],
      ["POST", "/api/workspaces", { name: "No" }],
    ] as const) {
      const response = await fixture.app.request(path, {
        method,
        headers: { ...taskHeaders, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).code).toBe("task_token_hard_denied");
    }

    const repositories = await fixture.app.request("/api/workspaces/local/repos", { headers: taskHeaders });
    expect(repositories.status).toBe(200);
    expect((await repositories.json()).repositories).toEqual([
      expect.objectContaining({
        id: fixture.repositoryId,
        url: "https://repo-user-secret@example.com/org/remi.git?access=repo-url-secret",
      }),
    ]);

    const created = await fixture.app.request(`/api/projects/${fixture.projectId}/docs`, {
      method: "POST",
      headers: { ...taskHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "memory", title: "Task memory", body: "Current project only" }),
    });
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual(expect.objectContaining({
      submission_id: expect.stringMatching(/^ksub_/),
      status: "pending",
    }));

    const sibling = fixture.store.createProject({ title: "Sibling", workspaceId: "local" });
    const siblingRead = await fixture.app.request(`/api/projects/${sibling.id}`, { headers: taskHeaders });
    const siblingDocs = await fixture.app.request(`/api/projects/${sibling.id}/docs`, { headers: taskHeaders });
    const siblingResources = await fixture.app.request(`/api/projects/${sibling.id}/resources`, { headers: taskHeaders });
    expect([siblingRead.status, siblingDocs.status, siblingResources.status]).toEqual([200, 200, 200]);

    const foreign = fixture.store.createWorkspace({ id: "ws_task_foreign", name: "Foreign", slug: "foreign" }, "local");
    const foreignRead = await fixture.app.request(`/api/workspaces/${foreign.id}`, { headers: taskHeaders });
    expect(foreignRead.status).toBe(404);

    const humanContext = await fixture.app.request("/api/cli/context", { headers: bearer(fixture.human) });
    const taskContext = await fixture.app.request("/api/cli/context", { headers: taskHeaders });
    expect((await taskContext.json()).allowed_operations).toEqual((await humanContext.json()).allowed_operations);
  });

  it("records structured audit fields for allowed and hard-denied task writes", async () => {
    const fixture = await cliFixture();
    const taskHeaders = { ...bearer(fixture.task), "Content-Type": "application/json" };
    const auditRows: Record<string, unknown>[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const row = args.find((value) => typeof value === "object" && value !== null
        && (value as Record<string, unknown>).event === "task_token_write");
      if (row) auditRows.push(row as Record<string, unknown>);
    };
    try {
      expect((await fixture.app.request("/api/workspaces/local", {
        method: "PATCH",
        headers: taskHeaders,
        body: JSON.stringify({ description: "Audited" }),
      })).status).toBe(200);
      expect((await fixture.app.request("/api/tokens", {
        method: "POST",
        headers: taskHeaders,
        body: JSON.stringify({ name: "Denied" }),
      })).status).toBe(403);
    } finally {
      console.log = originalLog;
    }

    expect(auditRows).toEqual([
      {
        event: "task_token_write",
        task_id: fixture.taskId,
        workspace_id: "local",
        method: "PATCH",
        path: "/api/workspaces/local",
        status_code: 200,
      },
      {
        event: "task_token_write",
        task_id: fixture.taskId,
        workspace_id: "local",
        method: "POST",
        path: "/api/tokens",
        status_code: 403,
        deny_category: "access_credentials",
      },
    ]);
    expect(JSON.stringify(auditRows)).not.toContain(fixture.task);
  });
});

async function cliFixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const repositoryUrl = "https://repo-user-secret@example.com/org/remi.git?access=repo-url-secret";
  store.updateWorkspace("local", {
    settings: { private_secret: "workspace-settings-secret" },
    repos: [{
      id: "repo_cli",
      name: "Remi",
      url: repositoryUrl,
      description: "Main repository",
      default_branch: "main",
    }],
  });
  const project = store.createProject({
    title: "CLI context project",
    description: "Safe project description",
    instructions: "project-instructions-secret",
    workspaceId: "local",
    resources: [{ resourceType: "github_repo", resourceRef: { url: repositoryUrl } }],
  });
  const runtime = store.registerRuntime({
    id: "rt_cli_context",
    name: "CLI Runtime",
    provider: "codex",
    daemonId: "daemon-cli",
    workspaceId: "local",
    metadata: { private_secret: "runtime-metadata-secret" },
  });
  const agent = store.createAgent({
    name: "CLI Agent",
    provider: "codex",
    workspaceId: "local",
    runtimeId: runtime.id,
    instructions: "agent-instructions-secret",
    customEnv: { API_SECRET: "agent-env-secret" },
  });
  const issue = store.createIssue({
    title: "CLI context issue",
    workspaceId: "local",
    projectId: project.id,
    assigneeType: "agent",
    assigneeId: agent.id,
  });
  const session = store.createIssueSession(issue.id, {
    title: "CLI delivery",
    createdByType: "member",
    createdById: "local",
  });
  const task = store.createTask({
    agentId: agent.id,
    runtimeId: runtime.id,
    issueId: issue.id,
    issueSessionId: session.id,
    workspaceId: "local",
    prompt: "task-prompt-secret",
  });
  const human = await store.createAccessToken({
    name: "CLI human",
    type: "pat",
    purpose: "cli",
    workspaceId: "local",
    userId: "local",
  });
  const taskCredential = await store.createAccessToken({
    name: "CLI task",
    type: "task",
    purpose: "task",
    workspaceId: "local",
    userId: "local",
    taskId: task.id,
    agentId: agent.id,
    expiresInDays: 1,
  });
  const daemon = await store.createAccessToken({
    name: "CLI daemon",
    type: "daemon",
    purpose: "daemon",
    workspaceId: "local",
    userId: "local",
    daemonId: "daemon-cli",
  });
  const shareRecord = store.ensureIssueShare(issue.id, "local", "local", 60);
  const share = signIssueShareId(shareRecord.id, SHARE_SECRET);
  const app = createMultiremiApp({
    store,
    authToken: ROOT_CREDENTIAL,
    shareSecret: SHARE_SECRET,
  });
  return {
    app,
    store,
    human: human.token,
    task: taskCredential.token,
    daemon: daemon.token,
    share,
    taskId: task.id,
    issueId: issue.id,
    projectId: project.id,
    agentId: agent.id,
    runtimeId: runtime.id,
    repositoryId: "repo_cli",
    secrets: [
      ROOT_CREDENTIAL,
      SHARE_SECRET,
      human.token,
      taskCredential.token,
      daemon.token,
      share,
      "repo-user-secret",
      "repo-url-secret",
      "workspace-settings-secret",
      "project-instructions-secret",
      "runtime-metadata-secret",
      "agent-instructions-secret",
      "agent-env-secret",
      "task-prompt-secret",
    ],
  };
}

function bearer(value: string): Record<string, string> {
  return { Authorization: `Bearer ${value}` };
}

function sensitiveFieldPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => sensitiveFieldPaths(entry, `${prefix}[${index}]`));
  const paths: string[] = [];
  for (const [field, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${field}` : field;
    if (/(?:authorization|token|password|secret|api[-_]?key|credential|cookie)/i.test(field)) paths.push(path);
    paths.push(...sensitiveFieldPaths(child, path));
  }
  return paths;
}
