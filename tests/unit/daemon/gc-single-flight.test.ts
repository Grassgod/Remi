import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { codeViewsRoot } from "@daemon/agent-runtime/workspace/layout.js";
import { executionTrackerFor } from "@daemon/agent-runtime/workspace/execution-tracker.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";

describe("daemon GC and lifecycle orchestration", () => {
  const roots: string[] = [];
  const outboxes: MultiremiTaskReportOutbox[] = [];
  const reports = () => {
    const outbox = new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async () => {} });
    outboxes.push(outbox);
    return () => outbox;
  };

  afterEach(async () => {
    for (const outbox of outboxes.splice(0)) await outbox.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("coalesces overlapping GC runs", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    let calls = 0;
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.assign(daemon, {
      gcInFlight: null,
      executeGcOnce: async () => {
        calls++;
        return await blocked;
      },
    });

    const first = daemon.runGcOnce();
    const second = daemon.runGcOnce();
    await Promise.resolve();
    expect(calls).toBe(1);

    finish();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("defers the first automatic GC until its interval", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    let calls = 0;
    Object.assign(daemon, {
      gcTimer: null,
      options: { gcEnabled: true, once: false, gcIntervalMs: 20 },
      runGcOnce: async () => {
        calls++;
      },
    });

    (daemon as unknown as { startGcLoop(): void }).startGcLoop();
    expect(calls).toBe(0);
    await Bun.sleep(35);
    expect(calls).toBeGreaterThanOrEqual(1);
    (daemon as unknown as { stopGcLoop(): void }).stopGcLoop();
  });

  it("does not let shutdown or restart finish while an active GC is blocked", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    let finishGc!: () => void;
    const blockedGc = new Promise<void>((resolve) => {
      finishGc = resolve;
    });
    let loopEntered!: () => void;
    const loopStarted = new Promise<void>((resolve) => {
      loopEntered = resolve;
    });
    Object.assign(daemon, {
      stopped: false,
      ready: false,
      claimsPaused: false,
      terminalAuthorityMode: false,
      terminalAuthorityCleanupAttempts: 0,
      restartRequestedFlag: false,
      gcTimer: null,
      gcInFlight: null,
      gcRunRequests: new Map(),
      inflight: new Set<Promise<void>>(),
      runtimeGoneInflight: new Set<string>(),
      activeTaskCount: 0,
      pendingClaimCount: 0,
      feishuOutboundRuns: new Map(),
      options: { once: false, pollIntervalMs: 1, pluginDesiredRefreshMs: 30_000, maxConcurrency: 1, runtimeId: "rt_shutdown" },
      client: {
        recoverOrphans: async () => {},
        claimTask: async () => {
          loopEntered();
          daemon.stop();
          return null;
        },
      },
      sshMeshManager: {
        getHeartbeatStatus: () => ({
          protocol_version: 1,
          state: "disabled",
          peers: [],
        }),
      },
      sweepLegacyLayout: async () => {},
      registerCurrentRuntime: async () => "rt_shutdown",
      ensureOutbox: reports(),
      ensureTrace: () => ({ track: () => {}, completion: () => ({}), close: () => {} }),
      refreshWorkspaceRepos: async () => {},
      startRepoCheckoutServer: () => {},
      stopRepoCheckoutServer: () => {},
      startGcLoop: () => {
        const state = daemon as unknown as {
          gcTimer: ReturnType<typeof setInterval> | null;
          gcInFlight: Promise<void> | null;
        };
        state.gcTimer = setInterval(() => {}, 60_000);
        state.gcInFlight = blockedGc;
      },
      startRuntimeModelRefresh: () => {},
      reconcileRuntimeAgentPlugins: async () => {},
      handleHeartbeatAck: async () => false,
      runtimeModelRefreshTask: null,
      runtimeModelListRequests: new Map(),
      terminalAuthorityCleanupRetryWake: null,
      agentPluginReconcileAbort: null,
      runtimeModelRefreshAbort: null,
      runtimeModelRetryTimer: null,
      runtimeModelRetryWake: null,
      workspaceRootFence: null,
      supervisorReady: () => true,
      onReadyChange: (ready: boolean) => {
        if (ready) { loopEntered(); daemon.stop(); }
      },
    });

    let stopped = false;
    const run = daemon.start().then(() => {
      stopped = true;
    });
    await loopStarted;
    await Promise.resolve();
    const daemonState = daemon as unknown as Record<string, unknown>;
    expect(daemonState.stopped).toBe(true);
    expect(daemonState.gcTimer).toBeNull();
    expect(stopped).toBe(false);

    finishGc();
    await run;
    expect(stopped).toBe(true);
  });

  it("holds the Issue lifecycle lease for the entire claimed task", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    const locker = new IssueWorkspaceLifecycleLocker();
    let providerEntered!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    let finishProvider!: () => void;
    const providerFinished = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const events: string[] = [];
    Object.assign(daemon, {
      pollAbort: new AbortController(),
      activeTaskCount: 0,
      activeTaskIds: new Set<string>(),
      activeTaskAborts: new Set<AbortController>(),
      issueWorkspaceLifecycleLocks: locker,
      taskDownlinks: { observeCancellation: () => () => {}, release: () => {} },
      ensureOutbox: reports(),
      ensureTrace: () => ({ track: () => {}, completion: () => ({}), close: () => {} }),
      options: { taskTimeoutMs: 0, workspacesRoot: "/tmp/multiremi-lifecycle-test" },
      client: {
        renewTaskDispatchLease: async () => "dispatched",
        getTaskStatus: async () => "running",
        failTask: async () => {},
      },
      resolveTaskWorkDir: async () => {
        events.push("provider-started");
        providerEntered();
        await providerFinished;
        events.push("provider-exited");
        throw new Error("test provider stopped");
      },
    });

    const taskRun = (daemon as unknown as {
      handleTask(task: Record<string, unknown>): Promise<void>;
    }).handleTask({
      id: "tsk_lifecycle",
      issueId: "iss_lifecycle",
      sessionId: null,
      workDir: null,
      agent: { provider: "claude" },
    });
    await providerStarted;
    await (daemon as unknown as {
      handleTask(task: Record<string, unknown>): Promise<void>;
    }).handleTask({
      id: "tsk_lifecycle",
      issueId: "iss_lifecycle",
      sessionId: null,
      workDir: null,
      agent: { provider: "claude" },
    });
    expect((daemon as unknown as { activeTaskCount: number }).activeTaskCount).toBe(1);
    const gcRun = locker.runExclusive("iss_lifecycle", async () => {
      events.push("gc-reclaim");
    });
    await Promise.resolve();
    expect(events).toEqual(["provider-started"]);

    finishProvider();
    await Promise.all([taskRun, gcRun]);
    expect(events).toEqual(["provider-started", "provider-exited", "gc-reclaim"]);
  });

  it.each([
    ["a Chat", { chatSessionId: "chat_held" }, "chat_held"],
    ["an Issue discussion", { issueId: "iss_held", holdsWorkspace: false, issueSessionId: "ises_held" }, "iss_held"],
    ["a task with neither", {}, "tsk_held"],
  ])("%s is tracked as running and holds its subject for the whole execution", async (_name, ids, subjectId) => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-tracked-subject-"));
    roots.push(root);
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    const locker = new IssueWorkspaceLifecycleLocker();
    let providerEntered!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
    let finishProvider!: () => void;
    const providerFinished = new Promise<void>((resolve) => { finishProvider = resolve; });
    Object.assign(daemon, {
      pollAbort: new AbortController(),
      activeTaskCount: 0,
      activeTaskIds: new Set<string>(),
      activeTaskAborts: new Set<AbortController>(),
      issueWorkspaceLifecycleLocks: locker,
      taskDownlinks: { observeCancellation: () => () => {}, release: () => {} },
      ensureOutbox: reports(),
      ensureTrace: () => ({ track: () => {}, completion: () => ({}), close: () => {} }),
      options: { taskTimeoutMs: 0, workspacesRoot: root },
      client: { renewTaskDispatchLease: async () => "dispatched", getTaskStatus: async () => "running", failTask: async () => {} },
      resolveTaskWorkDir: async () => {
        providerEntered();
        await providerFinished;
        throw new Error("test provider stopped");
      },
    });
    const tracker = executionTrackerFor(root);

    const run = (daemon as unknown as { handleTask(task: Record<string, unknown>): Promise<void> }).handleTask({
      id: "tsk_held", sessionId: null, workDir: null, agent: { provider: "claude" }, ...ids,
    });
    await providerStarted;

    expect(tracker.subjectRunning(subjectId)).toBe(true);
    expect(tracker.taskRunning("tsk_held")).toBe(true);
    // Reclaim takes the lock without queueing; it must find the subject busy.
    expect(locker.tryAcquire(subjectId)).toBeNull();

    finishProvider();
    await run;

    expect(tracker.subjectRunning(subjectId)).toBe(false);
    const release = locker.tryAcquire(subjectId);
    expect(release).not.toBeNull();
    release!();
  });

  it("shares one lifecycle barrier across provider daemon instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-multi-provider-lifecycle-"));
    roots.push(root);
    const [claude, codex] = instantiateCoResidentWorkerDaemons([
      { sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", provider: "claude", workspacesRoot: root },
      { sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", provider: "codex", workspacesRoot: root },
    ]) as unknown as Array<{ issueWorkspaceLifecycleLocks: IssueWorkspaceLifecycleLocker }>;
    if (!claude || !codex) throw new Error("Expected both provider daemons");

    expect(claude.issueWorkspaceLifecycleLocks).toBe(codex.issueWorkspaceLifecycleLocks);

    const releaseTask = await codex.issueWorkspaceLifecycleLocks.acquire("iss_shared");
    const events = ["codex-provider-started"];
    const gcRun = claude.issueWorkspaceLifecycleLocks.runExclusive("iss_shared", async () => {
      events.push("claude-gc-reclaim");
    });
    await Promise.resolve();
    expect(events).toEqual(["codex-provider-started"]);

    events.push("codex-provider-exited");
    releaseTask();
    await gcRun;
    expect(events).toEqual([
      "codex-provider-started",
      "codex-provider-exited",
      "claude-gc-reclaim",
    ]);
  });

  it("assigns workspace GC to one co-resident provider", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-multi-provider-gc-leader-"));
    roots.push(root);
    const daemons = instantiateCoResidentWorkerDaemons([
      { sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", provider: "claude", workspacesRoot: root },
      { sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", provider: "codex", workspacesRoot: root },
    ]) as unknown as Array<{ options: { gcEnabled: boolean } }>;

    expect(daemons.map((daemon) => daemon.options.gcEnabled)).toEqual([true, false]);
  });

  it("reports supervisor readiness only after every provider is ready", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-multi-provider-ready-"));
    roots.push(root);
    const daemons = instantiateCoResidentWorkerDaemons([
      { sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", provider: "claude", workspacesRoot: root },
      { sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", provider: "codex", workspacesRoot: root },
    ]) as unknown as Array<{
      onReadyChange(ready: boolean): void;
      supervisorReady(): boolean;
    }>;
    const [claude, codex] = daemons;
    if (!claude || !codex) throw new Error("Expected both provider daemons");

    expect(claude.supervisorReady()).toBe(false);
    claude.onReadyChange(true);
    expect(claude.supervisorReady()).toBe(false);
    codex.onReadyChange(true);
    expect(claude.supervisorReady()).toBe(true);
    expect(codex.supervisorReady()).toBe(true);
    codex.onReadyChange(false);
    expect(claude.supervisorReady()).toBe(false);
  });

  it("does not claim a task before the process-wide provider barrier is ready", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    let barrierReady = false;
    let claims = 0;
    let connections = 0;
    let providerReady!: () => void;
    const providerReachedBarrier = new Promise<void>((resolve) => { providerReady = resolve; });
    Object.assign(daemon, {
      stopped: false,
      ready: false,
      claimsPaused: false,
      terminalAuthorityMode: false,
      terminalAuthorityCleanupAttempts: 0,
      restartRequestedFlag: false,
      workspaceOwnershipLost: false,
      inflight: new Set<Promise<void>>(),
      runtimeGoneInflight: new Set<string>(),
      feishuOutboundRuns: new Map(),
      gcInFlight: null,
      gcRunRequests: new Map(),
      runtimeModelRefreshTask: null,
      runtimeModelListRequests: new Map(),
      workspaceRootFence: null,
      options: { once: true, pollIntervalMs: 1, runtimeId: "rt_barrier", maxConcurrency: 1 },
      client: {
        recoverOrphans: async () => {},
        heartbeatRuntime: async () => ({}),
        claimTask: async () => {
          claims++;
          return null;
        },
      },
      protocolClient: {
        startLane: () => { connections++; daemon.stop(); }, stopLane: () => {}, drain: async () => {},
      },
      sshMeshManager: {
        getHeartbeatStatus: () => ({ protocol_version: 1, state: "disabled", peers: [] }),
      },
      sweepLegacyLayout: async () => {},
      registerCurrentRuntime: async () => "rt_barrier",
      ensureOutbox: reports(),
      ensureTrace: () => ({ track: () => {}, completion: () => ({}), close: () => {} }),
      refreshWorkspaceRepos: async () => {},
      startRepoCheckoutServer: () => {},
      stopRepoCheckoutServer: () => {},
      startGcLoop: () => {},
      stopGcLoop: () => {},
      cancelRuntimeModelRefresh: () => {},
      reconcileRuntimeAgentPlugins: async () => {},
      handleHeartbeatAck: async () => false,
      supervisorReady: () => barrierReady,
      onReadyChange: (ready: boolean) => {
        if (ready) providerReady();
      },
    });

    const run = daemon.start();
    await providerReachedBarrier;
    await Bun.sleep(30);
    expect(claims).toBe(0);
    expect(connections).toBe(0);

    barrierReady = true;
    await run;
    expect(connections).toBe(1);
    expect(claims).toBe(0);
  });

  const storageReport = (mode: "periodic" | "dry_run" | "run" = "periodic") => ({
    version: 1, generated_at: "2026-10-13T00:00:00.000Z", mode, root: "/tmp/multiremi-gc-order", bytes: null,
    subjects: { total: 0, active: 0, ended: 0, reclaimed: 0 }, retained: {}, reclaimed_this_round: 2,
    forgotten_this_round: 0, freed_bytes: 10, plan: [], errors: [],
  });

  /** A daemon with only what one GC round touches. */
  function gcDaemon(overrides: Record<string, unknown> = {}) {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    const calls: string[] = [];
    Object.assign(daemon, {
      workspaceRootFence: null,
      gcRunRequests: new Map(),
      reclaim: { run: async (mode: string) => { calls.push(`reclaim:${mode}`); return storageReport(mode as "periodic"); } },
      client: {
        reportStorageReport: (runtimeId: string, report: { mode: string }) => { calls.push(`storage_report:${runtimeId}:${report.mode}`); },
        reportGcRunResult: async (runtimeId: string, requestId: string, result: { status: string; error: string | null }) => {
          calls.push(`result:${runtimeId}:${requestId}:${result.status}:${result.error ?? ""}`);
        },
      },
      runSnapshotGcPass: async () => {
        calls.push("code-views");
        return { removed: 0, retained: 0, skipped: 0 };
      },
      options: {
        workspacesRoot: "/tmp/multiremi-gc-order", snapshotTtlMs: 1234, runtimeId: "rt_gc",
        repoCacheRoot: "/tmp/multiremi-gc-order/shared/repos",
      },
      ...overrides,
    });
    return { daemon, calls };
  }

  it("runs a reclaim round, reports it, then sweeps the shared code views", async () => {
    const seen: Array<{ snapshotsRoot: string; ttlMs: number }> = [];
    const { daemon, calls } = gcDaemon({
      runSnapshotGcPass: async (options: { snapshotsRoot: string; ttlMs: number }) => {
        calls.push("code-views");
        seen.push({ snapshotsRoot: options.snapshotsRoot, ttlMs: options.ttlMs });
        return { removed: 3, retained: 0, skipped: 1 };
      },
    });

    await (daemon as unknown as { executeGcOnce(): Promise<void> }).executeGcOnce();

    expect(calls).toEqual(["reclaim:periodic", "storage_report:rt_gc:periodic", "code-views"]);
    expect(seen).toEqual([{ snapshotsRoot: codeViewsRoot("/tmp/multiremi-gc-order"), ttlMs: 1234 }]);
  });

  it("does not let a failing reclaim round starve the code-view sweep", async () => {
    const { daemon, calls } = gcDaemon({
      reclaim: { run: async () => { calls.push("reclaim:periodic"); throw new Error("registry unreadable"); } },
    });

    await expect((daemon as unknown as { executeGcOnce(): Promise<void> }).executeGcOnce())
      .rejects.toThrow("registry unreadable");

    expect(calls).toEqual(["reclaim:periodic", "code-views"]);
  });

  it("stops at the reclaim round when workspace ownership is lost mid-round", async () => {
    let lost = false;
    const { daemon, calls } = gcDaemon({
      workspaceRootFence: () => { if (lost) throw new Error("workspace root identity changed"); },
      reclaim: { run: async () => { lost = true; throw new Error("round aborted"); } },
      workspaceOwnershipLost: false,
      activeTaskAborts: new Set<AbortController>(),
      claimsPaused: false,
      ready: true,
      stopped: false,
      pollAbort: new AbortController(),
      gcTimer: null,
      terminalAuthorityCleanupRetryWake: null,
      agentPluginReconcileAbort: null,
      runtimeModelRefreshAbort: null,
      runtimeModelProbeAbort: null,
      runtimeModelRetryWake: null,
      onReadyChange: () => {},
    });

    await expect((daemon as unknown as { executeGcOnce(): Promise<void> }).executeGcOnce())
      .rejects.toThrow("workspace root identity changed");

    expect(calls).toEqual([]);
  });

  it("skips the code-view sweep and reports the fence when workspace ownership is lost", async () => {
    const pollAbort = new AbortController();
    const { daemon, calls } = gcDaemon({
      workspaceRootFence: () => {
        throw new Error("workspace root identity changed");
      },
      workspaceOwnershipLost: false,
      activeTaskAborts: new Set<AbortController>(),
      claimsPaused: false,
      ready: true,
      stopped: false,
      pollAbort,
      gcTimer: null,
      terminalAuthorityCleanupRetryWake: null,
      agentPluginReconcileAbort: null,
      runtimeModelRefreshAbort: null,
      runtimeModelProbeAbort: null,
      runtimeModelRetryWake: null,
      onReadyChange: () => {},
    });

    await expect((daemon as unknown as { executeGcOnce(): Promise<void> }).executeGcOnce())
      .rejects.toThrow("workspace root identity changed");
    expect(calls).toEqual([]);
  });

  describe("runtime.gc_run", () => {
    const handle = (daemon: unknown, request: { id: string; mode: "dry_run" | "run" }) =>
      (daemon as { handleRuntimeGcRun(runtimeId: string, request: { id: string; mode: string }): void }).handleRuntimeGcRun("rt_gc", request);
    const settle = async (daemon: unknown) =>
      Promise.allSettled([...(daemon as { gcRunRequests: Map<string, Promise<void>> }).gcRunRequests.values()]);

    it("runs the requested mode and answers with the report, sending a storage report only for a real run", async () => {
      const { daemon, calls } = gcDaemon();

      handle(daemon, { id: "gcr_dry", mode: "dry_run" });
      await settle(daemon);
      handle(daemon, { id: "gcr_run", mode: "run" });
      await settle(daemon);

      expect(calls).toEqual([
        "reclaim:dry_run", "result:rt_gc:gcr_dry:completed:",
        "reclaim:run", "storage_report:rt_gc:run", "result:rt_gc:gcr_run:completed:",
      ]);
    });

    it("answers a failed round with its error", async () => {
      const { daemon, calls } = gcDaemon({
        reclaim: { run: async () => { throw new Error("disk full"); } },
      });

      handle(daemon, { id: "gcr_1", mode: "run" });
      await settle(daemon);

      expect(calls).toEqual(["result:rt_gc:gcr_1:failed:disk full"]);
    });

    it("refuses an unknown mode instead of applying it", async () => {
      const { daemon, calls } = gcDaemon();

      handle(daemon, { id: "gcr_1", mode: "periodic" as "run" });
      await settle(daemon);

      expect(calls).toEqual(["result:rt_gc:gcr_1:failed:unknown reclaim mode: periodic"]);
    });

    it("serves a request once while it is in flight", async () => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const { daemon, calls } = gcDaemon({
        reclaim: { run: async (mode: string) => { calls.push(`reclaim:${mode}`); await gate; return storageReport("run"); } },
      });

      handle(daemon, { id: "gcr_1", mode: "run" });
      handle(daemon, { id: "gcr_1", mode: "run" });
      finish();
      await settle(daemon);

      expect(calls.filter((call) => call.startsWith("reclaim:"))).toEqual(["reclaim:run"]);
      expect((daemon as unknown as { gcRunRequests: Map<string, unknown> }).gcRunRequests.size).toBe(0);
    });

    it("keeps shutdown waiting for a run in flight", async () => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const { daemon } = gcDaemon({
        gcInFlight: null,
        reclaim: { run: async () => { await gate; return storageReport("run"); } },
      });
      handle(daemon, { id: "gcr_1", mode: "run" });

      let drained = false;
      const drain = (daemon as unknown as { drainGcInFlight(): Promise<void> }).drainGcInFlight().then(() => { drained = true; });
      await Bun.sleep(10);
      expect(drained).toBe(false);

      finish();
      await drain;
      expect(drained).toBe(true);
    });
  });

  it("fails closed before GC when workspace ownership is lost", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    const taskAbort = new AbortController();
    const pollAbort = new AbortController();
    const readyStates: boolean[] = [];
    Object.assign(daemon, {
      workspaceRootFence: () => {
        throw new Error("workspace root identity changed");
      },
      workspaceOwnershipLost: false,
      activeTaskAborts: new Set([taskAbort]),
      claimsPaused: false,
      ready: true,
      stopped: false,
      pollAbort,
      gcTimer: null,
      terminalAuthorityCleanupRetryWake: null,
      agentPluginReconcileAbort: null,
      runtimeModelRefreshAbort: null,
      runtimeModelProbeAbort: null,
      runtimeModelRetryWake: null,
      onReadyChange: (ready: boolean) => readyStates.push(ready),
    });

    await expect((daemon as unknown as { executeGcOnce(): Promise<void> }).executeGcOnce())
      .rejects.toThrow("workspace root identity changed");
    expect(taskAbort.signal.aborted).toBe(true);
    expect(pollAbort.signal.aborted).toBe(true);
    expect((daemon as unknown as { stopped: boolean }).stopped).toBe(true);
    expect(readyStates).toEqual([false]);
  });
});
