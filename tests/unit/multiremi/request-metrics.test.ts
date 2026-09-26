/**
 * MUL-367 — per-request API metrics.
 *
 * The three acceptance items from the Issue are (a) metric attribution under
 * concurrent interleaved requests, (b) `Server-Timing` format on the success,
 * 404, and 500 paths, and (c) slow-request logging that cannot leak the query
 * string, headers, body, or the real path. Each has its own describe block.
 *
 * The concurrency case is written so the interleaving is deterministic rather
 * than probabilistic: every handler parks on a promise it only resolves after
 * every other handler has reached the same point. `recordDbQuery` is synchronous
 * by construction (the PG bridge blocks on `Atomics.wait`), so the assertion is
 * that each request's accumulator contains exactly its own numbers — which is
 * only true if AsyncLocalStorage actually isolates the three contexts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { PostgresSyncDatabase, PostgresReplyTooLargeError, resetDbReplyLimitForTest } from "@multiremi/store/db/postgres.js";
import {
  createRequestMetricsMiddleware,
  drainRequestMetricsForTest,
  formatServerTiming,
  percentile,
  RequestMetricsRing,
  recordDbQuery,
  resolveRequestMetricsOptions,
  resetRequestMetricsForTest,
  startRequestMetricsSummary,
  summarizeWindow,
  type RequestMetricSample,
  type RequestMetricsOptions,
} from "@multiremi/observability/request-metrics.js";

const OPTIONS: RequestMetricsOptions = {
  enabled: true,
  slowRequestMs: 500,
  summaryIntervalMs: 60_000,
  summaryTopRoutes: 10,
  bufferCapacity: 256,
};

afterEach(() => {
  resetRequestMetricsForTest();
});

/** Parses a `Server-Timing` header into `{metric: {dur, desc}}`. */
function parseServerTiming(value: string | null): Record<string, { dur?: number; desc?: string }> {
  expect(value).toBeTruthy();
  const parsed: Record<string, { dur?: number; desc?: string }> = {};
  for (const part of value!.split(",")) {
    const [name, ...params] = part.trim().split(";");
    const entry: { dur?: number; desc?: string } = {};
    for (const param of params) {
      const [key, rawValue] = param.split("=");
      const unquoted = (rawValue ?? "").replace(/^"|"$/g, "");
      if (key === "dur") entry.dur = Number(unquoted);
      if (key === "desc") entry.desc = unquoted;
    }
    parsed[name!] = entry;
  }
  return parsed;
}

/** Captures `console.log` lines for assertions, then restores it. */
function captureConsoleLog<T>(run: () => Promise<T> | T): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return Promise.resolve()
    .then(run)
    .then((result) => ({ lines, result }))
    .finally(() => {
      console.log = original;
    });
}

describe("MUL-367 request metrics — Server-Timing format", () => {
  it("emits one decimal per duration and puts counts in desc", () => {
    expect(formatServerTiming({ totalMs: 12.34, dbMs: 4.5, dbParseMs: 0.26, dbQueries: 7, dbBytes: 12345 }))
      .toBe('total;dur=12.3, db;dur=4.5, dbp;dur=0.3, dbq;desc="7", dbb;desc="12345"');
  });

  it("keeps the documented shape on 200, 404, and a handler that throws 500", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));
    app.get("/api/issues/:id", async (c) => {
      recordDbQuery(4.56, 2048);
      return c.json({ ok: true });
    });
    app.get("/api/boom", () => {
      throw new Error("handler exploded");
    });
    app.onError((error, c) => c.json({ error: error.message }, 500));

    // `total` is the only duration that varies between runs; the rest is fixed by
    // the recorded DB numbers, which is what makes this a real assertion.
    const SHAPE = /^total;dur=\d+\.\d, db;dur=4\.6, dbp;dur=\d+\.\d, dbq;desc="1", dbb;desc="2048"$/;

    const ok = await app.request("/api/issues/iss_1?token=SECRET_Q");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("server-timing")).toMatch(SHAPE);

    const missing = await app.request("/api/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("server-timing"))
      .toMatch(/^total;dur=\d+\.\d, db;dur=0\.0, dbp;dur=0\.0, dbq;desc="0", dbb;desc="0"$/);

    const failed = await app.request("/api/boom");
    expect(failed.status).toBe(500);
    expect(failed.headers.get("server-timing"))
      .toMatch(/^total;dur=\d+\.\d, db;dur=0\.0, dbp;dur=0\.0, dbq;desc="0", dbb;desc="0"$/);
  });

  it("reports the route pattern, never the request path", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));
    app.get("/api/shares/:token", async (c) => {
      recordDbQuery(1, 1);
      return c.json({ ok: true });
    });

    const response = await app.request("/api/shares/SECRET_P");
    // The credential-shaped segment is replaced by the pattern; the header is
    // the only observable, and it must not contain the token.
    expect(response.headers.get("server-timing")).not.toContain("SECRET_P");
    expect(response.status).toBe(200);
  });
});

