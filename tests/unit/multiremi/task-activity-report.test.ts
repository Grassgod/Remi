/**
 * PR 5 (spec §5): the daemon's best-effort `task.activity` frame stores the
 * running-subagent count on the attempt it reports for.
 *
 * - It is authorized like every task report; a frame outside the daemon's
 *   authority, or with a malformed count, writes nothing.
 * - Only an active attempt (accepted or running) takes the count. A terminal
 *   attempt ignores it, and `/api/turns` reports none for it.
 * - A changed value tells the Chat's creator `task:subagents` with the count;
 *   there is no project-only gate, an unchanged value tells nobody, and the
 *   event never wakes daemon downlinks.
 * - Without an `id` the frame gets no reply, as a best-effort frame should.
 *
 * On SQLite and Postgres.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { registerDaemonReportHandlers } from "@multiremi/api/daemon-protocol/report-handlers.js";
import { notifyBrowserTaskEvent } from "@multiremi/api/realtime.js";
import { activeRequestReadCache, cacheKey, withRequestReadCache } from "@multiremi/store/request-read-cache.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { createResponsibleTestIssue } from "./helpers.js";
import { traceBackfillBackends, type OpenedStore } from "./trace-backfill-backends.js";
import { backendsInScope } from "../../helpers/postgres-scope.js";

const TIMEOUT = 60_000;
const DAEMON = "fixture-activity";
const backends = backendsInScope(import.meta.path, await traceBackfillBackends("taskactivity"));

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

interface World {
  opened: OpenedStore;
  store: MultiremiStore;
  runtimeId: string;
  agentId: string;
}

async function withWorld(backend: (typeof backends)[number], body: (world: World) => Promise<void>) {
  const opened = await backend.open();
  try {
    const { store } = opened;
    const runtime = store.registerRuntime({ daemonId: DAEMON, name: "Activity daemon", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Activity agent", provider: "claude", workspaceId: "local", runtimeId: runtime.id,
      maxConcurrentTasks: 4 });
    await body({ opened, store, runtimeId: runtime.id, agentId: agent.id });
  } finally {
    await opened.close();
  }
}

/** A running Chat attempt. The Chat has no project: `task:subagents` has no project gate. */
function runChatTask(world: World, agentId = world.agentId, runtimeId = world.runtimeId) {
  const chat = world.store.createChatSession({ agentId, workspaceId: "local", creatorId: "local" });
  const task = world.store.sendChatMessage(chat.id, { content: "spawn two subagents" }).task;
  expect(world.store.claimTask(runtimeId)?.id).toBe(task.id);
  world.store.startTask(task.id);
  return { chat, task };
}

function runIssueTask(world: World) {
  const issue = createResponsibleTestIssue(world.store, { title: "Activity issue", workspaceId: "local" });
  const task = world.store.createTask({ agentId: world.agentId, workspaceId: "local", issueId: issue.id, prompt: "work" });
  expect(world.store.claimTask(world.runtimeId)?.id).toBe(task.id);
  world.store.startTask(task.id);
  return task;
}

/**
 * Send one `task.activity` frame through a real session of the daemon protocol
 * layer, as the daemon does: no `seq`, and no `id` unless `id` is given, which
 * makes the outcome visible as a `res`. Returns every frame the server sent
 * after the handshake.
 */
async function activity(store: MultiremiStore, payload: Record<string, unknown>,
  options: { runtimeId: string; rt?: string | null; id?: string; daemonId?: string }) {
  const layer = new DaemonProtocolLayer({ store });
  registerDaemonReportHandlers(layer, store);
  const frames: Array<Record<string, any>> = [];
  const session = layer.openSession({
    get bufferedAmount() { return 0; },
    send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); },
    close() {},
  }, { accessToken: null, masterToken: true });
  try {
    const runtime = store.getRuntimeLite(options.runtimeId)!;
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: options.daemonId ?? runtime.daemonId ?? DAEMON,
      runtimes: [{ runtime_id: options.runtimeId, provider: runtime.provider, max_concurrency: 4,
        active_task_ids: store.listTasksForRuntimeStatuses(options.runtimeId, ["dispatched", "running"]).map((task) => task.id) }],
    } }));
    const handshake = frames.length;
    const rt = options.rt === undefined ? options.runtimeId : options.rt;
    await session.handleMessage(JSON.stringify({ v: 2, t: "task.activity", ...(options.id ? { id: options.id } : {}),
      ...(rt ? { rt } : {}), p: payload }));
    await layer.drain();
    return frames.slice(handshake);
  } finally {
    session.handleSocketClose();
    layer.stop();
  }
}

const report = (world: World, taskId: string, count: unknown) =>
  activity(world.store, { task_id: taskId, running_subagents: count }, { runtimeId: world.runtimeId });

