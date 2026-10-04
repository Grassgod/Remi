import { afterEach, describe, expect, it, jest } from "bun:test";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { DaemonProtocolClient, type DaemonProtocolLane } from "@multiremi/worker/daemon-protocol-client.js";
import { DaemonTaskDownlinks } from "@multiremi/worker/daemon-downlinks.js";
import { registerDaemonRuntimeDownlinks } from "@multiremi/worker/daemon-runtime-downlinks.js";
import type { FeishuBotRuntimeState } from "@multiremi/contracts/types.js";

interface LoopProbe {
  daemon: MultiremiDaemon & Record<string, unknown>;
  heartbeats: number;
  claims: number;
  desiredGets: number;
  claimTimes: number[];
  /** `claimIdleMs` as observed at each claim, i.e. the ladder the loop applied. */
  claimIdleLadder: number[];
  reconciles: number;
  run: Promise<void>;
  push(type: string, payload: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Drive the real `start()` poll loop with fake timers.
 *
 * Everything outside the loop (registration, outbox, repo server, plugin
 * reconciler) is stubbed so the test can assert the timers, the desired-state
 * GET decision and the wake-up wiring — the three things this change owns.
 */
function createLoopDaemon(options: {
  body?: (state: { heartbeats: number; claims: number; desiredGets: number }) => Promise<unknown> | unknown;
  ack?: (state: { heartbeats: number; claims: number; desiredGets: number }) => unknown;
  desired?: (state: { heartbeats: number; claims: number; desiredGets: number }) => unknown;
  claims?: (state: { heartbeats: number; claims: number; desiredGets: number }) => unknown;
  once?: boolean;
  startLoop?: boolean;
  client?: Record<string, unknown>;
  pluginDesiredRefreshMs?: number;
  /**
   * The concierge supervisor. `hostAttached` is what `setFeishuConciergeHost()`
   * installs (every long-running daemon gets one); `state` is what the control
   * plane actually assigned, which is the distinction the cadence turns on.
   */
  concierge?: { state: FeishuBotRuntimeState } | null;
} = {}): LoopProbe {
  const state = { heartbeats: 0, claims: 0, desiredGets: 0 };
  const probe: LoopProbe = {
    daemon: null as unknown as MultiremiDaemon & Record<string, unknown>,
    heartbeats: 0,
    claims: 0,
    desiredGets: 0,
    claimTimes: [],
    claimIdleLadder: [],
    reconciles: 0,
    run: Promise.resolve(),
    push: async () => {},
    stop: async () => {},
  };

  const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
  Object.assign(daemon, {
    stopped: false,
    ready: false,
    startedAt: new Date(),
    pollAbort: new AbortController(),
    activeTaskCount: 0,
    activeTaskIds: new Set<string>(),
    activeTaskAborts: new Set<AbortController>(),
    inflight: new Set<Promise<void>>(),
    feishuOutboundRuns: new Map(),
    claimsPaused: false,
    serverDrainActive: false,
    appliedDrainGeneration: 0,
    terminalAuthorityMode: false,
    terminalAuthorityCleanupAttempts: 0,
    authorityProbeAttempts: 0,
    authorityProbeNextAt: null,
    authorityProbeTask: null,
    authorityProbeWake: null,
    authorityProbeDelaysMs: [1000],
    restartRequestedFlag: false,
    workspaceOwnershipLost: false,
    runtimeRegistrationGeneration: 0,
    runtimeGoneInflight: new Set<string>(),
    runtimeCodexProfile: null,
    runtimeClaudeProfile: null,
    runtimeModelRefreshTask: null,
    runtimeModelListRequests: new Map(),
    runtimeModelRetryWake: null,
    runtimeModelRefreshAbort: null,
    runtimeModelProbeAbort: null,
    runtimeModelRetryTimer: null,
    agentPluginReconcileAbort: null,
    gcTimer: null,
    gcInFlight: null,
    feishuConcierge: conciergeStub(options.concierge),
    botMenuPublisher: null,
    terminalAuthorityCleanupRetryWake: null,
    claimIdleBaseMs: 3000,
    claimIdleMs: 3000,
    desiredFetchedAt: 0,
    lastDesiredRefreshAt: 0,
    lastDesired: null,
    nextPluginDesiredAt: 0,
    nextClaimAt: 0,
    waitWake: null,
    protocolClient: {
      startLane: () => {}, stopLane: () => {}, drain: async () => {},
      allowsClaims: () => true,
    },
    outboxPath: ":memory:",
    options: {
      once: options.once ?? false,
      pollIntervalMs: 20,
      maxConcurrency: 1,
      runtimeId: "rt_cadence",
      claimIdleMaxMs: 30_000,
      pluginDesiredRefreshMs: options.pluginDesiredRefreshMs ?? 30_000,
      serverUrl: "http://127.0.0.1:1",
      token: "daemon-token",
      taskDrainTimeoutMs: 50,
      supervisorReady: true,
    },
    workspaceRootFence: null,
    sshMeshManager: {
      getHeartbeatStatus: () => ({ status: "disabled" }),
      reconcile: async () => {},
      cleanupForRetirement: async () => {},
    },
    supervisorReady: () => true,
    onReadyChange: () => {},
    startRepoCheckoutServer: () => {},
    stopRepoCheckoutServer: () => {},
    startGcLoop: () => {},
    stopGcLoop: () => {},
    cancelRuntimeModelRefresh: () => {},
    drainGcInFlight: async () => {},
    startRuntimeModelRefresh: () => {},
    assertWorkspaceRootOwner: () => {},
    registerCurrentRuntime: async () => "rt_cadence",
    refreshWorkspaceRepos: async () => {},
    ensureOutbox: (_options?: unknown) => ({
      stats: () => null,
      taskIdsWithPendingTerminal: () => [],
      pendingTaskIds: () => [],
      pumpAll: () => {},
      close: async () => {},
    }),
    ensureTrace: () => ({ track: () => {}, completion: () => ({}), close: () => {} }),
    awaitTaskReportDrain: async () => ({ delivered: 0, pending: 0, failed: false }),
    cleanupTaskPrivateTempDirectory: async () => {},
    stopRepoCheckoutServerFn: () => {},
    finalizeTaskProgress: () => {},
    agentPluginReconciler: {
      reconcile: async () => {
        probe.reconciles++;
        return [];
      },
      restoreStates: () => {},
      syncReportedStates: () => {},
      clearReportedStates: () => {},
      getStates: () => [],
      retryNow: async () => [],
    },
    client: {
      recoverOrphans: async () => {},
      heartbeatRuntime: async () => {
        state.heartbeats++;
        probe.heartbeats++;
        return options.ack ? options.ack(state) : {};
      },
      getRuntimeAgentPluginDesired: async () => {
        state.desiredGets++;
        probe.desiredGets++;
        return options.desired?.(state) ?? { runtime_id: "rt_cadence", revision: "rev-1", plugins: [] };
      },
      claimTask: async () => {
        state.claims++;
        probe.claims++;
        probe.claimTimes.push(Date.now());
        probe.claimIdleLadder.push((daemon as unknown as { claimIdleMs: number }).claimIdleMs);
        return options.claims?.(state) ?? null;
      },
      ...options.client,
    },
  });

  let sequence = 0;
  let push!: (type: string, payload: Record<string, unknown>) => void;
  const protocolClient = new DaemonProtocolClient({ serverUrl: "http://127.0.0.1:1", daemonId: "cadence", cliVersion: "0.2.83",
    connect: () => {
      const listeners = new Map<string, Set<(event: any) => void>>();
      const emit = (type: string, event: any) => { for (const listener of listeners.get(type) ?? []) listener(event); };
      push = (type, payload) => emit("message", { data: JSON.stringify({ v: 2, t: type, seq: ++sequence, rt: "rt_cadence", p: payload }) });
      queueMicrotask(() => {
        emit("open", {});
        emit("message", { data: JSON.stringify({ v: 2, t: "welcome", p: { protocol: 2, min_cli_version: "0.2.86", session_id: "cadence" } }) });
        if (options.startLoop !== false) push("plugin.desired_revision", { revision: "rev-1" });
      });
      return {
        bufferedAmount: 0,
        send(text: string) {
          const frame = JSON.parse(text);
          if (!frame.id) return;
          const payload = frame.t === "plugin.desired" ? (() => {
            state.desiredGets++; probe.desiredGets++;
            return options.desired?.(state) ?? { runtime_id: "rt_cadence", revision: "rev-1", plugins: [] };
          })() : { runtime_acks: [{ runtime_id: "rt_cadence", status: "ok" }] };
          queueMicrotask(() => emit("message", { data: JSON.stringify({ v: 2, t: "res", re: frame.id, p: { ok: true, ...payload as object } }) }));
        },
        close() {},
        addEventListener(type: string, listener: (event: any) => void) {
          if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener);
        },
        removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener); },
      };
    } });
  const taskDownlinks = new DaemonTaskDownlinks(protocolClient, () => "rt_cadence");
  const input = daemon as unknown as {
    handleHeartbeatAck(rt: string, input: Record<string, unknown>): Promise<boolean>;
    reconcileRuntimeAgentPlugins(rt: string, revision: string): Promise<void>;
  };
  const drainRuntimeDownlinks = registerDaemonRuntimeDownlinks(protocolClient, () => "rt_cadence", (rt, ack) => input.handleHeartbeatAck(rt, ack as unknown as Record<string, unknown>),
    (rt, revision) => input.reconcileRuntimeAgentPlugins(rt, revision));
  const lane: DaemonProtocolLane = {
    runtime: () => ({ runtime_id: "rt_cadence", provider: "claude", max_concurrency: 1, active_task_ids: [] }),
    heartbeat: () => ({ active_task_count: 0 }), onHeartbeatAck: async () => {},
    probeUpgrade: async () => {}, onTerminal: async () => {}, onStateChange: () => taskDownlinks.connectionChanged(),
  };
  Object.assign(daemon, { protocolClient, protocolLane: lane, taskDownlinks, drainRuntimeDownlinks });
  protocolClient.addLane(lane); protocolClient.startLane(lane);
  probe.push = async (type, payload) => { await flushMicrotasks(); push(type, payload); await protocolClient.drain(); };

  probe.daemon = daemon;
  probe.run = options.startLoop === false ? Promise.resolve() : daemon.start();
  probe.stop = async () => {
    daemon.stop();
    await probe.run.catch(() => {});
  };
  return probe;
}

