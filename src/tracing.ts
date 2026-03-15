/**
 * DB-backed tracing system with OTel-compatible span format.
 *
 * Write path: Spans are buffered in memory per traceId.
 * Read path: Queries the `conversations` DB table directly.
 *
 * Usage (unchanged from JSONL version):
 *   const collector = new TraceCollector();
 *   const root = collector.startTrace("core.handle", { "chat.id": "abc" });
 *   const child = root.context().startSpan("provider.chat");
 *   child.setAttribute("llm.model", "claude-opus-4-6");
 *   child.end();
 *   root.end();
 */

import { randomBytes } from "node:crypto";
import { getDb } from "./db/index.js";

// ── Data types (OTel-compatible) ──────────────────────────────────

export interface SpanData {
  traceId: string;          // 32 hex chars
  spanId: string;           // 16 hex chars
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  startTime: string;        // ISO-8601
  endTime?: string;
  durationMs?: number;
  status: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events?: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceData {
  traceId: string;
  rootSpan: SpanData;
  spans: SpanData[];
  startTime: string;
  endTime: string;
  durationMs: number;
  source?: string;
  status: "OK" | "ERROR" | "UNSET";
}

// ── Interfaces ────────────────────────────────────────────────────

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  startSpan(operationName: string, attributes?: Record<string, string | number | boolean>): Span;
}

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  context(): TraceContext;
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attrs: Record<string, string | number | boolean>): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  end(): void;
  endWithError(message: string): void;
}

export interface SpanExporter {
  export(spans: SpanData[]): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ── ID generation ─────────────────────────────────────────────────

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

// ── Span implementation ───────────────────────────────────────────

class SpanImpl implements Span {
  readonly spanId: string;
  readonly traceId: string;
  private readonly _parentSpanId?: string;
  private readonly _operationName: string;
  private readonly _startTime: string;
  private readonly _startMs: number;
  private readonly _collector: TraceCollector;
  private readonly _attributes: Record<string, string | number | boolean>;
  private readonly _events: SpanEvent[] = [];
  private _ended = false;

  constructor(
    traceId: string,
    parentSpanId: string | undefined,
    operationName: string,
    collector: TraceCollector,
    attributes?: Record<string, string | number | boolean>,
  ) {
    this.spanId = generateSpanId();
    this.traceId = traceId;
    this._parentSpanId = parentSpanId;
    this._operationName = operationName;
    this._collector = collector;
    this._startTime = new Date().toISOString();
    this._startMs = performance.now();
    this._attributes = { ...attributes };
  }

  context(): TraceContext {
    return new TraceContextImpl(this.traceId, this.spanId, this._collector);
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this._attributes[key] = value;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): void {
    Object.assign(this._attributes, attrs);
  }

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    this._events.push({ name, timestamp: new Date().toISOString(), attributes });
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    const endTime = new Date().toISOString();
    const durationMs = Math.round(performance.now() - this._startMs);
    this._collector.recordSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this._parentSpanId,
      operationName: this._operationName,
      serviceName: "remi",
      startTime: this._startTime,
      endTime,
      durationMs,
      status: "OK",
      attributes: this._attributes,
      events: this._events.length > 0 ? this._events : undefined,
    });
  }

  endWithError(message: string): void {
    if (this._ended) return;
    this._ended = true;
    const endTime = new Date().toISOString();
    const durationMs = Math.round(performance.now() - this._startMs);
    this._collector.recordSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this._parentSpanId,
      operationName: this._operationName,
      serviceName: "remi",
      startTime: this._startTime,
      endTime,
      durationMs,
      status: "ERROR",
      statusMessage: message,
      attributes: this._attributes,
      events: this._events.length > 0 ? this._events : undefined,
    });
  }
}

// ── TraceContext implementation ────────────────────────────────────

class TraceContextImpl implements TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  private readonly _collector: TraceCollector;

  constructor(traceId: string, spanId: string, collector: TraceCollector) {
    this.traceId = traceId;
    this.spanId = spanId;
    this._collector = collector;
  }

  startSpan(operationName: string, attributes?: Record<string, string | number | boolean>): Span {
    return new SpanImpl(this.traceId, this.spanId, operationName, this._collector, attributes);
  }
}

// ── Row → TraceData conversion ────────────────────────────────────

interface ConversationRow {
  id: number;
  status: string;
  error?: string;
  chat_id: string;
  sender_id?: string;
  connector?: string;
  cli_session_id?: string;
  cli_cwd?: string;
  cli_round_start?: string;
  cli_round_end?: string;
  cost_usd?: number;
  duration_ms?: number;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  spans?: string;
  created_at: string;
}

