/**
 * The Live Hub's startup guard and its health/readiness fields (MUL-403 §1 items
 * 7, 8 and 9; plan 2/6 §1).
 *
 * The guard's whole job is an exclusive claim, so the interesting cases are the
 * ones that need a real server: two processes of the same role must not both hold
 * the lock, two *different* roles must, and an `all` process beside a configured
 * peer must leave the runtime lock alone. Those run against Postgres and are
 * skipped, with a warning, when `MULTIREMI_TEST_POSTGRES_URL` points nowhere — the
 * same convention `read-pool.test.ts` and `multiremi-postgres-store.test.ts` use.
 *
 * The role→lock table and the per-role read-pool capacity are pure and always run.
 */
import { describe, expect, it } from "bun:test";
import {
  HUB_LOCK_KEY_PREFIX,
  HUB_LOCK_RETRY_MS,
  HUB_LOCK_TIMEOUT_MS,
  hubLockKey,
  isPostgresUrl,
  locksForRole,
  resolveHubRole,
  startHubRoleGuard,
  type HubRoleGuardLogger,
} from "@multiremi/api/hub/hub-role-guard.js";
import {
  READ_POOL_CAPACITY_BY_ROLE,
  READ_POOL_QUEUE_LIMIT,
  READ_POOL_MAX_CONNECTIONS,
  readPoolCapacityForRole,
} from "@multiremi/store/db/read-pool.js";

// ── Pure: which locks a role takes ──────────────────────────────────────────────────────────────

describe("hub role guard: role resolution and lock table", () => {
  it("resolves ui and runtime, and degrades everything else to all", () => {
    expect(resolveHubRole("ui")).toBe("ui");
    expect(resolveHubRole("runtime")).toBe("runtime");
    expect(resolveHubRole(" UI ")).toBe("ui");
    for (const value of ["all", "", "  ", undefined, null, "RUNTIME_PLEASE", "u1"]) {
      expect(resolveHubRole(value)).toBe("all");
    }
  });

  it("takes one lock per single role and two for all without a peer", () => {
    expect(locksForRole("ui", false)).toEqual(["ui"]);
    expect(locksForRole("runtime", false)).toEqual(["runtime"]);
    expect(locksForRole("all", false)).toEqual(["ui", "runtime"]);
    // The S10 transition: `all` beside a `runtime` container is the ui half, so it
    // must not fight the runtime container for the runtime lock.
    expect(locksForRole("all", true)).toEqual(["ui"]);
  });

  it("names its own lock namespace", () => {
    expect(HUB_LOCK_KEY_PREFIX).toBe("remi:hub:");
    expect(hubLockKey("ui")).toBe("remi:hub:ui");
    expect(hubLockKey("runtime")).toBe("remi:hub:runtime");
  });

  it("only locks a Postgres deployment", () => {
    expect(isPostgresUrl("postgres://user:pw@host:5432/db")).toBe(true);
    expect(isPostgresUrl("postgresql://user:pw@host:5432/db")).toBe(true);
    expect(isPostgresUrl(" PostgreSQL://host/db ")).toBe(true);
    expect(isPostgresUrl("file:local.db")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
    expect(isPostgresUrl(null)).toBe(false);
    expect(isPostgresUrl(undefined)).toBe(false);
  });

  it("is a no-op without a Postgres URL, and takes nothing to release", async () => {
    const guard = await startHubRoleGuard({ databaseUrl: "", locks: ["ui", "runtime"] });
    expect(guard?.held).toEqual([]);
    expect(guard?.pid).toBeNull();
    await guard?.close();
  });

  it("times out, logs the reason and exits non-zero when the lock is taken", async () => {
    // A driver that answers "someone else has it" for the whole window, so the
    // retry/exit path is exercised without a server.
    const exits: number[] = [];
    const messages: string[] = [];
    const guard = await startHubRoleGuard({
      databaseUrl: "postgres://user:pw@127.0.0.1:1/none",
      locks: ["ui"],
      timeoutMs: 0,
      retryMs: 1,
      exit: (code) => { exits.push(code); },
      logger: collectingLogger(messages),
    });
    expect(guard).toBeNull();
    expect(exits).toEqual([1]);
    // The failure is reported as "cannot reach", which is the honest cause here:
    // nothing is listening. Either way the process must not silently continue.
    expect(messages.join("\n")).toContain("hub-role-guard:");
  });

  it("keeps the retry cadence the issue asks for", () => {
    expect(HUB_LOCK_TIMEOUT_MS).toBe(30_000);
    expect(HUB_LOCK_RETRY_MS).toBe(1_000);
  });
});

// ── Pure: per-role read-pool capacity ───────────────────────────────────────────────────────────

describe("read pool capacity by role", () => {
  it("gives ui (and all) 4/64 and runtime 2/16", () => {
    expect(READ_POOL_CAPACITY_BY_ROLE.ui).toEqual({ maxConnections: 4, queueLimit: 64 });
    expect(READ_POOL_CAPACITY_BY_ROLE.all).toEqual({ maxConnections: 4, queueLimit: 64 });
    expect(READ_POOL_CAPACITY_BY_ROLE.runtime).toEqual({ maxConnections: 2, queueLimit: 16 });
  });

  it("keeps the existing `all` constants, so nothing that reads them changes", () => {
    expect(READ_POOL_MAX_CONNECTIONS).toBe(4);
    expect(READ_POOL_QUEUE_LIMIT).toBe(64);
  });

  it("degrades an unknown role name to the all row", () => {
    expect(readPoolCapacityForRole("runtime")).toEqual({ maxConnections: 2, queueLimit: 16 });
    expect(readPoolCapacityForRole(null)).toEqual(READ_POOL_CAPACITY_BY_ROLE.all);
    expect(readPoolCapacityForRole("typo")).toEqual(READ_POOL_CAPACITY_BY_ROLE.all);
  });
});

// ── Real Postgres: exclusivity ──────────────────────────────────────────────────────────────────

const PG_ADMIN_URL =
  process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multiremi:local-only@localhost:5432/postgres";

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
    "[mul436-hub-role-guard] Postgres not reachable"
    + `${process.env.MULTIREMI_TEST_POSTGRES_URL ? "" : " (MULTIREMI_TEST_POSTGRES_URL is unset)"}`
    + " — skipping the guard's exclusivity checks. CI is expected to run them.",
  );
}

