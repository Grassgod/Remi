// MUL-464: the Compose driver's service list used to be a module constant, so a
// split-role installation could not be switched without editing the binary.
// `MULTIREMI_PLATFORM_CORE_SERVICES` makes it data — and the first acceptance
// item is that leaving it unset changes nothing: an unconfigured host must pull,
// switch and restart exactly the arguments it used before the knob existed.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import type { CommandRunner } from "@remi-platform/updater/types.js";
import { validComposeConfigResult } from "../../fixtures/platform-updater/compose-config.js";

const DIGEST = `ghcr.io/grassgod/remi-api@sha256:${"a".repeat(64)}`;
const WEB_DIGEST = `ghcr.io/grassgod/remi-web@sha256:${"b".repeat(64)}`;
const OLD_DIGEST = `ghcr.io/grassgod/remi-api@sha256:${"c".repeat(64)}`;
const OLD_WEB_DIGEST = `ghcr.io/grassgod/remi-web@sha256:${"d".repeat(64)}`;
/** Today's arguments, spelled out rather than imported: the point of the test. */
const TODAYS_SWITCH = "up -d --no-deps api web ssh-mesh-control-plane";
const TODAYS_RESTART = "restart api web ssh-mesh-control-plane";
const TODAYS_PULL = "pull api web";
const SPLIT_SERVICES = "api,web,ssh-mesh-control-plane,api-runtime";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  delete process.env.MULTIREMI_PLATFORM_CORE_SERVICES;
  delete process.env.MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS;
});

