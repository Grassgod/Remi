import { DaemonProtocolClient, DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import { MultiremiTaskReportOutbox, type MultiremiOutboxKind, type MultiremiTaskReportOutboxOptions } from "./outbox.js";
import { outboxRecordFrame } from "./report-frames.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { daemonTraceTransport } from "./trace-transport.js";

export interface DaemonReportTransport {
  report(type: string, partition: string, payload: Record<string, unknown>, wait?: boolean | { timeoutMs: number }): Promise<Record<string, unknown>>;
  rpc(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  bestEffort(type: string, payload: Record<string, unknown>): void;
  upgradeWaiting(): boolean;
}

const shared = new WeakMap<DaemonProtocolClient, { outbox: MultiremiTaskReportOutbox; owners: number; unsubscribe: () => void }>();

export function acquireDaemonOutbox(protocol: DaemonProtocolClient, options: MultiremiTaskReportOutboxOptions): MultiremiTaskReportOutbox {
  let entry = shared.get(protocol);
  if (!entry) {
    const outbox = new MultiremiTaskReportOutbox({ ...options,
      canSend: () => protocol.connectionState() === "connected" && !protocol.uplinkPaused(),
      prepareDelivery: record => {
        // v1 terminal rows predate trace pointers, but their preceding messages
        // have already been migrated locally in the same partition.
        if (!record.terminal || record.payload.trace) return record;
        const trace = daemonTraceTransport(protocol);
        if (typeof record.payload.runtime_id === "string") trace.track(record.taskId, record.payload.runtime_id);
        return { ...record, payload: { ...record.payload, ...trace.completion(record.taskId) } };
      },
      deliver: async record => {
        if (record.kind === "messages") return options.deliver(record);
        const reply = await protocol.event(outboxRecordFrame(record) as ReturnType<typeof outboxRecordFrame> & { seq: number });
        if (record.terminal) {
          const trace = daemonTraceTransport(protocol);
          if (trace.store.head(record.taskId)) trace.close(record.taskId, record.kind === "complete" ? "completed" : "failed");
        }
        return reply;
      },
    });
    entry = { outbox, owners: 0, unsubscribe: protocol.onWelcome(() => outbox.pumpAll()) };
    shared.set(protocol, entry);
  }
  entry.owners++;
  return entry.outbox;
}

export async function releaseDaemonOutbox(protocol: DaemonProtocolClient): Promise<void> {
  const entry = shared.get(protocol);
  if (!entry || --entry.owners > 0) return;
  shared.delete(protocol);
  entry.unsubscribe();
  await entry.outbox.close();
}

export function daemonOutboxHasPriority(protocol: DaemonProtocolClient): boolean {
  return (shared.get(protocol)?.outbox.stats().pending ?? 0) > 0;
}

export function daemonReportTransport(protocol: DaemonProtocolClient, runtime: () => string | null, outbox: () => MultiremiTaskReportOutbox,
  waitTimeoutMs = 30_000, waitSignal?: () => AbortSignal,
  trace?: { completion(taskId: string): DaemonTaskCompletionFields; close(taskId: string, status: "completed" | "failed"): void }): DaemonReportTransport {
  return {
    async report(type, partition, payload, wait = false) {
      const runtimeId = runtime();
      const terminal = type === "task.complete" || type === "task.fail";
      const p = { ...payload, runtime_id: payload.runtime_id ?? runtimeId,
        ...(terminal ? trace?.completion(partition) : {}) };
      const kind = (type.startsWith("task.") ? type.slice(5) : type) as MultiremiOutboxKind;
      if (wait) {
        const reply = await outbox().enqueueAndWait(partition, kind, p,
          typeof wait === "object" ? wait.timeoutMs : waitTimeoutMs, waitSignal?.());
        if (terminal) trace?.close(partition, type === "task.complete" ? "completed" : "failed");
        return reply;
      }
      outbox().enqueue(partition, kind, p);
      if (terminal) trace?.close(partition, type === "task.complete" ? "completed" : "failed");
      return { ok: true };
    },
    rpc: (type, payload) => protocol.rpc(type, payload, runtime() ?? undefined),
    upgradeWaiting: () => protocol.connectionState() === "upgrade_wait",
    bestEffort(type, payload) {
      if (protocol.connectionState() !== "connected") return;
      try { protocol.send({ t: type, rt: runtime() ?? undefined, p: payload }); }
      catch (error) { if (!(error instanceof DaemonProtocolRpcError)) throw error; }
    },
  };
}
