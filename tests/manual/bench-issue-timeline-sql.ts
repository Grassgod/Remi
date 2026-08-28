/**
 * MUL-172 diagnostic: count SQL statement executions and wall time for
 * `listIssueTimeline` as the comment count of an issue grows.
 *
 * Not a unit test — a measurement harness. Run with:
 *   bun run tests/manual/bench-issue-timeline-sql.ts
 */
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";

interface Counter {
  executions: number;
  bySql: Map<string, number>;
}

function instrument(db: Database, counter: Counter) {
  const rawQuery = db.query.bind(db);
  const rawRun = db.run.bind(db);
  const bump = (sql: string) => {
    counter.executions += 1;
    counter.bySql.set(sql, (counter.bySql.get(sql) ?? 0) + 1);
  };
  // @ts-expect-error -- deliberate monkey patch for measurement
  db.query = (sql: string) => {
    const stmt = rawQuery(sql);
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "all" || prop === "get" || prop === "run" || prop === "values") {
          return (...args: unknown[]) => {
            bump(sql);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  db.run = (sql: string, ...args: unknown[]) => {
    bump(sql);
    // @ts-expect-error -- forwarding
    return rawRun(sql, ...args);
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function scenario(commentCount: number, sessionCount: number, attachmentsPerComment: number) {
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const issue = store.createIssue({ title: `bench-${commentCount}`, workspaceId: "local" });

  const sessions: string[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    sessions.push(store.createIssueSession(issue.id, { title: `session-${i}` }).id);
  }

  for (let i = 0; i < commentCount; i += 1) {
    const issueSessionId = sessions.length ? sessions[i % sessions.length]! : undefined;
    const comment = store.createIssueComment(issue.id, {
      body: `comment body ${i} — ${"x".repeat(200)}`,
      authorType: "member",
      authorId: "mem_local_local",
      ...(issueSessionId ? { issueSessionId } : {}),
    });
    for (let a = 0; a < attachmentsPerComment; a += 1) {
      try {
        store.addCommentReaction(comment.id, { actorType: "member", actorId: "mem_local_local", emoji: a === 0 ? "👍" : "🎉" });
      } catch {
        // reaction shape mismatch is not the thing being measured
      }
    }
  }

  const counter: Counter = { executions: 0, bySql: new Map() };
  instrument(db, counter);

  // Warm once (statement cache) then measure.
  store.listIssueTimeline(issue.id, {});
  counter.executions = 0;
  counter.bySql.clear();

  const t0 = performance.now();
  const all = store.listIssueTimeline(issue.id, {});
  const t1 = performance.now();
  const allSql = counter.executions;
  const allTop = [...counter.bySql.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  counter.executions = 0;
  counter.bySql.clear();
  const targetSession = sessions[0];
  const t2 = performance.now();
  const scoped = targetSession
    ? store.listIssueTimeline(issue.id, { issueSessionId: targetSession })
    : [];
  const t3 = performance.now();
  const scopedSql = counter.executions;

  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const s = performance.now();
    store.listIssueTimeline(issue.id, {});
    samples.push(performance.now() - s);
  }

  db.close();
  return {
    commentCount,
    sessionCount,
    entriesAll: all.length,
    sqlAll: allSql,
    msAll: t1 - t0,
    msAllMedian: median(samples),
    entriesScoped: scoped.length,
    sqlScoped: scopedSql,
    msScoped: t3 - t2,
    topSql: allTop,
  };
}

const rows = [
  scenario(0, 1, 0),
  scenario(50, 1, 1),
  scenario(100, 1, 1),
  scenario(200, 3, 1),
  scenario(500, 3, 1),
  scenario(1000, 5, 1),
];

console.log("\n=== listIssueTimeline: SQL executions and wall time ===\n");
console.log(
  [
    "comments".padStart(9),
    "sessions".padStart(9),
    "entries".padStart(8),
    "SQL(all)".padStart(9),
    "ms(all)".padStart(9),
    "ms p50".padStart(8),
    "entries(1 sess)".padStart(16),
    "SQL(1 sess)".padStart(12),
    "ms(1 sess)".padStart(11),
  ].join(" "),
);
for (const r of rows) {
  console.log(
    [
      String(r.commentCount).padStart(9),
      String(r.sessionCount).padStart(9),
      String(r.entriesAll).padStart(8),
      String(r.sqlAll).padStart(9),
      r.msAll.toFixed(2).padStart(9),
      r.msAllMedian.toFixed(2).padStart(8),
      String(r.entriesScoped).padStart(16),
      String(r.sqlScoped).padStart(12),
      r.msScoped.toFixed(2).padStart(11),
    ].join(" "),
  );
}

console.log("\n=== hottest statements at 500 comments (full timeline) ===");
for (const [sql, n] of rows.find((r) => r.commentCount === 500)?.topSql ?? []) {
  console.log(`${String(n).padStart(6)}×  ${sql.replace(/\s+/g, " ").slice(0, 110)}`);
}
console.log();
