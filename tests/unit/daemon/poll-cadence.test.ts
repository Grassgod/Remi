import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  DaemonWakeupSocket,
  daemonWakeupUrl,
  type DaemonWakeupSocketLike,
  type DaemonWakeupStatus,
  type DaemonWakeupTransport,
} from "../../../packages/server/src/worker/daemon-websocket.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

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
  client?: Record<string, unknown>;
  taskWakeup?: DaemonWakeupTransport | null;
  taskWakeupConnect?: (url: string, init: { headers: Record<string, string> }) => DaemonWakeupSocketLike;
  pluginDesiredRefreshMs?: number;
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
    runtimeModelRefreshTask: null,
    runtimeModelListRequests: new Map(),
    runtimeModelRetryWake: null,
    runtimeModelRefreshAbort: null,
    runtimeModelProbeAbort: null,
    runtimeModelRetryTimer: null,
    agentPluginReconcileAbort: null,
    gcTimer: null,
    gcInFlight: null,
    feishuConcierge: null,
    botMenuPublisher: null,
    terminalAuthorityCleanupRetryWake: null,
    claimIdleBaseMs: 3000,
    claimIdleMs: 3000,
    desiredFetchedAt: 0,
    lastDesiredRefreshAt: 0,
    lastDesired: null,
    // `once` runs stay on the legacy single-timer behavior.
    nextHeartbeatAt: 0,
    nextClaimAt: 0,
    waitWake: null,
    taskWakeup: options.taskWakeup ?? null,
    outboxPath: ":memory:",
    options: {
      once: options.once ?? false,
      pollIntervalMs: 20,
      maxConcurrency: 1,
      runtimeId: "rt_cadence",
      heartbeatIntervalMs: null,
      claimIdleMaxMs: 30_000,
      pluginDesiredRefreshMs: options.pluginDesiredRefreshMs ?? 30_000,
      taskWakeupEnabled: options.taskWakeupConnect !== undefined || options.taskWakeup !== undefined,
      taskWakeupConnect: options.taskWakeupConnect,
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
      close: async () => {},
    }),
    reconcilePendingOutboxTasks: async () => {},
    flushStartupOutbox: async () => {},
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

  probe.daemon = daemon;
  probe.run = daemon.start();
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

function track(probe: LoopProbe): LoopProbe {
  running.push(probe.stop);
  return probe;
}