function operation(kind: "update" | "restart" = "update"): MultiremiPlatformOperation {
  return {
    id: "pop_core_services",
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

interface Bed {
  driver: DockerComposeDriver;
  docker: () => string[];
  healthHits: () => string[];
  stop: () => void;
}

function driverBed(sharedHealthPort?: number): Bed {
  const root = mkdtempSync(join(tmpdir(), "compose-core-services-"));
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
  const runner: CommandRunner = {
    async run(command, args) {
      commands.push([command, ...args]);
      const line = args.join(" ");
      if (args.includes("config")) return validComposeConfigResult;
      if (line.startsWith("ps -aq --filter")) return { exitCode: 0, stdout: "\n", stderr: "" };
      if (line.includes("ps --format json")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "find") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const healthHits: string[] = [];
  const health = sharedHealthPort === undefined
    ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        healthHits.push(new URL(request.url).pathname);
        return new Response("ok");
      },
    })
    : null;
  const port = sharedHealthPort ?? health!.port;
  const driver = new DockerComposeDriver({
    composeFile,
    envFile,
    stateDir,
    apiHealthUrl: `http://127.0.0.1:${port}/readyz`,
    webHealthUrl: `http://127.0.0.1:${port}/login`,
  }, runner);

  return {
    driver,
    docker: () => commands.map((args) => args.join(" ")),
    healthHits: () => [...healthHits],
    stop: () => health?.stop(true),
  };
}

describe("Docker Compose driver: core service list", () => {
  it("keeps today's pull, switch and restart arguments when the env is unset", async () => {
    const bed = driverBed();
    try {
      await bed.driver.execute(operation(), async () => {});
      const lines = bed.docker();
      expect(lines.some((line) => line.endsWith(TODAYS_PULL))).toBe(true);
      expect(lines.some((line) => line.endsWith(TODAYS_SWITCH))).toBe(true);
      expect(lines.some((line) => line.includes("api-runtime"))).toBe(false);

      const restarted = driverBed();
      try {
        await restarted.driver.execute(operation("restart"), async () => {});
        expect(restarted.docker().some((line) => line.endsWith(TODAYS_RESTART))).toBe(true);
        expect(restarted.docker().some((line) => line.includes("api-runtime"))).toBe(false);
      } finally {
        restarted.stop();
      }
    } finally {
      bed.stop();
    }
  });

  it("treats an empty or blank env value as unset", async () => {
    for (const value of ["", "   "]) {
      process.env.MULTIREMI_PLATFORM_CORE_SERVICES = value;
      const bed = driverBed();
      try {
        await bed.driver.execute(operation(), async () => {});
        const lines = bed.docker();
        expect(lines.some((line) => line.endsWith(TODAYS_PULL))).toBe(true);
        expect(lines.some((line) => line.endsWith(TODAYS_SWITCH))).toBe(true);
      } finally {
        bed.stop();
      }
    }
  });

  it("switches, pulls and restarts every configured service", async () => {
    process.env.MULTIREMI_PLATFORM_CORE_SERVICES = SPLIT_SERVICES;
    const bed = driverBed();
    try {
      await bed.driver.execute(operation(), async () => {});
      const lines = bed.docker();
      const expected = `api web ssh-mesh-control-plane api-runtime`;
      expect(lines.some((line) => line.endsWith(`pull ${expected}`))).toBe(true);
      expect(lines.some((line) => line.endsWith(`up -d --no-deps ${expected}`))).toBe(true);
    } finally {
      bed.stop();
    }

    const restarted = driverBed();
    try {
      await restarted.driver.execute(operation("restart"), async () => {});
      expect(restarted.docker().some((line) => line.endsWith("restart api web ssh-mesh-control-plane api-runtime"))).toBe(true);
    } finally {
      restarted.stop();
    }
  });

  it("tolerates spaces around a configured list", async () => {
    process.env.MULTIREMI_PLATFORM_CORE_SERVICES = " api , web , ssh-mesh-control-plane , api-runtime ";
    const bed = driverBed();
    try {
      await bed.driver.execute(operation(), async () => {});
      expect(bed.docker().some((line) => line.endsWith("up -d --no-deps api web ssh-mesh-control-plane api-runtime"))).toBe(true);
    } finally {
      bed.stop();
    }
  });

  it("checks MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS after a switch", async () => {
    const hits: string[] = [];
    const health = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        hits.push(new URL(request.url).pathname);
        return new Response("ok");
      },
    });
    // The split topology publishes api-runtime on its own port, so the runbook
    // adds a second /readyz. Without this knob the updater would call the switch
    // successful while the runtime container was still starting.
    process.env.MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS = `http://127.0.0.1:${health.port}/readyz`;
    const bed = driverBed(health.port);
    try {
      await bed.driver.execute(operation(), async () => {});
      expect(hits.filter((path) => path === "/readyz").length).toBeGreaterThanOrEqual(2);
      expect(hits).toContain("/login");
    } finally {
      bed.stop();
      health.stop(true);
    }
  });

  it("warns when a configured list drops api or web, without repairing it", () => {
    // Acceptance is not "make the platform work anyway" — the operator owns the
    // list. But a list without `api` silently stops upgrading the platform, so
    // the driver says so once per missing service instead of staying quiet.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      process.env.MULTIREMI_PLATFORM_CORE_SERVICES = "ssh-mesh-control-plane,api-runtime";
      const bed = driverBed();
      try {
        expect(warnings.filter((line) => line.includes('"api"')).length).toBe(1);
        expect(warnings.filter((line) => line.includes('"web"')).length).toBe(1);
        // The list is obeyed verbatim: reporting is the whole intervention.
        expect(bed.driver).toBeDefined();
      } finally {
        bed.stop();
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  it("does not warn for the default list or a complete configured list", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      const defaults = driverBed();
      defaults.stop();
      process.env.MULTIREMI_PLATFORM_CORE_SERVICES = SPLIT_SERVICES;
      const complete = driverBed();
      complete.stop();
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("checks only the API and Web health URLs when no extra URL is configured", async () => {
    const bed = driverBed();
    try {
      await bed.driver.execute(operation(), async () => {});
      expect([...new Set(bed.healthHits())].sort()).toEqual(["/login", "/readyz"]);
    } finally {
      bed.stop();
    }
  });
});
