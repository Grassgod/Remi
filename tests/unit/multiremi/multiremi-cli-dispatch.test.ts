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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
let previousProjectId: string | undefined;

beforeEach(() => {
  previousProjectId = process.env.MULTIREMI_PROJECT_ID;
  delete process.env.MULTIREMI_PROJECT_ID;
});

afterEach(() => {
  process.exit = realExit;
  console.error = realConsoleError;
  console.log = realConsoleLog;
  if (previousProjectId === undefined) delete process.env.MULTIREMI_PROJECT_ID;
  else process.env.MULTIREMI_PROJECT_ID = previousProjectId;
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
  it("registers native resource groups and every legacy top-level entry", () => {
    const inventory = cliCommandInventory();
    expect(inventory.filter((entry) => entry.path.length === 1).map((entry) => entry.path.join(" "))).toEqual([
      "context",
      "workspace",
      "member",
      "invite",
      "token",
      "project",
      "repo",
      "knowledge",
      "memory",
      "wiki",
      "comment",
      "session",
      "share",
      "label",
      "chat",
      "chat.issue",
      "chat.issue.updates",
      "task",
      "agent",
      "squad",
      "skill",
      "plugin",
      "runtime",
      "daemon",
      "autopilot",
      "scm",
      "messaging",
      "feishu",
      "inbox",
      "notification",
      "pin",
      "dashboard",
      "platform",
      "billing",
      "lark",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "service",
      "setup",
      "config",
      "issue",
      "attachment",
      "doctor",
      "login",
      "update",
      "git-credential",
      "multiremi",
    ]);
    expect(inventory.find((entry) => entry.path[0] === "multiremi"))
      .toMatchObject({ hidden: true, id: "legacy.multiremi" });
    expect(inventory.find((entry) => entry.id === "memory.search")?.aliases)
      .toContainEqual(expect.objectContaining({ path: ["memory", "recall"], deprecatedSince: "0.3.0" }));
    expect(inventory.find((entry) => entry.id === "issue.attachment.download")).toMatchObject({
      path: ["attachment", "download"],
      aliases: [expect.objectContaining({
        path: ["issue", "attachment", "download"],
        replacement: "remi attachment download",
      })],
    });
  });

  it("routes `remi project` into the native resource group", async () => {
    const result = await runDispatch(["project"]);

    expect(String((result.error as Error | null)?.message ?? "")).toContain("usage: remi project list|get|search");
    expect(result.exitCode).toBeNull();
    expect(result.stderr.join("\n")).not.toContain("Unknown command");
  });

  it("routes top-level memory and wiki commands into the knowledge layer", async () => {
    const memoryResult = await runDispatch(["memory", "read", "entry"]);
    const wikiResult = await runDispatch(["wiki", "read", "page"]);

    expect(String((memoryResult.error as Error | null)?.message ?? "")).toContain("--project is required");
    expect(String((wikiResult.error as Error | null)?.message ?? "")).toContain("--project is required");
    expect(memoryResult.stderr.join("\n")).not.toContain("Unknown command");
    expect(wikiResult.stderr.join("\n")).not.toContain("Unknown command");
  });

  it("renders generated help for native command paths without executing them", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); };
    try {
      await dispatch(["repo", "checkout", "--help"]);
      await dispatch(["help", "memory", "recall"]);
      await dispatch(["--help"]);
    } finally {
      console.log = originalLog;
    }
    expect(output.join("\n")).toContain("Usage: remi repo checkout <repository-or-url> [options]");
    expect(output.join("\n")).toContain("--ref <branch-or-sha>");
    expect(output.join("\n")).toContain("Usage: remi memory search <query> [options]");
    expect(output.join("\n")).toContain("seed         Deprecated alias; use remi agent default");
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