describe("daemon poll cadence", () => {
  it("skips the desired GET while the ack revision is unchanged", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
    }));

    await flushMicrotasks();
    await advance(60_000);

    expect(probe.heartbeats).toBeGreaterThanOrEqual(5);
    // One GET for the first heartbeat; the rest reuse the cached revision.
    expect(probe.desiredGets).toBe(1);
    // The local reconcile still runs every heartbeat so retry deadlines land.
    expect(probe.reconciles).toBeGreaterThanOrEqual(probe.heartbeats);
  });

  it("re-fetches desired state when the ack revision moves", async () => {
    jest.useFakeTimers();
    let revision = "rev-1";
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision } }),
      desired: () => ({ runtime_id: "rt_cadence", revision, plugins: [] }),
    }));

    await flushMicrotasks();
    await advance(30_000);
    const initialGets = probe.desiredGets;
    expect(initialGets).toBe(1);

    revision = "rev-2";
    await advance(30_000);
    expect(probe.desiredGets).toBe(initialGets + 1);
  });

  it("keeps an old server on the fallback refresh and always refreshes every 10 minutes", async () => {
    jest.useFakeTimers();
    // No `agent_plugins` in the ack: a server from before PR-1.
    const probe = track(createLoopDaemon({
      ack: () => ({}),
      pluginDesiredRefreshMs: 30_000,
    }));

    await flushMicrotasks();
    // Five 30s windows: roughly one fallback GET per window (the boundary can
    // land on either side), never one per heartbeat.
    await advance(150_000);
    expect(probe.desiredGets).toBeGreaterThanOrEqual(4);
    expect(probe.desiredGets).toBeLessThanOrEqual(6);
    expect(probe.heartbeats).toBe(16);
    expect(probe.desiredGets).toBeLessThan(probe.heartbeats);
  });

  it("forces a refresh even when a matching revision never moves", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
    }));

    await flushMicrotasks();
    await advance(60_000);
    expect(probe.desiredGets).toBe(1);

    // The 10-minute bound exists for revision definitions that miss a field, so
    // a matching revision must not suppress it. 8 more minutes: still cached.
    await advance(8 * 60_000);
    expect(probe.desiredGets).toBe(1);

    await advance(2 * 60_000 + 30_000);
    expect(probe.desiredGets).toBe(2);
  });

  it("heartbeats every 10s, or every 3s while hosting the Feishu concierge", async () => {
    jest.useFakeTimers();
    const plain = track(createLoopDaemon({ ack: () => ({ agent_plugins: { revision: "rev-1" } }) }));
    await flushMicrotasks();
    await advance(60_000);
    expect((plain.daemon as unknown as { heartbeatIntervalMs(): number }).heartbeatIntervalMs()).toBe(10_000);
    expect(plain.heartbeats).toBe(7);

    const concierge = track(createLoopDaemon({ ack: () => ({ agent_plugins: { revision: "rev-1" } }) }));
    (concierge.daemon as unknown as { feishuConcierge: unknown }).feishuConcierge = { host: true };
    await flushMicrotasks();
    await advance(60_000);
    expect((concierge.daemon as unknown as { heartbeatIntervalMs(): number }).heartbeatIntervalMs()).toBe(3_000);
    // 3s cadence plus the immediate first heartbeat in the same window.
    expect(concierge.heartbeats).toBe(21);
  });

  it("backs idle claims off 3s -> 30s and caps there", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
    }));

    await flushMicrotasks();
    // Let the first (immediate) claim happen before measuring idle intervals.
    await advance(5);
    expect(probe.claimTimes.length).toBe(1);
    expect(probe.claimIdleLadder[0]).toBe(3000);

    // Collect the next eight idle attempts; the ladder must double then cap.
    const deltas: number[] = [];
    for (let round = 0; round < 8; round++) {
      const before = probe.claimTimes.length;
      await advanceToNextClaim(probe);
      deltas.push(probe.claimTimes.at(-1)! - probe.claimTimes[before - 1]!);
    }
    // The wait applied before attempt N is the ladder value observed on attempt N-1.
    expect(probe.claimIdleLadder.slice(0, 8)).toEqual([
      3000, 6000, 12_000, 24_000, 30_000, 30_000, 30_000, 30_000,
    ]);
    // And the claims really waited that long. The tolerance only absorbs the
    // timer tick that lands the first claim; the ladder above is exact.
    const expectedWaits = [3000, 6000, 12_000, 24_000, 30_000];
    for (const [index, expected] of expectedWaits.entries()) {
      expect(Math.abs(deltas[index]! - expected)).toBeLessThanOrEqual(10);
    }
    expect(Math.max(...deltas)).toBeLessThanOrEqual(30_010);
  }, 20_000);

  it("resets the idle backoff when a claim finally returns work", async () => {
    jest.useFakeTimers();
    let deliverTask = false;
    let handled = 0;
    let delivered = 0;
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
      // Exactly one task: the stub handleTask never consumes a concurrency slot,
      // so a stub that kept returning work would spin the pump forever.
      claims: () => {
        if (!deliverTask || delivered >= 1) return null;
        delivered++;
        return { id: "tsk_1", agentId: "agt_1", workspaceId: "local", prompt: "x" };
      },
    }));
    (probe.daemon as unknown as { handleTask: () => Promise<void> }).handleTask = async () => { handled++; };

    await flushMicrotasks();
    // Back off to the cap first so the reset is unambiguous.
    for (let round = 0; round < 6; round++) await advanceToNextClaim(probe);
    expect((probe.daemon as unknown as { claimIdleMs: number }).claimIdleMs).toBe(30_000);

    deliverTask = true;
    await advanceToNextClaim(probe);
    await flushMicrotasks();
    expect(handled).toBe(1);
    // Claiming work resets the ladder to the base interval.
    expect((probe.daemon as unknown as { claimIdleMs: number }).claimIdleMs).toBe(3000);
    expect(probe.claimIdleLadder.at(-1)).toBe(30_000);
  }, 20_000);

  it("resets the idle backoff when a daemon:task_available frame arrives", async () => {
    jest.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    const connects: Array<{ url: string; headers: Record<string, string> }> = [];
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
      taskWakeupConnect: (url, init) => {
        connects.push({ url, headers: init.headers });
        return {
          send: () => {},
          close: () => {},
          addEventListener: (type, listener) => { listeners.set(type, listener); },
        };
      },
    }));

    await flushMicrotasks();
    // The loop opens the real wake-up socket for the registered Runtime.
    expect(connects).toHaveLength(1);
    expect(connects[0]!.url).toContain("/api/daemon/ws?runtime_ids=rt_cadence");
    expect(connects[0]!.headers.Authorization).toBe("Bearer daemon-token");
    listeners.get("open")!({});

    // Back off to the 30s cap so the reset is unambiguous.
    await advance(5);
    for (let round = 0; round < 6; round++) await advanceToNextClaim(probe);
    const internal = probe.daemon as unknown as { claimIdleMs: number };
    expect(internal.claimIdleMs).toBe(30_000);

    const claimsBefore = probe.claimTimes.length;
    const queuedAt = Date.now();
    listeners.get("message")!({
      data: JSON.stringify({ type: "daemon:task_available", payload: { runtime_id: "rt_cadence", task_id: "tsk_1" } }),
    });
    await flushMicrotasks();
    // The frame interrupts the pending sleep: the claim runs now rather than
    // waiting out the remaining ~30s of backoff.
    await advance(20);
    expect(probe.claimTimes.length).toBe(claimsBefore + 1);
    expect(probe.claimTimes.at(-1)! - queuedAt).toBeLessThanOrEqual(1000);
    // And that claim waited the base interval, i.e. the ladder restarted.
    expect(probe.claimIdleLadder.at(-1)).toBe(3000);
  }, 20_000);

  it("resets the idle backoff when a slot frees, drain clears, or claims resume", async () => {
    jest.useFakeTimers();
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
    }));
    await flushMicrotasks();
    await advance(30_000);
    const internal = probe.daemon as unknown as {
      claimIdleMs: number;
      nextClaimAt: number;
      activeTaskCount: number;
      releaseActiveTaskSlot(): void;
      releaseLocalUpdateClaimPause(): void;
      claimsPaused: boolean;
    };

    // A finished task frees capacity, so a queued task may already be waiting.
    internal.activeTaskCount = 1;
    internal.claimIdleMs = 30_000;
    internal.releaseActiveTaskSlot();
    expect(internal.activeTaskCount).toBe(0);
    expect(internal.claimIdleMs).toBe(3000);
    expect(internal.nextClaimAt).toBeLessThanOrEqual(Date.now());

    // A released update pause resumes claims immediately.
    internal.claimIdleMs = 30_000;
    internal.claimsPaused = true;
    internal.releaseLocalUpdateClaimPause();
    expect(internal.claimIdleMs).toBe(3000);
    expect(internal.claimsPaused).toBe(false);

    // And a drain returning to normal does the same through the ack path.
    internal.claimIdleMs = 30_000;
    (probe.daemon as unknown as { serverDrainActive: boolean }).serverDrainActive = true;
    await (probe.daemon as unknown as {
      handleHeartbeatAck(runtimeId: string, ack: unknown): Promise<boolean>;
    }).handleHeartbeatAck("rt_cadence", { status: "ok", drain: { mode: "normal", generation: 2 } });
    expect(internal.claimIdleMs).toBe(3000);
  }, 20_000);
});