describe("MUL-367 request metrics — attribution under concurrent interleaving", () => {
  it("gives three interleaved requests only their own DB numbers", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));

    // Deterministic barrier: every handler parks once per await point and cannot
    // advance until all three have arrived at that same point, so the db writes
    // interleave in a fixed, provable order instead of a timing-dependent one.
    const PLANNED = [
      { path: "/api/issues/one", queries: [7, 11, 13] as const, bytes: [100, 200, 300] as const },
      { path: "/api/issues/two", queries: [13, 17, 19] as const, bytes: [1000, 2000, 3000] as const },
      { path: "/api/issues/three", queries: [23, 29, 31] as const, bytes: [9, 90, 900] as const },
    ];
    let waiting: Array<() => void> = [];
    const barrier = (): Promise<void> => new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === PLANNED.length) {
        const release = waiting;
        waiting = [];
        for (const resume of release) resume();
      }
    });

    for (const [index, plan] of PLANNED.entries()) {
      app.get(plan.path, async (c) => {
        for (const [queryIndex, waitMs] of plan.queries.entries()) {
          recordDbQuery(waitMs, plan.bytes[queryIndex]!);
          // Barrier between every write, so request 2's second query lands after
          // requests 1 and 3 have already written their first.
          await barrier();
        }
        return c.json({ id: index });
      });
    }

    const responses = await Promise.all(PLANNED.map((plan) => app.request(plan.path)));
    for (const [index, response] of responses.entries()) {
      const plan = PLANNED[index]!;
      const timing = parseServerTiming(response.headers.get("server-timing"));
      const expectedWait = plan.queries.reduce((total, value) => total + value, 0);
      const expectedBytes = plan.bytes.reduce((total, value) => total + value, 0);
      // A shared accumulator would show the sum of all three requests here.
      expect(timing.db!.dur, `${plan.path} db`).toBe(Math.round(expectedWait * 10) / 10);
      expect(timing.dbq!.desc, `${plan.path} dbq`).toBe(String(plan.queries.length));
      expect(timing.dbb!.desc, `${plan.path} dbb`).toBe(String(expectedBytes));
    }

    // The window buffer must agree with the headers it derived from: three
    // separate samples, each carrying its own request's numbers.
    const { samples } = drainRequestMetricsForTest();
    expect(samples).toHaveLength(PLANNED.length);
    for (const planned of PLANNED) {
      const stored = samples.find((entry) => entry.route === planned.path)!;
      expect(stored, `${planned.path} missing from the window`).toBeTruthy();
      expect(stored.dbMs).toBe(Math.round(planned.queries.reduce((total, value) => total + value, 0) * 10) / 10);
      expect(stored.dbQueries).toBe(planned.queries.length);
      expect(stored.dbBytes).toBe(planned.bytes.reduce((total, value) => total + value, 0));
      expect(stored.status).toBe(200);
    }
  });

  it("keeps concurrent requests separate even when they finish out of order", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));

    let unblockSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      unblockSlow = resolve;
    });
    app.get("/api/fast", async (c) => {
      recordDbQuery(1, 10);
      return c.json({ slow: false });
    });
    app.get("/api/slow", async (c) => {
      // Starts first, finishes last — the request context must follow the async
      // chain, not "whatever request is newest".
      await slowGate;
      recordDbQuery(2, 20);
      return c.json({ slow: true });
    });

    const slow = app.request("/api/slow");
    await Bun.sleep(5);
    const fast = await app.request("/api/fast");
    unblockSlow!();
    const slowResponse = await slow;

    expect(parseServerTiming(fast.headers.get("server-timing")).db!.dur).toBe(1);
    expect(parseServerTiming(slowResponse.headers.get("server-timing")).db!.dur).toBe(2);
  });
});

