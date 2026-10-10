import { randomUUID } from "node:crypto";
import { MultiremiStore } from "@multiremi/store/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { activeRequestReadCache } from "@multiremi/store/request-read-cache.js";
import { readConnectionPragma } from "./sqlite-store-snapshot.js";
import type { StoreContext } from "@multiremi/store/context.js";

import type { NotificationSenderRegistry } from "../../packages/server/src/notifications/outbound-dispatcher.js";

/** Test-only: track original sends, not the dispatcher timeout race. */
function trackNotificationSenders(registry: NotificationSenderRegistry, pending: Set<Promise<unknown>>): NotificationSenderRegistry {
  for (const sender of new Set(Object.values(registry))) {
    if (!sender) continue;
    const original = sender.send;
    Object.defineProperty(sender, "send", { configurable: false, writable: false, value: function (this: typeof sender, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      const settlement = Promise.resolve(result);
      pending.add(settlement);
      void settlement.then(() => pending.delete(settlement), () => pending.delete(settlement));
      return result;
    } });
  }
  return Object.freeze(registry);
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Explicitly opted-in synchronous suites and placement cells, no schema changes, request cache,
 * subscriptions, mocks or background workers. Migration/cold-start tests must use a
 * fresh Store instead. Reset commits before a cell runs; claims keep their real
 * transaction/afterCommit behavior. Baseline rows stay in native temporary tables,
 * so SQL types, NULL and bytes never make a JSON round trip.
 */
export function createReusableStoreDatabase(dialect: "sqlite" | "postgres", postgresUrl: string | undefined, options: {
  fixture: string;
  label: string;
  strictStoreState?: boolean;
  /** Initial fake senders for this fixture’s cleanup-contract regressions only. */
  notificationSenders?: NotificationSenderRegistry;
  notificationSendTimeoutMs?: number;
}) {
  const label = options.label;
  const setupStarted = performance.now();
  let admin: PostgresSyncDatabase | undefined;
  let database: SqlDatabase | undefined;
  let created = false;
  const name = `reusable_store_${randomUUID().replaceAll("-", "")}`;
  const stats = { fixture: options.fixture, dialect, databaseCreates: 0, storeInitializations: 0, migrationRuns: 0, resets: 0, connections: 0, setupMs: 0, resetMs: 0 };
  let checkBackgroundBeforeClose = () => {};
  let stopBackground = () => {};
  let hasActiveBackground = () => false;
  function close() {
    checkBackgroundBeforeClose();
    try {
      database?.close();
    } finally {
      database = undefined;
      try {
        if (created) {
          admin!.exec(`DROP DATABASE ${quote(name)} WITH (FORCE)`);
          created = false;
        }
      } finally {
        admin?.close();
        admin = undefined;
      }
    }
  }
  try {
    if (dialect === "postgres") {
      if (!postgresUrl) throw new Error(`${label} requires an explicit test PostgreSQL URL`);
      const url = new URL(postgresUrl);
      // Match integration fixture isolation: an explicit local test service only.
      // Random CREATE DATABASE ownership still applies; never reset the URL's DB.
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error(`${label} requires a localhost PostgreSQL test URL`);
      }
      admin = new PostgresSyncDatabase(url.toString());
      stats.connections++;
      admin.exec(`CREATE DATABASE ${quote(name)}`);
      created = true;
      stats.databaseCreates++;
      url.pathname = `/${name}`;
      database = new PostgresSyncDatabase(url.toString());
    } else {
      database = openSqliteDatabase() as unknown as SqlDatabase;
    }
    stats.connections++;
    const db = database;
    const store = new MultiremiStore(db, {
      notificationSenders: options.notificationSenders,
      notificationSendTimeoutMs: options.notificationSendTimeoutMs,
    });
    stats.storeInitializations++;
    stats.migrationRuns++;
    store.ensureLocalWorkspace();
    // Test-only inspection: fail closed if the synchronous fixture contract is
    // violated instead of silently discarding a listener or pending delivery.
    const internals = store as unknown as {
      ctx: StoreContext;
      conversationLog: { listeners: Set<unknown> };
      taskCapabilityMonitor: { timer: unknown; sweeping: boolean };
      notificationDispatcher: { inFlight: Set<string>; retryTimers: Map<string, unknown>; sweepTimer: unknown; senders: NotificationSenderRegistry };
    };
    const ctx = internals.ctx;
    const pendingSends = new Set<Promise<unknown>>();
    Object.defineProperty(internals.notificationDispatcher, "senders", {
      value: trackNotificationSenders(internals.notificationDispatcher.senders, pendingSends),
      configurable: false, writable: false,
    });
    stopBackground = () => store.stopNotificationDeliverySweeper();
    hasActiveBackground = () => internals.taskCapabilityMonitor.sweeping || internals.notificationDispatcher.inFlight.size > 0 || pendingSends.size > 0;

    // Business transactions must use the same invalidatingDatabase wrapper as
    // production (SQLite afterCommit frames and lock sentinel). Raw db is only
    // for the explicit baseline snapshot/restore and legacy raw-SQL callers.
    const transactionDatabase = (store as unknown as { db: SqlDatabase }).db;
    const state = store as unknown as {
      tasks: { acceptedOfferLeases: Set<string>; taskRequestIssueLocks: Set<string> };
      agentPlugins: { versionCache: Map<string, unknown>; uncommittedVersionIds: Set<string> };
      feishuBot: { replayingOutboundOperation: boolean };
    };
    const environment = JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)));
    const clock = globalThis.Date;
    const now = Date.now;
    const uuid = crypto.randomUUID;
    const events = structuredClone(ctx.analyticsEvents);
    const counters = structuredClone(ctx.metricCounters);
    function assertNoBackgroundWork() {
      const monitor = internals.taskCapabilityMonitor;
      const dispatcher = internals.notificationDispatcher;
      if (monitor.timer || monitor.sweeping || dispatcher.sweepTimer || dispatcher.inFlight.size || dispatcher.retryTimers.size || pendingSends.size) {
        throw new Error(`${label} does not support background work`);
      }
    }
    // Install before baseline inspection so all subsequent initialization errors
    // have the same guard as a completed fixture. Constructors start no workers.
    checkBackgroundBeforeClose = assertNoBackgroundWork;
    async function dispose() {
      // Drain already queued dispatcher callbacks before deciding it is idle.
      await Promise.resolve();
      let backgroundError: unknown;
      try { assertNoBackgroundWork(); } catch (error) { backgroundError = error; }
      stopBackground();
      // Dispatcher timeout does not cancel senders; keep their connection usable until
      // they finish, and cancel retry timers they may schedule while settling.
      while (true) {
        if (hasActiveBackground()) await new Promise<void>(resolve => setTimeout(resolve, 10));
        // A settled sender may have queued another retry callback. Drain before
        // deciding to release its handle, then stop newly added retry timers.
        await Promise.resolve();
        stopBackground();
        if (!hasActiveBackground()) break;
      }
      try { close(); } catch (cleanupError) {
        if (backgroundError) throw new AggregateError([backgroundError, cleanupError], `${label} background work and cleanup failed`);
        throw cleanupError;
      }
      if (backgroundError) throw backgroundError;
    }
    function assertIdle() {
      if (db.inTransaction) throw new Error(`${label} reset inside an open transaction`);
      if (options.strictStoreState) {
        if (environment !== JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))
          || globalThis.Date !== clock || Date.now !== now || crypto.randomUUID !== uuid) {
          throw new Error(`${label} does not support environment, clock or UUID injection`);
        }
        if (state.tasks.acceptedOfferLeases.size || state.tasks.taskRequestIssueLocks.size
          || state.agentPlugins.uncommittedVersionIds.size || state.feishuBot.replayingOutboundOperation) {
          throw new Error(`${label} has unfinished Store work or lock scopes`);
        }
        // This diagnostic is PostgreSQL-only. SQLite's wrapper queue is a
        // closure, not a DB property. Its synchronous transaction/savepoint
        // finally blocks pop/drain frames before returning; db.inTransaction
        // above prevents resetting while either kind of runner is active.
        const frames = (db as unknown as { afterCommitFrames?: unknown[] }).afterCommitFrames;
        if (frames?.length) throw new Error(`${label} has unfinished afterCommit callbacks`);
      }
      if (activeRequestReadCache()) throw new Error(`${label} does not support request read caches`);
      assertNoBackgroundWork();
      for (const listeners of [ctx.taskEnqueuedListeners, ctx.taskEventListeners, ctx.taskMessagesListeners, ctx.workspaceEventListeners, ctx.humanRequestListeners, internals.conversationLog.listeners]) {
        if (listeners.size) throw new Error(`${label} does not support subscriptions`);
      }
    }
    function schema() {
      return JSON.stringify(dialect === "sqlite"
        ? db.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
        : [
          db.query("SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity, is_generated, generation_expression FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position").all(),
          db.query("SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY relation, conname").all(),
          db.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname").all(),
          db.query("SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY tgname").all(),
          db.query("SELECT relname, relkind FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'S') ORDER BY relname").all(),
        ]);
    }
    // These tables currently use explicit IDs and no triggers. Do not silently
    // expand this reset strategy to sequence state or trigger-generated rows.
    const unsupported = dialect === "sqlite"
      ? db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' OR (type = 'table' AND sql LIKE '%AUTOINCREMENT%')").all()
      : [
        ...db.query("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S'").all(),
        ...db.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)").all(),
      ];
    if (unsupported.length) throw new Error(`${label} does not support sequences or triggers`);
    assertIdle();
    const baselineSchema = schema();
    const tables: string[] = (dialect === "sqlite"
      ? db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
      : db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename").all().map(row => row.tablename));
    // One bridge round trip for the whole table set, not one per table/cell.
    const countsSql = tables.map((table, index) => `SELECT ${index} AS table_index, COUNT(*) AS count FROM ${quote(table)}`).join(" UNION ALL ");
    function counts(): number[] {
      const result: number[] = [];
      for (const row of db.query(countsSql).all()) result[Number(row.table_index)] = Number(row.count);
      return result;
    }
    const baselineCounts = counts();
    const seeded = tables.filter((_table, index) => baselineCounts[index]! > 0);
    // Restore parents before children, including non-deferrable PG foreign keys.
    const dependencies = new Map(seeded.map(table => [table, new Set<string>()]));
    for (const table of seeded) {
      const parents: string[] = dialect === "sqlite"
        ? db.query(`PRAGMA foreign_key_list(${quote(table)})`).all().map(row => row.table)
        : db.query("SELECT confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f' AND conrelid = ?::regclass").all(table).map(row => row.parent);
      for (const parent of parents) if (parent !== table && dependencies.has(parent)) dependencies.get(table)!.add(parent);
    }
    const order: string[] = [];
    while (order.length < seeded.length) {
      const next = seeded.find(table => !order.includes(table) && [...dependencies.get(table)!].every(parent => order.includes(parent)));
      if (!next) throw new Error(`${label} seed has cyclic foreign keys; use a fresh fixture`);
      order.push(next);
    }
    const snapshots = new Map<string, string>();
    for (const [index, table] of seeded.entries()) {
      const snapshot = `routing_baseline_${index}`;
      db.exec(`CREATE TEMP TABLE ${quote(snapshot)} AS SELECT * FROM ${quote(table)}`);
      snapshots.set(table, snapshot);
    }
    function assertClean() {
      assertIdle();
      if (schema() !== baselineSchema) throw new Error(`${label}: Schema-changing tests cannot reuse the fixture`);
    }
    function restoreBaseline(): MultiremiStore {
      assertClean();
      const foreignKeys = dialect === "sqlite" ? readConnectionPragma(db as unknown as import("bun:sqlite").Database, "foreign_keys") : 0;
      if (dialect === "sqlite") db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.transaction(() => {
          if (dialect === "postgres") db.exec(`TRUNCATE TABLE ${tables.map(quote).join(", ")}`);
          else for (const table of tables) db.exec(`DELETE FROM ${quote(table)}`);
          for (const table of order) db.exec(`INSERT INTO ${quote(table)} SELECT * FROM ${quote(snapshots.get(table)!)}`);
          const restoredCounts = counts();
          for (const [index, table] of tables.entries()) {
            if (restoredCounts[index] !== baselineCounts[index]) throw new Error(`Routing matrix reset did not restore ${table}`);
          }
          if (dialect === "sqlite" && db.query("PRAGMA foreign_key_check").all().length) throw new Error(`${label} reset violated a foreign key`);
        })();
      } finally {
        if (dialect === "sqlite") db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
      }
      ctx.analyticsEvents.splice(0, ctx.analyticsEvents.length, ...structuredClone(events));
      ctx.metricCounters.clear();
      for (const [key, value] of structuredClone(counters)) ctx.metricCounters.set(key, value);
      if (options.strictStoreState) state.agentPlugins.versionCache.clear();
      stats.resets++;
      return store;
    }
    function reset(): MultiremiStore {
      const resetStarted = performance.now();
      try {
        return restoreBaseline();
      } finally {
        // Include failed attempts; resets counts only completed baseline restores.
        stats.resetMs += performance.now() - resetStarted;
      }
    }
    // Never terminate a connection while an observed Store worker can still use
    // it. Subscribers/SQL rows may be discarded only after the idle check has
    // already failed the case; running background work must settle first.
    checkBackgroundBeforeClose = assertNoBackgroundWork;
    stats.setupMs = performance.now() - setupStarted;
    return { db, transactionDatabase, store, reset, stats, close, dispose, assertIdle, assertClean,
      databaseUrl: dialect === "postgres" ? (() => { const url = new URL(postgresUrl!); url.pathname = `/${name}`; return url.toString(); })() : undefined };
  } catch (error) {
    try { close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `${label} initialization and cleanup failed`); }
    throw error;
  }
}
