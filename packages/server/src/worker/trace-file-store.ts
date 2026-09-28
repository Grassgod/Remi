import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkTraceFileLines, isTraceFileEvent, TRACE_FILE_FORMAT, type TraceFileHeader, type TraceFileTrailer } from "@multiremi/contracts/trace-file.js";
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
  directories: Array<{ path: string; info: Stats }>;
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

function completeLines(path: string): { lines: string[]; completeBytes: number; incompleteTail: boolean; dev: number; ino: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let buffer: Buffer;
  let stat: ReturnType<typeof fstatSync>;
  try {
    stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Unsafe trace file: ${path}`);
    buffer = readFileSync(fd);
  } finally { closeSync(fd); }
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline < 0) return { lines: [], completeBytes: 0, incompleteTail: buffer.length > 0, dev: stat.dev, ino: stat.ino };
  return {
    lines: buffer.subarray(0, lastNewline).toString("utf8").split("\n"),
    completeBytes: lastNewline + 1,
    incompleteTail: lastNewline !== buffer.length - 1,
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
    const { lines, completeBytes, incompleteTail, dev, ino } = completeLines(path);
    if (stat.dev !== dev || stat.ino !== ino) throw new Error("trace file changed during inspection");
    const checked = checkTraceFileLines(lines, { taskId, sessionId, incompleteTail });
    if (!checked.ok) throw new Error(checked.reason);
    for (const directory of directories) assertRealDirectoryPath(directory.path, directory.info, "trace directory");
    for (const seq of checked.value.duplicate_seqs) this.warn(path, `duplicate seq ${seq}; retaining first occurrence`);
    return { path, directories, dev, ino, head: checked.value.head,
      eventCount: checked.value.event_count, closed: checked.value.closed, completeBytes };
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
    const entry: IndexedTrace = { path, directories: this.directoryChain(path), dev: stat.dev, ino: stat.ino,
      head: 0, eventCount: 0, closed: false, completeBytes: stat.size };
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
    // A previous crash may have left an unterminated JSON fragment. Remove only
    // that fragment before appending complete lines to this known-owned file.
    const fd = openSync(entry.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("trace file changed during append");
      this.assertOwned(entry);
      ftruncateSync(fd, entry.completeBytes);
      writeFileSync(fd, stored.map((row) => `${JSON.stringify(row)}\n`).join(""));
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
    const seen = new Set<number>();
    let bytes = 0;
    this.assertOwned(entry);
    const data = completeLines(entry.path);
    this.assertOwned(entry);
    if (data.dev !== entry.dev || data.ino !== entry.ino) throw new Error("trace file changed during read");
    for (const line of data.lines.slice(1)) {
      let row: unknown;
      try { row = JSON.parse(line); } catch { this.warn(entry.path, "invalid JSON during read"); break; }
      if (!isTraceFileEvent(row)) continue;
      if (seen.has(row.seq)) { this.warn(entry.path, `duplicate seq ${row.seq}; retaining first occurrence`); continue; }
      seen.add(row.seq);
      if (row.seq <= args.afterSeq) continue;
      if (events.length >= args.limit) break;
      const size = traceEventBytes(row);
      if (events.length > 0 && bytes + size > args.maxBytes) break;
      events.push(row);
      bytes += size;
    }
    return { events, head: entry.head, eof: (events.at(-1)?.seq ?? args.afterSeq) >= entry.head };
  }

  head(taskId: string): TraceStoreHead | null {
    const entry = this.index.get(taskId);
    return entry ? { head: entry.head, closed: entry.closed } : null;
  }

  close(taskId: string, end: TraceCloseInput): void {
    const entry = this.index.get(taskId) ?? this.create(taskId);
    this.assertOwned(entry);
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
