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
import { cliCommandInventory, dispatch } from "../../../apps/remi/cli/index.js";
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
  it("registers every legacy top-level entry, including hidden multiremi compatibility", () => {
    const inventory = cliCommandInventory();
    expect(inventory.map((entry) => entry.path.join(" "))).toEqual([
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "service",
      "setup",
      "config",
      "repo",
      "issue",
      "attachment",
      "memory",
      "wiki",
      "project",
      "seed",
      "doctor",
      "login",
      "update",
      "serve",
      "git-credential",
      "multiremi",
    ]);
    expect(inventory.find((entry) => entry.path[0] === "multiremi"))
      .toMatchObject({ hidden: true, id: "legacy.multiremi" });
  });

  it("routes `remi project` into the multiremi project command", async () => {
    const result = await runDispatch(["project"]);

    // Reaching the project layer's own usage error proves the command resolved.
    expect(String((result.error as Error | null)?.message ?? "")).toContain("usage: multiremi project knowledge");
    expect(result.exitCode).toBeNull();
    expect(result.stderr.join("\n")).not.toContain("Unknown command");
  });

  it("routes top-level memory and wiki commands into the knowledge layer", async () => {
    const memoryResult = await runDispatch(["memory", "read", "entry"]);
    const wikiResult = await runDispatch(["wiki", "read", "page"]);

    expect(String((memoryResult.error as Error | null)?.message ?? "")).toContain("--project <project-id> is required");
    expect(String((wikiResult.error as Error | null)?.message ?? "")).toContain("--project <project-id> is required");
    expect(memoryResult.stderr.join("\n")).not.toContain("Unknown command");
    expect(wikiResult.stderr.join("\n")).not.toContain("Unknown command");
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
