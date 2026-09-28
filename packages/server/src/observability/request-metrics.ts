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
import type { ApiRole } from "../config/api-role.js";

/**
 * Per-request accumulator. One instance per request, never shared.
 *
 * `method`/`route` are the Hono route PATTERN and verb, resolved once when the
 * request enters the middleware. The PG bridge reads them through
 * `currentDbReplyOrigin()` so a bridge-level log (`api_large_db_reply`,
 * `api_db_reply_rejected`) can name the route without ever touching the real
 * path — the same privacy rule `api_slow_request` follows.
 */
interface RequestDbMetrics {
  dbMs: number;
  dbQueries: number;
  dbBytes: number;
  dbParseMs: number;
  method: string;
  route: string;
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

/**
 * Peer-channel counters for one window (MUL-462).
 *
 * `sent`/`batches`/`rtt_p95_ms` are what the local process POSTed to its peer.
 * `dropped` counts backlog evictions — the queue caps being enforced, plus
 * whatever is still queued or frozen in the retry slot when the channel closes.
 * `oversize_dropped` counts events the channel cannot carry at all. The two are
 * disjoint: an oversize event is never also counted as `dropped`. `failed`
 * counts failed POST attempts. All zero when `MULTIREMI_PEER_URL` is unset —
 * the summary shape does not change.
 */
export interface PeerSummary {
  sent: number;
  batches: number;
  dropped: number;
  failed: number;
  rtt_p95_ms: number;
  /**
   * Events dropped because one event alone exceeded the per-event budget.
   * Disjoint from `dropped` (backlog eviction): the same event is only ever in
   * one of the two.
   */
  oversize_dropped: number;
  /** Outbound events the sender slimmed down to a task reference. */
  degraded: number;
  /** Inbound batches recognized as retries and answered without re-delivering. */
  duplicates: number;
}

export interface MinuteSummary {
  event: "api_minute_summary";
  ts: string;
  /** Emitted by the process that produced the window; two containers share one log. */
  pid: number;
  window_ms: number;
  requests: number;
  status_5xx: number;
  slow: number;
  dropped: number;
  db_busy_pct: number;
  db_queries: number;
  event_loop_lag_max_ms: number;
  /** MUL-461: which API role produced this window. */
  role: ApiRole;
  routes: RouteSummary[];
  peer: PeerSummary;
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
  /**
   * MUL-461: the API role this process runs as. It is part of the process's
   * identity, so it rides both log lines and lets an operator tell `api` from
   * `api-runtime` in one stream once MUL-405's `pid` lands next to it.
   */
  role: ApiRole;
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
 * Process-wide peer-channel counters, mirroring `processDbCounters` (MUL-462).
 *
 * They are deliberately process-wide rather than request-scoped: the events
 * being forwarded were produced by a store write that has already returned, so
 * there is no request context to attribute them to.
 *
 * Like the DB hook, these are a no-op when metrics are switched off: the
 * counters only ever feed the summary line.
 *
 * Two sets are kept because they answer different questions. The `lifetime`
 * totals back the health endpoint and never reset; the `window` counters are
 * drained by every `api_minute_summary` so one window's burst is not smeared
 * across the next one. `rttSamples` is bounded so a long-lived process cannot
 * accumulate one number per batch forever.
 */
const lifetimePeerCounters = {
  sent: 0, batches: 0, dropped: 0, failed: 0,
  oversizeDropped: 0, degraded: 0, duplicates: 0,
};
const lifetimePeerRttSamples: number[] = [];
const windowPeerCounters = {
  sent: 0, batches: 0, dropped: 0, failed: 0,
  oversizeDropped: 0, degraded: 0, duplicates: 0,
};
let windowPeerRttSamples: number[] = [];
const PEER_RTT_SAMPLE_CAPACITY = 1024;

/**
 * Events that never left this process while waiting for delivery.
 *
 * Exactly one meaning: a backlog eviction. The send queue is capped by count and
 * by bytes; whatever is evicted to stay inside those caps — plus whatever is
 * still queued or frozen in the retry slot when the channel closes — lands here.
 * A slow or absent peer is what makes this grow.
 *
 * Deliberately NOT incremented by an oversize event: that is a different failure
 * with a different response, and it has its own counter below.
 */
export function recordPeerDropped(count = 1): void {
  if (!requestMetricsEnabled) return;
  const value = Math.max(0, Math.trunc(count));
  if (value === 0) return;
  lifetimePeerCounters.dropped += value;
  windowPeerCounters.dropped += value;
}

/**
 * One event was discarded because it alone exceeded the per-event byte budget
 * and its kind could not be degraded to a task reference.
 *
 * The two counters are disjoint and must stay that way. `dropped` is "the
 * backlog was evicted to stay inside its caps", which is backpressure from a peer
 * that is slow or down; this one is "the producer handed the channel an event it
 * cannot carry", which is an upstream contract problem and needs a fix, not a
 * bigger queue. An event counted here is never also counted as `dropped`.
 */
export function recordPeerOversizeDropped(): void {
  if (!requestMetricsEnabled) return;
  lifetimePeerCounters.oversizeDropped += 1;
  windowPeerCounters.oversizeDropped += 1;
}

/** One outbound event was slimmed down to a task reference before sending. */
export function recordPeerDegraded(): void {
  if (!requestMetricsEnabled) return;
  lifetimePeerCounters.degraded += 1;
  windowPeerCounters.degraded += 1;
}

/** One inbound batch was recognized as a retry and not delivered again. */
export function recordPeerDuplicate(): void {
  if (!requestMetricsEnabled) return;
  lifetimePeerCounters.duplicates += 1;
  windowPeerCounters.duplicates += 1;
}

/** One POST failed; the sender retries that batch with backoff. */
export function recordPeerFailure(): void {
  if (!requestMetricsEnabled) return;
  lifetimePeerCounters.failed += 1;
  windowPeerCounters.failed += 1;
}

/** One POST succeeded and carried `events` events in `rttMs` milliseconds. */
export function recordPeerBatch(input: { events: number; rttMs: number }): void {
  if (!requestMetricsEnabled) return;
  const events = Math.max(0, Math.trunc(input.events));
  lifetimePeerCounters.sent += events;
  lifetimePeerCounters.batches += 1;
  windowPeerCounters.sent += events;
  windowPeerCounters.batches += 1;
  if (Number.isFinite(input.rttMs) && input.rttMs >= 0) {
    lifetimePeerRttSamples.push(input.rttMs);
    if (lifetimePeerRttSamples.length > PEER_RTT_SAMPLE_CAPACITY) lifetimePeerRttSamples.shift();
    // Also capped: a busy minute can POST thousands of batches, and p95 of the
    // most recent 1024 is the same answer without unbounded growth.
    windowPeerRttSamples.push(input.rttMs);
    if (windowPeerRttSamples.length > PEER_RTT_SAMPLE_CAPACITY) windowPeerRttSamples.shift();
  }
}

/**
 * Read and clear the peer counters for the window that just ended.
 *
 * The summary owns the cadence: draining here is what makes `api_minute_summary`
 * report this window rather than a running total.
 */
export function drainPeerWindowMetrics(): PeerSummary {
  const summary: PeerSummary = {
    sent: windowPeerCounters.sent,
    batches: windowPeerCounters.batches,
    dropped: windowPeerCounters.dropped,
    failed: windowPeerCounters.failed,
    rtt_p95_ms: round1(percentile(windowPeerRttSamples, 0.95)),
    oversize_dropped: windowPeerCounters.oversizeDropped,
    degraded: windowPeerCounters.degraded,
    duplicates: windowPeerCounters.duplicates,
  };
  windowPeerCounters.sent = 0;
  windowPeerCounters.batches = 0;
  windowPeerCounters.dropped = 0;
  windowPeerCounters.failed = 0;
  windowPeerCounters.oversizeDropped = 0;
  windowPeerCounters.degraded = 0;
  windowPeerCounters.duplicates = 0;
  windowPeerRttSamples = [];
  return summary;
}

/** Lifetime peer counters, for `/health/realtime` and tests. */
export function peerMetricsSnapshot(): PeerSummary {
  return {
    sent: lifetimePeerCounters.sent,
    batches: lifetimePeerCounters.batches,
    dropped: lifetimePeerCounters.dropped,
    failed: lifetimePeerCounters.failed,
    rtt_p95_ms: round1(percentile(lifetimePeerRttSamples, 0.95)),
    oversize_dropped: lifetimePeerCounters.oversizeDropped,
    degraded: lifetimePeerCounters.degraded,
    duplicates: lifetimePeerCounters.duplicates,
  };
}

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

// ────────────────────────── PG bridge reply guardrails ──────────────────────────

/**
 * Replying with more than this many bytes earns a log line (MUL-386 C.1).
 *
 * The bridge is synchronous: a 12–15 MB reply blocks the main thread twice, once
 * waiting on the worker's `JSON.stringify` into the 64 MB shared buffer and once
 * on `TextDecoder` + `JSON.parse` here. Production showed those replies lining up
 * with `event_loop_lag_max_ms` peaks, so the size is worth a line well before it
 * reaches the hard limit below.
 */
export const DB_REPLY_WARN_BYTES = 1_048_576;

/**
 * Production and test default since MUL-398 C-1 (2026-09-28 authorization).
 * Transition exceptions retain the existing 64-MiB buffer ceiling until C-2.
 * An explicit environment override of 0 disables the configurable guard.
 */
export const DEFAULT_DB_REPLY_MAX_BYTES = 8_388_608;

/**
 * Kept for callers and the hermetic preload: recommendation and default agree.
 */
export const RECOMMENDED_DB_REPLY_MAX_BYTES = DEFAULT_DB_REPLY_MAX_BYTES;

/**
 * Exact currentDbReplyOrigin keys, never concrete paths or query strings.
 * Sources: 209 v0.2.83 slow-request DB totals (not single replies), source audit,
 * and the C-1 continuation ruling. C-2 removes HTTP entries individually after
 * bounded reads/MUL-402 and three days of single-reply data below 6 MiB,
 * including a working-day peak. See docs/dev/performance.md for the audit.
 */
export const DB_REPLY_TRANSITION_EXCEPTIONS: ReadonlySet<string> = new Set([
  // 209 total >= 6 MiB; retain every one of the 18 conservative candidates.
  "GET /api/dashboard/usage/by-agent", // Usage history; C-2 bounded reads/data.
  "GET /api/dashboard/agent-runtime", // Runtime history; C-2 bounded reads/data.
  "GET /api/dashboard/runtime/daily", // Runtime history; C-2 bounded reads/data.
  "GET /api/dashboard/usage/daily", // Usage history; C-2 bounded reads/data.
  "GET /api/knowledge/submissions", // Knowledge list; C-2 projection/data.
  "GET /api/projects/:id/knowledge/recall", // Doc bodies; C-2 bounded reads/data.
  "GET /api/projects/:id/docs", // Doc bodies; C-2 bounded reads/data.
  "GET /api/workspaces/:id/repository-wikis", // A/A2 fixed; C-2 production data.
  "GET /api/knowledge/runs", // Compilation outputs; C-2 projection/data.
  "GET /api/issues/:id", // Issue bundle; C-2 bounded reads/data.
  "POST /api/autopilots/:id/trigger", // Run payload/result; C-2 bounded reads/data.
  "POST /api/daemon/tasks/:taskId/fail", // Task completion reads; C-2/data.
  "POST /api/daemon/tasks/:taskId/complete", // Task completion reads; C-2/data.
  "GET /api/inbox", // Issue/history reads; C-2 bounded reads/data.
  "GET /api/tasks/:id/inspection", // Full messages; C-2/MUL-402/data.
  "GET /api/tasks/:taskId/messages", // Full messages; C-2/MUL-402/data.
  "POST /api/daemon/runtimes/:runtimeId/tasks/claim", // Session projection; C-2/data.
  "GET /api/multiremi/tasks", // Hydrated task rows; C-2 bounded reads/data.

  // Audit: full message/session/comment collections. C-2/MUL-402 + byte data.
  "GET /api/multiremi/tasks/:id/messages",
  "GET /api/daemon/tasks/:taskId/messages",
  "GET /api/multiremi/tasks/:id/inspection",
  "GET /api/shares/:token",
  "GET /api/issues/:id/sessions/:sessionId/events",
  "GET /api/issues/:id/comments",
  "GET /api/multiremi/issues/:id/comments",
  "GET /api/multiremi/issues/:id", // Legacy bundle also reads all comments/tasks.
  "GET /api/issues/:id/timeline", // SQL pages still contain full comment bodies.
  "GET /api/multiremi/issues/:id/timeline",
  "GET /api/issues/:id/session-results", // Unbounded result content/metadata.
  "GET /api/issues", // Full description/metadata rows; C-2 bounded bytes/data.
  "GET /api/multiremi/issues", // Also hydrates full task rows for each issue.
  "GET /api/issues/status-pages", // Row pages retain full issue bodies.
  "GET /api/issues/grouped",
  "GET /api/multiremi/issues/grouped",
  "GET /api/issues/search",
  "GET /api/multiremi/issues/search",
  "GET /api/issues/children",
  "GET /api/multiremi/issues/children",
  "GET /api/issues/:id/children",
  "GET /api/multiremi/issues/:id/children",
  "GET /api/issues/:id/generated-issues",
  "GET /api/issues/:id/decisions", // Full body/options and human-request payloads.
  "GET /api/issues/:id/active-task", // Filters full task rows after the read.
  "GET /api/issues/:id/task-runs",
  "GET /api/issues/:id/sessions/:sessionId/tasks",
  "GET /api/agents/:id/tasks", // Unbounded SELECT * task prompt/result rows.
  "GET /api/multiremi/agents/:id/tasks",
  "GET /api/multiremi/chats/:id", // Legacy bundle includes all chat bodies.
  "GET /api/multiremi/chats/:id/messages",
  "GET /api/chat/sessions/:sessionId/messages",
  "GET /api/chat/sessions/:sessionId/messages/page", // Pagination is after SQL.
  "POST /api/chat/sessions/:sessionId/messages", // Dispatch builds chat history.
  "POST /api/multiremi/chats/:id/messages",
  "GET /api/chat/sessions", // Last-message excerpt is projected; retain pending C-2 byte data.
  "GET /api/multiremi/chats",
  "GET /api/chat/sessions/:sessionId",
  "POST /api/chat/sessions", // Initial message/context readbacks.
  "POST /api/multiremi/chats",
  "GET /api/chat/sessions/:sessionId/pending-task", // Full queued task rows.
  "GET /api/chat/pending-tasks", // Already projected; keep pending C-2 byte data.
  "POST /api/chat/attachments/send", // Task credential scope uses the full task getter.
  "GET /api/multiremi/inbox", // Legacy full inbox collection/hydration.
  "GET /api/inbox/page", // Row pagination does not cap details/issue body bytes.
  "GET /api/inbox/summary", // Projected but unbounded completed-run details rows.

  // Audit: row LIMIT does not bound payload/result/schedule_prompt bytes.
  // C-2 requires projections/bounded bodies and single-reply data below 6 MiB.
  "GET /api/autopilots/:id/runs",
  "GET /api/autopilots/:id/runs/:runId",
  "GET /api/multiremi/autopilots/:id/runs",
  "GET /api/multiremi/autopilots/:id",
  "GET /api/daemon/autopilot-runs/:runId/gc-check",
  "GET /api/cli/context", // Task scope resolves a full run and prompt context.
  "GET /api/autopilots", // Autopilot prompt/compiled_prompt collection.
  "GET /api/autopilots/:id", // Full prompt and trigger payload/templates.
  "POST /api/autopilots", // Full prompt readback.
  "POST /api/multiremi/autopilots",
  "PATCH /api/autopilots/:id",
  "PATCH /api/multiremi/autopilots/:id",
  "DELETE /api/autopilots/:id",
  "DELETE /api/multiremi/autopilots/:id",
  "POST /api/webhooks/autopilots/:token", // Webhook-triggered run/queued read.
  "GET /api/multiremi/autopilots",
  "GET /api/multiremi/scheduler",
  "POST /api/multiremi/autopilots/:id/run", // advanceScheduledTargetRuns; C-2 bounded queued reads/data.
  "POST /api/multiremi/autopilots/:id/run-scheduled", // Same queued read/C-2 condition.
  "POST /api/multiremi/autopilots/:id/trigger", // Same queued read/C-2 condition.
  "POST /api/multiremi/autopilots/:id/webhook",
  "GET /api/autopilots/:id/deliveries", // Raw bodies are optionally projected in.
  "GET /api/autopilots/:id/deliveries/:deliveryId",
  "POST /api/autopilots/:id/deliveries/:deliveryId/replay",
  "GET /api/multiremi/autopilots/:id/deliveries",
  "GET /api/multiremi/autopilots/:id/deliveries/:deliveryId",
  "POST /api/multiremi/autopilots/:id/deliveries/:deliveryId/replay",

  // Audit: SQL storage can contain full document/revision bodies. C-2/data.
  "GET /api/knowledge/submissions/:id",
  "POST /api/knowledge/submissions", // Write actor can resolve a full run.
  "GET /api/knowledge/runs/:id",
  "GET /api/projects/:id/docs/:ref",
  "GET /api/projects/:id/docs/:ref/revisions",
  "GET /api/projects/:id/docs/:ref/backlinks",
  "POST /api/projects/:id/docs",
  "PUT /api/projects/:id/docs/:ref",
  "DELETE /api/projects/:id/docs/:ref",
  "GET /api/project-docs",
  "GET /api/project-knowledge/migration",
  "POST /api/project-knowledge/migration/backfill",
  "POST /api/project-knowledge/migration/verify",
  "POST /api/project-knowledge/migration/retry-failed",
  "POST /api/knowledge/migrate-legacy",
  "POST /api/knowledge/events/repository-merged", // Compilation/run readbacks.
  "POST /api/projects/:id/knowledge/publish",
  "GET /api/workspaces/:id/repos/:repositoryId/wiki",
  "GET /api/workspaces/:id/repos/:repositoryId/wiki/:ref",
  "GET /api/workspaces/:id/repos/:repositoryId/wiki/:ref/revisions",
  "GET /api/workspaces/:id/repos/:repositoryId/wiki/:ref/backlinks",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/batch",
  "PUT /api/workspaces/:id/repos/:repositoryId/wiki/:ref",
  "DELETE /api/workspaces/:id/repos/:repositoryId/wiki/:ref",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/publish",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/move",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/merge",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/restore",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/repair-log",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/outcome",
  "POST /api/workspaces/:id/repos/:repositoryId/wiki/build", // advanceScheduledTargetRuns; C-2 bounded queued reads/data.

  // Audit: archive bytes are external, but SQL metadata has no byte cap.
  // C-2 requires bounded metadata reads and per-route single-reply evidence.
  "GET /api/issues/:issueId/session-archives",
  "POST /api/issues/:issueId/session-archives/:archiveId/verify",
  "POST /api/issues/:issueId/session-archives/:archiveId/retry",
  "GET /api/workspaces/:id/session-archive",
  "PUT /api/workspaces/:id/session-archive",
  "GET /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/status",
  "POST /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/init",
  "POST /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/failure",
  "GET /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/:archiveId/content",
  "PUT /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/:archiveId/content",
  "POST /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/:archiveId/failure",
  "POST /api/daemon/runtimes/:runtimeId/issues/:issueId/session-archives/:archiveId/complete",

  // Audit: even a capped 2-MiB prompt may expand beyond 8 MiB in JSON. C-2/data.
  "GET /api/tasks/:taskId/prompt",
  "POST /api/daemon/tasks/:taskId/prompt",
  // Audit: full task getters/write readbacks can include prompt/result/error.
  // C-2 requires narrow getters or byte bounds, then per-route evidence.
  "GET /api/multiremi/tasks/:id",
  "POST /api/multiremi/tasks",
  "POST /api/multiremi/tasks/:id/cancel",
  "POST /api/tasks/:id/cancel",
  "POST /api/multiremi/tasks/:id/steer",
  "POST /api/tasks/:id/steer",
  "GET /api/multiremi/tasks/:id/steer",
  "GET /api/tasks/:id/steer",
  "POST /api/multiremi/tasks/:id/redispatch",
  "POST /api/tasks/:id/redispatch",
  "GET /api/multiremi/tasks/:id/human-requests",
  "GET /api/tasks/:id/human-requests",
  "POST /api/multiremi/tasks/:id/human-requests/:requestId/respond",
  "POST /api/tasks/:id/human-requests/:requestId/respond",
  "POST /api/daemon/tasks/:taskId/start",
  "POST /api/daemon/tasks/:taskId/dispatch-lease",
  "POST /api/daemon/tasks/:taskId/wait-local-directory",
  "POST /api/daemon/tasks/:taskId/human-requests",
  "POST /api/daemon/tasks/:taskId/progress",
  "POST /api/daemon/tasks/:taskId/session",
  "POST /api/daemon/tasks/:taskId/workspace",
  "POST /api/daemon/tasks/:taskId/usage",
  "GET /api/daemon/tasks/:taskId/gc-check",
  "GET /api/daemon/tasks/:taskId/status", // Result/error remain in the projection.
  "GET /api/daemon/tasks/:taskId/steer", // Pending steer text has no row LIMIT.
  "POST /api/daemon/runtimes/:runtimeId/recover-orphans", // Full orphan task set.

  // Audit: resolved instruction/skill/body readers, including scope checks and readbacks.
  // C-2: bound/project these reads, then require single-reply data below 6 MiB.
  "DELETE /api/attachments/:id", // attachments.ts:175; large-column caller.
  "DELETE /api/autopilots/:id/triggers/:triggerId", // autopilots.ts:545; large-column caller.
  "DELETE /api/chat/sessions/:sessionId", // chat.ts:117; large-column caller.
  "DELETE /api/chat/sessions/:sessionId/queue", // chat.ts:210; large-column caller.
  "DELETE /api/chat/sessions/:sessionId/queue/:taskId", // chat.ts:202; large-column caller.
  "DELETE /api/comments/:id", // comments.ts:68; large-column caller.
  "DELETE /api/comments/:id/reactions", // comments.ts:107; large-column caller.
  "DELETE /api/comments/:id/resolve", // comments.ts:89; large-column caller.
  "DELETE /api/issues/:id", // issues.ts:1537; large-column caller.
  "DELETE /api/issues/:id/dependencies/:dependencyId", // issues.ts:1342; large-column caller.
  "DELETE /api/issues/:id/labels/:labelId", // issues.ts:2001; large-column caller.
  "DELETE /api/issues/:id/metadata/:key", // issues.ts:2168; large-column caller.
  "DELETE /api/issues/:id/reactions", // issues.ts:1906; large-column caller.
  "DELETE /api/issues/:id/sessions/:sessionId/participants/:participantType/:participantId", // issues.ts:1699; large-column caller.
  "DELETE /api/issues/:id/share", // issue-shares.ts:67; large-column caller.
  "DELETE /api/issues/:issueId/change-requests/:changeRequestId", // scm.ts:57; large-column caller.
  "DELETE /api/multiremi/agents/:id", // agents.ts:135; large-column caller.
  "DELETE /api/multiremi/agents/:id/plugins/:bindingId", // agent-plugins.ts:325; large-column caller.
  "DELETE /api/multiremi/comments/:id", // comments.ts:38; large-column caller.
  "DELETE /api/multiremi/comments/:id/reactions", // comments.ts:129; large-column caller.
  "DELETE /api/multiremi/comments/:id/resolve", // comments.ts:52; large-column caller.
  "DELETE /api/multiremi/issues/:id", // issues.ts:1522; large-column caller.
  "DELETE /api/multiremi/issues/:id/dependencies/:dependencyId", // issues.ts:1334; large-column caller.
  "DELETE /api/multiremi/issues/:id/labels/:labelId", // issues.ts:1969; large-column caller.
  "DELETE /api/multiremi/issues/:id/metadata/:key", // issues.ts:2153; large-column caller.
  "DELETE /api/multiremi/issues/:id/reactions", // issues.ts:1897; large-column caller.
  "DELETE /api/multiremi/issues/:id/subscribers/:memberId", // issues.ts:2091; large-column caller.
  "DELETE /api/multiremi/projects/:id", // projects.ts:217; large-column caller.
  "DELETE /api/multiremi/projects/:id/devices/:daemonId", // projects.ts:276; large-column caller.
  "DELETE /api/multiremi/projects/:id/resources/:resourceId", // projects.ts:320; large-column caller.
  "DELETE /api/multiremi/skills/:id", // skills.ts:115; large-column caller.
  "DELETE /api/projects/:id", // projects.ts:352; large-column caller.
  "DELETE /api/projects/:id/devices/:daemonId", // projects.ts:420; large-column caller.
  "DELETE /api/projects/:id/resources/:resourceId", // projects.ts:467; large-column caller.
  "DELETE /api/runtime-workspaces/:id", // runtime-workspaces.ts:46; large-column caller.
  "DELETE /api/runtimes/:id", // runtimes.ts:721; large-column caller.
  "DELETE /api/skills/:id", // skills.ts:205; large-column caller.
  "DELETE /api/skills/:id/files/:fileId", // skills.ts:236; large-column caller.
  "DELETE /api/workspaces/:id/feishu-bot", // feishu-bot.ts:308; large-column caller.
  "DELETE /api/workspaces/:id/repos/:repositoryId", // workspaces.ts:1003; large-column caller.
  "GET /api/agent-task-snapshot", // agents.ts:347; large-column caller.
  "GET /api/agents", // agents.ts:219; large-column caller.
  "GET /api/agents/:id", // agents.ts:263; large-column caller.
  "GET /api/agents/:id/env", // agents.ts:203; large-column caller.
  "GET /api/agents/:id/skills", // agents.ts:168; large-column caller.
  "GET /api/attachments/:id", // attachments.ts:145; large-column caller.
  "GET /api/attachments/:id/content", // attachments.ts:164; large-column caller.
  "GET /api/attachments/:id/download", // attachments.ts:153; large-column caller.
  "GET /api/cli/capabilities", // cli.ts:44; large-column caller.
  "GET /api/daemon/chat-sessions/:sessionId/gc-check", // daemon.ts:1431; large-column caller.
  "GET /api/daemon/issues/:issueId/gc-check", // daemon.ts:1349; large-column caller.
  "GET /api/daemon/runtimes/:runtimeId/feishu-bot", // daemon.ts:513; large-column caller.
  "GET /api/execution-groups", // runtimes.ts:628; large-column caller.
  "GET /api/issues/:id/attachments", // issues.ts:1925; large-column caller.
  "GET /api/issues/:id/change-requests", // scm.ts:23; large-column caller.
  "GET /api/issues/:id/dependencies", // issues.ts:1289; large-column caller.
  "GET /api/issues/:id/labels", // issues.ts:1977; large-column caller.
  "GET /api/issues/:id/metadata", // issues.ts:2106; large-column caller.
  "GET /api/issues/:id/reactions", // issues.ts:1871; large-column caller.
  "GET /api/issues/:id/sessions", // issues.ts:1600; large-column caller.
  "GET /api/issues/:id/sessions/:sessionId", // issues.ts:1643; large-column caller.
  "GET /api/issues/:id/sessions/:sessionId/participants", // issues.ts:1670; large-column caller.
  "GET /api/issues/:id/share", // issue-shares.ts:32; large-column caller.
  "GET /api/issues/:id/subscribers", // issues.ts:2020; large-column caller.
  "GET /api/issues/:id/usage", // issues.ts:1097; large-column caller.
  "GET /api/issues/:id/workspace", // issues.ts:994; large-column caller.
  "GET /api/models", // runtimes.ts:654; large-column caller.
  "GET /api/multiremi/agent-task-snapshot", // agents.ts:338; large-column caller.
  "GET /api/multiremi/agents", // agents.ts:54; large-column caller.
  "GET /api/multiremi/agents/:id", // agents.ts:119; large-column caller.
  "GET /api/multiremi/agents/:id/plugins", // agent-plugins.ts:279; large-column caller.
  "GET /api/multiremi/agents/:id/skills", // agents.ts:142; large-column caller.
  "GET /api/multiremi/attachments/:id", // attachments.ts:63; large-column caller.
  "GET /api/multiremi/comments/:id/attachments", // comments.ts:136; large-column caller.
  "GET /api/multiremi/comments/:id/reactions", // comments.ts:118; large-column caller.
  "GET /api/multiremi/execution-groups", // runtimes.ts:629; large-column caller.
  "GET /api/multiremi/issues/:id/attachments", // issues.ts:1918; large-column caller.
  "GET /api/multiremi/issues/:id/dependencies", // issues.ts:1281; large-column caller.
  "GET /api/multiremi/issues/:id/labels", // issues.ts:1948; large-column caller.
  "GET /api/multiremi/issues/:id/metadata", // issues.ts:2099; large-column caller.
  "GET /api/multiremi/issues/:id/reactions", // issues.ts:1864; large-column caller.
  "GET /api/multiremi/issues/:id/subscribers", // issues.ts:2013; large-column caller.
  "GET /api/multiremi/models", // runtimes.ts:655; large-column caller.
  "GET /api/multiremi/projects", // projects.ts:74; large-column caller.
  "GET /api/multiremi/projects/:id", // projects.ts:193; large-column caller.
  "GET /api/multiremi/projects/:id/devices", // projects.ts:233; large-column caller.
  "GET /api/multiremi/projects/:id/resources", // projects.ts:227; large-column caller.
  "GET /api/multiremi/projects/search", // projects.ts:82; large-column caller.
  "GET /api/multiremi/skills", // skills.ts:38; large-column caller.
  "GET /api/multiremi/skills/:id", // skills.ts:84; large-column caller.
  "GET /api/multiremi/skills/search", // skills.ts:76; large-column caller.
  "GET /api/projects", // projects.ts:123; large-column caller.
  "GET /api/projects/:id", // projects.ts:327; large-column caller.
  "GET /api/projects/:id/devices", // projects.ts:373; large-column caller.
  "GET /api/projects/:id/resources", // projects.ts:367; large-column caller.
  "GET /api/projects/search", // projects.ts:99; large-column caller.
  "GET /api/runtime-workspaces", // runtime-workspaces.ts:12; large-column caller.
  "GET /api/runtime-workspaces/:id", // runtime-workspaces.ts:35; large-column caller.
  "GET /api/runtimes/:id/workspaces", // runtime-workspaces.ts:20; large-column caller.
  "GET /api/shares/:token/attachments/:attachmentId/content", // issue-shares.ts:92; large-column caller.
  "GET /api/skills", // skills.ts:126; large-column caller.
  "GET /api/skills/:id", // skills.ts:172; large-column caller.
  "GET /api/skills/:id/files", // skills.ts:216; large-column caller.
  "GET /api/skills/search", // skills.ts:133; large-column caller.
  "GET /api/squads/:id/members/status", // squads.ts:194; large-column caller.
  "GET /api/workspaces/:id/feishu-bot", // feishu-bot.ts:84; large-column caller.
  "GET /api/workspaces/:id/feishu-bot/candidates", // feishu-bot.ts:108; large-column caller.
  "PATCH /api/autopilots/:id/triggers/:triggerId", // autopilots.ts:517; large-column caller.
  "PATCH /api/chat/sessions/:sessionId", // chat.ts:109; large-column caller.
  "PATCH /api/chat/sessions/:sessionId/queue/:taskId", // chat.ts:195; large-column caller.
  "PATCH /api/issues/:id", // issues.ts:1478; large-column caller.
  "PATCH /api/issues/:id/sessions/:sessionId", // issues.ts:1654; large-column caller.
  "PATCH /api/multiremi/agents/:id", // agents.ts:124; large-column caller.
  "PATCH /api/multiremi/agents/:id/plugins/:bindingId", // agent-plugins.ts:306; large-column caller.
  "PATCH /api/multiremi/chats/:id", // chat.ts:61; large-column caller.
  "PATCH /api/multiremi/comments/:id", // comments.ts:32; large-column caller.
  "PATCH /api/multiremi/issues/:id", // issues.ts:1385; large-column caller.
  "PATCH /api/multiremi/projects/:id", // projects.ts:198; large-column caller.
  "PATCH /api/multiremi/projects/:id/resources/:resourceId", // projects.ts:305; large-column caller.
  "PATCH /api/multiremi/skills/:id", // skills.ts:89; large-column caller.
  "PATCH /api/runtime-workspaces/:id", // runtime-workspaces.ts:39; large-column caller.
  "PATCH /api/skills/:id", // skills.ts:177; large-column caller.
  "POST /api/agents", // agents.ts:231; large-column caller.
  "POST /api/agents/:id/archive", // agents.ts:305; large-column caller.
  "POST /api/agents/:id/cancel-tasks", // agents.ts:319; large-column caller.
  "POST /api/agents/:id/restore", // agents.ts:312; large-column caller.
  "POST /api/agents/:id/skills/add", // agents.ts:186; large-column caller.
  "POST /api/agents/from-template", // agents.ts:245; large-column caller.
  "POST /api/autopilots/:id/triggers", // autopilots.ts:490; large-column caller.
  "POST /api/autopilots/:id/triggers/:triggerId/rotate-webhook-token", // autopilots.ts:553; large-column caller.
  "POST /api/chat/sessions/:sessionId/queue/:taskId/prioritize", // chat.ts:218; large-column caller.
  "POST /api/chat/sessions/:sessionId/read", // chat.ts:223; large-column caller.
  "POST /api/comments/:id/reactions", // comments.ts:98; large-column caller.
  "POST /api/comments/:id/resolve", // comments.ts:78; large-column caller.
  "GET /api/daemon/issues/:issueId/decisions/:decisionId", // daemon.ts:567; decision access reads issue description/metadata.
  "POST /api/daemon/issues/:issueId/decisions/:decisionId/answer", // daemon.ts:588; decision access and writeback read issue description/metadata.
  "POST /api/daemon/issues/:issueId/workspace/cleaned", // daemon.ts:1358; large-column caller.
  "POST /api/daemon/scm/git-credentials", // daemon.ts:159; large-column caller.
  "POST /api/daemon/tasks/:taskId/human-requests/:requestId/expire", // daemon.ts:1065; large-column caller.
  "POST /api/daemon/tasks/:taskId/human-requests/:requestId/respond", // daemon.ts:1078; large-column caller.
  "POST /api/daemon/tasks/:taskId/steer/consume", // daemon.ts:1339; large-column caller.
  "POST /api/issues", // issues.ts:791; large-column caller.
  "POST /api/issues/:id/comments", // issues.ts:1851; large-column caller.
  "POST /api/issues/:id/decisions", // issues.ts:1225; large-column caller.
  "POST /api/issues/:id/decisions/:decisionId/answer", // issues.ts:1242; large-column caller.
  "POST /api/issues/:id/decisions/:decisionId/escalate", // issues.ts:1259; large-column caller.
  "POST /api/issues/:id/decisions/:decisionId/withdraw", // issues.ts:1270; large-column caller.
  "POST /api/issues/:id/dependencies", // issues.ts:1315; large-column caller.
  "POST /api/issues/:id/labels", // issues.ts:1985; large-column caller.
  "POST /api/issues/:id/reactions", // issues.ts:1886; large-column caller.
  "POST /api/issues/:id/rerun", // issues.ts:1104; large-column caller.
  "POST /api/issues/:id/restore", // issues.ts:1512; large-column caller.
  "POST /api/issues/:id/sessions", // issues.ts:1612; large-column caller.
  "POST /api/issues/:id/sessions/:sessionId/messages", // issues.ts:1722; large-column caller.
  "POST /api/issues/:id/sessions/:sessionId/participants", // issues.ts:1678; large-column caller.
  "POST /api/issues/:id/sessions/:sessionId/results", // issues.ts:1794; large-column caller.
  "POST /api/issues/:id/sessions/:sessionId/tasks", // issues.ts:1754; large-column caller.
  "POST /api/issues/:id/share", // issue-shares.ts:41; large-column caller.
  "POST /api/issues/:id/share/extend", // issue-shares.ts:55; large-column caller.
  "POST /api/issues/:id/squad-evaluated", // issues.ts:1140; large-column caller.
  "POST /api/issues/:id/subscribe", // issues.ts:2037; large-column caller.
  "POST /api/issues/:id/tasks/:taskId/cancel", // issues.ts:1129; large-column caller.
  "POST /api/issues/:id/unsubscribe", // issues.ts:2064; large-column caller.
  "POST /api/issues/batch-delete", // issues.ts:722; large-column caller.
  "POST /api/issues/batch-update", // issues.ts:679; large-column caller.
  "POST /api/issues/quick-create", // issues.ts:918; large-column caller.
  "POST /api/me/onboarding/no-runtime-bootstrap", // me.ts:69; large-column caller.
  "POST /api/me/onboarding/runtime-bootstrap", // me.ts:59; large-column caller.
  "POST /api/multiremi/agents", // agents.ts:66; large-column caller.
  "POST /api/multiremi/agents/:id/plugins", // agent-plugins.ts:290; large-column caller.
  "POST /api/multiremi/agents/default", // agents.ts:80; large-column caller.
  "POST /api/multiremi/agents/from-template", // agents.ts:324; large-column caller.
  "POST /api/multiremi/attachments", // attachments.ts:70; large-column caller.
  "POST /api/multiremi/comments/:id/reactions", // comments.ts:123; large-column caller.
  "POST /api/multiremi/comments/:id/resolve", // comments.ts:44; large-column caller.
  "POST /api/multiremi/issues", // issues.ts:736; large-column caller.
  "POST /api/multiremi/issues/:id/assign", // issues.ts:1552; large-column caller.
  "POST /api/multiremi/issues/:id/attachments", // issues.ts:1932; large-column caller.
  "POST /api/multiremi/issues/:id/comments", // issues.ts:1843; large-column caller.
  "POST /api/multiremi/issues/:id/dependencies", // issues.ts:1297; large-column caller.
  "POST /api/multiremi/issues/:id/labels", // issues.ts:1956; large-column caller.
  "POST /api/multiremi/issues/:id/reactions", // issues.ts:1878; large-column caller.
  "POST /api/multiremi/issues/:id/restore", // issues.ts:1503; large-column caller.
  "POST /api/multiremi/issues/:id/retitle", // issues.ts:1480; large-column caller.
  "POST /api/multiremi/issues/:id/subscribers", // issues.ts:2027; large-column caller.
  "POST /api/multiremi/issues/batch-delete", // issues.ts:709; large-column caller.
  "POST /api/multiremi/issues/batch-update", // issues.ts:655; large-column caller.
  "POST /api/multiremi/issues/quick-create", // issues.ts:893; large-column caller.
  "POST /api/multiremi/pins", // pins.ts:29; large-column caller.
  "POST /api/multiremi/projects", // projects.ts:166; large-column caller.
  "POST /api/multiremi/projects/:id/devices", // projects.ts:257; large-column caller.
  "POST /api/multiremi/projects/:id/resources", // projects.ts:289; large-column caller.
  "POST /api/multiremi/projects/:id/restore", // projects.ts:222; large-column caller.
  "POST /api/multiremi/skills", // skills.ts:47; large-column caller.
  "POST /api/multiremi/skills/import", // skills.ts:60; large-column caller.
  "POST /api/pins", // pins.ts:74; large-column caller.
  "POST /api/projects", // projects.ts:133; large-column caller.
  "POST /api/projects/:id/devices", // projects.ts:397; large-column caller.
  "POST /api/projects/:id/resources", // projects.ts:434; large-column caller.
  "POST /api/projects/:id/restore", // projects.ts:359; large-column caller.
  "POST /api/skills", // skills.ts:141; large-column caller.
  "POST /api/skills/import", // skills.ts:155; large-column caller.
  "POST /api/squads", // squads.ts:49; large-column caller.
  "POST /api/upload-file", // attachments.ts:94; large-column caller.
  "POST /api/workspaces", // workspaces.ts:142; large-column caller.
  "PUT /api/agents/:id", // agents.ts:268; large-column caller.
  "PUT /api/agents/:id/env", // agents.ts:209; large-column caller.
  "PUT /api/agents/:id/role", // agents.ts:291; large-column caller.
  "PUT /api/agents/:id/skills", // agents.ts:173; large-column caller.
  "PUT /api/agents/:id/supervisor", // agents.ts:279; large-column caller.
  "PUT /api/autopilots/:id/triggers/:triggerId/signing-secret", // autopilots.ts:570; large-column caller.
  "PUT /api/comments/:id", // comments.ts:57; large-column caller.
  "PUT /api/issues/:id", // issues.ts:1479; large-column caller.
  "PUT /api/issues/:id/metadata/:key", // issues.ts:2134; large-column caller.
  "PUT /api/issues/:issueId/change-requests/:changeRequestId", // scm.ts:45; large-column caller.
  "PUT /api/multiremi/agents/:id/skills", // agents.ts:155; large-column caller.
  "PUT /api/multiremi/comments/:id", // comments.ts:26; large-column caller.
  "PUT /api/multiremi/issues/:id/metadata/:key", // issues.ts:2113; large-column caller.
  "PUT /api/multiremi/projects/:id/devices", // projects.ts:238; large-column caller.
  "PUT /api/multiremi/skills/:id", // skills.ts:102; large-column caller.
  "PUT /api/projects/:id", // projects.ts:332; large-column caller.
  "PUT /api/projects/:id/devices", // projects.ts:378; large-column caller.
  "PUT /api/projects/:id/resources/:resourceId", // projects.ts:451; large-column caller.
  "PUT /api/skills/:id", // skills.ts:191; large-column caller.
  "PUT /api/skills/:id/files", // skills.ts:225; large-column caller.
  "PUT /api/squads/:id", // squads.ts:147; large-column caller.
  "PUT /api/workspaces/:id/feishu-bot", // feishu-bot.ts:267; large-column caller.
  "PUT /api/workspaces/:id/issue-topics", // workspaces.ts:269; large-column caller.

  // 479 route audit: gatewayReasoningLevels and discovery/runtime setup can read
  // the unbounded multiremi_gateway_models.models JSON snapshot. C-2: bound the
  // snapshot reply and confirm single replies <6 MiB before removing each key.
  "POST /api/daemon/register",
  "PUT /api/workspaces/:id/relay-config/discovery",
  "PUT /api/workspaces/:id/relay-config/:engine",
  "POST /api/workspaces/:id/relay-config/:engine/probe",
  "GET /api/workspaces/:id/relay-config/:engine/reasoning-levels",
  "PUT /api/workspaces/:id/relay-config/:engine/reasoning-levels",
  "PUT /api/workspaces/:id/relay-config/:engine/context-window",
  "POST /api/multiremi/runtimes",
  "PATCH /api/multiremi/runtimes/:id",
  "PATCH /api/runtimes/:id",

  // C-1 ruling: preserve MUL-462 readback page size, avoiding extra bridge calls.
  // C-2: MUL-402 removes this read OR a separately authorized row-width algorithm.
  "POST /api/daemon/tasks/:taskId/messages",
  // Audit: peer.receive calls the reference consumer in this HTTP context.
  // C-2: MUL-402 removes this read OR a separately authorized row-width algorithm.
  "POST /internal/peer/events",
  // C-1 ruling: queued reads must be bounded AND v0.2.84+ background replies
  // observed below 6 MiB before C-2 removes this independent entry.
  "<background> <background>",
]);

/**
 * Unset/empty means 8 MiB; explicit 0 is the emergency disable switch.
 * Invalid values warn once when the bridge caches this resolution, with only
 * the raw override as variable information, and fall back to the default.
 */
export function resolveDbReplyMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MULTIREMI_PG_REPLY_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_DB_REPLY_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn("[pg-bridge] invalid MULTIREMI_PG_REPLY_MAX_BYTES", JSON.stringify(env.MULTIREMI_PG_REPLY_MAX_BYTES));
    return DEFAULT_DB_REPLY_MAX_BYTES;
  }
  return parsed;
}

