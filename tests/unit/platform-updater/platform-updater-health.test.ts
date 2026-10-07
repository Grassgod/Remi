import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import { DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS, resolveHealthTimeoutMs, waitForHealthyUrl } from "../../../packages/platform-updater/src/health-check.js";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import type { CommandRunner } from "@remi-platform/updater/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function operation(kind: "restart" | "update" = "restart"): MultiremiPlatformOperation {
  return { id: "health-test", kind, status: "preparing", driver: "docker_compose", targetVersion: "1.2.3", targetRef: "new", targetManifest: {
    version: "1.2.3", ref: "new", apiImage: `ghcr.io/test/api@sha256:${"a".repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${"b".repeat(64)}`,
  }, progress: {}, requestedBy: "tester", output: null, error: null, previousRelease: null, resultRelease: null,
    cancelRequested: false, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null };
}

function drivers(timeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "platform-health-")); roots.push(root);
  const envFile = join(root, "platform.env"); writeFileSync(envFile, "ORIGINAL=1\n");
  const commands: string[] = [];
  const runner: CommandRunner = { async run(command, args) {
    commands.push([command, ...args].join(" "));
    // Isolate URL deadline/rollback behavior from the API startup budget tests.
    if (args.includes("config")) return { exitCode: 0, stdout: '{"services":{"web":{}}}', stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  return {
    commands, envFile, root,
    compose: new DockerComposeDriver({ composeFile: join(root, "compose.yml"), envFile, stateDir: root,
      apiHealthUrl: "http://health.test/api", webHealthUrl: "http://health.test/web", extraHealthUrls: ["http://health.test/runtime"], healthTimeoutMs: timeoutMs }, runner),
    systemd: new SystemdReleaseDriver({ root, apiService: "api", webService: "web", bunExecutable: process.execPath,
      apiHealthUrl: "http://health.test/api", webHealthUrl: "http://health.test/web", healthTimeoutMs: timeoutMs }, runner),
  };
}

describe("platform health deadline", () => {
  it("allows readiness after both the old 60s window and the 300s migration budget", async () => {
    let clock = 0, probes = 0;
    await waitForHealthyUrl("http://health.test/api", DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS, {
      now: () => clock, sleep: async ms => { clock += ms; },
      request: async () => { probes++; return new Response(null, { status: clock >= 310_000 ? 200 : 503 }); },
    });
    expect(clock).toBe(310_000);
    expect(probes).toBe(125);
  });

  it("counts slow failed requests against the deadline and never sleeps past it", async () => {
    let clock = 0, probes = 0;
    await expect(waitForHealthyUrl("http://health.test/api", 20_000, {
      now: () => clock, sleep: async ms => { clock += ms; },
      request: async (_url, options) => { expect(options.signal).toBeInstanceOf(AbortSignal); probes++; clock += 5_000; throw new Error("connection refused"); },
    })).rejects.toThrow("within 20000ms: connection refused");
    expect(clock).toBe(20_000);
    expect(probes).toBe(3);
  });

  it("fails persistent HTTP errors at the finite default deadline", async () => {
    let clock = 0;
    await expect(waitForHealthyUrl("http://health.test/api", DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS, {
      now: () => clock, sleep: async ms => { clock += ms; }, request: async () => new Response(null, { status: 503 }),
    })).rejects.toThrow("within 360000ms: returned 503");
    expect(clock).toBe(360_000);
  });

  it("caps the last request and rejects success that arrives after the deadline", async () => {
    let clock = 0;
    const originalTimeout = AbortSignal.timeout;
    const budgets: number[] = [];
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => { budgets.push(ms); return originalTimeout(ms); });
    try {
      await expect(waitForHealthyUrl("http://health.test/api", 3_000, {
        now: () => clock, request: async () => { clock = 3_001; return new Response(null, { status: 200 }); },
      })).rejects.toThrow("readiness arrived after deadline");
      expect(budgets).toEqual([3_000]);
    } finally { timeout.mockRestore(); }
  });

  it("rejects invalid budgets before any deployment command", () => {
    expect(resolveHealthTimeoutMs(undefined)).toBe(360_000);
    for (const value of ["", "0", "-1", "1.5", "bad", Infinity]) expect(() => resolveHealthTimeoutMs(value)).toThrow("positive integer");
    expect(() => drivers(0)).toThrow("positive integer");
  });

  it("both drivers keep waiting past 60s and Compose also checks runtime readiness", async () => {
    let clock = 0;
    const hits = new Set<string>();
    const time = spyOn(performance, "now").mockImplementation(() => clock);
    const sleep = spyOn(Bun, "sleep").mockImplementation(async ms => { clock += Number(ms); return; });
    const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      hits.add(String(input)); return new Response(null, { status: clock >= 80_000 ? 200 : 503 });
    }, { preconnect: () => {} }));
    try {
      const bed = drivers();
      await bed.compose.execute(operation(), async () => {});
      expect(clock).toBeGreaterThanOrEqual(80_000);
      expect(hits.has("http://health.test/runtime")).toBe(true);
      clock = 0; hits.clear();
      await bed.systemd.execute(operation(), async () => {});
      expect(clock).toBeGreaterThanOrEqual(80_000);
      expect([...hits].sort()).toEqual(["http://health.test/api", "http://health.test/web"]);
    } finally { request.mockRestore(); sleep.mockRestore(); time.mockRestore(); }
  });

  it("Compose still restores the old images and env when readiness never succeeds", async () => {
    let clock = 0;
    const time = spyOn(performance, "now").mockImplementation(() => clock);
    const sleep = spyOn(Bun, "sleep").mockImplementation(async ms => { clock += Number(ms); return; });
    const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, { status: 503 }), { preconnect: () => {} }));
    try {
      const bed = drivers(10_000);
      writeFileSync(join(bed.root, "current-release.json"), JSON.stringify({ version: "1.2.2", ref: "old",
        apiImage: `ghcr.io/test/api@sha256:${"c".repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${"d".repeat(64)}` }));
      const originalEnv = `ORIGINAL=1\nREMI_API_IMAGE=ghcr.io/test/api@sha256:${"c".repeat(64)}\nREMI_WEB_IMAGE=ghcr.io/test/web@sha256:${"d".repeat(64)}\n`;
      writeFileSync(bed.envFile, originalEnv);
      await expect(bed.compose.execute(operation("update"), async () => {})).rejects.toThrow("within 10000ms");
      expect(readFileSync(bed.envFile, "utf8")).toBe(originalEnv);
      expect(bed.commands.filter(command => command.includes("up -d --no-deps")).length).toBe(2);
      expect(JSON.parse(readFileSync(join(bed.root, "current-release.json"), "utf8")).ref).toBe("old");
    } finally { request.mockRestore(); sleep.mockRestore(); time.mockRestore(); }
  });
});
