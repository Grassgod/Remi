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
import { PostgresSyncDatabase, translateSqliteToPg } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

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

  // Each test provisions its own workspace so shared state (issue numbering,
  // list results) stays isolated without per-test databases.
  let wsCounter = 0;
  const freshWorkspace = (): string => {
    wsCounter += 1;
    const slug = `pgtest-${process.pid}-${wsCounter}`;
    return store.createWorkspace({ name: `PG Test ${wsCounter}`, slug }).id;
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
      "multiremi_workspace_members",
      "multiremi_access_tokens",
      "multiremi_users",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("creates and lists projects scoped to a workspace", () => {
    const ws = freshWorkspace();
    const a = store.createProject({ title: "Alpha", workspaceId: ws });
    const b = store.createProject({ title: "Beta", workspaceId: ws });
    const ids = store.listProjects(ws).map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(store.getProject(a.id)?.title).toBe("Alpha");
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
    const project = store.createProject({
      title: "With resources",
      workspaceId: ws,
      resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/owner/repo" } }],
    });
    expect(store.getProject(project.id)?.title).toBe("With resources");
    expect(store.listProjectResources(project.id).length).toBe(1);
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
});
