import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiPlatformOperation, ReportPlatformOperationInput } from "@multiremi/contracts";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import type { CommandRunner } from "@remi-platform/updater/types.js";
import { parseComposeDurationMs, validateComposeStartupBudgets } from "../../../packages/platform-updater/src/startup-budget.js";

const options = { coreServices: ["api", "web", "api-runtime"], healthTimeoutMs: 360_000, composeFile: "/host/compose.application.yml" };
const enabledHealth = { test: ["CMD", "probe"], start_period: "360s" };
const service = (healthcheck: unknown = enabledHealth, budget?: unknown) => ({
  healthcheck, environment: budget === undefined ? {} : { MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS: budget },
});
const validate = (api: unknown, override: Partial<typeof options> = {}) =>
  validateComposeStartupBudgets({ services: { api } }, { ...options, ...override });

describe("Compose Go duration parsing", () => {
  it("parses compound, fractional and subsecond units without guessing", () => {
    for (const [source, expected] of [
      ["10s", 10_000], ["6m0s", 360_000], ["1m30s", 90_000], ["500ms", 500],
      ["1h0m0s", 3_600_000], ["1.5m", 90_000], [".5s", 500], ["1.s", 1_000],
      ["1s500ms", 1_500], ["1us", 0.001], ["1\u00b5s", 0.001], ["1\u03bcs", 0.001],
      ["1ns", 0.000001], ["0", 0], ["0s", 0], ["+6m", 360_000],
    ] as const) expect(parseComposeDurationMs(source), source).toBe(expected);
  });

  it("rejects malformed, negative, unitless, nonstring and overflowing durations", () => {
    for (const source of ["", "360", "6 minutes", "1d", "1m 30s", "-1s", "1e3s", "NaNs", "1m30", "1S", " 360s", "360s\n", "1..5s", "999999999999999999h", 360, null]) {
      expect(parseComposeDurationMs(source), String(source)).toBeNull();
    }
  });
});

