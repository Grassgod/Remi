/**
 * `remi runtime prepare` runs without --provider inside install-remi.sh during
 * daemon auto-upgrade. Antigravity is opt-in: the default path prepares it only
 * when some install already exists (a pin bump is pre-fetched), while an
 * explicit --provider antigravity installs it (terms permitting).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resolveRuntimePrepareProviders,
  runtimePrepareCommandSpec,
  type RuntimePrepareDeps,
  type RuntimePrepareProvider,
} from "../../../apps/remi/cli/commands/runtime-prepare.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";

const noDetect = () => {
  throw new Error("detection must not run");
};
const installed = () => true;
const absent = () => false;

describe("resolveRuntimePrepareProviders", () => {
  it("skips a detected antigravity that has never been installed", () => {
    expect(resolveRuntimePrepareProviders({ detect: () => ["claude", "codex", "antigravity", "claude"], antigravityInstalled: absent }))
      .toEqual(["claude", "codex"]);
    expect(resolveRuntimePrepareProviders({ detect: () => ["antigravity"] })).toEqual([]);
  });

  it("re-prepares antigravity when some install exists, so a pin bump is pre-fetched", () => {
    expect(resolveRuntimePrepareProviders({ detect: () => ["claude", "antigravity"], antigravityInstalled: installed }))
      .toEqual(["claude", "antigravity"]);
    expect(resolveRuntimePrepareProviders({ configured: "antigravity", detect: noDetect, antigravityInstalled: installed }))
      .toEqual(["antigravity"]);
  });

  it("prepares nothing when antigravity is configured but was never installed", () => {
    expect(resolveRuntimePrepareProviders({ configured: "antigravity", detect: noDetect, antigravityInstalled: absent })).toEqual([]);
  });

  it("keeps a configured bundled provider without detecting others", () => {
    expect(resolveRuntimePrepareProviders({ configured: "codex", detect: noDetect })).toEqual(["codex"]);
  });

  it("accepts an explicit --provider antigravity and rejects unknown providers", () => {
    expect(resolveRuntimePrepareProviders({ explicit: ["antigravity"], detect: noDetect, antigravityInstalled: absent }))
      .toEqual(["antigravity"]);
    expect(() => resolveRuntimePrepareProviders({ explicit: ["claude", "agy"], detect: noDetect }))
      .toThrow("--provider must be claude, codex or antigravity");
  });

  it("accepts explicit bundled providers and ignores the configured one", () => {
    expect(resolveRuntimePrepareProviders({ explicit: ["codex", "claude", "codex"], configured: "antigravity", detect: noDetect }))
      .toEqual(["codex", "claude"]);
    expect(resolveRuntimePrepareProviders({ explicit: "claude", detect: noDetect })).toEqual(["claude"]);
  });
});

describe("remi runtime prepare", () => {
  const realConsoleLog = console.log;
  let stdout: string[];

  beforeEach(() => {
    stdout = [];
    console.log = (...args: unknown[]) => { stdout.push(args.join(" ")); };
  });

  afterEach(() => {
    console.log = realConsoleLog;
  });

  function run(argv: string[], machine: { configured?: string; detected: string[]; antigravity?: boolean }) {
    const prepared: Array<{ providers: RuntimePrepareProvider[]; acceptAntigravityTerms: boolean }> = [];
    const deps: RuntimePrepareDeps = {
      configuredProvider: () => machine.configured,
      detectProviders: () => machine.detected,
      antigravityInstalled: () => machine.antigravity ?? false,
      prepare: async (providers, options) => { prepared.push({ providers: [...providers], ...options }); },
      versions: (provider) => provider === "antigravity"
        ? { server: "1.4.0" }
        : { acp: `${provider}-acp`, sdk: `${provider}-sdk`, executable: `${provider}-exe` },
    };
    const registry = new CommandRegistry();
    registry.register(runtimePrepareCommandSpec(async () => deps));
    return { prepared, done: registry.execute(["runtime", "prepare", ...argv]) };
  }

  it("prepares only claude and codex on a machine without an Antigravity install", async () => {
    const { prepared, done } = run([], { detected: ["claude", "codex", "antigravity"] });
    expect(await done).toBe(true);
    expect(prepared).toEqual([{ providers: ["claude", "codex"], acceptAntigravityTerms: false }]);
    expect(JSON.parse(stdout.join("\n")).runtimes.map((r: { provider: string }) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("succeeds with empty runtimes when antigravity is configured but not installed", async () => {
    const { prepared, done } = run([], { configured: "antigravity", detected: ["claude", "antigravity"] });
    expect(await done).toBe(true);
    expect(prepared).toEqual([{ providers: [], acceptAntigravityTerms: false }]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ runtimes: [] });
  });

  it("re-prepares an installed antigravity and reports its pinned server version", async () => {
    const { prepared, done } = run([], { detected: ["antigravity"], antigravity: true });
    expect(await done).toBe(true);
    expect(prepared).toEqual([{ providers: ["antigravity"], acceptAntigravityTerms: false }]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ runtimes: [{ provider: "antigravity", server: "1.4.0", verified: true }] });
  });

  it("passes the explicit terms consent for a first Antigravity install", async () => {
    const { prepared, done } = run(["--provider", "antigravity", "--accept-antigravity-terms"], { detected: ["claude"] });
    expect(await done).toBe(true);
    expect(prepared).toEqual([{ providers: ["antigravity"], acceptAntigravityTerms: true }]);
  });

  it("prepares explicit bundled providers even when antigravity is configured", async () => {
    const { prepared, done } = run(["--provider", "claude", "--provider", "codex"], { configured: "antigravity", detected: ["antigravity"] });
    expect(await done).toBe(true);
    expect(prepared.map((entry) => entry.providers)).toEqual([["claude", "codex"]]);
    expect(JSON.parse(stdout.join("\n")).runtimes.map((r: { provider: string }) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("fails on an unknown explicit provider before preparing anything", async () => {
    const { prepared, done } = run(["--provider", "gemini"], { detected: ["claude"] });
    await expect(done).rejects.toThrow("--provider must be claude, codex or antigravity");
    expect(prepared).toEqual([]);
    expect(stdout).toEqual([]);
  });
});