/** The `res` an `id`-carrying frame gets. */
async function outcome(world: World, payload: Record<string, unknown>, options: Partial<Parameters<typeof activity>[2]> = {}) {
  const frames = await activity(world.store, payload, { runtimeId: world.runtimeId, ...options, id: "probe" });
  return frames.find((frame) => frame.t === "res" && frame.re === "probe")?.p;
}

function listedTurn(store: MultiremiStore, taskId: string) {
  const turn = store.getTurnForAttempt(taskId)!;
  return store.listTurns({ workspace_id: "local", session_id: turn.session_id }).find((row) => row.id === turn.id)!;
}

function currentAttempt(store: MultiremiStore, taskId: string) {
  return store.listTurnAttempts(store.getTurnForAttempt(taskId)!.id).find((row) => row.id === taskId)!;
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`task.activity report (${backend.name})`, () => {
    it("stores a running Chat attempt's count and tells only the creator, only on change", async () => {
      await withWorld(backend, async (world) => {
        const { chat, task } = runChatTask(world);
        const events: Array<{ type: string; task: MultiremiTask }> = [];
        const unsubscribe = world.store.onTaskEvent((event) => events.push(event));
        try {
          // The closing 0 of an attempt that never ran a subagent writes nothing.
          expect(await report(world, task.id, 0)).toEqual([]);
          expect(world.store.getRunningSubagents(task.id)).toBeNull();
          expect(listedTurn(world.store, task.id).running_subagents).toBeNull();

          const seen: number[] = [];
          for (const count of [2, 2, 1, 1, 0, 0]) {
            // Best effort: no reply without an id.
            expect(await report(world, task.id, count)).toEqual([]);
            expect(world.store.getRunningSubagents(task.id)).toBe(count);
            expect(listedTurn(world.store, task.id).running_subagents).toBe(count);
            seen.push(...events.splice(0).map((event) => {
              expect(event).toMatchObject({ type: "task:subagents", task: { id: task.id, chatSessionId: chat.id } });
              return count;
            }));
          }
          expect(seen).toEqual([2, 1, 0]);

          // The browser frame carries the stored count to the Chat's creator, nobody else.
          expect(await report(world, task.id, 3)).toEqual([]);
          const [event] = events.splice(0);
          const creatorFrames: string[] = [];
          const workspaceFrames: string[] = [];
          notifyBrowserTaskEvent(
            new Map([["local", new Set([{ data: { kind: "browser", authenticated: true, userId: "local" },
              sendText: (frame: string) => workspaceFrames.push(frame) } as any])]]),
            new Map([[chat.creatorId!, new Set([{ data: { kind: "browser", workspaceId: "local" },
              sendText: (frame: string) => creatorFrames.push(frame) } as any])]]),
            world.store, event!.type, event!.task,
          );
          expect(creatorFrames.map((frame) => JSON.parse(frame))).toEqual([expect.objectContaining({
            type: "task:subagents",
            payload: expect.objectContaining({ task_id: task.id, chat_session_id: chat.id, running_subagents: 3 }),
          })]);
          expect(workspaceFrames).toEqual([]);
        } finally { unsubscribe(); }
      });
    }, TIMEOUT);

    it("PR 6: stores running_background_tasks beside the subagent count, optional and validated", async () => {
      await withWorld(backend, async (world) => {
        const { chat, task } = runChatTask(world);
        const events: MultiremiTask[] = [];
        const unsubscribe = world.store.onTaskEvent((event) => { if (event.type === "task:subagents") events.push(event.task); });
        try {
          // An older daemon omits it: the stored value stays unreported, not 0.
          expect(await report(world, task.id, 1)).toEqual([]);
          expect(world.store.getRunningBackgroundTasks(task.id)).toBeNull();
          expect(listedTurn(world.store, task.id)).toMatchObject({ running_subagents: 1, running_background_tasks: null });
          // A change of either count writes and tells the creator once.
          for (const [subagents, background] of [[1, 2], [1, 2], [0, 2], [0, 0]] as const) {
            expect(await activity(world.store, { task_id: task.id, running_subagents: subagents, running_background_tasks: background },
              { runtimeId: world.runtimeId })).toEqual([]);
          }
          expect(events).toHaveLength(4);
          expect(world.store.getRunningBackgroundTasks(task.id)).toBe(0);
          await activity(world.store, { task_id: task.id, running_subagents: 0, running_background_tasks: 3 }, { runtimeId: world.runtimeId });
          expect(listedTurn(world.store, task.id)).toMatchObject({ running_subagents: 0, running_background_tasks: 3 });
          expect(currentAttempt(world.store, task.id)).toMatchObject({ running_background_tasks: 3 });
          const frames: string[] = [];
          notifyBrowserTaskEvent(new Map(), new Map([[chat.creatorId!, new Set([{ data: { kind: "browser", workspaceId: "local" },
            sendText: (frame: string) => frames.push(frame) } as any])]]), world.store, "task:subagents", events.at(-1)!);
          expect(JSON.parse(frames[0]!).payload).toMatchObject({ running_subagents: 0, running_background_tasks: 3 });
          for (const bad of [-1, 1.5, "2", null, 2 ** 31]) {
            expect(await outcome(world, { task_id: task.id, running_subagents: 0, running_background_tasks: bad }))
              .toEqual({ ok: false, code: "invalid_report", retryable: false });
          }
          expect(world.store.getRunningBackgroundTasks(task.id)).toBe(3);
          // Only an active attempt reports one.
          world.store.cancelTask(task.id);
          expect(listedTurn(world.store, task.id).running_background_tasks).toBeNull();
          expect(currentAttempt(world.store, task.id).running_background_tasks).toBeNull();
        } finally { unsubscribe(); }
      });
    }, TIMEOUT);

    it("stores an Issue attempt's count without a browser event", async () => {
      await withWorld(backend, async (world) => {
        const task = runIssueTask(world);
        const events: string[] = [];
        const unsubscribe = world.store.onTaskEvent((event) => events.push(event.type));
        try {
          await report(world, task.id, 4);
        } finally { unsubscribe(); }
        expect(world.store.getRunningSubagents(task.id)).toBe(4);
        expect(events).toEqual([]);
        expect(listedTurn(world.store, task.id).running_subagents).toBe(4);
        expect(currentAttempt(world.store, task.id).running_subagents).toBe(4);
      });
    }, TIMEOUT);

    it("ignores the count of a terminal attempt and lists none for it", async () => {
      await withWorld(backend, async (world) => {
        const { task } = runChatTask(world);
        await report(world, task.id, 2);
        world.store.cancelTask(task.id);
        expect(world.store.getTask(task.id)?.status).toBe("cancelled");
        const events: string[] = [];
        const unsubscribe = world.store.onTaskEvent((event) => events.push(event.type));
        try {
          // The daemon's closing frame lost the race with the cancel: an accepted no-op.
          expect(await outcome(world, { task_id: task.id, running_subagents: 0 })).toEqual({ ok: true });
          expect(await outcome(world, { task_id: task.id, running_subagents: 5 })).toEqual({ ok: true });
        } finally { unsubscribe(); }
        expect(events).toEqual([]);
        expect(world.store.getRunningSubagents(task.id)).toBe(2);
        // A count the daemon never cleared does not outlive the attempt.
        expect(listedTurn(world.store, task.id)).toMatchObject({ status: "cancelled", running_subagents: null });
        expect(currentAttempt(world.store, task.id)).toMatchObject({ status: "cancelled", running_subagents: null });
      });
    }, TIMEOUT);

    it("rejects a frame outside the daemon's authority or with a malformed count without writing", async () => {
      await withWorld(backend, async (world) => {
        const { task } = runChatTask(world);
        // A second runtime on the same daemon, and a third on another daemon.
        const sibling = world.store.registerRuntime({ daemonId: DAEMON, name: "Sibling", provider: "claude", workspaceId: "local" });
        const foreign = world.store.registerRuntime({ daemonId: "fixture-foreign", name: "Foreign", provider: "claude", workspaceId: "local" });
        const events: string[] = [];
        const unsubscribe = world.store.onTaskEvent((event) => events.push(event.type));
        const valid = { task_id: task.id, running_subagents: 1 };
        try {
          for (const [payload, options, code] of [
            [{ ...valid, task_id: "" }, {}, "invalid_report"],
            [{ ...valid, task_id: "tsk_missing" }, {}, "task_not_found"],
            [valid, { runtimeId: sibling.id }, "authority_revoked"],
            [valid, { runtimeId: foreign.id }, "authority_revoked"],
            [{ ...valid, runtime_id: sibling.id }, {}, "authority_revoked"],
            [{ task_id: task.id }, {}, "invalid_report"],
            [{ ...valid, running_subagents: -1 }, {}, "invalid_report"],
            [{ ...valid, running_subagents: 1.5 }, {}, "invalid_report"],
            [{ ...valid, running_subagents: "1" }, {}, "invalid_report"],
            [{ ...valid, running_subagents: null }, {}, "invalid_report"],
            [{ ...valid, running_subagents: 2 ** 31 }, {}, "invalid_report"],
          ] as const) {
            expect(await outcome(world, payload, options), JSON.stringify({ payload, options }))
              .toEqual({ ok: false, code, retryable: false });
          }
          // Without an id a rejection is silent, as for every best-effort frame.
          expect(await activity(world.store, valid, { runtimeId: foreign.id })).toEqual([]);
        } finally { unsubscribe(); }
        expect(world.store.getRunningSubagents(task.id)).toBeNull();
        expect(events).toEqual([]);
        // The same frame from the right runtime lands; the payload may name it.
        expect(await outcome(world, { ...valid, runtime_id: world.runtimeId })).toEqual({ ok: true });
        expect(world.store.getRunningSubagents(task.id)).toBe(1);
      });
    }, TIMEOUT);

    it("serves the current attempt's count on /api/turns and clears the request read cache", async () => {
      await withWorld(backend, async (world) => {
        const { chat, task } = runChatTask(world);
        const app = createMultiremiApp({ store: world.store });
        const turns = async (query: string) => {
          const response = await app.request(`/api/turns?${query}`);
          expect(response.status).toBe(200);
          return (await response.json()).turns as Array<Record<string, unknown>>;
        };
        expect((await turns(`session_id=${chat.id}&status=running`))[0]).toMatchObject({ current_attempt_id: task.id, running_subagents: null });
        await report(world, task.id, 2);
        expect(await turns(`session_id=${chat.id}&status=running`)).toEqual([expect.objectContaining({
          current_attempt_id: task.id, running_subagents: 2 })]);
        const detail = await (await app.request(`/api/turns/${world.store.getTurnForAttempt(task.id)!.id}?attempts=true`)).json();
        expect(detail.attempts).toEqual([expect.objectContaining({ id: task.id, running_subagents: 2, late_subagents: null })]);

        // A later read in the same request sees the write, not a row cached before it.
        withRequestReadCache(() => {
          const key = cacheKey("multiremi_turn_execution_records", "row", task.id);
          const before = world.store.getTask(task.id)!;
          const cached = activeRequestReadCache()!.get<Record<string, unknown>>(key);
          expect(cached).toMatchObject({ id: task.id });
          expect(world.store.recordRunningSubagents(task.id, 3)).toBe(true);
          // The write evicted the cached row; any row cached now was read after it.
          const after = activeRequestReadCache()!.get<Record<string, unknown>>(key);
          expect(after).not.toBe(cached);
          const stored = world.opened.db.query("SELECT updated_at FROM multiremi_turn_attempts WHERE id = ?").get(task.id) as { updated_at: string };
          expect(world.store.getTask(task.id)!.updatedAt).toBe(stored.updated_at);
          expect(stored.updated_at >= before.updatedAt).toBe(true);
          expect(listedTurn(world.store, task.id).running_subagents).toBe(3);
        });
      });
    }, TIMEOUT);
  });
}

