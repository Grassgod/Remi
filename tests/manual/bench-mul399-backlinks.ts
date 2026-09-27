#!/usr/bin/env bun
/**
 * MUL-399 evidence: healthy-path wall time of the repository wiki backlinks
 * read on the largest known repository shape (146 pages, page bodies linking
 * the target) against the per-read floor measured on 209 (700 ms).
 *
 * Answers one question the issue left open: the suggested hydration bound of 4
 * cannot finish a 146-page repository inside the 25 s request budget
 * (ceil(146/4) x 700 ms = 25.9 s), while the deadline turns that healthy read
 * into a 504. The sweep prints the wall time each candidate bound needs.
 *
 *   MUL399_READ_DELAY_MS=700 bun run tests/manual/bench-mul399-backlinks.ts
 *
 * In-process SQLite through app.request(); mocked OpenViking latency; no
 * production access.
 */
import { performance } from "node:perf_hooks";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import { RepositoryWikiService, REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY } from "../../packages/server/src/repository-wiki/service.js";
import type { OpenVikingClientContract, OpenVikingFindHit, OpenVikingSnapshotCommit } from "../../packages/server/src/project-knowledge/types.js";
import { createStore, resetMultiremiTestEnv } from "../unit/multiremi/helpers.js";

const PAGES = Number(process.env.MUL399_PAGES ?? 146);
const READ_DELAY_MS = Number(process.env.MUL399_READ_DELAY_MS ?? 700);
const BUDGET_MS = Number(process.env.MUL399_BUDGET_MS ?? 25_000);
const WORKSPACE = "local";
const REPOSITORY_ID = "repo_bench";

/** Mock OpenViking with the production read floor; counts reads and peak concurrency. */
class SlowOpenViking implements OpenVikingClientContract {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readDelayMs = 0;
  readCalls = 0;
  maxActiveReads = 0;
  private activeReads = 0;

  async health(): Promise<void> {}
  async ensureDirectory(uri: string): Promise<void> { this.directories.add(uri); }
  async read(uri: string): Promise<string> {
    this.readCalls++;
    this.activeReads++;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    try {
      if (this.readDelayMs > 0) await Bun.sleep(this.readDelayMs);
      const value = this.files.get(uri);
      if (value === undefined) throw new Error(`not found: ${uri}`);
      return value;
    } finally { this.activeReads--; }
  }
  async exists(uri: string): Promise<boolean> { return this.files.has(uri); }
  async create(uri: string, _rootUri: string, content: string): Promise<void> { this.files.set(uri, content); }
  async replace(uri: string, _rootUri: string, content: string): Promise<void> { this.files.set(uri, content); }
  async remove(uri: string): Promise<void> { this.files.delete(uri); }
  async setTags(): Promise<void> {}
  async find(): Promise<OpenVikingFindHit[]> { return []; }
  async commit(): Promise<string | null> { return "bench"; }
  async log(): Promise<OpenVikingSnapshotCommit[]> { return []; }
  async show(_targetRef: string, path: string): Promise<string> { return this.files.get(path) ?? ""; }
}

async function main(): Promise<void> {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.updateWorkspaceRepositories(WORKSPACE, [{
    id: REPOSITORY_ID,
    name: "bench",
    url: "https://github.com/acme/bench.git",
    source: "github",
    default_branch: "main",
  }]);
  const client = new SlowOpenViking();
  const service = new RepositoryWikiService(store, client, "openviking");
  const docs = (await service.applyBatch(WORKSPACE, REPOSITORY_ID, Array.from({ length: PAGES }, (_, index) => ({
    kind: "create" as const,
    input: {
      path: `page-${index}.md`,
      title: `Page ${index}`,
      body: index === 0 ? "Target page" : `See [[page-0]].\nBody ${index}`,
    },
  })))).map(result => result.doc);
  await service.runStorageJobs();

  const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "root-secret" });
  const authorization = { Authorization: "Bearer root-secret" };
  const url = `/api/workspaces/${WORKSPACE}/repos/${REPOSITORY_ID}/wiki/${docs[0]!.id}/backlinks`;

  client.readDelayMs = 0;
  const warm = await app.request(url, { headers: authorization });
  console.log(`pages=${PAGES} readDelayMs=${READ_DELAY_MS} budgetMs=${BUDGET_MS} effectiveBound=${REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY} warmup=${warm.status}`);

  client.readDelayMs = READ_DELAY_MS;
  client.readCalls = 0;
  client.maxActiveReads = 0;
  const started = performance.now();
  const response = await app.request(url, { headers: authorization });
  const wall = performance.now() - started;
  const promisedByBound = Math.ceil(PAGES / REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY) * READ_DELAY_MS;
  console.log(JSON.stringify({
    issue: "MUL-399",
    bound: REPOSITORY_WIKI_BACKLINK_HYDRATE_CONCURRENCY,
    pages: PAGES,
    readDelayMs: READ_DELAY_MS,
    budgetMs: BUDGET_MS,
    status: response.status,
    wallMs: Number(wall.toFixed(1)),
    reads: client.readCalls,
    maxActiveReads: client.maxActiveReads,
    promisedRoundsPerBound: promisedByBound,
    naiveSerialMs: PAGES * READ_DELAY_MS,
  }, null, 2));
  resetMultiremiTestEnv();
}

await main();
