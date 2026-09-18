import { describe, expect, it } from "bun:test";
import { probeRuntimeModels, runtimeModelProbeCommand } from "@multiremi/worker/runtime-model-probe.js";

const provider = { agentType: "codex", env: { OPENAI_API_KEY: "test-secret-not-for-logs" } };
const capabilities = [{ id: "gpt-6-astra", label: "Astra", default: true,
  effort: { supportedLevels: [{ value: "high", label: "High" }] } }];
const child = (code: string) => [process.execPath, "-e", code];

describe("isolated runtime model probe", () => {
  it("supports source and compiled CLI entrypoints", () => {
    expect(runtimeModelProbeCommand("/usr/bin/bun")[1]).toEndWith("apps/remi/main.ts");
    expect(runtimeModelProbeCommand("/opt/remi")).toEqual(["/opt/remi", "runtime-model-probe"]);
  });

  it("passes credentials over stdin and returns per-model capabilities", async () => {
    const result = await probeRuntimeModels(provider, { command: child(`
      const input = JSON.parse(await Bun.stdin.text());
      if (input.env.OPENAI_API_KEY !== "test-secret-not-for-logs") process.exit(2);
      if (process.argv.join(" ").includes(input.env.OPENAI_API_KEY)) process.exit(3);
      process.stdout.write(${JSON.stringify(JSON.stringify(capabilities))});
    `) });
    expect(result).toEqual(capabilities);
  });

  it("isolates native crashes and never exposes child diagnostics", async () => {
    await expect(probeRuntimeModels(provider, { command: child(`
      const input = JSON.parse(await Bun.stdin.text());
      console.error(input.env.OPENAI_API_KEY);
      process.kill(process.pid, "SIGKILL");
    `) })).rejects.toThrow("Runtime model probe exited (SIGKILL)");
    expect(await probeRuntimeModels(provider, { command: child(`process.stdout.write(${JSON.stringify(JSON.stringify(capabilities))})`) })).toEqual(capabilities);
  });

  it("preserves defaults and capability states across the isolated child boundary", async () => {
    const models = [{ id: "custom", label: "Custom", default: false,
      effort: { status: "supported" as const, defaultLevel: "balanced", supportedLevels: [{ value: "balanced", label: "Balanced" }] } }];
    expect(await probeRuntimeModels(provider, {
      command: child(`process.stdout.write(${JSON.stringify(JSON.stringify(models))})`),
    })).toEqual(models);
    for (const invalid of [{ status: "bogus" }, { defaultLevel: 12 }]) {
      const malformed = [{ ...models[0], effort: { ...models[0]!.effort, ...invalid } }];
      await expect(probeRuntimeModels(provider, {
        command: child(`process.stdout.write(${JSON.stringify(JSON.stringify(malformed))})`),
      })).rejects.toThrow("invalid capabilities");
    }
  });

  it("bounds a hung child and supports cancellation", async () => {
    const command = child("setInterval(() => {}, 1000)");
    await expect(probeRuntimeModels(provider, { command, timeoutMs: 100 })).rejects.toThrow("timed out");
    const abort = new AbortController();
    const pending = probeRuntimeModels(provider, { command, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("rejects malformed, empty, or excessive output", async () => {
    for (const output of ["not json", "[]", '[{"id":"astra"}]']) {
      await expect(probeRuntimeModels(provider, { command: child(`process.stdout.write(${JSON.stringify(output)})`) })).rejects.toThrow("invalid capabilities");
    }
    await expect(probeRuntimeModels(provider, { command: child('process.stdout.write("x".repeat(3 * 1024 * 1024))') })).rejects.toThrow("exceeded limit");
  });
});
