// MUL-74: the drain gate between image pull and container switch.
// The hard invariants: on timeout or cancel the switch NEVER runs, the env
// file is restored, and the drain is released; the lease is re-acquired if
// lost mid-wait; on the happy path the switch only runs after ready.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiPlatformOperation, ReportPlatformOperationInput } from "@multiremi/contracts";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import {
  DrainCancelledError,
  DrainTimeoutError,
  PlatformDrainCoordinator,
  type PlatformDrainGate,
} from "@remi-platform/updater/drain.js";
import { PlatformDrainLostError, type PlatformDrainRenewResponse, type PlatformUpdaterClient } from "@remi-platform/updater/client.js";
import type { CommandRunner } from "@remi-platform/updater/types.js";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

const DIGEST = `ghcr.io/grassgod/remi-api@sha256:${"a".repeat(64)}`;
const WEB_DIGEST = `ghcr.io/grassgod/remi-web@sha256:${"b".repeat(64)}`;

function operation(kind: "update" | "rollback" = "update"): MultiremiPlatformOperation {
  return {
    id: "pop_test",
    kind,
    status: "preparing",
    driver: "docker_compose",
    targetVersion: "1.2.3",
    targetRef: "ref",
    targetManifest: { version: "1.2.3", ref: "ref", apiImage: DIGEST, webImage: WEB_DIGEST },
    progress: {},
    requestedBy: "tester",
    output: null,
    error: null,
    previousRelease: null,
    resultRelease: null,
    cancelRequested: false,
    createdAt: "",
    updatedAt: "",
    startedAt: null,
    finishedAt: null,
  };
}

function renewResponse(overrides: Partial<PlatformDrainRenewResponse["status"]> = {}, cancel = false): PlatformDrainRenewResponse {
  return {
    maintenance: { mode: "draining", generation: 1, operationId: "pop_test", startedAt: null, expiresAt: null, reason: null },
    status: {
      generation: 1,
      mode: "draining",
      online_daemons: 2,
      acked_daemons: 2,
      active_tasks: 0,
      pending_runtimes: [],
      ready: false,
      ...overrides,
    },
    cancel_requested: cancel,
  };
}

interface FakeDrainClient {
  begins: number;
  renews: number;
  releases: number;
  client: PlatformUpdaterClient;
}

function fakeDrainClient(renewSequence: Array<PlatformDrainRenewResponse | PlatformDrainLostError>): FakeDrainClient {
  const state: FakeDrainClient = { begins: 0, renews: 0, releases: 0, client: null as unknown as PlatformUpdaterClient };
  state.client = {
    drainBegin: async () => {
      state.begins += 1;
    },
    drainRenew: async () => {
      const next = renewSequence[Math.min(state.renews, renewSequence.length - 1)]!;
      state.renews += 1;
      if (next instanceof PlatformDrainLostError) throw next;
      return next;
    },
    drainRelease: async () => {
      state.releases += 1;
    },
  } as unknown as PlatformUpdaterClient;
  return state;
}

describe("PlatformDrainCoordinator", () => {
  it("waits until ready, reporting progress, and keeps the drain held on success", async () => {
    const fake = fakeDrainClient([
      renewResponse({ acked_daemons: 1, active_tasks: 2 }),
      renewResponse({ active_tasks: 1 }),
      renewResponse({ ready: true }),
    ]);
    const reports: ReportPlatformOperationInput[] = [];
    const coordinator = new PlatformDrainCoordinator(fake.client, "pop_test", {
      timeoutMs: 60_000,
      pollMs: 1,
      sleep: async () => {},
    });
    await coordinator.waitUntilDrained(async (input) => {
      reports.push(input);
    });
    expect(fake.begins).toBe(1);
    expect(fake.releases).toBe(0);
    expect(reports.every((report) => report.status === "draining")).toBe(true);
    const drains = reports.map((report) => (report.progress as any).drain);
    expect(drains[0]).toMatchObject({ acked_daemons: 1, active_tasks: 2, state: "waiting" });
    expect(drains.at(-1)).toMatchObject({ state: "ready" });
  });

  it("times out without switching: releases the drain and reports the timeout", async () => {
    const fake = fakeDrainClient([renewResponse({ active_tasks: 3 })]);
    const reports: ReportPlatformOperationInput[] = [];
    let clock = 0;
    const coordinator = new PlatformDrainCoordinator(fake.client, "pop_test", {
      timeoutMs: 10_000,
      pollMs: 1,
      sleep: async () => {
        clock += 6_000;
      },
      now: () => clock,
    });
    await expect(coordinator.waitUntilDrained(async (input) => {
      reports.push(input);
    })).rejects.toThrow(DrainTimeoutError);
    expect(fake.releases).toBe(1);
    expect((reports.at(-1)?.progress as any).drain).toMatchObject({ state: "timeout" });
  });

  it("honors operator cancellation before the switch and releases the drain", async () => {
    const fake = fakeDrainClient([renewResponse({}, true)]);
    const coordinator = new PlatformDrainCoordinator(fake.client, "pop_test", { pollMs: 1, sleep: async () => {} });
    await expect(coordinator.waitUntilDrained(async () => {})).rejects.toThrow(DrainCancelledError);
    expect(fake.releases).toBe(1);
  });

  it("re-acquires the drain when the lease was lost mid-wait", async () => {
    const fake = fakeDrainClient([
      new PlatformDrainLostError("lost"),
      renewResponse({ ready: true }),
    ]);
    const coordinator = new PlatformDrainCoordinator(fake.client, "pop_test", { pollMs: 1, sleep: async () => {} });
    await coordinator.waitUntilDrained(async () => {});
    // Initial begin + the re-begin after the lost lease.
    expect(fake.begins).toBe(2);
  });
});

