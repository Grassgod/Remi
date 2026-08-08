/**
 * Guards the shipped binary's command registry (apps/remi/cli/index.ts).
 *
 * A command that is documented in prompts/skills but never registered fails at
 * the very first hop — `dispatch()` prints "Unknown command: <name>" and exits
 * 1 — so these tests drive the real dispatcher rather than the multiremi layer
 * behind it. `process.exit` is stubbed so an unregistered command surfaces as a
 * test failure instead of killing the test runner.
 *
 * The provider-detection describe at the bottom covers the other half of the
 * entrypoint: which daemon providers the CLI reports as available on PATH.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { delimiter, join } from "node:path";
import { dispatch } from "../../../apps/remi/cli/index.js";
import { detectMultiremiProviders } from "../../../apps/remi/cli/multiremi.js";

interface DispatchResult {
  error: unknown;
  exitCode: number | null;
  stderr: string[];
}

const realExit = process.exit;
const realConsoleError = console.error;
const realConsoleLog = console.log;

afterEach(() => {
  process.exit = realExit;
  console.error = realConsoleError;
  console.log = realConsoleLog;
});

class ProcessExitError extends Error {
  constructor(readonly code: number | null) {
    super(`process.exit(${code})`);
  }
}

async function runDispatch(args: string[]): Promise<DispatchResult> {
  const stderr: string[] = [];
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  console.log = () => {};
  process.exit = ((code?: number) => { throw new ProcessExitError(code ?? 0); }) as typeof process.exit;
  try {
    await dispatch(args);
    return { error: null, exitCode: null, stderr };
  } catch (err) {
    if (err instanceof ProcessExitError) return { error: null, exitCode: err.code, stderr };
    return { error: err, exitCode: null, stderr };
  }
}

describe("remi CLI dispatcher", () => {
  it("routes `remi project` into the multiremi project command", async () => {
    const result = await runDispatch(["project"]);

    // Reaching the project layer's own usage error proves the command resolved.
    expect(String((result.error as Error | null)?.message ?? "")).toContain("usage: multiremi project doc|memory");
    expect(result.exitCode).toBeNull();
    expect(result.stderr.join("\n")).not.toContain("Unknown command");
  });

  it("routes `remi project doc list` past the dispatcher into the project layer", async () => {
    const result = await runDispatch(["project", "doc", "list"]);

    expect(String((result.error as Error | null)?.message ?? "")).toContain("usage: multiremi project doc list <project-id>");
    expect(result.stderr.join("\n")).not.toContain("Unknown command");
  });

  it("still rejects a command nobody registered", async () => {
    const result = await runDispatch(["definitely-not-a-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("Unknown command: definitely-not-a-command");
  });
});

describe("remi CLI provider detection", () => {
  it("detects supported daemon providers from PATH", () => {
    const pathEnv = ["/mock/bin", "/other/bin"].join(delimiter);

    expect(detectMultiremiProviders({
      pathEnv,
      canExecute: (path) => path === join("/mock/bin", "claude") || path === join("/other/bin", "codex"),
    })).toEqual(["claude", "codex"]);

    expect(detectMultiremiProviders({
      pathEnv,
      canExecute: (path) => path === "/mock/bin/gemini",
    })).toEqual([]);
  });
});
