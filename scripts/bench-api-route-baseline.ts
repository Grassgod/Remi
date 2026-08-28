#!/usr/bin/env bun
/**
 * MUL-176 API route / SQL baseline.
 *
 * Runs representative read-heavy requests for all 38 router modules plus
 * additional issue/task hotspots over a controlled in-memory SQLite fixture.
 * No production service or database is contacted.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SqlStatement } from "@multiremi/store/db/postgres.js";
import {
  buildSnapshotApp,
  SNAPSHOT_STATUS_ONLY_ROUTES,
  snapshotConcretePath,
  snapshotRouteTable,
  type SeedRefs,
} from "./snapshot-api-routes.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const OUTPUT_PATH = join(REPO_ROOT, "reports", "performance", "MUL-176-api-route-baseline.json");
const TMP_ROOT = "/tmp/mul176-api-route-baseline";
const WARMUPS = 5;
const SAMPLES = 30;

interface SqlExecution {
  sql: string;
  params: unknown[];
  operation: string;
}

interface SqlBucket {
  key: string;
  sql: string;
  params: unknown[];
  count: number;
}

class SqlTracker {
  enabled = false;
  executions: SqlExecution[] = [];

  reset(): void {
    this.executions = [];
  }

  record(sql: string, params: unknown[], operation: string): void {
    if (!this.enabled) return;
    this.executions.push({ sql: normalizeSql(sql), params: normalizeParams(params), operation });
  }

  buckets(): SqlBucket[] {
    const buckets = new Map<string, SqlBucket>();
    for (const execution of this.executions) {
      const key = `${execution.sql}\u0000${JSON.stringify(execution.params)}`;
      const bucket = buckets.get(key) ?? {
        key,
        sql: execution.sql,
        params: execution.params,
        count: 0,
      };
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((left, right) => right.count - left.count || left.sql.localeCompare(right.sql));
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function normalizeParams(params: unknown[]): unknown[] {
  const values = params.length === 1 && Array.isArray(params[0]) ? params[0] as unknown[] : params;
  return values.map((value) => {
    if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

function trackedStatement(statement: SqlStatement, sql: string, tracker: SqlTracker): SqlStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          tracker.record(sql, params, String(property));
          return (target[property as keyof SqlStatement] as (...args: unknown[]) => unknown).apply(target, params);
        };
      }
      const value = target[property as keyof SqlStatement];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function trackedDatabase(database: Database, tracker: SqlTracker): Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => trackedStatement(target[property](sql) as unknown as SqlStatement, sql, tracker);
      }
      if (property === "run") {
        return (sql: string, ...params: unknown[]) => {
          tracker.record(sql, params, "run");
          return target.run(sql, ...params as any[]);
        };
      }
      if (property === "exec") {
        return (sql: string) => {
          tracker.record(sql, [], "exec");
          return target.exec(sql);
        };
      }
      const value = target[property as keyof Database];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Database;
}

interface Probe {
  router: string;
  method: "GET" | "POST";
  path: (refs: SeedRefs) => string;
  body?: unknown;
  representative?: boolean;
}

const FOCUSED_PROBES: Probe[] = [
  { router: "agent-plugins", method: "GET", path: () => "/api/multiremi/agent-plugins?workspaceId=local", representative: true },
  { router: "agent-templates", method: "GET", path: () => "/api/multiremi/agent-templates", representative: true },
  { router: "agents", method: "GET", path: () => "/api/multiremi/agents?workspaceId=local", representative: true },
  { router: "attachments", method: "GET", path: (r) => `/api/multiremi/attachments/${r.attachmentId}`, representative: true },
  { router: "auth", method: "GET", path: () => "/auth/lark/url?redirect_uri=https%3A%2F%2Fbenchmark.invalid%2Fcallback", representative: true },
  { router: "autopilots", method: "GET", path: () => "/api/multiremi/autopilots?workspaceId=local", representative: true },
  { router: "chat", method: "GET", path: () => "/api/multiremi/chats?workspaceId=local", representative: true },
  { router: "cli-latest-version", method: "GET", path: () => "/api/cli/latest-version", representative: true },
  { router: "cli", method: "GET", path: () => "/api/cli/context", representative: true },
  { router: "cloud-billing", method: "GET", path: () => "/api/cloud-billing/balance", representative: true },
  { router: "cloud-runtime", method: "GET", path: () => "/api/cloud-runtime", representative: true },
  { router: "comments", method: "GET", path: (r) => `/api/multiremi/comments/${r.commentId}/reactions`, representative: true },
  { router: "daemon-retirement", method: "GET", path: () => "/api/multiremi/daemons/dmn_snapshot/retirement-plan?workspace_id=local", representative: true },
  { router: "daemon", method: "GET", path: (r) => `/api/daemon/tasks/${r.taskId}/status`, representative: true },
  { router: "dashboard", method: "GET", path: () => "/api/dashboard/agent-runtime?workspace_id=local", representative: true },
  { router: "feishu-ingest", method: "GET", path: () => "/api/workspaces/local/feishu/messages", representative: true },
  { router: "inbox", method: "GET", path: (r) => `/api/inbox?member_id=${r.inboxMemberId}`, representative: true },
  { router: "invitations", method: "GET", path: () => "/api/workspaces/local/invitations", representative: true },
  { router: "issue-shares", method: "GET", path: (r) => `/api/issues/${r.issueId}/share`, representative: true },
  { router: "issues", method: "GET", path: (r) => `/api/issues/${r.issueId}/timeline`, representative: true },
  { router: "labels", method: "GET", path: () => "/api/multiremi/labels?workspaceId=local", representative: true },
  { router: "me", method: "GET", path: () => "/api/me", representative: true },
  { router: "members", method: "GET", path: () => "/api/workspaces/local/members", representative: true },
  { router: "notification-channels", method: "GET", path: () => "/api/multiremi/notification-channels?workspaceId=local", representative: true },
  { router: "notification-preferences", method: "GET", path: () => "/api/multiremi/notification-preferences?workspaceId=local", representative: true },
  { router: "pins", method: "GET", path: () => "/api/multiremi/pins?workspaceId=local", representative: true },
  { router: "platform", method: "GET", path: () => "/api/multiremi/platform/status", representative: true },
  { router: "projects", method: "GET", path: () => "/api/multiremi/projects?workspaceId=local", representative: true },
  { router: "remi-releases", method: "GET", path: () => "/api/remi/releases/latest/version", representative: true },
  { router: "runtimes", method: "GET", path: () => "/api/multiremi/runtimes", representative: true },
  { router: "scm", method: "GET", path: () => "/api/workspaces/local/scm/connections", representative: true },
  { router: "session-archives", method: "GET", path: (r) => `/api/issues/${r.issueId}/session-archives`, representative: true },
  { router: "skills", method: "GET", path: () => "/api/multiremi/skills?workspaceId=local", representative: true },
  { router: "squads", method: "GET", path: () => "/api/multiremi/squads?workspaceId=local", representative: true },
  { router: "tasks", method: "GET", path: () => "/api/multiremi/tasks", representative: true },
  { router: "tokens", method: "GET", path: () => "/api/multiremi/tokens?workspaceId=local", representative: true },
  { router: "webhooks", method: "POST", path: () => "/api/webhooks/stripe", body: { type: "benchmark.noop" }, representative: true },
  { router: "workspaces", method: "GET", path: () => "/api/workspaces", representative: true },

  // Extra read hotspots inside the broad issues/tasks/projects routers.
  { router: "issues", method: "GET", path: () => "/api/issues?workspace_id=local" },
  { router: "issues", method: "GET", path: () => "/api/issues/grouped?workspace_id=local&limit=50" },
  { router: "issues", method: "GET", path: () => "/api/issues/search?q=benchmark&workspace_id=local" },
  { router: "issues", method: "GET", path: (r) => `/api/issues/${r.issueId}` },
  { router: "issues", method: "GET", path: (r) => `/api/issues/${r.issueId}/comments` },
  { router: "issues", method: "GET", path: (r) => `/api/issues/${r.issueId}/task-runs` },
  { router: "tasks", method: "GET", path: (r) => `/api/multiremi/tasks/${r.taskId}/inspection` },
  { router: "projects", method: "GET", path: () => "/api/projects/search?q=benchmark&workspace_id=local" },
  { router: "dashboard", method: "GET", path: () => "/api/dashboard/usage/daily?workspace_id=local" },
  { router: "runtimes", method: "GET", path: (r) => `/api/runtimes/${r.runtimeId}/task-activity` },
];

function pathname(path: string): string {
  return new URL(path, "http://benchmark.invalid").pathname;
}

function routerLabel(pattern: string): string {
  const segments = pattern.split("/").filter(Boolean);
  if (segments[0] === "auth") return "auth";
  if (segments[0] === "ws") return "realtime";
  if (segments[1] === "multiremi") return segments[2] ?? "multiremi";
  return segments[1] ?? segments[0] ?? "root";
}

function buildProbes(app: any, refs: SeedRefs): Probe[] {
  const probes = [...FOCUSED_PROBES];
  const focusedPaths = new Set(probes.map((probe) => `${probe.method} ${pathname(probe.path(refs))}`));
  for (const route of snapshotRouteTable(app)) {
    if (route.method !== "GET") continue;
    const routeKey = `${route.method} ${route.path}`;
    if (SNAPSHOT_STATUS_ONLY_ROUTES.has(routeKey)) continue;
    const concrete = snapshotConcretePath(route.path, refs);
    if (focusedPaths.has(`GET ${pathname(concrete)}`)) continue;
    probes.push({
      router: routerLabel(route.path),
      method: "GET",
      path: () => concrete,
    });
  }
  return probes;
}

interface ProbeResult {
  router: string;
  method: string;
  path: string;
  representative: boolean;
  status: number;
  sqlCount: number;
  sqlCountMin: number;
  sqlCountMax: number;
  p50Ms: number;
  p95Ms: number;
  responseBytes: number;
  repeatedBuckets: Array<Omit<SqlBucket, "key">>;
  topSql: Array<{ sql: string; count: number }>;
}

interface PlanProbe {
  name: string;
  sql: string;
  params: unknown[];
}

interface IndexExperiment extends PlanProbe {
  index: string;
  createSql: string;
}

const PLAN_PROBES: PlanProbe[] = [
  {
    name: "issue list by workspace",
    sql: "SELECT * FROM multiremi_issues WHERE archived_at IS NULL AND workspace_id = ? ORDER BY updated_at DESC",
    params: ["local"],
  },
  {
    name: "issue comments by issue",
    sql: "SELECT * FROM multiremi_issue_comments WHERE issue_id = ? ORDER BY created_at ASC",
    params: ["iss_snapshot"],
  },
  {
    name: "comment search snippet",
    sql: "SELECT body FROM multiremi_issue_comments WHERE issue_id = ? ORDER BY created_at DESC",
    params: ["iss_snapshot"],
  },
  {
    name: "tasks by issue",
    sql: "SELECT * FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    params: ["iss_snapshot"],
  },
  {
    name: "tasks by agent",
    sql: "SELECT * FROM multiremi_tasks WHERE agent_id = ? ORDER BY created_at DESC",
    params: ["agt_snapshot"],
  },
  {
    name: "all tasks",
    sql: "SELECT * FROM multiremi_tasks ORDER BY created_at DESC",
    params: [],
  },
  {
    name: "autopilot runs by task ids",
    sql: "SELECT task_id, id FROM multiremi_autopilot_runs WHERE task_id IN (?, ?, ?) ORDER BY created_at DESC",
    params: ["tsk_snapshot", "tsk_bench_0001", "tsk_bench_0002"],
  },
  {
    name: "agent skills",
    sql: `SELECT s.* FROM multiremi_skills s
      JOIN multiremi_agent_skills aks ON aks.skill_id = s.id
      WHERE aks.agent_id = ? AND s.archived_at IS NULL
      ORDER BY aks.created_at ASC, s.name ASC`,
    params: ["agt_snapshot"],
  },
  {
    name: "queued task blocker",
    sql: `SELECT active.id AS task_id, active.agent_id
      FROM multiremi_tasks queued
      JOIN multiremi_tasks active ON active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
      WHERE queued.id = ? AND queued.status = 'queued' AND (
        (queued.issue_session_id IS NOT NULL AND active.issue_session_id = queued.issue_session_id)
        OR (queued.issue_id IS NOT NULL AND queued.issue_session_id IS NULL AND active.issue_id = queued.issue_id)
        OR (queued.issue_id IS NOT NULL AND queued.holds_workspace = 1 AND active.issue_id = queued.issue_id AND active.holds_workspace = 1)
      )
      ORDER BY active.dispatched_at ASC, active.created_at ASC LIMIT 1`,
    params: ["tsk_bench_0003"],
  },
  {
    name: "projects with issue counts",
    sql: `SELECT p.id, COUNT(i.id) AS issue_count
      FROM multiremi_projects p
      LEFT JOIN multiremi_issues i ON i.project_id = p.id
      WHERE p.workspace_id = ?
      GROUP BY p.id ORDER BY p.updated_at DESC`,
    params: ["local"],
  },
];

const INDEX_EXPERIMENTS: IndexExperiment[] = [
  {
    name: "issue list order",
    index: "multiremi_issues(workspace_id, archived_at, updated_at DESC)",
    createSql: "CREATE INDEX mul176_tmp_issues_workspace_archive_updated ON multiremi_issues(workspace_id, archived_at, updated_at DESC)",
    sql: "SELECT * FROM multiremi_issues WHERE archived_at IS NULL AND workspace_id = ? ORDER BY updated_at DESC",
    params: ["local"],
  },
  {
    name: "tasks by issue order",
    index: "multiremi_tasks(issue_id, created_at DESC)",
    createSql: "CREATE INDEX mul176_tmp_tasks_issue_created ON multiremi_tasks(issue_id, created_at DESC)",
    sql: "SELECT * FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    params: ["iss_snapshot"],
  },
  {
    name: "tasks by agent order",
    index: "multiremi_tasks(agent_id, created_at DESC)",
    createSql: "CREATE INDEX mul176_tmp_tasks_agent_created ON multiremi_tasks(agent_id, created_at DESC)",
    sql: "SELECT * FROM multiremi_tasks WHERE agent_id = ? ORDER BY created_at DESC",
    params: ["agt_snapshot"],
  },
  {
    name: "autopilot runs by task order",
    index: "multiremi_autopilot_runs(task_id, created_at DESC)",
    createSql: "CREATE INDEX mul176_tmp_autopilot_runs_task_created ON multiremi_autopilot_runs(task_id, created_at DESC)",
    sql: "SELECT task_id, id FROM multiremi_autopilot_runs WHERE task_id IN (?, ?, ?) ORDER BY created_at DESC",
    params: ["tsk_snapshot", "tsk_bench_0001", "tsk_bench_0002"],
  },
  {
    name: "project issue join",
    index: "multiremi_issues(project_id)",
    createSql: "CREATE INDEX mul176_tmp_issues_project ON multiremi_issues(project_id)",
    sql: `SELECT p.id, COUNT(i.id) AS issue_count
      FROM multiremi_projects p
      LEFT JOIN multiremi_issues i ON i.project_id = p.id
      WHERE p.workspace_id = ?
      GROUP BY p.id ORDER BY p.updated_at DESC`,
    params: ["local"],
  },
  {
    name: "access tokens by workspace order",
    index: "multiremi_access_tokens(workspace_id, created_at DESC) WHERE type != 'task'",
    createSql: "CREATE INDEX mul176_tmp_tokens_workspace_created_non_task ON multiremi_access_tokens(workspace_id, created_at DESC) WHERE type != 'task'",
    sql: "SELECT * FROM multiremi_access_tokens WHERE workspace_id = ? AND type != 'task' ORDER BY created_at DESC",
    params: ["local"],
  },
];

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function countRows(db: Database, table: string): number {
  return Number((db.query(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total);
}

function explainQueryPlan(db: Database, sql: string, params: unknown[]): string[] {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return (statement.all(...params as any[]) as Array<{ detail?: unknown }>)
      .map((row) => String(row.detail ?? ""));
  } finally {
    statement.finalize();
  }
}

function runIndexExperiments(db: Database): Array<{
  name: string;
  index: string;
  sql: string;
  before: string[];
  after: string[];
}> {
  return INDEX_EXPERIMENTS.map((experiment) => {
    const before = explainQueryPlan(db, experiment.sql, experiment.params);
    const indexName = experiment.createSql.split(/\s+/)[2]!;
    db.exec(experiment.createSql);
    const after = explainQueryPlan(db, experiment.sql, experiment.params);
    db.exec(`DROP INDEX ${indexName}`);
    return {
      name: experiment.name,
      index: experiment.index,
      sql: normalizeSql(experiment.sql),
      before,
      after,
    };
  });
}

function expandSeed(db: Database, refs: SeedRefs): Record<string, number> {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const insertAgent = db.prepare(`
    INSERT INTO multiremi_agents (id, workspace_id, name, provider, owner_id, visibility, created_at, updated_at)
    VALUES (?, 'local', ?, 'codex', 'local', 'workspace', ?, ?)
  `);
  const insertIssue = db.prepare(`
    INSERT INTO multiremi_issues (
      id, issue_number, issue_key, title, description, status, priority,
      workspace_id, assignee_type, assignee_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'medium', 'local', 'agent', ?, ?, ?)
  `);
  const insertComment = db.prepare(`
    INSERT INTO multiremi_issue_comments (
      id, issue_id, issue_session_id, author_type, author_id, body, created_at, updated_at
    ) VALUES (?, ?, ?, 'member', ?, ?, ?, ?)
  `);
  const insertTask = db.prepare(`
    INSERT INTO multiremi_tasks (
      id, agent_id, runtime_id, issue_id, issue_session_id, workspace_id,
      status, prompt, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (let i = countRows(db, "multiremi_agents"); i < 50; i++) {
      const id = `agt_bench_${String(i).padStart(3, "0")}`;
      insertAgent.run(id, `Benchmark Agent ${i}`, createdAt, createdAt);
    }
    for (let i = countRows(db, "multiremi_issues"); i < 200; i++) {
      const id = `iss_bench_${String(i).padStart(3, "0")}`;
      const agentId = i % 50 === 0 ? refs.agentId : `agt_bench_${String(i % 50).padStart(3, "0")}`;
      insertIssue.run(
        id,
        i + 1,
        `MUL-B${i + 1}`,
        `Benchmark issue ${i}`,
        `benchmark fixture issue ${i}`,
        i % 5 === 0 ? "done" : "in_progress",
        agentId,
        createdAt,
        createdAt,
      );
    }
    for (let i = countRows(db, "multiremi_issue_comments"); i < 2_000; i++) {
      const id = `cmt_bench_${String(i).padStart(4, "0")}`;
      insertComment.run(
        id,
        refs.issueId,
        i % 3 === 0 ? refs.issueSessionId : null,
        refs.memberId,
        `Benchmark comment ${i}`,
        createdAt,
        createdAt,
      );
    }
    for (let i = countRows(db, "multiremi_tasks"); i < 500; i++) {
      const id = `tsk_bench_${String(i).padStart(4, "0")}`;
      const agentId = i % 50 === 0 ? refs.agentId : `agt_bench_${String(i % 50).padStart(3, "0")}`;
      const status = i % 4 === 0 ? "completed" : i % 4 === 1 ? "failed" : i % 4 === 2 ? "running" : "queued";
      insertTask.run(
        id,
        agentId,
        refs.runtimeId,
        refs.issueId,
        refs.issueSessionId,
        status,
        `Benchmark task ${i}`,
        createdAt,
        createdAt,
        status === "completed" ? createdAt : null,
      );
    }
  })();

  return {
    workspaces: countRows(db, "multiremi_workspaces"),
    issues: countRows(db, "multiremi_issues"),
    comments: countRows(db, "multiremi_issue_comments"),
    tasks: countRows(db, "multiremi_tasks"),
    agents: countRows(db, "multiremi_agents"),
  };
}

async function executeProbe(
  app: any,
  tracker: SqlTracker,
  probe: Probe,
  refs: SeedRefs,
): Promise<{ elapsedMs: number; status: number; bytes: number; sqlCount: number; buckets: SqlBucket[] }> {
  tracker.reset();
  tracker.enabled = true;
  const path = probe.path(refs);
  const init: RequestInit = { method: probe.method };
  if (probe.body !== undefined) {
    init.body = JSON.stringify(probe.body);
    init.headers = { "Content-Type": "application/json" };
  }
  const started = performance.now();
  const response = await app.request(path, init);
  const body = await response.arrayBuffer();
  const elapsedMs = performance.now() - started;
  tracker.enabled = false;
  return {
    elapsedMs,
    status: response.status,
    bytes: body.byteLength,
    sqlCount: tracker.executions.length,
    buckets: tracker.buckets(),
  };
}

async function benchmarkProbe(app: any, tracker: SqlTracker, probe: Probe, refs: SeedRefs): Promise<ProbeResult> {
  for (let i = 0; i < WARMUPS; i++) await executeProbe(app, tracker, probe, refs);

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await executeProbe(app, tracker, probe, refs));
  const sqlCounts = samples.map((sample) => sample.sqlCount);
  const representative = samples[Math.floor(samples.length / 2)]!;
  const aggregateSql = new Map<string, number>();
  for (const sample of samples) {
    for (const bucket of sample.buckets) {
      aggregateSql.set(bucket.sql, (aggregateSql.get(bucket.sql) ?? 0) + bucket.count);
    }
  }
  return {
    router: probe.router,
    method: probe.method,
    path: probe.path(refs),
    representative: probe.representative === true,
    status: representative.status,
    sqlCount: representative.sqlCount,
    sqlCountMin: Math.min(...sqlCounts),
    sqlCountMax: Math.max(...sqlCounts),
    p50Ms: roundMs(percentile(samples.map((sample) => sample.elapsedMs), 0.50)),
    p95Ms: roundMs(percentile(samples.map((sample) => sample.elapsedMs), 0.95)),
    responseBytes: representative.bytes,
    repeatedBuckets: representative.buckets
      .filter((bucket) => bucket.count >= 3)
      .slice(0, 20)
      .map(({ key: _key, ...bucket }) => bucket),
    topSql: [...aggregateSql.entries()]
      .map(([sql, count]) => ({ sql, count: Math.round(count / SAMPLES) }))
      .sort((left, right) => right.count - left.count || left.sql.localeCompare(right.sql))
      .slice(0, 20),
  };
}

async function main(): Promise<void> {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(join(TMP_ROOT, "uploads"), { recursive: true });
  const env = {
    MULTIREMI_DATABASE_URL: process.env.MULTIREMI_DATABASE_URL,
    MULTIREMI_UPLOAD_DIR: process.env.MULTIREMI_UPLOAD_DIR,
    MULTIREMI_RELEASE_DIR: process.env.MULTIREMI_RELEASE_DIR,
    MULTIREMI_SCRIPTS_DIR: process.env.MULTIREMI_SCRIPTS_DIR,
    MULTIREMI_TOKEN: process.env.MULTIREMI_TOKEN,
    NODE_ENV: process.env.NODE_ENV,
  };
  const originalFetch = globalThis.fetch;
  delete process.env.MULTIREMI_DATABASE_URL;
  delete process.env.MULTIREMI_TOKEN;
  process.env.MULTIREMI_UPLOAD_DIR = "/tmp/multiremi-api-snapshot/uploads";
  process.env.MULTIREMI_RELEASE_DIR = join(TMP_ROOT, "releases");
  process.env.MULTIREMI_SCRIPTS_DIR = join(TMP_ROOT, "scripts");
  process.env.NODE_ENV = "test";
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "network disabled by MUL-176 benchmark" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  const rawDb = new Database(":memory:");
  const tracker = new SqlTracker();
  const db = trackedDatabase(rawDb, tracker);
  try {
    const boot = await buildSnapshotApp(db);
    const seed = expandSeed(rawDb, boot.refs);
    const probes = buildProbes(boot.app, boot.refs);
    const routerNames = new Set(probes.filter((probe) => probe.representative).map((probe) => probe.router));
    if (routerNames.size !== 38) throw new Error(`expected 38 representative routers, got ${routerNames.size}`);

    const results: ProbeResult[] = [];
    for (const probe of probes) {
      const result = await benchmarkProbe(boot.app, tracker, probe, boot.refs);
      results.push(result);
      console.log(`${result.method} ${result.path}: sql=${result.sqlCount}, p50=${result.p50Ms}ms, p95=${result.p95Ms}ms, bytes=${result.responseBytes}`);
    }

    const indexStatement = rawDb.prepare(`
      SELECT name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY tbl_name, name
    `);
    const indexes = indexStatement.all();
    indexStatement.finalize();
    const queryPlans = PLAN_PROBES.map((probe) => ({
      name: probe.name,
      sql: normalizeSql(probe.sql),
      plan: explainQueryPlan(rawDb, probe.sql, probe.params),
    }));
    const indexExperiments = runIndexExperiments(rawDb);
    const output = {
      meta: {
        issue: "MUL-176",
        gitSha: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
        generatedAt: new Date().toISOString(),
        runtime: `Bun ${Bun.version}`,
        database: "SQLite in-memory (bun:sqlite)",
        method: "Hono app.request(); response body fully consumed; 5 warmups + 30 sequential samples",
        sqlCounting: "statement execution (get/all/run/values) plus direct db.run/exec; reset per request",
        seed,
        representativeRouters: routerNames.size,
        registeredGetRoutes: snapshotRouteTable(boot.app).filter((route) => route.method === "GET").length,
        websocketStatusOnlyRoutes: SNAPSHOT_STATUS_ONLY_ROUTES.size,
        probes: probes.length,
      },
      results,
      indexes,
      queryPlans,
      indexExperiments,
    };
    mkdirSync(resolve(OUTPUT_PATH, ".."), { recursive: true });
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`wrote ${OUTPUT_PATH}`);
  } finally {
    tracker.enabled = false;
    rawDb.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
