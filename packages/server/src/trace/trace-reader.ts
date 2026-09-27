import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { MultiremiTaskTrace } from "@multiremi/contracts/session-archive.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";

export const TRACE_READ_DEFAULT_LIMIT = 200;
export const TRACE_READ_MAX_LIMIT = 500;
export const TRACE_READ_MAX_BYTES = 1024 * 1024;

export type TraceReadState = "ok" | "unreachable" | "not_found" | "backfilling" | "lost";
export interface TraceReadResult {
  events: TraceEvent[];
  next_after_seq: number;
  head: number;
  eof: boolean;
  closed: boolean;
  source: "daemon" | "archive" | null;
  state: TraceReadState;
  reason?: string;
  retryable?: boolean;
  runtime_id?: string;
  runtime_name?: string;
  last_seen_at?: string;
}

export interface TraceReaderOptions {
  store: MultiremiStore;
  daemon: DaemonTraceReader;
  archive: SessionArchiveReader;
  /** The store's pointer repo uses an injectable query(sql, params) callback. */
  getPointer?: (taskId: string) => MultiremiTaskTrace | null;
}

export class TraceReader {
  constructor(private readonly options: TraceReaderOptions) {}

  async readTrace(taskId: string, afterSeq = 0, limit = TRACE_READ_DEFAULT_LIMIT, maxBytes = TRACE_READ_MAX_BYTES): Promise<TraceReadResult> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError("after_seq must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
    const pageLimit = Math.min(limit, TRACE_READ_MAX_LIMIT);
    const byteLimit = Math.min(maxBytes, TRACE_READ_MAX_BYTES);
    const pointer = this.pointer(taskId);
    if (!pointer) {
      const task = this.options.store.getTask(taskId);
      const active = task && ["dispatched", "running", "waiting_local_directory", "awaiting_human"].includes(task.status);
      const runtime = task?.runtimeId ? this.options.store.getRuntime(task.runtimeId) : null;
      return {
        ...empty(afterSeq, active ? "unreachable" : "not_found", active ? "daemon" : null, "pointer_missing"),
        ...(active && task?.runtimeId ? {
          runtime_id: task.runtimeId,
          runtime_name: runtime?.name ?? task.runtimeId,
        } : {}),
      };
    }
    if (pointer.location === "lost" || pointer.location === "backfilling") {
      return empty(afterSeq, pointer.location, null);
    }
    if (pointer.location === "none") return empty(afterSeq, "not_found", null, "no_events");
    if (pointer.location === "archive") return this.readArchive(pointer, afterSeq, pageLimit, byteLimit);
    if (!pointer.runtimeId) return empty(afterSeq, "unreachable", "daemon", "runtime_missing");

    const runtime = this.options.store.getRuntime(pointer.runtimeId);
    const location = { runtime_id: pointer.runtimeId, runtime_name: runtime?.name ?? pointer.runtimeId };
    try {
      const result = await this.options.daemon.read({
        taskId, runtimeId: pointer.runtimeId, afterSeq, limit: pageLimit, maxBytes: byteLimit,
      });
      if (!result.ok) {
        if (result.code === "trace_not_hot") {
          const latest = this.pointer(taskId);
          if (latest?.location === "archive") return this.readArchive(latest, afterSeq, pageLimit, byteLimit);
          return { ...empty(afterSeq, "not_found", "daemon", "trace_not_hot"), ...location };
        }
        return {
          ...empty(afterSeq, "unreachable", "daemon", result.code), ...location,
          last_seen_at: result.last_seen_at, retryable: true,
        };
      }
      return this.bounded(result.events, afterSeq, result.head, result.eof, result.closed, "daemon", byteLimit, location);
    } catch {
      return { ...empty(afterSeq, "unreachable", "daemon", "daemon_read_failed"), ...location, retryable: true };
    }
  }

  private pointer(taskId: string): MultiremiTaskTrace | null {
    return this.options.getPointer ? this.options.getPointer(taskId) : this.options.store.getTaskTrace(taskId);
  }

  private async readArchive(pointer: MultiremiTaskTrace, afterSeq: number, limit: number, maxBytes: number): Promise<TraceReadResult> {
    try {
      const window = await this.options.archive.readTraceLines(pointer, afterSeq, limit);
      return this.bounded(window.events as unknown as TraceEvent[], afterSeq, window.head, window.complete, window.closed, "archive", maxBytes);
    } catch {
      return { ...empty(afterSeq, "unreachable", "archive", "archive_read_failed"), retryable: true };
    }
  }

  private bounded(
    events: TraceEvent[], afterSeq: number, head: number, eof: boolean, closed: boolean,
    source: "daemon" | "archive", maxBytes: number,
    location: Pick<TraceReadResult, "runtime_id" | "runtime_name"> = {},
  ): TraceReadResult {
    const page: TraceEvent[] = [];
    let bytes = 0;
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event), "utf8") + (page.length ? 1 : 0);
      if (bytes + size > maxBytes) break;
      page.push(event);
      bytes += size;
    }
    if (events.length > 0 && page.length === 0) {
      return { ...empty(afterSeq, "not_found", source, "event_exceeds_budget"), ...location };
    }
    return {
      events: page,
      next_after_seq: page.at(-1)?.seq ?? afterSeq,
      head,
      eof: eof && page.length === events.length,
      closed,
      source,
      state: "ok",
      ...location,
    };
  }
}

function empty(afterSeq: number, state: Exclude<TraceReadState, "ok">, source: TraceReadResult["source"], reason?: string): TraceReadResult {
  return {
    events: [], next_after_seq: afterSeq, head: 0, eof: true, closed: false, source, state,
    ...(reason ? { reason } : {}),
  };
}
