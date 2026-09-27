import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { OpenVikingClient } from "@multiremi/project-knowledge/openviking-client.js";
import { PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS, ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const JSON_HEADERS = { "Content-Type": "application/json" };
/** Stands in for the 25s production budget so a hang costs well under a second here. */
const TEST_BUDGET_MS = 600;

type HangRule = (call: { op: string; body: any }) => boolean;

/** In-memory OpenViking HTTP API covering the project-doc calls; any call can be made to hang. */
class FakeOpenVikingHttp {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  hang: HangRule = () => false;
  private commits = 0;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const op = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push(op);
    if (this.hang({ op, body })) {
      const signal = init!.signal!;
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return this.handle(op, url.searchParams.get("uri") ?? "", body);
  }) as typeof fetch;

  private handle(op: string, uri: string, body: any): Response {
    switch (op) {
      case "POST /api/v1/fs/mkdir":
      case "POST /api/v1/content/set_tags":
        return ok({});
      case "POST /api/v1/search/find":
        return ok({ resources: [] });
      case "GET /api/v1/fs/stat":
        return this.files.has(uri) ? ok({ uri }) : notFound();
      case "GET /api/v1/content/read":
        return this.files.has(uri) ? ok(this.files.get(uri)) : notFound();
      case "DELETE /api/v1/fs":
        this.files.delete(uri);
        return ok({});
      case "POST /api/v1/snapshot/commit":
        return ok({ oid: `oid_${++this.commits}` });
      case "POST /api/v1/content/batch-write":
        for (const write of body.operations) {
          const current = this.files.get(write.uri);
          const allowed = write.precondition.kind === "create_if_absent"
            ? current === undefined
            : current !== undefined && write.precondition.base_hash === `sha256:${sha256(current)}`;
          if (!allowed) return Response.json({ status: "error", error: { code: "CONFLICT", message: "precondition failed" } }, { status: 409 });
          this.files.set(write.uri, write.content);
        }
        return ok({});
      default:
        return Response.json({ status: "error", error: { message: `unexpected ${op}` } }, { status: 400 });
    }
  }
}

function ok(result: unknown): Response {
  return Response.json({ status: "ok", result });
}

function notFound(): Response {
  return Response.json({ status: "error", error: { code: "NOT_FOUND" } }, { status: 404 });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function setup() {
  const store = createStore();
  const openviking = new FakeOpenVikingHttp();
  // Production's env (180s per attempt, 5 retries): the request budget has to win over it.
  const client = new OpenVikingClient({
    baseUrl: "http://openviking.internal",
    apiKey: "server-only-secret",
    timeoutMs: 180_000,
    maxRetries: 5,
    fetch: openviking.fetch,
  });
  const projectKnowledge = new ProjectKnowledgeService(store, client, "openviking");
  const budgets: Array<number | undefined> = [];
  const scope = projectKnowledge.withRequestDeadline.bind(projectKnowledge);
  projectKnowledge.withRequestDeadline = (budgetMs?: number) => {
    budgets.push(budgetMs);
    return scope(TEST_BUDGET_MS);
  };
  const app = createMultiremiApp({ store, projectKnowledge });
  const project = store.createProject({ title: "Deadline" });
  const created = await app.request(`/api/projects/${project.id}/docs`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ kind: "wiki", title: "Runbook", body: "v1 body" }),
  });
  expect(created.status).toBe(201);
  const doc = (await created.json()).doc;
  openviking.calls.length = 0;
  const docsUrl = `/api/projects/${project.id}/docs`;
  const docUrl = (ref: string = doc.slug) => `${docsUrl}/${ref}`;
  const put = (body: Record<string, unknown>) => app.request(docUrl(), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { store, openviking, app, doc, docsUrl, docUrl, put, budgets };
}

