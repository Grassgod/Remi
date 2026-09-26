import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { OpenVikingClient, OpenVikingClientError } from "@multiremi/project-knowledge/openviking-client.js";
import { PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS } from "@multiremi/project-knowledge/service.js";
import type { OpenVikingClientContract } from "@multiremi/project-knowledge/types.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

/** Stands in for the 25s production budget so a hang costs well under a second here. */
const TEST_BUDGET_MS = 600;
const AUTHORIZATION = { Authorization: "Bearer root-secret" };
const WIKI_ROOT = "/api/workspaces/local/repos/repo_deadline/wiki";

type HangRule = (call: { op: string }) => boolean;

/** In-memory OpenViking HTTP API covering the repository-wiki calls; any call can be made to hang. */
class FakeOpenVikingHttp {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  hang: HangRule = () => false;
  /** Reads answered with a retryable 503 before the next one succeeds. */
  failReads = 0;
  private commits = 0;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const op = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push(op);
    if (this.hang({ op })) {
      const signal = init!.signal!;
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return this.handle(op, url.searchParams.get("uri") ?? "", body);
  }) as typeof fetch;

  reads(): number {
    return this.calls.filter((op) => op === "GET /api/v1/content/read").length;
  }

  private handle(op: string, uri: string, body: any): Response {
    switch (op) {
      case "POST /api/v1/fs/mkdir":
      case "POST /api/v1/content/set_tags":
        return ok({});
      case "GET /api/v1/fs/stat":
        return this.files.has(uri) ? ok({ uri }) : notFound();
      case "GET /api/v1/content/read":
        if (this.failReads > 0) {
          this.failReads--;
          return Response.json({ status: "error", error: { message: "busy" } }, { status: 503 });
        }
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

/** Production's env (180s per attempt, 5 retries) by default: the request budget has to win over it. */
async function setup(options: { pages?: number; timeoutMs?: number; maxRetries?: number; budgetMs?: number } = {}) {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.updateWorkspaceRepositories("local", [{
    id: "repo_deadline",
    name: "deadline",
    url: "https://github.com/acme/deadline.git",
    source: "github",
    default_branch: "main",
  }]);
  const openviking = new FakeOpenVikingHttp();
  const client = new OpenVikingClient({
    baseUrl: "http://openviking.internal",
    apiKey: "server-only-secret",
    timeoutMs: options.timeoutMs ?? 180_000,
    maxRetries: options.maxRetries ?? 5,
    fetch: openviking.fetch,
  });
  const repositoryWiki = new RepositoryWikiService(store, client, "openviking");
  const docs = (await repositoryWiki.applyBatch("local", "repo_deadline", Array.from({ length: options.pages ?? 20 }, (_, index) => ({
    kind: "create" as const,
    input: { path: `page-${index}.md`, title: `Page ${index}`, body: `Body ${index}` },
  })))).map((result) => result.doc);
  await repositoryWiki.runStorageJobs();
  const budgets: Array<number | undefined> = [];
  const scope = repositoryWiki.withRequestDeadline.bind(repositoryWiki);
  repositoryWiki.withRequestDeadline = (budgetMs?: number) => {
    budgets.push(budgetMs);
    return scope(options.budgetMs ?? TEST_BUDGET_MS);
  };
  const app = createMultiremiApp({ store, repositoryWiki, authToken: "root-secret" });
  openviking.calls.length = 0;
  const request = (path: string) => app.request(path, { headers: AUTHORIZATION });
  return { store, openviking, docs, app, request, budgets };
}

/** Runs `action` with console.log captured and returns the `openviking_request_timeout` lines it wrote. */
async function captureTimeoutLogs<T>(action: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const logs = spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await action();
    const lines = logs.mock.calls.map(([arg]) => String(arg)).filter((arg) => arg.includes("openviking_request_timeout"));
    return { result, lines };
  } finally {
    logs.mockRestore();
  }
}

describe("repository wiki reads under an OpenViking request deadline", () => {
  it("answers a hung single-page read with 504 inside the budget after one clamped attempt", async () => {
    const { openviking, docs, request, budgets } = await setup({ pages: 1 });
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const started = Date.now();
    const { result: response, lines } = await captureTimeoutLogs(() => request(`${WIKI_ROOT}/${docs[0]!.id}`));
    expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "DEADLINE_EXCEEDED" });
    // 180s per attempt and 5 retries configured, yet the one attempt ended at the budget and was not replayed.
    expect(openviking.reads()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "openviking_request_timeout",
      method: "GET",
      route: "/api/workspaces/:id/repos/:repositoryId/wiki/:ref",
      code: "DEADLINE_EXCEEDED",
      operation: "GET /api/v1/content/read",
      attempts: 1,
      budget_ms: PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS,
    });
    expect(lines[0]).not.toContain("server-only-secret");
    expect(budgets).toEqual([undefined]);

    openviking.hang = () => false;
    const read = await request(`${WIKI_ROOT}/${docs[0]!.id}`);
    expect(read.status).toBe(200);
    expect((await read.json() as any).doc).toMatchObject({ id: docs[0]!.id, body: "Body 0", version: 1 });
  });

  it("answers a hung 20-page include_body read with 504 inside the budget without scheduling more reads", async () => {
    const { openviking, docs, request, budgets } = await setup();
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const ids = docs.map((doc) => doc.id).join(",");
    const started = Date.now();
    const { result: response, lines } = await captureTimeoutLogs(() => request(`${WIKI_ROOT}?include_body=true&ids=${ids}`));
    expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "DEADLINE_EXCEEDED" });
    // The four in-flight reads share the deadline; none is retried and no fifth one starts.
    expect(openviking.reads()).toBe(4);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      method: "GET",
      route: "/api/workspaces/:id/repos/:repositoryId/wiki",
      code: "DEADLINE_EXCEEDED",
      operation: "GET /api/v1/content/read",
    });
    expect(budgets).toEqual([undefined]);
  });

  it("stops a configured attempt timeout shorter than the budget at the deadline", async () => {
    // The default env's shape (attempt timeout below the budget), scaled: 1s attempts inside a 1.5s budget.
    const { openviking, docs, request } = await setup({ pages: 1, timeoutMs: 1_000, maxRetries: 2, budgetMs: 1_500 });
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const started = Date.now();
    const { result: response } = await captureTimeoutLogs(() => request(`${WIKI_ROOT}/${docs[0]!.id}`));
    expect(Date.now() - started).toBeLessThan(1_500 + 500);
    expect(response.status).toBe(504);
    expect((await response.json() as any).code).toBe("DEADLINE_EXCEEDED");
    // The first attempt used its full second; the retry got only what was left of the budget.
    expect(openviking.reads()).toBe(2);
  });

  it("still retries a failed read when the deadline leaves room", async () => {
    const { openviking, docs, request } = await setup({ pages: 1 });
    openviking.failReads = 1;
    const response = await request(`${WIKI_ROOT}/${docs[0]!.id}`);
    expect(response.status).toBe(200);
    expect((await response.json() as any).doc.body).toBe("Body 0");
    expect(openviking.reads()).toBe(2);
  });

  it("maps an OpenViking TIMEOUT to 504 on both read paths", async () => {
    const { store, docs } = await setup({ pages: 2 });
    const timingOut = {
      read: async () => { throw new OpenVikingClientError("OpenViking request timed out", null, "TIMEOUT", true); },
    } as unknown as OpenVikingClientContract;
    const app = createMultiremiApp({
      store,
      repositoryWiki: new RepositoryWikiService(store, timingOut, "openviking"),
      authToken: "root-secret",
    });
    const { result, lines } = await captureTimeoutLogs(async () => [
      await app.request(`${WIKI_ROOT}/${docs[0]!.id}`, { headers: AUTHORIZATION }),
      await app.request(`${WIKI_ROOT}?include_body=true&ids=${docs.map((doc) => doc.id).join(",")}`, { headers: AUTHORIZATION }),
    ]);
    for (const response of result) {
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "TIMEOUT" });
    }
    expect(lines).toHaveLength(2);
  });

  it("serves single-page and include_body reads normally when OpenViking is healthy", async () => {
    const { openviking, docs, request, budgets } = await setup();
    const single = await request(`${WIKI_ROOT}/${docs[3]!.id}`);
    expect(single.status).toBe(200);
    expect((await single.json() as any).doc).toMatchObject({ id: docs[3]!.id, body: "Body 3" });

    const batch = await request(`${WIKI_ROOT}?include_body=true&ids=${docs.map((doc) => doc.id).join(",")}`);
    expect(batch.status).toBe(200);
    const bodies = (await batch.json() as any).docs.map((doc: any) => doc.body);
    expect(bodies).toEqual(docs.map((_, index) => `Body ${index}`));

    const list = await request(WIKI_ROOT);
    expect(list.status).toBe(200);
    expect((await list.json() as any).docs).toHaveLength(20);
    expect(openviking.reads()).toBe(21);
    expect(budgets).toEqual([undefined, undefined]);
  });
});
