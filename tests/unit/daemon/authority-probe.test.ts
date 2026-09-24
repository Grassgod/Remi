import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiDaemonHttpError } from "@multiremi/client.js";

interface ProbeBed {
  daemon: MultiremiDaemon & Record<string, unknown>;
  registerTimes: number[];
  stopCalls: () => number;
}

/**
 * Drive `stopAfterTerminalAuthority()` on a real daemon instance with only the
 * process-external effects stubbed (register, SSH Mesh, local HTTP server).
 *
 * `registerCurrentRuntime` is the single probe call the design allows, so
 * counting it *is* measuring the schedule.
 */
function createProbeDaemon(options: {
  once?: boolean;
  authorityProbeDelaysMs?: number[];
  register?: (attempt: number) => Promise<void>;
} = {}): ProbeBed {
  const registerTimes: number[] = [];
  let stopCalls = 0;
  const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
  const register = options.register ?? (async () => {
    // Default: the control plane still rejects this daemon, i.e. the state the
    // old code responded to by exiting.
    throw new MultiremiDaemonHttpError(401, "POST", "/api/daemon/register", '{"error":"unauthorized"}', null);
  });
  Object.assign(daemon, {
    stopped: false,
    ready: false,
    startedAt: new Date(),
    pollAbort: new AbortController(),
    claimsPaused: false,
    serverDrainActive: false,
    terminalAuthorityMode: false,
    terminalAuthorityCleanupAttempts: 0,
    authorityProbeAttempts: 0,
    authorityProbeNextAt: null,
    authorityProbeTask: null,
    authorityProbeWake: null,
    authorityProbeDelaysMs: options.authorityProbeDelaysMs ?? [30_000, 60_000, 120_000, 240_000, 480_000, 900_000],
    restartRequestedFlag: false,
    activeTaskAborts: new Set<AbortController>(),
    agentPluginReconcileAbort: null,
    terminalAuthorityCleanup: null,
    terminalAuthorityCleanupRetryWake: null,
    terminalAuthorityCleanupRetryDelaysMs: [10],
    gcTimer: null,
    gcInFlight: null,
    runtimeModelRefreshAbort: null,
    runtimeModelRetryWake: null,
    runtimeModelRetryTimer: null,
    runtimeModelListRequests: new Map(),
    workspaceOwnershipLost: false,
    waitWake: null,
    taskWakeup: null,
    onRestartRequested: null,
    supervisorReady: () => true,
    onReadyChange: () => {},
    repoServerPort: 0,
    workspaceId: null,
    runtimeName: "probe-runtime",
    serverUrl: "http://127.0.0.1:1",
    outboxStats: () => null,
    drainingTaskCount: 0,
    activeTaskCount: 0,
    nextClaimAt: 0,
    options: {
      once: options.once ?? false,
      runtimeId: "rt_probe",
      provider: "claude",
      pollIntervalMs: 10,
    },
    sshMeshManager: {
      getHeartbeatStatus: () => ({ status: "disabled" }),
      reconcile: async () => {},
      cleanupForRetirement: async () => {},
    },
    stopGcLoop: () => {},
    cancelRuntimeModelRefresh: () => {},
    startRepoCheckoutServer: () => {},
    stopRepoCheckoutServer: () => {},
    registerCurrentRuntime: async () => {
      // Record before the call: a rejected probe is the case being measured.
      registerTimes.push(Date.now());
      await register(registerTimes.length);
      return "rt_probe";
    },
    // Mirrors the real `stop()` for the fields this path touches: most
    // importantly it wakes the probe sleeper, which is what makes SIGTERM
    // immediate rather than "wait out the remaining interval".
    stop: () => {
      stopCalls++;
      const internal = daemon as unknown as {
        stopped: boolean;
        pollAbort: AbortController;
        authorityProbeWake: (() => void) | null;
        terminalAuthorityCleanupRetryWake: (() => void) | null;
        waitWake: (() => void) | null;
      };
      internal.stopped = true;
      internal.pollAbort.abort();
      internal.terminalAuthorityCleanupRetryWake?.();
      internal.authorityProbeWake?.();
      internal.waitWake?.();
    },
  });

  return { daemon, registerTimes, stopCalls: () => stopCalls };
}

/**
 * Collect the daemon's WARN and ERROR output.
 *
 * The daemon's logger is module-private and writes through `console`, so the
 * console sinks are the only place a test can observe a line's level.
 */
