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

export function redactRuntimeCommandText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:password|token)\s*=\s*)(["']?)([^\s"';&]+)\2/gi, "$1$2[REDACTED]$2")
    .replace(/\b(?:ghp|gho)_[A-Za-z0-9]{4,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]");
}

export function redactRuntimeCommandArgs(values: readonly string[]): string[] {
  return values.map((value, index) => {
    const previous = values[index - 1]?.trim() ?? "";
    const beforePrevious = values[index - 2]?.trim() ?? "";
    if (/^authorization\s*:\s*bearer$/i.test(previous)) return "[REDACTED]";
    if (/^bearer$/i.test(previous) && /^authorization\s*:?$/i.test(beforePrevious)) return "[REDACTED]";
    return redactRuntimeCommandText(value);
  });
}

export function truncateRuntimeCommandOutput(value: string, limitBytes = DEFAULT_OUTPUT_LIMIT_BYTES): string {
  const buffer = new HeadTailBuffer(positiveInteger(limitBytes, "limitBytes"));
  buffer.append(new TextEncoder().encode(value));
  return buffer.text();
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

class HeadTailBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private full: Uint8Array<ArrayBufferLike> | null = new Uint8Array(0);
  private totalBytes = 0;

  constructor(private readonly limitBytes: number) {
    const markerReserve = Math.min(96, Math.max(32, Math.floor(limitBytes / 4)));
    const retained = Math.max(2, limitBytes - markerReserve);
    this.headLimit = Math.ceil(retained / 2);
    this.tailLimit = Math.floor(retained / 2);
  }

  append(chunk: Uint8Array<ArrayBufferLike>): void {
    this.totalBytes += chunk.byteLength;
    if (this.full) {
      const combined = concatBytes(this.full, chunk);
      if (this.totalBytes <= this.limitBytes) {
        this.full = combined;
        return;
      }
      this.head = combined.subarray(0, this.headLimit).slice();
      this.tail = combined.subarray(Math.max(0, combined.byteLength - this.tailLimit)).slice();
      this.full = null;
      return;
    }
    const headRoom = this.headLimit - this.head.byteLength;
    const headBytes = headRoom > 0 ? chunk.subarray(0, Math.min(headRoom, chunk.byteLength)) : new Uint8Array(0);
    if (headBytes.byteLength) this.head = concatBytes(this.head, headBytes);
    const remainder = chunk.subarray(headBytes.byteLength);
    if (remainder.byteLength) {
      const combined = concatBytes(this.tail, remainder);
      this.tail = combined.subarray(Math.max(0, combined.byteLength - this.tailLimit)).slice();
    }
  }

  text(): string {
    const decoder = new TextDecoder();
    if (this.full) return decoder.decode(this.full);
    const truncated = this.totalBytes - this.head.byteLength - this.tail.byteLength;
    return `${decoder.decode(this.head)}\n... ${truncated} bytes truncated ...\n${decoder.decode(this.tail)}`;
  }
}

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  if (!left.byteLength) return right.slice();
  if (!right.byteLength) return left.slice();
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
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
