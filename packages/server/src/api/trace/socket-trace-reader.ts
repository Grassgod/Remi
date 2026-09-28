import { randomUUID } from "node:crypto";
import {
  DAEMON_TRACE_READ_DEFAULT_LIMIT, DAEMON_TRACE_READ_MAX_LIMIT, DAEMON_TRACE_READ_MAX_BYTES,
  DAEMON_TRACE_READ_TIMEOUT_MS, DAEMON_TRACE_READ_MAX_IN_FLIGHT, DAEMON_TRACE_READ_MAX_QUEUED,
} from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonProtocolLayer } from "../daemon-protocol/index.js";
import type { DaemonProtocolSession } from "../daemon-protocol/session.js";
import type { DaemonParsedFrame } from "../daemon-protocol/frames.js";
import type { DaemonTraceReader, DaemonTraceReadRequest, DaemonTraceReadResult } from "@multiremi/api/trace/daemon-trace-reader.js";

interface ReadJob {
  id: string;
  request: DaemonTraceReadRequest;
  timer: ReturnType<typeof setTimeout>;
  finish(result: DaemonTraceReadResult): void;
  lastSeenAt?: string;
}
interface ConnectionReads { active: Map<string, ReadJob>; queue: ReadJob[] }

/** Admission and deadlines are per socket, including all its provider runtimes. */
export class SocketDaemonTraceReader implements DaemonTraceReader {
  private readonly connections = new Map<DaemonProtocolSession, ConnectionReads>();
  constructor(private readonly layer: DaemonProtocolLayer,
    private readonly lastSeenAt: (runtimeId: string) => string | null = () => null) {
    layer.onReply((frame, session) => this.reply(frame, session));
    layer.onClose(session => {
      const reads = this.connections.get(session);
      this.connections.delete(session);
      if (!reads) return;
      for (const job of [...reads.active.values(), ...reads.queue]) job.finish({ ok: false, code: "daemon_unreachable",
        runtime_id: job.request.runtimeId, last_seen_at: job.lastSeenAt });
    });
  }

  read(request: DaemonTraceReadRequest): Promise<DaemonTraceReadResult> {
    const session = this.layer.registry.sessionForRuntime(request.runtimeId) as DaemonProtocolSession | null;
    const lastSeenAt = this.lastSeenAt(request.runtimeId) ?? undefined;
    if (!session || session.isClosed) return Promise.resolve({ ok: false, code: "daemon_unreachable", runtime_id: request.runtimeId, last_seen_at: lastSeenAt });
    let reads = this.connections.get(session);
    if (!reads) this.connections.set(session, reads = { active: new Map(), queue: [] });
    if (reads.active.size >= DAEMON_TRACE_READ_MAX_IN_FLIGHT && reads.queue.length >= DAEMON_TRACE_READ_MAX_QUEUED) {
      return Promise.resolve({ ok: false, code: "daemon_busy", runtime_id: request.runtimeId });
    }
    return new Promise(resolve => {
      const id = randomUUID();
      let done = false;
      const job: ReadJob = { id, request, lastSeenAt,
        timer: setTimeout(() => job.finish({ ok: false, code: "daemon_timeout", runtime_id: request.runtimeId }),
          Math.max(1, Math.min(request.timeoutMs ?? DAEMON_TRACE_READ_TIMEOUT_MS, DAEMON_TRACE_READ_TIMEOUT_MS))),
        finish: result => {
          if (done) return;
          done = true;
          clearTimeout(job.timer);
          session.settleRequest(id);
          reads!.active.delete(id);
          reads!.queue = reads!.queue.filter(pending => pending !== job);
          resolve(result);
          if (!session.isClosed) this.dispatch(session, reads!);
        },
      };
      reads!.queue.push(job);
      this.dispatch(session, reads!);
    });
  }

  private dispatch(session: DaemonProtocolSession, reads: ConnectionReads): void {
    while (!session.isClosed && reads.active.size < DAEMON_TRACE_READ_MAX_IN_FLIGHT && reads.queue.length) {
      const job = reads.queue.shift()!;
      reads.active.set(job.id, job);
      const r = job.request;
      if (!session.request(job.id, { t: "trace.read", rt: r.runtimeId, p: {
        task_id: r.taskId, after_seq: Math.max(0, Math.floor(r.afterSeq ?? 0)),
        limit: Math.max(1, Math.min(Math.floor(r.limit ?? DAEMON_TRACE_READ_DEFAULT_LIMIT), DAEMON_TRACE_READ_MAX_LIMIT)),
        max_bytes: Math.max(1, Math.min(Math.floor(r.maxBytes ?? DAEMON_TRACE_READ_MAX_BYTES), DAEMON_TRACE_READ_MAX_BYTES)),
      } })) job.finish({ ok: false, code: "daemon_unreachable", runtime_id: r.runtimeId, last_seen_at: job.lastSeenAt });
    }
  }

  private reply(frame: DaemonParsedFrame, session: DaemonProtocolSession): void {
    const job = frame.re ? this.connections.get(session)?.active.get(frame.re) : null;
    if (!job) return;
    const p = frame.payload;
    if (p.ok === true && Array.isArray(p.events) && Number.isSafeInteger(p.head) && typeof p.eof === "boolean" && typeof p.closed === "boolean") {
      job.finish(p as unknown as DaemonTraceReadResult);
    } else if (p.ok === false && ["daemon_unreachable", "daemon_timeout", "daemon_busy", "trace_not_hot"].includes(String(p.code))) {
      job.finish({ ok: false, code: p.code as "trace_not_hot", runtime_id: job.request.runtimeId });
    } else job.finish({ ok: false, code: "daemon_timeout", runtime_id: job.request.runtimeId });
  }
}
