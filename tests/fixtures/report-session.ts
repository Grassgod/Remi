import { DAEMON_MIN_CLI_VERSION, daemonFrameCategory, type DaemonRuntimeCapabilities } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiAccessToken } from "@multiremi/contracts/types.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { registerDaemonReportHandlers, registerDaemonMaintenanceHandlers } from "@multiremi/api/daemon-protocol/report-handlers.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import type { MultiremiDaemonClient } from "@multiremi/client.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";
import { InMemoryTraceSink } from "@multiremi/api/trace/trace-sink.js";
import { registerDaemonTraceHandlers } from "@multiremi/api/daemon-protocol/trace-handlers.js";
import { registerTaskInputRpcs } from "@multiremi/api/daemon-protocol/task-input-rpcs.js";
import type { DaemonTurnBridge } from "@multiremi/api/daemon-protocol/turn-bridge.js";

const traceSinks = new WeakMap<MultiremiStore, InMemoryTraceSink>();
export function reportTraceSink(store: MultiremiStore): InMemoryTraceSink {
  let sink = traceSinks.get(store);
  if (!sink) traceSinks.set(store, sink = new InMemoryTraceSink());
  return sink;
}

/** Exercise client payloads against real session dispatch; HTTP remains for non-report calls. */
export function bindReportFrames(client: MultiremiDaemonClient, store: MultiremiStore, options: Parameters<typeof reportFrame>[3] = {}) {
  const background = new Set<Promise<unknown>>();
  const send = async (type: string, payload: Record<string, unknown>) => {
    const result = await reportFrame(store, type, payload, options);
    if (result.ok === false) throw new DaemonProtocolRpcError(result.code, result.retryable === true, result.operation_error);
    return result;
  };
  client.setReportTransport({ report: (type, partition, payload) => send(type, type.startsWith("task.") ? { task_id: partition, ...payload } : payload), rpc: send,
    bestEffort: (type, payload) => {
      const run = send(type, payload); background.add(run);
      void run.finally(() => background.delete(run));
    }, upgradeWaiting: () => false });
  return async () => { while (background.size) await Promise.all([...background]); };
}

export function captureReports(client: MultiremiDaemonClient, reply: (type: string, payload: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })) {
  const calls: Array<{ type: string; partition: string; payload: Record<string, unknown>; wait: boolean; timeoutMs?: number }> = [];
  client.setReportTransport({
    report: async (type, partition, payload, wait = false) => {
      calls.push({ type, partition, payload, wait: !!wait, ...(typeof wait === "object" ? { timeoutMs: wait.timeoutMs } : {}) });
      return reply(type, payload);
    },
    rpc: async (type, payload) => { calls.push({ type, partition: "", payload, wait: true }); return reply(type, payload); },
    bestEffort: (type, payload) => { calls.push({ type, partition: "", payload, wait: false }); },
    upgradeWaiting: () => false,
  });
  return calls;
}

/** Unit-level real frame dispatch and Store effects, without an HTTP report adapter. */
export async function reportFrame(
  store: MultiremiStore, type: string, payload: Record<string, unknown> = {},
  options: { runtimeId?: string; token?: MultiremiAccessToken | null; seq?: number; archives?: SessionArchiveService;
    headers?: HeadersInit; authToken?: string; rawPayload?: string; beforeFrame?: () => void;
    capabilities?: DaemonRuntimeCapabilities;
    turns?: DaemonTurnBridge;
    onRoundCard?: (taskId: string, fields: import("@multiremi/contracts/daemon-protocol.js").DaemonTaskCompletionFields | null) => void;
    onTraceClosed?: Parameters<typeof registerDaemonReportHandlers>[2] } = {},
): Promise<Record<string, any>> {
  const layer = new DaemonProtocolLayer({ store });
  let identity = { accessToken: options.token ?? null, masterToken: !options.token };
  if (options.headers) {
    const result = await layer.resolveIdentity(new Request("http://fixture/api/daemon/ws", { headers: options.headers }), options.authToken ?? "");
    if ("response" in result) return { ok: false, code: "authority_revoked", retryable: false };
    identity = result.identity;
  }
  const token = identity.accessToken;
  const runtimes = store.listRuntimes();
  const runtimeId = options.runtimeId ?? (typeof payload.runtime_id === "string" ? payload.runtime_id : null)
    ?? (typeof payload.task_id === "string" ? store.getTask(payload.task_id)?.runtimeId : null)
    ?? runtimes.find(runtime => !token || (runtime.daemonId === token.daemonId && runtime.workspaceId === token.workspaceId))?.id;
  const runtime = runtimeId ? store.getRuntimeLite(runtimeId) : null;
  const daemonId = token?.daemonId ?? runtime?.daemonId ?? "fixture-reports";
  const recordCard = store.recordTurnCardCompletionFieldsWithinTransaction;
  if (options.onRoundCard) store.recordTurnCardCompletionFieldsWithinTransaction = (taskId, fields) => {
    options.onRoundCard?.(taskId, fields);
    return recordCard.call(store, taskId, fields);
  };
  const trace = registerDaemonTraceHandlers(layer, store, reportTraceSink(store));
  registerDaemonReportHandlers(layer, store, (taskId, head, rt) => {
    options.onTraceClosed?.(taskId, head, rt);
    trace.close(taskId, head, rt);
  }, options.turns);
  registerTaskInputRpcs(layer, store, () => {}, options.turns);
  registerDaemonMaintenanceHandlers(layer, store, options.archives ?? new SessionArchiveService(store));
  const frames: Array<Record<string, any>> = [];
  let closed: number | undefined;
  const session = layer.openSession({
    get bufferedAmount() { return 0; },
    send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); },
    close(code) { closed = code; },
  }, identity);
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: daemonId,
      runtimes: runtimeId ? [{ runtime_id: runtimeId, provider: runtime?.provider ?? "claude", max_concurrency: 1,
        active_task_ids: [], capabilities: options.capabilities }] : [],
    } }));
    const seq = options.seq ?? 1;
    const category = daemonFrameCategory(type);
    const event = category === "event";
    const re = event ? String(seq) : "fixture-rpc";
    const frame = JSON.stringify({ v: 2, t: type, ...(event ? { seq } : category === "rpc" ? { id: re } : {}),
      ...(runtimeId ? { rt: runtimeId } : {}), p: payload });
    options.beforeFrame?.();
    await session.handleMessage(options.rawPayload === undefined ? frame : frame.slice(0, frame.lastIndexOf('"p":')) + `"p":${options.rawPayload}}`);
    if (closed !== undefined) return { closed };
    if (category === "best_effort") return { sent: true };
    const reply = frames.find(frame => frame.t === "res" && frame.re === re);
    if (!reply) throw new Error(`No res for ${type}: ${JSON.stringify(frames)}`);
    return reply.p;
  } finally {
    if (options.onRoundCard) store.recordTurnCardCompletionFieldsWithinTransaction = recordCard;
    session.handleSocketClose();
    layer.stop();
  }
}
