import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  checkTraceFileLines,
  isTraceFileEvent,
  isTraceFileSnapshotLine,
  isTraceFileTrailer,
  isTraceFileTrailerV2,
  TRACE_FILE_FORMAT_V2,
  type TraceFileFormatVersion,
  type TraceFileHeaderV2,
  type TraceFileSnapshotLine,
  type TraceFileTrailerV2,
} from "@multiremi/contracts/trace-file.js";
import type { TraceEvent, TraceEventInput, TraceEventLine } from "@multiremi/contracts/trace.js";
import { assertRealDirectoryPath } from "@daemon/agent-runtime/workspace/safe-remove.js";
import { TRACES_DIRECTORY, traceDirectory, tracePath, tracesRoot } from "@daemon/agent-runtime/workspace/layout.js";
import { createLogger } from "@shared/logger.js";
import {
  sanitizeStoredEvent,
  splitTraceSnapshot,
  traceEventBytes,
  normalizeTraceReadArgs,
  TRACE_READ_DEFAULT_LIMIT,
  type TraceAppendResult,
  type TraceClock,
  type TraceCloseInput,
  type TraceReadResult,
  type TraceSnapshotPart,
  type TraceStore,
  type TraceStoreHead,
} from "./trace-store.js";

const log = createLogger("multiremi-trace-file-store");
export const TRACE_FILE_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Leave room for task/runtime ids and the trace RPC/push envelope. */
export const TRACE_FILE_MAX_EVENT_BYTES = TRACE_FILE_MAX_LINE_BYTES - 8 * 1024;

/** Closed traces whose offset index stays resident; open traces are never evicted. */
export const TRACE_FILE_RESIDENT_CLOSED_LIMIT = 256;
/** A trailer is a short final line; this much of a file's end is enough to recognize one. */
const TRACE_TAIL_BYTES = 8 * 1024;
const TRACE_TAIL_CONCURRENCY = 32;

export interface TraceTaskContext {
  /** Conversation (Issue session / Chat) that wrote the trace; omitted for a one-shot task. */
  sessionId?: string | null;
  /** Subject whose `traces/<subject>/` directory holds the file. */
  subjectId: string;
  agentId: string;
  provider: string;
  startedAt: string;
  runtimeId?: string;
}

export interface TraceFileStoreOptions {
  workspacesRoot: string;
  resolveTask: (taskId: string) => TraceTaskContext;
  now?: TraceClock;
  onWarning?: (path: string, reason: string) => void;
  /** Diagnostics: bytes physically read, including bounded chunk read-ahead. */
  onReadBytes?: (bytes: number) => void;
  /** How many closed traces keep their offset index in memory. */
  residentClosedLimit?: number;
}

interface IndexedTrace {
  path: string;
  directories: Array<{ path: string; info: Stats }>;
  dev: number;
  ino: number;
  head: number;
  eventCount: number;
  closed: boolean;
  /** Header format. A v1 file is read-only: never appended to, closed or resumed. */
  format: TraceFileFormatVersion;
  /**
   * Bytes through the last complete line the store keeps; an interrupted final
   * line, and the snapshot framing of a close that crashed before its trailer
   * (decision Q2), lie beyond it and are cut by the next write.
   */
  completeBytes: number;
  context: TraceTaskContext;
  /** Only sequence/offset pairs are resident; event payloads stay on disk. */
  offsets: Array<{ seq: number; offset: number }>;
  /** Offsets of the snapshot framing lines of a closed v2 trace, in part order. */
  snapshotOffsets: number[];
  duplicates?: boolean;
}

function safeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id !== "." && id !== "..";
}

function realDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe trace directory: ${path}`);
  return true;
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
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

/** Whether the last complete line of a trace file is its trailer; any doubt reads as "not closed". */
async function endsWithTrailer(path: string): Promise<boolean> {
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TRACE_TAIL_BYTES);
    const tail = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(tail, 0, length, size - length);
    const text = tail.subarray(0, bytesRead).toString("utf8");
    // An interrupted final line has no newline and is ignored, as in a full index.
    const end = text.lastIndexOf("\n");
    if (end < 0) return false;
    const line = text.slice(text.lastIndexOf("\n", end - 1) + 1, end);
    return isTraceFileTrailer(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  } finally {
    await file.close();
  }
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

/**
 * Durable, per-task JSONL implementation of A-0's TraceStore.
 *
 * Starting the store only lists `traces/<subject>/<task>.jsonl` paths. A trace
 * is indexed the first time it is read or appended to, and the resident indexes
 * of closed traces are capped (least recently used first), so a daemon with
 * years of history starts and runs in constant memory.
 */
export class TraceFileStore implements TraceStore {
  private readonly root: string;
  /** Every known trace file, indexed or not. */
  private readonly paths = new Map<string, string>();
  /** Resident indexes in recency order (oldest first). */
  private readonly index = new Map<string, IndexedTrace>();
  private readonly now: TraceClock;
  private readonly contexts = new Map<string, TraceTaskContext>();
  private readonly residentClosedLimit: number;

  constructor(private readonly options: TraceFileStoreOptions) {
    this.root = resolve(options.workspacesRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.residentClosedLimit = Math.max(0, options.residentClosedLimit ?? TRACE_FILE_RESIDENT_CLOSED_LIMIT);
    this.listTraces();
  }

  registerTask(taskId: string, context: TraceTaskContext): void {
    const previous = this.entry(taskId)?.context ?? this.contexts.get(taskId);
    if (previous?.runtimeId && previous.runtimeId !== context.runtimeId) throw new Error("trace runtime ownership changed");
    this.contexts.set(taskId, context);
  }

  registerRuntime(taskId: string, runtimeId: string): void {
    const context = this.entry(taskId)?.context ?? this.contexts.get(taskId) ?? this.options.resolveTask(taskId);
    this.registerTask(taskId, { ...context, runtimeId });
  }

  /** Runtime that owns a trace, from its header; indexes the trace on first use. */
  owner(taskId: string): string | undefined {
    return this.entry(taskId)?.context.runtimeId;
  }

  /**
   * Traces a crash left without their trailer, by runtime owner. Only the end
   * of each listed file is read, in the background, so a root with years of
   * closed history costs no index; the few open traces are then indexed fully.
   */
  async findUnclosed(): Promise<Map<string, string>> {
    const unclosed = new Map<string, string>();
    const candidates = [...this.paths].filter(([taskId]) => !this.index.has(taskId));
    let next = 0;
    const scan = async () => {
      for (let index = next++; index < candidates.length; index = next++) {
        const [taskId, path] = candidates[index]!;
        try {
          if (await endsWithTrailer(path)) continue;
          const entry = this.entry(taskId);
          // A v1 file is read-only history: never resumed, even when it was left open.
          if (entry && entry.format === "v2" && !entry.closed && entry.context.runtimeId) unclosed.set(taskId, entry.context.runtimeId);
        } catch (error) {
          this.warn(path, error instanceof Error ? error.message : String(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRACE_TAIL_CONCURRENCY, candidates.length) }, scan));
    return unclosed;
  }

  /** Owners of the traces whose index is resident right now. */
  ownership(): ReadonlyMap<string, string> {
    return new Map([...this.index].flatMap(([taskId, entry]) => entry.context.runtimeId ? [[taskId, entry.context.runtimeId] as const] : []));
  }

  private warn(path: string, reason: string): void {
    this.options.onWarning?.(path, reason);
    log.warn(`Trace file skipped or damaged: ${path}: ${reason}`);
  }

  private directoryChain(path: string): Array<{ path: string; info: Stats }> {
    const subject = dirname(path);
    const traces = dirname(subject);
    if (dirname(traces) !== this.root || basename(traces) !== TRACES_DIRECTORY) {
      throw new Error(`Trace path is outside owned root: ${path}`);
    }
    return [this.root, traces, subject].map((part) => {
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

  private inspect(path: string, taskId: string): IndexedTrace {
    const directories = this.directoryChain(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular trace file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const offsets: IndexedTrace["offsets"] = [];
    const snapshotOffsets: number[] = [];
    let header: (TraceFileHeaderV2 | (Omit<TraceFileHeaderV2, "format"> & { format: string })) | undefined;
    let format: TraceFileFormatVersion = "v2";
    let completeBytes = 0;
    /** Bytes through the last header or event line: where a crashed close is cut back to. */
    let eventsEnd = 0;
    let snapshotParts: number | null = null;
    let head = 0;
    let closed = false;
    let duplicates = false;
    const seen = new Set<number>();
    try {
      const opened = fstatSync(fd);
      if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw new Error("trace file changed during inspection");
      for (const record of completeLines(fd, 0, opened.size, this.options.onReadBytes)) {
        if (!header) {
          const checked = checkTraceFileLines([record.line], { taskId });
          if (!checked.ok) throw new Error(checked.reason);
          format = checked.value.format;
          header = JSON.parse(record.line);
          if (header!.runtime_id !== undefined && (typeof header!.runtime_id !== "string" || !header!.runtime_id)) throw new Error("invalid runtime owner");
          eventsEnd = record.end;
        } else {
          if (closed) throw new Error("trailer is not final line");
          const row: unknown = JSON.parse(record.line);
          if (isTraceFileTrailer(row)) {
            if (row.end.head !== head || row.end.event_count !== offsets.length) throw new Error("trailer counts disagree with events");
            if (duplicates || record.end !== opened.size) throw new Error("ambiguous trailer after recovered events");
            if (format === "v2") {
              if (!isTraceFileTrailerV2(row)) throw new Error("v2 trailer without snapshot_parts");
              if (row.end.snapshot_parts !== snapshotOffsets.length) throw new Error("trailer snapshot_parts disagree with snapshot lines");
              if (snapshotParts !== null && snapshotParts !== snapshotOffsets.length) throw new Error("snapshot parts incomplete");
            }
            closed = true;
          } else if (format === "v2" && isTraceFileSnapshotLine(row)) {
            const part = row.snapshot;
            if (part.head !== head) throw new Error("snapshot head disagrees with events");
            if (part.part !== snapshotOffsets.length || (snapshotParts !== null && part.parts !== snapshotParts)) {
              throw new Error("snapshot part out of order");
            }
            snapshotParts = part.parts;
            snapshotOffsets.push(record.offset);
          } else {
            if (!isTraceFileEvent(row)) throw new Error("invalid trace event");
            if (snapshotOffsets.length) throw new Error("event after snapshot");
            if (seen.has(row.seq)) { duplicates = true; this.warn(path, `duplicate seq ${row.seq}; retaining first occurrence`); }
            else {
              if (row.seq < head) throw new Error(`out-of-order seq ${row.seq}`);
              offsets.push({ seq: row.seq, offset: record.offset });
              seen.add(row.seq);
              head = row.seq;
            }
            eventsEnd = record.end;
          }
        }
        completeBytes = record.end;
      }
      if (!header) throw new Error("missing complete header");
    } finally { closeSync(fd); }
    for (const directory of directories) assertRealDirectoryPath(directory.path, directory.info, "trace directory");
    if (!closed && snapshotOffsets.length) {
      // Decision Q2: a crash inside close() left snapshot framing without a
      // trailer. Cut it (and any partial trailer) back to the last event; the
      // re-close writes the snapshot again from the fold.
      this.warn(path, "unsealed snapshot framing; truncating to the last event before re-closing");
      completeBytes = eventsEnd;
      snapshotOffsets.length = 0;
    }
    return { path, directories, dev: stat.dev, ino: stat.ino, head, format,
      eventCount: offsets.length, closed, completeBytes, offsets, snapshotOffsets, duplicates,
      context: { sessionId: header.session_id, subjectId: basename(dirname(path)), agentId: header.agent_id,
        provider: header.provider, startedAt: header.started_at, runtimeId: header.runtime_id } };
  }

  /** Record the path of every trace file on disk. Nothing is opened. */
  private listTraces(): void {
    this.paths.clear();
    const traces = tracesRoot(this.root);
    if (!realDirectory(traces)) return;
    for (const subject of readdirSync(traces, { withFileTypes: true }).sort(byName)) {
      if (!subject.isDirectory() || !safeId(subject.name)) continue;
      const subjectRoot = join(traces, subject.name);
      try {
        if (!realDirectory(subjectRoot)) continue;
        for (const file of readdirSync(subjectRoot, { withFileTypes: true }).sort(byName)) {
          if (!file.name.endsWith(".jsonl")) continue;
          const taskId = file.name.slice(0, -6);
          const path = join(subjectRoot, file.name);
          if (!safeId(taskId) || !file.isFile()) this.warn(path, "invalid trace filename or file type");
          else if (this.paths.has(taskId)) this.warn(path, "duplicate task id in another subject");
          else this.paths.set(taskId, path);
        }
      } catch (error) {
        this.warn(subjectRoot, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * The resident index of a trace, building it from disk on first use. A file
   * that fails its integrity checks is reported and treated as absent.
   */
  private entry(taskId: string): IndexedTrace | undefined {
    const resident = this.index.get(taskId);
    if (resident) {
      this.index.delete(taskId);
      this.index.set(taskId, resident);
      return resident;
    }
    const path = this.paths.get(taskId);
    if (!path) return undefined;
    try {
      return this.remember(taskId, this.inspect(path, taskId));
    } catch (error) {
      this.paths.delete(taskId);
      this.warn(path, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  private remember(taskId: string, entry: IndexedTrace): IndexedTrace {
    this.index.delete(taskId);
    this.index.set(taskId, entry);
    this.paths.set(taskId, entry.path);
    this.evictClosed();
    return entry;
  }

  /** Drop the least recently used closed indexes beyond the limit; open traces stay. */
  private evictClosed(): void {
    let closed = 0;
    for (const entry of this.index.values()) if (entry.closed) closed++;
    for (const [taskId, entry] of this.index) {
      if (closed <= this.residentClosedLimit) break;
      if (!entry.closed) continue;
      this.index.delete(taskId);
      closed--;
    }
  }

  private create(taskId: string): IndexedTrace {
    if (!safeId(taskId)) throw new Error(`Invalid trace task id: ${taskId}`);
    const context = this.contexts.get(taskId) ?? this.options.resolveTask(taskId);
    const sessionId = context.sessionId ?? taskId;
    if (!safeId(sessionId)) throw new Error(`Invalid trace session id: ${sessionId}`);
    if (!safeId(context.subjectId)) throw new Error(`Invalid trace subject id: ${context.subjectId}`);
    ensureDirectory(this.root);
    ensureDirectory(tracesRoot(this.root));
    ensureDirectory(traceDirectory(this.root, context.subjectId));
    const path = tracePath(this.root, context.subjectId, taskId);
    if (existsSync(path)) return this.remember(taskId, this.inspect(path, taskId));
    const header: TraceFileHeaderV2 = {
      format: TRACE_FILE_FORMAT_V2,
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
    return this.remember(taskId, { path, directories: this.directoryChain(path), dev: stat.dev, ino: stat.ino,
      head: 0, eventCount: 0, closed: false, format: "v2", completeBytes: stat.size, offsets: [], snapshotOffsets: [], context });
  }

  append(taskId: string, events: TraceEventInput[]): TraceAppendResult {
    const entry = this.entry(taskId) ?? this.create(taskId);
    this.assertOwned(entry);
    if (entry.format === "v1") throw new Error(`v1 trace is read-only: ${entry.path}`);
    if (entry.closed || events.length === 0) return { head: entry.head, events: [] };
    const stored: TraceEvent[] = [];
    for (const event of events) {
      const row = sanitizeStoredEvent(event, this.now(), taskId);
      if (row) stored.push({ ...row, seq: entry.head + stored.length + 1 } as TraceEvent);
    }
    if (stored.length === 0) return { head: entry.head, events: [] };
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
    const entry = this.entry(taskId);
    if (!entry) return { events: [], head: 0, eof: true };
    const args = normalizeTraceReadArgs(afterSeq, limit, maxBytes);
    const events: TraceEventLine[] = [];
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
          const row: unknown = JSON.parse(record.line);
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
    const entry = this.entry(taskId);
    return entry ? { head: entry.head, closed: entry.closed } : null;
  }

  format(taskId: string): TraceFileFormatVersion | null {
    return this.entry(taskId)?.format ?? null;
  }

  snapshotPart(taskId: string, part: number): TraceSnapshotPart | null {
    const entry = this.entry(taskId);
    if (!entry?.closed || entry.format !== "v2" || !Number.isSafeInteger(part)) return null;
    const offset = entry.snapshotOffsets[part];
    if (offset === undefined) return null;
    this.assertOwned(entry);
    const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during read");
      for (const record of completeLines(fd, offset, entry.completeBytes, this.options.onReadBytes)) {
        const row: unknown = JSON.parse(record.line);
        if (!isTraceFileSnapshotLine(row) || row.snapshot.part !== part) throw new Error("trace snapshot changed during read");
        this.assertOwned(entry);
        return row.snapshot;
      }
    } finally { closeSync(fd); }
    throw new Error("trace snapshot shortened during read");
  }

  /** Release metadata only for files definitively removed by workspace reclaim. */
  pruneMissing(): string[] {
    const removed: string[] = [];
    for (const [taskId, path] of this.paths) {
      const resident = this.index.get(taskId);
      try {
        if (resident) this.assertOwned(resident);
        else lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        this.paths.delete(taskId);
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
      Object.assign(entry, this.inspect(entry.path, taskId));
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
    const entry = this.entry(taskId) ?? this.create(taskId);
    this.assertOwned(entry);
    if (entry.closed) return;
    if (entry.format === "v1") throw new Error(`v1 trace is read-only: ${entry.path}`);
    // A recovered append-only duplicate cannot remain before a trailer: the
    // trace contract deliberately rejects ambiguous completed files.
    this.canonicalizeDuplicates(taskId, entry);
    const parts = end.snapshot ? splitTraceSnapshot({ ...end.snapshot, head: entry.head, closed: true }) : [];
    const lines = parts.map((snapshot): string => `${JSON.stringify({ snapshot } satisfies TraceFileSnapshotLine)}\n`);
    const trailer: TraceFileTrailerV2 = { end: {
      status: end.status,
      head: entry.head,
      event_count: entry.eventCount,
      ended_at: end.ended_at,
      snapshot_parts: parts.length,
    } };
    const fd = openSync(entry.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const snapshotOffsets: number[] = [];
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during close");
      this.assertOwned(entry);
      // Also cuts the framing of an earlier close that crashed before its trailer.
      ftruncateSync(fd, entry.completeBytes);
      let offset = entry.completeBytes;
      for (const line of lines) {
        snapshotOffsets.push(offset);
        offset += writeLine(fd, line);
      }
      writeLine(fd, `${JSON.stringify(trailer)}\n`);
      fsyncSync(fd);
      entry.completeBytes = fstatSync(fd).size;
    }
    finally { closeSync(fd); }
    entry.snapshotOffsets = snapshotOffsets;
    entry.closed = true;
    this.evictClosed();
  }

  forget(taskId: string): void {
    const entry = this.entry(taskId);
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
          this.paths.delete(taskId);
        } finally { closeSync(fd); }
      } finally { closeSync(parentFd); }
    } catch (error) {
      this.warn(entry.path, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
