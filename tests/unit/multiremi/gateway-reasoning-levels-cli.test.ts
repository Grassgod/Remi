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
const CODEX_FRAG = 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"';

function setup({ snapshot = true }: { snapshot?: boolean } = {}) {
  const store = createLocalStore();
  store.setRelayModelDiscovery("local", true);
  const revision = store.upsertRelayConfig("local", "claude", {
    fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }),
    tokenOp: "set",
    authToken: "test-key",
  });
  if (snapshot) store.saveGatewayModels("local", "claude", {
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

  it("publishes a declared model the gateway never listed, without probing for it", async () => {
    const { store, server } = setup({ snapshot: false });
    try {
      // Round C: the declaration stands on its own. No probe has ever succeeded
      // here (no snapshot row at all), and the model id is not from any inventory.
      expect(store.getGatewayModels("local", "claude")).toBeNull();

      const declared = await run([
        "workspace", "relay", "reasoning-levels", "update", "local", "claude",
        "--model", "future-alias", "--level", "low", "--level", "high", "--default-level", "high", "--json",
      ], server);
      expect(declared.error).toBeNull();
      expect(declared.exitCode).toBe(null);

      const catalog = await run(["runtime", "model", "catalog", "--json"], server);
      expect(catalog.error).toBeNull();
      const { providers } = JSON.parse(catalog.stdout.join("\n")) as {
        providers: Array<{
          provider: string;
          models: Array<{ id: string; thinking_source?: string; thinking?: { supported_levels: Array<{ value: string }>; default_level?: string } }>;
        }>;
      };
      const listed = providers.find(entry => entry.provider === "claude")?.models.find(model => model.id === "future-alias");
      expect(listed?.thinking_source).toBe("manual");
      expect(listed?.thinking?.supported_levels.map(level => level.value)).toEqual(["low", "high"]);
      expect(listed?.thinking?.default_level).toBe("high");
      // Serving the catalog is a read: it neither probed nor invented a snapshot.
      expect(store.getGatewayModels("local", "claude")).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("reports a declaration for a model outside the Codex execution catalog as blocked", async () => {
    const { store, server } = setup({ snapshot: false });
    try {
      const declare = (model: string) => run([
        "workspace", "relay", "reasoning-levels", "update", "local", "codex",
        "--model", model, "--level", "low", "--json",
      ], server);
      const manual = async (model: string) => {
        const read = await run(["workspace", "relay", "reasoning-levels", "get", "local", "codex", "--json"], server);
        expect(read.error).toBeNull();
        const listing = JSON.parse(read.stdout.join("\n")) as {
          models: Array<{ model_id: string; manual: { levels: string[]; state: string; state_code?: string } | null }>;
        };
        return listing.models.find(entry => entry.model_id === model)?.manual;
      };

      expect((await declare("gpt-not-in-catalog")).exitCode).toBe(null);
      // No Codex engine is configured, so nothing has decided anything about this
      // model: the listing says so rather than claiming a catalog omitted it.
      expect(await manual("gpt-not-in-catalog")).toMatchObject({
        levels: ["low"], state: "blocked", state_code: "execution_catalog_unknown",
      });

      // Now a Codex execution catalog exists and does not list the model. The
      // declaration is stored and listed, and annotated as inert with the reason
      // (#220: the native catalog alone decides executability) — never dropped.
      const revision = store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAG, tokenOp: "set", authToken: "test-key" });
      store.saveGatewayModels("local", "codex", { sourceRevision: revision, nativeCatalogStatus: "ready", models: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }] });
      expect(await manual("gpt-not-in-catalog")).toMatchObject({
        levels: ["low"], state: "blocked", state_code: "not_in_execution_catalog",
      });
      // And it stays that way: a declaration never adds a Codex member.
      expect(store.getGatewayModelReasoning("local", "codex", "gpt-not-in-catalog")?.levels).toEqual(["low"]);
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
