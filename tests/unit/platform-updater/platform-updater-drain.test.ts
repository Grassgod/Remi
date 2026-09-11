// MUL-74: the drain gate between image pull and container switch.
// The hard invariants: on timeout or cancel the switch NEVER runs, the env
// file is restored, and the drain is released; the lease is re-acquired if
// lost mid-wait; on the happy path the switch only runs after ready.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiPlatformOperation, ReportPlatformOperationInput } from "@multiremi/contracts";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import {
  DrainCancelledError,
  DrainTimeoutError,
  PlatformDrainCoordinator,
  resolveDrainTimeoutMs,
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
const OLD_DIGEST = `ghcr.io/grassgod/remi-api@sha256:${"c".repeat(64)}`;
const OLD_WEB_DIGEST = `ghcr.io/grassgod/remi-web@sha256:${"d".repeat(64)}`;

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
  it.each([undefined, "", "0", 0, "invalid", "Infinity", "-1", -1, Number.NaN])(
    "resolves %s to an unlimited task wait",
    (value) => {
      expect(resolveDrainTimeoutMs(value)).toBe(0);
    },
  );

  it.each([900_000, "900000"])("preserves an explicit finite deadline of %s ms", (value) => {
    expect(resolveDrainTimeoutMs(value)).toBe(900_000);
  });

  it.each([undefined, 0])("keeps waiting for hours with timeoutMs=%s while renewing the recovery lease", async (timeoutMs) => {
    const fake = fakeDrainClient([
      renewResponse({ active_tasks: 1 }),
      renewResponse({ active_tasks: 1 }),
      renewResponse({ active_tasks: 1 }),
      renewResponse({ ready: true }),
    ]);
    const reports: ReportPlatformOperationInput[] = [];
    let clock = 0;
    const coordinator = new PlatformDrainCoordinator(fake.client, "pop_test", {
      timeoutMs,
      sleep: async () => { clock += 2 * 60 * 60_000; },
      now: () => clock,
    });
    await coordinator.waitUntilDrained(async (input) => { reports.push(input); });

    expect(fake.renews).toBe(4);
    expect(fake.releases).toBe(0);
    expect(reports.map((report) => (report.progress as any).drain.state)).toEqual([
      "waiting", "waiting", "waiting", "ready",
    ]);
    expect((reports.at(-1)?.progress as any).drain).toMatchObject({
      waited_ms: 6 * 60 * 60_000,
      timeout_ms: 0,
    });
  });

  it("still releases an unlimited wait when the operator cancels after hours", async () => {
    const fake = fakeDrainClient([
      renewResponse({ active_tasks: 1 }),
      renewResponse({ active_tasks: 1 }),
      renewResponse({ active_tasks: 1 }, true),
    ]);
    let clock = 0;
    const coordinator = new PlatformDrainCoordinator(fake.client, "pop_test", {
      sleep: async () => { clock += 2 * 60 * 60_000; },
      now: () => clock,
    });
    await expect(coordinator.waitUntilDrained(async () => {})).rejects.toThrow(DrainCancelledError);
    expect(clock).toBe(4 * 60 * 60_000);
    expect(fake.releases).toBe(1);
  });

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
  function driverBed(options: { failFirstSwitch?: boolean } = {}): {
    driver: DockerComposeDriver;
    commands: string[][];
    envFile: string;
    stateDir: string;
  } {
    // Paths containing command names must not be mistaken for argv tokens.
    const root = mkdtempSync(join(tmpdir(), "compose-drain-up-pull-"));
    tempDirs.push(root);
    const envFile = join(root, "platform.env");
    writeFileSync(envFile, `REMI_API_IMAGE=${OLD_DIGEST}\nREMI_WEB_IMAGE=${OLD_WEB_DIGEST}\n`);
    const composeFile = join(root, "compose.yaml");
    writeFileSync(composeFile, "services: {}\n");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "current-release.json"), JSON.stringify({
      version: "1.2.2",
      ref: "previous-ref",
      publishedAt: new Date(0).toISOString(),
      apiImage: OLD_DIGEST,
      webImage: OLD_WEB_DIGEST,
    }));
    const commands: string[][] = [];
    let switches = 0;
    const runner: CommandRunner = {
      async run(command, args) {
        commands.push([command, ...args]);
        if (args.includes("up")) {
          switches += 1;
          if (options.failFirstSwitch && switches === 1) {
            return { exitCode: 1, stdout: "", stderr: "simulated switch failure" };
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const driver = new DockerComposeDriver({
      composeFile,
      envFile,
      stateDir,
      apiHealthUrl: "http://127.0.0.1:1/readyz",
      webHealthUrl: "http://127.0.0.1:1/login",
    }, runner);
    return { driver, commands, envFile, stateDir };
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
    expect(commands.some((args) => args.includes("compose") && args.includes("pull"))).toBe(true);
    // The switch (and any rollback recreate) never ran.
    expect(commands.some((args) => args.includes("up"))).toBe(false);
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
    expect(commands.some((args) => args.includes("up"))).toBe(false);
    expect(readFileSync(envFile, "utf8")).toBe(originalEnv);
  });

  it("runs the switch only after the gate opens (pull → drain → up ordering)", async () => {
    const { driver, commands } = driverBed();
    const order: string[] = [];
    const gate: PlatformDrainGate = {
      waitUntilDrained: async () => {
        order.push("drain");
        // Nothing may have switched before the gate resolves.
        expect(commands.some((args) => args.includes("up"))).toBe(false);
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
      const pullIndex = commands.findIndex((args) => args.includes("pull"));
      const upIndex = commands.findIndex((args) => args.some((arg, index) => arg === "up" && args[index + 1] === "-d"));
      expect(pullIndex).toBeGreaterThanOrEqual(0);
      expect(upIndex).toBeGreaterThan(pullIndex);
    } finally {
      health.stop(true);
    }
  });

  it("restores the previous images before reporting a failed switch", async () => {
    const { driver, commands, envFile } = driverBed({ failFirstSwitch: true });
    const originalEnv = readFileSync(envFile, "utf8");
    const health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const reports: ReportPlatformOperationInput[] = [];
    try {
      const bed = driver as unknown as { config: { apiHealthUrl: string; webHealthUrl: string } };
      bed.config.apiHealthUrl = `http://127.0.0.1:${health.port}/readyz`;
      bed.config.webHealthUrl = `http://127.0.0.1:${health.port}/login`;
      await expect(driver.execute(operation(), async (input) => {
        if (input.status === "rolling_back") {
          expect(commands.filter((args) => args.includes("up"))).toHaveLength(2);
          expect(readFileSync(envFile, "utf8")).toBe(originalEnv);
        }
        reports.push(input);
      })).rejects.toThrow("simulated switch failure");
      expect(reports.map((report) => report.status)).toEqual(["pulling", "switching", "rolling_back"]);
    } finally {
      health.stop(true);
    }
  });
});