function captureLogger() {
  const calls: { level: string; message: string }[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation(((message: unknown) => {
    calls.push({ level: "error", message: String(message) });
  }) as never);
  const warnSpy = spyOn(console, "warn").mockImplementation(((message: unknown) => {
    calls.push({ level: "warn", message: String(message) });
  }) as never);
  return { calls, restore: () => { errorSpy.mockRestore(); warnSpy.mockRestore(); } };
}

/** Start the terminal path and let the cleanup finish so the probe is running. */
async function startProbe(bed: ProbeBed): Promise<{ pending: Promise<void>; settled: () => boolean }> {
  let done = false;
  const pending = (bed.daemon as unknown as { stopAfterTerminalAuthority(): Promise<void> })
    .stopAfterTerminalAuthority()
    .finally(() => { done = true; });
  // Cleanup + setup run on microtasks; the probe itself starts on a timer.
  for (let index = 0; index < 8; index++) await Promise.resolve();
  return { pending, settled: () => done };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("daemon terminal-authority keep-alive probe", () => {
  it("keeps probing on the widening schedule instead of exiting, and caps at 15 minutes", async () => {
    jest.useFakeTimers();
    const logger = captureLogger();
    const bed = createProbeDaemon();
    try {
      const { pending, settled } = await startProbe(bed);
      let resolved = false;
      void pending.then(() => { resolved = true; });

      // The first probe waits 30s; later intervals are the differences below.
      const firstProbeAt = (bed.daemon as unknown as { authorityProbeNextAt: string | null }).authorityProbeNextAt;
      expect(Date.parse(String(firstProbeAt)) - Date.now()).toBe(30_000);
      expect(bed.registerTimes.length).toBe(0);

      // Walk far past the cap: the daemon must still be parked, not exited.
      for (let round = 0; round < 8; round++) {
        jest.advanceTimersByTime(15 * 60_000);
        for (let index = 0; index < 8; index++) await Promise.resolve();
      }

      expect(settled()).toBe(false);
      expect(resolved).toBe(false);
      expect(bed.stopCalls()).toBe(0);
      expect(bed.registerTimes.length).toBeGreaterThanOrEqual(8);

      // Intervals between probes: 30s → 1m → 2m → 4m → 8m → 15m, then the cap.
      const schedule = bed.registerTimes.slice(1)
        .map((stamp, index) => stamp - bed.registerTimes[index]!);
      expect(schedule.slice(0, 5)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000]);
      for (const delay of schedule.slice(4)) expect(delay).toBe(900_000);

      // One register per interval, and nothing else: that is the whole probe.
      const internal = bed.daemon as unknown as { authorityProbeAttempts: number };
      expect(internal.authorityProbeAttempts).toBeGreaterThanOrEqual(bed.registerTimes.length);
      expect(internal.authorityProbeAttempts).toBeLessThanOrEqual(bed.registerTimes.length + 1);

      bed.daemon.stop();
      await pending;
    } finally {
      logger.restore();
    }
  }, 20_000);

  it("reports the probe schedule in the daemon status JSON", async () => {
    jest.useFakeTimers();
    const logger = captureLogger();
    // A long first interval keeps the assertions about the published schedule
    // rather than racing the probe itself.
    const bed = createProbeDaemon({ authorityProbeDelaysMs: [120_000, 240_000] });
    const health = async () => (bed.daemon as unknown as { handleHealthRequest(r: Request): Response })
      .handleHealthRequest(new Request("http://127.0.0.1/health")).json() as Promise<Record<string, unknown>>;
    const probeState = (value: Record<string, unknown>) =>
      value.authority_probe as { attempts: number; next_probe_at: string | null };
    try {
      const { pending } = await startProbe(bed);
      // The loop publishes its deadline as its first action; wait for that
      // rather than racing the cleanup it follows.
      let body = await health();
      for (let index = 0; index < 50 && probeState(body).next_probe_at == null; index++) {
        await Promise.resolve();
        body = await health();
      }
      expect(body.mode).toBe("cleanup_only");
      expect(probeState(body).attempts).toBe(0);
      // The published deadline is the interval the loop is waiting out.
      expect(Date.parse(String(probeState(body).next_probe_at)) - Date.now()).toBe(120_000);

      jest.advanceTimersByTime(120_000);
      for (let index = 0; index < 8; index++) await Promise.resolve();
      const after = probeState(await health());
      expect(after.attempts).toBe(1);
      // And the next deadline, from the second step of the schedule.
      expect(Date.parse(String(after.next_probe_at)) - Date.now()).toBe(240_000);

      bed.daemon.stop();
      await pending;
    } finally {
      logger.restore();
    }
  }, 20_000);

  it("requests a restart through the existing channel once the probe succeeds", async () => {
    jest.useFakeTimers();
    const logger = captureLogger();
    let restarts = 0;
    const bed = createProbeDaemon({ register: async () => {} });
    (bed.daemon as unknown as { onRestartRequested: () => void }).onRestartRequested = () => { restarts++; };
    try {
      const { pending } = await startProbe(bed);
      expect(bed.registerTimes.length).toBe(0);

      jest.advanceTimersByTime(30_000);
      await pending;

      expect(bed.registerTimes.length).toBe(1);
      expect(bed.daemon.restartRequested()).toBe(true);
      expect(bed.stopCalls()).toBe(1);
      // The process-wide restart channel replaces the process; the daemon must
      // not try to boot a second copy of itself here.
      expect(restarts).toBe(1);
    } finally {
      logger.restore();
    }
  }, 20_000);

  it("does not idle in the probe loop in once mode", async () => {
    jest.useFakeTimers();
    const logger = captureLogger();
    const bed = createProbeDaemon({ once: true });
    try {
      // A `--once` run has no supervisor to own the keep-alive, so cleanup
      // completes and the caller keeps ownership of the process lifecycle.
      const { pending } = await startProbe(bed);
      await pending;
      expect(bed.registerTimes.length).toBe(0);
      expect(bed.daemon.restartRequested()).toBe(false);
      expect(bed.stopCalls()).toBe(1);
    } finally {
      logger.restore();
    }
  }, 20_000);

  it("stops immediately on SIGTERM while the probe loop is waiting", async () => {
    jest.useFakeTimers();
    const logger = captureLogger();
    const bed = createProbeDaemon();
    try {
      const { pending } = await startProbe(bed);
      expect(bed.registerTimes.length).toBe(0);

      // The CLI signal handler calls stop(); the probe must not wait out the
      // remaining sleep or fire another register.
      bed.daemon.stop();
      await pending;
      expect(bed.registerTimes.length).toBe(0);
      const internal = bed.daemon as unknown as { authorityProbeNextAt: string | null };
      expect(internal.authorityProbeNextAt).not.toBe("running");
    } finally {
      logger.restore();
    }
  }, 20_000);
});
