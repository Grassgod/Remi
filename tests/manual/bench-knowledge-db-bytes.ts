#!/usr/bin/env bun
/**
 * MUL-386 (C.2): per-SQL `db_bytes` harness for the three knowledge routes whose
 * bridge replies were 12–15 MB in production (`api_slow_request.db_bytes`).
 *
 * "db_bytes" is the payload the PG bridge worker serializes into the shared
 * buffer and the main thread parses — `JSON.stringify({ rows, count })` per
 * statement — not the HTTP response size. Deleting fields from the response
 * only is therefore not enough; the list SQL itself must stop reading the big
 * columns. This harness attributes the bytes to each statement so the fix is
 * driven by measurement instead of by eyeballing the response shape.
 *
 * Routes:
 *   GET /api/knowledge/submissions   production 11.8–14.0 MB
 *   GET /api/knowledge/runs          production 13.7–13.8 MB
 *   GET /api/projects/:id/knowledge/recall   production 15.5 MB, db_queries=101
 *
 * Two byte accounting modes, reported in the output:
 *   postgres  real `PostgresSyncDatabase` behind a wrapper that re-serializes
 *             every reply exactly like `pg-worker.ts` does. This is the accounting the
 *             acceptance criterion is stated in.
 *   sqlite    in-process `bun:sqlite` behind the same wrapper. Cheap fallback
 *             when no PostgreSQL is reachable; the wrapper makes it comparable.
 *
 * The recall scenario runs in OpenViking mode with a fake client, because SQL
 * mode answers recall from one `searchProjectDocs` statement and never reaches
 * the `findDocByUri` path production exercises.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-knowledge-db-bytes.ts --out /tmp/before.json
 *
 * The "before" numbers come from running this same file on the parent commit.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import type { OpenVikingClientContract, OpenVikingFindHit, OpenVikingSnapshotCommit } from "../../packages/server/src/project-knowledge/types.js";
import { projectKnowledgeDocUri } from "../../packages/server/src/project-knowledge/codec.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { ProjectKnowledgeService } from "../../packages/server/src/project-knowledge/service.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-386-knowledge-db-bytes.json");
const PG_URL = process.env.MULTIREMI_TEST_POSTGRES_URL?.trim() ?? "";

/** Production-like scale. Sized so each route lands in the 11–15 MB band. */
const SUBMISSIONS = Number(process.env.MUL386_SUBMISSIONS ?? 100);
const SUBMISSION_BODY_BYTES = Number(process.env.MUL386_SUBMISSION_BODY ?? 80_000);
const SUBMISSION_PATCH_BYTES = Number(process.env.MUL386_SUBMISSION_PATCH ?? 40_000);
const RUNS = Number(process.env.MUL386_RUNS ?? 100);
const RUN_SUBMISSION_SOURCES = 1;
const RUN_SCM_SOURCES = 2;
const SCM_METADATA_BYTES = Number(process.env.MUL386_SCM_METADATA ?? 35_000);
const REPOSITORY_WIKI_DOCS = Number(process.env.MUL386_REPO_DOCS ?? 120);
const REPOSITORY_WIKI_BODY_BYTES = Number(process.env.MUL386_REPO_DOC_BODY ?? 50_000);
const PROJECT_DOCS = Number(process.env.MUL386_PROJECT_DOCS ?? 40);
const PROJECT_DOC_BODY_BYTES = Number(process.env.MUL386_PROJECT_DOC_BODY ?? 20_000);
/** Recall hits; production showed ~20 hits against a project of this size. */
const RECALL_HITS = Number(process.env.MUL386_RECALL_HITS ?? 20);
const SAMPLES = Number(process.env.MUL386_SAMPLES ?? 3);
const WARMUPS = Number(process.env.MUL386_WARMUPS ?? 1);
const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);

interface StatementSample {
  /** Normalized statement label: leading verb + target object. */
  sql: string;
  calls: number;
  rows: number;
  bytes: number;
  maxBytes: number;
}

interface RouteSample {
  route: string;
  method: string;
  samples: number;
  p50Ms: number;
  responseBytes: number;
  itemsReturned: number;
  statements: number;
  dbBytes: number;
  statements_: StatementSample[];
}

interface ModeReport {
  mode: "postgres" | "sqlite";
  database: string;
  fixture: Record<string, number>;
  routes: RouteSample[];
}

