/**
 * The daemon's parked-lane registry (PR 6 §2.3): the park decision, the
 * keep-alive cap, eviction, release reasons and the done-close, the doorbell
 * (Claude completed or failed only), the hold of a request raised while
 * parked, the lane snapshots, and the crash sweep of `parked-bridges.json`.
 * The provider is a stub with an async-task registry.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsyncTaskSnapshot } from "@shared/contracts/provider-types.js";
import type { DaemonLaneBackgroundTasksPayload, DaemonLaneBackgroundWakePayload, DaemonLaneBackgroundWakeReply } from "@multiremi/contracts/daemon-protocol.js";
import {
  ParkedLanes,
  isBackgroundDoorbellMessage,
  laneKeyOf,
  processStartTime,
  resolveMaxParkedLanes,
  type LaneRecord,
  type ParkableProvider,
  type ParkedLanesOptions,
} from "@multiremi/worker/parked-lanes.js";
import { AsyncTaskOutputTailer } from "@multiremi/worker/async-task-output.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class StubProvider implements ParkableProvider {
  tasks = new Map<string, AsyncTaskSnapshot>();
  parked = new Map<string, boolean>();
  closed = 0;
  stops: Array<[string, string | undefined]> = [];
  cancels = 0;
  alive = true;
  chatId: string;
  permission: ((params: any) => Promise<any>) | null = null;
  onChange: ((chatId: string, task: AsyncTaskSnapshot) => void) | null = null;
  constructor(chatId: string) { this.chatId = chatId; }
  listAsyncTasks() { return [...this.tasks.values()]; }
  async stopAsyncTask(taskId: string, options: { by?: "user" | "remi" }) {
    const task = this.tasks.get(taskId);
    this.stops.push([taskId, options.by]);
    if (!task || (task.state !== "running" && task.state !== "paused")) return { stopped: false };
    this.change({ ...task, state: "stopped", endedAt: Date.now(), stop: { requestedAt: Date.now(), by: options.by ?? "remi", outcome: "stopped" } });
    return { stopped: true };
  }
  park(chatId: string, on: boolean) { this.parked.set(chatId, on); }
  adoptSession(from: string, to: string) { if (from !== this.chatId) return false; this.chatId = to; return true; }
  processGroupId() { return this.alive ? 4242 : null; }
  sessionAlive() { return this.alive; }
  async cancelIdle() { this.cancels++; }
  setPermissionHandler(handler: (params: any) => Promise<any>) { this.permission = handler; }
  setElicitationHandler() {}
  async close() { this.closed++; this.alive = false; }
  change(task: AsyncTaskSnapshot) { this.tasks.set(task.id, task); this.onChange?.(this.chatId, task); }
}

const snapshot = (id: string, state: AsyncTaskSnapshot["state"] = "running", extra: Partial<AsyncTaskSnapshot> = {}): AsyncTaskSnapshot => ({
  id, sessionId: "sess_root", state, canStop: true, name: `task ${id}`, taskType: "shell", description: `task ${id}`, toolCallId: `toolu_${id}`,
  outputFilePath: null, summary: null, lastToolName: null, usage: null, startedAt: Date.now() - 1_000,
  endedAt: state === "running" || state === "paused" ? null : Date.now(), stop: null, ...extra,
});

function registry(options: Partial<ParkedLanesOptions> = {}) {
  const snapshots: DaemonLaneBackgroundTasksPayload[] = [];
  const wakes: DaemonLaneBackgroundWakePayload[] = [];
  const logs: string[] = [];
  let shares = true;
  const lanes = new ParkedLanes({
    maxParkedLanes: 4, keepAliveMs: 60_000, stateFile: null, runtimeId: () => "rt_1", sharesCap: () => shares,
    sendSnapshot: (payload) => snapshots.push(payload),
    wake: async (payload) => { wakes.push(payload); return { ok: true, outcome: "created", turn_id: "turn_2", attempt_id: null } as DaemonLaneBackgroundWakeReply; },
    log: { info: (message, data) => logs.push(`${message} ${JSON.stringify(data ?? {})}`), warn: (message, data) => logs.push(`${message} ${JSON.stringify(data ?? {})}`) },
    debounceMs: 5, refreshMs: 60_000, closedRepeats: 3, closedRepeatMs: 20, idleCloseMs: 60_000, requestHoldMs: 300, stopTimeoutMs: 500,
    ...options,
  });
  let disposals = 0;
  const begin = (session: string, chatId: string, extra: { wakesModel?: boolean } = {}) => {
    const provider = new StubProvider(chatId);
    const record = lanes.begin({ lane: { session_id: session, agent_id: "agt_1", execution_scope: "" }, provider, poolChatId: chatId,
      attemptId: chatId, providerSessionId: `prov_${session}`, wakesModel: extra.wakesModel ?? true, launchFingerprint: "launch-1",
      resources: { privateTmpPath: null, pluginFingerprint: null, dispose: async () => { disposals++; } } });
    provider.onChange = lanes.onAsyncTaskChange;
    return { provider, record };
  };
  return { lanes, snapshots, wakes, logs, begin, setShares: (value: boolean) => { shares = value; }, disposals: () => disposals };
}

const waitFor = async (probe: () => boolean, label: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
};

describe("ParkedLanes: the park decision (§2.2)", () => {
  it("parks only an attempt's live lane with room, both sides holding the cap, and parking on", async () => {
    const r = registry();
    const { record } = r.begin("chat_a", "tsk_1");
    expect(r.lanes.canPark(record)).toEqual({ park: true });
    r.setShares(false);
    expect(r.lanes.canPark(record)).toEqual({ park: false, reason: null });
    r.setShares(true);
    r.lanes.disable("draining");
    expect(r.lanes.canPark(record)).toEqual({ park: false, reason: "daemon_restart" });
    r.lanes.disable(null);
    record.releaseAfterAttempt = "session_closed";
    expect(r.lanes.canPark(record)).toEqual({ park: false, reason: "session_closed" });
    record.releaseAfterAttempt = null;
    (record.provider as StubProvider).alive = false;
    expect(r.lanes.canPark(record)).toEqual({ park: false, reason: null });
    const off = registry({ maxParkedLanes: 0 });
    expect(off.lanes.canPark(off.begin("chat_b", "tsk_2").record)).toEqual({ park: false, reason: null });
  });

  it("parks: suspends the provider's cleanup, starts the cap, snapshots `parked` with the cap time", async () => {
    const r = registry();
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("bash-1"));
    expect(await r.lanes.park(record)).toEqual({ parked: true });
    expect(provider.parked.get("tsk_1")).toBe(true);
    expect(r.lanes.isParked(laneKeyOf(record.lane))).toBe(true);
    await waitFor(() => r.snapshots.some((payload) => payload.state === "parked"), "the parked snapshot");
    const parked = r.snapshots.find((payload) => payload.state === "parked")!;
    expect(parked).toMatchObject({ runtime_id: "rt_1", session_id: "chat_a", provider_session_id: "prov_chat_a", attempt_id: null });
    expect(Date.parse(parked.parked_until!)).toBeGreaterThan(Date.now() + 50_000);
    expect(parked.tasks).toEqual([expect.objectContaining({ task_id: "bash-1", status: "running", origin_attempt_id: "tsk_1",
      origin_item_id: "bg:bash-1", can_stop: true, command: null })]);
  });
});

describe("ParkedLanes: limits, timers and releases (§2.7)", () => {
  it("the keep-alive cap stops every task (keepalive_cap), closes the process and repeats the closed snapshot", async () => {
    const r = registry({ keepAliveMs: 80 });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("bash-1"));
    await r.lanes.park(record);
    await waitFor(() => provider.closed === 1, "the cap");
    expect(provider.stops).toEqual([["bash-1", "remi"]]);
    expect(r.disposals()).toBe(1);
    await waitFor(() => r.snapshots.filter((payload) => payload.state === "closed").length === 3, "three closed snapshots");
    const closed = r.snapshots.filter((payload) => payload.state === "closed");
    expect(closed.map((payload) => payload.revision)).toEqual([...closed.map((payload) => payload.revision)].sort((a, b) => a - b));
    expect(closed[0]!.tasks[0]).toMatchObject({ status: "stopped", stop_reason: "keepalive_cap" });
    expect(r.lanes.get(laneKeyOf(record.lane))).toBeNull();
  });

  it("evicts the least recently active parked lane, never one whose doorbell is out; with none evictable it does not park", async () => {
    const r = registry({ maxParkedLanes: 2 });
    const a = r.begin("chat_a", "tsk_a");
    const b = r.begin("chat_b", "tsk_b");
    for (const lane of [a, b]) {
      lane.provider.change(snapshot(`bash-${lane.record.lane.session_id}`));
      await r.lanes.park(lane.record);
      await Bun.sleep(5);
    }
    a.record.doorbell = "sent";
    const c = r.begin("chat_c", "tsk_c");
    c.provider.change(snapshot("bash-c"));
    expect(await r.lanes.park(c.record)).toEqual({ parked: true });
    expect(b.provider.closed).toBe(1);
    expect(a.provider.closed).toBe(0);
    await waitFor(() => r.snapshots.some((payload) => payload.session_id === "chat_b" && payload.state === "closed"), "b closed");
    expect(r.snapshots.find((payload) => payload.session_id === "chat_b" && payload.state === "closed")!.tasks[0])
      .toMatchObject({ stop_reason: "evicted" });
    c.record.doorbell = "sent";
    const d = r.begin("chat_d", "tsk_d");
    expect(r.lanes.canPark(d.record)).toEqual({ park: false, reason: "no_capacity" });
    expect(await r.lanes.park(d.record)).toEqual({ parked: false, reason: "no_capacity" });
  });

  it("closes as done once nothing runs and no doorbell is out", async () => {
    const r = registry({ idleCloseMs: 60 });
    const { record, provider } = r.begin("chat_a", "tsk_1", { wakesModel: false });
    provider.change(snapshot("term-1"));
    await r.lanes.park(record);
    await Bun.sleep(100);
    expect(provider.closed).toBe(0);
    provider.change(snapshot("term-1", "completed"));
    await waitFor(() => provider.closed === 1, "the done close");
    expect(r.wakes).toEqual([]);
    expect(provider.stops).toEqual([]);
  });

  it("claim, adopt, unclaim, and the adopt verdict (one process per provider session, §2.4)", async () => {
    const r = registry();
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("bash-1"));
    await r.lanes.park(record);
    const key = laneKeyOf(record.lane);
    expect(r.lanes.claim("other", "tsk_2")).toBeNull();
    const claimed = r.lanes.claim(key, "tsk_2")!;
    expect(claimed).toBe(record);
    expect(r.lanes.isParked(key)).toBe(false);
    expect(r.lanes.adoptVerdict(claimed, { providerSessionId: "prov_other", launchFingerprint: "launch-1", reuse: { reuse: true } }))
      .toEqual({ adopt: false, reason: "lane_reset", cause: "lane_reset" });
    expect(r.lanes.adoptVerdict(claimed, { providerSessionId: null, launchFingerprint: "launch-1", reuse: { reuse: true } }))
      .toMatchObject({ adopt: false, reason: "lane_reset" });
    expect(r.lanes.adoptVerdict(claimed, { providerSessionId: "prov_chat_a", launchFingerprint: "launch-2", reuse: { reuse: true } }))
      .toEqual({ adopt: false, reason: "config_changed", cause: "config_changed" });
    expect(r.lanes.adoptVerdict(claimed, { providerSessionId: "prov_chat_a", launchFingerprint: "launch-1", reuse: { reuse: false, reason: "plugins" } }))
      .toEqual({ adopt: false, reason: "config_changed", cause: "plugins" });
    expect(r.lanes.adoptVerdict(claimed, { providerSessionId: "prov_chat_a", launchFingerprint: "launch-1", reuse: { reuse: false, reason: "process_dead" } }))
      .toMatchObject({ adopt: false, reason: "lost" });
    expect(r.lanes.adoptVerdict(claimed, { providerSessionId: "prov_chat_a", launchFingerprint: "launch-1", reuse: { reuse: true } }))
      .toEqual({ adopt: true });
    r.lanes.unclaim(claimed);
    expect(r.lanes.isParked(key)).toBe(true);
    r.lanes.claim(key, "tsk_2");
    expect(r.lanes.adopt(record, "tsk_2", "tsk_2")).toBe(true);
    expect(record).toMatchObject({ state: "in_attempt", poolChatId: "tsk_2", attemptId: "tsk_2", parkedUntil: null });
    expect(provider.parked.get("tsk_2")).toBe(false);
    // A task change after the move is still the lane's.
    provider.change(snapshot("bash-2"));
    expect(record.tasks.get("bash-2")!.originAttemptId).toBe("tsk_2");
  });

  it("acquire waits for the lane's previous attempt to park (then claims it) or close (then none); never two processes", async () => {
    const r = registry();
    const first = r.begin("chat_a", "tsk_1");
    first.provider.change(snapshot("srv"));
    const key = laneKeyOf(first.record.lane);
    // The stopped attempt still finishes: the next one waits instead of starting a second process.
    let acquired: LaneRecord | null | undefined;
    const waiting = r.lanes.acquire(key, "tsk_2").then((record) => { acquired = record; });
    await Bun.sleep(30);
    expect(acquired).toBeUndefined();
    await r.lanes.park(first.record);
    await waiting;
    expect(acquired).toBe(first.record);
    expect(first.record.state).toBe("claimed");
    // An attempt that ends without parking closes the process: the next one starts fresh.
    const second = r.begin("chat_b", "tsk_3");
    let none: LaneRecord | null | undefined;
    const fresh = r.lanes.acquire(laneKeyOf(second.record.lane), "tsk_4").then((record) => { none = record; });
    await Bun.sleep(30);
    expect(none).toBeUndefined();
    await r.lanes.endAttempt(second.record, null);
    await fresh;
    expect(none).toBeNull();
    // Bounded, and cancellable.
    const third = r.begin("chat_c", "tsk_5");
    await expect(r.lanes.acquire(laneKeyOf(third.record.lane), "tsk_6", undefined, 40)).rejects.toThrow("lane_busy");
    const abort = new AbortController();
    const aborted = r.lanes.acquire(laneKeyOf(third.record.lane), "tsk_6", abort.signal);
    abort.abort();
    await expect(aborted).rejects.toThrow();
    expect(await r.lanes.acquire("nothing", "tsk_7")).toBeNull();
  });

  it("begin never leaves a live process it replaces untracked: it stops its tasks and closes it", async () => {
    const r = registry();
    const old = r.begin("chat_a", "tsk_1");
    old.provider.change(snapshot("srv"));
    const replacement = r.begin("chat_a", "tsk_2");
    await waitFor(() => old.provider.closed === 1, "the replaced process closing");
    expect(old.provider.stops).toEqual([["srv", "remi"]]);
    expect(r.logs.some((line) => line.includes("parked_lane_conflict"))).toBe(true);
    expect(r.lanes.get(laneKeyOf(old.record.lane))).toBe(replacement.record);
    expect(replacement.provider.closed).toBe(0);
  });

  it("a release before spawning stops the tasks with its reason, closes, and keeps the resources for the caller", async () => {
    const r = registry();
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("bash-1"));
    await r.lanes.park(record);
    r.lanes.claim(laneKeyOf(record.lane), "tsk_2");
    await r.lanes.release(record, "config_changed", { keepResources: true });
    expect(provider.stops).toEqual([["bash-1", "remi"]]);
    expect(provider.closed).toBe(1);
    expect(r.disposals()).toBe(0);
    await waitFor(() => r.snapshots.some((payload) => payload.state === "closed"), "closed");
    expect(r.snapshots.find((payload) => payload.state === "closed")!.tasks[0]).toMatchObject({ stop_reason: "config_changed" });
  });

  it("the server's release closes a parked lane now, and an in-use one at its attempt's end", async () => {
    const r = registry();
    const parked = r.begin("chat_a", "tsk_1");
    parked.provider.change(snapshot("bash-1"));
    await r.lanes.park(parked.record);
    await r.lanes.handleRelease({ ...parked.record.lane, provider_session_id: "prov_other", reason: "lane_reset" });
    expect(parked.provider.closed).toBe(0);
    await r.lanes.handleRelease({ ...parked.record.lane, provider_session_id: "prov_chat_a", reason: "session_closed" });
    expect(parked.provider.closed).toBe(1);
    const busy = r.begin("chat_b", "tsk_2");
    await r.lanes.handleRelease({ ...busy.record.lane, provider_session_id: "prov_chat_b", reason: "lane_reset" });
    expect(busy.provider.closed).toBe(0);
    expect(r.lanes.canPark(busy.record)).toEqual({ park: false, reason: "lane_reset" });
  });

  it("a person's stop reaches the provider as `user`; `*` stops every running task", async () => {
    const r = registry();
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("a"));
    provider.change(snapshot("b"));
    provider.change(snapshot("c", "completed"));
    await r.lanes.park(record);
    await r.lanes.handleStop({ ...record.lane, task_id: "*", requested_at: new Date().toISOString() });
    expect(provider.stops).toEqual([["a", "user"], ["b", "user"]]);
    await waitFor(() => r.snapshots.at(-1)!.tasks.filter((task) => task.stop_reason === "user").length === 2, "the user stops reported");
  });

  it("the daemon's stop closes parked lanes with daemon_restart", async () => {
    const r = registry();
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("bash-1"));
    await r.lanes.park(record);
    await r.lanes.closeAll("daemon_restart");
    expect(provider.closed).toBe(1);
    await waitFor(() => r.snapshots.some((payload) => payload.state === "closed"), "closed");
    expect(r.snapshots.find((payload) => payload.state === "closed")!.tasks[0]).toMatchObject({ stop_reason: "daemon_restart" });
  });

  it("a process death while parked closes the lane with its tasks lost", async () => {
    const r = registry();
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("bash-1"));
    await r.lanes.park(record);
    provider.alive = false;
    r.lanes.onSessionLost("tsk_1", "exit code 1", [snapshot("bash-1")]);
    await waitFor(() => provider.closed === 1, "the close");
    expect(provider.stops).toEqual([]);
    await waitFor(() => r.snapshots.some((payload) => payload.state === "closed"), "closed");
    expect(r.snapshots.find((payload) => payload.state === "closed")!.tasks[0]).toMatchObject({ status: "stopped", stop_reason: "lost" });
  });
});

describe("ParkedLanes: the doorbell (§2.5)", () => {
  it("rings once for a parked Claude task that completed or failed; never for a stop, Codex or an attempt in progress", async () => {
    const r = registry();
    const claude = r.begin("chat_a", "tsk_1");
    claude.provider.change(snapshot("a"));
    claude.provider.change(snapshot("b"));
    claude.provider.change(snapshot("c"));
    // In an attempt: the attempt itself catches the end (no doorbell).
    claude.provider.change(snapshot("c", "completed"));
    await r.lanes.park(claude.record);
    claude.provider.change(snapshot("b", "stopped"));
    claude.provider.change(snapshot("a", "failed", { summary: "exit 1" }));
    claude.provider.change(snapshot("a", "failed", { summary: "exit 1" }));
    await waitFor(() => r.wakes.length === 1, "the doorbell");
    expect(r.wakes[0]).toMatchObject({ session_id: "chat_a", agent_id: "agt_1", execution_scope: "", provider_session_id: "prov_chat_a",
      task: { task_id: "a", name: "task a", task_type: "shell", status: "failed", origin_attempt_id: "tsk_1", summary: "exit 1" } });
    expect(claude.record.doorbell).toBe("sent");
    const codex = r.begin("chat_b", "tsk_2", { wakesModel: false });
    codex.provider.change(snapshot("t"));
    await r.lanes.park(codex.record);
    codex.provider.change(snapshot("t", "completed"));
    await Bun.sleep(20);
    expect(r.wakes).toHaveLength(1);
  });

  it("rings at park for a handed-off task that ended while its attempt was still finishing; not for one the attempt saw end", async () => {
    const r = registry({ idleCloseMs: 30 });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("seen"));
    provider.change(snapshot("late"));
    provider.change(snapshot("seen", "completed"));
    // The attempt decides to park with `late` running, then `late` ends before the lane is parked.
    r.lanes.handOff(record);
    provider.change(snapshot("late", "completed", { summary: "done" }));
    expect(r.wakes).toEqual([]);
    expect(await r.lanes.park(record)).toEqual({ parked: true });
    await waitFor(() => r.wakes.length === 1, "the doorbell");
    expect(r.wakes[0]!.task).toMatchObject({ task_id: "late", status: "completed", summary: "done" });
    expect(record.doorbell).toBe("sent");
    // The doorbell is out: the lane waits for its turn instead of closing as done.
    await Bun.sleep(80);
    expect(provider.closed).toBe(0);

    // The adopting attempt sees its own tasks end; only a new hand-off makes a later end ring at park.
    const claimed = r.lanes.claim(laneKeyOf(record.lane), "tsk_2")!;
    expect(r.lanes.adopt(claimed, "tsk_2", "tsk_2")).toBe(true);
    provider.change(snapshot("next"));
    provider.change(snapshot("other"));
    provider.change(snapshot("next", "completed"));
    await r.lanes.park(record);
    await Bun.sleep(30);
    expect(r.wakes).toHaveLength(1);
  });

  it("a rejected doorbell cancels the cycle and closes the lane (session_closed)", async () => {
    const r = registry({ wake: async () => { throw Object.assign(new Error("rejected"), { code: "session_closed" }); } });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("a"));
    await r.lanes.park(record);
    provider.change(snapshot("a", "completed"));
    await waitFor(() => provider.closed === 1, "the close");
    expect(provider.cancels).toBe(1);
    expect(r.logs.some((line) => line.includes("background_cycle_unattached"))).toBe(true);
  });
});

describe("ParkedLanes: requests raised while parked (R7)", () => {
  it("are held for an attempt to attach, then answered by its handler", async () => {
    const r = registry({ requestHoldMs: 2_000 });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("a"));
    await r.lanes.park(record);
    const answer = provider.permission!({ toolCall: { toolCallId: "toolu_w" } });
    await Bun.sleep(50);
    r.lanes.claim(laneKeyOf(record.lane), "tsk_2");
    r.lanes.adopt(record, "tsk_2", "tsk_2");
    r.lanes.handlerSink(record).setPermissionHandler!(async () => ({ outcome: "selected", optionId: "allow" }));
    expect(await answer).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("are cancelled when nothing attaches in time", async () => {
    const r = registry({ requestHoldMs: 100 });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("a"));
    r.lanes.handlerSink(record).setPermissionHandler!(async () => ({ outcome: "selected", optionId: "allow" }));
    await r.lanes.park(record);
    const started = Date.now();
    expect(await provider.permission!({ toolCall: { toolCallId: "toolu_w" } })).toEqual({ outcome: "cancelled" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

describe("ParkedLanes: snapshots (§5.2)", () => {
  it("debounces changes, needs the cap, and carries the stop request and output tail", async () => {
    const r = registry({ debounceMs: 30 });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("a"));
    provider.change(snapshot("a", "running", { summary: "half" }));
    await Bun.sleep(10);
    expect(r.snapshots).toEqual([]);
    await waitFor(() => r.snapshots.length === 1, "one debounced snapshot");
    expect(r.snapshots[0]).toMatchObject({ state: "in_attempt", attempt_id: "tsk_1", tasks: [expect.objectContaining({ summary: "half" })] });
    r.setShares(false);
    provider.change(snapshot("a", "paused"));
    await Bun.sleep(60);
    expect(r.snapshots).toHaveLength(1);
    void record;
  });

  it("flags an output file that exists but cannot be read (output_unreadable); a readable one carries its tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-pr6b-unreadable-"));
    dirs.push(dir);
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks", "readable.output"), "line 1\n");
    writeFileSync(join(dir, "secret.txt"), "secret");
    // A link where the output should be is there, but is never followed.
    symlinkSync(join(dir, "secret.txt"), join(dir, "tasks", "linked.output"));
    const r = registry({ outputTailer: new AsyncTaskOutputTailer({ platform: "darwin" }) });
    const { provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("readable", "running", { outputFilePath: join(dir, "tasks", "readable.output") }));
    provider.change(snapshot("linked", "running", { outputFilePath: join(dir, "tasks", "linked.output") }));
    provider.change(snapshot("missing", "running", { outputFilePath: join(dir, "tasks", "missing.output") }));
    const task = (id: string) => r.snapshots.at(-1)?.tasks.find((candidate) => candidate.task_id === id);
    await waitFor(() => task("readable")?.output_tail === "line 1\n" && task("linked")?.output_unreadable === true, "the tails");
    expect(task("linked")).toMatchObject({ output_tail: null, output_unreadable: true });
    expect("output_unreadable" in task("readable")!).toBe(false);
    expect("output_unreadable" in task("missing")!).toBe(false);
  });
});

describe("isBackgroundDoorbellMessage (§2.5)", () => {
  const doorbell = { background_task: { task_id: "bash-1", name: "sleep", task_type: "shell", status: "completed",
    origin_attempt_id: "tsk_1", origin_turn_id: null, provider_session_id: "prov_1" } };
  it("trusts the message's metadata whenever it has `background_task`, and reads the text only when it has not", () => {
    const byText = (value: boolean) => () => value;
    expect(isBackgroundDoorbellMessage(doorbell, byText(false))).toBe(true);
    // Present but malformed: no doorbell, whatever the text says.
    expect(isBackgroundDoorbellMessage({ background_task: { task_id: "bash-1" } }, byText(true))).toBe(false);
    expect(isBackgroundDoorbellMessage({ background_task: null }, byText(true))).toBe(false);
    // A projection without it (today's, metadata `{ execution_scope }`, or none): the text fallback decides.
    expect(isBackgroundDoorbellMessage({ execution_scope: "" }, byText(true))).toBe(true);
    expect(isBackgroundDoorbellMessage({ execution_scope: "" }, byText(false))).toBe(false);
    expect(isBackgroundDoorbellMessage(undefined, byText(true))).toBe(true);
    expect(isBackgroundDoorbellMessage(null, byText(false))).toBe(false);
  });
});

describe("ParkedLanes: crash sweep (R2)", () => {
  it("records parked process groups, and a restart kills those whose start time still matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-pr6b-parked-"));
    dirs.push(dir);
    const stateFile = join(dir, "parked-bridges.json");
    const r = registry({ stateFile, processStartTime: (pid) => pid === 4242 ? "Thu Oct 16 08:00:00 2026" : null });
    const { record, provider } = r.begin("chat_a", "tsk_1");
    provider.change(snapshot("a"));
    await r.lanes.park(record);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).bridges).toEqual([expect.objectContaining({ pgid: 4242,
      startTime: "Thu Oct 16 08:00:00 2026", lane: record.lane })]);

    const killed: number[] = [];
    const restarted = registry({ stateFile, killProcessGroup: (pgid) => killed.push(pgid),
      processStartTime: (pid) => pid === 4242 ? "Thu Oct 16 08:00:00 2026" : null });
    expect(restarted.lanes.sweepCrashedBridges()).toBe(1);
    expect(killed).toEqual([4242]);
    expect(existsSync(stateFile)).toBe(false);

    // A reused pid (another start time) is left alone.
    writeFileSync(stateFile, JSON.stringify({ version: 1, bridges: [{ pgid: 4242, startTime: "Wed Oct 15 08:00:00 2026" }] }));
    const reused: number[] = [];
    const again = registry({ stateFile, killProcessGroup: (pgid) => reused.push(pgid),
      processStartTime: () => "Thu Oct 16 08:00:00 2026" });
    expect(again.lanes.sweepCrashedBridges()).toBe(0);
    expect(reused).toEqual([]);
  });

  it("kills a real orphaned process group", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "claude-pr6b-parked-"));
    dirs.push(dir);
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" } as never);
    const startTime = processStartTime(child.pid);
    expect(startTime).toBeTruthy();
    const stateFile = join(dir, "parked-bridges.json");
    writeFileSync(stateFile, JSON.stringify({ version: 1, bridges: [{ pgid: child.pid, startTime }] }));
    const r = registry({ stateFile, processStartTime, killProcessGroup: (pgid) => process.kill(-pgid, "SIGKILL") });
    expect(r.lanes.sweepCrashedBridges()).toBe(1);
    expect(await child.exited).not.toBe(0);
  });

  it("REMI_MAX_PARKED_LANES parsing", () => {
    expect(resolveMaxParkedLanes(undefined)).toBe(4);
    expect(resolveMaxParkedLanes("0")).toBe(0);
    expect(resolveMaxParkedLanes(" 7 ")).toBe(7);
    expect(resolveMaxParkedLanes("-1")).toBe(4);
    expect(resolveMaxParkedLanes("two")).toBe(4);
  });
});

void (null as unknown as LaneRecord);
