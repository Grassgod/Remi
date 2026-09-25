/**
 * MUL-367: the Postgres bridge across a dropped connection (PG restart,
 * pg_terminate_backend, network cut).
 *
 * Bun.SQL reconnects on its own, so the API heals once Postgres is back. The
 * hazard is a drop in the middle of BEGIN…COMMIT: the server rolls the open
 * transaction back, and without a guard the remaining statements would run in
 * autocommit on the new session and COMMIT would degrade to a warning — a
 * partial commit reported as success. `pg_terminate_backend` exercises the same
 * client-side path as a restart without needing to bounce the CI service.
 *
 * Skipped (not failed) when Postgres is unreachable, matching
 * `multiremi-postgres-store.test.ts`. Point `MULTIREMI_TEST_POSTGRES_URL` at an
 * instance where the configured role may CREATE DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul367_reconnect_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

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
    `[mul367-pg] Postgres not reachable at ${PG_ADMIN_URL} — skipping the bridge reconnect checks.`,
  );
}

describe.skipIf(!pgAvailable)("Postgres bridge across a dropped connection (MUL-367)", () => {
  let db: PostgresSyncDatabase;
  let observer: PostgresSyncDatabase;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${TEST_DB}`;
    db = new PostgresSyncDatabase(url.toString());
    observer = new PostgresSyncDatabase(url.toString());
    db.exec("CREATE TABLE reconnect_probe (id INTEGER NOT NULL)");
  });

  afterAll(async () => {
    db?.close();
    observer?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  function backendPid(): number {
    return Number(db.query("SELECT pg_backend_pid() AS pid").get().pid);
  }

  /** Kill `pid` from the observer session and wait until the server reaped it. */
  function dropConnection(pid: number): void {
    expect(observer.query("SELECT pg_terminate_backend(?) AS killed").get(pid).killed).toBe(true);
    const deadline = Date.now() + 5_000;
    while (observer.query("SELECT 1 AS alive FROM pg_stat_activity WHERE pid = ?").get(pid)) {
      if (Date.now() > deadline) throw new Error(`backend ${pid} still alive after pg_terminate_backend`);
      Bun.sleepSync(10);
    }
    // Let the worker observe the closed socket, as it would after a restart.
    Bun.sleepSync(50);
  }

  function probeIds(): number[] {
    return observer.query("SELECT id FROM reconnect_probe ORDER BY id").all().map((row) => Number(row.id));
  }

  it("heals after the connection drops between statements", () => {
    const before = backendPid();
    dropConnection(before);
    const after = backendPid();
    expect(after).not.toBe(before);
    expect(db.query("SELECT 1 AS ok").get().ok).toBe(1);
  });

  it("rolls the whole transaction back when the connection drops mid-transaction", () => {
    db.run("DELETE FROM reconnect_probe");
    const insert = db.query("INSERT INTO reconnect_probe (id) VALUES (?)");
    const write = db.transaction(() => {
      insert.run(1);
      dropConnection(backendPid());
      insert.run(2);
      insert.run(3);
    });

    expect(() => write()).toThrow(/connection lost during transaction/);
    expect(probeIds()).toEqual([]);
  });

  it("runs the next transaction normally on the new connection", () => {
    db.run("DELETE FROM reconnect_probe");
    const insert = db.query("INSERT INTO reconnect_probe (id) VALUES (?)");
    db.transaction(() => {
      insert.run(4);
      insert.run(5);
    })();
    expect(probeIds()).toEqual([4, 5]);

    expect(() => db.transaction(() => {
      insert.run(6);
      throw new Error("caller aborted");
    })()).toThrow("caller aborted");
    expect(probeIds()).toEqual([4, 5]);
  });
});