/** True when the reply crossed a real worker boundary; SQLite is the fallback. */
class MeteredDb implements SqlDatabase {
  statements = 0;
  bridgeBytes = 0;
  bridgeRows = 0;
  private readonly byStatement = new Map<string, StatementSample>();

  constructor(private readonly inner: SqlDatabase, private readonly kind: string) {}

  reset(): void {
    this.statements = 0;
    this.bridgeBytes = 0;
    this.bridgeRows = 0;
    this.byStatement.clear();
  }

  breakdown(): StatementSample[] {
    return [...this.byStatement.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => right.bytes - left.bytes);
  }

  /** Mirrors `pg-worker.ts`: `JSON.stringify({ rows, count })` into the buffer. */
  private measure<T>(sql: string, run: () => T, rowsOf: (value: T) => unknown[] = () => []): T {
    const startedAt = performance.now();
    const value = run();
    const elapsed = performance.now() - startedAt;
    void elapsed;
    this.statements += 1;
    const rows = rowsOf(value);
    const bytes = rows.length ? JSON.stringify({ rows, count: rows.length }).length : 0;
    this.bridgeRows += rows.length;
    this.bridgeBytes += bytes;
    const key = statementLabel(sql);
    const entry = this.byStatement.get(key) ?? { sql: key, calls: 0, rows: 0, bytes: 0, maxBytes: 0 };
    entry.calls += 1;
    entry.rows += rows.length;
    entry.bytes += bytes;
    entry.maxBytes = Math.max(entry.maxBytes, bytes);
    this.byStatement.set(key, entry);
    return value;
  }

  private wrap(statement: SqlStatement, sql: string): SqlStatement {
    return {
      get: (...params: unknown[]) => this.measure(sql, () => statement.get(...params), (row) => (row == null ? [] : [row])),
      all: (...params: unknown[]) => this.measure(sql, () => statement.all(...params), (rows) => rows),
      run: (...params: unknown[]) => this.measure(sql, () => statement.run(...params)),
      values: (...params: unknown[]) => this.measure(sql, () => statement.values(...params), (rows) => rows),
    };
  }

  query(sql: string): SqlStatement {
    return this.wrap(this.inner.query(sql), sql);
  }
  prepare(sql: string): SqlStatement {
    return this.wrap(this.inner.prepare(sql), sql);
  }
  run(sql: string, ...params: unknown[]) {
    return this.measure(sql, () => this.inner.run(sql, ...params));
  }
  exec(sql: string): void {
    this.inner.exec(sql);
  }
  transaction<T>(fn: (...args: any[]) => T) {
    return this.inner.transaction(fn);
  }
  close(): void {
    this.inner.close();
  }
}

/** Collapse a statement to a stable label so per-SQL bytes can be ranked. */
export function statementLabel(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  const select = /^SELECT\s+(.+?)\s+FROM\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (select) return `SELECT ${select[1]!.slice(0, 40)} FROM ${select[2]}`;
  const insert = /^(INSERT(?: OR IGNORE)?\s+INTO)\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (insert) return `${insert[1]!.toUpperCase()} ${insert[2]}`;
  const update = /^UPDATE\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (update) return `UPDATE ${update[1]}`;
  const del = /^DELETE\s+FROM\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (del) return `DELETE FROM ${del[1]}`;
  return flat.slice(0, 60);
}

