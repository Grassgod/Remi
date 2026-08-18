import { afterEach, describe, expect, test } from "bun:test";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body?: any;
}

let previousTaskId: string | undefined;
let previousProjectId: string | undefined;

afterEach(() => {
  if (previousTaskId === undefined) delete process.env.MULTIREMI_TASK_ID;
  else process.env.MULTIREMI_TASK_ID = previousTaskId;
  previousTaskId = undefined;
  if (previousProjectId === undefined) delete process.env.MULTIREMI_PROJECT_ID;
  else process.env.MULTIREMI_PROJECT_ID = previousProjectId;
  previousProjectId = undefined;
});

function setTaskId(taskId: string): void {
  previousTaskId = process.env.MULTIREMI_TASK_ID;
  process.env.MULTIREMI_TASK_ID = taskId;
}

function setProjectId(projectId: string): void {
  previousProjectId = process.env.MULTIREMI_PROJECT_ID;
  process.env.MULTIREMI_PROJECT_ID = projectId;
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
      if (url.pathname === "/api/project-docs" && request.method === "GET") {
        return Response.json({
          docs: [
            doc({ project_title: "Project One" }),
            doc({ id: "pdoc_2", kind: "memory", slug: "ci-is-arm64", title: "CI is arm64", pinned: true, version: 3, project_title: "Project One" }),
          ],
        });
      }
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
      if (url.pathname === "/api/projects/prj_1/knowledge/recall" && request.method === "GET") {
        const kind = url.searchParams.get("kind") ?? "memory";
        return Response.json({ hits: [{ ...doc({ kind }), score: 0.88, snippet: "semantic hit", uri: `viking://${kind}` }] });
      }
      if (url.pathname === "/api/projects/prj_1/docs/build-guide/backlinks" && request.method === "GET") {
        return Response.json({ docs: [doc({ slug: "index", title: "Index" })] });
      }
      if (url.pathname === "/api/projects/prj_1/docs/build-guide/revisions" && request.method === "GET") {
        return Response.json({ revisions: [{ version: 1, body: "v1" }] });
      }
      if (url.pathname === "/api/project-knowledge/migration" && request.method === "GET") {
        return Response.json({ mode: "shadow", total: 2, failed: 0 });
      }
      if (url.pathname === "/api/project-knowledge/migration/backfill" && request.method === "POST") {
        return Response.json({ dryRun: entry.body.dry_run, scanned: 2, migrated: 2, failed: 0 });
      }
      if (url.pathname === "/api/project-knowledge/migration/verify" && request.method === "POST") {
        return Response.json({ scanned: 2, migrated: 2, failed: 0 });
      }
      if (url.pathname === "/api/project-knowledge/migration/retry-failed" && request.method === "POST") {
        return Response.json({ scanned: 1, migrated: 1, failed: 0 });
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
  test("lists workspace knowledge and reads, searches, and deletes project wiki pages", async () => {
    await withDocsServer(async (serverUrl, requests, logs) => {
      await runMultiremi(["wiki", "list", "--server", serverUrl, "--token", "tok_cli", "--workspace", "local", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["wiki", "list", "--project", "prj_1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["wiki", "read", "build-guide", "--project", "prj_1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });
      await runMultiremi(["wiki", "search", "arm64", "--project", "prj_1", "--server", serverUrl, "--token", "tok_cli", "--limit", "5", "--output", "json"], { programName: "multiremi" });
      await runMultiremi(["wiki", "delete", "build-guide", "--project", "prj_1", "--server", serverUrl, "--token", "tok_cli"], { programName: "multiremi" });

      expect(requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /api/project-docs?kind=wiki&workspace_id=local",
        "GET /api/projects/prj_1/docs?kind=wiki",
        "GET /api/projects/prj_1/docs/build-guide",
        "GET /api/projects/prj_1/knowledge/recall?q=arm64&kind=wiki&limit=5",
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
      expect(JSON.parse(logs[3]).hits[0].score).toBe(0.88);
      expect(JSON.parse(logs[4])).toEqual({ deleted: true });
    });
  });

  test("maps create and update options onto the request body", async () => {
    await withDocsServer(async (serverUrl, requests, logs) => {
      await runMultiremi([
        "wiki", "create", "--project", "prj_1",
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
        "wiki", "update", "build-guide", "--project", "prj_1",
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
        "memory", "remember", "--project", "prj_1",
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

  test("uses the task project environment when --project is omitted", async () => {
    setProjectId("prj_1");
    await withDocsServer(async (serverUrl, requests, logs) => {
      await runMultiremi([
        "memory", "read", "build-guide",
        "--server", serverUrl,
        "--token", "tok_cli",
      ], { programName: "multiremi" });

      expect(requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /api/projects/prj_1/docs/build-guide",
      ]);
      expect(JSON.parse(logs[0]).doc.title).toBe("Build guide");
    });
  });

  test("supports recall, backlinks, revisions and migration maintenance", async () => {
    await withDocsServer(async (serverUrl, requests, logs) => {
      const base = ["--server", serverUrl, "--token", "tok_cli", "--workspace", "ws_cli", "--output", "json"];
      await runMultiremi(["memory", "recall", "rollback owner", "--project", "prj_1", ...base, "--limit", "3"], { programName: "multiremi" });
      await runMultiremi(["memory", "search", "global owner", ...base, "--limit", "4"], { programName: "multiremi" });
      await runMultiremi(["memory", "backlinks", "build-guide", "--project", "prj_1", ...base], { programName: "multiremi" });
      await runMultiremi(["wiki", "history", "build-guide", "--project", "prj_1", ...base], { programName: "multiremi" });
      await runMultiremi(["project", "knowledge", "status", ...base], { programName: "multiremi" });
      await runMultiremi(["project", "knowledge", "backfill", "prj_1", ...base, "--dry-run", "--resume"], { programName: "multiremi" });
      await runMultiremi(["project", "knowledge", "verify", "prj_1", ...base], { programName: "multiremi" });
      await runMultiremi(["project", "knowledge", "retry-failed", "prj_1", ...base], { programName: "multiremi" });

      expect(requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /api/projects/prj_1/knowledge/recall?q=rollback+owner&kind=memory&limit=3",
        "GET /api/project-docs?kind=memory&workspace_id=ws_cli&q=global+owner&limit=4",
        "GET /api/projects/prj_1/docs/build-guide/backlinks",
        "GET /api/projects/prj_1/docs/build-guide/revisions",
        "GET /api/project-knowledge/migration?workspace_id=ws_cli",
        "POST /api/project-knowledge/migration/backfill",
        "POST /api/project-knowledge/migration/verify",
        "POST /api/project-knowledge/migration/retry-failed",
      ]);
      expect(JSON.parse(logs[0]).hits[0].score).toBe(0.88);
      expect(JSON.parse(logs[1]).docs).toHaveLength(2);
      expect(JSON.parse(logs[2]).docs[0].slug).toBe("index");
      expect(JSON.parse(logs[3]).revisions[0].body).toBe("v1");
      expect(JSON.parse(logs[4]).mode).toBe("shadow");
      expect(requests[5]!.body).toEqual({ project_id: "prj_1", workspace_id: "ws_cli", dry_run: true, resume: true });
      expect(requests[6]!.body).toEqual({ project_id: "prj_1", workspace_id: "ws_cli" });
      expect(requests[7]!.body).toEqual({ project_id: "prj_1", workspace_id: "ws_cli" });
    });
  });

  test("rejects malformed refs and incomplete usage", async () => {
    await withDocsServer(async (serverUrl, requests) => {
      const base = ["--server", serverUrl, "--token", "tok_cli"];
      await expect(runMultiremi(["wiki", "create", "--project", "prj_1", ...base, "--title", "Bad ref", "--ref", "MUL-12"], { programName: "multiremi" }))
        .rejects.toThrow("--ref \"MUL-12\" must be <type>:<value>");
      await expect(runMultiremi(["wiki", "create", "--project", "prj_1", ...base, "--title", "Bad pin", "--pinned", "maybe"], { programName: "multiremi" }))
        .rejects.toThrow("--pinned must be true or false");
      await expect(runMultiremi(["wiki", "create", "--project", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("--title is required");
      await expect(runMultiremi(["wiki", "read", ...base, "--project", "prj_1"], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi wiki read <slug-or-id> --project <project-id>");
      await expect(runMultiremi(["wiki", "update", "build-guide", "--project", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("no fields to update");
      await expect(runMultiremi(["wiki", "explode", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi wiki list|search|read|create|update|delete|history|backlinks");
      await expect(runMultiremi(["memory", "explode", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi memory list|search|recall|read|remember|update|forget|backlinks");
      await expect(runMultiremi(["memory", "remember", ...base, "--title", "Missing scope"], { programName: "multiremi" }))
        .rejects.toThrow("--project <project-id> is required for memory remember");
      await expect(runMultiremi(["project", "doc", "list", "prj_1", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project knowledge");
      await expect(runMultiremi(["project", "memory", "recall", "prj_1", "query", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project knowledge");
      await expect(runMultiremi(["project", "nonsense", ...base], { programName: "multiremi" }))
        .rejects.toThrow("usage: multiremi project knowledge");

      // Every one of those failed before reaching the network.
      expect(requests).toEqual([]);
    });
  });
});
