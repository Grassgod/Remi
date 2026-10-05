import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { checkTraceFileLines, isTraceFileEvent, isTraceFileTrailer, TRACE_FILE_FORMAT, type TraceFileHeader, type TraceFileTrailer } from "@multiremi/contracts/trace-file.js";
import { assertRealDirectoryPath } from "@daemon/agent-runtime/workspace/safe-remove.js";
import { createLogger } from "@shared/logger.js";
import {
  sanitizeStoredEvent,
  traceEventBytes,
  normalizeTraceReadArgs,
  TRACE_READ_DEFAULT_LIMIT,
  type TraceAppendResult,
  type TraceClock,
  type TraceCloseInput,
  type TraceReadResult,
  type TraceStore,
  type TraceStoreHead,
} from "./trace-store.js";

const log = createLogger("multiremi-trace-file-store");
export const TRACE_FILE_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Leave room for task/runtime ids and the trace RPC/push envelope. */
export const TRACE_FILE_MAX_EVENT_BYTES = TRACE_FILE_MAX_LINE_BYTES - 8 * 1024;

export interface TraceTaskContext {
  /** Issue/chat Session id; omitted for a one-shot task. */
  sessionId?: string | null;
  agentId: string;
  provider: string;
  startedAt: string;
  runtimeId?: string;
  issueId?: string | null;
  /** Production subject identity for archive-gated collection of early failures. */
  subjectKind?: "chat" | "task";
}

export interface TraceFileStoreOptions {
  workspacesRoot: string;
  resolveTask: (taskId: string) => TraceTaskContext;
  now?: TraceClock;
  onWarning?: (path: string, reason: string) => void;
  /** Diagnostics: bytes physically read, including bounded chunk read-ahead. */
  onReadBytes?: (bytes: number) => void;
}

interface IndexedTrace {
  path: string;
  directories: Array<{ path: string; info: Stats }>;
  dev: number;
  ino: number;
  head: number;
  eventCount: number;
  closed: boolean;
  /** Bytes through the last complete line; an interrupted final line is ignored. */
  completeBytes: number;
  context: TraceTaskContext;
  /** Only sequence/offset pairs are resident; event payloads stay on disk. */
  offsets: Array<{ seq: number; offset: number }>;
  duplicates?: boolean;
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

function writeLine(fd: number, line: string): number {
  const buffer = Buffer.from(line);
  let written = 0;
  while (written < buffer.length) {
    const size = writeSync(fd, buffer, written, buffer.length - written, null);
    if (!size) throw new Error("trace append made no progress");
    written += size;
  }
  return buffer.length;
}

function* completeLines(fd: number, start: number, end: number, onRead?: (bytes: number) => void): Generator<{ line: string; offset: number; end: number }> {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = start;
  let lineStart = start;
  let pending = Buffer.alloc(0);
  while (position < end) {
    const size = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
    if (!size) break;
    onRead?.(size);
    position += size;
    const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, size)]) : chunk.subarray(0, size);
    let consumed = 0;
    for (;;) {
      const newline = data.indexOf(10, consumed);
      if (newline < 0) break;
      if (newline - consumed + 1 > TRACE_FILE_MAX_LINE_BYTES) throw new Error("trace line exceeds normalized event budget");
      const next = lineStart + newline - consumed + 1;
      yield { line: data.subarray(consumed, newline).toString("utf8"), offset: lineStart, end: next };
      lineStart = next;
      consumed = newline + 1;
    }
    pending = Buffer.from(data.subarray(consumed));
    if (pending.length >= TRACE_FILE_MAX_LINE_BYTES) throw new Error("trace line exceeds normalized event budget");
  }
}

/** Durable, per-task JSONL implementation of A-0's TraceStore. */
export class TraceFileStore implements TraceStore {
  private readonly root: string;
  private readonly index = new Map<string, IndexedTrace>();
  private readonly now: TraceClock;
  private readonly contexts = new Map<string, TraceTaskContext>();

