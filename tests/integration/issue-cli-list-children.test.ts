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
  const squad = store.createSquad({ name: "CLI squad" });
  const assignments = [
    { type: "member", id: member.id },
    { type: "agent", id: agent.id },
    { type: "squad", id: squad.id },
  ] as const;
  const assignedIssues = assignments.map(({ type, id }) =>
    store.createIssue({ title: `Assigned to ${type}`, assigneeType: type, assigneeId: id }));
  const parent = store.createIssue({ title: "CLI parent" });
  const child = store.createIssue({ title: "CLI child", parentIssueId: parent.id });
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