function filler(prefix: string, index: number, bytes: number): string {
  const head = `${prefix} #${index} `;
  return head + "lorem ipsum dolor sit amet consectetur ".repeat(Math.ceil(bytes / 40) + 1).slice(0, Math.max(0, bytes - head.length));
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Fake OpenViking index for the recall scenario.
 *
 * `find` returns the URIs a real index would return for the project's docs. Half
 * the docs deliberately have a stale/empty `content_uri`, which is the case
 * `findDocByUri`'s second clause (`docUri(doc) === uri`) exists for.
 */
class FakeOpenViking implements OpenVikingClientContract {
  readonly files = new Map<string, string>();
  hits: OpenVikingFindHit[] = [];
  findCalls = 0;

  async health(): Promise<void> {}
  async ensureDirectory(_uri: string): Promise<void> {}
  async read(uri: string): Promise<string> { return this.files.get(uri) ?? ""; }
  async exists(uri: string): Promise<boolean> { return this.files.has(uri); }
  async create(uri: string, _root: string, content: string): Promise<void> { this.files.set(uri, content); }
  async replace(uri: string, _root: string, content: string): Promise<void> { this.files.set(uri, content); }
  async remove(uri: string): Promise<void> { this.files.delete(uri); }
  async setTags(_uri: string, _tags: string[]): Promise<void> {}
  async commit(_message: string, _paths: string[]): Promise<string | null> { return null; }
  async log(_paths: string[], _limit?: number): Promise<OpenVikingSnapshotCommit[]> { return []; }
  async show(_ref: string, _path: string): Promise<string> { return ""; }
  async find(_query: string, _target: string | string[], limit: number): Promise<OpenVikingFindHit[]> {
    this.findCalls += 1;
    return this.hits.slice(0, limit);
  }
}

interface Fixture {
  projectId: string;
  repositoryId: string;
  submissionIds: string[];
  runIds: string[];
  recall: { docId: string; uri: string }[];
}

function seedFixture(store: MultiremiStore, fake: FakeOpenViking): Fixture {
  store.ensureLocalWorkspace();
  const owner = store.getCurrentUser();
  const workspace = store.getWorkspace("local")!;
  const repositoryId = "repo_bench_bridge";
  store.updateWorkspaceRepositories("local", [...workspace.repos, {
    id: repositoryId,
    name: "bridge-bytes-bench",
    url: "git@github.com:multiremi/bridge-bytes-bench.git",
    source: "github",
    default_branch: "main",
  }]);
  const project = store.createProject({ title: "Bridge bytes bench", workspaceId: "local" });
  const agent = store.createAgent({
    id: "agt_bench_bridge", name: "Bench agent", provider: "codex",
    workspaceId: "local", ownerId: owner.id, visibility: "workspace",
  });
  const issue = store.createIssue({ title: "Bridge bytes issue", workspaceId: "local", projectId: project.id });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "bench" });

  // 1) Raw submissions: large `body` + large `patch` are what the list route
  //    used to ship 100 rows of.
  const submissionIds: string[] = [];
  const submissionCreatedAt = new Date(NOW).toISOString();
  for (let index = 0; index < SUBMISSIONS; index += 1) {
    const created = store.createKnowledgeSubmission({
      workspaceId: "local",
      projectId: project.id,
      scope: "project_wiki",
      sourceType: index % 3 === 0 ? "agent" : "external",
      proposedPath: `bench/submission-${index}.md`,
      proposedSlug: `bench-submission-${index}`,
      body: filler("submission-body", index, SUBMISSION_BODY_BYTES),
      patch: filler("submission-patch", index, SUBMISSION_PATCH_BYTES),
      baseRevision: `rev-${index}`,
      sourceIssueId: issue.id,
      sourceTaskId: task.id,
      authorAgentId: agent.id,
    }).submission;
    submissionIds.push(created.id);
  }
  // Two columns the list route searches server-side; make them realistic.
  store.createKnowledgeSubmission({
    workspaceId: "local", projectId: project.id, scope: "project_wiki", sourceType: "external",
    proposedPath: "bench/needle.md", proposedSlug: "bench-needle",
    body: `FindMeNeedle ${filler("needle-body", 0, 1_000)}`,
  });

  // 2) Compilation runs: each run carries submission + SCM sources (large
  //    `metadata`) and outputs that point at repository wiki and project docs.
  const repositoryDocIds: string[] = [];
  for (let index = 0; index < REPOSITORY_WIKI_DOCS; index += 1) {
    const doc = store.createRepositoryWikiDoc("local", repositoryId, {
      path: `bench/wiki-${index}.md`,
      title: `Repository wiki doc ${index}`,
      summary: `summary ${index}`,
      body: filler("repository-wiki-body", index, REPOSITORY_WIKI_BODY_BYTES),
      authorType: "agent",
      authorId: agent.id,
    });
    repositoryDocIds.push(doc.id);
  }
  const projectDocIds: string[] = [];
  for (let index = 0; index < PROJECT_DOCS; index += 1) {
    const doc = store.createProjectDoc(project.id, {
      kind: "wiki",
      path: `bench/project-doc-${index}.md`,
      slug: `bench-project-doc-${index}`,
      title: `Project doc ${index}`,
      summary: `summary ${index}`,
      body: filler("project-doc-body", index, PROJECT_DOC_BODY_BYTES),
      authorType: "agent",
      authorId: agent.id,
    });
    projectDocIds.push(doc.id);
    // Every other doc gets a stale/empty content_uri so recall has to fall back
    // to the kind+slug URI derived from the codec.
    if (index % 2 === 1) {
      store.setProjectDocSyncState(doc.id, {
        storageBackend: "openviking",
        syncStatus: "ready",
        contentUri: undefined,
      });
    } else {
      const uri = projectKnowledgeDocUri({ workspaceId: "local", projectId: project.id, kind: "wiki", slug: `bench-project-doc-${index}` });
      store.setProjectDocSyncState(doc.id, {
        storageBackend: "openviking",
        syncStatus: "ready",
        contentUri: uri,
        contentSha256: "0".repeat(64),
      });
      fake.files.set(uri, "body");
    }
  }

  const runIds: string[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const run = store.createKnowledgeCompilationRun({
      workspaceId: "local",
      projectId: project.id,
      repositoryId,
      taskId: task.id,
      agentId: agent.id,
      mode: "issue_ingest",
      status: "published",
    }).run;
    runIds.push(run.id);
    for (let source = 0; source < RUN_SUBMISSION_SOURCES; source += 1) {
      store.addKnowledgeRunSubmissionSource(run.id, submissionIds[(index + source) % submissionIds.length]!);
    }
    for (let source = 0; source < RUN_SCM_SOURCES; source += 1) {
      store.addKnowledgeRunScmSource(run.id, `scm_event_${index}_${source}`, {
        event_type: "change.merged",
        change_number: index * 10 + source,
        change_title: filler("change-title", index, 200),
        changed_files: [filler("file", index, SCM_METADATA_BYTES)],
        after_sha: "a".repeat(40),
      });
    }
    store.recordKnowledgeCompilationOutput({
      runId: run.id,
      artifactScope: "repository_wiki",
      docId: repositoryDocIds[index % repositoryDocIds.length]!,
      version: 1,
      action: "create",
    });
    store.recordKnowledgeCompilationOutput({
      runId: run.id,
      artifactScope: "project_wiki",
      docId: projectDocIds[index % projectDocIds.length]!,
      version: 1,
      action: "create",
    });
  }
  void submissionCreatedAt;

  // 3) recall hits: ~20 project docs, matching production's hit count.
  const recall = [];
  for (let index = 0; index < RECALL_HITS; index += 1) {
    const docIndex = Math.floor((index * PROJECT_DOCS) / RECALL_HITS) % PROJECT_DOCS;
    const doc = store.getProjectDoc(projectDocIds[docIndex]!);
    if (!doc) continue;
    const uri = doc.contentUri
      ?? projectKnowledgeDocUri({ workspaceId: "local", projectId: project.id, kind: doc.kind, slug: doc.slug });
    recall.push({ docId: doc.id, uri });
  }
  fake.hits = recall.map(({ uri }) => ({ uri, score: 0.9, abstract: "recall hit", tags: [] }));

  return { projectId: project.id, repositoryId, submissionIds, runIds, recall };
}

