import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TRACE_END_STATUSES, TRACE_FILE_FORMAT, type TraceFileHeader, type TraceFileTrailer } from "@multiremi/contracts/trace-file.js";
import { createLogger } from "@shared/logger.js";
import {
  sanitizeStoredEvent,
  traceEventBytes,
  TRACE_READ_DEFAULT_LIMIT,
  TRACE_READ_MAX_LIMIT,
  type TraceAppendResult,
  type TraceClock,
  type TraceCloseInput,
  type TraceReadResult,
  type TraceStore,
  type TraceStoreHead,
} from "./trace-store.js";

const log = createLogger("multiremi-trace-file-store");

export interface TraceTaskContext {
  /** Issue/chat Session id; omitted for a one-shot task. */
  sessionId?: string | null;
  agentId: string;
  provider: string;
  startedAt: string;
}

export interface TraceFileStoreOptions {
  workspacesRoot: string;
  resolveTask: (taskId: string) => TraceTaskContext;
  now?: TraceClock;
  onWarning?: (path: string, reason: string) => void;
}

interface IndexedTrace {
  path: string;
  dev: number;
  ino: number;
  head: number;
  eventCount: number;
  closed: boolean;
  /** Bytes through the last complete line; an interrupted final line is ignored. */
  completeBytes: number;
}

type TraceEvent = TraceAppendResult["events"][number];
type TraceEventInput = Parameters<TraceStore["append"]>[1][number];

function safeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id !== "." && id !== "..";
}

function realDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe trace directory: ${path}`);
  return true;
}

function ensureDirectory(path: string): void {
  if (!realDirectory(path)) mkdirSync(path, { mode: 0o700 });
}

function isHeader(value: unknown, taskId: string, sessionId: string): value is TraceFileHeader {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TraceFileHeader> & { seq?: unknown };
  return row.format === TRACE_FILE_FORMAT && row.task_id === taskId && row.session_id === sessionId
    && typeof row.agent_id === "string" && typeof row.provider === "string"
    && typeof row.started_at === "string" && row.seq === undefined;
}

function isTrailer(value: unknown): value is TraceFileTrailer {
  if (!value || typeof value !== "object" || "seq" in value) return false;
  const end = (value as { end?: Partial<TraceFileTrailer["end"]> }).end;
  return !!end && TRACE_END_STATUSES.includes(end.status as typeof TRACE_END_STATUSES[number])
    && Number.isSafeInteger(end.head) && (end.head ?? -1) >= 0
    && Number.isSafeInteger(end.event_count) && (end.event_count ?? -1) >= 0
    && typeof end.ended_at === "string";
}

function isEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TraceEvent>;
  return Number.isSafeInteger(row.seq) && (row.seq ?? 0) >= 1
    && typeof row.ts === "string" && typeof row.type === "string";
}

function completeLines(path: string): { lines: string[]; completeBytes: number; dev: number; ino: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let buffer: Buffer;
  let stat: ReturnType<typeof fstatSync>;
  try {
    stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Unsafe trace file: ${path}`);
    buffer = readFileSync(fd);
  } finally { closeSync(fd); }
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline < 0) return { lines: [], completeBytes: 0, dev: stat.dev, ino: stat.ino };
  return {
    lines: buffer.subarray(0, lastNewline).toString("utf8").split("\n"),
    completeBytes: lastNewline + 1,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/** Durable, per-task JSONL implementation of A-0's TraceStore. */
export class TraceFileStore implements TraceStore {
  private readonly root: string;
  private readonly index = new Map<string, IndexedTrace>();
  private readonly now: TraceClock;

  constructor(private readonly options: TraceFileStoreOptions) {
    this.root = resolve(options.workspacesRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.rebuildIndex();
  }

  private warn(path: string, reason: string): void {
    this.options.onWarning?.(path, reason);
    log.warn(`Trace file skipped or damaged: ${path}: ${reason}`);
  }

  private inspect(path: string, taskId: string, sessionId: string): IndexedTrace {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular trace file");
    const { lines, completeBytes, dev, ino } = completeLines(path);
    if (stat.dev !== dev || stat.ino !== ino) throw new Error("trace file changed during inspection");
    if (!lines.length) throw new Error("missing complete header");
    let header: unknown;
    try { header = JSON.parse(lines[0]!); } catch { throw new Error("invalid header JSON"); }
    if (!isHeader(header, taskId, sessionId)) throw new Error("invalid header");

    let head = 0;
    let eventCount = 0;
    let closed = false;
    const seen = new Set<number>();
    for (let i = 1; i < lines.length; i++) {
      let row: unknown;
      try { row = JSON.parse(lines[i]!); } catch { throw new Error(`invalid JSON at line ${i + 1}`); }
      if (isTrailer(row) && i === lines.length - 1) {
        if (row.end.head !== head || row.end.event_count !== eventCount) throw new Error("trailer counts disagree with events");
        closed = true;
        continue;
      }
      if (!isEvent(row)) throw new Error(`invalid event at line ${i + 1}`);
      if (seen.has(row.seq)) {
        this.warn(path, `duplicate seq ${row.seq}; retaining first occurrence`);
        continue;
      }
      if (row.seq < head) throw new Error(`out-of-order seq ${row.seq} at line ${i + 1}`);
      seen.add(row.seq);
      head = Math.max(head, row.seq);
      eventCount++;
    }
    return { path, dev, ino, head, eventCount, closed, completeBytes };
  }

  rebuildIndex(): void {
    this.index.clear();
    const runtimeRoot = join(this.root, ".runtime");
    if (!realDirectory(runtimeRoot)) return;
    for (const session of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!session.isDirectory() || !safeId(session.name)) continue;
      const sessionRoot = join(runtimeRoot, session.name);
      try {
        if (!realDirectory(sessionRoot)) continue;
        const traces = join(sessionRoot, "traces");
        if (!realDirectory(traces)) continue;
        for (const file of readdirSync(traces, { withFileTypes: true })) {
          if (!file.name.endsWith(".jsonl")) continue;
          const taskId = file.name.slice(0, -6);
          const path = join(traces, file.name);
          try {
            if (!safeId(taskId) || !file.isFile()) throw new Error("invalid trace filename or file type");
            const entry = this.inspect(path, taskId, session.name);
            if (this.index.has(taskId)) throw new Error("duplicate task id in another session");
            this.index.set(taskId, entry);
          } catch (error) {
            this.warn(path, error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        this.warn(sessionRoot, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private create(taskId: string): IndexedTrace {
    if (!safeId(taskId)) throw new Error(`Invalid trace task id: ${taskId}`);
    const context = this.options.resolveTask(taskId);
    const sessionId = context.sessionId ?? taskId;
    if (!safeId(sessionId)) throw new Error(`Invalid trace session id: ${sessionId}`);
    ensureDirectory(this.root);
    const runtimeRoot = join(this.root, ".runtime");
    ensureDirectory(runtimeRoot);
    const sessionRoot = join(runtimeRoot, sessionId);
    ensureDirectory(sessionRoot);
    const traces = join(sessionRoot, "traces");
    ensureDirectory(traces);
    const path = join(traces, `${taskId}.jsonl`);
    if (existsSync(path)) {
      const entry = this.inspect(path, taskId, sessionId);
      this.index.set(taskId, entry);
      return entry;
    }
    const header: TraceFileHeader = {
      format: TRACE_FILE_FORMAT,
      task_id: taskId,
      session_id: sessionId,
      agent_id: context.agentId,
      provider: context.provider,
      started_at: context.startedAt,
    };
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(header)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    const stat = lstatSync(path);
    const entry: IndexedTrace = { path, dev: stat.dev, ino: stat.ino, head: 0, eventCount: 0, closed: false, completeBytes: stat.size };
    this.index.set(taskId, entry);
    return entry;
  }

  append(taskId: string, events: TraceEventInput[]): TraceAppendResult {
    const entry = this.index.get(taskId) ?? this.create(taskId);
    if (entry.closed || events.length === 0) return { head: entry.head, events: [] };
    const stored = events.map((event, offset): TraceEvent => ({
      ...sanitizeStoredEvent(event, event.ts ?? this.now()),
      seq: entry.head + offset + 1,
    }));
    // A previous crash may have left an unterminated JSON fragment. Remove only
    // that fragment before appending complete lines to this known-owned file.
    const fd = openSync(entry.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during append");
      ftruncateSync(fd, entry.completeBytes);
      writeFileSync(fd, stored.map((row) => `${JSON.stringify(row)}\n`).join(""));
      entry.completeBytes = fstatSync(fd).size;
    }
    finally { closeSync(fd); }
    entry.head += stored.length;
    entry.eventCount += stored.length;
    return { head: entry.head, events: stored };
  }

  read(taskId: string, afterSeq = 0, limit = TRACE_READ_DEFAULT_LIMIT, maxBytes = Number.MAX_SAFE_INTEGER): TraceReadResult {
    const entry = this.index.get(taskId);
    if (!entry) return { events: [], head: 0, eof: true };
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), TRACE_READ_MAX_LIMIT)) : TRACE_READ_DEFAULT_LIMIT;
    const events: TraceEvent[] = [];
    const seen = new Set<number>();
    let bytes = 0;
    const data = completeLines(entry.path);
    if (data.dev !== entry.dev || data.ino !== entry.ino) throw new Error("trace file changed during read");
    for (const line of data.lines.slice(1)) {
      let row: unknown;
      try { row = JSON.parse(line); } catch { this.warn(entry.path, "invalid JSON during read"); break; }
      if (!isEvent(row)) continue;
      if (seen.has(row.seq)) { this.warn(entry.path, `duplicate seq ${row.seq}; retaining first occurrence`); continue; }
      seen.add(row.seq);
      if (row.seq <= afterSeq) continue;
      if (events.length >= boundedLimit) break;
      const size = traceEventBytes(row);
      if (events.length > 0 && bytes + size > maxBytes) break;
      events.push(row);
      bytes += size;
    }
    return { events, head: entry.head, eof: (events.at(-1)?.seq ?? afterSeq) >= entry.head };
  }

  head(taskId: string): TraceStoreHead | null {
    const entry = this.index.get(taskId);
    return entry ? { head: entry.head, closed: entry.closed } : null;
  }

  close(taskId: string, end: TraceCloseInput): void {
    const entry = this.index.get(taskId) ?? this.create(taskId);
    if (entry.closed) return;
    const trailer: TraceFileTrailer = { end: {
      status: end.status,
      head: entry.head,
      event_count: entry.eventCount,
      ended_at: end.ended_at,
    } };
    const fd = openSync(entry.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during close");
      ftruncateSync(fd, entry.completeBytes);
      writeFileSync(fd, `${JSON.stringify(trailer)}\n`);
      fsyncSync(fd);
      entry.completeBytes = fstatSync(fd).size;
    }
    finally { closeSync(fd); }
    entry.closed = true;
  }

  forget(taskId: string): void {
    const entry = this.index.get(taskId);
    if (!entry) return;
    rmSync(entry.path);
    this.index.delete(taskId);
  }
}
