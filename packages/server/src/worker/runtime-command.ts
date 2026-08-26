import {
  HeadTailBuffer,
  redactRuntimeCommandText,
} from "@multiremi/runtime-command-safety.js";

export {
  redactRuntimeCommandArgs,
  redactRuntimeCommandText,
  truncateRuntimeCommandOutput,
} from "@multiremi/runtime-command-safety.js";

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;

export interface RuntimeCommandExecutionInput {
  command: string;
  args?: string[];
  timeoutMs: number;
  outputLimitBytes?: number;
  killGraceMs?: number;
}

export interface RuntimeCommandExecutionResult {
  status: "completed" | "failed" | "timeout";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export async function executeRuntimeCommand(
  input: RuntimeCommandExecutionInput,
): Promise<RuntimeCommandExecutionResult> {
  const startedAt = performance.now();
  const outputLimitBytes = positiveInteger(input.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "outputLimitBytes");
  const killGraceMs = positiveInteger(input.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "killGraceMs");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(runtimeCommandArgv(input.command, input.args ?? []), {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: elapsedMs(startedAt),
      error: redactRuntimeCommandText(error instanceof Error ? error.message : String(error)),
    };
  }

  const stdoutPromise = readBoundedStream(proc.stdout as ReadableStream<Uint8Array> | null | undefined, outputLimitBytes);
  const stderrPromise = readBoundedStream(proc.stderr as ReadableStream<Uint8Array> | null | undefined, outputLimitBytes);
  let exited = false;
  const exitPromise = proc.exited.then((exitCode) => {
    exited = true;
    return exitCode;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // The process may have exited between the flag check and kill.
        }
      }
      resolve({ kind: "timeout" });
    }, positiveInteger(input.timeoutMs, "timeoutMs"));
    timeoutHandle.unref?.();
  });

  try {
    const outcome = await Promise.race([
      exitPromise.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      timeoutPromise,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (outcome.kind === "timeout") {
      await Promise.race([exitPromise.then(() => undefined), delay(killGraceMs)]);
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // A concurrently exiting process does not need a second signal.
        }
      }
      await exitPromise.catch(() => null);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return {
        status: "timeout",
        exitCode: null,
        stdout: redactRuntimeCommandText(stdout),
        stderr: redactRuntimeCommandText(stderr),
        durationMs: elapsedMs(startedAt),
        error: `command timed out after ${input.timeoutMs}ms`,
      };
    }

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      status: "completed",
      exitCode: outcome.exitCode,
      stdout: redactRuntimeCommandText(stdout),
      stderr: redactRuntimeCommandText(stderr),
      durationMs: elapsedMs(startedAt),
    };
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const [stdout, stderr] = await Promise.all([
      stdoutPromise.catch(() => ""),
      stderrPromise.catch(() => ""),
    ]);
    return {
      status: "failed",
      exitCode: null,
      stdout: redactRuntimeCommandText(stdout),
      stderr: redactRuntimeCommandText(stderr),
      durationMs: elapsedMs(startedAt),
      error: redactRuntimeCommandText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function runtimeCommandArgv(command: string, args: readonly string[]): string[] {
  const script = [command, ...args.map(shellQuote)].join(" ");
  if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", script];
  return [process.env.SHELL?.trim() || "/bin/sh", "-c", script];
}

async function readBoundedStream(stream: ReadableStream<Uint8Array> | null | undefined, limitBytes: number): Promise<string> {
  if (!stream) return "";
  const buffer = new HeadTailBuffer(limitBytes);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) buffer.append(value);
    }
  } finally {
    reader.releaseLock();
  }
  return buffer.text();
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