  constructor(private readonly options: TraceFileStoreOptions) {
    this.root = resolve(options.workspacesRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.rebuildIndex();
  }

  registerTask(taskId: string, context: TraceTaskContext): void {
    const previous = this.index.get(taskId)?.context ?? this.contexts.get(taskId);
    if (previous?.runtimeId && previous.runtimeId !== context.runtimeId) throw new Error("trace runtime ownership changed");
    this.contexts.set(taskId, context);
  }

  registerRuntime(taskId: string, runtimeId: string): void {
    const context = this.index.get(taskId)?.context ?? this.contexts.get(taskId) ?? this.options.resolveTask(taskId);
    this.registerTask(taskId, { ...context, runtimeId });
  }

  ownership(): ReadonlyMap<string, string> {
    return new Map([...this.index].flatMap(([taskId, entry]) => entry.context.runtimeId ? [[taskId, entry.context.runtimeId] as const] : []));
  }

  private warn(path: string, reason: string): void {
    this.options.onWarning?.(path, reason);
    log.warn(`Trace file skipped or damaged: ${path}: ${reason}`);
  }

  private directoryChain(path: string): Array<{ path: string; info: Stats }> {
    const traces = dirname(path);
    const session = dirname(traces);
    const runtime = dirname(session);
    if (dirname(runtime) !== this.root || basename(runtime) !== ".runtime" || basename(traces) !== "traces") {
      throw new Error(`Trace path is outside owned root: ${path}`);
    }
    return [this.root, runtime, session, traces].map((part) => {
      const info = lstatSync(part);
      assertRealDirectoryPath(part, info, "trace directory");
      return { path: part, info };
    });
  }

  private assertOwned(entry: IndexedTrace): void {
    for (const directory of entry.directories) {
      assertRealDirectoryPath(directory.path, directory.info, "trace directory");
    }
    const stat = lstatSync(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new Error(`trace file identity changed: ${entry.path}`);
    }
  }

  private inspect(path: string, taskId: string, sessionId: string): IndexedTrace {
    const directories = this.directoryChain(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular trace file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const offsets: IndexedTrace["offsets"] = [];
    let header: TraceFileHeader | undefined;
    let completeBytes = 0;
    let head = 0;
    let closed = false;
    let duplicates = false;
    const seen = new Set<number>();
    try {
      const opened = fstatSync(fd);
      if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw new Error("trace file changed during inspection");
      for (const record of completeLines(fd, 0, opened.size, this.options.onReadBytes)) {
        if (!header) {
          const checked = checkTraceFileLines([record.line], { taskId, sessionId });
          if (!checked.ok) throw new Error(checked.reason);
          header = JSON.parse(record.line);
          if (header!.runtime_id !== undefined && (typeof header!.runtime_id !== "string" || !header!.runtime_id)) throw new Error("invalid runtime owner");
        } else {
          if (closed) throw new Error("trailer is not final line");
          const row: unknown = JSON.parse(record.line);
          if (isTraceFileTrailer(row)) {
            if (row.end.head !== head || row.end.event_count !== offsets.length) throw new Error("trailer counts disagree with events");
            if (duplicates || record.end !== opened.size) throw new Error("ambiguous trailer after recovered events");
            closed = true;
          } else {
            if (!isTraceFileEvent(row)) throw new Error("invalid trace event");
            if (seen.has(row.seq)) { duplicates = true; this.warn(path, `duplicate seq ${row.seq}; retaining first occurrence`); }
            else {
              if (row.seq < head) throw new Error(`out-of-order seq ${row.seq}`);
              offsets.push({ seq: row.seq, offset: record.offset });
              seen.add(row.seq);
              head = row.seq;
            }
          }
        }
        completeBytes = record.end;
      }
      if (!header) throw new Error("missing complete header");
    } finally { closeSync(fd); }
    for (const directory of directories) assertRealDirectoryPath(directory.path, directory.info, "trace directory");
    return { path, directories, dev: stat.dev, ino: stat.ino, head,
      eventCount: offsets.length, closed, completeBytes, offsets, duplicates,
      context: { sessionId: header.session_id, agentId: header.agent_id, provider: header.provider,
        startedAt: header.started_at, runtimeId: header.runtime_id } };
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
    const context = this.contexts.get(taskId) ?? this.options.resolveTask(taskId);
    const sessionId = context.sessionId ?? taskId;
    if (!safeId(sessionId)) throw new Error(`Invalid trace session id: ${sessionId}`);
    ensureDirectory(this.root);
    const runtimeRoot = join(this.root, ".runtime");
    ensureDirectory(runtimeRoot);
    const sessionRoot = join(runtimeRoot, sessionId);
    ensureDirectory(sessionRoot);
    if (context.issueId || context.subjectKind) {
      // A preparation failure can emit a trace before provider-home setup
      // writes GC metadata. The canonical Issue archive root enumerator must
      // still discover this Session and retain its process history.
      const metadata = join(sessionRoot, ".multiremi");
      ensureDirectory(metadata);
      const gcPath = join(metadata, "gc.json");
      if (!existsSync(gcPath)) {
        const fd = openSync(gcPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const metadata = context.issueId
          ? { version: 2, kind: "issue_runtime", issue_id: context.issueId }
          : context.subjectKind === "chat"
            ? { version: 1, kind: "chat", chat_session_id: sessionId, task_id: taskId }
            : { version: 1, kind: "quick_create", task_id: taskId };
        try { writeFileSync(fd, JSON.stringify(metadata)); fsyncSync(fd); }
        finally { closeSync(fd); }
      } else {
        const info = lstatSync(gcPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe trace Session GC metadata");
      }
    }
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
      ...(context.runtimeId ? { runtime_id: context.runtimeId } : {}),
    };
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(header)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    const stat = lstatSync(path);
    const entry: IndexedTrace = { path, directories: this.directoryChain(path), dev: stat.dev, ino: stat.ino,
      head: 0, eventCount: 0, closed: false, completeBytes: stat.size, offsets: [], context };
    this.index.set(taskId, entry);
    return entry;
  }

  append(taskId: string, events: TraceEventInput[]): TraceAppendResult {
    const entry = this.index.get(taskId) ?? this.create(taskId);
    this.assertOwned(entry);
    if (entry.closed || events.length === 0) return { head: entry.head, events: [] };
    const stored = events.map((event, offset): TraceEvent => ({
      ...sanitizeStoredEvent(event, event.ts ?? this.now()),
      seq: entry.head + offset + 1,
    }));
    // Reject the whole batch before writing any row that recovery would reject.
    for (const event of stored) {
      if (traceEventBytes(event) > TRACE_FILE_MAX_EVENT_BYTES) throw new Error("trace line exceeds normalized event budget");
    }
    // A previous crash may have left an unterminated JSON fragment. Remove only
    // that fragment before appending complete lines to this known-owned file.
    const fd = openSync(entry.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during append");
      this.assertOwned(entry);
      ftruncateSync(fd, entry.completeBytes);
      const newOffsets: IndexedTrace["offsets"] = [];
      let offset = entry.completeBytes;
      for (const row of stored) {
        const line = `${JSON.stringify(row)}\n`;
        const bytes = writeLine(fd, line);
        newOffsets.push({ seq: row.seq, offset });
        offset += bytes;
      }
      // Complete writes precede head publication. Process restart recovery
      // needs kernel-visible bytes; close() fsyncs the final trace for archiving.
      entry.offsets.push(...newOffsets);
      entry.completeBytes = fstatSync(fd).size;
    }
    finally { closeSync(fd); }
    entry.head += stored.length;
    entry.eventCount += stored.length;
    return { head: entry.head, events: stored };
  }

  read(taskId: string, afterSeq = 0, limit = TRACE_READ_DEFAULT_LIMIT, maxBytes?: number): TraceReadResult {
    const entry = this.index.get(taskId);
    if (!entry) return { events: [], head: 0, eof: true };
    const args = normalizeTraceReadArgs(afterSeq, limit, maxBytes);
    const events: TraceEvent[] = [];
    let bytes = 0;
    this.assertOwned(entry);
    // Binary search avoids rescanning the prefix for every page, including
    // sparse historical sequences and files recovered by a fresh daemon.
    let low = 0;
    let high = entry.offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (entry.offsets[middle]!.seq <= args.afterSeq) low = middle + 1;
      else high = middle;
    }
    const start = entry.offsets[low]?.offset;
    if (start !== undefined) {
      const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during read");
        if (stat.size < entry.completeBytes) throw new Error("trace file shortened during read");
        for (const record of completeLines(fd, start, entry.completeBytes, this.options.onReadBytes)) {
          // Skip the duplicate physical records excluded by the index.
          if (record.offset !== entry.offsets[low]?.offset) continue;
          const row: TraceEvent = JSON.parse(record.line);
          if (!isTraceFileEvent(row) || row.seq !== entry.offsets[low]!.seq) throw new Error("trace event changed during read");
          const size = traceEventBytes(row);
          if (events.length > 0 && bytes + size > args.maxBytes) break;
          events.push(row);
          bytes += size;
          low++;
          if (events.length >= args.limit || low >= entry.offsets.length) break;
        }
        this.assertOwned(entry);
      } finally { closeSync(fd); }
    }
    return { events, head: entry.head, eof: (events.at(-1)?.seq ?? args.afterSeq) >= entry.head };
  }

  head(taskId: string): TraceStoreHead | null {
    const entry = this.index.get(taskId);
    return entry ? { head: entry.head, closed: entry.closed } : null;
  }

  /** Release metadata only for files definitively removed by workspace GC. */
  pruneMissing(): string[] {
    const removed: string[] = [];
    for (const [taskId, entry] of this.index) {
      try { this.assertOwned(entry); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        this.index.delete(taskId);
        this.contexts.delete(taskId);
        removed.push(taskId);
      }
    }
    return removed;
  }

  private canonicalizeDuplicates(taskId: string, entry: IndexedTrace): void {
    if (!entry.duplicates) return;
    this.assertOwned(entry);
    const partialPath = `${entry.path}.${randomUUID()}.partial`;
    const source = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let target: number | undefined;
    let published = false;
    try {
      const stat = fstatSync(source);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during duplicate recovery");
      target = openSync(partialPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let position = 0;
      for (const record of completeLines(source, 0, entry.completeBytes, this.options.onReadBytes)) {
        if (record.offset === 0) {
          const header = checkTraceFileLines([record.line], { taskId, sessionId: entry.context.sessionId ?? taskId });
          if (!header.ok) throw new Error(header.reason);
          writeLine(target, `${record.line}\n`);
        } else if (record.offset === entry.offsets[position]?.offset) {
          const event: unknown = JSON.parse(record.line);
          if (!isTraceFileEvent(event) || event.seq !== entry.offsets[position]!.seq) throw new Error("trace event changed during duplicate recovery");
          writeLine(target, `${record.line}\n`);
          position++;
        }
      }
      if (position !== entry.offsets.length) throw new Error("trace shortened during duplicate recovery");
      fsyncSync(target);
      this.assertOwned(entry);
      renameSync(partialPath, entry.path);
      published = true;
      Object.assign(entry, this.inspect(entry.path, taskId, entry.context.sessionId ?? taskId));
    } finally {
      closeSync(source);
      if (target !== undefined) closeSync(target);
      if (!published && target !== undefined) {
        this.assertOwned(entry);
        const partial = lstatSync(partialPath);
        if (!partial.isFile() || partial.isSymbolicLink()) throw new Error("unsafe duplicate recovery partial file");
        unlinkSync(partialPath);
      }
    }
  }

  close(taskId: string, end: TraceCloseInput): void {
    const entry = this.index.get(taskId) ?? this.create(taskId);
    this.assertOwned(entry);
    if (entry.closed) return;
    // A recovered append-only duplicate cannot remain before a trailer: the
    // archive contract deliberately rejects ambiguous completed files.
    this.canonicalizeDuplicates(taskId, entry);
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
      this.assertOwned(entry);
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
    try {
      this.assertOwned(entry);
      const parentFd = openSync(dirname(entry.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const parent = fstatSync(parentFd);
        const expected = entry.directories.at(-1)!.info;
        if (parent.dev !== expected.dev || parent.ino !== expected.ino) throw new Error("trace parent directory changed");
        const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during forget");
          this.assertOwned(entry);
          const target = process.platform === "linux"
            ? join(`/proc/self/fd/${parentFd}`, basename(entry.path))
            : entry.path;
          unlinkSync(target);
          this.index.delete(taskId);
        } finally { closeSync(fd); }
      } finally { closeSync(parentFd); }
    } catch (error) {
      this.warn(entry.path, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
