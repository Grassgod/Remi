/**
 * MUL-338 — the reasoning-level declaration has to be reachable from the CLI, not
 * only from the settings page (AGENTS.md: a new user-facing endpoint ships with
 * its CLI command in the same batch).
 *
 * These drive the real dispatcher against a real HTTP server, so they cover the
 * whole hop: command registration, the capability handshake
 * (`cli-capabilities-generated.ts`), request body construction and rendering.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { createMultiremiApp } from "@multiremi/api.js";
import { dispatch } from "../../../apps/remi/cli/index.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

afterEach(resetMultiremiTestEnv);

/**
 * The live shape: a Claude relay with the 15-model gateway inventory (ids and
 * labels only — the gateway declares no reasoning metadata for these aliases).
 */
const GATEWAY_MODELS = ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "deepseek-v4-flash", "kimi-k2"];

function setup() {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "claude", {
    fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }),
    tokenOp: "set",
    authToken: "test-key",
  });
  store.saveGatewayModels("local", "claude", {
    sourceRevision: revision,
    models: GATEWAY_MODELS.map(id => ({ id, label: id })),
  });
  const app = createMultiremiApp({ store });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return { store, server };
}

class ProcessExitError extends Error {
  constructor(readonly code: number | null) {
    super(`process.exit(${code})`);
  }
}

async function run(args: string[], server: Server<undefined>): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | null; error: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = { url: process.env.MULTIREMI_SERVER_URL, workspace: process.env.MULTIREMI_WORKSPACE_ID };
  console.log = (value?: unknown) => { stdout.push(String(value)); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  process.exit = ((code?: number) => { throw new ProcessExitError(code ?? 0); }) as typeof process.exit;
  process.env.MULTIREMI_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.MULTIREMI_WORKSPACE_ID = "local";
  try {
    await dispatch(args);
    return { stdout, stderr, exitCode: null, error: null };
  } catch (error) {
    if (error instanceof ProcessExitError) return { stdout, stderr, exitCode: error.code, error: null };
    // apps/remi/main.ts is the real reporter: a thrown CliError prints
    // "Fatal: <message>" and exits 1. Reproduce that instead of unwrapping here.
    stderr.push(`Fatal: ${(error as Error).message}`);
    return { stdout, stderr, exitCode: 1, error: null };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
    if (previous.url === undefined) delete process.env.MULTIREMI_SERVER_URL;
    else process.env.MULTIREMI_SERVER_URL = previous.url;
    if (previous.workspace === undefined) delete process.env.MULTIREMI_WORKSPACE_ID;
    else process.env.MULTIREMI_WORKSPACE_ID = previous.workspace;
  }
}

describe("MUL-338 reasoning levels: the CLI path", () => {
  it("declares, reads back and clears a model's levels", async () => {
    const { store, server } = setup();
    try {
      const set = await run([
        "workspace", "relay", "reasoning-levels", "update", "local", "claude",
        "--model", "deepseek-v4-flash",
        "--level", "low", "--level", "high", "--level", "max",
        "--default-level", "high",
        "--json",
      ], server);
      expect(set.error).toBeNull();
      expect(set.exitCode).toBe(null);
      expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")?.levels).toEqual(["low", "high", "max"]);

      const read = await run([
        "workspace", "relay", "reasoning-levels", "get", "local", "claude", "--json",
      ], server);
      expect(read.error).toBeNull();
      const listing = JSON.parse(read.stdout.join("\n")) as {
        allowed_levels: string[];
        models: Array<{ model_id: string; manual: { levels: string[] } | null; effective: { source: string; supported_levels: Array<{ value: string }> } | null }>;
      };
      expect(listing.allowed_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
      const declared = listing.models.find(model => model.model_id === "deepseek-v4-flash");
      expect(declared?.manual?.levels).toEqual(["low", "high", "max"]);
      expect(declared?.effective?.source).toBe("manual");
      expect(declared?.effective?.supported_levels.map(level => level.value)).toEqual(["low", "high", "max"]);

      const cleared = await run([
        "workspace", "relay", "reasoning-levels", "update", "local", "claude",
        "--model", "deepseek-v4-flash", "--clear", "--json",
      ], server);
      expect(cleared.error).toBeNull();
      expect(store.getGatewayModelReasoning("local", "claude", "deepseek-v4-flash")).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("refuses an ambiguous or invalid declaration before it reaches the API", async () => {
    const { store, server } = setup();
    try {
      // No --level and no --clear is not a no-op: a typo'd --model would otherwise
      // delete a declaration.
      const ambiguous = await run([
        "workspace", "relay", "reasoning-levels", "update", "local", "claude", "--model", "deepseek-v4-flash",
      ], server);
      expect(ambiguous.error).toBeNull();
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stderr.join("\n")).toContain("requires --level (repeatable) or --clear");
      expect(store.listGatewayModelReasoning("local", "claude")).toEqual([]);

      const both = await run([
        "workspace", "relay", "reasoning-levels", "update", "local", "claude",
        "--model", "deepseek-v4-flash", "--level", "low", "--clear",
      ], server);
      expect(both.exitCode).toBe(1);
      expect(both.stderr.join("\n")).toContain("--clear");

      // The server owns the enum; the CLI forwards it and reports the 400.
      const invalid = await run([
        "workspace", "relay", "reasoning-levels", "update", "local", "claude",
        "--model", "deepseek-v4-flash", "--level", "ultra",
      ], server);
      expect(invalid.error).toBeNull();
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr.join("\n")).toContain("ultra");
      expect(store.listGatewayModelReasoning("local", "claude")).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
