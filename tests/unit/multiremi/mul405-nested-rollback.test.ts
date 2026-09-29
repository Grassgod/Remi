/**
 * MUL-405: the three real nested `transaction()` call sites must roll back as
 * one unit.
 *
 * PostgreSQL has no nested `BEGIN`; a second one is ignored with a warning and
 * the matching `COMMIT` commits the OUTER transaction. The first version of this
 * change therefore turned nested use into a partial commit. The fix makes an
 * inner `transaction()` a SAVEPOINT, and this file pins the acceptance
 * requirement: for each real nesting — Feishu bot ingest, messaging outcomes and
 * Autopilot — a failure raised in the inner transaction (or in a later step of
 * the outer one) must leave every table exactly as it was.
 *
 * Each case runs twice:
 *   - SQLite, always (that is the default backend of the unit suite);
 *   - PostgreSQL, when `MULTIREMI_TEST_POSTGRES_URL` points at a reachable
 *     instance, guarded exactly like the other PG-backed suites.
 *
 * The last case covers the other half of the contract: catching an inner failure
 * must leave the outer transaction usable, so the caller can still commit.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { resolveSqlDialect } from "@multiremi/store/migrations.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul405_rollback_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
});

/** Every table these cases can write, so "no partial commit" is checkable. */
const TRACKED_TABLES = [
  "multiremi_issues",
  "multiremi_tasks",
  "multiremi_issue_sessions",
  "multiremi_chat_sessions",
  "multiremi_chat_messages",
  "multiremi_feishu_bot_chat_bindings",
  "multiremi_feishu_bot_deliveries",
  "multiremi_feishu_bot_senders",
  "multiremi_message_outcomes",
  "multiremi_autopilot_runs",
  "multiremi_autopilots",
  "multiremi_pinned_items",
] as const;

function snapshot(db: SqlDatabase): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of TRACKED_TABLES) {
    const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | string } | null;
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}

type Backend = {
  name: string;
  makeStore: () => MultiremiStore;
  db: () => SqlDatabase;
  cleanup: () => Promise<void> | void;
};

function sqliteBackend(): Backend {
  let handle: Database | null = null;
  let opened: Database | null = null;
  return {
    name: "sqlite",
    makeStore() {
      handle = openSqliteDatabase(":memory:");
      opened = handle;
      expect((handle as SqlDatabase).dialect).toBe("sqlite");
      expect(resolveSqlDialect(handle as SqlDatabase)).toBe("sqlite");
      return new MultiremiStore(handle as unknown as SqlDatabase);
    },
    db: () => handle as unknown as SqlDatabase,
    cleanup: () => {
      opened?.close();
      handle = null;
      opened = null;
    },
  };
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

const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(
    `[mul405-nested-rollback] Postgres not reachable at ${PG_ADMIN_URL} — running the SQLite cases only.`,
  );
}

// ────────────────────────────── shared fixtures ──────────────────────────────

/** A workspace with an agent + runtime, plus a Feishu bot in group-topic mode. */
function feishuFixture(store: MultiremiStore, workspaceId: string): {
  revision: number;
  agentId: string;
  runtimeId: string;
} {
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId });
  const runtimeId = `rt_rollback_${Math.floor(Math.random() * 1e6)}`;
  store.registerRuntime({ id: runtimeId, name: "Bot host", provider: "codex", workspaceId, daemonId: `${runtimeId}-host` });
  store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig(workspaceId, {
    agentId: agent.id,
    runtimeId,
    appId: `cli_rollback_${Math.floor(Math.random() * 1e6)}`,
    senderAccessPolicy: "agent",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  store.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, {
    appliedRevision: config.revision, state: "online",
  });
  const workspace = store.getWorkspace(workspaceId)!;
  store.updateWorkspace(workspaceId, {
    settings: { ...workspace.settings, issueTopics: { enabled: true, chatId: "oc_rollback" } },
  });
  store.replaceFeishuBotAgentRoutes(workspaceId, [
    { scope: "chat", chatId: "oc_rollback", agentId: agent.id },
  ]);
  return { revision: config.revision, agentId: agent.id, runtimeId };
}

