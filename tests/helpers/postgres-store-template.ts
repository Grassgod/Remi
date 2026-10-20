import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { resolveMigrationReportDirectory } from "@multiremi/store/migration-report-directory.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";

import { environmentFingerprint, normalClockAndRandom } from "./sqlite-store-snapshot.js";

export interface PostgresCaseDatabase { name: string; url: string }

/**
 * PostgreSQL counterpart of the SQLite snapshot factory, for explicitly
 * opted-in ordinary business suites only. A suite-owned TEMPLATE database runs
 * the cold migration once; every case still receives its own new database
 * (`CREATE DATABASE ... TEMPLATE`), its own connection and a new Store whose
 * production migration entrance runs the already-migrated path. Nothing is
 * shared at run time, no rollback wraps a case and no migration is skipped.
 *
 * The template stores the migration seed (schema_migrations timestamps), so the
 * SQLite snapshot exclusions apply: cold migration, empty-schema, startup side
 * effect and environment/clock/UUID-sensitive cases keep a fresh database. Like
 * the SQLite image, the template is built lazily by the first case under that
 * case's environment; a later case whose clock, RNG or environment differs, or
 * whose migration report is missing, falls back to a fresh empty database.
 *
 * Only an explicit local test server is accepted; only databases this factory
 * created are dropped. The consuming suite must await `prepare()` in beforeAll
 * and `dispose()` in afterAll.
 */
export function createPostgresStoreTemplate(adminUrl: string, options: { prefix: string; fixture: string }) {
  if (!/^[a-z][a-z0-9_]{0,20}$/.test(options.prefix)) throw new Error("Template database prefix must be a short lowercase identifier");
  const base = new URL(adminUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error(`${options.fixture} requires a local dedicated PostgreSQL test server`);
  }
  const urlFor = (name: string) => { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); };
  const ownedName = new RegExp(`^${options.prefix}_[a-f0-9]{32}$`);
  const owned = new Set<string>();
  let admin: Bun.SQL | undefined;
  let template: { name: string; environment: string; reportDir: string } | undefined;
  const stats = {
    fixture: options.fixture, dialect: "postgres", templateBuilds: 0, clones: 0, freshFallbacks: 0,
    databaseCreates: 0, templateMs: 0, createMs: 0,
  };

  const connection = () => {
    if (!admin) throw new Error(`${options.fixture} template is not prepared`);
    return admin;
  };
  async function createOwned(templateName?: string): Promise<PostgresCaseDatabase> {
    const name = `${options.prefix}_${randomUUID().replaceAll("-", "")}`;
    await connection().unsafe(templateName ? `CREATE DATABASE ${name} TEMPLATE ${templateName}` : `CREATE DATABASE ${name}`);
    owned.add(name);
    stats.databaseCreates++;
    return { name, url: urlFor(name) };
  }

  async function prepare(): Promise<void> {
    if (admin) throw new Error(`${options.fixture} template is already prepared`);
    admin = new Bun.SQL(adminUrl, { max: 1 });
    try { await admin`SELECT 1`; }
    catch (error) {
      await admin.end();
      admin = undefined;
      throw new Error(`Configured ${options.fixture} test PostgreSQL is unavailable`, { cause: error });
    }
  }

  async function buildTemplate(environment: string): Promise<void> {
    const started = performance.now();
    const database = await createOwned();
    const db = new PostgresSyncDatabase(database.url);
    try {
      new MultiremiStore(db);
    } finally {
      // CREATE DATABASE ... TEMPLATE requires that nobody is connected to it.
      db.close();
    }
    template = { name: database.name, environment, reportDir: resolveMigrationReportDirectory() };
    stats.templateBuilds++;
    stats.templateMs += performance.now() - started;
  }

  /** A new database for one case: a template clone when compatible, else a fresh empty one. */
  async function createDatabase(): Promise<PostgresCaseDatabase> {
    const started = performance.now();
    try {
      if (!normalClockAndRandom()) {
        stats.freshFallbacks++;
        return await createOwned();
      }
      const environment = environmentFingerprint();
      if (!template) await buildTemplate(environment);
      const compatible = template!.environment === environment
        && ["before", "after"].every(phase => existsSync(join(template!.reportDir, `${UNIFIED_MODEL_MIGRATION}-${phase}.json`)));
      if (!compatible) {
        stats.freshFallbacks++;
        return await createOwned();
      }
      stats.clones++;
      return await createOwned(template!.name);
    } finally {
      stats.createMs += performance.now() - started;
    }
  }

  async function dropDatabase(name: string): Promise<void> {
    if (!owned.has(name) || !ownedName.test(name)) throw new Error("Refusing to drop a database not created by this template factory");
    await connection().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    owned.delete(name);
  }

  async function dispose(): Promise<void> {
    if (!admin) return;
    const errors: unknown[] = [];
    try {
      for (const name of [...owned]) {
        try { await dropDatabase(name); } catch (error) { errors.push(error); }
      }
    } finally {
      template = undefined;
      try { await admin.end(); } catch (error) { errors.push(error); }
      admin = undefined;
    }
    if (errors.length) throw new AggregateError(errors, `${options.fixture} cleanup failed`);
  }

  return { prepare, createDatabase, dropDatabase, dispose, stats: () => ({ ...stats }) };
}
