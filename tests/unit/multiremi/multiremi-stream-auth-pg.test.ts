/**
 * MUL-438 strict verification: the browser stream's subscription checks against a
 * real PostgreSQL database, through C4's read-only pool.
 *
 * The unit suite next door runs the SQLite arm. This file exists for the two
 * things that arm cannot show:
 *
 * 1. **The SQL is real.** `LOG_STREAM_FACTS_SQL` / `TRACE_STREAM_FACTS_SQL` are
 *    sqlite dialect and reach Postgres through the pool's translation; a typo, a
 *    missing column or a translation the regexes do not cover would only surface
 *    here. The store's own `multiremi_*` schema is created by running the real
 *    migrations against the throwaway database.
 * 2. **The read-only pool answers it.** The check runs on the pool the plan
 *    reserves for new server read paths (MUL-383 `cmt_u3fltd47w6r0`), not on the
 *    synchronous bridge, and the pool's own gate must accept the statement —
 *    `findDisallowedFunction` refusing this SQL would be a production-only
 *    failure of every subscription.
 *
 * Skipped, with a warning, when no Postgres is reachable — the same convention
 * `multiremi-postgres-store.test.ts` and `read-pool.test.ts` use.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, translateSqliteToPg } from "@multiremi/store/db/postgres.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import {
  SqliteReadPool,
  createReadPool,
  findDisallowedFunction,
  isReadOnlySelect,
} from "@multiremi/store/db/read-pool.js";
import type { ReadPool } from "@multiremi/store/db/read-pool.js";
import {
  LOG_STREAM_FACTS_SQL,
  TRACE_STREAM_FACTS_SQL,
  createPostgresStreamAuthReader,
  decideLogSubscription,
  decideTraceSubscription,
  logFactsFromRow,
  traceFactsFromRow,
} from "@multiremi/api/hub/stream-auth.js";


const PG_ADMIN_URL =
  process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multiremi:local-only@localhost:5432/postgres";
const TEST_DB = `multiremi_mul438_stream_auth_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

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

/**
 * Where the test database is, in a form that is safe to log: a skip message is
 * the last place a DSN password should appear.
 */
function describeTestDatabaseTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//u, "");
    const host = parsed.host || "unknown-host";
    return database ? `${host}/${database}` : host;
  } catch {
    return "an unparseable MULTIREMI_TEST_POSTGRES_URL";
  }
}

const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(
    `[mul438-stream-auth] Postgres not reachable at ${describeTestDatabaseTarget(PG_ADMIN_URL)} — skipping the pool-backed subscription checks.`,
  );
}

describe("MUL-438 stream auth SQL passes the read pool's own gate", () => {
  // These three run everywhere: the gate and the translator are pure, and the
  // parameter count is the one mistake that would only show up against a real
  // database as a "bind message supplies 2 parameters" error.
  it("accepts the log facts statement and rejects nothing in it", () => {
    expect(isReadOnlySelect(LOG_STREAM_FACTS_SQL)).toBe(true);
    expect(findDisallowedFunction(LOG_STREAM_FACTS_SQL)).toBeNull();
  });

  it("accepts the trace facts statement and rejects nothing in it", () => {
    expect(isReadOnlySelect(TRACE_STREAM_FACTS_SQL)).toBe(true);
    expect(findDisallowedFunction(TRACE_STREAM_FACTS_SQL)).toBeNull();
  });

  it("translates to the number of positional parameters the reader binds", () => {
    const logSql = translateSqliteToPg(LOG_STREAM_FACTS_SQL);
    const traceSql = translateSqliteToPg(TRACE_STREAM_FACTS_SQL);
    // `?` becomes `$n`; the reader binds four values for the log statement
    // (userId/sessionId per arm) and two for the trace one (is_admin userId, id).
    expect(logSql).toContain("$4");
    expect(logSql).not.toContain("$5");
    expect(traceSql).toContain("$2");
    expect(traceSql).not.toContain("$3");
    expect(LOG_STREAM_FACTS_SQL.match(/\?/g)).toHaveLength(4);
    expect(TRACE_STREAM_FACTS_SQL.match(/\?/g)).toHaveLength(2);
  });
});

