import { afterEach, describe, expect, test } from "bun:test";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body?: any;
}

let previousTaskId: string | undefined;

afterEach(() => {
  if (previousTaskId === undefined) delete process.env.MULTIREMI_TASK_ID;
  else process.env.MULTIREMI_TASK_ID = previousTaskId;
  previousTaskId = undefined;
});

function setTaskId(taskId: string): void {
  previousTaskId = process.env.MULTIREMI_TASK_ID;
  process.env.MULTIREMI_TASK_ID = taskId;
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pdoc_1",
    project_id: "prj_1",
    workspace_id: "local",
    kind: "wiki",
    slug: "build-guide",
    title: "Build guide",
    summary: null,
    body: "",
    tags: [],
    pinned: false,
    refs: [],
    source_task_id: null,
    source_issue_id: null,
    author_type: "member",
    author_id: "local",
    updated_by_type: null,
    updated_by_id: null,
    version: 1,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/** Serves the project docs endpoints and records every request the CLI makes. */
async function withDocsServer(
  run: (serverUrl: string, requests: RecordedRequest[], logs: string[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const entry: RecordedRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
      };
      if (request.method !== "GET" && request.method !== "DELETE") entry.body = await request.json();
      requests.push(entry);
      if (url.pathname === "/api/projects/prj_1/docs" && request.method === "GET") {
        return Response.json({
          docs: [doc(), doc({ id: "pdoc_2", kind: "memory", slug: "ci-is-arm64", title: "CI is arm64", pinned: true, version: 3 })],
        });
      }
      if (url.pathname === "/api/projects/prj_1/docs" && request.method === "POST") {
        return Response.json({ doc: doc({ ...entry.body, id: "pdoc_created" }) }, { status: 201 });
      }
      if (url.pathname === "/api/projects/prj_1/docs/build-guide" && request.method === "GET") {
        return Response.json({ doc: doc() });
      }
      if (url.pathname === "/api/projects/prj_1/docs/build-guide" && request.method === "PUT") {
        return Response.json({ doc: doc({ ...entry.body, version: 2 }) });
      }
      if (url.pathname === "/api/projects/prj_1/docs/build-guide" && request.method === "DELETE") {
        return Response.json({ deleted: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { logs.push(String(value)); };
    await run(`http://127.0.0.1:${server.port}`, requests, logs);
  } finally {
    console.log = originalLog;
    server.stop(true);
  }
}

describe("Multiremi CLI project knowledge commands", () => {
  test("lists, reads, searches, and deletes project docs", async () => {
    await withDocsServer(async (serverUrl, requests, logs) => {
      await runMultiremi(["project", "doc", "list", "prj_1", "--server", serverUrl, "--token", "tok_cli", "--kind", "wiki", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["project", "doc", "list", "prj_1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["project", "doc", "get", "prj_1", "build-guide", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["project", "doc", "search", "prj_1", "arm64", "--server", serverUrl, "--token", "tok_cli", "--kind", "memory", "--limit", "5", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["project", "doc", "delete", "prj_1", "build-guide", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });

      expect(requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /api/projects/prj_1/docs?kind=wiki",
        "GET /api/projects/prj_1/docs",
        "GET /api/projects/prj_1/docs/build-guide",
        "GET /api/projects/prj_1/docs?q=arm64&kind=memory&limit=5",
        "DELETE /api/projects/prj_1/docs/build-guide",
      ]);
      expect(requests.every((entry) => entry.authorization === "Bearer tok_cli")).toBe(true);

      expect(JSON.parse(logs[0]).docs.map((row: any) => row.slug)).toEqual(["build-guide", "ci-is-arm64"]);
      // No --output json => the table renderer.
      expect(logs[1]).toContain("SLUG");
      expect(logs[1]).toContain("build-guide");
      expect(logs[1]).toContain("ci-is-arm64");
      expect(logs[1]).toContain("yes");
      expect(JSON.parse(logs[2]).doc.title).toBe("Build guide");
      expect(JSON.parse(logs[3]).docs).toHaveLength(2);
      expect(JSON.parse(logs[4])).toEqual({ deleted: true });
    });
  });

  test("maps create and update options onto the request body", async () => {
    await withDocsServer(async (serverUrl, requests, logs) => {
      await runMultiremi([
        "project", "doc", "create", "prj_1",
        "--server", serverUrl,
        "--token", "tok_cli",
        "--kind", "wiki",
        "--title", "Deploy runbook",
        "--slug", "deploy-runbook",
        "--summary", "How production ships",
        "--tags", "ops, runbook",
        "--ref", "issue:MUL-12",
        "--ref", "task:tsk_9",
        "--ref", "https://example.test/deploy",
        "--content", "See [[build-guide]].",
        "--pinned",
      ], { programName: "multiremi" });

      await runMultiremi([
        "project", "doc", "update", "prj_1", "build-guide",
        "--server", serverUrl,
        "--token", "tok_cli",
        "--title", "Build guide v2",
        "--pinned", "false",
        "--ref", "issue:MUL-13",
        "--expected-version", "1",
        "--content", "Updated body",
      ], { programName: "multiremi" });

      expect(requests[0]).toMatchObject({
        method: "POST",
        path: "/api/projects/prj_1/docs",
        body: {
          kind: "wiki",
          title: "Deploy runbook",
          slug: "deploy-runbook",
          summary: "How production ships",
          tags: ["ops", "runbook"],
          pinned: true,
          refs: [
            { type: "issue", value: "MUL-12" },
            { type: "task", value: "tsk_9" },
            { type: "url", value: "https://example.test/deploy" },
          ],
          body: "See [[build-guide]].",
        },
      });
      expect(requests[0].body.source_task_id).toBeUndefined();

      expect(requests[1]).toMatchObject({
        method: "PUT",
        path: "/api/projects/prj_1/docs/build-guide",
        body: {
          title: "Build guide v2",
          pinned: false,
          // --ref replaces the doc's refs wholesale.
          refs: [{ type: "issue", value: "MUL-13" }],
          expected_version: 1,
          body: "Updated body",
        },
      });

      expect(JSON.parse(logs[0]).doc.id).toBe("pdoc_created");
      expect(JSON.parse(logs[1]).doc.version).toBe(2);
    });
  });

  test("memory add pins the entry and carries the in-task provenance", async () => {
    setTaskId("tsk_from_env");
    await withDocsServer(async (serverUrl, requests, logs) => {
      await runMultiremi([
        "project", "memory", "add", "prj_1",
        "--server", serverUrl,
        "--token", "tok_cli",
        "--title", "Node 18 breaks the build",
        "--summary", "Use bun instead",
        "--ref", "issue:MUL-12",
        "--content", "The daemon host ships Node 18.",
      ], { programName: "multiremi" });

      expect(requests[0]).toMatchObject({
        method: "POST",
        path: "/api/projects/prj_1/docs",
        body: {
          kind: "memory",
          title: "Node 18 breaks the build",
          pinned: true,
          summary: "Use bun instead",
          refs: [{ type: "issue", value: "MUL-12" }],
          body: "The daemon host ships Node 18.",
          source_task_id: "tsk_from_env",
        },
      });
      expect(JSON.parse(logs[0]).doc.kind).toBe("memory");
    });
  });

  test("rejects malformed refs and incomplete usage", async () => {
    await withDocsServer(async (serverUrl, requests) => {
      const base = ["--server", serverUrl, "--token", "tok_cli"];
      await expect(runMultiremi(["project", "doc", "create", "prj_1", ...base, "--title", "Bad ref", "--ref", "MUL-12"], { programName: "multiremi" }))
        .rejects.toThrow("--ref \"MUL-12\" must be <type>:<value>");
      await expect(runMultiremi(["project", "doc", "create", "prj_1", ...base, "--title", "Bad pin", "--pinned", "maybe"], { programName: "multiremi" }))
        .rejects.toThrow("--pinned must be true or false");
      await expect(runMultiremi(["project", "doc", "create", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("--title is required");
      await expect(runMultiremi(["project", "doc", "get", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project doc get <project-id> <slug-or-id>");
      await expect(runMultiremi(["project", "doc", "update", "prj_1", "build-guide", ...base], { programName: "multiremi" }))
        .rejects.toThrow("no fields to update");
      await expect(runMultiremi(["project", "doc", "explode", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project doc list|get|create|update|delete|search <project-id> ...");
      await expect(runMultiremi(["project", "memory", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project memory add <project-id>");
      await expect(runMultiremi(["project", "nonsense", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project doc|memory ...");

      // Every one of those failed before reaching the network.
      expect(requests).toEqual([]);
    });
  });
});