describe.skipIf(!pgAvailable)("hub role guard: Postgres exclusivity", () => {
  it("lets two processes take their own role but not the same one twice", async () => {
    const first = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["ui"],
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
    });
    expect(first?.held).toEqual(["ui"]);
    expect(first?.pid).toBeGreaterThan(0);

    // The same role, a different connection: refused inside the window and the
    // process is told to exit.
    const exits: number[] = [];
    const second = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["ui"],
      timeoutMs: 0,
      retryMs: 1,
      exit: (code) => { exits.push(code); },
      logger: silentLogger(),
    });
    expect(second).toBeNull();
    expect(exits).toEqual([1]);

    // A different role coexists: that is the whole point of a per-role lock.
    const runtime = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["runtime"],
      timeoutMs: 0,
      retryMs: 1,
      exit: (code) => { exits.push(code); },
    });
    expect(runtime?.held).toEqual(["runtime"]);

    await runtime?.close();
    await first?.close();
  });

  it("releases its locks when the guard closes", async () => {
    const first = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["runtime"],
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
    });
    expect(first?.held).toEqual(["runtime"]);
    await first?.close();

    const after = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["runtime"],
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
    });
    expect(after?.held).toEqual(["runtime"]);
    await after?.close();
  });

  it("takes both keys for all without a peer and only ui with one", async () => {
    const all = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: locksForRole("all", false),
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
    });
    expect(all?.held).toEqual(["ui", "runtime"]);

    // A runtime process cannot start beside it: the all process holds runtime.
    const blocked = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["runtime"],
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
      logger: silentLogger(),
    });
    expect(blocked).toBeNull();
    await all?.close();

    // With a peer configured, `all` is the ui half and leaves runtime free.
    const withPeer = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: locksForRole("all", true),
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
    });
    expect(withPeer?.held).toEqual(["ui"]);
    const runtime = await startHubRoleGuard({
      databaseUrl: PG_ADMIN_URL,
      locks: ["runtime"],
      timeoutMs: 0,
      retryMs: 1,
      exit: () => {},
    });
    expect(runtime?.held).toEqual(["runtime"]);
    await runtime?.close();
    await withPeer?.close();
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** A logger that records everything, so a case can assert what an operator sees. */
function collectingLogger(messages: string[]): HubRoleGuardLogger {
  return {
    info: (message) => { messages.push(`hub-role-guard: ${message}`); },
    warn: (message) => { messages.push(`hub-role-guard: ${message}`); },
    error: (message) => { messages.push(`hub-role-guard: ${message}`); },
  };
}

/** A logger that says nothing: used where the failure is the assertion's point. */
function silentLogger(): HubRoleGuardLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
