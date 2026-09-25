/**
 * Per-request API performance metrics (MUL-367).
 *
 * WHY: the API previously had no per-request timing at all, so "the web app is
 * slow" could only be investigated with a temporary nginx timing log and manual
 * PostgreSQL sampling. Everything here answers one question per request — how
 * much wall time it took, how much of that was spent blocked on the synchronous
 * Postgres bridge, and how many bytes crossed that bridge — and ships the answer
 * three ways: a `Server-Timing` response header for DevTools, one stdout line
 * per slow request, and one stdout line per minute aggregating the window.
 *
 * COST MODEL (this runs on every request, so the rules are structural):
 *   - `recordDbQuery` / `recordDbParse` are O(1) property increments behind one
 *     boolean. No allocation, no timers, no IO.
 *   - Per-request values ride on one AsyncLocalStorage store per request. The PG
 *     bridge is synchronous, so whatever is running during `Atomics.wait` is by
 *     construction the request that issued the query.
 *   - The window buffer is a fixed-capacity set of typed arrays with route and
 *     method strings interned to integer ids; it never grows per request.
 *   - The only periodic work is the summary timer plus its event-loop-lag probe.
 *     Both are `unref()`ed and torn down by `server.stop()`.
 *   - Log events are plain `console.log(JSON.stringify(...))` lines. Using
 *     `createLogger` was checked and rejected: only INFO reaches stdout (WARN and
 *     ERROR go to stderr), the human-readable tag means one entry is not one JSON
 *     object, and once `initLogPersistence()` has run every entry becomes an
 *     `appendFileSync` — synchronous disk IO on the request path.
 *
 * PRIVACY: recorded routes are Hono route PATTERNS (`/api/issues/:id`), never
 * the request path or query. The real path of `/api/shares/:token` contains a
 * credential, which is precisely why the pattern is the only safe thing to emit.
 * No header, body, user, or token value is recorded anywhere in this module.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";

/** Per-request accumulator. One instance per request, never shared. */
interface RequestDbMetrics {
  dbMs: number;
  dbQueries: number;
  dbBytes: number;
  dbParseMs: number;
}

/** One finished request, as stored in the window buffer. */
export interface RequestMetricSample {
  method: string;
  route: string;
  status: number;
  totalMs: number;
  dbMs: number;
  dbParseMs: number;
  dbQueries: number;
  dbBytes: number;
  slow: boolean;
}

export interface RouteSummary {
  method: string;
  route: string;
  count: number;
  p50_ms: number;
  p95_ms: number;
  sum_ms: number;
}

export interface MinuteSummary {
  event: "api_minute_summary";
  ts: string;
  window_ms: number;
  requests: number;
  status_5xx: number;
  slow: number;
  dropped: number;
  db_busy_pct: number;
  db_queries: number;
  event_loop_lag_max_ms: number;
  routes: RouteSummary[];
}

export interface RequestMetricsOptions {
  /** Overall switch. When false nothing is measured, buffered, or logged. */
  enabled: boolean;
  /** Requests above this total are logged as `api_slow_request`. */
  slowRequestMs: number;
  /** Cadence of the `api_minute_summary` line. */
  summaryIntervalMs: number;
  /** How many routes the summary keeps, ranked by `sum_ms`. */
  summaryTopRoutes: number;
  /** Fixed window-buffer capacity; older samples are dropped once it wraps. */
  bufferCapacity: number;
}

export const DEFAULT_SLOW_REQUEST_MS = 500;
export const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;
export const DEFAULT_SUMMARY_TOP_ROUTES = 10;
export const DEFAULT_BUFFER_CAPACITY = 4096;
/** The lag probe samples inside the 200–500 ms band the Issue asked for. */
const EVENT_LOOP_LAG_INTERVAL_MS = 250;

const requestContext = new AsyncLocalStorage<RequestDbMetrics>();

/**
 * Process-wide DB counters, shared by every request AND by background work.
 *
 * The bridge is synchronous on the main thread, so this total is the sum of all
 * time the process spent blocked on PostgreSQL — that is what makes it usable as
 * the denominator of the DB-busy share.
 */
const processDbCounters = { dbMs: 0, dbQueries: 0, dbBytes: 0 };

/**
 * Module-level switch so the DB hook stays a single boolean test when metrics
 * are off. `createRequestMetricsMiddleware` writes it from its own options, so an
 * app built with metrics disabled leaves the hot path untouched.
 */
let requestMetricsEnabled = true;
let warnEmitted = false;

