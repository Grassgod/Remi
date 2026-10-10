import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store/store.js";
import { deserializeSqliteDatabase, openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { resolveMigrationReportDirectory } from "@multiremi/store/migration-report-directory.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";

const nativeDate = Date;
const nativeNow = Date.now;
const nativeRandom = Math.random;
const nativeGetRandomValues = crypto.getRandomValues;
const nativeRandomUUID = crypto.randomUUID;
const clockWall = nativeNow();
const clockMonotonic = process.hrtime.bigint();

function normalClockAndRandom(): boolean {
  const elapsed = Number(process.hrtime.bigint() - clockMonotonic) / 1_000_000;
  return Date === nativeDate && Date.now === nativeNow && Math.random === nativeRandom
    && crypto.getRandomValues === nativeGetRandomValues && crypto.randomUUID === nativeRandomUUID
    && Math.abs(Date.now() - clockWall - elapsed) < 250
    // A module can itself be loaded while Date is already mocked; captured
    // function identity alone is not proof of a real wall clock.
    && Math.abs(Date.now() - (performance.timeOrigin + performance.now())) < 250;
}

function environmentFingerprint(): string {
  // Hash the entire environment: do not guess which inputs a future migration
  // may read, and never expose credentials or fingerprint contents in output.
  return createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

// Connection settings are not all part of SQLite's serialized database image.
const connectionPragmas = ["foreign_keys", "recursive_triggers", "busy_timeout", "read_uncommitted", "ignore_check_constraints"] as const;

/** Read the one scalar value without relying on Bun/SQLite column labels. */
export function readConnectionPragma(db: Pick<Database, "query">, pragma: typeof connectionPragmas[number]): number {
  const row = db.query(`PRAGMA ${pragma}`).get();
  const values = row ? Object.values(row) : [];
  const value = values[0];
  if (values.length !== 1 || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unsupported SQLite connection PRAGMA result: ${pragma}`);
  }
  return value;
}

interface SqliteStoreSnapshot {
  bytes: Uint8Array;
  environment: string;
  pragmas: Record<string, number>;
  reportDir: string;
}

/**
 * Opt-in ordinary business fixtures only. Each caller gets a new handle and a
 * new Store, with the normal production migration entrance still running. The
 * immutable image shares migration-generated seed timestamps/metadata, so clock,
 * ID-sequence, empty-schema, migration and startup-side-effect tests must use a
 * fresh factory instead. No enclosing rollback, Store mock or migration skip.
 */
export function createSqliteStoreSnapshotFactory() {
  let snapshot: SqliteStoreSnapshot | undefined;
  const stats = {
    fixture: "ordinary-sqlite-snapshot", dialect: "sqlite", coldBootstraps: 0,
    clones: 0, freshFallbacks: 0, storeInitializations: 0, initializationMs: 0,
  };

  function coldStore() {
    const db = openSqliteDatabase();
    try {
      const store = new MultiremiStore(db);
      stats.coldBootstraps++;
      stats.storeInitializations++;
      return { db, store };
    } catch (error) {
      try { db.close(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "SQLite snapshot initialization and cleanup failed");
      }
      throw error;
    }
  }

  function create(): { db: Database; store: MultiremiStore } {
    const started = performance.now();
    try {
      const environment = environmentFingerprint();
      const compatible = normalClockAndRandom() && (!snapshot || snapshot.environment === environment);
      const reportsPresent = !snapshot || ["before", "after"].every(phase =>
        existsSync(join(snapshot!.reportDir, `${UNIFIED_MODEL_MIGRATION}-${phase}.json`)));
      if (!compatible || !reportsPresent) {
        stats.freshFallbacks++;
        return coldStore();
      }
      if (!snapshot) {
        const template = coldStore();
        let image: SqliteStoreSnapshot;
        try {
          const pragmas = Object.fromEntries(connectionPragmas.map(pragma => [pragma, readConnectionPragma(template.db, pragma)]));
          const bytes = template.db.serialize();
          image = { bytes, environment, pragmas, reportDir: resolveMigrationReportDirectory() };
        } finally {
          template.db.close();
        }
        snapshot = image;
      }
      // Copy before passing to the native deserializer; it can never mutate the
      // cached baseline buffer or another caller's SQLite image.
      const db = deserializeSqliteDatabase(snapshot!.bytes.slice());
      try {
        for (const pragma of connectionPragmas) db.exec(`PRAGMA ${pragma} = ${snapshot!.pragmas[pragma]}`);
        const store = new MultiremiStore(db);
        stats.storeInitializations++;
        stats.clones++;
        return { db, store };
      } catch (error) {
        try { db.close(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "SQLite snapshot clone initialization and cleanup failed");
        }
        throw error;
      }
    } finally {
      stats.initializationMs += performance.now() - started;
    }
  }
  return { create, stats: () => ({ ...stats }) };
}
