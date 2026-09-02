import { afterEach, describe, expect, it } from "bun:test";
import { dispatch } from "../../../apps/remi/cli/index.js";

const previousProjectId = process.env.MULTIREMI_PROJECT_ID;
const previousToken = process.env.MULTIREMI_TOKEN;
const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
  if (previousProjectId === undefined) delete process.env.MULTIREMI_PROJECT_ID;
  else process.env.MULTIREMI_PROJECT_ID = previousProjectId;
  if (previousToken === undefined) delete process.env.MULTIREMI_TOKEN;
  else process.env.MULTIREMI_TOKEN = previousToken;
});

describe("knowledge CLI control plane", () => {
  it("registers and executes submit, inspection, publish, and legacy migration commands", async () => {
    delete process.env.MULTIREMI_PROJECT_ID;
    delete process.env.MULTIREMI_TOKEN;
    const requests: Array<{ method: string; path: string; body: any }> = [];
    const allowed = [
      "knowledge.submit",
      "knowledge.submissions",
      "knowledge.inspect",
      "knowledge.runs",
      "knowledge.run.show",
      "knowledge.migrate-legacy",
      "memory.publish",
      "wiki.publish",
    ];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "GET" ? null : await request.json();
        if (url.pathname !== "/api/cli/capabilities") {
          requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
        }
        if (url.pathname === "/api/cli/capabilities") {
          return Response.json({ commands: allowed.map((id) => ({ id, allowed: true })) });
        }
        if (url.pathname === "/api/projects/prj_1") return Response.json({ id: "prj_1", title: "Project" });
        if (url.pathname === "/api/workspaces/local/repos") {
          return Response.json({ repositories: [{ id: "repo_1", name: "repo", url: "git@github.com:acme/repo.git" }] });
        }
        if (url.pathname === "/api/knowledge/submissions" && request.method === "POST") {
          return Response.json({ submission: { id: "ksub_1", status: "pending" }, deduplicated: false }, { status: 201 });
        }
        if (url.pathname === "/api/knowledge/submissions" && request.method === "GET") {
          return Response.json({ submissions: [{ id: "ksub_1", status: "pending" }], next_cursor: "ksub_next" });
        }
        if (url.pathname === "/api/knowledge/submissions/ksub_1") {
          return Response.json({ submission: { id: "ksub_1", status: "pending" } });
        }
        if (url.pathname === "/api/knowledge/runs" && request.method === "GET") {
          return Response.json({ runs: [{ id: "krun_1", status: "published" }], next_cursor: "krun_next" });
        }
        if (url.pathname === "/api/knowledge/runs/krun_1") {
          return Response.json({ run: { id: "krun_1", status: "published" }, sources: [], outputs: [] });
        }
        if (url.pathname === "/api/knowledge/migrate-legacy") {
          return Response.json({ dry_run: true, total: 3, succeeded: 0, skipped: 0, errors: 0 });
        }
        if (url.pathname.endsWith("/knowledge/publish") || url.pathname.endsWith("/wiki/publish")) {
          return Response.json({ run: { id: "krun_publish", status: "published" }, outputs: [] });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    console.log = (value?: unknown) => { logs.push(String(value)); };
    const common = ["--server", `http://127.0.0.1:${server.port}`, "--token", "task-token", "--workspace", "local", "--output", "json"];
    try {
      await dispatch(["knowledge", "submit", "--scope", "memory", "--project", "prj_1", "--slug", "fact", "--content", "raw body", ...common]);
      await dispatch(["knowledge", "submissions", "--scope", "memory", "--status", "pending", "--limit", "1", "--cursor", "ksub_cursor", ...common]);
      await dispatch(["knowledge", "inspect", "ksub_1", ...common]);
      await dispatch(["knowledge", "runs", "--status", "published", "--limit", "1", "--cursor", "krun_cursor", ...common]);
      await dispatch(["knowledge", "run", "show", "krun_1", ...common]);
      await dispatch(["knowledge", "migrate-legacy", "--project", "prj_1", "--dry-run", "--batch-size", "25", ...common]);
      await dispatch(["memory", "publish", "--project", "prj_1", "--submission", "ksub_1", "--dedupe-key", "memory-1", "--title", "Fact", "--content", "curated", ...common]);
      await dispatch(["wiki", "publish", "--repo", "repo_1", "--submission", "ksub_1", "--dedupe-key", "repo-1", "--path", "overview.md", "--title", "Overview", "--content", "curated", ...common]);
    } finally {
      server.stop(true);
    }

    expect(requests.find((entry) => entry.method === "POST" && entry.path === "/api/knowledge/submissions")?.body).toMatchObject({
      workspace_id: "local",
      project_id: "prj_1",
      scope: "memory",
      proposed_slug: "fact",
      body: "raw body",
    });
    expect(requests.find((entry) => entry.path === "/api/knowledge/migrate-legacy")?.body).toMatchObject({
      project_id: "prj_1",
      batch_size: 25,
      dry_run: true,
      execute: false,
    });
    const submissionListUrl = new URL(
      requests.find((entry) => entry.method === "GET" && entry.path.startsWith("/api/knowledge/submissions?"))!.path,
      "http://localhost",
    );
    expect(submissionListUrl.searchParams.get("limit")).toBe("1");
    expect(submissionListUrl.searchParams.get("cursor")).toBe("ksub_cursor");
    const runListUrl = new URL(
      requests.find((entry) => entry.method === "GET" && entry.path.startsWith("/api/knowledge/runs?"))!.path,
      "http://localhost",
    );
    expect(runListUrl.searchParams.get("limit")).toBe("1");
    expect(runListUrl.searchParams.get("cursor")).toBe("krun_cursor");
    expect(logs.join("\n")).toContain('"next_cursor": "ksub_next"');
    expect(logs.join("\n")).toContain('"next_cursor": "krun_next"');
    expect(requests.find((entry) => entry.path === "/api/projects/prj_1/knowledge/publish")?.body).toMatchObject({
      submission_ids: ["ksub_1"],
      dedupe_key: "memory-1",
      output: { action: "create", kind: "memory", title: "Fact", body: "curated" },
    });
    expect(requests.find((entry) => entry.path === "/api/workspaces/local/repos/repo_1/wiki/publish")?.body).toMatchObject({
      submission_ids: ["ksub_1"],
      dedupe_key: "repo-1",
      output: { action: "create", kind: "wiki", path: "overview.md", body: "curated" },
    });
    expect(logs).toHaveLength(8);
  });
});