describe("MUL-367 request metrics — slow-request log privacy", () => {
  it("logs no query, header, body, or raw path value", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware({ ...OPTIONS, slowRequestMs: 0 }));
    app.post("/api/shares/:token/comments", async (c) => {
      await c.req.text();
      recordDbQuery(9.5, 4096);
      return c.json({ ok: true });
    });

    const { lines, result } = await captureConsoleLog(() => app.request("/api/shares/SECRET_P/comments?token=SECRET_Q", {
      method: "POST",
      headers: { Authorization: "Bearer SECRET_H", "Content-Type": "application/json" },
      body: JSON.stringify({ note: "SECRET_B" }),
    }));
    const response = await result;
    expect(response.status).toBe(200);

    const slowLines = lines.filter((line) => line.includes("api_slow_request"));
    expect(slowLines).toHaveLength(1);

    const raw = slowLines[0]!;
    for (const secret of ["SECRET_P", "SECRET_Q", "SECRET_H", "SECRET_B"]) {
      expect(raw, `slow log leaked ${secret}`).not.toContain(secret);
    }
    // Not even the query delimiter survives: the log carries no path at all.
    expect(raw).not.toContain("?token");

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.event).toBe("api_slow_request");
    expect(parsed.method).toBe("POST");
    expect(parsed.route).toBe("/api/shares/:token/comments");
    expect(parsed.status).toBe(200);
    expect(parsed.db_ms).toBe(9.5);
    expect(parsed.db_queries).toBe(1);
    expect(parsed.db_bytes).toBe(4096);
    expect(typeof parsed.total_ms).toBe("number");
    expect(typeof parsed.ts).toBe("string");
    // The exact field set is the contract the Issue fixed.
    expect(Object.keys(parsed).sort()).toEqual([
      "db_bytes", "db_ms", "db_parse_ms", "db_queries", "event", "method", "route", "status", "total_ms", "ts",
    ]);
  });

  it("uses <unmatched> for a request that matched no route", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware({ ...OPTIONS, slowRequestMs: 0 }));
    const { lines, result } = await captureConsoleLog(() => app.request("/totally/unknown?token=SECRET_Q"));
    expect((await result).status).toBe(404);
    const parsed = JSON.parse(lines.find((line) => line.includes("api_slow_request"))!) as Record<string, unknown>;
    expect(parsed.route).toBe("<unmatched>");
    expect(JSON.stringify(parsed)).not.toContain("SECRET_Q");
  });

  it("stays silent below the threshold and logs above it", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware({ ...OPTIONS, slowRequestMs: 5_000 }));
    app.get("/api/health", (c) => c.json({ ok: true }));
    const quiet = await captureConsoleLog(() => app.request("/api/health"));
    expect(quiet.lines.filter((line) => line.includes("api_slow_request"))).toHaveLength(0);

    const loud = new Hono();
    loud.use("*", createRequestMetricsMiddleware({ ...OPTIONS, slowRequestMs: 0 }));
    loud.get("/api/health", (c) => c.json({ ok: true }));
    const noisy = await captureConsoleLog(() => loud.request("/api/health"));
    expect(noisy.lines.filter((line) => line.includes("api_slow_request"))).toHaveLength(1);
  });

  it("records nothing and adds no header when metrics are disabled", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware({ ...OPTIONS, enabled: false }));
    app.get("/api/health", async (c) => {
      recordDbQuery(10, 10);
      return c.json({ ok: true });
    });
    const { lines, result } = await captureConsoleLog(() => app.request("/api/health"));
    expect((await result).headers.get("server-timing")).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe("MUL-367 request metrics — environment switches", () => {
  it("defaults to enabled with a 500 ms threshold and a one-minute summary", () => {
    expect(resolveRequestMetricsOptions({})).toEqual({
      enabled: true,
      slowRequestMs: 500,
      summaryIntervalMs: 60_000,
      summaryTopRoutes: 10,
      bufferCapacity: 4096,
    });
  });

  it("treats 0/false/off as off and ignores unparsable numbers", () => {
    for (const off of ["0", "false", "FALSE", "off", " off "]) {
      expect(resolveRequestMetricsOptions({ MULTIREMI_REQUEST_METRICS: off }).enabled, off).toBe(false);
    }
    expect(resolveRequestMetricsOptions({ MULTIREMI_REQUEST_METRICS: "1" }).enabled).toBe(true);

    const invalid = resolveRequestMetricsOptions({
      MULTIREMI_SLOW_REQUEST_MS: "not-a-number",
      MULTIREMI_METRICS_SUMMARY_INTERVAL_MS: "0",
    });
    expect(invalid.slowRequestMs).toBe(500);
    expect(invalid.summaryIntervalMs).toBe(60_000);
  });

  it("accepts an explicit 0 threshold so every request can be logged", () => {
    expect(resolveRequestMetricsOptions({ MULTIREMI_SLOW_REQUEST_MS: "0" }).slowRequestMs).toBe(0);
    expect(resolveRequestMetricsOptions({ MULTIREMI_METRICS_SUMMARY_INTERVAL_MS: "5000" }).summaryIntervalMs)
      .toBe(5000);
  });
});

