#!/usr/bin/env bun
/**
 * MUL-389 Phase 0 attribution: where do heartbeat and claim spend their SQL?
 *
 * There is no reachable local PostgreSQL (5432 is closed, docker is not
 * available), so this measures the same store through SQLite with a counting
 * proxy, the same shape as tests/manual/bench-store-n-plus-one.ts: every
 * statement is normalized, counted, and charged the JSON-serialized size of the
 * rows it returned. That byte count stands in for the Postgres bridge's
 * `db_bytes` (packages/server/src/store/db/postgres.ts copies
 * `JSON.stringify({rows, count})` across the bridge), so the number is
 * comparable in kind, not in absolute value.
 *
 *   bun run tests/manual/bench-daemon-heartbeat-claim.ts
 *
 * Both entry points are the real ones: the heartbeat and the task claim go
 * through an in-process Hono app built by `createMultiremiApp` with a real
 * daemon access token, so token verification, the runtime-identity guards and
 * every router-side read sit inside the measurement exactly as in production.
 *
 * Knowledge is materialized the production way: Project Wiki and Repository
 * Wiki are stored through `ProjectKnowledgeService` / `RepositoryWikiService` in
 * OpenViking mode against an in-memory stub client, so the claim really ships
 * Wiki bodies and the store really reads the control-plane rows behind them.
 *
 * Output: a table per scenario plus JSON at MUL389_BENCH_OUTPUT
 * (default /tmp/MUL-389-heartbeat-claim.json). Nothing here touches the
 * operator's database, PostgreSQL, the network, or a credential on disk.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { repositoryWikiRetrievalTags } from "@multiremi/repository-wiki/codec.js";
import { projectKnowledgeRetrievalTags, sha256Text } from "@multiremi/project-knowledge/codec.js";
import type { MultiremiRuntime, MultiremiRuntimeUpdateScope } from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

const OUTPUT_PATH = process.env.MUL389_BENCH_OUTPUT ?? "/tmp/MUL-389-heartbeat-claim.json";
const TOP_N = Number(process.env.MUL389_BENCH_TOP_N ?? 12);
const SAMPLES = Number(process.env.MUL389_BENCH_SAMPLES ?? 3);
const MASTER_TOKEN = "bench-master-token";

// ────────────────────────────── counting proxy ──────────────────────────────

interface StatementStat { count: number; bytes: number }
interface Snapshot { sql: string; count: number; bytes: number }

interface CountingDatabase {
  database: Database;
  proxy: Database;
  reset(): void;
  snapshot(): Snapshot[];
  totalQueries(): number;
  totalBytes(): number;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? Number(item) : item) ?? "");
  } catch {
    return 0;
  }
}

function countingDatabase(): CountingDatabase {
  const database = new Database(":memory:");
  const stats = new Map<string, StatementStat>();
  const charge = (sql: string, rows: unknown[], count: number): void => {
    const normalized = normalizeSql(sql);
    const entry = stats.get(normalized) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += jsonBytes({ rows, count });
    stats.set(normalized, entry);
  };
  const wrap = (sql: string, statement: any): any => ({
    get: (...params: unknown[]) => {
      const row = statement.get(...params);
      charge(sql, row === null || row === undefined ? [] : [row], row === null || row === undefined ? 0 : 1);
      return row;
    },
    all: (...params: unknown[]) => {
      const rows = statement.all(...params) as unknown[];
      charge(sql, rows, rows.length);
      return rows;
    },
    values: (...params: unknown[]) => {
      const rows = statement.values(...params) as unknown[];
      charge(sql, rows, rows.length);
      return rows;
    },
    run: (...params: unknown[]) => {
      const result = statement.run(...params) as { changes: number };
      charge(sql, [], result.changes ?? 0);
      return result;
    },
  });
  const proxy = new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if ((key === "query" || key === "prepare") && typeof value === "function") {
        return (sql: string, ...args: unknown[]) => wrap(sql, Reflect.apply(value, target, [sql, ...args]));
      }
      if (key === "run" && typeof value === "function") {
        return (sql: string, ...args: unknown[]) => {
          const result = Reflect.apply(value, target, [sql, ...args]) as { changes: number };
          charge(sql, [], result.changes ?? 0);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
  return {
    database,
    proxy,
    reset: () => stats.clear(),
    snapshot: () => [...stats.entries()]
      .map(([sql, entry]) => ({ sql, count: entry.count, bytes: entry.bytes }))
      .sort((left, right) => right.count - left.count || right.bytes - left.bytes || left.sql.localeCompare(right.sql)),
    totalQueries: () => [...stats.values()].reduce((sum, entry) => sum + entry.count, 0),
    totalBytes: () => [...stats.values()].reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

// ────────────────────────────── stub OpenViking ──────────────────────────────

/** In-memory stand-in for the OpenViking content store; bodies never enter the SQL bridge. */
class StubOpenVikingClient {
  readonly contents = new Map<string, string>();
  readonly tags = new Map<string, string[]>();
  readonly directories = new Set<string>();