describe("task.activity in the server", () => {
  it("reaches browsers without waking daemon downlinks", async () => {
    const [sqlite] = backends;
    await withWorld(sqlite!, async (world) => {
      const project = world.store.createProject({ title: "Activity project" });
      const chat = world.store.createChatSession({ agentId: world.agentId, workspaceId: "local", creatorId: "local", projectId: project.id });
      const task = world.store.sendChatMessage(chat.id, { content: "spawn" }).task;
      expect(world.store.claimTask(world.runtimeId)?.id).toBe(task.id);
      world.store.startTask(task.id);
      let layer: DaemonProtocolLayer | undefined;
      const server = startMultiremiServer({ store: world.store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1",
        port: 0, authToken: "fixture-master", onDaemonProtocol: (created) => { layer = created; } });
      const session = layer!.openSession({
        get bufferedAmount() { return 0; },
        send(text) { return Buffer.byteLength(text); },
        close() {},
      }, { accessToken: null, masterToken: true });
      const snapshots = spyOn(world.store, "pendingRuntimeRequests");
      try {
        await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
          protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: DAEMON,
          runtimes: [{ runtime_id: world.runtimeId, provider: "claude", max_concurrency: 4, active_task_ids: [task.id] }],
        } }));
        await layer!.drain();
        snapshots.mockClear();
        const events: string[] = [];
        const unsubscribe = world.store.onTaskEvent((event) => events.push(event.type));
        try {
          for (const count of [1, 2, 0]) {
            await session.handleMessage(JSON.stringify({ v: 2, t: "task.activity", rt: world.runtimeId,
              p: { task_id: task.id, running_subagents: count } }));
            await layer!.drain();
          }
          expect(events).toEqual(["task:subagents", "task:subagents", "task:subagents"]);
          expect(snapshots).not.toHaveBeenCalled();
          // Control: a project Chat's progress event does wake this runtime's downlinks.
          world.store.reportProgress(task.id, "preparing", 1, 2);
          await layer!.drain();
          expect(events.at(-1)).toBe("task:progress");
          expect(snapshots).toHaveBeenCalledWith(world.runtimeId);
        } finally { unsubscribe(); }
      } finally {
        snapshots.mockRestore();
        session.handleSocketClose();
        await layer?.drain();
        server.stop(true);
      }
    });
  }, TIMEOUT);
});
