import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { OpenVikingClient, OpenVikingClientError } from "@multiremi/project-knowledge/openviking-client.js";
import { PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS } from "@multiremi/project-knowledge/service.js";
import type { OpenVikingClientContract } from "@multiremi/project-knowledge/types.js";
import {
  REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY,
  RepositoryWikiService,
} from "@multiremi/repository-wiki/service.js";
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
  /** Per-read latency once the fixture is published; models the 209 read floor. */
  readDelayMs = 0;
  private commits = 0;
  private activeReads = 0;
  maxActiveReads = 0;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const op = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push(op);
    const reading = op === "GET /api/v1/content/read";
    if (reading) {
      this.activeReads += 1;
      this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    }
    try {
      if (this.hang({ op })) {
        const signal = init!.signal!;
        return await new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (reading && this.readDelayMs > 0) await Bun.sleep(this.readDelayMs);
      return this.handle(op, url.searchParams.get("uri") ?? "", body);
    } finally {
      if (reading) this.activeReads -= 1;
    }
  }) as typeof fetch;

  reads(): number {
    return this.calls.filter((op) => op === "GET /api/v1/content/read").length;
  }

  finds(): number {
    return this.calls.filter((op) => op === "POST /api/v1/search/find").length;
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
      case "POST /api/v1/search/find": {
        // Substring match over the stored documents: enough to rank a hit list without
        // reproducing OpenViking's semantic scoring.
        const root = typeof body.target_uri === "string" ? body.target_uri : "";
        const limit = typeof body.limit === "number" ? body.limit : 20;
        const resources = [...this.files.entries()]
          .filter(([uri, content]) => uri.startsWith(`${root}/`) && content.includes(String(body.query)))
          .slice(0, limit)
          .map(([uri]) => ({ uri, score: 1, tags: [] }));
        return ok({ resources });
      }
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
async function setup(options: {
  pages?: number;
  timeoutMs?: number;
  maxRetries?: number;
  budgetMs?: number;
  /** Bodies for the fixture pages; the default is `Body <index>`. */
  body?: (index: number) => string;
} = {}) {
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
    input: {
      path: `page-${index}.md`,
      title: `Page ${index}`,
      body: options.body?.(index) ?? `Body ${index}`,
    },
  })))).map((result) => result.doc);
  await repositoryWiki.runStorageJobs();
  const budgets: Array<number | undefined> = [];
  const scope = repositoryWiki.withRequestDeadline.bind(repositoryWiki);
  repositoryWiki.withRequestDeadline = (budgetMs?: number) => {
    budgets.push(budgetMs);
    return scope(options.budgetMs ?? TEST_BUDGET_MS);
  };
  const app = createMultiremiApp({ store, repositoryWiki, authToken: "root-secret" });
  // Publishing the fixture reads every page; measure only the request under test.
  openviking.calls.length = 0;
  openviking.maxActiveReads = 0;
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { ...AUTHORIZATION, ...(init.headers as Record<string, string> | undefined) },
  });
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

  it("answers a hung ?q= search with 504 inside the budget and one timeout line", async () => {
    const { openviking, docs, request, budgets } = await setup({ pages: 4 });
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const started = Date.now();
    const { result: response, lines } = await captureTimeoutLogs(() => request(`${WIKI_ROOT}?q=Body%203`));
    expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "DEADLINE_EXCEEDED" });
    // The semantic find succeeded; the first hydrated hit spent the budget and was not replayed.
    expect(openviking.finds()).toBe(1);
    expect(openviking.reads()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "openviking_request_timeout",
      method: "GET",
      route: "/api/workspaces/:id/repos/:repositoryId/wiki",
      code: "DEADLINE_EXCEEDED",
      operation: "GET /api/v1/content/read",
    });
    expect(budgets).toEqual([undefined]);

    openviking.hang = () => false;
    const healthy = await request(`${WIKI_ROOT}?q=Body%203`);
    expect(healthy.status).toBe(200);
    expect((await healthy.json() as any).docs).toMatchObject([{ id: docs[3]!.id, body: "Body 3" }]);
    expect(openviking.finds()).toBe(2);
  });

  it("answers hung backlinks with 504 inside the budget without scheduling past the hydration bound", async () => {
    // One page more than the bound, so the hung case shows both the in-flight ceiling
    // and that no further round is scheduled after the deadline.
    const pages = REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY + 1;
    const { openviking, docs, request, budgets, store } = await setup({
      pages,
      body: (index) => index === 0 ? "Body 0" : `See [[page-0]].\nBody ${index}`,
    });
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const started = Date.now();
    const { result: response, lines } = await captureTimeoutLogs(() => request(`${WIKI_ROOT}/${docs[0]!.id}/backlinks`));
    expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "DEADLINE_EXCEEDED" });
    // Every page but the one in flight reached the bound; none was retried after the deadline.
    expect(openviking.reads()).toBe(REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY);
    expect(openviking.maxActiveReads).toBe(REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "openviking_request_timeout",
      method: "GET",
      route: "/api/workspaces/:id/repos/:repositoryId/wiki/:ref/backlinks",
      code: "DEADLINE_EXCEEDED",
      operation: "GET /api/v1/content/read",
    });
    expect(budgets).toEqual([undefined]);

    openviking.hang = () => false;
    const healthy = await request(`${WIKI_ROOT}/${docs[0]!.id}/backlinks`);
    expect(healthy.status).toBe(200);
    // Paths sort lexicographically (page-10 before page-2), so compare as sets.
    const backlinkIds = (payload: any) => (payload.docs as any[]).map((doc) => doc.id).sort();
    expect(backlinkIds(await healthy.json())).toEqual(docs.slice(1).map((doc) => doc.id).sort());

    // A single unreadable source still degrades to a skipped page instead of failing the request.
    const metadata = store.listRepositoryWikiDocs("local", "repo_deadline");
    const skipped = metadata.find((doc) => doc.id !== docs[0]!.id)!;
    openviking.files.delete(skipped.contentUri!);
    const tolerated = await request(`${WIKI_ROOT}/${docs[0]!.id}/backlinks`);
    expect(tolerated.status).toBe(200);
    expect(backlinkIds(await tolerated.json())).toEqual(docs.slice(1).map((doc) => doc.id).filter((id) => id !== skipped.id).sort());
  });

  it("answers a hung legacy list shim with 504 inside the budget and one timeout line", async () => {
    const { openviking, docs, request, budgets } = await setup({ pages: 3 });
    openviking.hang = ({ op }) => op === "GET /api/v1/content/read";
    const started = Date.now();
    const { result: response, lines } = await captureTimeoutLogs(() => request(WIKI_ROOT, {
      headers: { "User-Agent": "Bun/1.3.14" },
    }));
    expect(Date.now() - started).toBeLessThan(TEST_BUDGET_MS + 500);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "OpenViking did not respond in time", code: "DEADLINE_EXCEEDED" });
    expect(openviking.reads()).toBe(3);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "openviking_request_timeout",
      method: "GET",
      route: "/api/workspaces/:id/repos/:repositoryId/wiki",
      code: "DEADLINE_EXCEEDED",
      operation: "GET /api/v1/content/read",
    });
    expect(budgets).toEqual([undefined]);

    openviking.hang = () => false;
    const healthy = await request(WIKI_ROOT, { headers: { "User-Agent": "Bun/1.3.14" } });
    expect(healthy.status).toBe(200);
    expect((await healthy.json() as any).docs.map((doc: any) => doc.body)).toEqual(docs.map((_, index) => `Body ${index}`));
  });

  it("sizes the backlinks hydration bound to finish the largest repository inside the budget", async () => {
    // The bound is what keeps a full repository off the deadline: the largest shape
    // measured on 209 is 146 pages at a 700 ms single-read floor, and production
    // inflated that floor to about 830 ms under the old unbounded fan-out.
    expect(REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY).toBeGreaterThanOrEqual(
      Math.ceil(146 * 830 / PROJECT_KNOWLEDGE_REQUEST_BUDGET_MS),
    );
    expect(REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY).toBeLessThanOrEqual(64);

    // The same shape against a fake with the 700 ms floor: the read answers 200 well
    // inside the budget with one read per page. See tests/manual/bench-mul399-backlinks.ts.
    const pages = 146;
    const { openviking, docs, request } = await setup({
      pages,
      body: (index) => index === 0 ? "Body 0" : `See [[page-0]].\nBody ${index}`,
    });
    const started = Date.now();
    openviking.readDelayMs = 20;
    const response = await request(`${WIKI_ROOT}/${docs[0]!.id}/backlinks`);
    const wall = Date.now() - started;
    expect(response.status).toBe(200);
    expect((await response.json() as any).docs).toHaveLength(pages - 1);
    expect(openviking.reads()).toBe(pages);
    expect(openviking.maxActiveReads).toBe(REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY);
    // 146 pages / 16 in flight x 20 ms = 200 ms promised; the 600 ms test budget must hold.
    expect(wall).toBeLessThan(TEST_BUDGET_MS);
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