describe("Compose startup budget validation", () => {
  it("rejects the 209 configuration with no start_period", () => {
    expect(() => validate(service({ test: ["CMD", "probe"] }))).toThrow("start_period=0ms must be >= 360000ms");
  });

  it("accepts both templates' default budget at the inclusive boundaries", () => {
    expect(() => validate(service())).not.toThrow();
    expect(() => validate(service({ ...enabledHealth, start_period: "6m0s" }, "300000"))).not.toThrow();
    expect(() => validate(service({ ...enabledHealth, start_period: "660s" }, 600_000), { healthTimeoutMs: 660_000 })).not.toThrow();
  });

  it("rejects a larger migration budget until both other budgets increase", () => {
    expect(() => validate(service(enabledHealth, "600000"))).toThrow("600000ms + 60000ms startup margin");
    expect(() => validate(service(enabledHealth, "600000"))).toThrow("start_period=360000ms must be >= 660000ms");
  });

  it("rejects an updater deadline shorter than the required budget or start_period", () => {
    expect(() => validate(service(), { healthTimeoutMs: 300_000 })).toThrow("must be >= healthcheck.start_period=360000ms");
    expect(() => validate(service({ ...enabledHealth, start_period: "361s" }))).toThrow("must be >= healthcheck.start_period=361000ms");
    expect(() => validate(service({ ...enabledHealth, start_period: "359.999s" }))).toThrow("must be >= 360000ms");
  });

  it("checks only API services present in both the core list and the rendered config", () => {
    const rendered = { services: { api: service(), "api-runtime": service({ test: ["CMD", "probe"] }), web: service({ start_period: "bad" }) } };
    expect(() => validateComposeStartupBudgets(rendered, { ...options, coreServices: ["api", "web"] })).not.toThrow();
    expect(() => validateComposeStartupBudgets(rendered, options)).toThrow("api-runtime: healthcheck.start_period=0ms");
    expect(() => validateComposeStartupBudgets({ services: { api: service() } }, options)).not.toThrow();
    expect(() => validateComposeStartupBudgets({ services: { api: service({ start_period: "bad" }) } }, { ...options, coreServices: ["web"] })).not.toThrow();
  });

  it("keeps the updater budget check when healthchecks are absent or disabled", () => {
    for (const health of [null, { disable: true, start_period: "bad" }, { test: ["NONE"] }, { test: "NONE" }]) {
      expect(() => validate(service(health))).not.toThrow();
      expect(() => validate(service(health), { healthTimeoutMs: 359_999 })).toThrow("must be >= 360000ms");
    }
  });

  it("rejects invalid migration budgets, including null rather than treating it as unset", () => {
    for (const budget of ["", " ", "bad", "0", "-1", "1.5", 0, -1, true, null, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validate(service(enabledHealth, budget)), String(budget)).toThrow("positive safe integer");
    }
    expect(() => validate(service(enabledHealth, Number.MAX_SAFE_INTEGER))).toThrow("exceeds the safe integer range");
  });

  it("lists every independent violation with actionable files and no unrelated environment values", () => {
    const secret = "ENV_FILE_SECRET_SENTINEL";
    const api = service({ test: ["CMD", "probe"] }, "600000");
    Object.assign(api.environment, { API_TOKEN: secret, DATABASE_URL: secret });
    let message = "";
    try { validateComposeStartupBudgets({ services: { api, "api-runtime": api } }, options); } catch (error) { message = (error as Error).message; }
    for (const name of ["api", "api-runtime"]) {
      expect(message).toContain(`${name}: updater`);
      expect(message).toContain(`${name}: healthcheck.start_period`);
    }
    expect(message).toContain("600000ms + 60000ms startup margin");
    expect(message).toContain(options.composeFile);
    expect(message).toContain("host updater.env");
    expect(message).toContain("deploy/README.md#usage-accounting-startup-cutover");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("API_TOKEN");
    expect(message).not.toContain("DATABASE_URL");
  });

  it("fails closed on unknown durations and malformed config without echoing the input", () => {
    expect(() => validate(service({ start_period: "SECRET_BAD_DURATION" }))).toThrow("start_period is invalid");
    for (const config of [null, [], {}, { services: [] }]) expect(() => validateComposeStartupBudgets(config, options)).toThrow("requires a services object");
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const oldManifest = { version: "1.2.2", ref: "old", apiImage: `ghcr.io/test/api@sha256:${"c".repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${"d".repeat(64)}` };
const newManifest = { version: "1.2.3", ref: "new", apiImage: `ghcr.io/test/api@sha256:${"a".repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${"b".repeat(64)}` };
function operation(kind: MultiremiPlatformOperation["kind"] = "update"): MultiremiPlatformOperation {
  return { id: "startup-budget", kind, status: "preparing", driver: "docker_compose", targetVersion: kind === "rollback" ? "1.2.2" : "1.2.3", targetRef: kind === "rollback" ? "old" : "new", targetManifest: newManifest,
    progress: {}, requestedBy: "tester", output: null, error: null, previousRelease: null, resultRelease: null,
    cancelRequested: false, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null };
}
function driverBed(configResult: { exitCode: number; stdout: string; stderr: string } | Error) {
  const root = mkdtempSync(join(tmpdir(), "compose-startup-budget-")); roots.push(root);
  const envFile = join(root, "application.env");
  const originalEnv = Buffer.from(`# preserve bytes\r\nREMI_API_IMAGE=${oldManifest.apiImage}\r\nREMI_WEB_IMAGE=${oldManifest.webImage}\r\nTOKEN=ENV_FILE_SECRET_SENTINEL\r\n`);
  writeFileSync(envFile, originalEnv);
  const current = JSON.stringify(oldManifest);
  writeFileSync(join(root, "current-release.json"), current);
  const recentFile = join(root, "old.json"); writeFileSync(recentFile, current);
  const commands: string[][] = [];
  const reports: ReportPlatformOperationInput[] = [];
  const runner: CommandRunner = { async run(command, args) {
    commands.push([command, ...args]);
    if (args.includes("config")) {
      if (configResult instanceof Error) throw configResult;
      return configResult;
    }
    if (command === "find") return { exitCode: 0, stdout: `1 ${recentFile}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const driver = new DockerComposeDriver({ composeFile: join(root, "compose.application.yml"), envFile, stateDir: root,
    apiHealthUrl: `http://127.0.0.1:${health.port}/readyz`, webHealthUrl: `http://127.0.0.1:${health.port}/login`, coreServices: ["api", "web"] }, runner);
  return { root, envFile, originalEnv, current, commands, reports, driver, stop: () => health.stop(true), report: async (input: ReportPlatformOperationInput) => { reports.push(input); } };
}

describe("Compose driver startup preflight", () => {
  it("rejects before reports, env writes, pull, up, drain and rollback even with a previous release", async () => {
    const cases = [
      { result: { exitCode: 0, stdout: JSON.stringify({ services: { api: service({ test: ["CMD", "probe"] }) } }), stderr: "" }, expected: "start_period=0ms" },
      { result: { exitCode: 1, stdout: "ENV_FILE_SECRET_SENTINEL", stderr: "ENV_FILE_SECRET_SENTINEL" }, expected: "config failed (exit 1)" },
      { result: { exitCode: 0, stdout: '{"TOKEN":"ENV_FILE_SECRET_SENTINEL"', stderr: "" }, expected: "invalid JSON" },
      { result: { exitCode: 0, stdout: "null", stderr: "" }, expected: "requires a services object" },
      { result: new Error("ENV_FILE_SECRET_SENTINEL"), expected: "config failed" },
    ];
    for (const { result, expected } of cases) {
      const bed = driverBed(result);
      const before = readdirSync(bed.root).sort();
      let drains = 0;
      try {
        let message = "";
        try { await bed.driver.execute(operation(), bed.report, { waitUntilDrained: async () => { drains++; }, release: async () => {} }); } catch (error) { message = (error as Error).message; }
        expect(message).toContain(expected);
        expect(message).not.toContain("ENV_FILE_SECRET_SENTINEL");
        expect(bed.commands).toHaveLength(1);
        expect(bed.commands[0]!.slice(-4)).toEqual([join(bed.root, "compose.application.yml"), "config", "--format", "json"]);
        expect(readFileSync(bed.envFile).equals(bed.originalEnv)).toBe(true);
        expect(readFileSync(join(bed.root, "current-release.json"), "utf8")).toBe(bed.current);
        expect(readdirSync(bed.root).sort()).toEqual(before);
        expect(bed.reports).toEqual([]);
        expect(drains).toBe(0);
      } finally { bed.stop(); }
    }
  });

  it("renders config first and proceeds through a normal update when valid", async () => {
    const bed = driverBed({ exitCode: 0, stdout: JSON.stringify({ services: { api: service() } }), stderr: "" });
    try {
      expect((await bed.driver.execute(operation(), bed.report))?.ref).toBe("new");
      expect(bed.commands[0]).toContain("config");
      expect(bed.commands.some(args => args.includes("pull"))).toBe(true);
      expect(bed.commands.filter(args => args.includes("up"))).toHaveLength(1);
      expect(bed.reports.map(report => report.status)).toEqual(["pulling", "switching"]);
      expect(readFileSync(bed.envFile, "utf8")).toContain(newManifest.apiImage);
      expect(JSON.parse(readFileSync(join(bed.root, "current-release.json"), "utf8")).ref).toBe("new");
    } finally { bed.stop(); }
  });

  it("skips config for rollback, restart and check_updates", async () => {
    for (const kind of ["rollback", "restart", "check_updates"] as const) {
      const bed = driverBed(new Error("config must not run"));
      try {
        expect((await bed.driver.execute(operation(kind), bed.report))?.ref).toBe("old");
        expect(bed.commands.some(args => args.includes("config"))).toBe(false);
        if (kind === "rollback") expect(bed.commands.some(args => args.includes("up"))).toBe(true);
        if (kind === "restart") expect(bed.commands.some(args => args.includes("restart"))).toBe(true);
      } finally { bed.stop(); }
    }
  });
});
