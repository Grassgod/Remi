import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpModelCapability, AcpProviderOptions } from "@acp/index.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function runtimeModelProbeCommand(execPath = process.execPath): string[] {
  const name = basename(execPath).toLowerCase();
  return name === "bun" || name === "bun.exe" || name.startsWith("bun-debug")
    ? [execPath, fileURLToPath(new URL("../../../../apps/remi/main.ts", import.meta.url)), "runtime-model-probe"]
    : [execPath, "runtime-model-probe"];
}

/** The child owns ACP and its descendants. Credentials travel over stdin, never argv. */
export function probeRuntimeModels(
  provider: AcpProviderOptions,
  options: { signal?: AbortSignal; timeoutMs?: number; command?: string[] } = {},
): Promise<AcpModelCapability[]> {
  options.signal?.throwIfAborted();
  const command = options.command ?? runtimeModelProbeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, REMI_DEBUG: undefined },
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    const killGroup = () => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const finish = (error?: Error, models?: AcpModelCapability[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      killGroup();
      if (error) reject(error);
      else resolve(models!);
    };
    const abort = () => finish(new Error("Runtime model probe cancelled"));
    const timer = setTimeout(() => finish(new Error("Runtime model probe timed out")), options.timeoutMs ?? 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", () => finish(new Error("Runtime model probe could not start")));
    child.stdin.on("error", () => finish(new Error("Runtime model probe input failed")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) finish(new Error("Runtime model probe output exceeded limit"));
      else output += chunk;
    });
    // Drain diagnostics without exposing provider credentials or allowing unbounded buffers.
    child.stderr.resume();
    child.on("exit", (code, signal) => {
      // Kill descendants even if a crashing child left inherited pipes open.
      if (code !== 0) finish(new Error(`Runtime model probe exited (${signal ?? code})`));
      else killGroup();
    });
    child.on("close", (code) => {
      if (settled || code !== 0) return;
      try {
        const result = JSON.parse(output);
        if (!Array.isArray(result) || result.length === 0 || !result.every(validCapability)) {
          throw new Error("invalid capabilities");
        }
        finish(undefined, result);
      } catch {
        finish(new Error("Runtime model probe returned invalid capabilities"));
      }
    });
    child.stdin.end(JSON.stringify(provider));
  });
}

function validCapability(value: unknown): value is AcpModelCapability {
  if (!value || typeof value !== "object") return false;
  const m = value as AcpModelCapability;
  return typeof m.id === "string" && m.id.length > 0 && typeof m.label === "string"
    && typeof m.default === "boolean"
    && (m.effort === undefined || (Array.isArray(m.effort?.supportedLevels)
      && m.effort.supportedLevels.every(l => typeof l?.value === "string" && typeof l.label === "string")));
}