  withSignal(): StubOpenVikingClient { return this; }
  async health(): Promise<void> {}
  async ensureDirectory(uri: string): Promise<void> { this.directories.add(uri); }
  async read(uri: string): Promise<string> {
    const content = this.contents.get(uri);
    if (content === undefined) throw new Error(`OpenViking content not found: ${uri}`);
    return content;
  }
  async exists(uri: string): Promise<boolean> { return this.contents.has(uri); }
  async create(uri: string, _rootUri: string, content: string): Promise<void> { this.contents.set(uri, content); }
  async replace(uri: string, _rootUri: string, content: string, _hash: string): Promise<void> { this.contents.set(uri, content); }
  async remove(uri: string): Promise<void> { this.contents.delete(uri); }
  async setTags(uri: string, tags: string[]): Promise<void> { this.tags.set(uri, tags); }
  async find(): Promise<never[]> { return []; }
  async commit(message: string): Promise<string> { return createHash("sha1").update(message).digest("hex"); }
  async log(): Promise<never[]> { return []; }
  async show(): Promise<string> { return ""; }
}

// ────────────────────────────── fixtures ──────────────────────────────

const REPO_URL = "https://github.com/example/bench-repo";

/** A few hundred KB of skill-file content per Agent, so eligibility loops that hydrate skills are visible. */
function largeSkillFile(agentIndex: number): { path: string; content: string } {
  const filler = "0123456789abcdef".repeat(64);
  return {
    path: `notes/agent-${agentIndex}.md`,
    content: `# Agent ${agentIndex} notes\n${Array.from({ length: 300 }, (_v, line) => `${line}: ${filler}`).join("\n")}\n`,
  };
}

function largeBody(title: string, kib: number): string {
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(8);
  return `# ${title}\n${Array.from({ length: kib }, (_v, line) => `${line}: ${filler}`).join("\n")}\n`;
}

type App = ReturnType<typeof createMultiremiApp>;

interface Fixture {
  counting: CountingDatabase;
  store: MultiremiStore;
  app: App;
  runtime: MultiremiRuntime;
  daemonToken: string;
  close(): void;
}

async function fixture(options: {
  /** Daemon capability flags re-advertised on the heartbeat. */
  metadata?: Record<string, unknown>;
  /** Install a GitHub repo on the workspace (needed for Repository Wiki fixtures). */
  repos?: boolean;
  /** Seed rows; runs inside construction, so its statements are not measured. */
  seed?: (context: { store: MultiremiStore; runtime: MultiremiRuntime }) => void | Promise<void>;
  /** Collect Wiki documents through the real knowledge services before measuring. */
  knowledge?: (context: {
    store: MultiremiStore;
    runtime: MultiremiRuntime;
    project: ProjectKnowledgeService;
    repository: RepositoryWikiService;
  }) => Promise<void>;
} = {}): Promise<Fixture> {
  const counting = countingDatabase();
  const store = new MultiremiStore(counting.proxy);
  store.ensureLocalWorkspace();
  if (options.repos) {
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_bench",
        name: "bench-repo",
        url: REPO_URL,
        source: "github",
        default_branch: "main",
      }],
    });
  }
  const runtime = store.registerRuntime({
    id: "rt_bench",
    name: "Bench runtime",
    provider: "codex",
    daemonId: "daemon-bench",
    workspaceId: "local",
    ownerId: "local",
    status: "online",
    maxConcurrency: 8,
    metadata: options.metadata ?? {},
  });
  const token = await store.createAccessToken({
    workspaceId: "local",
    name: "Bench daemon",
    type: "daemon",
    daemonId: "daemon-bench",
  });
  const client = new StubOpenVikingClient();
  const project = new ProjectKnowledgeService(store, client, "openviking");
  const repository = new RepositoryWikiService(store, client, "openviking");
  if (options.seed) await options.seed({ store, runtime });
  if (options.knowledge) await options.knowledge({ store, runtime, project, repository });
  const app = createMultiremiApp({
    store,
    authToken: MASTER_TOKEN,
    backgroundJobs: false,
    projectKnowledge: project,
    repositoryWiki: repository,
  });
  // Everything above is fixture construction; only what follows is measured.
  counting.reset();
  return {
    counting,
    store,
    app,
    runtime,
    daemonToken: token.token,
    close: () => counting.database.close(),
  };
}

function daemonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const HEARTBEAT_BODY = (runtimeId: string) => ({
  runtime_id: runtimeId,
  supports_batch_import: true,
  supports_directory_scan: true,
  supports_skill_directory: true,
  supports_bot_menu: true,
  agent_plugin_protocol: 1,
});

async function heartbeat(fx: Fixture, extra: Record<string, unknown> = {}): Promise<Response> {
  return fx.app.request("/api/daemon/heartbeat", {
    method: "POST",
    headers: daemonHeaders(fx.daemonToken),
    body: JSON.stringify({ ...HEARTBEAT_BODY(fx.runtime.id), ...extra }),
  });
}

/** The store-side heartbeat call on its own: isolates the poll from the HTTP route's auth/config reads. */
function heartbeatStoreOnly(fx: Fixture, extra: Record<string, unknown> = {}): void {
  fx.store.heartbeatRuntime(fx.runtime.id, {
    supportsBatchImport: true,
    supportsDirectoryScan: true,
    supportsSkillDirectory: true,
    supportsBotMenu: true,
    agentPluginProtocol: 1,
    ...extra,
  });
}

async function claim(fx: Fixture): Promise<Response> {
  return fx.app.request(`/api/daemon/runtimes/${fx.runtime.id}/tasks/claim`, {
    method: "POST",
    headers: daemonHeaders(fx.daemonToken),
    body: JSON.stringify({ supports_binary_skill_files: true }),
  });
}

// ────────────────────────────── pending-request seeding ──────────────────────────────

const ALL_FAMILIES = ["update", "model_list", "command", "bot_menu", "local_skills", "directory_scan", "local_skill_import"] as const;
type Family = typeof ALL_FAMILIES[number];

function seedPendingFamilies(
  store: MultiremiStore,
  runtime: MultiremiRuntime,
  families: ReadonlySet<string>,
  options: { batchImports?: number } = {},
): void {
  if (families.has("update")) {
    store.createRuntimeUpdateRequest(runtime.id, { scope: "cli" as MultiremiRuntimeUpdateScope, targetVersion: "v0.2.83" });
  }
  if (families.has("model_list")) store.createRuntimeModelListRequest(runtime.id);
  if (families.has("command")) store.createRuntimeCommandRequest(runtime.id, { command: "echo", args: ["bench"] });
  if (families.has("bot_menu")) {
    store.createBotMenuPublishRequest(runtime.id, {
      workspaceId: "local",
      config: { default: [{ name: "Status", behaviors: [{ type: "send_message" }] }] } as any,
      dryRun: false,
    });
  }
  if (families.has("local_skills")) store.createRuntimeLocalSkillListRequest(runtime.id, {});
  if (families.has("directory_scan")) {
    store.createRuntimeDirectoryScanRequest(runtime.id, { root: "/tmp", maxDepth: 2, mode: "scan" });
  }
  if (families.has("local_skill_import")) {
    for (let index = 0; index < (options.batchImports ?? 1); index += 1) {
      store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: `bench-skill-${index}`, name: `bench-skill-${index}` });
    }
  }
}

