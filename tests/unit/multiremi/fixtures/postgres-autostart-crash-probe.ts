/**
 * Real process-exit probe shared by Postgres and file-backed SQLite.
 * Usage: <database URL/path> <prerequisiteId> <dependentId> <mode> [replayAt] [resumeFile]
 * The parent kills this process after its phase marker. A resume file lets the
 * concurrent PG test release the normal post-commit path while replay runs.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { StoreContext } from "@multiremi/store/context.js";

const [databaseUrl, prerequisiteId, dependentId, mode, replayAt, resumeFile] = process.argv.slice(2);
const MODES = [
  "before-commit", "after-commit", "after-claim-commit", "after-done-commit",
  "replay-before-commit", "replay-after-commit", "replay",
];

if (!databaseUrl || !prerequisiteId || !dependentId || !MODES.includes(mode ?? "")) {
  console.error(`usage: <database URL/path> <prerequisiteId> <dependentId> <${MODES.join("|")}> [replayAt] [resumeFile]`);
  process.exit(2);
}

function announce(phase: string): void {
  process.stdout.write(`${phase}\n`);
}

function holdUntilKilled(): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (resumeFile && existsSync(resumeFile)) return;
    Atomics.wait(sleeper, 0, 0, 10);
  }
  process.exit(97);
}

const db: SqlDatabase = /^postgres(?:ql)?:\/\//.test(databaseUrl)
  ? new PostgresSyncDatabase(databaseUrl)
  : Object.assign(new Database(databaseUrl), { dialect: "sqlite" as const });
const store = new MultiremiStore(db);
const { ctx } = store as unknown as { ctx: StoreContext };

function status(issueId: string): string | undefined {
  return (db.query("SELECT status FROM multiremi_issues WHERE id = ?").get(issueId) as
    { status: string } | null)?.status;
}

if (mode === "before-commit" || mode === "replay-before-commit") {
  // BEGIN is real on both backends. Park before the auto-start's first write,
  // after the prerequisite's own transaction has already committed.
  const original = db.transaction.bind(db);
  db.transaction = <T,>(fn: (...args: any[]) => T) => {
    const nested = db.inTransaction;
    return original((...args: any[]): T => {
      if (!nested && status(prerequisiteId) === "done" && status(dependentId) === "backlog") {
        announce(mode === "before-commit" ? "in-transaction" : "replay-before-commit");
        holdUntilKilled();
      }
      return fn(...args);
    });
  };
} else if (mode === "after-claim-commit" || mode === "after-done-commit") {
  const original = db.transaction.bind(db);
  let armed = true;
  db.transaction = <T,>(fn: (...args: any[]) => T) => {
    const nested = db.inTransaction;
    const run = original(fn);
    return (...args: any[]): T => {
      const result = run(...args);
      if (nested) return result;
      const reached = mode === "after-claim-commit"
        ? status(dependentId) === "todo"
        : status(prerequisiteId) === "done" && status(dependentId) === "backlog";
      if (armed && reached) {
        armed = false;
        announce(mode!);
        holdUntilKilled();
      }
      return result;
    };
  };
} else if (mode === "after-commit" || mode === "replay-after-commit") {
  const original = ctx.emitCommitEvents.bind(ctx);
  ctx.emitCommitEvents = (queue) => {
    const target = queue.workspace.find((event) =>
      (event.payload.issue as { id?: string } | undefined)?.id === dependentId);
    if (target) {
      announce(mode!);
      holdUntilKilled();
    }
    original(queue);
  };
}

try {
  if (mode!.startsWith("replay")) {
    store.dispatchPendingSystemEvents(new Date(replayAt ?? Date.now() + 5_000));
  } else {
    store.updateIssue(prerequisiteId, { status: "done" });
  }
  announce("completed");
} catch (error) {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
} finally {
  db.close();
}