/**
 * Advance fake time and drain the microtasks the poll loop awaits in between.
 *
 * Deliberately no `setSystemTime`: in Bun 1.3.14 the fake clock does not survive
 * a timer fire, so the loop would compute its next deadlines against a different
 * base. The cadence itself is relative, so the tests assert intervals instead.
 */
async function advance(ms: number, stepMs = 250): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    jest.advanceTimersByTime(Math.min(stepMs, ms - elapsed));
    await flushMicrotasks();
  }
}

/**
 * Advance to the next scheduled claim, then settle the loop.
 *
 * Sampling in fixed steps would quantize the measured backoff to the step size,
 * and the whole point of the assertion is the exact 3→6→12→24→30s ladder.
 */
async function advanceToNextClaim(probe: LoopProbe): Promise<void> {
  const seen = probe.claimTimes.length;
  const internal = probe.daemon as unknown as { nextClaimAt: number };
  const deadline = internal.nextClaimAt;
  let guard = 0;
  while (probe.claimTimes.length === seen && guard++ < 4000) {
    const delay = Math.max(1, deadline - Date.now());
    jest.advanceTimersByTime(delay);
    void delay;
    await flushMicrotasks();
  }
  expect(probe.claimTimes.length).toBeGreaterThan(seen);
}

async function flushMicrotasks(times = 12): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
  jest.useRealTimers();
});