/** One `pending` Agent-Plugin state per bound Agent, so the heartbeat reconciles several. */
function seedPluginBindings(store: MultiremiStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const agent = store.createAgent({
      id: `agt_plugin_${index}`,
      name: `Plugin agent ${index}`,
      provider: "codex",
      workspaceId: "local",
      runtimeId: "rt_bench",
    });
    const plugin = store.importAgentPlugin({
      id: `apl_plugin_${index}`,
      workspaceId: "local",
      provider: "codex",
      name: `bench-plugin-${index}`,
      manifest: { name: `bench-plugin-${index}`, version: "1.0.0" },
      files: [{ path: `skills/bench-${index}/SKILL.md`, content: `# Bench ${index}\n` }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id!, enabled: true });
  }
}

// ────────────────────────────── measurement ──────────────────────────────

interface Measurement {
  scenario: string;
  samples: number;
  queries: number;
  bytes: number;
  wallMs: number;
  top: Snapshot[];
  detail: Record<string, unknown>;
}

/** Every sample rebuilds its fixture, so a mutating claim is never measured against its own writes. */
async function measure(
  scenario: string,
  build: () => Promise<Fixture>,
  run: (fx: Fixture) => Promise<Record<string, unknown> | void>,
): Promise<Measurement> {
  let queries = 0;
  let bytes = 0;
  let wallMs = 0;
  let top: Snapshot[] = [];
  let detail: Record<string, unknown> = {};
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const fx = await build();
    try {
      const startedAt = performance.now();
      const result = await run(fx);
      const elapsed = performance.now() - startedAt;
      if (sample === 0) {
        queries = fx.counting.totalQueries();
        bytes = fx.counting.totalBytes();
        top = fx.counting.snapshot().slice(0, TOP_N);
        detail = result ?? {};
        wallMs = elapsed;
      } else if (fx.counting.totalQueries() !== queries) {
        throw new Error(`${scenario} emitted unstable query counts: ${queries} then ${fx.counting.totalQueries()}`);
      }
    } finally {
      fx.close();
    }
  }
  return { scenario, samples: SAMPLES, queries, bytes, wallMs: Number(wallMs.toFixed(1)), top, detail };
}

// ────────────────────────────── heartbeat scenarios ──────────────────────────────

