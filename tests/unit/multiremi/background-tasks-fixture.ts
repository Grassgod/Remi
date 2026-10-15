/**
 * PR 6 server tests: a Chat lane whose first attempt completed on a runtime
 * with provider session `sess-1` (so the Chat's lineage is that runtime and
 * session), lane snapshots and tasks as a daemon sends them, and a daemon
 * protocol session that negotiated `lane.background`.
 */
import { expect } from "bun:test";
import {
  DAEMON_MIN_CLI_VERSION,
  type DaemonLaneBackgroundTask,
  type DaemonLaneBackgroundTasksPayload,
  type DaemonParkedLane,
  type DaemonProtocolCap,
} from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { registerDaemonReportHandlers } from "@multiremi/api/daemon-protocol/report-handlers.js";
import { registerBackgroundTaskHandlers } from "@multiremi/api/daemon-protocol/background-task-handlers.js";
import type { MultiremiStore } from "@multiremi/store.js";

export const PROVIDER_SESSION = "sess-1";

export interface BackgroundWorld {
  store: MultiremiStore;
  daemonId: string;
  runtimeId: string;
  agentId: string;
  chatId: string;
  /** The completed attempt that started the tasks. */
  attemptId: string;
  turnId: string;
}

let sequence = 0;

/** A runtime, its agent and a Chat whose first turn completed there on {@link PROVIDER_SESSION}. */
export function backgroundWorld(store: MultiremiStore, options: { creatorId?: string; daemonId?: string } = {}): BackgroundWorld {
  sequence += 1;
  const daemonId = options.daemonId ?? `bg-daemon-${sequence}`;
  const runtime = store.registerRuntime({ daemonId, name: `Background host ${sequence}`, provider: "claude", workspaceId: "local",
    maxConcurrency: 4 });
  const agent = store.createAgent({ name: `Background agent ${sequence}`, provider: "claude", workspaceId: "local", visibility: "workspace",
    runtimeId: runtime.id, maxConcurrentTasks: 4 });
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: options.creatorId ?? "local" });
  const attempt = runAttempt(store, runtime.id, chat.id, "start the dev server in the background");
  store.completeTask(attempt.id, { output: "The server is starting.", sessionId: PROVIDER_SESSION, workDir: "/tmp/claude-pr6d-wd" });
  const world = { store, daemonId, runtimeId: runtime.id, agentId: agent.id, chatId: chat.id, attemptId: attempt.id,
    turnId: store.getTurnForAttempt(attempt.id)!.id };
  expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: PROVIDER_SESSION, sessionRuntimeId: runtime.id });
  return world;
}

/** Send a Chat message and start its attempt on the runtime. */
export function runAttempt(store: MultiremiStore, runtimeId: string, chatId: string, body: string) {
  const task = store.sendChatMessage(chatId, { body }).task;
  expect(store.claimTask(runtimeId)?.id).toBe(task.id);
  store.startTask(task.id);
  return task;
}

export function laneTask(world: BackgroundWorld, overrides: Partial<DaemonLaneBackgroundTask> = {}): DaemonLaneBackgroundTask {
  return {
    task_id: "bash-1", task_type: "shell", name: "npm run dev", command: "npm run dev",
    origin_attempt_id: world.attemptId, origin_item_id: "bg:bash-1", status: "running", can_stop: true,
    started_at: "2026-10-16T01:00:00.000Z", output_tail: "ready on :3000\n", ...overrides,
  };
}

export function laneSnapshot(world: BackgroundWorld, revision: number, tasks: DaemonLaneBackgroundTask[],
  overrides: Partial<DaemonLaneBackgroundTasksPayload> = {}): DaemonLaneBackgroundTasksPayload {
  return {
    runtime_id: world.runtimeId, session_id: world.chatId, agent_id: world.agentId, execution_scope: "",
    provider_session_id: PROVIDER_SESSION, revision, state: "parked", parked_until: "2026-10-16T03:00:00.000Z",
    tasks, ...overrides,
  };
}

export function snapshotFor(world: BackgroundWorld, revision: number, tasks: DaemonLaneBackgroundTask[],
  overrides: Partial<DaemonLaneBackgroundTasksPayload> = {}): number {
  return world.store.upsertLaneBackgroundSnapshot(world.runtimeId, "local", laneSnapshot(world, revision, tasks, overrides));
}

export interface DaemonHarness {
  layer: DaemonProtocolLayer;
  /** Frames the server sent after the handshake. */
  frames: Array<Record<string, any>>;
  welcome: Record<string, any>;
  /** Runtimes the handlers asked to re-run downlinks for. */
  kicks: string[];
  send(type: string, payload: Record<string, unknown>, options?: { id?: string; rt?: string | null }): Promise<Array<Record<string, any>>>;
  /** The `res` of an `id`-carrying frame. */
  call(type: string, payload: Record<string, unknown>, options?: { rt?: string | null }): Promise<Record<string, any> | undefined>;
  close(): void;
}

/** A daemon session over the real protocol layer, with the report and background-task handlers. */
export async function daemonHarness(store: MultiremiStore, world: Pick<BackgroundWorld, "runtimeId" | "daemonId">, options: {
  caps?: DaemonProtocolCap[];
  welcomeCaps?: DaemonProtocolCap[];
  parkedLanes?: DaemonParkedLane[];
  activeTaskIds?: string[];
} = {}): Promise<DaemonHarness> {
  const layer = new DaemonProtocolLayer({ store, ...(options.welcomeCaps ? { welcomeCaps: options.welcomeCaps } : {}) });
  registerDaemonReportHandlers(layer, store);
  const kicks: string[] = [];
  registerBackgroundTaskHandlers(layer, store, (rt) => kicks.push(rt));
  const all: Array<Record<string, any>> = [];
  const session = layer.openSession({
    get bufferedAmount() { return 0; },
    send(text) { all.push(JSON.parse(text)); return Buffer.byteLength(text); },
    close() {},
  }, { accessToken: null, masterToken: true });
  const runtime = store.getRuntimeLite(world.runtimeId)!;
  await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
    protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: world.daemonId,
    caps: options.caps ?? ["offer", "turn.message", "lane.background"],
    runtimes: [{ runtime_id: world.runtimeId, provider: runtime.provider, max_concurrency: 4,
      active_task_ids: options.activeTaskIds ?? [],
      ...(options.parkedLanes ? { parked_lanes: options.parkedLanes } : {}) }],
  } }));
  await layer.drain();
  const welcome = all.find((frame) => frame.t === "welcome")?.p;
  expect(welcome).toBeDefined();
  const handshake = all.length;
  let next = 0;
  const send: DaemonHarness["send"] = async (type, payload, sendOptions = {}) => {
    const before = all.length;
    const rt = sendOptions.rt === undefined ? world.runtimeId : sendOptions.rt;
    await session.handleMessage(JSON.stringify({ v: 2, t: type, ...(sendOptions.id ? { id: sendOptions.id } : {}),
      ...(rt ? { rt } : {}), p: payload }));
    await layer.drain();
    return all.slice(before);
  };
  return {
    layer, welcome, kicks, send,
    get frames() { return all.slice(handshake); },
    async call(type, payload, callOptions = {}) {
      const id = `probe-${++next}`;
      const frames = await send(type, payload, { ...callOptions, id });
      return frames.find((frame) => frame.t === "res" && frame.re === id)?.p;
    },
    close() { session.handleSocketClose(); layer.stop(); },
  };
}
