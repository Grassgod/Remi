/**
 * `remi runtime prepare` runs without --provider inside install-remi.sh during
 * daemon auto-upgrade. Providers without an ACP bundle (antigravity) must be
 * skipped there, while an explicit --provider keeps rejecting them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ProvisionProvider } from "../../../packages/acp/src/provision.js";
import {
  resolveRuntimePrepareProviders,
  runtimePrepareCommandSpec,
  type RuntimePrepareDeps,
} from "../../../apps/remi/cli/commands/runtime-prepare.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";

const noDetect = () => {
  throw new Error("detection must not run");
};

describe("resolveRuntimePrepareProviders", () => {
  it("skips antigravity among detected providers", () => {
    expect(resolveRuntimePrepareProviders({ detect: () => ["claude", "codex", "antigravity", "claude"] }))
      .toEqual(["claude", "codex"]);
  });

  it("prepares nothing when antigravity is the configured provider", () => {
    expect(resolveRuntimePrepareProviders({ configured: "antigravity", detect: noDetect })).toEqual([]);
  });

  it("prepares nothing when antigravity is the only detected provider", () => {
    expect(resolveRuntimePrepareProviders({ detect: () => ["antigravity"] })).toEqual([]);
  });

  it("keeps a configured bundled provider without detecting others", () => {
    expect(resolveRuntimePrepareProviders({ configured: "codex", detect: noDetect })).toEqual(["codex"]);
  });

  it("rejects an explicit --provider antigravity", () => {
    expect(() => resolveRuntimePrepareProviders({ explicit: ["antigravity"], detect: noDetect }))
      .toThrow("--provider must be claude or codex");
    expect(() => resolveRuntimePrepareProviders({ explicit: ["claude", "antigravity"], detect: noDetect }))
      .toThrow("--provider must be claude or codex");
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

  function run(argv: string[], machine: { configured?: string; detected: string[] }) {
    const prepared: ProvisionProvider[][] = [];
    const deps: RuntimePrepareDeps = {
      configuredProvider: () => machine.configured,
      detectProviders: () => machine.detected,
      prepare: async (providers) => { prepared.push([...providers]); },
      versions: (provider) => ({ acp: `${provider}-acp`, sdk: `${provider}-sdk`, executable: `${provider}-exe` }),
    };
    const registry = new CommandRegistry();
    registry.register(runtimePrepareCommandSpec(async () => deps));
    return { prepared, done: registry.execute(["runtime", "prepare", ...argv]) };
  }

  it("prepares only claude and codex on a machine that also has antigravity", async () => {
    const { prepared, done } = run([], { detected: ["claude", "codex", "antigravity"] });
    expect(await done).toBe(true);
    expect(prepared).toEqual([["claude", "codex"]]);
    expect(JSON.parse(stdout.join("\n")).runtimes.map((r: { provider: string }) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("succeeds with empty runtimes when antigravity is configured", async () => {
    const { prepared, done } = run([], { configured: "antigravity", detected: ["claude", "antigravity"] });
    expect(await done).toBe(true);
    expect(prepared).toEqual([[]]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ runtimes: [] });
  });

  it("succeeds with empty runtimes when only antigravity is installed", async () => {
    const { done } = run([], { detected: ["antigravity"] });
    expect(await done).toBe(true);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ runtimes: [] });
  });

  it("prepares explicit bundled providers even when antigravity is configured", async () => {
    const { prepared, done } = run(["--provider", "claude", "--provider", "codex"], { configured: "antigravity", detected: ["antigravity"] });
    expect(await done).toBe(true);
    expect(prepared).toEqual([["claude", "codex"]]);
    expect(JSON.parse(stdout.join("\n")).runtimes.map((r: { provider: string }) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("fails on an explicit --provider antigravity before preparing anything", async () => {
    const { prepared, done } = run(["--provider", "antigravity"], { detected: ["claude", "antigravity"] });
    await expect(done).rejects.toThrow("--provider must be claude or codex");
    expect(prepared).toEqual([]);
    expect(stdout).toEqual([]);
  });
});
