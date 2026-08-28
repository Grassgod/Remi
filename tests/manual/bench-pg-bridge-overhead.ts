/**
 * MUL-172 diagnostic: measure the per-statement floor cost of the
 * Worker + SharedArrayBuffer + Atomics.wait bridge in
 * `packages/server/src/store/db/postgres.ts`, with the Postgres query itself
 * replaced by a zero-latency echo.
 *
 * This isolates bridge overhead (postMessage + thread block + JSON encode /
 * decode + SAB copy) from real database time, so the SQL counts measured by
 * bench-issue-timeline-sql.ts can be turned into a production floor.
 *
 * Run: bun run tests/manual/bench-pg-bridge-overhead.ts
 */
const WORKER_SRC = `
const STATUS_DONE = 1;
self.onmessage = (event) => {
  const { control, data, rows } = event.data;
  const ctl = new Int32Array(control);
  const buf = new Uint8Array(data);
  const payload = JSON.stringify({ rows, count: rows.length });
  const bytes = new TextEncoder().encode(payload);
  buf.set(bytes, 0);
  Atomics.store(ctl, 1, bytes.length);
  Atomics.store(ctl, 0, STATUS_DONE);
  Atomics.notify(ctl, 0);
};
`;

const workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" }));

const control = new SharedArrayBuffer(16);
const data = new SharedArrayBuffer(64 * 1024 * 1024); // same size as RESULT_BUFFER_BYTES
const ctl = new Int32Array(control);
const buf = new Uint8Array(data);
const worker = new Worker(workerUrl);

function roundTrip(rows: unknown[]): unknown {
  Atomics.store(ctl, 0, 0);
  worker.postMessage({ control, data, rows });
  const waited = Atomics.wait(ctl, 0, 0, 10_000);
  if (waited === "timed-out") throw new Error("bridge timed out");
  const len = Atomics.load(ctl, 1);
  return JSON.parse(new TextDecoder().decode(buf.slice(0, len)));
}

function measure(label: string, rows: unknown[], iterations: number) {
  for (let i = 0; i < 200; i += 1) roundTrip(rows); // warm
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t = performance.now();
    roundTrip(rows);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `${label.padEnd(34)} mean ${(mean * 1000).toFixed(1).padStart(7)}µs   p50 ${(p50 * 1000).toFixed(1).padStart(7)}µs   p95 ${(p95 * 1000).toFixed(1).padStart(7)}µs`,
  );
  return p50;
}

// Shapes that mirror what the timeline N+1 actually round-trips.
const emptyRows: unknown[] = [];
const oneReaction = [{ id: "rx_abcdefghij", comment_id: "cmt_abcdefghij", workspace_id: "local", actor_type: "member", actor_id: "mem_local_local", emoji: "👍", created_at: "2026-08-28T00:00:00.000Z" }];
const oneComment = [{
  id: "cmt_abcdefghij", issue_id: "iss_abcdefghij", issue_session_id: "isn_abcdefghij",
  parent_id: null, author_type: "member", author_id: "mem_local_local", type: "comment",
  body: "x".repeat(400), metadata: "{}", task_id: null, resolved_at: null,
  resolved_by_type: null, resolved_by_id: null,
  created_at: "2026-08-28T00:00:00.000Z", updated_at: "2026-08-28T00:00:00.000Z",
}];

console.log("\n=== pg sync-bridge floor cost per statement (Postgres time excluded) ===\n");
const pEmpty = measure("empty result (0 rows)", emptyRows, 3000);
const pReaction = measure("1 reaction row", oneReaction, 3000);
const pComment = measure("1 comment row (400B body)", oneComment, 3000);
const pBatch = measure("500 comment rows (one batched query)", Array.from({ length: 500 }, () => oneComment[0]), 500);

console.log("\n=== extrapolation to listIssueTimeline (measured SQL counts) ===\n");
console.log("comments  SQL   bridge-floor ms   (+0ms Postgres; production adds real query time on top)");
for (const [comments, sql] of [[0, 5], [50, 205], [100, 405], [200, 805], [500, 2005], [1000, 4005]] as const) {
  // Shape mix per comment: 2× single-comment lookup, 1× reactions, 1× attachments.
  const perComment = 2 * pComment + pReaction + pEmpty;
  const floor = comments === 0 ? sql * pEmpty : comments * perComment + (sql - comments * 4) * pComment;
  console.log(
    `${String(comments).padStart(8)}  ${String(sql).padStart(4)}   ${floor.toFixed(1).padStart(15)}`,
  );
}
console.log(
  `\nbatched alternative (1 comments query + 1 reactions query + 1 attachments query): ~${(3 * pBatch).toFixed(1)} ms at 500 comments\n`,
);

worker.terminate();
