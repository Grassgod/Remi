/**
 * `ws_minute_summary`: the WebSocket half of the per-minute observability line
 * (MUL-417; the HTTP half is `api_minute_summary` in `observability/request-metrics.ts`).
 *
 * WHY THIS EXISTS. Once daemon traffic moves off HTTP, its DB time stops showing
 * up in any route's `db_ms` — `db_busy_pct` would fall purely because the work
 * moved, not because it got cheaper. This module keeps the same accounting
 * visible per frame type, so "HTTP + WS daemon DB time" stays measurable across
 * the migration.
 *
 * SAME WINDOW, SAME SHAPE, SAME SINK as `api_minute_summary`:
 *   - a fixed-capacity ring of typed arrays, interned frame types (no per-frame
 *     allocation, no growth with traffic);
 *   - the same `dropped` semantics when the ring wraps;
 *   - one `console.log(JSON.stringify(...))` line per interval, on stdout, with
 *     no query, header, payload, or credential content anywhere in it.
 *
 * The DB numbers come from the same process-wide counters the HTTP summary reads,
 * measured as a delta over the window. That is deliberate: the two lines are
 * meant to be added together, and double-counting a single query in both would
 * break exactly the comparison they exist to support. Each frame is measured as
 * the DB time spent *inside its own handler*, by diffing the process counters
 * around the dispatch, so a frame that issues no query reports zero.
 */

/** One dispatched frame, as stored in the window. */
export interface WsFrameSample {
  /** Frame type (`hb`, `res`, `hello`, ...). Interned to an id. */
  type: string;
  /** Connection role the frame arrived on; part of the grouping key. */
  direction: "uplink" | "rpc";
  /** Error code when the handler answered with one, else null. */
  errorCode: string | null;
  /** Wall time spent in the handler. */
  totalMs: number;
  /** Increase of the process-wide DB counters during the handler. */
  dbMs: number;
  dbQueries: number;
  /** True when the frame violated the protocol (oversized or unknown). */
  protocolViolation: boolean;
}

export interface WsFrameSummary {
  type: string;
  direction: "uplink" | "rpc";
  count: number;
  /** Frames that closed with a protocol violation. */
  violations: number;
  db_ms: number;
  db_queries: number;
  p50_ms: number;
  p95_ms: number;
}

export interface WsMinuteSummary {
  event: "ws_minute_summary";
  ts: string;
  window_ms: number;
  frames: number;
  dropped: number;
  /** Process-level DB time and queries observed over this window, all sources. */
  db_busy_pct: number;
  db_queries: number;
  /** Per-frame-type breakdown, ranked by `db_ms` then `count`. */
  types: WsFrameSummary[];
}

export interface WsFrameMetricsOptions {
  enabled: boolean;
  summaryIntervalMs: number;
  summaryTopTypes: number;
  bufferCapacity: number;
}

export const DEFAULT_WS_SUMMARY_INTERVAL_MS = 60_000;
export const DEFAULT_WS_SUMMARY_TOP_TYPES = 20;
export const DEFAULT_WS_BUFFER_CAPACITY = 4096;

/**
 * Fixed-capacity ring of finished frames.
 *
 * Structurally the same design as `RequestMetricsRing`, for the same reason: the
 * summary must describe the most recent window, and a buffer that grows with
 * traffic turns an observability feature into a leak.
 */