interface Scenario {
  label: string;
  path: string;
  items: (body: any) => number;
}

const SCENARIOS: Scenario[] = [
  { label: "submissions list", path: "/api/knowledge/submissions?limit=100", items: (body) => body.submissions.length },
  { label: "runs list", path: "/api/knowledge/runs?limit=100", items: (body) => body.runs.length },
  { label: "recall", path: "", items: (body) => body.hits.length },
];

async function measureMode(kind: "postgres" | "sqlite", out: ModeReport): Promise<void> {
  let inner: SqlDatabase;
  let databaseLabel: string;
  let cleanup: () => Promise<void> | void = () => {};

  if (kind === "postgres") {
    const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
    const admin = new Bun.SQL(PG_URL, { max: 1 });
    const dbName = `multiremi_mul386_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const version = String((await admin`SHOW server_version`)[0]?.server_version ?? "unknown");
    await admin.end();
    const url = new URL(PG_URL);
    url.pathname = `/${dbName}`;
    const raw = new PostgresSyncDatabase(url.toString());
    inner = raw;
    databaseLabel = `PostgreSQL ${version}`;
    cleanup = async () => {
      raw.close();
      const drop = new Bun.SQL(PG_URL, { max: 1 });
      await drop.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await drop.end();
    };
  } else {
    inner = new Database(":memory:") as unknown as SqlDatabase;
    databaseLabel = "bun:sqlite in-memory";
  }

  const metered = new MeteredDb(inner, kind);
  const store = new MultiremiStore(metered);
  const fake = new FakeOpenViking();
  const fixture = seedFixture(store, fake);
  const projectKnowledge = new ProjectKnowledgeService(store, fake, "openviking");
  const app = createMultiremiApp({
    store,
    authToken: "root-secret",
    projectKnowledge,
    requestMetrics: { enabled: false, slowRequestMs: 500, summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 128 },
  });
  const headers = { Authorization: "Bearer root-secret" };

  const routes: RouteSample[] = [];
  for (const scenario of SCENARIOS) {
    const path = scenario.path || `/api/projects/${fixture.projectId}/knowledge/recall?q=bench&limit=${RECALL_HITS}`;
    const durations: number[] = [];
    let responseBytes = 0;
    let itemsReturned = 0;
    let statements = 0;
    let dbBytes = 0;
    let breakdown: StatementSample[] = [];
    for (let sample = 0; sample < WARMUPS + SAMPLES; sample += 1) {
      metered.reset();
      const startedAt = performance.now();
      const response = await app.request(path, { headers });
      const text = await response.text();
      const elapsed = performance.now() - startedAt;
      if (response.status !== 200) throw new Error(`${scenario.label}: HTTP ${response.status} ${text.slice(0, 300)}`);
      if (sample < WARMUPS) continue;
      const parsed = JSON.parse(text) as unknown;
      durations.push(elapsed);
      responseBytes = text.length;
      itemsReturned = scenario.items(parsed);
      statements = metered.statements;
      dbBytes = metered.bridgeBytes;
      breakdown = metered.breakdown();
    }
    routes.push({
      route: scenario.label,
      method: "GET",
      samples: durations.length,
      p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
      responseBytes,
      itemsReturned,
      statements,
      dbBytes,
      statements_: breakdown,
    });
  }

  out.mode = kind;
  out.database = databaseLabel;
  out.fixture = {
    submissions: SUBMISSIONS,
    submission_body_bytes: SUBMISSION_BODY_BYTES,
    submission_patch_bytes: SUBMISSION_PATCH_BYTES,
    runs: RUNS,
    scm_sources_per_run: RUN_SCM_SOURCES,
    scm_metadata_bytes: SCM_METADATA_BYTES,
    repository_wiki_docs: REPOSITORY_WIKI_DOCS,
    repository_wiki_body_bytes: REPOSITORY_WIKI_BODY_BYTES,
    project_docs: PROJECT_DOCS,
    project_doc_body_bytes: PROJECT_DOC_BODY_BYTES,
    recall_hits: fixture.recall.length,
  };
  out.routes = routes;
  await cleanup();
}

async function postgresReachable(): Promise<boolean> {
  if (!PG_URL) return false;
  try {
    const probe = new Bun.SQL(PG_URL, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

function printReport(report: ModeReport): void {
  console.log(`\n== ${report.mode} (${report.database}) ==`);
  for (const route of report.routes) {
    console.log(`\n${route.route}: db_bytes=${route.dbBytes} (${(route.dbBytes / 1_048_576).toFixed(2)} MiB) ` +
      `statements=${route.statements} response=${route.responseBytes} items=${route.itemsReturned} p50=${route.p50Ms}ms`);
    for (const statement of route.statements_.slice(0, 8)) {
      console.log(`    ${String(statement.bytes).padStart(9)}  x${String(statement.calls).padStart(3)}  rows=${String(statement.rows).padStart(4)}  ${statement.sql}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;
  const modes: Array<"postgres" | "sqlite"> = [];
  const requested = args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "auto";
  if (requested === "postgres" || requested === "auto") {
    if (await postgresReachable()) modes.push("postgres");
    else if (requested === "postgres") throw new Error(`MULTIREMI_TEST_POSTGRES_URL is not reachable: ${PG_URL}`);
  }
  if (requested === "sqlite" || requested === "auto") modes.push("sqlite");

  const reports: ModeReport[] = [];
  for (const mode of modes) {
    const report: ModeReport = { mode, database: "", fixture: {}, routes: [] };
    await measureMode(mode, report);
    printReport(report);
    reports.push(report);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: { bun: Bun.version },
    accounting: "db_bytes = JSON.stringify({ rows, count }) per statement, matching pg-worker.ts",
    reports,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${outPath}`);
}

await main();