describe("DockerComposeDriver drain gating", () => {
  function driverBed(): { driver: DockerComposeDriver; commands: string[][]; envFile: string; stateDir: string } {
    const root = mkdtempSync(join(tmpdir(), "compose-drain-"));
    tempDirs.push(root);
    const envFile = join(root, "platform.env");
    writeFileSync(envFile, "REMI_API_IMAGE=old-api\nREMI_WEB_IMAGE=old-web\n");
    const composeFile = join(root, "compose.yaml");
    writeFileSync(composeFile, "services: {}\n");
    const commands: string[][] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        commands.push([command, ...args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const driver = new DockerComposeDriver({
      composeFile,
      envFile,
      stateDir: join(root, "state"),
      apiHealthUrl: "http://127.0.0.1:1/readyz",
      webHealthUrl: "http://127.0.0.1:1/login",
    }, runner);
    return { driver, commands, envFile, stateDir: join(root, "state") };
  }

  it("drain timeout aborts before the switch: pull ran, up never did, env restored, no rollback recreate", async () => {
    const { driver, commands, envFile } = driverBed();
    const originalEnv = readFileSync(envFile, "utf8");
    const gate: PlatformDrainGate = {
      waitUntilDrained: async () => {
        throw new DrainTimeoutError(null, 10_000);
      },
      release: async () => {},
    };
    await expect(driver.execute(operation(), async () => {}, gate)).rejects.toThrow(DrainTimeoutError);
    const joined = commands.map((args) => args.join(" "));
    expect(joined.some((line) => line.includes("compose") && line.includes("pull"))).toBe(true);
    // The switch (and any rollback recreate) never ran.
    expect(joined.some((line) => line.includes("up"))).toBe(false);
    // The staged image digests were rolled back on disk.
    expect(readFileSync(envFile, "utf8")).toBe(originalEnv);
  });

  it("cancellation behaves like timeout: no switch, env restored", async () => {
    const { driver, commands, envFile } = driverBed();
    const originalEnv = readFileSync(envFile, "utf8");
    const gate: PlatformDrainGate = {
      waitUntilDrained: async () => {
        throw new DrainCancelledError();
      },
      release: async () => {},
    };
    await expect(driver.execute(operation(), async () => {}, gate)).rejects.toThrow(DrainCancelledError);
    expect(commands.map((args) => args.join(" ")).some((line) => line.includes("up"))).toBe(false);
    expect(readFileSync(envFile, "utf8")).toBe(originalEnv);
  });

  it("runs the switch only after the gate opens (pull → drain → up ordering)", async () => {
    const { driver, commands } = driverBed();
    const order: string[] = [];
    const gate: PlatformDrainGate = {
      waitUntilDrained: async () => {
        order.push("drain");
        // Nothing may have switched before the gate resolves.
        expect(commands.map((args) => args.join(" ")).some((line) => line.includes("up"))).toBe(false);
      },
      release: async () => {},
    };
    // Health verification hits real URLs; give it a live endpoint.
    const health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      const bed = driver as unknown as { config: { apiHealthUrl: string; webHealthUrl: string } };
      bed.config.apiHealthUrl = `http://127.0.0.1:${health.port}/readyz`;
      bed.config.webHealthUrl = `http://127.0.0.1:${health.port}/login`;
      const release = await driver.execute(operation(), async () => {}, gate);
      expect(order).toEqual(["drain"]);
      expect(release?.version).toBe("1.2.3");
      const joined = commands.map((args) => args.join(" "));
      const pullIndex = joined.findIndex((line) => line.includes("pull"));
      const upIndex = joined.findIndex((line) => line.includes("up -d"));
      expect(pullIndex).toBeGreaterThanOrEqual(0);
      expect(upIndex).toBeGreaterThan(pullIndex);
    } finally {
      health.stop(true);
    }
  });
});