export class WsFrameMetricsRing {
  private readonly typeIds = new Map<string, number>();
  private readonly typeNames: string[] = [];
  private readonly directionIds: Uint8Array;
  private readonly errorIds: Int32Array;
  private readonly totalMs: Float64Array;
  private readonly dbMs: Float64Array;
  private readonly dbQueries: Uint32Array;
  private readonly violationFlags: Uint8Array;
  private readonly frameTypeIds: Int32Array;
  private cursor = 0;
  private size = 0;
  private dropped = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`ws metrics buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.directionIds = new Uint8Array(capacity);
    this.errorIds = new Int32Array(capacity);
    this.totalMs = new Float64Array(capacity);
    this.dbMs = new Float64Array(capacity);
    this.dbQueries = new Uint32Array(capacity);
    this.violationFlags = new Uint8Array(capacity);
    this.frameTypeIds = new Int32Array(capacity);
    this.errorIds.fill(-1);
  }

  private internType(value: string): number {
    const existing = this.typeIds.get(value);
    if (existing !== undefined) return existing;
    // Bounded like the ring: a peer that invents frame types cannot grow this
    // table without bound, and the overflow bucket is still in the summary.
    if (this.typeNames.length >= 512) return -1;
    const id = this.typeNames.length;
    this.typeNames.push(value);
    this.typeIds.set(value, id);
    return id;
  }

  private internError(value: string | null): number {
    if (!value) return -1;
    const key = `\u0000${value}`;
    return this.internType(key);
  }

  record(sample: WsFrameSample): void {
    const index = this.cursor;
    if (this.size === this.capacity) this.dropped += 1;
    else this.size += 1;
    this.frameTypeIds[index] = this.internType(sample.type);
    this.directionIds[index] = sample.direction === "rpc" ? 1 : 0;
    this.errorIds[index] = this.internError(sample.errorCode);
    this.totalMs[index] = finite(sample.totalMs);
    this.dbMs[index] = finite(sample.dbMs);
    this.dbQueries[index] = Math.min(0xffff_ffff, Math.max(0, Math.trunc(finite(sample.dbQueries))));
    this.violationFlags[index] = sample.protocolViolation ? 1 : 0;
    this.cursor = (index + 1) % this.capacity;
  }

  drain(): { samples: WsFrameSample[]; dropped: number } {
    const samples: WsFrameSample[] = [];
    const oldest = this.size === this.capacity ? this.cursor : 0;
    for (let offset = 0; offset < this.size; offset += 1) {
      const index = (oldest + offset) % this.capacity;
      const typeId = this.frameTypeIds[index]!;
      const errorId = this.errorIds[index]!;
      samples.push({
        type: typeId >= 0 ? this.typeNames[typeId]! : "<unknown>",
        direction: this.directionIds[index] === 1 ? "rpc" : "uplink",
        errorCode: errorId >= 0 ? this.typeNames[errorId]!.slice(1) : null,
        totalMs: this.totalMs[index]!,
        dbMs: this.dbMs[index]!,
        dbQueries: this.dbQueries[index]!,
        protocolViolation: this.violationFlags[index] === 1,
      });
    }
    const dropped = this.dropped;
    this.size = 0;
    this.cursor = 0;
    this.dropped = 0;
    return { samples, dropped };
  }
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Nearest-rank percentile, matching `api_minute_summary` so the two are comparable. */
export function wsPercentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export interface WsWindowSummaryInput {
  windowMs: number;
  samples: WsFrameSample[];
  dropped: number;
  /** Process-level DB time attributed to this window. */
  dbMs: number;
  dbQueries: number;
  topTypes: number;
  now?: Date;
}

/**
 * Pure window aggregation. The whole summary line is derived here so the shape
 * and the ranking can be asserted without a live timer.
 */
export function summarizeWsWindow(input: WsWindowSummaryInput): WsMinuteSummary {
  const windowMs = finite(input.windowMs);
  const groups = new Map<string, {
    type: string;
    direction: "uplink" | "rpc";
    durations: number[];
    violations: number;
    dbMs: number;
    dbQueries: number;
  }>();
  for (const sample of input.samples) {
    const key = `${sample.direction}\u0000${sample.type}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: sample.type, direction: sample.direction, durations: [], violations: 0, dbMs: 0, dbQueries: 0 };
      groups.set(key, group);
    }
    group.durations.push(sample.totalMs);
    group.dbMs += sample.dbMs;
    group.dbQueries += sample.dbQueries;
    if (sample.protocolViolation) group.violations += 1;
  }

  const types: WsFrameSummary[] = [...groups.values()].map((group) => ({
    type: group.type,
    direction: group.direction,
    count: group.durations.length,
    violations: group.violations,
    db_ms: round1(group.dbMs),
    db_queries: Math.max(0, Math.trunc(group.dbQueries)),
    p50_ms: round1(wsPercentile(group.durations, 0.5)),
    p95_ms: round1(wsPercentile(group.durations, 0.95)),
  }));
  types.sort((left, right) => right.db_ms - left.db_ms
    || right.db_queries - left.db_queries
    || right.count - left.count
    || left.type.localeCompare(right.type));

  const top = Math.max(0, Math.trunc(input.topTypes));
  return {
    event: "ws_minute_summary",
    ts: (input.now ?? new Date()).toISOString(),
    window_ms: Math.round(windowMs),
    frames: input.samples.length,
    dropped: Math.max(0, Math.trunc(input.dropped)),
    db_busy_pct: windowMs > 0 ? round2((finite(input.dbMs) / windowMs) * 100) : 0,
    db_queries: Math.max(0, Math.trunc(finite(input.dbQueries))),
    types: types.slice(0, top),
  };
}