/**
 * Where the reply that is being measured came from.
 *
 * Background work (schedulers, migrations) has no request context by
 * construction, and the Issue fixes its label as `<background>`.
 */
export function currentDbReplyOrigin(): { method: string; route: string } {
  const request = requestContext.getStore();
  if (!request) return { method: "<background>", route: "<background>" };
  return { method: request.method, route: request.route };
}

/**
 * One line per oversized bridge reply. Never includes SQL text, parameters, the
 * real path, or the query string — only the route pattern, the verb, and a size.
 */
export function emitLargeDbReply(bytes: number): void {
  if (!(bytes > DB_REPLY_WARN_BYTES)) return;
  const { method, route } = currentDbReplyOrigin();
  emitJsonLine({
    event: "api_large_db_reply",
    ts: new Date().toISOString(),
    method,
    route,
    bytes,
  });
}

/** The line emitted when a reply is refused before decode/parse. */
export function emitDbReplyRejected(bytes: number, maxBytes: number): void {
  const { method, route } = currentDbReplyOrigin();
  emitJsonLine({
    event: "api_db_reply_rejected",
    ts: new Date().toISOString(),
    method,
    route,
    bytes,
    max_bytes: maxBytes,
  });
}

/** Shared writer so every guardrail line is one JSON object on stdout. */
function emitJsonLine(line: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(line));
  } catch (error) {
    warnOnce("could not write a bridge guardrail line", error);
  }
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
  /** MUL-461: reported verbatim in the summary line. */
  role: ApiRole;
  /** MUL-462: peer-channel counters for this window. Omitted means a zeroed block. */
  peer?: PeerSummary;
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
    pid: process.pid,
    window_ms: Math.round(windowMs),
    requests: input.samples.length,
    status_5xx: status5xx,
    slow,
    dropped: Math.max(0, Math.trunc(input.dropped)),
    db_busy_pct: windowMs > 0 ? round2((finite(input.dbMs) / windowMs) * 100) : 0,
    db_queries: Math.max(0, Math.trunc(finite(input.dbQueries))),
    event_loop_lag_max_ms: round1(finite(input.eventLoopLagMaxMs)),
    role: input.role,
    routes: routes.slice(0, top),
    peer: input.peer ?? {
      sent: 0, batches: 0, dropped: 0, failed: 0, rtt_p95_ms: 0,
      oversize_dropped: 0, degraded: 0, duplicates: 0,
    },
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
  role: ApiRole,
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
    role,
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
  emitJsonLine(line);
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
    // Hono has already matched the full handler chain by the time a middleware
    // runs, so the pattern is available here — before any handler queries the
    // database. `resolveRoutePattern` skips the `ALL` middleware entries, which
    // is exactly what keeps a bridge log from reporting `/*`.
    const state: RequestDbMetrics = {
      dbMs: 0,
      dbQueries: 0,
      dbBytes: 0,
      dbParseMs: 0,
      method: String(c.req.method ?? "GET").toUpperCase(),
      route: resolveRoutePattern(c),
    };
    // Reply limits need the route even when collection and timing headers are off.
    if (!options.enabled) return requestContext.run(state, () => next());
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
        // Re-resolve for the sample: a handler that answers before routing is
        // already past, and the entry-time value is the fallback.
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
            pid: process.pid,
            role: options.role,
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
    const peer = drainPeerWindowMetrics();
    const summary = summarizeWindow({
      windowMs,
      samples,
      dropped,
      dbMs,
      dbQueries,
      eventLoopLagMaxMs: lag,
      topRoutes: options.summaryTopRoutes,
      role: options.role,
      peer,
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
  lifetimePeerCounters.sent = 0;
  lifetimePeerCounters.batches = 0;
  lifetimePeerCounters.dropped = 0;
  lifetimePeerCounters.failed = 0;
  lifetimePeerCounters.oversizeDropped = 0;
  lifetimePeerCounters.degraded = 0;
  lifetimePeerCounters.duplicates = 0;
  lifetimePeerRttSamples.length = 0;
  windowPeerCounters.sent = 0;
  windowPeerCounters.batches = 0;
  windowPeerCounters.dropped = 0;
  windowPeerCounters.failed = 0;
  windowPeerCounters.oversizeDropped = 0;
  windowPeerCounters.degraded = 0;
  windowPeerCounters.duplicates = 0;
  windowPeerRttSamples = [];
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