describe("daemon wake-up channel", () => {
  it("builds the websocket URL from the HTTP control-plane origin", () => {
    expect(daemonWakeupUrl("http://127.0.0.1:6120", "rt_1")).toBe(
      "ws://127.0.0.1:6120/api/daemon/ws?runtime_ids=rt_1",
    );
    expect(daemonWakeupUrl("https://remi.example/base/", "rt_2")).toBe(
      "wss://remi.example/base/api/daemon/ws?runtime_ids=rt_2",
    );
  });

  it("sends the daemon token as an Authorization header and wakes on task frames", async () => {
    const opened: Array<{ url: string; headers: Record<string, string> }> = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const socket: DaemonWakeupSocketLike = {
      send: () => {},
      close: () => {},
      addEventListener: (type, listener) => { listeners.set(type, listener); },
    };
    const wakes: number[] = [];
    const transport = new DaemonWakeupSocket({
      serverUrl: "https://remi.example",
      token: "daemon-secret",
      onTaskAvailable: () => wakes.push(Date.now()),
      connect: (url, init) => {
        opened.push({ url, headers: init.headers });
        return socket;
      },
      pingIntervalMs: 30_000,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
    });
    transport.setRuntimeId("rt_1");
    listeners.get("open")!({});
    expect(opened[0]!.url).toBe("wss://remi.example/api/daemon/ws?runtime_ids=rt_1");
    expect(opened[0]!.headers.Authorization).toBe("Bearer daemon-secret");
    expect(transport.status()).toMatchObject({ state: "connected", connected: true });

    listeners.get("message")!({ data: JSON.stringify({ type: "ready", runtime_id: "rt_1" }) });
    expect(wakes).toHaveLength(0);
    listeners.get("message")!({ data: JSON.stringify({ type: "daemon:task_available", payload: { task_id: "tsk_1" } }) });
    expect(wakes).toHaveLength(1);
    // Frames the daemon does not own must not wake the claim lane.
    listeners.get("message")!({ data: JSON.stringify({ type: "pong" }) });
    expect(wakes).toHaveLength(1);
    transport.close();
  });

  it("reports a disconnected state with a reconnect deadline and warning when the socket fails", async () => {
    const warnings: string[] = [];
    const transport = new DaemonWakeupSocket({
      serverUrl: "https://remi.example",
      token: "daemon-secret",
      onTaskAvailable: () => { throw new Error("must not fire"); },
      connect: () => { throw new Error("Expected 101 status code"); },
      log: { info: () => {}, warn: (message) => warnings.push(message) },
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
    });
    transport.setRuntimeId("rt_1");
    expect(transport.status()).toMatchObject({
      state: "disconnected",
      connected: false,
      last_error: "Expected 101 status code",
      reconnect_attempts: 1,
    });
    expect(transport.status().next_reconnect_at).not.toBeNull();
    expect(warnings[0]).toContain("claims degrade to polling with up to 30s latency");
    transport.close();
    expect(transport.status()).toMatchObject({ state: "disabled", connected: false });
  });

  it("keeps the claim backoff running when the wake-up channel is unavailable", async () => {
    jest.useFakeTimers();
    // A real socket that cannot connect: the frame the control plane publishes
    // never arrives, so only the backoff can deliver the queued task.
    const transport = new DaemonWakeupSocket({
      serverUrl: "http://127.0.0.1:1",
      token: "daemon-token",
      onTaskAvailable: () => { throw new Error("no frame can arrive on a dead socket"); },
      connect: () => { throw new Error("Expected 101 status code"); },
      log: { info: () => {}, warn: () => {} },
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
    });
    const probe = track(createLoopDaemon({
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
      taskWakeup: transport,
    }));

    await flushMicrotasks();
    expect(transport.status().state).toBe("disconnected");
    await advance(10 * 60_000);

    // Polling is unaffected: claims still happen on the backoff schedule.
    expect(probe.claims).toBeGreaterThanOrEqual(5);
    expect(probe.heartbeats).toBeGreaterThanOrEqual(20);

    const health = (probe.daemon as unknown as { handleHealthRequest(request: Request): Response })
      .handleHealthRequest(new Request("http://127.0.0.1/health"));
    const body = await health.json() as Record<string, unknown>;
    // A blocked Upgrade path must be visible in the status JSON, including the
    // reconnect deadline, so nobody has to guess why claims are up to 30s late.
    expect(body.claim_wake_ws).toMatchObject({
      state: "disconnected",
      connected: false,
      last_error: "Expected 101 status code",
    });
    expect(Number((body.claim_wake_ws as { reconnect_attempts: number }).reconnect_attempts))
      .toBeGreaterThanOrEqual(1);
    expect((body.claim_wake_ws as { next_reconnect_at: string | null }).next_reconnect_at).not.toBeNull();
  }, 20_000);

  it("keeps once mode strictly serial", async () => {
    jest.useFakeTimers();
    let connects = 0;
    const probe = track(createLoopDaemon({
      once: true,
      ack: () => ({ agent_plugins: { revision: "rev-1" } }),
      client: { handleTask: async () => {} },
      taskWakeupConnect: () => {
        connects++;
        return { send: () => {}, close: () => {}, addEventListener: () => {} };
      },
    }));
    (probe.daemon as unknown as { handleTask: () => Promise<void> }).handleTask = async () => {};

    await flushMicrotasks();
    await probe.run;
    // One heartbeat, one claim, then return — no backoff and no idle loop.
    expect(probe.heartbeats).toBe(1);
    expect(probe.claims).toBe(1);
    // A one-shot run never dials the wake-up socket.
    expect(connects).toBe(0);
    expect(probe.daemon.taskWakeupStatus()).toBeNull();
  });
});