export interface WsFrameMetricsRuntime {
  /** Emit the current window right now (tests and smoke runs). */
  flush(): void;
  stop(): void;
  /** Record one finished frame. A no-op when metrics are disabled. */
  record(sample: WsFrameSample): void;
}

/**
 * Process-wide ring, shared by every connection so one summary describes the
 * whole server rather than one daemon.
 */
let wsRing: WsFrameMetricsRing | null = null;

function wsRingFor(capacity: number): WsFrameMetricsRing {
  if (!wsRing || wsRing.capacity !== capacity) wsRing = new WsFrameMetricsRing(capacity);
  return wsRing;
}

/**
 * Start the per-window summary for WebSocket frames.
 *
 * Mirrors `startRequestMetricsSummary`: one line per interval even when idle, so
 * "no daemon traffic" is distinguishable from "the feature died", and every
 * timer is `unref()`ed so a test or a short-lived process can exit.
 */
export function startWsFrameMetricsSummary(
  options: WsFrameMetricsOptions,
  readProcessDb: () => { dbMs: number; dbQueries: number },
): WsFrameMetricsRuntime | null {
  if (!options.enabled) {
    return {
      flush: () => {},
      stop: () => {},
      record: () => {},
    };
  }
  const buffer = wsRingFor(options.bufferCapacity);

  let lastDbMs = readProcessDb().dbMs;
  let lastDbQueries = readProcessDb().dbQueries;
  let lastTickAt = performance.now();

  const emit = (): void => {
    const { samples, dropped } = buffer.drain();
    const windowMs = performance.now() - lastTickAt;
    lastTickAt = performance.now();
    const counters = readProcessDb();
    const dbMs = counters.dbMs - lastDbMs;
    const dbQueries = counters.dbQueries - lastDbQueries;
    lastDbMs = counters.dbMs;
    lastDbQueries = counters.dbQueries;
    console.log(JSON.stringify(summarizeWsWindow({
      windowMs,
      samples,
      dropped,
      dbMs,
      dbQueries,
      topTypes: options.summaryTopTypes,
    })));
  };

  const timer = setInterval(() => {
    try {
      emit();
    } catch (error) {
      console.warn(`[ws-metrics] ws_minute_summary failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }, options.summaryIntervalMs);
  timer.unref?.();

  return {
    flush: () => {
      try {
        emit();
      } catch (error) {
        console.warn(`[ws-metrics] ws_minute_summary failed: ${(error as Error)?.message ?? String(error)}`);
      }
    },
    stop: () => clearInterval(timer),
    record: (sample) => buffer.record(sample),
  };
}

/**
 * The WS metrics configuration, derived from the HTTP one.
 *
 * Derived rather than re-resolved from the environment on purpose: the Issue's
 * requirement is that the two summaries cover the SAME window, and two
 * independent readers of the same env vars can drift the moment one caller passes
 * an explicit override (`startMultiremiServer({ requestMetrics })`, which is how
 * tests and smoke runs shorten the interval). Sharing the resolved values makes
 * the alignment structural instead of conventional. The per-type list is wider
 * than the per-route one because frame types are the whole breakdown here.
 */
export function wsFrameMetricsFromHttp(
  http: { enabled: boolean; summaryIntervalMs: number; summaryTopRoutes: number; bufferCapacity: number },
): WsFrameMetricsOptions {
  return {
    enabled: http.enabled,
    summaryIntervalMs: http.summaryIntervalMs,
    summaryTopTypes: Math.max(DEFAULT_WS_SUMMARY_TOP_TYPES, http.summaryTopRoutes),
    bufferCapacity: http.bufferCapacity,
  };
}

/** Test seam: drop the process ring so one case cannot leak samples into the next. */
export function resetWsFrameMetricsForTest(): void {
  wsRing = null;
}

/** Test seam: read and clear the window, so a case can assert on stored samples. */
export function drainWsFrameMetricsForTest(): { samples: WsFrameSample[]; dropped: number } {
  if (!wsRing) return { samples: [], dropped: 0 };
  return wsRing.drain();
}
