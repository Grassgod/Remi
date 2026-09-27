/**
 * MUL-409 fix round 4 (QA round 3, blockers 1+2): the process-exit probe for the
 * automatic start, on a real Postgres connection.
 *
 * Two exit points, both from QA's reproduction:
 *
 *   - `mode: "before-commit"` — exit while the auto-start transaction is open
 *     and before any of its writes. Pre-fix the claim had already committed, so
 *     the dependent stayed `todo` with no round and no activity forever. With
 *     the single-transaction fix the attempt is one unit: dying before COMMIT
 *     leaves nothing.
 *   - `mode: "after-commit"` — let the transaction commit, then exit on the
 *     first post-commit wakeup. The durable state must be complete (`todo` plus
 *     its queued round plus both activities); only the live notification is lost.
 *   - `mode: "after-claim-commit"` — exit on the first commit after which the
 *     dependent is `todo`. This is the seam QA's round-3 probe used, written so it
 *     runs unchanged on both versions: pre-fix that commit is the claim alone, so
 *     the dependent ends up `todo` with no round; post-fix it is the whole
 *     auto-start, so the same instant leaves a complete state.
 */
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

/**
 * A real OS process: `process.exit` here is the crash under test, so the
 * transaction stays open with no ROLLBACK and the connection dies with it.
 *
 * Usage: bun run <this file> <databaseUrl> <prerequisiteId> <dependentId> <mode>
 * The process prints a phase marker to stdout, then sleeps until the parent
 * kills it.
 */
const [databaseUrl, prerequisiteId, dependentId, mode] = process.argv.slice(2);
const MODES = ["before-commit", "after-commit", "after-claim-commit"];

if (!databaseUrl || !prerequisiteId || !dependentId || !MODES.includes(mode ?? "")) {
  console.error(`usage: <databaseUrl> <prerequisiteId> <dependentId> <${MODES.join("|")}>`);
  process.exit(2);
}

function announce(phase: string): void {
  process.stdout.write(`${phase}\n`);
}

/** Burn CPU until the parent kills us; never returns in the probe path. */
function holdUntilKilled(): never {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Busy wait on purpose: the parent terminates the process and the death of
    // the process is what the test observes.
  }
  process.exit(97);
}

const db = new PostgresSyncDatabase(databaseUrl);
const store = new MultiremiStore(db);
type Internals = {
  ctx: {
    transactionWithDeferredEvents: <T>(database: unknown, fn: () => T) => T;
    notifyTaskEnqueued: (task: unknown) => void;
  };
};
const internals = store as unknown as Internals;

if (mode === "before-commit") {
  const original = internals.ctx.transactionWithDeferredEvents.bind(internals.ctx);
  let armed = true;
  internals.ctx.transactionWithDeferredEvents = <T,>(database: unknown, fn: () => T): T =>
    original(database, () => {
      if (armed) {
        armed = false;
        announce("in-transaction");
        holdUntilKilled();
      }
      return fn();
    });
} else if (mode === "after-claim-commit") {
  // QA's round-3 seam, expressed so it runs unchanged on both versions: exit on
  // the first commit after which the DEPENDENT's status write is visible.
  //
  // Pre-fix that is the claim transaction on its own — the dependent is `todo`
  // with no round, and the crash strands it there. Post-fix the same instant is
  // the commit of the whole auto-start, so the dependent is `todo` WITH its
  // round. The mode therefore measures exactly what the fix changed.
  const dbHandle = (store as unknown as {
    ctx: { db: { transaction: <T>(fn: () => T) => () => T; query(sql: string): { get(...args: unknown[]): unknown } } };
  }).ctx.db;
  const original = dbHandle.transaction.bind(dbHandle);
  dbHandle.transaction = <T,>(fn: () => T): (() => T) => {
    const run = original(fn);
    return () => {
      const result = run();
      const row = dbHandle.query("SELECT status FROM multiremi_issues WHERE id = ?").get(dependentId) as
        | { status: string }
        | null;
      if (row?.status === "todo") {
        announce("after-claim-commit");
        holdUntilKilled();
      }
      return result;
    };
  };
} else {
  const original = internals.ctx.notifyTaskEnqueued.bind(internals.ctx);
  let armed = true;
  internals.ctx.notifyTaskEnqueued = (task: unknown) => {
    if (armed) {
      armed = false;
      announce("after-commit");
      holdUntilKilled();
    }
    original(task);
  };
}

try {
  store.updateIssue(prerequisiteId, { status: "done" });
  announce("completed");
} catch (error) {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
} finally {
  db.close();
}
