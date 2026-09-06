import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { writeIssueSessionArchiveReceipt } from "@daemon/agent-runtime/workspace/session-archive.js";
import type { MultiremiDaemonGcSummary } from "@daemon/agent-runtime/workspace/gc.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";

describe("daemon Session archive GC orchestration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("coalesces overlapping GC runs", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    let calls = 0;
    let finish!: (summary: MultiremiDaemonGcSummary) => void;
    const blocked = new Promise<MultiremiDaemonGcSummary>((resolve) => {
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

    const summary = { cleaned: 1, orphaned: 0, skipped: 0 };
    finish(summary);
    expect(await Promise.all([first, second])).toEqual([summary, summary]);
  });

  it("defers the first automatic GC until its interval", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    let calls = 0;
    Object.assign(daemon, {
      gcTimer: null,
      options: { gcEnabled: true, once: false, gcIntervalMs: 20 },
      runGcOnce: async () => {
        calls++;
        return { cleaned: 0, orphaned: 0, skipped: 0 };
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
    let heartbeatEntered!: () => void;
    const heartbeatStarted = new Promise<void>((resolve) => {
      heartbeatEntered = resolve;
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
      inflight: new Set<Promise<void>>(),
      options: { once: false, pollIntervalMs: 1, runtimeId: "rt_shutdown" },
      client: {
        recoverOrphans: async () => {},
        heartbeatRuntime: async () => {
          heartbeatEntered();
          daemon.stop();
          return {};
        },
      },
      sshMeshManager: {
        getHeartbeatStatus: () => ({
          protocol_version: 1,
          state: "disabled",
          peers: [],
        }),
      },
      registerCurrentRuntime: async () => "rt_shutdown",
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
      terminalAuthorityCleanupRetryWake: null,
      agentPluginReconcileAbort: null,
      runtimeModelRefreshAbort: null,
      runtimeModelRetryTimer: null,
      runtimeModelRetryWake: null,
      workspaceRootFence: null,
      supervisorReady: () => true,
      onReadyChange: () => {},
    });

    let stopped = false;
    const run = daemon.start().then(() => {
      stopped = true;
    });
    await heartbeatStarted;
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
      activeTaskCount: 0,
      activeTaskIds: new Set<string>(),
      activeTaskAborts: new Set<AbortController>(),
      issueWorkspaceLifecycleLocks: locker,
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
      events.push("gc-archive-and-delete");
    });
    await Promise.resolve();
    expect(events).toEqual(["provider-started"]);

    finishProvider();
    await Promise.all([taskRun, gcRun]);
    expect(events).toEqual(["provider-started", "provider-exited", "gc-archive-and-delete"]);
  });

  it("shares one lifecycle barrier across provider daemon instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-multi-provider-lifecycle-"));
    roots.push(root);
    const [claude, codex] = instantiateCoResidentWorkerDaemons([
      { serverUrl: "http://127.0.0.1:1", provider: "claude", workspacesRoot: root },
      { serverUrl: "http://127.0.0.1:1", provider: "codex", workspacesRoot: root },
    ]) as unknown as Array<{ issueWorkspaceLifecycleLocks: IssueWorkspaceLifecycleLocker }>;
    if (!claude || !codex) throw new Error("Expected both provider daemons");

    expect(claude.issueWorkspaceLifecycleLocks).toBe(codex.issueWorkspaceLifecycleLocks);

    const releaseTask = await codex.issueWorkspaceLifecycleLocks.acquire("iss_shared");
    const events = ["codex-provider-started"];
    const gcRun = claude.issueWorkspaceLifecycleLocks.runExclusive("iss_shared", async () => {
      events.push("claude-gc-archive-and-delete");
    });
    await Promise.resolve();
    expect(events).toEqual(["codex-provider-started"]);

    events.push("codex-provider-exited");
    releaseTask();
    await gcRun;
    expect(events).toEqual([
      "codex-provider-started",
      "codex-provider-exited",
      "claude-gc-archive-and-delete",
    ]);
  });

  it("assigns workspace GC to one co-resident provider", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-multi-provider-gc-leader-"));
    roots.push(root);
    const daemons = instantiateCoResidentWorkerDaemons([
      { serverUrl: "http://127.0.0.1:1", provider: "claude", workspacesRoot: root },
      { serverUrl: "http://127.0.0.1:1", provider: "codex", workspacesRoot: root },
    ]) as unknown as Array<{ options: { gcEnabled: boolean } }>;

    expect(daemons.map((daemon) => daemon.options.gcEnabled)).toEqual([true, false]);
  });

  it("reports supervisor readiness only after every provider is ready", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-multi-provider-ready-"));
    roots.push(root);
    const daemons = instantiateCoResidentWorkerDaemons([
      { serverUrl: "http://127.0.0.1:1", provider: "claude", workspacesRoot: root },
      { serverUrl: "http://127.0.0.1:1", provider: "codex", workspacesRoot: root },
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
      gcInFlight: null,
      runtimeModelRefreshTask: null,
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
      sshMeshManager: {
        getHeartbeatStatus: () => ({ protocol_version: 1, state: "disabled", peers: [] }),
      },
      registerCurrentRuntime: async () => "rt_barrier",
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

    barrierReady = true;
    await run;
    expect(claims).toBe(1);
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

    await expect((daemon as unknown as {
      executeGcOnce(): Promise<MultiremiDaemonGcSummary>;
    }).executeGcOnce()).rejects.toThrow("workspace root identity changed");
    expect(taskAbort.signal.aborted).toBe(true);
    expect(pollAbort.signal.aborted).toBe(true);
    expect((daemon as unknown as { stopped: boolean }).stopped).toBe(true);
    expect(readyStates).toEqual([false]);
  });

  it("checks a verified receipt without scanning or packing provider history", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-receipt-fast-path-"));
    roots.push(root);
    mkdirSync(join(root, ".multiremi"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-receipt-outside-"));
    roots.push(outside);
    // prepareIssueSessionArchive would reject this. Success therefore proves
    // the receipt path returned before provider history was scanned.
    symlinkSync(outside, join(root, ".multiremi", "sessions"));
    await writeIssueSessionArchiveReceipt(root, {
      issueId: "iss_1",
      sourceRevision: "a".repeat(64),
      sha256: "b".repeat(64),
      archiveId: "isar_1",
    });

    const requests: unknown[][] = [];
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    Object.assign(daemon, {
      options: { runtimeId: "rt_1", sessionArchiveMaxSourceBytes: 1024 },
      client: {
        getIssueSessionArchiveStatus: async (...args: unknown[]) => {
          requests.push(args);
          return {
            latest: null,
            latest_ready: { id: "isar_1", status: "ready" },
            requested_ready: { id: "isar_1", status: "ready" },
            gc_ready: true,
          };
        },
      },
    });

    expect(await (daemon as unknown as {
      ensureIssueSessionArchive(issueId: string, workspaceDir: string): Promise<unknown>;
    }).ensureIssueSessionArchive("iss_1", root)).toEqual({
      archiveId: "isar_1",
      sourceRevision: "a".repeat(64),
      sha256: "b".repeat(64),
    });
    expect(requests).toEqual([["rt_1", "iss_1", "a".repeat(64), "b".repeat(64)]]);
  });

  it("requests physical verification for the deletion-time fresh snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-fresh-barrier-"));
    roots.push(root);
    const sessions = join(root, ".multiremi", "sessions", "codex");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "history.jsonl"), "{\"type\":\"session\"}\n");

    const requests: unknown[][] = [];
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    Object.assign(daemon, {
      options: { runtimeId: "rt_1", sessionArchiveMaxSourceBytes: 1024 },
      client: {
        getIssueSessionArchiveStatus: async (...args: unknown[]) => {
          requests.push(args);
          return {
            latest: null,
            latest_ready: { id: "isar_1", status: "ready" },
            requested_ready: { id: "isar_1", status: "ready" },
            gc_ready: true,
          };
        },
      },
    });

    expect(await (daemon as unknown as {
      ensureIssueSessionArchive(
        issueId: string,
        workspaceDir: string,
        forceFreshSnapshot: boolean,
      ): Promise<unknown>;
    }).ensureIssueSessionArchive("iss_1", root, true)).toMatchObject({ archiveId: "isar_1" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(["rt_1", "iss_1"]);
    expect(requests[1]?.slice(0, 2)).toEqual(["rt_1", "iss_1"]);
    expect(requests[1]?.[4]).toBe(true);
  });

  it("reports a preparation failure before init and leaves the workspace retryable", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-preparation-failure-"));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-preparation-outside-"));
    roots.push(outside);
    mkdirSync(join(root, ".multiremi"), { recursive: true });
    symlinkSync(outside, join(root, ".multiremi", "sessions"));

    const reports: Array<{ runtimeId: string; issueId: string; input: unknown }> = [];
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    Object.assign(daemon, {
      options: { runtimeId: "rt_1", sessionArchiveMaxSourceBytes: 1024 },
      client: {
        getIssueSessionArchiveStatus: async () => ({
          latest: null,
          latest_ready: null,
          requested_ready: null,
          gc_ready: false,
        }),
        reportIssueSessionArchiveFailure: async (
          runtimeId: string,
          issueId: string,
          input: unknown,
        ) => {
          reports.push({ runtimeId, issueId, input });
          return { id: "sar_failure", status: "failed" };
        },
      },
    });

    await expect((daemon as unknown as {
      ensureIssueSessionArchive(issueId: string, workspaceDir: string): Promise<boolean>;
    }).ensureIssueSessionArchive("iss_1", root)).rejects.toThrow("must not contain symlinks");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      runtimeId: "rt_1",
      issueId: "iss_1",
      input: {
        stage: "prepare",
        error: expect.stringContaining("must not contain symlinks"),
      },
    });
  });

  it("resolves a preparation failure when the rebuilt snapshot already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-preparation-resolved-"));
    roots.push(root);
    const sessions = join(root, ".multiremi", "sessions", "codex");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "history.jsonl"), "{\"type\":\"session\"}\n");

    const initialized: unknown[] = [];
    const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
    Object.assign(daemon, {
      options: { runtimeId: "rt_1", sessionArchiveMaxSourceBytes: 1024 },
      client: {
        getIssueSessionArchiveStatus: async () => ({
          latest: {
            id: "sar_failure",
            status: "pending",
            source_revision: "preparation-failed",
          },
          latest_ready: { id: "sar_ready", status: "ready" },
          requested_ready: { id: "sar_ready", status: "ready" },
          gc_ready: true,
        }),
        initIssueSessionArchive: async (...args: unknown[]) => {
          initialized.push(args);
          return {
            archive: { id: "sar_ready", status: "ready" },
            upload_attempt: null,
            upload_url: null,
          };
        },
      },
    });

    expect(await (daemon as unknown as {
      ensureIssueSessionArchive(issueId: string, workspaceDir: string): Promise<unknown>;
    }).ensureIssueSessionArchive("iss_1", root)).toMatchObject({ archiveId: "sar_ready" });
    expect(initialized).toHaveLength(1);
  });
});