interface Wrapped {
  /** Attach the injection to a store's database. */
  install: (store: MultiremiStore) => void;
  /** Raise from the first inner `transaction()` call. */
  failInnerTransaction: () => void;
  /** Raise from the first statement whose SQL matches the pattern. */
  failStatement: (pattern: RegExp) => void;
  disarm: () => void;
  innerCalls: () => number;
}

/**
 * Inject failures at the two places the acceptance requirement names: the inner
 * `transaction()` call itself, or a later statement inside the outer one.
 *
 * The wrapper replaces `db.transaction` / `db.run` on the store's database. That
 * database is the store's own handle — the real call sites reach it through the
 * exact same method — so an injection here exercises the production nesting
 * rather than a re-implementation of it.
 */
/** The store's private context, for the two calls a caller-owned drain needs. */
function storeContext(store: MultiremiStore): {
  emitCommitEvents: (queue: ReturnType<typeof createCommitEventQueue>) => void;
} {
  return (store as unknown as {
    ctx: { emitCommitEvents: (queue: ReturnType<typeof createCommitEventQueue>) => void };
  }).ctx;
}

function injectFailures(): Wrapped {
  let failInner = false;
  let failPattern: RegExp | null = null;
  let depth = 0;
  let innerCalls = 0;
  return {
    install(store: MultiremiStore) {
      const db = (store as unknown as { db: SqlDatabase }).db;
      const originalTransaction = db.transaction.bind(db);
      const originalRun = db.run.bind(db);
      (db as { transaction: SqlDatabase["transaction"] }).transaction = (<T>(fn: (...args: any[]) => T) => {
        const wrapped = (...args: any[]): T => {
          if (failInner && depth > 0) {
            innerCalls += 1;
            throw new Error("injected inner failure");
          }
          depth += 1;
          try {
            return fn(...args);
          } finally {
            depth -= 1;
          }
        };
        return originalTransaction(wrapped as never);
      }) as SqlDatabase["transaction"];
      // MUL-406 turned the nested call inside a caller-owned transaction into a
      // direct \`createIssueWithinTransaction\` (no second \`db.transaction\`), so
      // counting nesting depth alone no longer sees it. Both entry points are
      // wrapped: the transaction counter covers a self-owned inner transaction
      // and this covers the "caller already owns the transaction" form.
      const issues = (store as unknown as {
        issues: { createIssueWithinTransaction: (...args: any[]) => unknown };
      }).issues;
      const originalCreateWithin = issues.createIssueWithinTransaction.bind(issues);
      issues.createIssueWithinTransaction = (...args: any[]) => {
        if (failInner) {
          innerCalls += 1;
          throw new Error("injected inner failure");
        }
        return originalCreateWithin(...args);
      };
      (db as { run: SqlDatabase["run"] }).run = ((sql: string, ...params: unknown[]) => {
        if (failPattern && failPattern.test(sql)) {
          failPattern = null;
          throw new Error("injected statement failure");
        }
        return originalRun(sql, ...params);
      }) as SqlDatabase["run"];
    },
    failInnerTransaction: () => { failInner = true; },
    failStatement: (pattern: RegExp) => { failPattern = pattern; },
    disarm: () => { failInner = false; failPattern = null; },
    innerCalls: () => innerCalls,
  };
}

/** Seed one ingested message so `messagingOutcomes` has something to act on. */
function seedMessaging(
  store: MultiremiStore,
  workspaceId: string,
  ref: { connectionId: string; externalMessageId: string },
): void {
  store.messaging.upsertConnection({
    id: ref.connectionId, workspaceId, provider: "test_provider", channel: "test_channel",
    name: "Rollback connection", status: "ready",
  });
  // One source per connection: a Source cannot be rebound to another
  // connection, and the PostgreSQL suite reuses one database across cases.
  const sourceId = `msrc_${ref.connectionId}`;
  store.messaging.upsertSource({
    id: sourceId, workspaceId, connectionId: ref.connectionId, name: "Rollback source",
    allowlist: [{ externalConversationId: "conversation_rollback", addedAt: "2026-09-01T00:00:00.000Z" }],
  });
  store.messaging.ingestMessages({
    connectionId: ref.connectionId,
    sourceId,
    messages: [{
      externalMessageId: ref.externalMessageId,
      externalConversationId: "conversation_rollback",
      conversationName: "Rollback chat",
      conversationKind: "group",
      externalThreadId: null,
      externalRootId: null,
      externalParentId: null,
      sender: { externalSenderId: "sender_rollback", displayName: "Sender", kind: "user", isSelf: false },
      text: "the API is down again",
      attachments: [],
      mentions: [],
      reactions: [],
      url: "https://example.invalid/m/external_rollback",
      sentAt: "2026-09-01T10:00:00.000Z",
      editedAt: null,
      recalled: false,
      raw: {},
    } satisfies CanonicalMessage],
  });
}