async function heartbeatScenarios(): Promise<Measurement[]> {
  const pluginMetadata = { agent_plugin_protocol: 1, feishu_bot_menu: true };
  const results: Measurement[] = [];

  results.push(await measure("heartbeat.idle", () => fixture({ metadata: pluginMetadata }), async (fx) => {
    const response = await heartbeat(fx);
    return { status: response.status };
  }));

  // Same two scenarios again, but calling the store directly. The difference
  // between these and the HTTP rows above is the route's own cost (token
  // verification, workspace config, ssh mesh, maintenance, concierge), which
  // the store-side poll cannot remove.
  results.push(await measure("heartbeat.store_only.idle", () => fixture({ metadata: pluginMetadata }), async (fx) => {
    heartbeatStoreOnly(fx);
  }));

  results.push(await measure("heartbeat.store_only.pending.every_family", () => fixture({
    metadata: pluginMetadata,
    seed: ({ store, runtime }) => seedPendingFamilies(store, runtime, new Set(ALL_FAMILIES)),
  }), async (fx) => {
    heartbeatStoreOnly(fx);
  }));

  for (const family of ALL_FAMILIES) {
    results.push(await measure(`heartbeat.pending.${family}`, () => fixture({
      metadata: pluginMetadata,
      seed: ({ store, runtime }) => seedPendingFamilies(store, runtime, new Set([family])),
    }), async (fx) => {
      const response = await heartbeat(fx);
      return { status: response.status };
    }));
    results.push(await measure(`heartbeat.store_only.pending.${family}`, () => fixture({
      metadata: pluginMetadata,
      seed: ({ store, runtime }) => seedPendingFamilies(store, runtime, new Set([family])),
    }), async (fx) => {
      heartbeatStoreOnly(fx);
    }));
  }

  results.push(await measure("heartbeat.store_only.worst_case", () => fixture({
    metadata: {
      agent_plugin_protocol: 1,
      feishu_bot_menu: true,
      codex_profiles: 1,
      claude_profiles: 1,
    },
    seed: ({ store, runtime }) => {
      seedPendingFamilies(store, runtime, new Set(ALL_FAMILIES), { batchImports: 10 });
      seedPluginBindings(store, 4);
    },
  }), async (fx) => {
    heartbeatStoreOnly(fx);
  }));

  // Store-only counterpart of the mesh/drain/concierge variant: the store call itself does not
  // change, which is what isolates those queries to the route.
  results.push(await measure("heartbeat.store_only.worst_case_with_side_channels", () => fixture({
    metadata: {
      agent_plugin_protocol: 1,
      feishu_bot_menu: true,
      codex_profiles: 1,
      claude_profiles: 1,
    },
    seed: ({ store, runtime }) => {
      seedPendingFamilies(store, runtime, new Set(ALL_FAMILIES), { batchImports: 10 });
      seedPluginBindings(store, 4);
    },
  }), async (fx) => {
    heartbeatStoreOnly(fx);
  }));

  // The worst case the acceptance criterion describes: every capability flag on, the Plugin
  // protocol advertised, several pending Plugin states, and a 10-item batch import. The daemon
  // also keeps ssh-mesh, drain-lease and Feishu-concierge reporting on the same endpoint; those
  // are measured separately below so the criterion is not charged for features it does not name.
  results.push(await measure("heartbeat.worst_case", () => fixture({
    metadata: {
      agent_plugin_protocol: 1,
      feishu_bot_menu: true,
      feishu_concierge_config_v1: true,
      codex_profiles: 1,
      claude_profiles: 1,
      parallel_agent_execution: 1,
      runtime_workspaces: 1,
    },
    seed: ({ store, runtime }) => {
      seedPendingFamilies(store, runtime, new Set(ALL_FAMILIES), { batchImports: 10 });
      seedPluginBindings(store, 4);
    },
  }), async (fx) => {
    const response = await heartbeat(fx);
    return { status: response.status };
  }));

  /** The same fixture with the mesh, drain-lease and concierge reporting the endpoint also carries. */
  results.push(await measure("heartbeat.worst_case_with_side_channels", () => fixture({
    metadata: {
      agent_plugin_protocol: 1,
      feishu_bot_menu: true,
      feishu_concierge_config_v1: true,
      codex_profiles: 1,
      claude_profiles: 1,
      parallel_agent_execution: 1,
      runtime_workspaces: 1,
    },
    seed: ({ store, runtime }) => {
      seedPendingFamilies(store, runtime, new Set(ALL_FAMILIES), { batchImports: 10 });
      seedPluginBindings(store, 4);
    },
  }), async (fx) => {
    const response = await heartbeat(fx, {
      ssh_mesh_protocol: 1,
      drain_ack_generation: 1,
      active_task_count: 0,
      feishu_concierge_protocol: 6,
    });
    return { status: response.status };
  }));

  return results;
}

// ────────────────────────────── claim scenarios ──────────────────────────────

function seedClaimWorkspace(context: { store: MultiremiStore; runtime: MultiremiRuntime }): void {
  const { store, runtime } = context;
  const project = store.createProject({
    id: "prj_bench",
    title: "Bench project",
    workspaceId: "local",
    resources: [{ resourceType: "github_repo", resourceRef: { url: REPO_URL, id: "repo_bench" } }],
  });
  // Several Agents, each with a few hundred KB of skill files.
  const agents = Array.from({ length: 5 }, (_value, index) => {
    const agent = store.createAgent({
      id: `agt_bench_${index}`,
      name: `Bench agent ${index}`,
      provider: "codex",
      workspaceId: "local",
      runtimeId: runtime.id,
      model: index === 0 ? "gpt-5-codex" : null,
    });
    const skill = store.createSkill({
      workspaceId: "local",
      name: `Bench skill ${index}`,
      content: `# Bench skill ${index}\n`,
      files: [largeSkillFile(index)],
    });
    store.setAgentSkills(agent.id, [skill.id!]);
    return agent;
  });
  const issue = store.createIssue({ title: "Bench issue", workspaceId: "local", projectId: project.id });
  // The selected task: highest priority, so ordering fixes the winner.
  store.createTask({ agentId: agents[0]!.id, issueId: issue.id, prompt: "High priority issue work", priority: 100 });
  // Profile tasks: the claim walks each row and hydrates its Agent.
  for (let index = 1; index < agents.length; index += 1) {
    store.createTask({
      agentId: agents[index]!.id,
      prompt: `Profile work ${index}`,
      priority: 50 - index,
      codexProfile: {
        name: "bench",
        base_url: "http://127.0.0.1:8000/v1",
        model: "custom-model",
        env_key: "REMI_BENCH_KEY",
        auth_mode: "env",
      },
    });
  }
  // Queued chat turns: refreshQueuedChatAffinity walks every one of them.
  for (let index = 1; index < agents.length; index += 1) {
    const chat = store.createChatSession({ agentId: agents[index]!.id, workspaceId: "local", projectId: project.id });
    store.sendChatMessage(chat.id, { body: `Chat turn ${index}` });
  }
}

