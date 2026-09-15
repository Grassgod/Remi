import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiDaemon } from "@multiremi/daemon.js";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const outcome of ["failed", "completed"] as const) {
  test(`co-resident poll loops survive a slow CLI update until it is ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-update-lifecycle-"));
    roots.push(root);
    let releaseInstall!: () => void;
    const installing = new Promise<void>((resolve) => { releaseInstall = resolve; });
    let updatePending = false;
    let updateStarted = false;
    const reports: Array<{ status: string; error?: string }> = [];
    const heartbeats = [0, 0];
    const claims = [0, 0];
    const exited = [false, false];
    let restarts = 0;
    const daemons: MultiremiDaemon[] = instantiateCoResidentWorkerDaemons(
      ["claude", "codex"].map((provider) => ({
        serverUrl: "http://127.0.0.1:1",
        runtimeId: `rt_${provider}`,
        provider,
        workspacesRoot: root,
        repoCacheRoot: join(root, `repo-cache-${provider}`),
        daemonPort: 0,
        pollIntervalMs: 5,
        gcEnabled: false,
        outboxPath: ":memory:",
        updateRunner: async () => {
          updateStarted = true;
          await installing;
          if (outcome === "failed") throw new Error("SDK version mismatch");
          return "verified and installed";
        },
        onRestartRequested: () => {
          restarts++;
          for (const daemon of daemons) daemon.stop();
        },
      })),
    );
    // Keep the real startup/readiness barrier, poll loops, update coordinator,
    // local health servers and teardown. Only external I/O is replaced.
    daemons.forEach((daemon, index) => Object.assign(daemon, {
      registerCurrentRuntime: async () => `rt_${index === 0 ? "claude" : "codex"}`,
      refreshWorkspaceRepos: async () => {},
      startRuntimeModelRefresh: () => {},
      reconcileRuntimeAgentPlugins: async () => {},
      client: {
        recoverOrphans: async () => {},
        heartbeatRuntime: async () => {
          heartbeats[index]++;
          if (index === 0 && updatePending) {
            updatePending = false;
            return { pending_update: { id: "upd_test", target_version: "v9.9.9", scope: "cli" } };
          }
          return {};
        },
        claimTask: async () => { claims[index]++; return null; },
        reportRuntimeUpdateResult: async (_runtime: string, _request: string, report: { status: string; error?: string }) => {
          reports.push(report);
        },
      },
    }));
    const runs = daemons.map((daemon, index) => daemon.start().finally(() => { exited[index] = true; }));
    try {
      await waitFor(() => claims.every((count) => count > 0), "both providers must poll before the update");
      updatePending = true;
      await waitFor(() => updateStarted, "installer must start");
      const pausedClaims = [...claims];
      const siblingHeartbeats = heartbeats[1]!;
      await waitFor(() => exited[1]! || heartbeats[1]! >= siblingHeartbeats + 2, "sibling must keep heartbeating during installation");
      expect(exited).toEqual([false, false]);
      expect(claims).toEqual(pausedClaims);
      for (const daemon of daemons) {
        const port = (daemon as unknown as { repoServerPort: number }).repoServerPort;
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await response.json()).toMatchObject({ status: "running", supervisor_ready: true });
      }

      releaseInstall();
      await waitFor(() => reports.some((report) => report.status === outcome), "update must report its outcome");
      if (outcome === "failed") {
        await waitFor(() => claims.every((count, index) => count > pausedClaims[index]!), "both providers must resume claims after failure");
        const afterFailure = [...heartbeats];
        await waitFor(() => heartbeats.every((count, index) => count > afterFailure[index]!), "both providers must keep heartbeating after failure");
        expect(exited).toEqual([false, false]);
        expect(restarts).toBe(0);
        expect(reports.at(-1)).toEqual({ status: "failed", error: "SDK version mismatch" });
      } else {
        await Promise.all(runs);
        expect(exited).toEqual([true, true]);
        expect(restarts).toBe(1);
        expect(daemons[0]!.restartRequested()).toBe(true);
        expect(claims).toEqual(pausedClaims);
      }
    } finally {
      releaseInstall();
      for (const daemon of daemons) daemon.stop();
      await Promise.allSettled(runs);
    }
  });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(5);
  }
}
