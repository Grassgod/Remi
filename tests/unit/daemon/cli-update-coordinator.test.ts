import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiRuntimeUpdateScope } from "@multiremi/contracts/types.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiCliUpdateCoordinator } from "@multiremi/worker/cli-update-coordinator.js";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";

interface UpdateReport {
  status: "running" | "completed" | "failed";
  output?: string;
  error?: string;
}

interface TestDaemonState {
  activeTaskCount: number;
  drainingTaskCount: number;
  pendingClaimCount: number;
  claimsPaused: boolean;
  cliUpdateCoordinator: MultiremiCliUpdateCoordinator | null;
  client: {
    claimTask?(runtimeId: string): Promise<unknown>;
    reportRuntimeUpdateResult(
      runtimeId: string,
      requestId: string,
      report: UpdateReport,
    ): Promise<void>;
  };
  updateRunner(targetVersion: string): string | Promise<string>;
  updateAgentCli(): Promise<string>;
  reinstallAcpBridge(): string;
  handleRuntimeUpdate(
    runtimeId: string,
    requestId: string,
    targetVersion: string,
    scope: MultiremiRuntimeUpdateScope,
  ): Promise<void>;
  claimTask(runtimeId: string): Promise<unknown>;
}

describe("co-resident CLI update coordination", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a CLI update when a sibling provider is busy and names it", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    let updateCalls = 0;
    claudeState.updateRunner = () => {
      updateCalls++;
      return "updated";
    };
    codexState.activeTaskCount = 2;

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_busy", "v9.9.9", "cli");

    expect(updateCalls).toBe(0);
    expect(reports).toEqual([{
      status: "failed",
      error: "CLI update blocked: provider is busy: codex (2 active tasks); retry when all providers are idle",
    }]);
    expect(claudeState.claimsPaused).toBe(false);
    expect(codexState.claimsPaused).toBe(false);
  });

  it("pauses claims on every provider before replacing the shared CLI", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    claudeState.updateRunner = () => {
      expect(claudeState.claimsPaused).toBe(true);
      expect(codexState.claimsPaused).toBe(true);
      return "updated together";
    };

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_idle", "v9.9.9", "cli");

    expect(reports).toEqual([
      { status: "running" },
      { status: "completed", output: "updated together" },
    ]);
    expect(claudeState.claimsPaused).toBe(true);
    expect(codexState.claimsPaused).toBe(true);
    expect(claude.restartRequested()).toBe(true);
  });

  it("does not treat a sibling's durable report drain as active agent execution", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    codexState.activeTaskCount = 0;
    codexState.drainingTaskCount = 3;
    claudeState.updateRunner = () => "updated while reports drain";

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_draining", "v9.9.9", "cli");

    expect(reports).toEqual([
      { status: "running" },
      { status: "completed", output: "updated while reports drain" },
    ]);
    expect(claudeState.claimsPaused).toBe(true);
    expect(codexState.claimsPaused).toBe(true);
  });

  it("rejects a CLI update while a sibling claim request is in flight", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    const pendingClaim = deferred<null>();
    codexState.client = {
      claimTask: async () => await pendingClaim.promise,
      reportRuntimeUpdateResult: async () => {},
    };
    const claimRun = codexState.claimTask("rt_codex");
    await Promise.resolve();

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_claiming", "v9.9.9", "cli");

    expect(reports).toEqual([{
      status: "failed",
      error: "CLI update blocked: provider is checking for new work: codex; retry when all providers are idle",
    }]);
    expect(claudeState.claimsPaused).toBe(false);
    expect(codexState.claimsPaused).toBe(false);
    expect(codexState.pendingClaimCount).toBe(1);

    pendingClaim.resolve(null);
    await claimRun;
    expect(codexState.pendingClaimCount).toBe(0);
  });

  it("releases every provider claim pause when a CLI update fails", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    claudeState.updateRunner = () => {
      expect(claudeState.claimsPaused).toBe(true);
      expect(codexState.claimsPaused).toBe(true);
      throw new Error("binary replacement failed");
    };

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_failed", "v9.9.9", "cli");

    expect(reports).toEqual([
      { status: "running" },
      { status: "failed", error: "binary replacement failed" },
    ]);
    expect(claudeState.claimsPaused).toBe(false);
    expect(codexState.claimsPaused).toBe(false);
  });

  it("keeps agent and ACP updates independent from a busy sibling", async () => {
    for (const scope of ["agent", "acp"] as const) {
      const [claude, codex] = createDaemons();
      const claudeState = state(claude);
      const codexState = state(codex);
      const reports = captureReports(claudeState);
      let updateCalls = 0;
      claudeState.updateAgentCli = async () => {
        updateCalls++;
        return "agent updated";
      };
      claudeState.reinstallAcpBridge = () => {
        updateCalls++;
        return "bridge updated";
      };
      codexState.activeTaskCount = 1;

      await claudeState.handleRuntimeUpdate("rt_claude", `upd_${scope}`, "latest", scope);

      expect(updateCalls).toBe(1);
      expect(reports.map((report) => report.status)).toEqual(["running", "completed"]);
      expect(claudeState.claimsPaused).toBe(true);
      expect(codexState.claimsPaused).toBe(false);
    }
  });

  it("preserves the single-provider update gate when no coordinator is injected", async () => {
    const [daemon] = createDaemons(1);
    const daemonState = state(daemon);
    const reports = captureReports(daemonState);
    daemonState.activeTaskCount = 1;

    expect(daemonState.cliUpdateCoordinator).toBeNull();
    await daemonState.handleRuntimeUpdate("rt_claude", "upd_single", "v9.9.9", "cli");

    expect(reports).toEqual([{
      status: "failed",
      error: "daemon is busy; retry update when idle",
    }]);
    expect(daemonState.claimsPaused).toBe(false);
  });

  function createDaemons(count = 2): MultiremiDaemon[] {
    const root = mkdtempSync(join(tmpdir(), "multiremi-cli-update-coordinator-"));
    roots.push(root);
    return instantiateCoResidentWorkerDaemons([
      {
        serverUrl: "http://127.0.0.1:1",
        provider: "claude",
        workspacesRoot: root,
        repoCacheRoot: join(root, "repo-cache-claude"),
      },
      ...(count > 1
        ? [{
          serverUrl: "http://127.0.0.1:1",
          provider: "codex",
          workspacesRoot: root,
          repoCacheRoot: join(root, "repo-cache-codex"),
        }]
        : []),
    ]);
  }
});

function state(daemon: MultiremiDaemon | undefined): TestDaemonState {
  if (!daemon) throw new Error("Expected daemon");
  return daemon as unknown as TestDaemonState;
}

function captureReports(daemon: TestDaemonState): UpdateReport[] {
  const reports: UpdateReport[] = [];
  daemon.client = {
    reportRuntimeUpdateResult: async (_runtimeId, _requestId, report) => {
      reports.push(report);
    },
  };
  return reports;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}