/** Never throws: a broken probe must not break the request it is measuring. */
function warnOnce(message: string, error: unknown): void {
  if (warnEmitted) return;
  warnEmitted = true;
  try {
    console.warn(`[request-metrics] ${message}: ${(error as Error)?.message ?? String(error)}`);
  } catch {
    // A hostile console is not worth failing a request over.
  }
}

const finite = (value: number, fallback = 0): number => (Number.isFinite(value) && value > 0 ? value : fallback);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

// ────────────────────────────── DB hook ──────────────────────────────

/**
 * Record one `sql` round trip through the Postgres bridge.
 *
 * Always accumulates into the process counters (background jobs' DB time is
 * part of the busy share) and, when a request context is active, into that
 * request. Called by `PgBridge.request` only for SQL, never for `init`.
 */
export function recordDbQuery(waitMs: number, bytes: number): void {
  if (!requestMetricsEnabled) return;
  const waited = finite(waitMs);
  const size = finite(bytes);
  processDbCounters.dbMs += waited;
  processDbCounters.dbQueries += 1;
  processDbCounters.dbBytes += size;
  const request = requestContext.getStore();
  if (request) {
    request.dbMs += waited;
    request.dbQueries += 1;
    request.dbBytes += size;
  }
}

/**
 * Main-thread `TextDecoder` + `JSON.parse` cost of a bridge reply.
 *
 * Request-scoped only: it exists to test the MUL-366 "serialization + GC"
 * hypothesis from `Server-Timing` (`dbp`) and the slow-request log, and it does
 * not belong in the process-level DB-busy share.
 */
export function recordDbParse(parseMs: number): void {
  if (!requestMetricsEnabled) return;
  const request = requestContext.getStore();
  if (request) request.dbParseMs += finite(parseMs);
}

// ────────────────────────────── window buffer ──────────────────────────────

/**
 * Fixed-capacity ring buffer of finished requests.
 *
 * Once full it overwrites the oldest sample and counts the loss in `dropped`,
 * so the summary always describes the most recent window instead of silently
 * reporting on a stale prefix. Routes and methods are interned to integer ids in
 * append-only tables, which is what keeps a per-request record allocation-free
 * apart from the id lookup.
 */