/**
 * The statements themselves, executed for real.
 *
 * The Postgres block below needs a server; these cases do not. They run the same
 * SQL text through {@link SqliteReadPool} against a database seeded by the real
 * store, which is what proves the *statement* — table and column names, the
 * `UNION ALL` arms, the joins, the subqueries — rather than only the decision
 * function. The pool's gate and translator then cover what changes on Postgres.
 */
describe("MUL-438 stream auth SQL, executed through the read pool", () => {
  it("projects the log and trace facts the decision functions read", async () => {
    const db = openSqliteDatabase(":memory:");
    const store = new MultiremiStore(db as unknown as SqlDatabase);
    store.ensureLocalWorkspace();
    const workspaceId = store.ensureLocalWorkspace().id;
    store.createWorkspaceMember({ workspaceId, userId: "creator", name: "Creator", role: "owner" });
    store.createWorkspaceMember({ workspaceId, userId: "member", name: "Member", role: "member" });
    store.createWorkspaceMember({ workspaceId, userId: "admin", name: "Admin", role: "admin" });
    const agent = store.createAgent({ workspaceId, name: "Public", provider: "codex", visibility: "workspace" });
    const privateAgent = store.createAgent({
      workspaceId, name: "Private", provider: "codex", visibility: "private", ownerId: "creator",
    });
    const issue = store.createIssue({ workspaceId, title: "SQL issue" });
    const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
    const chat = store.createChatSession({ agentId: agent.id, workspaceId, creatorId: "creator", title: "SQL chat" });
    const chatTask = store.createTask({ agentId: agent.id, workspaceId, prompt: "chat", chatSessionId: chat.id });
    const privateTask = store.createTask({ agentId: privateAgent.id, workspaceId, prompt: "private", issueId: issue.id });
    const pool = new SqliteReadPool(db as unknown as SqlDatabase);

    try {
      // log: an issue session reports its workspace and the caller's membership
      const issueRow = await pool.queryOne<any>(LOG_STREAM_FACTS_SQL, ["member", session.id, "member", session.id]);
      expect(logFactsFromRow(issueRow)).toEqual({
        kind: "issue",
        workspaceId,
        creatorId: null,
        requesterIsMember: true,
      });
      const strangerRow = await pool.queryOne<any>(LOG_STREAM_FACTS_SQL, ["stranger", session.id, "stranger", session.id]);
      expect(logFactsFromRow(strangerRow)?.requesterIsMember).toBe(false);

      // log: a chat session is its creator's, and membership is irrelevant
      const chatRow = await pool.queryOne<any>(LOG_STREAM_FACTS_SQL, ["member", chat.id, "member", chat.id]);
      expect(logFactsFromRow(chatRow)).toEqual({
        kind: "chat",
        workspaceId,
        creatorId: "creator",
        requesterIsMember: true,
      });
      expect(decideLogSubscription({ userId: "member", workspaceId }, logFactsFromRow(chatRow)))
        .toEqual({ ok: false, code: "forbidden" });

      // log: an unknown id selects nothing at all
      const missing = await pool.queryOne<any>(LOG_STREAM_FACTS_SQL, ["member", "ises_missing", "member", "ises_missing"]);
      expect(logFactsFromRow(missing)).toBeNull();

      // trace: a chat task carries its session's creator. `creator` owns this
      // workspace, so the same row also answers the admin question truthfully.
      const chatTrace = await pool.queryOne<any>(TRACE_STREAM_FACTS_SQL, ["creator", chatTask.id]);
      expect(traceFactsFromRow(chatTrace)).toMatchObject({
        workspaceId,
        chatSessionId: chat.id,
        chatCreatorId: "creator",
        agentId: agent.id,
        agentVisibility: "workspace",
        requesterIsWorkspaceAdmin: true,
      });

      // …and a plain member reads the same task with the admin flag false.
      const chatTraceAsMember = await pool.queryOne<any>(TRACE_STREAM_FACTS_SQL, ["member", chatTask.id]);
      expect(traceFactsFromRow(chatTraceAsMember)).toMatchObject({
        chatCreatorId: "creator",
        requesterIsWorkspaceAdmin: false,
      });
      expect(decideTraceSubscription({ userId: "member", workspaceId }, traceFactsFromRow(chatTraceAsMember)))
        .toEqual({ ok: false, code: "forbidden" });

      // trace: a private agent's task carries the privacy rule, and the admin
      // flag is answered in the same row.
      const privateByMember = await pool.queryOne<any>(TRACE_STREAM_FACTS_SQL, ["member", privateTask.id]);
      expect(traceFactsFromRow(privateByMember)).toMatchObject({
        agentVisibility: "private",
        agentOwnerId: "creator",
        requesterIsWorkspaceAdmin: false,
      });
      const privateByAdmin = await pool.queryOne<any>(TRACE_STREAM_FACTS_SQL, ["admin", privateTask.id]);
      expect(traceFactsFromRow(privateByAdmin)?.requesterIsWorkspaceAdmin).toBe(true);
      expect(decideTraceSubscription({ userId: "admin", workspaceId }, traceFactsFromRow(privateByAdmin)))
        .toEqual({ ok: true });
    } finally {
      await pool.close();
      db.close();
    }
  });
});