export function rowToTraceData(row: ConversationRow): TraceData {
  const traceId = String(row.id);
  const status: TraceData["status"] =
    row.status === "failed" ? "ERROR"
    : row.status === "processing" ? "UNSET"
    : "OK";
  const startTime = row.cli_round_start ?? row.created_at;
  const endTime = row.cli_round_end ?? row.created_at;

  const rootSpan: SpanData = {
    traceId,
    spanId: traceId,
    operationName: `handle: [${row.connector ?? "?"}] ${row.chat_id?.slice(-12) ?? ""}`,
    serviceName: "remi",
    startTime,
    endTime,
    durationMs: row.duration_ms ?? 0,
    status,
    attributes: {
      "chat.id": row.chat_id ?? "",
      "connector.name": row.connector ?? "",
      "session.id": row.cli_session_id ?? "",
      "model": row.model ?? "",
      "input_tokens": row.input_tokens ?? 0,
      "output_tokens": row.output_tokens ?? 0,
      "cost_usd": row.cost_usd ?? 0,
    },
  };

  // Parse spans JSON → SpanData[], with sequential startTime estimation
  let rawSpans: Array<{ op: string; ms?: number; model?: string; tool_count?: number }> = [];
  try {
    rawSpans = JSON.parse(row.spans ?? "[]");
  } catch { /* ignore */ }

  let elapsed = 0;
  const startMs = new Date(startTime).getTime();
  const spans: SpanData[] = [rootSpan];

  for (const s of rawSpans) {
    const ms = s.ms ?? 0;
    const spanStart = new Date(startMs + elapsed).toISOString();
    spans.push({
      traceId,
      spanId: `${row.id}-${spans.length}`,
      parentSpanId: traceId,
      operationName: s.op,
      serviceName: "remi",
      startTime: spanStart,
      endTime: new Date(startMs + elapsed + ms).toISOString(),
      durationMs: ms,
      status: "OK",
      attributes: s.model ? { "llm.model": s.model } : {},
    });
    elapsed += ms;
  }

  return {
    traceId,
    rootSpan,
    spans,
    startTime,
    endTime,
    durationMs: row.duration_ms ?? 0,
    source: row.connector,
    status,
  };
}

// ── Monitor stats type ────────────────────────────────────────────

export interface MonitorTraceStats {
  tracesCount: number;
  errorsCount: number;
  errorRate: number;
  latencyP50: number | null;
  latencyP95: number | null;
  latencyAvg: number | null;
  topOperations: Array<{ name: string; count: number; avgMs: number }>;
}

// ── TraceCollector ────────────────────────────────────────────────

export class TraceCollector {
  /** In-memory span buffer: traceId → SpanData[] */
  private _pendingSpans = new Map<string, SpanData[]>();

  constructor(_tracesDir?: string) {
    // tracesDir kept as optional param for backward compat, but unused
  }

  /** Start a new trace with a root span. */
  startTrace(operationName: string, attributes?: Record<string, string | number | boolean>): Span {
    const traceId = generateTraceId();
    return new SpanImpl(traceId, undefined, operationName, this, attributes);
  }

  /** Buffer a completed span in memory (no longer writes to JSONL). */
  recordSpan(span: SpanData): void {
    const arr = this._pendingSpans.get(span.traceId) ?? [];
    arr.push(span);
    this._pendingSpans.set(span.traceId, arr);
  }

  /** Flush and return all buffered spans for a trace. Called by core.ts before completeConversation. */
  flushTrace(traceId: string): SpanData[] {
    const spans = this._pendingSpans.get(traceId) ?? [];
    this._pendingSpans.delete(traceId);
    return spans;
  }

  // ── Query methods: DB-backed ────────────────────────────────────

  /** Get recent traces for a given date. */
  getRecentTraces(limit: number, date?: string): TraceData[] {
    const db = getDb();
    const d = date ?? new Date().toISOString().slice(0, 10);
    const rows = db.query(`
      SELECT id, status, error, chat_id, sender_id, connector,
             cli_session_id, cost_usd, duration_ms, model,
             input_tokens, output_tokens, spans,
             created_at, cli_round_start, cli_round_end
      FROM conversations
      WHERE DATE(created_at) = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(d, limit) as ConversationRow[];
    return rows.map(rowToTraceData);
  }

  /** Get a single trace by conversations.id. */
  getTrace(id: string): TraceData | null {
    const db = getDb();
    const row = db.query("SELECT * FROM conversations WHERE id = ?").get(Number(id)) as ConversationRow | null;
    return row ? rowToTraceData(row) : null;
  }

  /** Compute monitor stats from today's conversations. */
  getMonitorStats(date?: string): MonitorTraceStats {
    const db = getDb();
    const d = date ?? new Date().toISOString().slice(0, 10);
    const rows = db.query(`
      SELECT status, duration_ms, spans
      FROM conversations
      WHERE DATE(created_at) = ?
    `).all(d) as Array<{ status: string; duration_ms: number | null; spans: string | null }>;

    const tracesCount = rows.length;
    const errorsCount = rows.filter(r => r.status === "failed").length;
    const errorRate = tracesCount > 0 ? Math.round((errorsCount / tracesCount) * 1000) / 10 : 0;

    // Latency percentiles
    const durations = rows
      .map(r => r.duration_ms ?? 0)
      .filter(d => d > 0)
      .sort((a, b) => a - b);

    const latencyP50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : null;
    const latencyP95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : null;
    const latencyAvg = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    // Top operations from spans JSON
    const opMap = new Map<string, { count: number; totalMs: number }>();
    for (const row of rows) {
      let spanArr: Array<{ op: string; ms?: number }> = [];
      try { spanArr = JSON.parse(row.spans ?? "[]"); } catch { /* skip */ }
      for (const s of spanArr) {
        const existing = opMap.get(s.op);
        if (existing) {
          existing.count++;
          existing.totalMs += s.ms ?? 0;
        } else {
          opMap.set(s.op, { count: 1, totalMs: s.ms ?? 0 });
        }
      }
    }
    const topOperations = [...opMap.entries()]
      .map(([name, data]) => ({ name, count: data.count, avgMs: Math.round(data.totalMs / data.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { tracesCount, errorsCount, errorRate, latencyP50, latencyP95, latencyAvg, topOperations };
  }

  // ── Deprecated methods (kept for backward compat) ───────────────

  /** @deprecated No longer needed — DB has no file-based retention. */
  cleanupOldTraces(_retentionDays: number): number { return 0; }

  /** @deprecated Use getRecentTraces() instead. */
  readDay(_date: string): SpanData[] { return []; }

  /** @deprecated Use getRecentTraces() with date param instead. */
  listDates(): string[] { return []; }
}