describe("MUL-367 request metrics — window aggregation", () => {
  const sample = (overrides: Partial<RequestMetricSample>): RequestMetricSample => ({
    method: "GET",
    route: "/api/issues",
    status: 200,
    totalMs: 10,
    dbMs: 1,
    dbParseMs: 0,
    dbQueries: 1,
    dbBytes: 100,
    slow: false,
    ...overrides,
  });

  it("uses nearest-rank percentiles", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("ranks routes by sum_ms and keeps only the requested top N", () => {
    const summary = summarizeWindow({
      windowMs: 60_000,
      samples: [
        sample({ route: "/api/a", totalMs: 30 }),
        sample({ route: "/api/a", totalMs: 30 }),
        sample({ method: "POST", route: "/api/b", totalMs: 100 }),
      ],
      dropped: 0,
      dbMs: 1000,
      dbQueries: 42,
      eventLoopLagMaxMs: 12.34,
      topRoutes: 1,
    });

    expect(summary.routes).toHaveLength(1);
    expect(summary.routes[0]).toMatchObject({ method: "POST", route: "/api/b", count: 1, sum_ms: 100 });
    expect(summary.requests).toBe(3);
    expect(summary.db_queries).toBe(42);
    expect(summary.event_loop_lag_max_ms).toBe(12.3);
  });

  it("computes db_busy_pct from process DB time over the window", () => {
    const summary = summarizeWindow({
      windowMs: 10_000,
      samples: [sample({ status: 503, slow: true }), sample({ status: 200 })],
      dropped: 7,
      dbMs: 2500,
      dbQueries: 5,
      eventLoopLagMaxMs: 0,
      topRoutes: 10,
    });

    expect(summary.db_busy_pct).toBe(25);
    expect(summary.status_5xx).toBe(1);
    expect(summary.slow).toBe(1);
    expect(summary.dropped).toBe(7);
    expect(summary.window_ms).toBe(10_000);
    expect(summary.routes.map((route) => route.route)).toEqual(["/api/issues"]);
  });

  it("reports an idle window as a zeroed heartbeat", () => {
    const summary = summarizeWindow({
      windowMs: 60_000,
      samples: [],
      dropped: 0,
      dbMs: 0,
      dbQueries: 0,
      eventLoopLagMaxMs: 0,
      topRoutes: 10,
      now: new Date("2026-09-24T12:00:00.000Z"),
    });
    expect(summary).toEqual({
      event: "api_minute_summary",
      ts: "2026-09-24T12:00:00.000Z",
      window_ms: 60_000,
      requests: 0,
      status_5xx: 0,
      slow: 0,
      dropped: 0,
      db_busy_pct: 0,
      db_queries: 0,
      event_loop_lag_max_ms: 0,
      routes: [],
    });
  });

  it("counts samples past the fixed capacity as dropped and keeps the newest ones", () => {
    const ring = new RequestMetricsRing(2);
    ring.record(sample({ route: "/api/first" }));
    ring.record(sample({ route: "/api/second" }));
    ring.record(sample({ route: "/api/third" }));

    const { samples, dropped } = ring.drain();
    expect(dropped).toBe(1);
    expect(samples.map((entry) => entry.route)).toEqual(["/api/second", "/api/third"]);
    // Draining resets the window so the next summary covers only new traffic.
    expect(ring.drain()).toEqual({ samples: [], dropped: 0 });
  });
});

describe("MUL-367 request metrics — minute summary timer", () => {
  it("emits one summary line per interval with the fixed field set", async () => {
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware({ ...OPTIONS, bufferCapacity: 64 }));
    app.get("/api/issues/:id", async (c) => {
      recordDbQuery(2, 512);
      return c.json({ ok: true });
    });
    const runtime = startRequestMetricsSummary({ ...OPTIONS, bufferCapacity: 64, summaryTopRoutes: 10 });
    expect(runtime).not.toBeNull();

    const { lines } = await captureConsoleLog(async () => {
      await app.request("/api/issues/iss_1");
      runtime!.flush();
    });

    const summaryLines = lines.filter((line) => line.includes("api_minute_summary"));
    expect(summaryLines).toHaveLength(1);
    const summary = JSON.parse(summaryLines[0]!) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "db_busy_pct", "db_queries", "dropped", "event", "event_loop_lag_max_ms",
      "requests", "routes", "slow", "status_5xx", "ts", "window_ms",
    ]);
    expect(summary.requests).toBe(1);
    expect(summary.db_queries).toBe(1);
    expect(summary.routes).toEqual([
      { method: "GET", route: "/api/issues/:id", count: 1, p50_ms: expect.any(Number), p95_ms: expect.any(Number), sum_ms: expect.any(Number) },
    ]);

    runtime!.stop();
  });

  it("creates no timer when metrics are disabled", () => {
    expect(startRequestMetricsSummary({ ...OPTIONS, enabled: false })).toBeNull();
  });
});

