/**
 * Coverage for the Postgres backend of the Multiremi store.
 *
 * `src/multiremi/store/db/postgres.ts` translates the sqlite-dialect SQL the
 * store emits into Postgres via regexes (translateSqliteToPg) and bridges the
 * store's synchronous bun:sqlite call surface to an async Postgres connection
 * (PostgresSyncDatabase, via a Worker + SharedArrayBuffer + Atomics). The risk
 * is that a query silently mis-translates. This file guards both layers:
 *
 *  1. Pure unit tests for translateSqliteToPg() — one per regex rule. These run
 *     everywhere and need no database.
 *  2. Integration tests that run the *real* MultiremiStore against Postgres in a
 *     throwaway database, exercising a broad slice of the query surface
 *     (issues incl. the SQL-pushdown listIssues, projects, agents, runtimes,
 *     tasks claim, workspace members, users, access tokens). A bad SQLite→PG
 *     translation surfaces as a thrown error or a wrong result here.
 *
 * The integration suite is skipped (not failed) when Postgres is unreachable, so
 * the file is safe on machines without the configured MULTIREMI_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { PostgresSyncDatabase, translateSqliteToPg } from "@multiremi/store/db/postgres.js";
import { daemonRuntimeId, MultiremiStore } from "@multiremi/store.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { ProjectInstructionsRevisionConflictError } from "@multiremi/store/repos/projects-repo.js";
import { TaskSteerConflictError, TaskSteerPendingError } from "@multiremi/store/repos/tasks-repo.js";
import { readyArchiveBinding } from "./helpers.js";

// ────────────────────────────── translateSqliteToPg ──────────────────────────────

describe("translateSqliteToPg", () => {
  it("numbers ? placeholders positionally, skipping ? inside string literals", () => {
    expect(translateSqliteToPg("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
    expect(translateSqliteToPg("SELECT * FROM t WHERE name = ? AND note = 'a ? b' AND c = ?")).toBe(
      "SELECT * FROM t WHERE name = $1 AND note = 'a ? b' AND c = $2",
    );
  });

  it("rewrites INSERT OR IGNORE to INSERT … ON CONFLICT DO NOTHING", () => {
    expect(translateSqliteToPg("INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)")).toBe(
      "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    );
  });

  it("keeps an existing ON CONFLICT clause on INSERT OR IGNORE (no double append)", () => {
    const out = translateSqliteToPg("INSERT OR IGNORE INTO t (a) VALUES (?) ON CONFLICT(a) DO NOTHING");
    expect(out).toBe("INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO NOTHING");
    expect(out.match(/ON CONFLICT/g)?.length).toBe(1);
  });

  it("normalizes ON CONFLICT(col) to ON CONFLICT (col)", () => {
    expect(translateSqliteToPg("INSERT INTO t (a) VALUES (?) ON CONFLICT(id) DO NOTHING")).toBe(
      "INSERT INTO t (a) VALUES ($1) ON CONFLICT (id) DO NOTHING",
    );
  });

  it("translates PRAGMA table_info(X) to an information_schema query", () => {
    expect(translateSqliteToPg("PRAGMA table_info(multiremi_issues)")).toBe(
      "SELECT column_name AS name, CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull, data_type AS type " +
        "FROM information_schema.columns WHERE table_schema='public' AND table_name='multiremi_issues'",
    );
  });

  it("translates the sqlite_master table+index listing to pg_tables/pg_indexes", () => {
    expect(
      translateSqliteToPg("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')"),
    ).toBe(
      "SELECT tablename AS name, 'table' AS type FROM pg_tables WHERE schemaname='public' " +
        "UNION ALL SELECT indexname AS name, 'index' AS type FROM pg_indexes WHERE schemaname='public'",
    );
  });

  it("turns the sqlite_master CREATE-text lookup into a NULL-returning probe", () => {
    expect(
      translateSqliteToPg("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_issues'"),
    ).toBe(
      "SELECT NULL::text AS sql FROM information_schema.tables WHERE table_schema='public' AND table_name='multiremi_issues'",
    );
  });

  it("makes ALTER TABLE … ADD COLUMN idempotent, without double-adding IF NOT EXISTS", () => {
    expect(translateSqliteToPg("ALTER TABLE multiremi_issues ADD COLUMN foo TEXT")).toBe(
      "ALTER TABLE multiremi_issues ADD COLUMN IF NOT EXISTS foo TEXT",
    );
    // Already guarded → left as-is (negative lookahead).
    expect(translateSqliteToPg('ALTER TABLE "multiremi_issues" ADD COLUMN IF NOT EXISTS bar TEXT')).toBe(
      'ALTER TABLE "multiremi_issues" ADD COLUMN IF NOT EXISTS bar TEXT',
    );
  });

  it("strips FOREIGN KEY clauses (unenforced in sqlite; rejected on forward refs in PG)", () => {
    expect(
      translateSqliteToPg(
        "CREATE TABLE t (id TEXT, x TEXT, FOREIGN KEY (x) REFERENCES other(id) ON DELETE CASCADE)",
      ),
    ).toBe("CREATE TABLE t (id TEXT, x TEXT)");
  });

  it("rewrites the sqlite rowid dedup DELETE to a Postgres ctid self-join", () => {
    expect(
      translateSqliteToPg("DELETE FROM t WHERE rowid NOT IN (SELECT MAX(rowid) FROM t GROUP BY a, b)"),
    ).toBe("DELETE FROM t a USING t b WHERE a.a = b.a AND a.b = b.b AND a.ctid < b.ctid");
  });
});

// ────────────────────────────── PostgresSyncDatabase + MultiremiStore ──────────────────────────────

const PG_ADMIN_URL = "postgres://multimira:multimira@localhost:5432/postgres";
const PG_HOST_URL = "postgres://multimira:multimira@localhost:5432";
const TEST_DB = `multiremi_pgtest_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

function waitForWorkerPhase(worker: Worker, expectedPhase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<{ phase?: string; error?: string }>) => {
      if (event.data.phase === "error") {
        cleanup();
        reject(new Error(event.data.error ?? "Postgres race worker failed"));
      } else if (event.data.phase === expectedPhase) {
        cleanup();
        resolve();
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

// Decide skip-vs-run at collection time (top-level await); the throwaway DB and
// store are built in beforeAll so a probe failure never leaves half-open state.
const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(
    `[multiremi-postgres-store] Postgres not reachable at ${PG_ADMIN_URL} — skipping PG-backed store integration tests.`,
  );
}

describe.skipIf(!pgAvailable)("MultiremiStore on Postgres (integration)", () => {
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    // Constructing the store runs migrate(): all CREATE TABLE / ALTER / index DDL
    // flows through translateSqliteToPg. A mis-translation would throw right here.
    db = new PostgresSyncDatabase(`${PG_HOST_URL}/${TEST_DB}`);
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    db?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  it("checks repository Wiki publication without untyped nullable parameters", () => {
    const agent = store.createAgent({ name: "Atlas · LLM Wiki", provider: "claude" });
    const autopilot = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      assigneeId: agent.id,
      executionMode: "run_only",
    });

    const taskRun = store.runAutopilot(autopilot.id, {
      source: "api",
      repositoryId: "repo_publication_task",
      dedupeKey: "repo_publication_task:bootstrap_repository:head",
    });
    expect(store.isRepositoryWikiRunPublished(taskRun.id)).toBe(false);
    store.createRepositoryWikiDoc("local", "repo_publication_task", {
      path: "task.md",
      title: "Task publication",
      sourceTaskId: taskRun.taskId,
    });
    expect(store.isRepositoryWikiRunPublished(taskRun.id)).toBe(true);

    store.createRepositoryWikiDoc("local", "repo_publication_revision", {
      path: "revision.md",
      title: "Revision publication",
      sourceRevision: "abc123",
    });
    const revisionRun = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      repositoryId: "repo_publication_revision",
      dedupeKey: "repo_publication_revision:incremental_update:abc123",
    });
    expect(store.isRepositoryWikiRunPublished(revisionRun.id)).toBe(true);
  });

  // Each test provisions its own workspace so shared state (issue numbering,
  // list results) stays isolated without per-test databases.
  let wsCounter = 0;
  const freshWorkspace = (): string => {
    wsCounter += 1;
    const slug = `pgtest-${process.pid}-${wsCounter}`;
    return store.createWorkspace({ name: `PG Test ${wsCounter}`, slug }).id;
  };

  const createDelegationFixture = () => {
    const workspaceId = freshWorkspace();
    const leaderRuntime = store.registerRuntime({
      name: `PG delegation leader runtime ${wsCounter}`,
      provider: "claude",
      workspaceId,
    });
    const qaRuntime = store.registerRuntime({
      name: `PG delegation QA runtime ${wsCounter}`,
      provider: "claude",
      workspaceId,
    });
    const leader = store.createAgent({
      name: `PG Leader ${wsCounter}`,
      provider: "claude",
      runtimeId: leaderRuntime.id,
      workspaceId,
    });
    const qa = store.createAgent({
      name: `PG QA ${wsCounter}`,
      provider: "claude",
      runtimeId: qaRuntime.id,
      workspaceId,
    });
    const squad = store.createSquad({
      name: `PG delegation squad ${wsCounter}`,
      leaderId: leader.id,
      memberIds: [qa.id],
      workspaceId,
    });
    const issue = store.createIssue({
      title: `PG delegation ${wsCounter}`,
      assigneeType: "squad",
      assigneeId: squad.id,
      workspaceId,
    });
    const leaderTask = store.createTask({
      agentId: leader.id,
      issueId: issue.id,
      prompt: "Lead the PG delegation test.",
      workspaceId,
    });
    expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
    store.buildTaskSessionProjection(leaderTask.id);
    store.startTask(leaderTask.id);
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please verify [@QA](mention://agent/${qa.id})`,
    });
    const childTask = store.listTasksForIssue(issue.id).find((task) => task.agentId === qa.id)!;
    store.completeTask(leaderTask.id, { output: "Delegated to QA." });
    expect(store.claimTask(qaRuntime.id)?.id).toBe(childTask.id);
    store.buildTaskSessionProjection(childTask.id);
    store.startTask(childTask.id);
    const report = store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: qa.id,
      taskId: childTask.id,
      body: "Intermediate PG report.",
    });
    const explicitReturn = store.ensureDelegationWakeup({
      sourceTaskId: childTask.id,
      requiredEventSeq: 1_000_000,
      triggerCommentId: report.id,
    }).task!;
    return { workspaceId, leader, qa, issue, childTask, report, explicitReturn };
  };

  it("migrate() created the core tables in Postgres", () => {
    const tables = db
      .query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')")
      .all()
      .map((r: { name: string }) => r.name);
    for (const t of [
      "multiremi_issues",
      "multiremi_projects",
      "multiremi_agents",
      "multiremi_runtimes",
      "multiremi_tasks",
      "multiremi_issue_sessions",
      "multiremi_session_participants",
      "multiremi_session_events",
      "multiremi_session_agent_lanes",
      "multiremi_session_results",
      "multiremi_workspace_members",
      "multiremi_access_tokens",
      "multiremi_users",
      "multiremi_daemon_ssh_mesh_states",
      "multiremi_scm_change_requests",
      "multiremi_scm_issue_links",
      "multiremi_scm_effects",
    ]) {
      expect(tables).toContain(t);
    }
    const sshMeshStateColumns = db.query(
      "PRAGMA table_info(multiremi_daemon_ssh_mesh_states)",
    ).all().map((row: { name: string }) => row.name);
    expect(sshMeshStateColumns).toEqual(expect.arrayContaining(["node_kind", "name"]));
  });

  it("does not replay the one-time SCM default backfill on Postgres restart", () => {
    const workspaceId = freshWorkspace();
    const connection = store.createScmConnection({
      workspaceId,
      name: "Explicit selected GitHub",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
    });
    expect(connection).toMatchObject({ repositoryScope: "selected", isDefault: false });

    runMigrations(db);

    expect(store.getScmConnection(connection.id)).toMatchObject({
      repositoryScope: "selected",
      isDefault: false,
    });
  });

  it("normalizes legacy SCM base URL paths and keeps one default per origin on Postgres", () => {
    const workspaceId = freshWorkspace();
    db.run(
      "DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260822_scm_connection_origins"],
    );
    for (const [id, name, baseUrl, createdAt] of [
      [`scm_pg_origin_first_${wsCounter}`, "First origin", "https://github.com/acme/first", "2026-08-20T00:00:00.000Z"],
      [`scm_pg_origin_second_${wsCounter}`, "Second origin", "https://github.com/acme/second/", "2026-08-21T00:00:00.000Z"],
    ] as const) {
      db.run(
        `INSERT INTO multiremi_scm_connections (
          id, workspace_id, name, provider, mode, base_url, api_base_url,
          repository_scope, is_default, created_at, updated_at
         ) VALUES (?, ?, ?, 'github', 'poll', ?, 'https://api.github.com', 'all', 1, ?, ?)`,
        [id, workspaceId, name, baseUrl, createdAt, createdAt],
      );
    }

    runMigrations(db);

    expect(db.query(
      `SELECT base_url, repository_scope, is_default
       FROM multiremi_scm_connections
       WHERE workspace_id = ? AND provider = 'github'
       ORDER BY created_at, id`,
    ).all(workspaceId)).toEqual([
      { base_url: "https://github.com", repository_scope: "all", is_default: 1 },
      { base_url: "https://github.com", repository_scope: "selected", is_default: 0 },
    ]);

    db.run(
      `UPDATE multiremi_scm_connections
       SET repository_scope = 'selected', is_default = 0
       WHERE workspace_id = ? AND provider = 'github' AND is_default = 1`,
      [workspaceId],
    );
    runMigrations(db);
    const remainingDefaults = db.query(
      `SELECT COUNT(*) AS count FROM multiremi_scm_connections
       WHERE workspace_id = ? AND provider = 'github' AND is_default = 1`,
    ).get(workspaceId) as { count: number | string };
    expect(Number(remainingDefaults.count)).toBe(0);
  });

  it("registers daemon runtimes with models under one lifecycle transaction (PG)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      id: `rt_pg_models_${wsCounter}`,
      name: "PG daemon models",
      provider: "claude",
      daemonId: `daemon-pg-models-${wsCounter}`,
      workspaceId: ws,
      metadata: { agent_plugin_protocol: 1 },
      models: [
        { id: "claude-pg-default", label: "Claude PG", provider: "anthropic", default: true },
        { id: "claude-pg-fast", label: "Claude PG Fast", provider: "anthropic", default: false },
      ],
    });

    expect(runtime.models.map((model) => model.id)).toEqual([
      "claude-pg-default",
      "claude-pg-fast",
    ]);
    expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(1);
  });

  it("serializes competing daemon owner claims while allowing same-owner tokens (PG)", async () => {
    const ws = freshWorkspace();
    const daemonId = `daemon-pg-owner-race-${wsCounter}`;
    const results = await Promise.allSettled([
      store.createAccessToken({
        name: "PG daemon owner A",
        type: "daemon",
        workspaceId: ws,
        daemonId,
        userId: "pg-owner-a",
      }),
      store.createAccessToken({
        name: "PG daemon owner B",
        type: "daemon",
        workspaceId: ws,
        daemonId,
        userId: "pg-owner-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const ownerUserId = store.getDaemonIdentityOwnerUserId(ws, daemonId);
    expect(ownerUserId).not.toBeNull();
    expect(["pg-owner-a", "pg-owner-b"]).toContain(ownerUserId!);
    expect(store.listAccessTokens(ws).filter((token) => token.daemonId === daemonId)).toHaveLength(1);

    const sameOwner = await store.createAccessToken({
      name: "PG same owner second token",
      type: "daemon",
      workspaceId: ws,
      daemonId,
      userId: ownerUserId!,
    });
    expect(sameOwner.daemonId).toBe(daemonId);
    expect(store.registerRuntime({
      id: `rt-pg-owner-race-${wsCounter}`,
      name: "PG same owner runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId,
      ownerId: ownerUserId,
    }).ownerId).toBe(ownerUserId);
    expect(() => store.registerRuntime({
      id: `rt-pg-owner-race-conflict-${wsCounter}`,
      name: "PG conflicting owner runtime",
      provider: "codex",
      workspaceId: ws,
      daemonId,
      ownerId: ownerUserId === "pg-owner-a" ? "pg-owner-b" : "pg-owner-a",
    })).toThrow("already owned by another user");
  });

  it("reports Agent Plugin Runtime state without untyped nullable parameters (PG)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      name: "rt-plugin-state-pg",
      provider: "claude",
      workspaceId: ws,
    });
    const agent = store.createAgent({ name: "Plugin PG", provider: "claude", workspaceId: ws });
    const plugin = store.importAgentPlugin({
      workspaceId: ws,
      provider: "claude",
      manifest: { name: "plugin-state-pg", version: "1.0.0" },
      files: [{ path: "skills/plugin-state/SKILL.md", content: "# Plugin state\n" }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });

    // The omitted attempts value used to become `$3 IS NOT NULL`. Postgres
    // cannot infer a type for that independent placeholder and rejected the
    // whole report even though SQLite accepted it.
    const setup = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "setup_required",
      lastErrorCode: "dependency_missing",
      lastError: "dependency missing",
      nextRetryAt: "2026-08-14T12:00:00.000Z",
    });
    expect(setup).toMatchObject({ status: "setup_required", retryCount: 1 });

    const [retried] = store.retryAgentPluginRuntime(plugin.id, runtime.id);
    const ready = store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      attempts: 2,
      retryGeneration: retried!.retryGeneration,
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    expect(ready).toMatchObject({ status: "ready", retryCount: 2 });

    // Import, binding and desired-state reconciliation all take the same
    // workspace lock. Claiming must consume the frozen snapshot without
    // attempting to open a nested transaction on Postgres.
    const task = store.createTask({ agentId: agent.id, prompt: "Use the PG Plugin" });
    const claimed = store.claimTask(runtime.id);
    expect(claimed).toMatchObject({ id: task.id, pluginSnapshot: [{ pluginId: plugin.id }] });
  });

  it("creates and lists projects scoped to a workspace", () => {
    const ws = freshWorkspace();
    const a = store.createProject({ title: "Alpha", workspaceId: ws });
    const b = store.createProject({ title: "Beta", workspaceId: ws });
    const ids = store.listProjects(ws).map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(store.getProject(a.id)?.title).toBe("Alpha");
  });

  it("persists project instruction revisions and rejects stale Postgres writes", () => {
    const ws = freshWorkspace();
    const project = store.createProject(
      { title: "PG instructions", workspaceId: ws, instructions: "Initial" },
      { instructionsUpdatedBy: "usr_pg_creator" },
    );
    expect(project).toMatchObject({
      instructions: "Initial",
      instructionsRevision: 1,
      instructionsUpdatedBy: "usr_pg_creator",
    });

    const updated = store.updateProject(
      project.id,
      { instructions: "Updated", expectedInstructionsRevision: 1 },
      { instructionsUpdatedBy: "usr_pg_editor" },
    );
    expect(updated).toMatchObject({
      instructions: "Updated",
      instructionsRevision: 2,
      instructionsUpdatedBy: "usr_pg_editor",
    });
    expect(() => store.updateProject(
      project.id,
      { instructions: "Stale", expectedInstructionsRevision: 1 },
      { instructionsUpdatedBy: "usr_pg_stale" },
    )).toThrow(ProjectInstructionsRevisionConflictError);
    expect(store.getProject(project.id)).toMatchObject({
      instructions: "Updated",
      instructionsRevision: 2,
      instructionsUpdatedBy: "usr_pg_editor",
    });
  });

  it("persists OpenViking control metadata without project knowledge bodies", () => {
    const ws = freshWorkspace();
    const project = store.createProject({ title: "PG OpenViking", workspaceId: ws });
    const uri = `viking://resources/multiremi/workspaces/${ws}/projects/${project.id}/knowledge/wiki/runbook.md`;
    const created = store.createProjectDocMetadata(project.id, {
      kind: "wiki",
      slug: "runbook",
      title: "Runbook",
      body: "must not enter SQL",
    }, {
      contentUri: uri,
      contentSha256: "hash-v1",
      snapshotOid: "oid-v1",
      syncStatus: "ready",
    });

    expect(created).toMatchObject({
      body: "",
      storageBackend: "openviking",
      contentUri: uri,
      contentSha256: "hash-v1",
      syncStatus: "ready",
      snapshotOid: "oid-v1",
    });
    const v2 = store.replaceProjectDocMetadataExact({
      ...created,
      title: "Runbook v2",
      version: 2,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    }, {
      contentUri: uri,
      contentSha256: "hash-v2",
      snapshotOid: "oid-v2",
      syncStatus: "ready",
    });
    expect(v2).toMatchObject({ body: "", version: 2, contentSha256: "hash-v2", snapshotOid: "oid-v2" });
    expect(store.listProjectDocRevisions(created.id).map((revision) => ({
      version: revision.version,
      body: revision.body,
      contentSha256: revision.contentSha256,
      snapshotOid: revision.snapshotOid,
    }))).toEqual([
      { version: 2, body: "", contentSha256: "hash-v2", snapshotOid: "oid-v2" },
      { version: 1, body: "", contentSha256: "hash-v1", snapshotOid: "oid-v1" },
    ]);
  });

  it("escapes LIKE metacharacters in project doc search the same way sqlite does", () => {
    // searchProjectDocs pins `ESCAPE '\'` into the SQL text. Postgres already
    // treats backslash as the default LIKE escape while sqlite has none, so the
    // clause is what makes the two dialects agree — and it has to survive
    // translateSqliteToPg's string-aware placeholder numbering to get here.
    const ws = freshWorkspace();
    const project = store.createProject({ title: "PG escaping", workspaceId: ws });
    const percent = store.createProjectDoc(project.id, { kind: "memory", title: "Cache hit 90% on warm runs" });
    const underscore = store.createProjectDoc(project.id, { kind: "memory", title: "Set MAX_WORKERS before the run" });
    const backslash = store.createProjectDoc(project.id, { kind: "memory", title: "Windows path C:\\Users\\ci" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Unrelated page" });

    expect(store.searchProjectDocs(project.id, "90%").map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.searchProjectDocs(project.id, "MAX_WORKERS").map((doc) => doc.id)).toEqual([underscore.id]);
    expect(store.searchProjectDocs(project.id, "MAXaWORKERS")).toHaveLength(0);
    expect(store.searchProjectDocs(project.id, "C:\\Users").map((doc) => doc.id)).toEqual([backslash.id]);
    expect(store.searchProjectDocs(project.id, "%").map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.searchProjectDocs(project.id, "_").map((doc) => doc.id)).toEqual([underscore.id]);
    expect(store.searchProjectDocs(project.id, "%unrelated%")).toEqual([]);
  });

  it("lists workspace docs with the project JOIN and literal LIKE on Postgres", () => {
    // listWorkspaceDocs adds a JOIN with an aliased column plus the same
    // ESCAPE'd LIKE block — both must survive translateSqliteToPg.
    const ws = freshWorkspace();
    const alpha = store.createProject({ title: "Alpha PG", workspaceId: ws });
    const beta = store.createProject({ title: "Beta PG", workspaceId: ws });
    const percent = store.createProjectDoc(alpha.id, { kind: "memory", title: "Cache hit 90% on warm runs" });
    store.createProjectDoc(beta.id, { kind: "wiki", title: "Unrelated page" });

    const all = store.listWorkspaceDocs(ws).filter((doc) => doc.slug !== "_schema");
    expect(all.map((doc) => [doc.title, doc.projectTitle]).sort()).toEqual([
      ["Cache hit 90% on warm runs", "Alpha PG"],
      ["Unrelated page", "Beta PG"],
    ]);

    expect(store.listWorkspaceDocs(ws, { q: "90%" }).map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.listWorkspaceDocs(ws, { q: "90a" })).toHaveLength(0);
    expect(store.listWorkspaceDocs(ws, { kind: "memory" }).map((doc) => doc.id)).toEqual([percent.id]);
  });

  it("registers runtimes and upserts them via ON CONFLICT (id) DO UPDATE", () => {
    const ws = freshWorkspace();
    const first = store.registerRuntime({ name: "rt-a", provider: "claude", workspaceId: ws, maxConcurrency: 3 });
    expect(first.status).toBe("online");
    expect(first.maxConcurrency).toBe(3);
    // Re-register same id → UPDATE path (ON CONFLICT), not a duplicate row.
    const again = store.registerRuntime({ id: first.id, name: "rt-a2", provider: "claude", workspaceId: ws, maxConcurrency: 5 });
    expect(again.id).toBe(first.id);
    expect(again.maxConcurrency).toBe(5);
    expect(store.listRuntimes().filter((r) => r.id === first.id).length).toBe(1);
  });

  it("creates and lists agents (non-archived only)", () => {
    const ws = freshWorkspace();
    const agent = store.createAgent({ name: "Ag", provider: "claude", workspaceId: ws });
    const listed = store.listAgents().find((a) => a.id === agent.id);
    expect(listed?.name).toBe("Ag");
  });

  it("creates issues with auto-incrementing per-workspace keys", () => {
    const ws = freshWorkspace();
    const i1 = store.createIssue({ title: "One", workspaceId: ws });
    const i2 = store.createIssue({ title: "Two", workspaceId: ws });
    expect(i1.number).toBe(1);
    expect(i2.number).toBe(2);
    expect(store.getIssue(i1.id)?.title).toBe("One");
  });

  it("projects and links provider-neutral change requests on Postgres", () => {
    const ws = freshWorkspace();
    const repositoryId = `repo_pg_scm_${wsCounter}`;
    store.updateWorkspace(ws, {
      repos: [{
        id: repositoryId,
        name: "widgets",
        url: "git@github.com:acme/widgets.git",
        source: "github",
        default_branch: "main",
      }],
    });
    const connection = store.createScmConnection({
      workspaceId: ws,
      name: "PG GitHub",
      provider: "github",
      mode: "poll",
      repositoryIds: [repositoryId],
    });
    const issue = store.createIssue({ title: "PG change request", workspaceId: ws });

    expect(store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId,
      entityType: "change_request",
      externalId: "9001",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "open-v1",
      payload: {
        number: 42,
        title: "PG projection",
        body: `Resolves ${issue.key}`,
        state: "open",
        source_branch: "feature/pg",
        target_branch: "main",
      },
    }).applied).toBe(true);

    expect(store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId,
      entityType: "change_request",
      externalId: "without-number",
      revisionAt: "2026-08-21T10:01:00.000Z",
      revision: "v1",
      contentHash: "without-number-v1",
      payload: { title: "Projection without a numeric identifier", state: "open" },
    }).applied).toBe(true);

    const projected = store.listScmChangeRequestsForIssue(issue.id)!;
    expect(projected).toEqual([
      expect.objectContaining({
        externalId: "9001",
        number: 42,
        body: `Resolves ${issue.key}`,
        sourceBranch: "feature/pg",
      }),
    ]);
    expect(store.unlinkScmChangeRequestFromIssue(issue.id, projected[0]!.id)).toBe(true);
    expect(store.listScmChangeRequestsForIssue(issue.id)).toEqual([]);
    expect(store.linkScmChangeRequestToIssue(issue.id, projected[0]!.id).link.source).toBe("manual");
  });

  it("atomically reconciles workspace repositories and selected bindings on Postgres", () => {
    const ws = freshWorkspace();
    const firstId = `repo_pg_atomic_first_${wsCounter}`;
    const secondId = `repo_pg_atomic_second_${wsCounter}`;
    const repositories = [
      { id: firstId, name: "first", url: "git@github.com:acme/first.git", source: "github", default_branch: "main" },
      { id: secondId, name: "second", url: "git@github.com:acme/second.git", source: "github", default_branch: "main" },
    ];
    store.updateWorkspaceRepositories(ws, repositories);
    const connection = store.createScmConnection({
      workspaceId: ws,
      name: "PG selected",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
      repositoryIds: [firstId],
    });

    const replaced = store.updateScmConnection(connection.id, {
      repositoryIds: [secondId],
    });
    expect(replaced.repositories.map((binding) => binding.repositoryId)).toEqual([secondId]);

    expect(() => store.updateScmConnection(connection.id, {
      name: "Must roll back",
      repositoryIds: [secondId, "repo_missing"],
    })).toThrow("Repository not found in workspace");
    expect(store.getScmConnection(connection.id)?.name).toBe("PG selected");
    expect(store.listScmRepositoryBindings({ connectionId: connection.id }).map((binding) => binding.repositoryId))
      .toEqual([secondId]);

    expect(() => store.updateWorkspaceRepositories(ws, [
      repositories[0]!,
      { ...repositories[1]!, url: "git@gitlab.example.test:acme/second.git" },
    ])).toThrow();
    expect(store.getWorkspace(ws)?.repos).toContainEqual(
      expect.objectContaining({ id: secondId, url: "git@github.com:acme/second.git" }),
    );
    expect(store.getScmRepositoryBinding(connection.id, secondId)?.repositoryUrl)
      .toBe("git@github.com:acme/second.git");
  });

  it("persists Issue Sessions, agent lanes, projections, and explicit results", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      name: "rt-session-pg",
      provider: "claude",
      workspaceId: ws,
    });
    const agent = store.createAgent({
      name: "Session PG",
      provider: "claude",
      workspaceId: ws,
      runtimeId: runtime.id,
    });
    const issue = store.createIssue({ title: "Session PG issue", workspaceId: ws });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const sibling = store.createIssueSession(issue.id, { title: "Sibling" });

    store.createIssueComment(issue.id, {
      issueSessionId: main.id,
      body: "Canonical main context",
    });
    store.createIssueComment(issue.id, {
      issueSessionId: sibling.id,
      body: "Private sibling transcript",
    });

    const task = store.createSessionTask(main.id, {
      agentId: agent.id,
      prompt: "Use the main context",
    });
    expect(store.buildTaskSessionProjection(task.id)).toMatchObject({
      mode: "bootstrap",
      sessionId: main.id,
      targetAgentId: agent.id,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const prompt = "# Bootstrap Prompt\n\n## Current Request\nUse the main context";
    const recordedPrompt = store.recordTaskPrompt(task.id, {
      mode: "bootstrap",
      prompt,
      sha256: createHash("sha256").update(prompt).digest("hex"),
    });
    expect(store.getTaskPrompt(task.id)).toEqual(recordedPrompt);
    store.startTask(task.id);
    store.completeTask(task.id, {
      output: "Main answer",
      sessionId: "pg_acp_session",
      workDir: "/tmp/pg-issue-session",
    });

    expect(store.getSessionAgentLane(main.id, agent.id)).toMatchObject({
      providerSessionId: "pg_acp_session",
      runtimeId: runtime.id,
      provider: "claude",
      lastTaskId: task.id,
    });
    expect(store.listSessionEvents(main.id).some((event) => event.body === "Private sibling transcript")).toBe(false);

    const result = store.publishSessionResult(main.id, {
      title: "Reusable decision",
      body: "Only this bounded result crosses Sessions.",
    });
    expect(store.listIssueSessionResults(issue.id)).toEqual([result]);
  });

  it("listIssues pushes status/priority/project/assignee filters + pagination into SQL", () => {
    const ws = freshWorkspace();
    const project = store.createProject({ title: "P", workspaceId: ws });
    const todoHigh = store.createIssue({ title: "todo-high", workspaceId: ws, status: "todo", priority: "high", projectId: project.id });
    const progLow = store.createIssue({ title: "prog-low", workspaceId: ws, status: "in_progress", priority: "low" });
    const done = store.createIssue({ title: "done", workspaceId: ws, status: "done", priority: "none" });

    const keyset = (issues: { id: string }[]) => new Set(issues.map((i) => i.id));

    expect(keyset(store.listIssues({ workspaceId: ws }))).toEqual(keyset([todoHigh, progLow, done]));
    expect(store.listIssues({ workspaceId: ws, statuses: ["todo"] }).map((i) => i.id)).toEqual([todoHigh.id]);
    expect(store.listIssues({ workspaceId: ws, statuses: ["todo", "in_progress"] }).length).toBe(2);
    expect(store.listIssues({ workspaceId: ws, priorities: ["high"] }).map((i) => i.id)).toEqual([todoHigh.id]);
    expect(store.listIssues({ workspaceId: ws, projectId: project.id }).map((i) => i.id)).toEqual([todoHigh.id]);
    expect(store.listIssues({ workspaceId: ws, includeNoProject: true }).length).toBe(2);
    // LIMIT/OFFSET pushdown: ordered by updated_at DESC (last created first).
    expect(store.listIssues({ workspaceId: ws, limit: 1 }).length).toBe(1);
    expect(store.listIssues({ workspaceId: ws, limit: 2, offset: 2 }).length).toBe(1);
  });

  it("filters issues by assignee via the IN (…) pushdown", () => {
    const ws = freshWorkspace();
    const member = store.createWorkspaceMember({ name: "Assignee", workspaceId: ws, role: "member" });
    const assigned = store.createIssue({ title: "assigned", workspaceId: ws, assigneeType: "member", assigneeId: member.id });
    store.createIssue({ title: "unassigned", workspaceId: ws });
    expect(store.listIssues({ workspaceId: ws, assigneeIds: [member.id] }).map((i) => i.id)).toEqual([assigned.id]);
    expect(store.listIssues({ workspaceId: ws, assigneeTypes: ["member"] }).map((i) => i.id)).toEqual([assigned.id]);
    expect(store.listIssues({ workspaceId: ws, includeNoAssignee: true }).map((i) => i.title)).toEqual(["unassigned"]);
  });

  it("claims a queued task for a runtime via the UPDATE … RETURNING pushdown", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-claim", provider: "claude", workspaceId: ws, maxConcurrency: 2 });
    const agent = store.createAgent({ name: "Claimer", provider: "claude", workspaceId: ws, runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "go", workspaceId: ws });
    expect(task.status).toBe("queued");

    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("dispatched");
    expect(claimed?.agent?.id).toBe(agent.id);
    // Nothing left queued → second claim yields null.
    expect(store.claimTask(runtime.id)).toBeNull();
  });

  it("pool-claims unbound agents' tasks and stamps affinity (chat session + local directory)", () => {
    const ws = freshWorkspace();
    const codex = store.registerRuntime({ name: "rt-pool-codex", provider: "codex", workspaceId: ws, daemonId: "daemon-pg-pool" });
    const claude = store.registerRuntime({ name: "rt-pool-claude", provider: "claude", workspaceId: ws });
    const agent = store.createAgent({ name: "PG Pool", provider: "codex", workspaceId: ws });
    expect(agent.runtimeId).toBeNull();

    // Unbound task: claude can't claim it, codex can, and the claim stamps it.
    const task = store.createTask({ agentId: agent.id, prompt: "pooled", workspaceId: ws });
    expect(task.runtimeId).toBeNull();
    expect(store.claimTask(claude.id)).toBeNull();
    expect(store.claimTask(codex.id)?.id).toBe(task.id);
    expect(store.getTask(task.id)?.runtimeId).toBe(codex.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });

    // Chat affinity: a promoted provider session pins follow-ups to its machine.
    const session = store.createChatSession({ agentId: agent.id, title: "pg chat", workspaceId: ws });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi", workspaceId: ws });
    expect(first.runtimeId).toBeNull();
    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "done", sessionId: "sess_pg_chat", workDir: "/tmp/pg-chat" });
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again", workspaceId: ws });
    expect(followUp.runtimeId).toBe(codex.id);

    // local_directory affinity resolves the daemon's provider-matching runtime.
    const project = store.createProject({
      title: "PG local dir",
      workspaceId: ws,
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/pg-project", daemon_id: "daemon-pg-pool" } }],
    });
    const issue = store.createIssue({ title: "pg dir issue", workspaceId: ws, projectId: project.id });
    const dirTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work in dir", workspaceId: ws });
    expect(dirTask.runtimeId).toBe(codex.id);

    // Ownership predicate: another member's private runtime can't claim the
    // pool task; a public one can. (Same SQL path as SQLite — this guards the
    // translated Postgres form.)
    const privateRt = store.registerRuntime({
      name: "rt-pool-private",
      provider: "codex",
      workspaceId: ws,
      ownerId: "someone-else",
      visibility: "private",
    });
    const publicRt = store.registerRuntime({
      name: "rt-pool-public",
      provider: "codex",
      workspaceId: ws,
      ownerId: "someone-else",
      visibility: "public",
    });
    const ownedIssue = store.createIssue({ title: "pg owned", workspaceId: ws });
    const ownedTask = store.createTask({ agentId: agent.id, issueId: ownedIssue.id, prompt: "owned", workspaceId: ws });
    expect(store.claimTask(privateRt.id)).toBeNull();
    expect(store.claimTask(publicRt.id)?.id).toBe(ownedTask.id);
  });

  it("serializes Runtime-affine project, token, and Issue workspace writes with daemon retirement", async () => {
    const ws = freshWorkspace();
    const daemonId = `daemon-pg-retire-${wsCounter}`;
    const runtime = store.registerRuntime({
      id: daemonRuntimeId(daemonId, "claude"),
      name: "PG retiring runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId,
    });
    const unboundDaemonToken = await store.createAccessToken({
      name: "PG unbound daemon",
      type: "daemon",
      workspaceId: ws,
    });
    const project = store.createProject({
      title: "PG lifecycle lock",
      workspaceId: ws,
      resources: [{
        resourceType: "local_directory",
        resourceRef: { localPath: "/abs/pg-other-machine", daemonId: "daemon-pg-other" },
      }],
    });
    const localDirectory = store.listProjectResources(project.id)[0]!;
    const issue = store.createIssue({ title: "PG clean workspace", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/abs/pg-issue",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });
    const deletedIssue = store.createIssue({ title: "PG deleted workspace", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: deletedIssue.id,
      runtimeId: runtime.id,
      rootPath: "/abs/pg-deleted-issue",
      branchName: `agent/${deletedIssue.key}`,
      status: "in_use",
    });
    expect(store.deleteIssue(deletedIssue.id)).toBeFalse();
    store.markIssueWorkspaceCleaned({
      issueId: deletedIssue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, deletedIssue.id, runtime.id),
    });
    expect(store.deleteIssue(deletedIssue.id)).toBeTrue();
    expect(store.getIssueWorkspace(deletedIssue.id)).toBeNull();
    expect(Number((db.query(
      "SELECT COUNT(*) AS count FROM multiremi_issue_workspaces WHERE issue_id = ?",
    ).get(deletedIssue.id) as { count: number }).count)).toBe(0);
    const completedSkillImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "pg-completed-skill" });
    const completedSkill = store.reportRuntimeLocalSkillImportResult(runtime.id, completedSkillImport.id, {
      status: "completed",
      skill: { name: "PG imported skill", content: "# PG imported skill" },
    });
    expect(completedSkill.status).toBe("completed");
    expect(completedSkill.skill?.name).toBe("PG imported skill");
    const localSkillImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "pg-retired-skill" });
    const skillCountBeforeRetirement = store.listSkills(ws).length;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO multiremi_daemon_ssh_mesh_states (
         workspace_id, daemon_id, runtime_id, protocol_version, status, key_version,
         config_revision, ssh_user, hostname, addresses, host_keys,
         public_key_installed, config_installed, peer_tests,
         probe_revision, desired_probe_revision, probe_target_daemon_ids,
         last_error_code, last_error, last_reported_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'ready', 7, ?, 'pg-user', 'pg-host', ?, ?, 1, 1, ?, 3, 4, ?,
                 'old-error', 'old detail', ?, ?, ?)`,
      [
        ws,
        daemonId,
        runtime.id,
        "pg-config-revision",
        JSON.stringify(["10.0.0.8"]),
        JSON.stringify(["ssh-ed25519 AAAAPG"]),
        JSON.stringify([{ daemon_id: "peer", status: "ready" }]),
        JSON.stringify(["peer"]),
        now,
        now,
        now,
      ],
    );

    const plan = store.getDaemonRetirementPlan(ws, daemonId);
    expect(plan.canRetire).toBeTrue();
    expect(store.retireDaemon(ws, daemonId, plan.snapshot, null).status).toBe("retired");
    expect(db.query(
      `SELECT runtime_id, protocol_version, status, key_version, config_revision,
              ssh_user, hostname, addresses, host_keys, public_key_installed,
              config_installed, peer_tests, probe_revision, desired_probe_revision,
              probe_target_daemon_ids, last_error_code, last_error
       FROM multiremi_daemon_ssh_mesh_states
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get(ws, daemonId)).toMatchObject({
      runtime_id: null,
      protocol_version: 0,
      status: "cleaned",
      key_version: null,
      config_revision: null,
      ssh_user: null,
      hostname: null,
      addresses: "[]",
      host_keys: "[]",
      public_key_installed: 0,
      config_installed: 0,
      peer_tests: "[]",
      probe_revision: 0,
      desired_probe_revision: 0,
      probe_target_daemon_ids: "[]",
      last_error_code: null,
      last_error: null,
    });
    expect(() => store.updateProjectResource(project.id, localDirectory.id, {
      resourceRef: { localPath: "/abs/pg-retired-machine", daemonId },
    })).toThrow("has been retired");
    expect(() => store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/abs/pg-resurrected",
      branchName: `agent/${issue.key}`,
      status: "ready",
    })).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.updateRuntimeModels(runtime.id, [{ id: "late-pg-model", label: "Late PG", provider: "anthropic", default: false }]))
      .toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeDirectoryScanRequest(runtime.id)).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeModelListRequest(runtime.id)).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9" }))
      .toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeLocalSkillListRequest(runtime.id)).toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "late-pg-skill" }))
      .toThrow(`Runtime not found: ${runtime.id}`);
    expect(() => store.reportRuntimeLocalSkillImportResult(runtime.id, localSkillImport.id, {
      status: "completed",
      skill: { name: "Dangling PG skill", content: "Never persisted" },
    })).toThrow("request not found");
    expect(store.listSkills(ws)).toHaveLength(skillCountBeforeRetirement);
    expect(() => store.bindDaemonAccessToken(unboundDaemonToken.id, daemonId)).toThrow("has been retired");
    expect(store.getAccessToken(unboundDaemonToken.id)?.daemonId).toBeNull();
    await expect(store.createAccessToken({
      name: "PG rejected retired daemon",
      type: "daemon",
      workspaceId: ws,
      daemonId,
    })).rejects.toThrow("has been retired");
  });

  it("rejects ordinary disable and explicitly invalidates an SSH Mesh rollout on Postgres", () => {
    const previousKey = process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
    process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const ws = freshWorkspace();
      const daemonId = `daemon-pg-ssh-emergency-${wsCounter}`;
      store.registerRuntime({
        id: `rt-pg-ssh-emergency-${wsCounter}`,
        name: "PG SSH emergency daemon",
        provider: "claude",
        workspaceId: ws,
        daemonId,
      });
      store.setSshMeshEnabled(ws, true, {
        privateKey: "test-private-key-v1",
        publicKey: "ssh-ed25519 test-v1",
        fingerprint: "SHA256:test-v1",
      }, null);
      expect(store.rotateSshMeshKey(ws, {
        privateKey: "test-private-key-v2",
        publicKey: "ssh-ed25519 test-v2",
        fingerprint: "SHA256:test-v2",
      })).toMatchObject({ key_version: 2, rotation_state: "rolling_out" });

      const rollingRow = db.query(
        `SELECT active_key_version, active_operation_id, active_private_key_encrypted,
                active_public_key, active_fingerprint, previous_private_key_encrypted,
                previous_public_key, previous_fingerprint, enabled, rotation_state
         FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
      ).get(ws);
      expect(() => store.setSshMeshEnabled(ws, false, null, null))
        .toThrow("SSH Mesh key rotation is in progress; confirm key invalidation to disable");
      expect(db.query(
        `SELECT active_key_version, active_operation_id, active_private_key_encrypted,
                active_public_key, active_fingerprint, previous_private_key_encrypted,
                previous_public_key, previous_fingerprint, enabled, rotation_state
         FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
      ).get(ws)).toEqual(rollingRow);

      expect(store.invalidateSshMeshKey(ws)).toMatchObject({
        enabled: false,
        key_version: 3,
        fingerprint: null,
        rotation_state: "rekey_required",
      });
      const row = db.query(
        `SELECT active_operation_id, active_private_key_encrypted, active_public_key, active_fingerprint,
                previous_private_key_encrypted, previous_public_key, previous_fingerprint
         FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
      ).get(ws) as Record<string, unknown>;
      expect(String(row.active_operation_id)).toStartWith("sshinvalidate_");
      expect(Object.entries(row)
        .filter(([column]) => column !== "active_operation_id")
        .every(([, value]) => value === null)).toBeTrue();

      const plan = store.getDaemonRetirementPlan(ws, daemonId);
      expect(store.retireDaemon(ws, daemonId, plan.snapshot, null)).toMatchObject({ status: "retired" });
      expect(store.deleteWorkspace(ws)).toBeTrue();
    } finally {
      if (previousKey === undefined) delete process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY;
      else process.env.MULTIREMI_SSH_MESH_ENCRYPTION_KEY = previousKey;
    }
  });

  it("records an idempotent explicit SSH key invalidation on Postgres", () => {
    const ws = freshWorkspace();
    const first = store.invalidateSshMeshKey(ws);
    expect(first).toMatchObject({
      enabled: false,
      key_version: 1,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    expect(store.invalidateSshMeshKey(ws)).toMatchObject({
      enabled: false,
      key_version: 1,
      fingerprint: null,
      rotation_state: "rekey_required",
    });
    expect(store.deleteWorkspace(ws)).toBeTrue();
  });

  it("migrates and cleans complete Runtime auxiliary state on Postgres", () => {
    const ws = freshWorkspace();
    const oldRuntime = store.registerRuntime({
      id: `rt-pg-merge-old-${wsCounter}`,
      name: "PG old Runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId: `daemon-pg-old-${wsCounter}`,
      models: [
        { id: "old-only", label: "Old only", provider: "claude", default: false },
        { id: "shared", label: "Old shared", provider: "claude", default: true },
      ],
    });
    const newRuntime = store.registerRuntime({
      id: `rt-pg-merge-new-${wsCounter}`,
      name: "PG new Runtime",
      provider: "claude",
      workspaceId: ws,
      daemonId: `daemon-pg-new-${wsCounter}`,
      models: [
        { id: "shared", label: "New shared", provider: "claude", default: true },
        { id: "new-only", label: "New only", provider: "claude", default: false },
      ],
    });
    const agent = store.createAgent({
      name: "PG merged agent",
      provider: "claude",
      workspaceId: ws,
      runtimeId: oldRuntime.id,
    });
    const issue = store.createIssue({ title: "PG merged workspace", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: oldRuntime.id,
      rootPath: "/tmp/pg-merged",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const requests = [
      ["multiremi_runtime_model_list_requests", store.createRuntimeModelListRequest(oldRuntime.id).id],
      ["multiremi_runtime_update_requests", store.createRuntimeUpdateRequest(oldRuntime.id, { targetVersion: "2.0.0" }).id],
      ["multiremi_runtime_local_skill_list_requests", store.createRuntimeLocalSkillListRequest(oldRuntime.id).id],
      ["multiremi_runtime_local_skill_import_requests", store.createRuntimeLocalSkillImportRequest(oldRuntime.id, { skillKey: "pg-merge" }).id],
      ["multiremi_runtime_directory_scan_requests", store.createRuntimeDirectoryScanRequest(oldRuntime.id, { root: "/tmp" }).id],
    ] as const;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO multiremi_agent_plugin_runtime_states (
        id, workspace_id, runtime_id, plugin_id, plugin_version_id,
        desired, desired_reason, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'active_binding', 'pending', ?, ?)`,
      [`aprs-pg-merge-${wsCounter}`, ws, oldRuntime.id, `apl-pg-${wsCounter}`, `apv-pg-${wsCounter}`, now, now],
    );

    expect(store.mergeRuntimeInto(oldRuntime.id, newRuntime.id).deleted).toBeTrue();
    expect(store.getAgent(agent.id)?.runtimeId).toBe(newRuntime.id);
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: newRuntime.id, status: "ready" });
    expect(store.listRuntimeModels(newRuntime.id).map((model) => model.id).sort())
      .toEqual(["new-only", "old-only", "shared"]);
    expect(store.listRuntimeModels(newRuntime.id).find((model) => model.id === "shared")?.label).toBe("New shared");
    for (const [table, requestId] of requests) {
      expect(Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ? AND id = ?`).get(
        newRuntime.id,
        requestId,
      ) as { count: number }).count)).toBe(1);
      expect(Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`).get(
        oldRuntime.id,
      ) as { count: number }).count)).toBe(0);
    }
    expect(Number((db.query(
      "SELECT COUNT(*) AS count FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ?",
    ).get(oldRuntime.id) as { count: number }).count)).toBe(0);

    // Runtime cleanup is still exercised directly, but keep one sibling for
    // this managed daemon so the last-Runtime guard correctly reserves whole
    // machine removal for the daemon retirement flow.
    store.registerRuntime({
      id: `rt-pg-merge-sibling-${wsCounter}`,
      name: "PG sibling Runtime",
      provider: "codex",
      workspaceId: ws,
      daemonId: newRuntime.daemonId,
    });
    expect(store.deleteRuntime(newRuntime.id)).toBeTrue();
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: null, status: "runtime_offline" });
    for (const table of [
      "multiremi_agent_plugin_runtime_states",
      "multiremi_runtime_models",
      ...requests.map(([table]) => table),
    ]) {
      expect(Number((db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`).get(
        newRuntime.id,
      ) as { count: number }).count)).toBe(0);
    }
  });

  it("re-pins a local_directory task when its runtime re-registers under a new engine", () => {
    const ws = freshWorkspace();
    store.registerRuntime({ id: "rt-pg-repin", name: "rt-pg-repin", provider: "codex", workspaceId: ws, daemonId: "daemon-pg-repin" });
    const agent = store.createAgent({ name: "PG Repin", provider: "codex", workspaceId: ws });
    const project = store.createProject({
      title: "PG repin dir",
      workspaceId: ws,
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/pg-repin", daemon_id: "daemon-pg-repin" } }],
    });
    const issue = store.createIssue({ title: "pg repin issue", workspaceId: ws, projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work", workspaceId: ws });
    expect(task.runtimeId).toBe("rt-pg-repin");
    // Same-id re-registration flips the engine → the codex directory task re-pins
    // to the daemon's codex runtime id (exercises the repool UPDATE on Postgres).
    store.registerRuntime({ id: "rt-pg-repin", name: "rt-pg-repin", provider: "claude", workspaceId: ws, daemonId: "daemon-pg-repin" });
    expect(store.getTask(task.id)?.runtimeId).toBe(daemonRuntimeId("daemon-pg-repin", "codex"));
  });

  it("creates and lists workspace members", () => {
    const ws = freshWorkspace();
    const before = store.listWorkspaceMembers(ws).length; // owner seeded by createWorkspace
    const bob = store.createWorkspaceMember({ name: "Bob", workspaceId: ws, role: "member", email: "bob@e.com" });
    const members = store.listWorkspaceMembers(ws);
    expect(members.length).toBe(before + 1);
    expect(members.find((m) => m.id === bob.id)?.email).toBe("bob@e.com");
  });

  it("resolves users by external id and email (getOrCreateUser)", () => {
    const created = store.getOrCreateUser({ externalId: "ou_pgtest", email: "pg@e.com", name: "PG User" });
    expect(store.getOrCreateUser({ externalId: "ou_pgtest", email: "pg@e.com" }).id).toBe(created.id);
    expect(store.getUserByExternalId("ou_pgtest")?.id).toBe(created.id);
    expect(store.getUserByEmail("PG@E.com")?.id).toBe(created.id);
  });

  it("mints, lists, verifies, and revokes access tokens", async () => {
    const ws = freshWorkspace();
    const created = await store.createAccessToken({ workspaceId: ws, userId: "local", name: "PAT", type: "pat", expiresInDays: 30 });
    expect(created.token).toBeTruthy();

    const listed = store.listAccessTokens(ws);
    expect(listed.map((t) => t.id)).toContain(created.id);

    const verified = await store.verifyAccessToken(created.token);
    expect(verified?.id).toBe(created.id);
    expect(verified?.lastUsedAt).toBeTruthy(); // UPDATE … SET last_used_at ran

    store.revokeAccessToken(created.id);
    expect(await store.verifyAccessToken(created.token)).toBeNull();
  });

  it("runs transactions (createProject with nested resource) atomically", () => {
    const ws = freshWorkspace();
    store.updateWorkspaceRepositories(ws, [{
      id: `repo_pg_nested_${wsCounter}`,
      name: "repo",
      url: "https://github.com/owner/repo",
      source: "github",
    }]);
    const project = store.createProject({
      title: "With resources",
      workspaceId: ws,
      resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/owner/repo" } }],
    });
    expect(store.getProject(project.id)?.title).toBe("With resources");
    expect(store.listProjectResources(project.id).length).toBe(1);
  });

  it("upserts Issue session preparation failures on Postgres", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({
      name: "archive-failure-pg",
      provider: "codex",
      workspaceId: ws,
      daemonId: `dmn_archive_failure_${wsCounter}`,
    });
    const issue = store.createIssue({ title: "Archive failure PG", workspaceId: ws });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const input = {
      workspaceId: ws,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      stage: "prepare" as const,
      error: "first pack failure",
    };

    const first = store.reportSessionArchiveFailure(
      input,
      `sar_failure_${wsCounter}`,
      `failures/sar_failure_${wsCounter}/sessions.tar.gz`,
    );
    expect(first).toMatchObject({
      created: true,
      archive: { status: "failed", lastError: "first pack failure" },
    });
    expect(store.retrySessionArchive(first.archive.id)).toMatchObject({ status: "pending" });

    const repeated = store.reportSessionArchiveFailure(
      { ...input, error: "second pack failure" },
      `sar_failure_replacement_${wsCounter}`,
      `failures/sar_failure_replacement_${wsCounter}/sessions.tar.gz`,
    );
    expect(repeated).toMatchObject({
      created: false,
      archive: {
        id: first.archive.id,
        status: "failed",
        lastError: "second pack failure",
      },
    });
    expect(store.listSessionArchives(issue.id)).toHaveLength(1);

    const actualInput = {
      workspaceId: ws,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "sessions-v1",
      sha256: createHash("sha256").update("").digest("hex"),
      sizeBytes: 0,
    };
    const actual = store.initSessionArchive(
      actualInput,
      `sar_actual_${wsCounter}`,
      `archives/sar_actual_${wsCounter}/sessions.tar.gz`,
    );
    expect(actual.created).toBe(true);
    expect(store.getSessionArchive(first.archive.id)).toBeNull();

    const newFailure = store.reportSessionArchiveFailure(
      { ...input, error: "third pack failure" },
      `sar_failure_third_${wsCounter}`,
      `failures/sar_failure_third_${wsCounter}/sessions.tar.gz`,
    );
    expect(newFailure.created).toBe(true);
    expect(store.listSessionArchives(issue.id)).toHaveLength(2);
    expect(store.initSessionArchive(
      actualInput,
      `sar_actual_duplicate_${wsCounter}`,
      `archives/sar_actual_duplicate_${wsCounter}/sessions.tar.gz`,
    )).toMatchObject({ created: false, archive: { id: actual.archive.id } });
    expect(store.getSessionArchive(newFailure.archive.id)).toBeNull();
    expect(store.listSessionArchives(issue.id)).toHaveLength(1);
  });

  it("drives the runtime directory scan queue (create → claim → report)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-dirscan", provider: "claude", workspaceId: ws });
    const request = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "~/code", maxDepth: 2 });
    expect(request.status).toBe("pending");
    expect(request.params).toEqual({ root: "~/code", maxDepth: 2 });

    const claimed = store.claimRuntimeDirectoryScanRequest(runtime.id);
    expect(claimed?.id).toBe(request.id);
    expect(claimed?.status).toBe("running");
    expect(store.claimRuntimeDirectoryScanRequest(runtime.id)).toBeNull();

    const reported = store.reportRuntimeDirectoryScanResult(runtime.id, request.id, {
      status: "completed",
      candidates: [{ path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null }],
    });
    expect(reported.status).toBe("completed");
    expect(reported.candidates).toEqual([
      { path: "/home/dev/code/app", name: "app", remoteUrl: "git@github.com:acme/app.git", currentBranch: "main", isDirty: null },
    ]);
  });

  it("resolves project_ref expansion and rejects duplicate refs via the UNIQUE index", () => {
    const ws = freshWorkspace();
    store.updateWorkspaceRepositories(ws, [
      { id: `repo_pg_ref_lib_${wsCounter}`, name: "lib", url: "https://github.com/acme/lib", source: "github" },
      { id: `repo_pg_ref_main_${wsCounter}`, name: "main", url: "https://github.com/acme/main", source: "github" },
    ]);
    const lib = store.createProject({ title: "Lib", workspaceId: ws, resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/lib" } }] });
    const main = store.createProject({
      title: "Main",
      workspaceId: ws,
      resources: [
        { resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/main" } },
        { resourceType: "project_ref", resourceRef: { project_id: lib.id } },
      ],
    });

    const agent = store.createAgent({ name: "dirscan-agent", provider: "claude", workspaceId: ws });
    const issue = store.createIssue({ title: "Ref work", workspaceId: ws, projectId: main.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work", workspaceId: ws });
    expect(store.getTaskWithAgent(task.id)!.repos.map((repo) => repo.url)).toEqual([
      "https://github.com/acme/main",
      "https://github.com/acme/lib",
    ]);

    // Re-attaching the same reference collides on UNIQUE(project_id, resource_type, resource_ref).
    expect(() => store.createProjectResource(main.id, { resourceType: "project_ref", resourceRef: { projectId: lib.id } }))
      .toThrow("duplicate key value violates unique constraint");
  });

  // Regression: agentCommentedSince used `(? IS NULL OR created_at >= ?)`,
  // which Postgres rejects ("could not determine data type of parameter") —
  // the throw escaped postAgentReplyComment's try, so completing an issue task
  // never posted the agent's reply comment in production.
  it("posts the agent's final reply as an issue comment on completion (PG)", () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "rt-reply-pg", provider: "claude", workspaceId: ws });
    const agent = store.createAgent({ name: "Reply PG", provider: "claude", workspaceId: ws, runtimeId: runtime.id });
    const issue = store.createIssue({ title: "统计后端文件", workspaceId: ws });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "统计后端文件", workspaceId: ws });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "后端共 119 个文件。" });

    const comments = store.listIssueComments(issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "agent", authorId: agent.id, body: "后端共 119 个文件。" });

    // Self-replied run: completion must not double-post.
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "再来一次", workspaceId: ws });
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
    store.startTask(second.id);
    store.createIssueComment(issue.id, { authorType: "agent", authorId: agent.id, body: "自己发的回复" });
    const before = store.listIssueComments(issue.id).length;
    store.completeTask(second.id, { output: "narration text" });
    expect(store.listIssueComments(issue.id)).toHaveLength(before);
  });

  it("dispatches trigger_issue system events atomically on Postgres", () => {
    const ws = freshWorkspace();
    const agent = store.createAgent({ name: "Wiki PG", provider: "codex", workspaceId: ws });
    const issue = store.createIssue({ title: "Wiki PG evidence", workspaceId: ws, status: "in_review" });
    const autopilot = store.createAutopilot({
      title: "Wiki PG maintainer",
      workspaceId: ws,
      assigneeId: agent.id,
      executionMode: "trigger_issue",
      sessionPolicy: "new",
    });
    store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
      },
    });

    store.updateIssue(issue.id, { status: "done" });
    const [run] = store.dispatchPendingSystemEvents();
    expect(run).toMatchObject({ issueId: issue.id, source: "system_event", status: "running" });
    expect(run.issueSessionId).toBeString();
    expect(store.getTask(run.taskId!)?.issueSessionId).toBe(run.issueSessionId);
  });

  it("archives eligible terminal issues and counts archived lists on Postgres", () => {
    const ws = freshWorkspace();
    store.updateWorkspace(ws, {
      settings: {
        issue_archive: {
          ttl_ms: 60 * 60 * 1000,
          sweep_interval_ms: 60 * 1000,
        },
      },
    });
    const archived = store.createIssue({ title: "Archive PG", workspaceId: ws, status: "done" });
    const active = store.createIssue({ title: "Active PG", workspaceId: ws });
    db.run(
      "UPDATE multiremi_issues SET completed_at = ? WHERE id = ?",
      ["2026-08-22T06:00:00.000Z", archived.id],
    );

    expect(store.archiveEligibleIssues(new Date("2026-08-22T08:00:00.000Z")))
      .toContainEqual(expect.objectContaining({ id: archived.id }));
    expect(store.listIssues({ workspaceId: ws }).map((issue) => issue.id)).toEqual([active.id]);
    expect(store.countIssues({ workspaceId: ws, archivedOnly: true })).toBe(1);

    expect(store.restoreIssue(archived.id)).toMatchObject({
      status: "done",
      completedAt: null,
      archivedAt: null,
    });
    runMigrations(db);
    expect(store.getIssue(archived.id)).toMatchObject({ completedAt: null, archivedAt: null });
    expect(store.archiveEligibleIssues(new Date("2026-08-22T08:00:00.000Z")).map((issue) => issue.id))
      .not.toContain(archived.id);
  });

  it("keeps a user terminal Issue committed while a worker status write waits on its row lock (PG)", async () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "terminal-race-runtime", provider: "codex", workspaceId: ws });
    const agent = store.createAgent({ name: "Terminal Race", provider: "codex", workspaceId: ws });
    const issue = store.createIssue({ title: "Do not reopen", workspaceId: ws, status: "backlog" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Start after acceptance" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    db.run("DELETE FROM multiremi_system_events WHERE resource_id = ?", [issue.id]);

    const worker = new Worker(
      new URL("./fixtures/postgres-terminal-issue-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    worker.postMessage({
      databaseUrl: `${PG_HOST_URL}/${TEST_DB}`,
      issueId: issue.id,
      eventId: `sev_pg_terminal_${wsCounter}`,
      holdMs: 200,
    });

    await locked;
    // This call reaches the Issue row while the user transaction still owns
    // it. The store's own bridge runs in another worker, so the test process can
    // genuinely exercise the two-connection lock ordering.
    expect(store.startTask(task.id).status).toBe("running");
    await committed;
    worker.terminate();

    expect(store.getIssue(issue.id)?.status).toBe("done");
    const outbox = db.query(
      "SELECT payload FROM multiremi_system_events WHERE resource_id = ? ORDER BY created_at ASC",
    ).all(issue.id) as Array<{ payload: string }>;
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({
      previous_status: "todo",
      status: "done",
    });
  });

  it("orders terminal writes after Session projection locks without deadlocking (PG)", async () => {
    const ws = freshWorkspace();
    const runtime = store.registerRuntime({ name: "projection-race-runtime", provider: "codex", workspaceId: ws });
    const agent = store.createAgent({ name: "Projection Race", provider: "codex", workspaceId: ws });
    const issue = store.createIssue({ title: "Projection race", workspaceId: ws });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Freeze this prompt" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(task.issueSessionId).toBeString();

    const worker = new Worker(
      new URL("./fixtures/postgres-session-projection-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    worker.postMessage({
      databaseUrl: `${PG_HOST_URL}/${TEST_DB}`,
      sessionId: task.issueSessionId!,
      taskId: task.id,
      holdMs: 150,
    });

    await locked;
    // The fixed terminal path waits on Session before touching Task. The old
    // Task -> Session order deadlocked here when the projection worker woke
    // and tried to write the same Task while still owning Session.
    expect(store.completeTask(task.id, { output: "Completed after projection." }).status).toBe("completed");
    await committed;
    worker.terminate();

    expect(store.getTask(task.id)).toMatchObject({
      status: "completed",
      projectionToSeq: 1,
      projectionMode: "bootstrap",
    });
  });

  it("does not cancel a terminal return detached while comment editing waits on the workspace lock (PG)", async () => {
    const fixture = createDelegationFixture();
    const worker = new Worker(
      new URL("./fixtures/postgres-comment-edit-worker.ts", import.meta.url).href,
    );
    const ready = waitForWorkerPhase(worker, "ready");
    worker.postMessage({ type: "init", databaseUrl: `${PG_HOST_URL}/${TEST_DB}` });
    await ready;

    const blocker = new Bun.SQL(`${PG_HOST_URL}/${TEST_DB}`, { max: 1 });
    const observer = new Bun.SQL(`${PG_HOST_URL}/${TEST_DB}`, { max: 1 });
    await blocker`BEGIN`;
    await blocker`
      UPDATE multiremi_workspaces
      SET updated_at = updated_at
      WHERE id = ${fixture.workspaceId}
    `;

    const completed = waitForWorkerPhase(worker, "completed");
    worker.postMessage({
      type: "edit",
      commentId: fixture.report.id,
      body: "Intermediate PG report without a mention.",
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [comment] = await observer`
        SELECT body FROM multiremi_issue_comments WHERE id = ${fixture.report.id}
      `;
      if (comment?.body === "Intermediate PG report without a mention.") break;
      await Bun.sleep(10);
    }
    const [edited] = await observer`
      SELECT body FROM multiremi_issue_comments WHERE id = ${fixture.report.id}
    `;
    expect(edited?.body).toBe("Intermediate PG report without a mention.");

    await blocker`
      UPDATE multiremi_tasks
      SET prompt = ${"Terminal PG report."}, trigger_comment_id = NULL, trigger_summary = NULL
      WHERE id = ${fixture.explicitReturn.id}
    `;
    await blocker`COMMIT`;
    await completed;
    worker.terminate();
    await blocker.end();
    await observer.end();

    expect(store.getTask(fixture.explicitReturn.id)).toMatchObject({
      status: "queued",
      triggerCommentId: null,
      prompt: "Terminal PG report.",
    });
  });

  const createRunningSteerTask = () => {
    const workspaceId = freshWorkspace();
    const runtime = store.registerRuntime({ name: `steer-race-runtime-${wsCounter}`, provider: "claude", workspaceId });
    const agent = store.createAgent({ name: `Steer Race ${wsCounter}`, provider: "claude", workspaceId });
    const task = store.createTask({ agentId: agent.id, prompt: "steer race" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    return { workspaceId, task };
  };

  it("steer insert committed by a second connection blocks completion (PG steer barrier)", async () => {
    const { workspaceId, task } = createRunningSteerTask();
    const worker = new Worker(
      new URL("./fixtures/postgres-steer-race-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    const steerId = `steer_pg_race_${wsCounter}`;
    worker.postMessage({
      databaseUrl: `${PG_HOST_URL}/${TEST_DB}`,
      mode: "steer",
      workspaceId,
      taskId: task.id,
      steerId,
      holdMs: 200,
    });

    await locked;
    // completeTask contends on the same workspace lifecycle lock; once the
    // steer transaction commits, its post-lock re-read must see the pending
    // steer and refuse.
    expect(() => store.completeTask(task.id, { output: "old answer" })).toThrow(TaskSteerPendingError);
    await committed;
    worker.terminate();

    expect(store.getTaskStatus(task.id)).toBe("running");
    expect(store.listPendingTaskSteerMessages(task.id).map((m) => m.id)).toEqual([steerId]);

    // Consuming lifts the barrier.
    store.consumeTaskSteerMessages(task.id, [steerId]);
    expect(store.completeTask(task.id, { output: "steered answer" }).status).toBe("completed");
  });

  it("completion committed by a second connection makes steer insert conflict (PG)", async () => {
    const { workspaceId, task } = createRunningSteerTask();
    const worker = new Worker(
      new URL("./fixtures/postgres-steer-race-worker.ts", import.meta.url).href,
    );
    const locked = waitForWorkerPhase(worker, "locked");
    const committed = waitForWorkerPhase(worker, "committed");
    worker.postMessage({
      databaseUrl: `${PG_HOST_URL}/${TEST_DB}`,
      mode: "complete",
      workspaceId,
      taskId: task.id,
      steerId: `steer_pg_unused_${wsCounter}`,
      holdMs: 200,
    });

    await locked;
    expect(() => store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "too late" }))
      .toThrow(TaskSteerConflictError);
    await committed;
    worker.terminate();

    expect(store.getTaskStatus(task.id)).toBe("completed");
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
  });

  it("creates a fresh terminal return when comment editing cancels the explicit return first (PG)", () => {
    const fixture = createDelegationFixture();
    store.updateIssueComment(fixture.report.id, { body: "Intermediate report withdrawn." });
    expect(store.getTask(fixture.explicitReturn.id)?.status).toBe("cancelled");

    store.completeTask(fixture.childTask.id, {
      output: "Final PG QA result after the explicit report was withdrawn.",
    });

    const leaderReturns = store.listTasksForIssue(fixture.issue.id).filter((task) => (
      task.agentId === fixture.leader.id && task.delegationId === fixture.childTask.delegationId
    ));
    expect(leaderReturns).toHaveLength(2);
    const terminalReturn = leaderReturns.find((task) => task.id !== fixture.explicitReturn.id)!;
    expect(terminalReturn.status).toBe("queued");
    expect(terminalReturn.prompt).toContain("Final PG QA result after the explicit report was withdrawn.");
  });
});