describe.skipIf(!pgAvailable)("MUL-438 stream auth on Postgres (integration)", () => {
  let store: MultiremiStore;
  let pool: ReadPool;
  let db: PostgresSyncDatabase;

  const workspaceId = "ws_stream_auth";
  const otherWorkspaceId = "ws_stream_auth_other";

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    pool = createReadPool({ databaseUrl: pgDatabaseUrl(TEST_DB) });

    store.createWorkspace({ id: workspaceId, name: "Stream auth", slug: "stream-auth" });
    store.createWorkspace({ id: otherWorkspaceId, name: "Other", slug: "stream-auth-other" });
    store.createWorkspaceMember({ workspaceId, userId: "creator", name: "Creator", role: "owner" });
    store.createWorkspaceMember({ workspaceId, userId: "member", name: "Member", role: "member" });
    store.createWorkspaceMember({ workspaceId, userId: "admin", name: "Admin", role: "admin" });
    const agent = store.createAgent({ workspaceId, name: "Public agent", provider: "codex", visibility: "workspace" });
    const privateAgent = store.createAgent({
      workspaceId,
      name: "Private agent",
      provider: "codex",
      visibility: "private",
      ownerId: "creator",
    });
    const issue = store.createIssue({ workspaceId, title: "Streamed" });
    const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
    const chat = store.createChatSession({ agentId: agent.id, workspaceId, creatorId: "creator", title: "Chat" });
    const task = store.createTask({ agentId: agent.id, workspaceId, prompt: "issue task", issueId: issue.id });
    const chatTask = store.createTask({ agentId: agent.id, workspaceId, prompt: "chat task", chatSessionId: chat.id });
    const privateTask = store.createTask({ agentId: privateAgent.id, workspaceId, prompt: "private task", issueId: issue.id });

    (globalThis as Record<string, unknown>).__mul438 = {
      issueSessionId: session.id,
      chatSessionId: chat.id,
      taskId: task.id,
      chatTaskId: chatTask.id,
      privateTaskId: privateTask.id,
    };
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
    db?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  function refs(): Record<string, string> {
    return (globalThis as Record<string, any>).__mul438;
  }

  it("answers a log subscription from one pool statement", async () => {
    const auth = createPostgresStreamAuthReader(pool);
    const sessionId = refs().issueSessionId!;

    const member = await auth.logFacts(sessionId, { userId: "member", workspaceId });
    expect(member.ok).toBe(true);
    if (!member.ok) return;
    expect(member.facts).toMatchObject({ kind: "issue", workspaceId, requesterIsMember: true });
    expect(decideLogSubscription({ userId: "member", workspaceId }, member.facts)).toEqual({ ok: true });

    const outsider = await auth.logFacts(sessionId, { userId: "stranger", workspaceId });
    expect(outsider.ok).toBe(true);
    if (!outsider.ok) return;
    expect(outsider.facts).toMatchObject({ requesterIsMember: false });
    expect(decideLogSubscription({ userId: "stranger", workspaceId }, outsider.facts))
      .toEqual({ ok: false, code: "forbidden" });
  });

  it("resolves a chat session's creator from the database", async () => {
    const auth = createPostgresStreamAuthReader(pool);
    const chatSessionId = refs().chatSessionId!;

    const creator = await auth.logFacts(chatSessionId, { userId: "creator", workspaceId });
    expect(creator.ok).toBe(true);
    if (!creator.ok) return;
    expect(creator.facts).toMatchObject({ kind: "chat", creatorId: "creator" });
    expect(decideLogSubscription({ userId: "creator", workspaceId }, creator.facts)).toEqual({ ok: true });

    const peer = await auth.logFacts(chatSessionId, { userId: "member", workspaceId });
    if (!peer.ok) throw new Error("unexpected unavailable");
    expect(decideLogSubscription({ userId: "member", workspaceId }, peer.facts))
      .toEqual({ ok: false, code: "forbidden" });
  });

  it("reports an unknown session as absent rather than inventing facts", async () => {
    const auth = createPostgresStreamAuthReader(pool);
    const missing = await auth.logFacts("ises_not_here", { userId: "creator", workspaceId });
    expect(missing).toEqual({ ok: true, facts: null });
    expect(decideLogSubscription({ userId: "creator", workspaceId }, null))
      .toEqual({ ok: false, code: "forbidden" });
  });

  it("reads chat-creator and agent-privacy facts for a trace subscription", async () => {
    const auth = createPostgresStreamAuthReader(pool);

    const chatTask = await auth.traceFacts(refs().chatTaskId!, { userId: "creator", workspaceId });
    if (!chatTask.ok) throw new Error("unexpected unavailable");
    expect(chatTask.facts).toMatchObject({ chatSessionId: refs().chatSessionId, chatCreatorId: "creator" });
    expect(decideTraceSubscription({ userId: "creator", workspaceId }, chatTask.facts)).toEqual({ ok: true });
    expect(decideTraceSubscription({ userId: "member", workspaceId }, chatTask.facts))
      .toEqual({ ok: false, code: "forbidden" });

    const privateTask = await auth.traceFacts(refs().privateTaskId!, { userId: "member", workspaceId });
    if (!privateTask.ok) throw new Error("unexpected unavailable");
    expect(privateTask.facts).toMatchObject({
      agentVisibility: "private",
      agentOwnerId: "creator",
      requesterIsWorkspaceAdmin: false,
    });
    expect(decideTraceSubscription({ userId: "member", workspaceId }, privateTask.facts))
      .toEqual({ ok: false, code: "forbidden" });

    const asAdmin = await auth.traceFacts(refs().privateTaskId!, { userId: "admin", workspaceId });
    if (!asAdmin.ok) throw new Error("unexpected unavailable");
    expect(asAdmin.facts).toMatchObject({ requesterIsWorkspaceAdmin: true });
    expect(decideTraceSubscription({ userId: "admin", workspaceId }, asAdmin.facts)).toEqual({ ok: true });
  });

  it("refuses a stream from another workspace before the rule is even consulted", async () => {
    const auth = createPostgresStreamAuthReader(pool);
    const facts = await auth.logFacts(refs().issueSessionId!, { userId: "creator", workspaceId: otherWorkspaceId });
    if (!facts.ok) throw new Error("unexpected unavailable");
    // The session belongs to `workspaceId`, so the socket bound elsewhere is refused
    // even though its user is a member of the session's workspace.
    expect(decideLogSubscription({ userId: "creator", workspaceId: otherWorkspaceId }, facts.facts))
      .toEqual({ ok: false, code: "forbidden" });
  });

  it("uses exactly one statement per subscription", async () => {
    const calls: string[] = [];
    const counting: ReadPool = {
      postgres: pool.postgres,
      async query(sql, params, options) {
        calls.push(sql);
        return pool.query(sql, params, options);
      },
      async queryOne(sql, params, options) {
        calls.push(sql);
        return pool.queryOne(sql, params, options);
      },
      close: () => pool.close(),
    };
    const auth = createPostgresStreamAuthReader(counting);

    await auth.logFacts(refs().issueSessionId!, { userId: "member", workspaceId });
    await auth.traceFacts(refs().taskId!, { userId: "member", workspaceId });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(LOG_STREAM_FACTS_SQL);
    expect(calls[1]).toBe(TRACE_STREAM_FACTS_SQL);
  });
});
