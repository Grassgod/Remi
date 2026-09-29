import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiDaemon } from "@multiremi/daemon.js";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import type { DaemonProtocolConnect } from "@multiremi/worker/daemon-protocol-client.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const outcome of ["failed", "completed"] as const) {
  test(`co-resident offers survive a slow CLI update until it is ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-update-lifecycle-"));
    roots.push(root);
    let releaseInstall!: () => void;
    const installing = new Promise<void>((resolve) => { releaseInstall = resolve; });
    let updateStarted = false;
    const reports: Array<{ status: string; error?: string }> = [];
    const heartbeats = [0, 0];
    const replies = new Map<string, { ok: boolean; code?: string }>();
    let push!: (frame: Record<string, unknown>) => void;
    const clock = new ManualDaemonProtocolClock();
    const connect: DaemonProtocolConnect = () => {
      const listeners = new Map<string, Set<(event: any) => void>>();
      let closed = false;
      const emit = (type: string, event: any) => { if (!closed) for (const handler of [...listeners.get(type) ?? []]) handler(event); };
      push = frame => emit("message", { data: JSON.stringify({ v: 2, ...frame }) });
      const socket = {
        bufferedAmount: 0,
        send: (text: string) => {
          const frame = JSON.parse(text);
          if (frame.t === "res") replies.set(frame.re, frame.p);
          if (frame.t !== "hb") return;
          heartbeats[0]++; heartbeats[1]++;
          queueMicrotask(() => emit("message", { data: JSON.stringify({ v: 2, t: "res", re: frame.id, p: { runtime_acks: ["claude", "codex"].map(provider => ({ runtime_id: `rt_${provider}`, status: "ok" })) } }) }));
        },
        close: () => { closed = true; },
        addEventListener: (type: string, handler: (event: any) => void) => {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)!.add(handler);
        },
        removeEventListener: (type: string, handler: (event: any) => void) => { listeners.get(type)?.delete(handler); },
      };
      queueMicrotask(() => {
        emit("open", {});
        emit("message", { data: JSON.stringify({ v: 2, t: "welcome", p: { protocol: 2, session_id: "unit-update" } }) });
      });
      return socket;
    };
    const claims = [0, 0];
    const handled = [0, 0];
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
        protocolClientOptions: { clock, connect },
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
      handleTask: async () => { handled[index]++; },
      client: {
        recoverOrphans: async () => {},
        claimTask: async () => { claims[index]++; return null; },
        reportRuntimeUpdateResult: async (_runtime: string, _request: string, report: { status: string; error?: string }) => {
          reports.push(report);
        },
      },
    }));
    const runs = daemons.map((daemon, index) => daemon.start().finally(() => { exited[index] = true; }));
    let sequence = 0;
    const offer = async (index: number) => {
      const provider = index === 0 ? "claude" : "codex";
      const seq = ++sequence;
      push({ t: "task.offer", seq, rt: `rt_${provider}`, p: {
        id: `tsk_lifecycle_${seq}`, runtime_id: `rt_${provider}`, agent_id: "agt_lifecycle",
        prompt: "no-op", agent: { provider },
      } });
      await waitFor(() => replies.has(String(seq)), "offer must be answered while an update is running");
      return replies.get(String(seq));
    };
    let update: Promise<void> | undefined;
    try {
      await waitFor(() => heartbeats.every(count => count > 0), "both providers must connect before the update");
      expect(await offer(0)).toEqual({ ok: true });
      expect(await offer(1)).toEqual({ ok: true });
      expect(handled).toEqual([1, 1]);
      push({ t: "runtime.update", rt: "rt_claude", seq: ++sequence,
        p: { id: "upd_test", target_version: "v9.9.9", scope: "cli" } });
      update = daemons[0]!.daemonProtocolClient().drain();
      await waitFor(() => updateStarted, "installer must start");
      const pausedHandled = [...handled];
      expect(await offer(0)).toEqual({ ok: false, code: "claims_paused" });
      expect(await offer(1)).toEqual({ ok: false, code: "claims_paused" });
      const siblingHeartbeats = heartbeats[1]!;
      clock.advance(15_000);
      await waitFor(() => heartbeats[1]! > siblingHeartbeats, "heartbeat must continue during installation");
      clock.advance(15_000);
      await waitFor(() => exited[1]! || heartbeats[1]! >= siblingHeartbeats + 2, "sibling must keep heartbeating during installation");
      expect(exited).toEqual([false, false]);
      expect(handled).toEqual(pausedHandled);
      expect(claims).toEqual([0, 0]);
      for (const daemon of daemons) {
        const port = (daemon as unknown as { repoServerPort: number }).repoServerPort;
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await response.json()).toMatchObject({ status: "running", supervisor_ready: true });
      }

      releaseInstall();
      await update;
      await waitFor(() => reports.some((report) => report.status === outcome), "update must report its outcome");
      if (outcome === "failed") {
        expect(await offer(0)).toEqual({ ok: true });
        expect(await offer(1)).toEqual({ ok: true });
        expect(handled).toEqual([2, 2]);
        const afterFailure = [...heartbeats];
        clock.advance(15_000);
        await waitFor(() => heartbeats.every((count, index) => count > afterFailure[index]!), "both providers must keep heartbeating after failure");
        expect(exited).toEqual([false, false]);
        expect(restarts).toBe(0);
        expect(reports.at(-1)).toEqual({ status: "failed", error: "SDK version mismatch" });
      } else {
        await Promise.all(runs);
        expect(exited).toEqual([true, true]);
        expect(restarts).toBe(1);
        expect(daemons[0]!.restartRequested()).toBe(true);
        expect(handled).toEqual(pausedHandled);
      }
      expect(claims).toEqual([0, 0]);
    } finally {
      releaseInstall();
      for (const daemon of daemons) daemon.stop();
      await update;
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
