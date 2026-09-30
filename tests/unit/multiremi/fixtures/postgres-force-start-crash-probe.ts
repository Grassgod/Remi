/**
 * MUL-409 fix round 5 (QA round 4, blocker 1): the process-exit probe for the
 * member's forced start, on a real Postgres connection.
 *
 * QA round 4 reproduced the defect by exiting after the status write committed
 * and before the dispatch ran, leaving the issue at `todo` with no round. Both
 * seams are kept here so the fix is measured at the exact point QA used:
 *
 *   - `before-commit` — the status UPDATE has run inside the write transaction
 *     and the process dies before COMMIT. Nothing may survive: `backlog`, no task
 *     rows, no activity.
 *   - `after-status-commit` — QA's seam, written so it runs unchanged on both
 *     versions: exit on the first commit after which the issue reads `todo`.
 *     Pre-fix that commit is the status write alone, so the crash strands a
 *     `todo` with no round. Post-fix it is the whole forced start, so the same
 *     instant leaves `todo` WITH its queued round and the force record.
 *   - `after-gate-open-commit` — the same post-COMMIT/pre-event seam with a
 *     prerequisite the parent test has already marked `done`. The request is
 *     an ordinary member start, so `issue_updated` is its only dependency-start
 *     record and must already be durable when this process exits.
 *
 * Usage: bun run <this file> <databaseUrl> <issueId> <mode> [exitCode]
 */
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

const [databaseUrl, issueId, mode, exitCodeRaw] = process.argv.slice(2);
const MODES = ["before-commit", "after-status-commit", "after-gate-open-commit"];
const exitCode = Number(exitCodeRaw ?? 19);

if (!databaseUrl || !issueId || !MODES.includes(mode ?? "")) {
  console.error(`usage: <databaseUrl> <issueId> <${MODES.join("|")}> [exitCode]`);
  process.exit(2);
}

function announce(phase: string): void {
  process.stdout.write(`${phase}\n`);
}

/** Burn CPU until the parent kills us; never returns in the probe path. */
function holdUntilKilled(): never {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Busy wait on purpose: the process death is what the test observes.
  }
  process.exit(97);
}

const db = new PostgresSyncDatabase(databaseUrl);
const store = new MultiremiStore(db);
type Internals = {
  ctx: {
    db: {
      run(sql: string, params?: unknown[]): unknown;
      transaction<T>(fn: () => T): () => T;
      query(sql: string): { get(...args: unknown[]): unknown };
      readonly inTransaction: boolean;
    };
  };
};
const internals = store as unknown as Internals;

if (mode === "before-commit") {
  const handle = internals.ctx.db;
  const originalRun = handle.run.bind(handle);
  let armed = true;
  handle.run = (sql: string, params?: unknown[]) => {
    const result = originalRun(sql, params);
    if (armed && sql.includes("UPDATE multiremi_issues") && sql.includes("title = ?")) {
      armed = false;
      announce("after-status-update");
      holdUntilKilled();
    }
    return result;
  };
} else {
  const handle = internals.ctx.db;
  const original = handle.transaction.bind(handle);
  let armed = true;
  handle.transaction = <T,>(fn: () => T): (() => T) => {
    const run = original(fn);
    return () => {
      const result = run();
      // A nested transaction() only releases a SAVEPOINT; the seam is the top-level COMMIT (MUL-402 ② / (c)).
      if (armed && !handle.inTransaction) {
        const row = handle.query("SELECT status FROM multiremi_issues WHERE id = ?").get(issueId) as
          | { status: string }
          | null;
        if (row?.status === "todo") {
          armed = false;
          announce(mode === "after-gate-open-commit" ? "after-gate-open-commit" : "after-status-commit");
          // A real process exit: the transaction is committed, the connection
          // dies with the process, and nothing after this point runs.
          process.exit(exitCode);
        }
      }
      return result;
    };
  };
}

try {
  // Direct store call: the probe measures the write transaction itself, not the
  // route's dispatch step.
  store.updateIssueWithOutcome(issueId, {
    status: "todo",
    force: true,
    actorType: "member",
    actorId: "mem_local",
  });
  announce("completed");
} catch (error) {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
} finally {
  if (mode === "before-commit") db.close();
}