async function seedClaimKnowledge(context: {
  store: MultiremiStore;
  project: ProjectKnowledgeService;
  repository: RepositoryWikiService;
}): Promise<void> {
  const { project, repository } = context;
  for (let index = 0; index < 8; index += 1) {
    await project.createProjectDoc("prj_bench", {
      slug: `wiki-${index}`,
      kind: "wiki",
      title: `Bench wiki ${index}`,
      body: largeBody(`Bench wiki ${index}`, 40),
    });
  }
  for (let index = 0; index < 8; index += 1) {
    await repository.create("local", "repo_bench", {
      title: `Repo wiki ${index}`,
      path: `docs/repo-wiki-${index}.md`,
      body: largeBody(`Repo wiki ${index}`, 40),
    });
  }
}

async function claimScenarios(): Promise<Measurement[]> {
  return [await measure("claim.mixed_workspace", () => fixture({
    repos: true,
    metadata: { parallel_agent_execution: 1, runtime_workspaces: 1, codex_profiles: 1 },
    seed: seedClaimWorkspace,
    knowledge: seedClaimKnowledge,
  }), async (fx) => {
    const response = await claim(fx);
    const payload = await response.json() as { task?: Row | null };
    const task = payload.task as any;
    return {
      status: response.status,
      claimed_task_id: task?.id ?? null,
      claimed_agent_id: task?.agent_id ?? null,
      response_bytes: jsonBytes(payload),
      skill_file_bytes: jsonBytes(task?.agent?.skills ?? []),
      project_wiki_docs: Array.isArray(task?.project_wiki_docs) ? task.project_wiki_docs.length : 0,
      project_wiki_bytes: jsonBytes(task?.project_wiki_docs ?? []),
      repository_wiki_docs: Array.isArray(task?.repository_wiki_contexts)
        ? (task.repository_wiki_contexts as any[]).reduce((sum, context) => sum + (context.docs?.length ?? 0), 0)
        : 0,
      repository_wiki_bytes: jsonBytes(task?.repository_wiki_contexts ?? []),
      knowledge_warnings: Array.isArray(task?.knowledge_warnings) ? task.knowledge_warnings.length : 0,
    };
  })];
}

// ────────────────────────────── reporting ──────────────────────────────

function printMeasurement(measurement: Measurement): void {
  console.log(`\n### ${measurement.scenario}  (dbq=${measurement.queries}, dbb=${measurement.bytes}, wall=${measurement.wallMs}ms)`);
  for (const entry of measurement.top) {
    console.log(`  ${String(entry.count).padStart(4)}  ${String(entry.bytes).padStart(9)}  ${entry.sql.slice(0, 150)}`);
  }
  if (Object.keys(measurement.detail).length) console.log(`  detail: ${JSON.stringify(measurement.detail)}`);
}

const heartbeatResults = await heartbeatScenarios();
const claimResults = await claimScenarios();

if (import.meta.main) {
  for (const measurement of [...heartbeatResults, ...claimResults]) printMeasurement(measurement);
  writeFileSync(OUTPUT_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    runtime: `Bun ${Bun.version}`,
    engine: "sqlite counting proxy; db_bytes = JSON.stringify({rows,count}) size (PG bridge stand-in)",
    samples: SAMPLES,
    heartbeat: heartbeatResults,
    claim: claimResults,
  }, null, 2)}\n`);
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

export { heartbeatScenarios, claimScenarios, fixture, heartbeat, claim };
