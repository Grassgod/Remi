import { createResponsibleTestIssue } from "../unit/multiremi/helpers.js";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "../unit/multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);

test("issue CLI filters assignee types and resolves a parent key over local HTTP", async () => {
  const store = createStore();
  store.ensureLocalWorkspace();
  const member = store.createWorkspaceMember({ name: "CLI member" });
  const agent = store.createAgent({ name: "CLI agent", provider: "codex" });
  const squad = store.createSquad({ name: "CLI squad", leaderId: agent.id });
  const assignments = [
    { type: "member", id: member.id },
    { type: "agent", id: agent.id },
    { type: "squad", id: squad.id },
  ] as const;
  const assignedIssues = assignments.map(({ type, id }) => {
    const issue = createResponsibleTestIssue(store, { title: `Assigned to ${type}`,
      assigneeType: type === 'member' ? 'agent' : type, assigneeId: type === 'member' ? agent.id : id });
    // Read-only CLI filtering must still display a genuine legacy member row.
    // New Issue writes reject a member execution owner; this is snapshot seeding.
    if (type === 'member') (store as unknown as { db: { run: (sql: string, params: string[]) => unknown } }).db
      .run("UPDATE multiremi_issues SET assignee_type='member',assignee_id=? WHERE id=?", [id, issue.id]);
    return issue;
  });
  const parent = createResponsibleTestIssue(store, { title: "CLI parent" });
  const child = createResponsibleTestIssue(store, { title: "CLI child", parentIssueId: parent.id });
  const authToken = randomUUID();
  const app = createMultiremiApp({ store, authToken });
  const requests: URL[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push(new URL(request.url));
      return app.fetch(request);
    },
  });
  const root = resolve(import.meta.dir, "../..");
  const env = {
    ...process.env,
    MULTIREMI_TOKEN: authToken,
    MULTIREMI_CONFIG: join(tmpdir(), `mul415-unused-config-${randomUUID()}.json`),
  };

  async function runCli(args: string[]) {
    const cliArgs = [...args, "--server", server.url.toString(), "--workspace", "local", "--output", "json"];
    const cliProcess = Bun.spawn([process.execPath, "run", "apps/remi/main.ts", ...cliArgs], {
      cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cliProcess.stdout).text(), new Response(cliProcess.stderr).text(), cliProcess.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const body = JSON.parse(stdout) as {
      total: number;
      issues: Array<{ id: string; identifier: string; title: string; assignee_type: string | null }>;
    };
    console.log(`$ bun run apps/remi/main.ts ${cliArgs.join(" ")}`);
    console.log(JSON.stringify({ total: body.total, issues: body.issues.map(({ identifier, title, assignee_type }) => ({ identifier, title, assignee_type })) }));
    return body;
  }

  try {
    const rejected = Bun.spawn([process.execPath, "run", "apps/remi/main.ts", "issue", "assign", parent.id, "--to", member.id, "--to-type", "member", "--server", server.url.toString(), "--workspace", "local", "--output", "json"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [rejectedError, rejectedCode] = await Promise.all([new Response(rejected.stderr).text(), rejected.exited]);
    expect(rejectedCode).not.toBe(0);
    expect(rejectedError).toContain("Execution assignee must be an Agent or Squad");
    expect(store.getIssue(parent.id)?.assigneeType).toBeNull();
    expect(requests.some(url => url.pathname === `/api/issues/${parent.id}`)).toBe(false);
    const humanSubmit = Bun.spawn([process.execPath, "run", "apps/remi/main.ts", "issue", "delivery", "submit", parent.id, "--summary", "Human cannot impersonate execution coordinator", "--server", server.url.toString(), "--workspace", "local", "--output", "json"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [submitError, submitCode] = await Promise.all([new Response(humanSubmit.stderr).text(), humanSubmit.exited]);
    expect(submitCode).not.toBe(0);
    expect(submitError).toContain("current credential cannot run issue.delivery.submit");
    expect(requests.some(url => url.pathname === `/api/issues/${parent.id}/deliveries`)).toBe(false);
    for (const [index, { type }] of assignments.entries()) {
      const result = await runCli(["issue", "list", "--assignee-type", type]);
      expect(result.total).toBe(1);
      expect(result.issues.map((issue) => issue.id)).toEqual([assignedIssues[index]!.id]);
      expect(result.issues[0]!.assignee_type).toBe(type);
    }
    const children = await runCli(["issue", "children", parent.key]);
    expect(children.total).toBe(1);
    expect(children.issues.map((issue) => issue.id)).toEqual([child.id]);
    const listRequests = requests.filter((url) => url.pathname === "/api/issues");
    expect(listRequests.map((url) => url.searchParams.get("assignee_types"))).toEqual(["member", "agent", "squad"]);
    expect(listRequests.every((url) => !url.searchParams.has("assignee_type"))).toBe(true);
    expect(requests.some((url) => url.pathname === "/api/issues/children" && url.searchParams.get("parent_ids") === parent.key)).toBe(true);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("issue CLI resolves the same parent key within each explicitly selected workspace", async () => {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ name: "CLI workspace owner", email: "cli-workspace-owner@example.test" });
  const records = ["A", "B"].map((label) => {
    const workspace = store.createWorkspace({ name: `Workspace ${label}`, slug: `cli-workspace-${label.toLowerCase()}` }, owner.id);
    const parent = createResponsibleTestIssue(store, { workspaceId: workspace.id, title: `${label} parent` });
    const child = createResponsibleTestIssue(store, { workspaceId: workspace.id, title: `${label} child`, parentIssueId: parent.id });
    return { workspace, parent, child };
  });
  expect(records.map(({ parent }) => parent.key)).toEqual(["MUL-1", "MUL-1"]);
  const authToken = randomUUID();
  const app = createMultiremiApp({ store, authToken });
  const requests: Array<{ url: URL; workspaceId: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push({ url: new URL(request.url), workspaceId: request.headers.get("X-Workspace-ID") });
      return app.fetch(request);
    },
  });
  const root = resolve(import.meta.dir, "../..");
  const env = {
    ...process.env,
    MULTIREMI_TOKEN: authToken,
    MULTIREMI_CONFIG: join(tmpdir(), `mul415-unused-config-${randomUUID()}.json`),
  };
  try {
    for (const { workspace, parent, child } of records) {
      const cliArgs = ["issue", "children", parent.key, "--server", server.url.toString(), "--workspace", workspace.id, "--output", "json"];
      const cliProcess = Bun.spawn([process.execPath, "run", "apps/remi/main.ts", ...cliArgs], {
        cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(cliProcess.stdout).text(), new Response(cliProcess.stderr).text(), cliProcess.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const body = JSON.parse(stdout) as { total: number; issues: Array<{ id: string; title: string }> };
      expect(body.total).toBe(1);
      expect(body.issues.map((issue) => issue.id)).toEqual([child.id]);
      console.log(`$ bun run apps/remi/main.ts ${cliArgs.join(" ")}`);
      console.log(JSON.stringify({ total: body.total, titles: body.issues.map((issue) => issue.title) }));
    }
    const childrenRequests = requests.filter(({ url }) => url.pathname === "/api/issues/children");
    expect(childrenRequests.map(({ workspaceId }) => workspaceId)).toEqual(records.map(({ workspace }) => workspace.id));
    expect(childrenRequests.every(({ url }) => url.searchParams.get("parent_ids") === "MUL-1"
      && !url.searchParams.has("workspace_id") && !url.searchParams.has("workspaceId"))).toBe(true);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("issue CLI resolves a full parent ID outside the default workspace", async () => {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ name: "CLI default owner", email: "cli-default-owner@example.test" });
  const workspace = store.createWorkspace({ name: "Workspace A", slug: "cli-default-a" }, owner.id);
  const parent = createResponsibleTestIssue(store, { workspaceId: workspace.id, title: "A parent" });
  const child = createResponsibleTestIssue(store, { workspaceId: workspace.id, title: "A child", parentIssueId: parent.id });
  const authToken = randomUUID();
  const app = createMultiremiApp({ store, authToken });
  const workspaceHeaders: Array<string | null> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/issues/children") workspaceHeaders.push(request.headers.get("X-Workspace-ID"));
      return app.fetch(request);
    },
  });
  const root = resolve(import.meta.dir, "../..");
  const env = {
    ...process.env,
    MULTIREMI_TOKEN: authToken,
    MULTIREMI_WORKSPACE_ID: "local",
    MULTIREMI_CONFIG: join(tmpdir(), `mul415-unused-config-${randomUUID()}.json`),
  };
  try {
    for (const workspaceArgs of [[], ["--workspace", workspace.id]]) {
      const cliArgs = ["issue", "children", parent.id, ...workspaceArgs, "--server", server.url.toString(), "--output", "json"];
      const cliProcess = Bun.spawn([process.execPath, "run", "apps/remi/main.ts", ...cliArgs], {
        cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(cliProcess.stdout).text(), new Response(cliProcess.stderr).text(), cliProcess.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const body = JSON.parse(stdout) as { total: number; issues: Array<{ id: string; title: string }> };
      expect(body.total).toBe(1);
      expect(body.issues.map((issue) => issue.id)).toEqual([child.id]);
      console.log(`$ MULTIREMI_WORKSPACE_ID=local bun run apps/remi/main.ts ${cliArgs.join(" ")}`);
      console.log(JSON.stringify({ total: body.total, titles: body.issues.map((issue) => issue.title) }));
    }
    expect(workspaceHeaders).toEqual(["local", workspace.id]);
  } finally {
    server.stop(true);
  }
}, 20_000);
