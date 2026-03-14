/**
 * Lightweight tracing system with OTel-compatible span format.
 *
 * Usage:
 *   const collector = new TraceCollector("~/.remi/traces");
 *   const root = collector.startTrace("core.handle", { "chat.id": "abc" });
 *   const child = root.context().startSpan("provider.chat");
 *   child.setAttribute("llm.model", "claude-opus-4-6");
 *   child.end();
 *   root.end();
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { exportSpan, registerSpan } from "./langsmith-exporter.js";

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
    registerSpan(this.spanId, traceId, parentSpanId, operationName, attributes);
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

// ── TraceCollector ────────────────────────────────────────────────

export class TraceCollector {
  readonly tracesDir: string;

  constructor(tracesDir: string) {
    this.tracesDir = tracesDir;
    mkdirSync(tracesDir, { recursive: true });
  }

  /** Start a new trace with a root span. */
  startTrace(operationName: string, attributes?: Record<string, string | number | boolean>): Span {
    const traceId = generateTraceId();
    return new SpanImpl(traceId, undefined, operationName, this, attributes);
  }

  /** Record a completed span to JSONL and export to LangSmith. */
  recordSpan(span: SpanData): void {
    const date = span.startTime.slice(0, 10);
    const filePath = join(this.tracesDir, `${date}.jsonl`);
    appendFileSync(filePath, JSON.stringify(span) + "\n");
    exportSpan(span);
  }

  /** Read all spans for a given date. */
  readDay(date: string): SpanData[] {
    const filePath = join(this.tracesDir, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    const spans: SpanData[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        spans.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return spans;
  }

  /** List available dates (YYYY-MM-DD). */
  listDates(): string[] {
    if (!existsSync(this.tracesDir)) return [];
    return readdirSync(this.tracesDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort()
      .reverse();
  }

  /** Assemble a full trace from its spans. */
  getTrace(traceId: string, date?: string): TraceData | null {
    const dates = date ? [date] : this.listDates().slice(0, 7); // search recent 7 days
    let allSpans: SpanData[] = [];
    for (const d of dates) {
      const daySpans = this.readDay(d).filter((s) => s.traceId === traceId);
      allSpans = allSpans.concat(daySpans);
      if (allSpans.length > 0 && d !== dates[0]) break; // found in an older day, stop
    }
    if (allSpans.length === 0) return null;

    const rootSpan = allSpans.find((s) => !s.parentSpanId) ?? allSpans[0];
    const sorted = allSpans.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const hasError = allSpans.some((s) => s.status === "ERROR");

    return {
      traceId,
      rootSpan,
      spans: sorted,
      startTime: rootSpan.startTime,
      endTime: rootSpan.endTime ?? sorted[sorted.length - 1].endTime ?? rootSpan.startTime,
      durationMs: rootSpan.durationMs ?? 0,
      source: rootSpan.attributes["connector.name"] as string | undefined,
      status: hasError ? "ERROR" : "OK",
    };
  }

  /** Get recent traces (assembled), limited to N. */
  getRecentTraces(limit: number, date?: string): TraceData[] {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const spans = this.readDay(d);
    // Find unique traceIds from root spans (no parentSpanId)
    const rootSpans = spans
      .filter((s) => !s.parentSpanId)
      .sort((a, b) => b.startTime.localeCompare(a.startTime))
      .slice(0, limit);

    const traces: TraceData[] = [];
    for (const root of rootSpans) {
      const traceSpans = spans
        .filter((s) => s.traceId === root.traceId)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      const hasError = traceSpans.some((s) => s.status === "ERROR");
      traces.push({
        traceId: root.traceId,
        rootSpan: root,
        spans: traceSpans,
        startTime: root.startTime,
        endTime: root.endTime ?? traceSpans[traceSpans.length - 1]?.endTime ?? root.startTime,
        durationMs: root.durationMs ?? 0,
        source: root.attributes["connector.name"] as string | undefined,
        status: hasError ? "ERROR" : "OK",
      });
    }
    return traces;
  }

  /** Delete JSONL trace files older than retentionDays. Returns count removed. */
  cleanupOldTraces(retentionDays: number): number {
    if (!existsSync(this.tracesDir)) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let removed = 0;
    for (const file of readdirSync(this.tracesDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr) {
        unlinkSync(join(this.tracesDir, file));
        removed++;
      }
    }
    return removed;
  }
}