// ────────────────────────────── the three call sites ──────────────────────────────

describe("MUL-405 nested transaction rollback", () => {
  const backends: Backend[] = [sqliteBackend()];

  let pgDb: PostgresSyncDatabase | null = null;
  if (pgAvailable) {
    backends.push({
      name: "postgres",
      makeStore() {
        const url = new URL(PG_ADMIN_URL);
        url.pathname = `/${TEST_DB}`;
        pgDb = new PostgresSyncDatabase(url.toString());
        expect(resolveSqlDialect(pgDb)).toBe("postgres");
        return new MultiremiStore(pgDb);
      },
      db: () => pgDb as unknown as SqlDatabase,
      cleanup: () => {
        pgDb?.close();
        pgDb = null;
      },
    });
  }

  beforeAll(async () => {
    if (!pgAvailable) return;
    // One throwaway database for the whole file; every case uses its own
    // workspace so the SQLite and PostgreSQL runs assert the same shape.
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    pgDb?.close();
    pgDb = null;
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  afterEach(() => {
    for (const backend of backends) backend.cleanup();
  });

  for (const backend of backends) {
    describe(backend.name, () => {
      it("Feishu bot: an inner failure rolls back the whole ingest", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Feishu rollback", slug: `feishu-rollback-${backend.name}` }).id;
        const { revision, runtimeId } = feishuFixture(store, workspaceId);
        const input = {
          revision,
          externalSessionKey: "oc_rollback:thread:omt_rollback",
          externalMessageId: "om_rollback_1",
          chatType: "group" as const,
          chatId: "oc_rollback",
          threadId: "omt_rollback",
          senderOpenId: "ou_rollback",
          text: "Create the group Issue",
        };
        const before = snapshot(backend.db());
        const injection = injectFailures();
        injection.install(store);

        injection.failInnerTransaction();
        expect(() => store.submitFeishuBotMessage(workspaceId, runtimeId, input))
          .toThrow("injected inner failure");
        injection.disarm();
        // The injected failure must have fired on the real nested call
        // (`IssuesRepo.createIssue`), not before the outer transaction did anything.
        expect(injection.innerCalls()).toBeGreaterThan(0);
        expect(snapshot(backend.db())).toEqual(before);

        // And without the injection the same call commits normally, which proves
        // the case above failed for the injected reason rather than a fixture.
        const committed = store.submitFeishuBotMessage(workspaceId, runtimeId, { ...input, externalMessageId: "om_rollback_2" });
        expect(store.getFeishuIssueIdForChatSession(committed.chatSessionId)).not.toBeNull();
      });

      it("Feishu bot: a failure after the inner Issue still rolls everything back", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Feishu late", slug: `feishu-late-${backend.name}` }).id;
        const { revision, runtimeId } = feishuFixture(store, workspaceId);
        const before = snapshot(backend.db());
        const injection = injectFailures();
        injection.install(store);

        // Raised after the auto-created Issue and Chat session exist: the
        // delivery row is the last write of the outer transaction.
        injection.failStatement(/INSERT INTO multiremi_feishu_bot_deliveries/i);
        expect(() => store.submitFeishuBotMessage(workspaceId, runtimeId, {
          revision,
          externalSessionKey: "oc_rollback:thread:omt_late",
          externalMessageId: "om_rollback_late",
          chatType: "group",
          chatId: "oc_rollback",
          threadId: "omt_late",
          senderOpenId: "ou_rollback",
          text: "Create then fail",
        })).toThrow("injected statement failure");
        injection.disarm();
        expect(snapshot(backend.db())).toEqual(before);
      });

      it("messaging outcomes: an inner failure rolls back the Issue and outcome", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Outcomes", slug: `outcomes-${backend.name}` }).id;
        const ref = { connectionId: "mconn_rollback", externalMessageId: "external_rollback" };
        seedMessaging(store, workspaceId, ref);
        const before = snapshot(backend.db());
        const injection = injectFailures();
        injection.install(store);

        injection.failInnerTransaction();
        expect(() => store.messagingOutcomes.createIssue(ref, { workspaceId, title: "Rolled back Issue" }))
          .toThrow("injected inner failure");
        injection.disarm();
        expect(injection.innerCalls()).toBeGreaterThan(0);
        expect(snapshot(backend.db())).toEqual(before);
        // The message stays unprocessed, so a retry is still possible.
        expect(store.messaging.getMessage(ref.connectionId, ref.externalMessageId)?.processedAt).toBeNull();

        const retried = store.messagingOutcomes.createIssue(ref, { workspaceId, title: "Committed on retry" });
        expect(retried.created).toBe(true);
      });

      it("messaging outcomes: a successful Issue is rolled back when a later outer step fails", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Outcomes late", slug: `outcomes-late-${backend.name}` }).id;
        const ref = { connectionId: "mconn_rollback_late", externalMessageId: "external_rollback_late" };
        seedMessaging(store, workspaceId, ref);
        const before = snapshot(backend.db());
        const db = backend.db();

        // QA round 2: the other direction of the messaging rollback contract.
        // The inner createIssue SUCCEEDS — Issue, outcome and the message's
        // processed_at all land — and then the outer transaction fails. Nothing
        // may survive: no Issue, no outcome, and no message state change.
        expect(() => db.transaction(() => {
          store.messagingOutcomes.createIssue(ref, { workspaceId, title: "Committed then rolled back" });
          expect(store.messaging.getMessage(ref.connectionId, ref.externalMessageId)?.processedAt).not.toBeNull();
          throw new Error("injected outer failure");
        })()).toThrow("injected outer failure");

        expect(snapshot(backend.db())).toEqual(before);
        expect(store.messaging.getMessage(ref.connectionId, ref.externalMessageId)?.processedAt).toBeNull();
        expect(store.messaging.listOutcomes(ref.connectionId, ref.externalMessageId)).toHaveLength(0);

        // The rollback left the message retryable.
        const retried = store.messagingOutcomes.createIssue(ref, { workspaceId, title: "Retried after outer failure" });
        expect(retried.created).toBe(true);
      });

      it("Autopilot: an inner failure rolls back the run, Issue, Session and Task", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Autopilot", slug: `autopilot-${backend.name}` }).id;
        const agent = store.createAgent({ name: "Automation", provider: "codex", workspaceId });
        const autopilot = store.createAutopilot({
          title: "Rollback automation", assigneeId: agent.id, workspaceId,
          executionMode: "create_issue", status: "active",
        });
        const before = snapshot(backend.db());
        const injection = injectFailures();
        injection.install(store);

        // `runAutopilot`'s own transaction is the outer one; the inner failure
        // lands on `IssuesRepo.createIssue`.
        injection.failInnerTransaction();
        expect(() => store.runAutopilot(autopilot.id)).toThrow("injected inner failure");
        injection.disarm();
        expect(injection.innerCalls()).toBeGreaterThan(0);
        expect(snapshot(backend.db())).toEqual(before);
        expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(0);

        // The run row is created before the Issue, so this is exactly the
        // partial commit the SAVEPOINT fix prevents: without it the run would
        // survive as `running` with no Issue and no Task.
        const committed = store.runAutopilot(autopilot.id);
        expect(committed.issueId).not.toBeNull();
        expect(committed.taskId).not.toBeNull();
      });

      it("Autopilot: a failure after the Task still rolls back the run", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Autopilot late", slug: `autopilot-late-${backend.name}` }).id;
        const agent = store.createAgent({ name: "Automation", provider: "codex", workspaceId });
        const autopilot = store.createAutopilot({
          title: "Late failure automation", assigneeId: agent.id, workspaceId,
          executionMode: "create_issue", status: "active",
        });
        const before = snapshot(backend.db());
        const injection = injectFailures();
        injection.install(store);

        // The final write of the outer transaction, after the Issue, Session and
        // Task all exist.
        injection.failStatement(/UPDATE multiremi_autopilot_runs\s+SET issue_id = \?, task_id = \?/i);
        expect(() => store.runAutopilot(autopilot.id)).toThrow("injected statement failure");
        injection.disarm();
        expect(snapshot(backend.db())).toEqual(before);
        expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(0);
      });

      it("nested createIssue publishes nothing before the outermost commit", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Nested commit", slug: `nested-commit-${backend.name}` }).id;
        // The store's own handle, not the raw one: that is where the after-commit
        // queue lives, and a caller-owned outer transaction runs through it.
        const db = (store as unknown as { db: SqlDatabase }).db;

        const seen: string[] = [];
        const unsubscribe = store.onWorkspaceEvent((event) => {
          if (event.type === "activity:created"
            && (event.payload.entry as { action?: string } | undefined)?.action === "issue_created") {
            seen.push(String((event.payload.entry as { action?: string }).action));
          }
        });

        try {
          // Outer transaction -> createIssue (a nested transaction) -> still
          // inside the outer one. MUL-409 makes the caller the owner of the
          // commit-event queue, and MUL-405 hangs that owner's drain on the
          // OUTERMOST commit, so the activity push must not have happened yet:
          // on Postgres the inner call only released a SAVEPOINT.
          const owner = { childStatusChanges: [], deferredEvents: createCommitEventQueue() };
          db.transaction(() => {
            store.createIssue({ title: "Nested before commit", workspaceId }, owner);
            expect(seen).toHaveLength(0);
          })();
          // The owner of the transaction is the owner of the queue (MUL-409),
          // and MUL-405 hangs that drain on the outermost commit. Drain it the
          // way a caller does — through the context — and only now.
          storeContext(store).emitCommitEvents(owner.deferredEvents);
        } finally {
          unsubscribe();
        }

        // Committed: exactly one push, and only now.
        expect(seen).toHaveLength(1);
      });

      it("nested createIssue publishes nothing when the outer transaction rolls back", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Nested rollback", slug: `nested-rollback-${backend.name}` }).id;
        const db = (store as unknown as { db: SqlDatabase }).db;
        const before = snapshot(backend.db());

        const seen: string[] = [];
        const unsubscribe = store.onWorkspaceEvent((event) => {
          if (event.type === "activity:created"
            && (event.payload.entry as { action?: string } | undefined)?.action === "issue_created") {
            seen.push(String((event.payload.entry as { action?: string }).action));
          }
        });

        expect(() => db.transaction(() => {
          store.createIssue({ title: "Nested then rollback", workspaceId }, {
            childStatusChanges: [], deferredEvents: createCommitEventQueue(),
          });
          expect(seen).toHaveLength(0);
          throw new Error("outer rollback");
        })()).toThrow("outer rollback");

        unsubscribe();
        // Nothing was published, and the row is gone with the rollback.
        expect(seen).toHaveLength(0);
        expect(snapshot(backend.db())).toEqual(before);
      });

      it("captured inner failure leaves the outer transaction usable", () => {
        const store = backend.makeStore();
        const workspaceId = store.createWorkspace({ name: "Recover", slug: `recover-${backend.name}` }).id;
        const agent = store.createAgent({ name: "Automation", provider: "codex", workspaceId });
        const autopilot = store.createAutopilot({
          title: "Recoverable automation", assigneeId: agent.id, workspaceId,
          executionMode: "create_issue", status: "active",
        });
        const before = snapshot(backend.db());
        const db = backend.db();

        // A caller-owned outer transaction catches the inner failure and then
        // commits work of its own: PostgreSQL must keep the outer transaction
        // usable rather than discarding it as aborted.
        const result = db.transaction(() => {
          const injection = injectFailures();
          injection.install(store);
          let innerFailed = false;
          try {
            injection.failInnerTransaction();
            store.runAutopilot(autopilot.id);
          } catch (error) {
            innerFailed = true;
            expect(String((error as Error).message)).toContain("injected inner failure");
          }
          injection.disarm();
          expect(innerFailed).toBe(true);
          return store.createIssue({ title: "Committed after inner failure", workspaceId }, {
            childStatusChanges: [], deferredEvents: createCommitEventQueue(),
          });
        })();

        expect(result.title).toBe("Committed after inner failure");
        const after = snapshot(backend.db());
        expect(after.multiremi_issues).toBe(before.multiremi_issues + 1);
        expect(after.multiremi_autopilot_runs).toBe(before.multiremi_autopilot_runs);
        expect(after.multiremi_tasks).toBe(before.multiremi_tasks);
        expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(0);
      });
    });
  }
});