describe("project docs under an OpenViking request deadline", () => {
  it("fits the default budget inside nginx's 30s cutoff", () => {
    expect(PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS).toBe(25_000);
    expect(PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS).toBeLessThan(30_000);
  });

  it("answers a PUT against a hung OpenViking with 504 inside the budget and never replays the write", async () => {
    const { openviking, app, docUrl, put, budgets } = await setup();
    openviking.hang = ({ op }) => op === "POST /api/v1/content/batch-write";
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      const started = Date.now();
      const response = await put({ body: "v2 body" });
      expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "DEADLINE_EXCEEDED" });
      expect(openviking.calls.filter((op) => op === "POST /api/v1/content/batch-write")).toHaveLength(1);
      const line = logs.mock.calls.map(([arg]) => String(arg)).find((arg) => arg.includes("openviking_request_timeout"));
      expect(JSON.parse(line!)).toMatchObject({
        event: "openviking_request_timeout",
        method: "PUT",
        route: "/api/projects/:id/docs/:ref",
        code: "DEADLINE_EXCEEDED",
        operation: "POST /api/v1/content/batch-write",
        attempts: 1,
      });
      expect(line).not.toContain("server-only-secret");
    } finally {
      logs.mockRestore();
    }
    expect(budgets.every((budget) => budget === undefined)).toBe(true);

    openviking.hang = () => false;
    const read = await app.request(docUrl());
    expect(read.status).toBe(200);
    expect((await read.json()).doc).toMatchObject({ body: "v1 body", version: 1 });
  });

  it("rolls back a half-applied write in the budget's reserved tail so the doc stays readable", async () => {
    const { openviking, app, docUrl, put } = await setup();
    // replace has already landed the new content when the forward commit hangs.
    openviking.hang = ({ op, body }) => op === "POST /api/v1/snapshot/commit" && !String(body.message).includes(":rollback:");
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const started = Date.now();
    let response: Response;
    try {
      response = await put({ body: "v2 body" });
    } finally {
      logs.mockRestore();
    }
    expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
    expect(response.status).toBe(504);
    expect(openviking.calls.slice(-4)).toEqual([
      "GET /api/v1/content/read",
      "POST /api/v1/content/batch-write",
      "POST /api/v1/content/set_tags",
      "POST /api/v1/snapshot/commit",
    ]);

    openviking.hang = () => false;
    const read = await app.request(docUrl());
    expect(read.status).toBe(200);
    expect((await read.json()).doc).toMatchObject({ body: "v1 body", version: 1 });
  });

  it("answers a hung read with 504 inside the budget", async () => {
    const { openviking, app, docUrl } = await setup();
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      const started = Date.now();
      const response = await app.request(docUrl());
      expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
      expect(response.status).toBe(504);
    } finally {
      logs.mockRestore();
    }
  });

  it("reads, updates, renames and deletes normally when OpenViking is healthy", async () => {
    const { store, openviking, app, doc, docsUrl, docUrl, put, budgets } = await setup();
    const read = await app.request(docUrl());
    expect((await read.json()).doc).toMatchObject({ body: "v1 body", version: 1 });

    const updated = await put({ body: "v2 body", expected_version: 1 });
    expect(updated.status).toBe(200);
    expect((await updated.json()).doc).toMatchObject({ body: "v2 body", version: 2 });

    const oldUri = store.getProjectDoc(doc.id)!.contentUri!;
    const renamed = await put({ slug: "runbook-v3", body: "v3 body" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).doc).toMatchObject({ slug: "runbook-v3", body: "v3 body", version: 3 });
    expect(openviking.files.has(oldUri)).toBe(false);

    const listed = await app.request(docsUrl);
    expect((await listed.json()).docs.map((row: any) => row.slug).sort()).toEqual(["_schema", "runbook-v3"]);

    const deleted = await app.request(docUrl("runbook-v3"), { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await app.request(docUrl("runbook-v3"))).status).toBe(404);
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((budget) => budget === undefined)).toBe(true);
  });
});
