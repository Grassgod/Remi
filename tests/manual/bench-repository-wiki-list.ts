#!/usr/bin/env bun
/**
 * MUL-387: `GET /api/workspaces/:id/repos/:repositoryId/wiki` before/after
 * harness.
 *
 * Seeds a repository with 146 pages whose bodies live behind an OpenViking
 * client that takes 700ms per read, then times the real route through
 * `app.request()`. The acceptance target is p95 < 200ms for the default list:
 * the route must serve DB rows without touching OpenViking at all.
 *
 *   bun run tests/manual/bench-repository-wiki-list.ts --out /tmp/after.json
 *
 * The "before" number comes from running the same file on the parent commit.
 * Run it on the 209 read-only host only through a checkout; this script never
 * talks to production.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import { RepositoryWikiService } from "../../packages/server/src/repository-wiki/service.js";
import type {
  OpenVikingClientContract,
  OpenVikingFindHit,
  OpenVikingSnapshotCommit,
} from "../../packages/server/src/project-knowledge/types.js";
import { createStore, resetMultiremiTestEnv } from "../unit/multiremi/helpers.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-387-repository-wiki-list.json");

const PAGES = Number(process.env.MUL387_PAGES ?? 146);
const READ_DELAY_MS = Number(process.env.MUL387_READ_DELAY_MS ?? 700);
const WARMUPS = Number(process.env.MUL387_WARMUPS ?? 5);
const SAMPLES = Number(process.env.MUL387_SAMPLES ?? 100);
const WORKSPACE = "local";
const REPOSITORY_ID = "repo_bench";

/** Mock OpenViking with the production read latency; counts every read. */
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
    } finally {
      this.activeReads--;
    }
  }
  async exists(uri: string): Promise<boolean> { return this.files.has(uri); }
  async create(uri: string, _rootUri: string, content: string): Promise<void> { this.files.set(uri, content); }
  async replace(uri: string, _rootUri: string, content: string): Promise<void> { this.files.set(uri, content); }
  async remove(uri: string): Promise<void> { this.files.delete(uri); }
  async setTags(): Promise<void> {}
  async find(): Promise<OpenVikingFindHit[]> { return []; }
  async commit(): Promise<string> { return "bench"; }
  async show(_oid: string, uri: string): Promise<string> { return this.files.get(uri) ?? ""; }
  async history(): Promise<OpenVikingSnapshotCommit[]> { return []; }
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]!) : DEFAULT_OUT;

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
  // Seed with reads disabled so the fixture itself is instant; the delay only
  // models the OpenViking cost the measured route must avoid.
  await service.applyBatch(WORKSPACE, REPOSITORY_ID, Array.from({ length: PAGES }, (_, index) => ({
    kind: "create" as const,
    input: { path: `page-${index}.md`, title: `Page ${index}`, body: `Body ${index}` },
  })));
  await service.runStorageJobs();
  // Restore the delayed read so any accidental hydration shows up as latency.
  client.readDelayMs = READ_DELAY_MS;
  client.readCalls = 0;
  client.maxActiveReads = 0;

  const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "root-secret" });
  const path = `/api/workspaces/${WORKSPACE}/repos/${REPOSITORY_ID}/wiki`;
  const headers = { Authorization: "Bearer root-secret" };

  let pageCount = 0;
  for (let index = 0; index < WARMUPS; index++) {
    const response = await app.request(path, { headers });
    if (response.status !== 200) throw new Error(`warmup ${index} returned ${response.status}`);
    pageCount = ((await response.json()) as { docs: unknown[] }).docs.length;
  }
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const start = performance.now();
    const response = await app.request(path, { headers });
    samples.push(performance.now() - start);
    if (response.status !== 200) throw new Error(`sample ${index} returned ${response.status}`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);

  const report = {
    issue: "MUL-387",
    generatedAt: new Date().toISOString(),
    measurement: {
      note: "In-process SQLite measurement through app.request(). It isolates the route from PostgreSQL, network transfer and serialization cost, and it is not a production measurement.",
      mockOpenVikingReadDelayMs: READ_DELAY_MS,
      pages: PAGES,
      warmups: WARMUPS,
      samples: SAMPLES,
      reproduce: "bun run tests/manual/bench-repository-wiki-list.ts --out <path>",
    },
    list: { pageCount, p50_ms: p50, p95_ms: p95, p99_ms: p99, max_ms: sorted.at(-1)!, samples: samples.length },
    openviking: { readCalls: client.readCalls, maxActiveReads: client.maxActiveReads },
    acceptance: {
      p95Under200ms: p95 < 200,
      noOpenVikingReads: client.readCalls === 0,
    },
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`repository wiki list: pages=${pageCount} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms openviking_reads=${client.readCalls}`);
  console.log(`report written to ${out}`);

  await resetMultiremiTestEnv();
  if (!report.acceptance.p95Under200ms || !report.acceptance.noOpenVikingReads) process.exitCode = 1;
}

await main();