export class RequestMetricsRing {
  private readonly routes = new Map<string, number>();
  private readonly routeNames: string[] = [];
  private readonly methods = new Map<string, number>();
  private readonly methodNames: string[] = [];
  private readonly totalMs: Float64Array;
  private readonly dbMs: Float64Array;
  private readonly dbParseMs: Float64Array;
  private readonly dbQueries: Uint32Array;
  private readonly dbBytes: Float64Array;
  private readonly statuses: Uint16Array;
  private readonly routeIds: Int32Array;
  private readonly methodIds: Uint8Array;
  private readonly slowFlags: Uint8Array;
  private cursor = 0;
  private size = 0;
  private dropped = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`request metrics buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.totalMs = new Float64Array(capacity);
    this.dbMs = new Float64Array(capacity);
    this.dbParseMs = new Float64Array(capacity);
    this.dbQueries = new Uint32Array(capacity);
    this.dbBytes = new Float64Array(capacity);
    this.statuses = new Uint16Array(capacity);
    this.routeIds = new Int32Array(capacity);
    this.methodIds = new Uint8Array(capacity);
    this.slowFlags = new Uint8Array(capacity);
  }

  private intern(table: Map<string, number>, names: string[], value: string): number {
    const existing = table.get(value);
    if (existing !== undefined) return existing;
    const id = names.length;
    names.push(value);
    table.set(value, id);
    return id;
  }

  record(sample: RequestMetricSample): void {
    const index = this.cursor;
    if (this.size === this.capacity) this.dropped += 1;
    else this.size += 1;
    this.totalMs[index] = finite(sample.totalMs);
    this.dbMs[index] = finite(sample.dbMs);
    this.dbParseMs[index] = finite(sample.dbParseMs);
    this.dbQueries[index] = Math.min(0xffff_ffff, Math.max(0, Math.trunc(finite(sample.dbQueries))));
    this.dbBytes[index] = finite(sample.dbBytes);
    this.statuses[index] = Math.min(65_535, Math.max(0, Math.trunc(sample.status)));
    this.routeIds[index] = this.intern(this.routes, this.routeNames, sample.route);
    this.methodIds[index] = Math.min(255, this.intern(this.methods, this.methodNames, sample.method));
    this.slowFlags[index] = sample.slow ? 1 : 0;
    this.cursor = (index + 1) % this.capacity;
  }

  /** Empty the buffer and hand back its samples in arrival order. */
  drain(): { samples: RequestMetricSample[]; dropped: number } {
    const samples: RequestMetricSample[] = [];
    const oldest = this.size === this.capacity ? this.cursor : 0;
    for (let offset = 0; offset < this.size; offset += 1) {
      const index = (oldest + offset) % this.capacity;
      samples.push({
        method: this.methodNames[this.methodIds[index]!] ?? "UNKNOWN",
        route: this.routeNames[this.routeIds[index]!] ?? "<unmatched>",
        status: this.statuses[index]!,
        totalMs: this.totalMs[index]!,
        dbMs: this.dbMs[index]!,
        dbParseMs: this.dbParseMs[index]!,
        dbQueries: this.dbQueries[index]!,
        dbBytes: this.dbBytes[index]!,
        slow: this.slowFlags[index] === 1,
      });
    }
    const dropped = this.dropped;
    this.size = 0;
    this.cursor = 0;
    this.dropped = 0;
    return { samples, dropped };
  }
}

/**
 * The process-wide buffer, created on first use and re-created only when the
 * requested capacity changes. Requests and the summary timer must share it, so
 * it lives at module scope rather than on the app.
 */
let ring: RequestMetricsRing | null = null;

function ringFor(capacity: number): RequestMetricsRing {
  if (!ring || ring.capacity !== capacity) ring = new RequestMetricsRing(capacity);
  return ring;
}

// ────────────────────────────── aggregation ──────────────────────────────

/**
 * Nearest-rank percentile, matching the convention already used by
 * `tests/manual/bench-task-list-pagination.ts` and the API baseline scripts so
 * numbers from these logs are comparable with the existing reports.
 */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export interface WindowSummaryInput {
  /** Actual elapsed time covered by these samples, in milliseconds. */
  windowMs: number;
  samples: RequestMetricSample[];
  dropped: number;
  /** Process-level DB time attributed to this window. */
  dbMs: number;
  /** Process-level SQL count for this window. */
  dbQueries: number;
  eventLoopLagMaxMs: number;
  topRoutes: number;
  /** Injectable clock so tests can pin `ts`. */
  now?: Date;
}

/**
 * Pure window aggregation: the whole summary line is derived here, so the
 * shape, the ranking, and the busy share can be asserted without a live timer.
 */
export function summarizeWindow(input: WindowSummaryInput): MinuteSummary {
  const windowMs = finite(input.windowMs);
  const groups = new Map<string, { method: string; route: string; durations: number[] }>();
  let status5xx = 0;
  let slow = 0;
  for (const sample of input.samples) {
    if (sample.status >= 500) status5xx += 1;
    if (sample.slow) slow += 1;
    const key = `${sample.method} ${sample.route}`;
    const group = groups.get(key);
    if (group) group.durations.push(sample.totalMs);
    else groups.set(key, { method: sample.method, route: sample.route, durations: [sample.totalMs] });
  }

  const routes: RouteSummary[] = [...groups.values()].map((group) => ({
    method: group.method,
    route: group.route,
    count: group.durations.length,
    p50_ms: round1(percentile(group.durations, 0.5)),
    p95_ms: round1(percentile(group.durations, 0.95)),
    sum_ms: round1(group.durations.reduce((total, duration) => total + duration, 0)),
  }));
  routes.sort((left, right) => right.sum_ms - left.sum_ms
    || right.count - left.count
    || `${left.method} ${left.route}`.localeCompare(`${right.method} ${right.route}`));

  const top = Math.max(0, Math.trunc(input.topRoutes));
  return {
    event: "api_minute_summary",
    ts: (input.now ?? new Date()).toISOString(),
    window_ms: Math.round(windowMs),
    requests: input.samples.length,
    status_5xx: status5xx,
    slow,
    dropped: Math.max(0, Math.trunc(input.dropped)),
    db_busy_pct: windowMs > 0 ? round2((finite(input.dbMs) / windowMs) * 100) : 0,
    db_queries: Math.max(0, Math.trunc(finite(input.dbQueries))),
    event_loop_lag_max_ms: round1(finite(input.eventLoopLagMaxMs)),
    routes: routes.slice(0, top),
  };
}

// ────────────────────────────── configuration ──────────────────────────────

function envEnabled(value: string | undefined, fallback = true): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function envNumber(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Resolve the runtime configuration. Defaults are the ones the Issue fixed:
 * metrics on, 500 ms slow-request threshold, one summary per minute.
 */
export function resolveRequestMetricsOptions(
  env: Record<string, string | undefined> = process.env,
): RequestMetricsOptions {
  return {
    enabled: envEnabled(env.MULTIREMI_REQUEST_METRICS),
    slowRequestMs: envNumber(env.MULTIREMI_SLOW_REQUEST_MS, DEFAULT_SLOW_REQUEST_MS, 0),
    summaryIntervalMs: envNumber(
      env.MULTIREMI_METRICS_SUMMARY_INTERVAL_MS,
      DEFAULT_SUMMARY_INTERVAL_MS,
      1,
    ),
    summaryTopRoutes: envNumber(env.MULTIREMI_METRICS_SUMMARY_TOP_N, DEFAULT_SUMMARY_TOP_ROUTES, 0),
    bufferCapacity: envNumber(env.MULTIREMI_METRICS_BUFFER_SIZE, DEFAULT_BUFFER_CAPACITY, 1),
  };
}

// ────────────────────────────── Server-Timing ──────────────────────────────

/**
 * `total;dur=12.3, db;dur=4.5, dbp;dur=0.2, dbq;desc="7", dbb;desc="12345"`.
 *
 * Durations carry exactly one decimal as the Issue specified; the counts ride in
 * `desc` because Server-Timing metrics are numerically typed.
 */
export function formatServerTiming(input: {
  totalMs: number;
  dbMs: number;
  dbParseMs: number;
  dbQueries: number;
  dbBytes: number;
}): string {
  return [
    `total;dur=${finite(input.totalMs).toFixed(1)}`,
    `db;dur=${finite(input.dbMs).toFixed(1)}`,
    `dbp;dur=${finite(input.dbParseMs).toFixed(1)}`,
    `dbq;desc="${Math.max(0, Math.trunc(finite(input.dbQueries)))}"`,
    `dbb;desc="${Math.max(0, Math.trunc(finite(input.dbBytes)))}"`,
  ].join(", ");
}

/**
 * Attach the header without being able to break the response.
 *
 * `c.header()` re-wraps a finalized response, which is the normal path. If the
 * runtime hands back immutable headers, the Issue's documented fallback applies:
 * rebuild the response from the existing one and set the header there.
 */
function applyServerTiming(c: Context, value: string): void {
  try {
    c.header("Server-Timing", value);
    return;
  } catch {
    // fall through to the rebuild path
  }
  try {
    const rebuilt = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers: c.res.headers,
    });
    rebuilt.headers.set("Server-Timing", value);
    c.res = rebuilt;
  } catch (error) {
    warnOnce("could not attach Server-Timing", error);
  }
}

/**
 * Route PATTERN of the last non-middleware route Hono matched.
 *
 * Middleware registers as `ALL`, real handlers register as their method, so the
 * `ALL` filter is what separates the two. Anything unmatched — a 404, or a
 * middleware that answered before routing — reports `<unmatched>`; the caller's
 * real path never reaches a log line or a header.
 */
export function resolveRoutePattern(c: Context): string {
  try {
    const matched = c.req.matchedRoutes;
    for (let index = matched.length - 1; index >= 0; index -= 1) {
      const route = matched[index];
      if (!route) continue;
      if (String(route.method ?? "ALL").toUpperCase() === "ALL") continue;
      if (route.path) return route.path;
    }
  } catch (error) {
    warnOnce("could not resolve the matched route pattern", error);
  }
  return "<unmatched>";
}

// ────────────────────────────── middleware ──────────────────────────────

function emitSlowRequest(line: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(line));
  } catch (error) {
    warnOnce("could not write the slow-request line", error);
  }
}

/**
 * The instrumentation middleware.
 *
 * Register it FIRST in the app: Hono only wraps handlers registered after a
 * middleware, and auth's own `verifyAccessToken` lookup is part of the request's
 * cost, so it has to be inside the measured region.
 */
export function createRequestMetricsMiddleware(options: RequestMetricsOptions): MiddlewareHandler {
  requestMetricsEnabled = options.enabled;
  const buffer = options.enabled ? ringFor(options.bufferCapacity) : null;

  return async (c, next) => {
    if (!options.enabled) return next();

    const state: RequestDbMetrics = { dbMs: 0, dbQueries: 0, dbBytes: 0, dbParseMs: 0 };
    const startedAt = performance.now();
    let thrown = false;
    try {
      await requestContext.run(state, () => next());
    } catch (error) {
      // Hono's own errorHandler normally turns this into a 500 before it reaches
      // us; this branch exists so a handler that throws past that still gets
      // measured instead of leaving a hole in the window.
      thrown = true;
      throw error;
    } finally {
      try {
        const totalMs = finite(performance.now() - startedAt);
        const status = thrown ? 500 : (c.finalized ? c.res.status : 500);
        const route = resolveRoutePattern(c);
        const method = String(c.req.method ?? "GET").toUpperCase();
        const slow = totalMs > options.slowRequestMs;

        buffer?.record({
          method,
          route,
          status,
          totalMs,
          dbMs: state.dbMs,
          dbParseMs: state.dbParseMs,
          dbQueries: state.dbQueries,
          dbBytes: state.dbBytes,
          slow,
        });
        applyServerTiming(c, formatServerTiming({
          totalMs,
          dbMs: state.dbMs,
          dbParseMs: state.dbParseMs,
          dbQueries: state.dbQueries,
          dbBytes: state.dbBytes,
        }));

        if (slow) {
          emitSlowRequest({
            event: "api_slow_request",
            ts: new Date().toISOString(),
            method,
            route,
            status,
            total_ms: round1(totalMs),
            db_ms: round1(state.dbMs),
            db_parse_ms: round1(state.dbParseMs),
            db_queries: state.dbQueries,
            db_bytes: state.dbBytes,
          });
        }
      } catch (error) {
        warnOnce("request metrics failed", error);
      }
    }
  };
}

// ────────────────────────────── minute summary ──────────────────────────────

export interface RequestMetricsRuntime {
  /** Emit the current window right now (used by tests and manual smoke runs). */
  flush(): void;
  stop(): void;
}

/**
 * Start the per-window summary.
 *
 * Emits one line per interval even for an idle window: a steady heartbeat is
 * what lets an operator tell "no traffic" from "the feature died". The event
 * loop lag probe rides on `setInterval` drift, which is exactly the signal the
 * Issue asked for — the PG bridge blocks the main thread, so a blocked loop
 * shows up as a late tick.
 */
export function startRequestMetricsSummary(options: RequestMetricsOptions): RequestMetricsRuntime | null {
  if (!options.enabled) return null;
  const buffer = ringFor(options.bufferCapacity);

  let lastDbMs = processDbCounters.dbMs;
  let lastDbQueries = processDbCounters.dbQueries;
  let lastTickAt = performance.now();
  let lagMaxMs = 0;
  let expectedAt = performance.now() + EVENT_LOOP_LAG_INTERVAL_MS;

  const lagTimer = setInterval(() => {
    try {
      const now = performance.now();
      const lag = now - expectedAt;
      // Re-anchor on the observed time so one long stall is reported once
      // instead of poisoning every later tick with accumulated drift.
      expectedAt = now + EVENT_LOOP_LAG_INTERVAL_MS;
      if (lag > lagMaxMs) lagMaxMs = lag;
    } catch (error) {
      warnOnce("event loop lag probe failed", error);
    }
  }, EVENT_LOOP_LAG_INTERVAL_MS);
  lagTimer.unref?.();

  const emit = (): void => {
    const { samples, dropped } = buffer.drain();
    const windowMs = performance.now() - lastTickAt;
    lastTickAt = performance.now();
    const dbMs = processDbCounters.dbMs - lastDbMs;
    const dbQueries = processDbCounters.dbQueries - lastDbQueries;
    lastDbMs = processDbCounters.dbMs;
    lastDbQueries = processDbCounters.dbQueries;
    const lag = lagMaxMs;
    lagMaxMs = 0;
    const summary = summarizeWindow({
      windowMs,
      samples,
      dropped,
      dbMs,
      dbQueries,
      eventLoopLagMaxMs: lag,
      topRoutes: options.summaryTopRoutes,
    });
    console.log(JSON.stringify(summary));
  };

  const summaryTimer = setInterval(() => {
    try {
      emit();
    } catch (error) {
      warnOnce("minute summary failed", error);
    }
  }, options.summaryIntervalMs);
  summaryTimer.unref?.();

  return {
    flush: () => {
      try {
        emit();
      } catch (error) {
        warnOnce("minute summary failed", error);
      }
    },
    stop: () => {
      clearInterval(summaryTimer);
      clearInterval(lagTimer);
    },
  };
}

/**
 * Test seam: clear the buffer, the process counters, and the warn latch so one
 * case cannot leak window state or a dropped log into the next.
 */
export function resetRequestMetricsForTest(): void {
  ring = null;
  processDbCounters.dbMs = 0;
  processDbCounters.dbQueries = 0;
  processDbCounters.dbBytes = 0;
  requestMetricsEnabled = true;
  warnEmitted = false;
}

/**
 * Test seam: read and clear whatever the process-wide buffer currently holds,
 * so a test can assert on the stored samples rather than only on the header.
 */
export function drainRequestMetricsForTest(): { samples: RequestMetricSample[]; dropped: number } {
  if (!ring) return { samples: [], dropped: 0 };
  return ring.drain();
}