/**
 * Optional real-database evidence. The Issue made this "nice to have": it proves
 * that a genuine `PostgresSyncDatabase` round trip actually feeds `dbq`/`dbb`,
 * which the pure tests above can only simulate. Skipped, never failed, when no
 * Postgres is reachable — the same contract as `multiremi-postgres-store.test.ts`.
 */
const PG_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";

async function postgresReachable(): Promise<boolean> {
  try {
    const probe = new Bun.SQL(PG_URL, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await postgresReachable();
if (!pgAvailable) {
  console.warn(`[mul367-metrics] Postgres not reachable at ${PG_URL} — skipping the real-bridge checks.`);
}

describe.skipIf(!pgAvailable)("MUL-367 request metrics — real Postgres bridge", () => {
  it("attributes real dbq/dbb from the synchronous bridge to the request", async () => {
    const database = new PostgresSyncDatabase(PG_URL);
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));
    app.get("/api/count", (c) => {
      // Two statements, one of them returning rows, so both count and bytes are
      // non-trivial. `init` already ran in the constructor and must not appear.
      database.run("SELECT 1");
      const rows = database.query("SELECT 42 AS answer").all() as Array<{ answer: number }>;
      return c.json({ rows });
    });

    try {
      const response = await app.request("/api/count");
      expect(response.status).toBe(200);
      const timing = parseServerTiming(response.headers.get("server-timing"));
      expect(Number(timing.dbq!.desc)).toBeGreaterThan(0);
      expect(Number(timing.dbb!.desc)).toBeGreaterThan(0);
      expect(timing.db!.dur).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});

/**
 * MUL-386 C.1 — the PG bridge reply guardrails.
 *
 * Two behaviours, both about the number that crossed the bridge:
 *   - a reply over 1 MB logs `api_large_db_reply`, with the Hono route PATTERN
 *     and the byte count and nothing else;
 *   - a reply over the hard limit is refused before decode/parse.
 *
 * The privacy assertions are structural: the emitted line is compared against the
 * exact expected key set, so a future field (SQL text, a parameter, the real path)
 * fails the test instead of quietly shipping.
 */
describe("MUL-386 bridge reply guardrails", () => {
  /** Big enough to exceed the 1 MB default warning threshold. */
  const BIG_ROWS = "x".repeat(1_200_000);

  /** Collect stdout lines, tolerating a throwing operation so lines survive. */
  async function capture<T>(run: () => Promise<T> | T): Promise<{ lines: string[]; result: T | null; error: unknown }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map((arg) => String(arg)).join(" ")); };
    try {
      return { lines, result: await run(), error: null };
    } catch (error) {
      return { lines, result: null, error };
    } finally {
      console.log = original;
    }
  }

  it("logs api_large_db_reply with the route pattern and byte count only", async () => {
    resetDbReplyLimitForTest();
    const database = new PostgresSyncDatabase(PG_URL);
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));
    app.get("/api/leaky/:id/reply", (c) => {
      // The secret lives in the path and in a parameter; neither may reach the log.
      const rows = database.query("SELECT ?::text AS payload").all(BIG_ROWS) as Array<{ payload: string }>;
      return c.json({ bytes: rows[0]?.payload.length ?? 0 });
    });

    try {
      const { lines } = await capture(() => app.request("/api/leaky/super-secret-id/reply"));
      const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.event === "api_large_db_reply");
      expect(event).toBeDefined();
      // Exact key set: no SQL text, no params, no real path, no query string.
      expect(Object.keys(event!).sort()).toEqual(["bytes", "event", "method", "route", "ts"]);
      expect(event!.route).toBe("/api/leaky/:id/reply");
      expect(event!.method).toBe("GET");
      expect(Number(event!.bytes)).toBeGreaterThan(1_048_576);
      for (const line of lines) {
        expect(line).not.toContain("super-secret-id");
        expect(line).not.toContain("SELECT");
        expect(line).not.toContain(BIG_ROWS.slice(0, 40));
      }
    } finally {
      database.close();
    }
  });

  it("labels a query with no request context as <background>", async () => {
    resetDbReplyLimitForTest();
    const database = new PostgresSyncDatabase(PG_URL);
    try {
      const { lines } = await capture(() => {
        database.query("SELECT ?::text AS payload").all(BIG_ROWS);
      });
      const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.event === "api_large_db_reply");
      expect(event).toBeDefined();
      expect(event!.route).toBe("<background>");
      expect(event!.method).toBe("<background>");
    } finally {
      database.close();
    }
  });

  it("refuses a reply over the hard limit before decoding it", async () => {
    // 2 MB limit, 4 MB payload: refused before any decode/parse work happens.
    process.env.MULTIREMI_PG_REPLY_MAX_BYTES = String(2 * 1_048_576);
    resetDbReplyLimitForTest();
    const database = new PostgresSyncDatabase(PG_URL);
    const payload = "y".repeat(4 * 1_048_576);
    try {
      const first = await capture(() => database.query("SELECT ?::text AS payload").all(payload));
      expect(first.error).toBeInstanceOf(PostgresReplyTooLargeError);
      const rejected = first.lines
        .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
        .find((line) => line?.event === "api_db_reply_rejected");
      expect(rejected).toBeDefined();
      // Exact key set: no SQL text, no parameters, not the payload.
      expect(Object.keys(rejected!).sort()).toEqual(["bytes", "event", "max_bytes", "method", "route", "ts"]);
      expect(rejected!.bytes).toBeGreaterThan(2 * 1_048_576);
      expect(rejected!.max_bytes).toBe(2 * 1_048_576);
      // No request context means the background label, seen from the bridge side.
      expect(rejected!.route).toBe("<background>");

      const message = (first.error as Error).message;
      expect(message).toMatch(/postgres reply of \d+ bytes exceeds \d+ bytes bridge limit; paginate or project columns/);
      expect(message).not.toContain("SELECT");
      expect(message).not.toContain("y".repeat(16));
    } finally {
      delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      resetDbReplyLimitForTest();
      database.close();
    }
  });

  it("labels a rejected reply with the handler's route pattern", async () => {
    process.env.MULTIREMI_PG_REPLY_MAX_BYTES = String(2 * 1_048_576);
    resetDbReplyLimitForTest();
    const database = new PostgresSyncDatabase(PG_URL);
    const payload = "y".repeat(4 * 1_048_576);
    const app = new Hono();
    app.use("*", createRequestMetricsMiddleware(OPTIONS));
    app.get("/api/leaky/:id/reply", () => {
      database.query("SELECT ?::text AS payload").all(payload);
      return new Response("unreachable");
    });
    try {
      // Hono turns the handler's throw into a 500 response; the point here is the
      // route label on the guardrail line, not the request's outcome.
      const { lines } = await capture(async () => {
        const response = await app.request("/api/leaky/hard-secret-id/reply");
        // Hono's default error path; asserting the body keeps the case honest
        // about the request having actually failed rather than being swallowed.
        return { status: response.status, body: await response.text() };
      });
      const rejected = lines
        .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
        .find((line) => line?.event === "api_db_reply_rejected");
      expect(rejected).toBeDefined();
      // The handler's pattern, never the wildcard middleware route and never the
      // real path — the same contract `api_slow_request` follows.
      expect(rejected!.route).toBe("/api/leaky/:id/reply");
      expect(rejected!.method).toBe("GET");
      for (const line of lines) {
        expect(line).not.toContain("hard-secret-id");
        expect(line).not.toContain("SELECT");
      }
    } finally {
      delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      resetDbReplyLimitForTest();
      database.close();
    }
  });

  it("disables the hard limit when the override is 0", async () => {
    process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "0";
    resetDbReplyLimitForTest();
    const database = new PostgresSyncDatabase(PG_URL);
    try {
      const { result } = await capture(() => database.query("SELECT ?::text AS payload").all("z".repeat(9 * 1_048_576)));
      expect((result as Array<{ payload: string }>)[0]!.payload.length).toBe(9 * 1_048_576);
    } finally {
      delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      resetDbReplyLimitForTest();
      database.close();
    }
  });
});