/**
 * Minimal stand-in for `FeishuConciergeSupervisor`: the cadence reads
 * `snapshot().state`, and the test mutates `state` to simulate a handover.
 */
function conciergeStub(state: { state: FeishuBotRuntimeState } | null | undefined) {
  if (!state) return null;
  return { snapshot: () => ({ state: state.state, appliedRevision: 0, botName: null }) };
}

function track(probe: LoopProbe): LoopProbe {
  running.push(probe.stop);
  return probe;
}

describe("daemon poll cadence", () => {
  it("skips the desired RPC snapshot while the pushed revision is unchanged", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({ startLoop: false }));
    for (let round = 0; round <= 6; round++) {
      jest.setSystemTime(1_000_000 + round * 10_000);
      await probe.push("plugin.desired_revision", { revision: "rev-1" });
    }
    expect(probe.desiredGets).toBe(1);
    expect(probe.reconciles).toBeGreaterThanOrEqual(7);
  });

  it("re-fetches desired state and drops the report baseline after a re-registration", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({ startLoop: false }));
    jest.setSystemTime(1_000_000);
    await probe.push("plugin.desired_revision", { revision: "rev-1" });
    const internal = probe.daemon as unknown as {
      lastDesired: unknown; desiredFetchedAt: number; lastDesiredRefreshAt: number;
      agentPluginReconciler: { clearReportedStates(): void }; clearDesiredAgentPlugins(): void;
    };
    expect(probe.desiredGets).toBe(1);
    expect(internal.lastDesired).not.toBeNull();
    let cleared = 0;
    const originalClear = internal.agentPluginReconciler.clearReportedStates.bind(internal.agentPluginReconciler);
    internal.agentPluginReconciler.clearReportedStates = () => { cleared++; originalClear(); };
    internal.clearDesiredAgentPlugins();
    expect(internal.lastDesired).toBeNull();
    expect(internal.desiredFetchedAt).toBe(0);
    expect(internal.lastDesiredRefreshAt).toBe(0);
    expect(cleared).toBe(1);
    jest.setSystemTime(1_030_000);
    await probe.push("plugin.desired_revision", { revision: "rev-1" });
    expect(probe.desiredGets).toBe(2);
  }, 20_000);

  it("re-fetches desired state when the pushed revision moves", async () => {
    jest.useFakeTimers();
    let revision = "rev-1";
    const probe = track(createLoopDaemon({ startLoop: false, desired: () => ({ runtime_id: "rt_cadence", revision, plugins: [] }) }));
    await probe.push("plugin.desired_revision", { revision });
    const initialGets = probe.desiredGets;
    expect(initialGets).toBe(1);
    revision = "rev-2";
    await probe.push("plugin.desired_revision", { revision });
    expect(probe.desiredGets).toBe(initialGets + 1);
  });

  it("does not run a 30s desired fallback when unrelated frames arrive", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({ startLoop: false, pluginDesiredRefreshMs: 30_000 }));
    await probe.push("plugin.desired_revision", { revision: "rev-1" });
    for (let round = 0; round <= 15; round++) {
      jest.setSystemTime(1_000_000 + round * 10_000);
      await probe.push("workspace.settings", { settings: {} });
    }
    expect(probe.desiredGets).toBe(1);
    expect(probe.desiredGets).toBeLessThan(16);
  });

  it("forces a refresh even when a matching revision never moves", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({ startLoop: false }));
    for (const offset of [0, 60_000, 9 * 60_000, 11 * 60_000 + 30_000]) {
      jest.setSystemTime(1_000_000 + offset);
      await probe.push("plugin.desired_revision", { revision: "rev-1" });
      if (offset <= 9 * 60_000) expect(probe.desiredGets).toBe(1);
    }
    expect(probe.desiredGets).toBe(2);
  });

  it("keeps HTTP heartbeat and the 30s desired fallback out of the main loop", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon());
    await flushMicrotasks();
    await advance(180_000);
    expect(probe.heartbeats).toBe(0);
    expect(probe.desiredGets).toBe(1);
  });

  it("keeps once mode free of HTTP claims and heartbeats", async () => {
    const probe = track(createLoopDaemon({ once: true }));
    await flushMicrotasks();
    await probe.stop();
    expect(probe.claims).toBe(0);
    expect(probe.heartbeats).toBe(0);
  });

  it("never runs an idle HTTP claim pump, even after ten minutes", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon());
    await flushMicrotasks();
    await advance(10 * 60_000);
    expect(probe.claims).toBe(0);
    expect(probe.claimTimes).toEqual([]);
    expect(probe.heartbeats).toBe(0);
    expect(probe.desiredGets).toBe(2);
  }, 20_000);

  it("does not spin the poll loop while claims are paused or draining", async () => {
    jest.useFakeTimers();
    let loops = 0;
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
    }));
    // Count poll iterations independently of heartbeats: a suppressed claim lane
    // that leaves an already-due deadline would run this flat out.
    const internal = probe.daemon as unknown as {
      claimsPaused: boolean;
      serverDrainActive: boolean;
      waitForNextTick(): Promise<void>;
    };
    const originalWait = internal.waitForNextTick.bind(probe.daemon);
    internal.waitForNextTick = async () => { loops++; await originalWait(); };

    await flushMicrotasks();
    // The loop is live (one immediate claim) before the pause is applied.
    const claimsBeforePause = probe.claims;
    internal.claimsPaused = true;
    await advance(60_000);
    const pausedLoops = loops;
    // Paused: bounded by the 10s heartbeat cadence, not a tight loop. Before
    // the claim deadline moved with the suppression this was ~230 iterations.
    expect(pausedLoops).toBeLessThanOrEqual(10);

    internal.claimsPaused = false;
    internal.serverDrainActive = true;
    const beforeDrain = loops;
    await advance(60_000);
    expect(loops - beforeDrain).toBeLessThanOrEqual(10);

    // No claim was attempted while either suppression was active.
    expect(probe.claims).toBe(claimsBeforePause);
  }, 20_000);

  it("does not consume work from the removed HTTP claim path", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({ claims: () => ({ id: "tsk_legacy", prompt: "legacy" }) }));
    let handled = 0;
    (probe.daemon as unknown as { handleTask(): Promise<void> }).handleTask = async () => { handled++; };
    await flushMicrotasks();
    await advance(10 * 60_000);
    expect(probe.claims).toBe(0);
    expect(handled).toBe(0);
  }, 20_000);

  it("wakes on slot release, update pause release and drain release without HTTP claims", async () => {
    const probe = track(createLoopDaemon({ startLoop: false }));
    const internal = probe.daemon as unknown as {
      activeTaskCount: number; claimsPaused: boolean; serverDrainActive: boolean;
      waitWake(): void; releaseActiveTaskSlot(): void; releaseLocalUpdateClaimPause(): void;
    };
    let wakes = 0;
    internal.waitWake = () => { wakes++; };
    internal.activeTaskCount = 1;
    internal.releaseActiveTaskSlot();
    expect(internal.activeTaskCount).toBe(0);
    expect(wakes).toBe(1);
    internal.claimsPaused = true;
    internal.releaseLocalUpdateClaimPause();
    expect(internal.claimsPaused).toBe(false);
    expect(wakes).toBe(2);
    internal.serverDrainActive = true;
    await probe.push("platform.drain", { mode: "normal", generation: 2 });
    expect(internal.serverDrainActive).toBe(false);
    expect(internal.claimsPaused).toBe(false);
    expect(wakes).toBeGreaterThanOrEqual(3);
    expect(probe.claims).toBe(0);
  });

  it("a drain-release input wakes the loop immediately without restarting HTTP claims", async () => {
    const probe = track(createLoopDaemon({ startLoop: false }));
    const internal = probe.daemon as unknown as { serverDrainActive: boolean; waitWake(): void };
    internal.serverDrainActive = true;
    let wokeAt: number | null = null;
    internal.waitWake = () => { wokeAt = Date.now(); };
    const queuedAt = Date.now();
    await probe.push("platform.drain", { mode: "normal", generation: 2 });
    expect(wokeAt).not.toBeNull();
    expect(wokeAt! - queuedAt).toBeLessThanOrEqual(1000);
    expect(internal.serverDrainActive).toBe(false);
    expect(probe.claims).toBe(0);
  });

  it("never falls back to HTTP claim while the protocol channel is unavailable", async () => {
    jest.useFakeTimers();
    const client = new DaemonProtocolClient({
      serverUrl: "http://127.0.0.1:1", daemonId: "offline", cliVersion: "0.2.83",
      connect: () => { throw new Error("Expected 101 status code"); },
    });
    const lane: DaemonProtocolLane = {
      runtime: () => ({ runtime_id: "rt_cadence", provider: "claude", max_concurrency: 1, active_task_ids: [] }),
      heartbeat: () => ({ active_task_count: 0 }), onHeartbeatAck: async () => {},
      probeUpgrade: async () => {}, onTerminal: async () => {},
    };
    client.addLane(lane);
    client.startLane(lane);
    running.push(async () => { client.close(); await client.drain(); });
    const probe = track(createLoopDaemon());
    (probe.daemon as unknown as { protocolClient: { allowsClaims(): boolean } }).protocolClient.allowsClaims = () => client.allowsClaims();
    await flushMicrotasks();
    expect(client.connectionState()).toBe("disconnected");
    await advance(10 * 60_000);
    expect(probe.claims).toBe(0);
    expect(probe.heartbeats).toBe(0);
    expect(client.health().state).toBe("disconnected");
    expect(client.diagnostics().timers).toBe(1);
  }, 20_000);
});
