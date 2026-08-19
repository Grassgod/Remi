import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMultiremi,
  stopChannelWhenProvidersFinish,
  terminateUnreadyBackgroundProcess,
} from "../../../apps/remi/cli/multiremi.js";
import { waitForDaemonReady } from "../../../apps/remi/cli/multiremi/daemon-health.js";

describe("Multiremi CLI daemon lifecycle fence", () => {
  const servers: Bun.Server<unknown>[] = [];
  const roots: string[] = [];
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
    for (const server of servers.splice(0)) server.stop(true);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("aborts restart when the old daemon is still draining", async () => {
    let shutdowns = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") {
          return Response.json({
            status: "running",
            pid: process.pid,
            active_task_count: 1,
          });
        }
        if (path === "/shutdown" && request.method === "POST") {
          shutdowns++;
          return Response.json({ status: "shutting_down" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    console.error = () => {};

    await expect(runMultiremi([
      "daemon",
      "restart",
      "--daemon-port",
      String(server.port),
      "--shutdown-timeout-ms",
      "20",
    ], { programName: "multiremi" })).rejects.toThrow("No replacement daemon was started");
    expect(shutdowns).toBe(1);
  });

  it("fails daemon stop instead of reporting success while draining", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") {
          return Response.json({ status: "starting", pid: process.pid, active_task_count: 0 });
        }
        if (path === "/shutdown" && request.method === "POST") {
          return Response.json({ status: "shutting_down" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    console.error = () => {};

    await expect(runMultiremi([
      "daemon",
      "stop",
      "--daemon-port",
      String(server.port),
      "--shutdown-timeout-ms",
      "20",
    ], { programName: "multiremi" })).rejects.toThrow("still draining");
  });

  it("validates the graceful shutdown timeout", async () => {
    await expect(runMultiremi([
      "daemon",
      "stop",
      "--daemon-port",
      "0",
      "--shutdown-timeout-ms",
      "0",
    ], { programName: "multiremi" })).rejects.toThrow("must be a positive integer");
  });

  it("does not treat one ready provider as supervisor readiness", async () => {
    let supervisorReady = false;
    let reportedPid: number | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          status: "running",
          supervisor_ready: supervisorReady,
          pid: reportedPid,
          provider: "claude",
        });
      },
    });
    servers.push(server);
    const port = server.port;
    if (port === undefined) throw new Error("Expected test server port");

    const partial = await waitForDaemonReady(port, 25);
    expect(partial).toMatchObject({ status: "running", supervisor_ready: false });

    supervisorReady = true;
    const complete = await waitForDaemonReady(port, 25);
    expect(complete).toMatchObject({ status: "running", supervisor_ready: true });

    const wrongProcess = await waitForDaemonReady(port, 25, {
      expectedPid: process.pid,
      requireSupervisorReady: true,
    });
    expect(wrongProcess.pid).toBeUndefined();

    reportedPid = process.pid;
    const owned = await waitForDaemonReady(port, 25, {
      expectedPid: process.pid,
      requireSupervisorReady: true,
    });
    expect(owned).toMatchObject({
      status: "running",
      supervisor_ready: true,
      pid: process.pid,
    });
  });

  it("stops a co-resident channel after every provider exits cleanly", async () => {
    let finishClaude!: () => void;
    let finishCodex!: () => void;
    const claude = new Promise<void>((resolve) => { finishClaude = resolve; });
    const codex = new Promise<void>((resolve) => { finishCodex = resolve; });
    let stops = 0;
    stopChannelWhenProvidersFinish([claude, codex], {
      stop: async () => { stops++; },
    });

    finishClaude();
    await Promise.resolve();
    expect(stops).toBe(0);
    finishCodex();
    await Promise.resolve();
    await Promise.resolve();
    expect(stops).toBe(1);
  });

  it("terminates and reaps an unready background supervisor before removing its PID file", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-unready-child-"));
    roots.push(root);
    const pidPath = join(root, "multiremi.pid");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Expected spawned child PID");
    writeFileSync(pidPath, `${child.pid}\n`);

    await terminateUnreadyBackgroundProcess(child, pidPath, 2_000);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("sweeps a detached ACP-style descendant before acknowledging startup cleanup", async () => {
    if (process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "multiremi-unready-tree-"));
    roots.push(root);
    const pidPath = join(root, "multiremi.pid");
    const descendantPath = join(root, "descendant.pid");
    const supervisorInstanceId = `test-${process.pid}-${Date.now()}`;
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      "child.unref();",
      `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: "ignore",
      env: {
        ...process.env,
        MULTIREMI_SUPERVISOR_INSTANCE_ID: supervisorInstanceId,
      },
    });
    if (!parent.pid) throw new Error("Expected spawned supervisor PID");
    writeFileSync(pidPath, `${parent.pid}\n`);
    try {
      const deadline = Date.now() + 2_000;
      while (!existsSync(descendantPath) && Date.now() < deadline) await Bun.sleep(20);
      const descendantPid = Number(readFileSync(descendantPath, "utf8"));
      expect(descendantPid).toBeGreaterThan(0);

      await terminateUnreadyBackgroundProcess(parent, pidPath, 300, supervisorInstanceId);

      expect(processAlive(descendantPid)).toBe(false);
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      try { parent.kill("SIGKILL"); } catch {}
      if (existsSync(descendantPath)) {
        const descendantPid = Number(readFileSync(descendantPath, "utf8"));
        try { process.kill(-descendantPid, "SIGKILL"); } catch {}
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      }
    }
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
