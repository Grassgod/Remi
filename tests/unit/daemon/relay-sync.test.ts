import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  buildCodexAuth,
  deepMerge,
  mergeClaudeSettings,
  mergeCodexConfig,
  syncRelayConfigs,
  type RelayPaths,
  type RelayWire,
} from "@daemon/agent-runtime/relay-sync.js";

let dir: string | null = null;

function tempPaths(): RelayPaths {
  dir = mkdtempSync(join(tmpdir(), "relay-sync-"));
  return {
    claudeSettings: join(dir, ".claude", "settings.json"),
    codexConfig: join(dir, ".codex", "config.toml"),
    codexAuth: join(dir, ".codex", "auth.json"),
    stateFile: join(dir, ".multiremi", "relay-state.json"),
  };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("pure merge helpers", () => {
  it("deepMerge overrides patch keys, preserves others, blocks prototype pollution", () => {
    const merged = deepMerge<Record<string, unknown>>({ a: 1, nested: { keep: true, x: 1 } }, { nested: { x: 2 }, b: 3 });
    expect(merged).toEqual({ a: 1, nested: { keep: true, x: 2 }, b: 3 });
    const poisoned = deepMerge({} as Record<string, unknown>, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(poisoned).toEqual({});
  });

  it("mergeClaudeSettings sets AUTH_TOKEN, drops API_KEY, preserves user prefs", () => {
    const current = { model: "opus", theme: "dark", env: { ANTHROPIC_API_KEY: "old", ENABLE_TOOL_SEARCH: "1" } };
    const frag = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } });
    const out = mergeClaudeSettings(current, frag, "sk-ant-new");
    expect(out.model).toBe("opus");
    expect(out.theme).toBe("dark");
    const env = out.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://ai.openremi.fun");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-new");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_TOOL_SEARCH).toBe("1");
  });

  it("mergeCodexConfig preserves projects/hooks, applies provider block, strips inline secret", () => {
    const current = [
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://old.example.com/v1"',
      'experimental_bearer_token = "sk-inline"',
      'wire_api = "responses"',
      "",
      '[projects."/home/u/repo"]',
      'trust_level = "trusted"',
    ].join("\n");
    const frag = [
      'model_provider = "OpenAI"',
      "[model_providers.OpenAI]",
      'base_url = "https://vip.openremi.fun/v1"',
      "requires_openai_auth = true",
    ].join("\n");
    const out = parseToml(mergeCodexConfig(current, frag)) as Record<string, any>;
    expect(out.model_providers.OpenAI.base_url).toBe("https://vip.openremi.fun/v1");
    expect(out.model_providers.OpenAI.requires_openai_auth).toBe(true);
    expect(out.model_providers.OpenAI.experimental_bearer_token).toBeUndefined();
    expect(out.model_providers.OpenAI.wire_api).toBe("responses"); // untouched existing key
    expect(out.projects["/home/u/repo"].trust_level).toBe("trusted"); // machine-specific preserved
  });

  it("buildCodexAuth writes a static key only (drops chatgpt OAuth entirely)", () => {
    expect(buildCodexAuth("sk-static")).toEqual({ OPENAI_API_KEY: "sk-static" });
    expect(buildCodexAuth("")).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("mergeClaudeSettings fails closed when a token has no gateway base_url", () => {
    // token set but fragment (and existing settings) define no ANTHROPIC_BASE_URL
    expect(() => mergeClaudeSettings({}, "{}", "sk-orphan")).toThrow(/base_url/);
    // no token → allowed (pure no-op merge)
    expect(() => mergeClaudeSettings({}, "{}", "")).not.toThrow();
  });
});

describe("syncRelayConfigs orchestration", () => {
  const relay = (rev: number): RelayWire => ({
    claude: { fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }), auth_token: "sk-ant", revision: rev },
    codex: {
      fragment: ['model_provider = "OpenAI"', "[model_providers.OpenAI]", 'base_url = "https://vip.openremi.fun/v1"', "requires_openai_auth = true"].join("\n"),
      auth_token: "sk-codex",
      revision: rev,
    },
    model_discovery: true,
  });

  it("writes all three files atomically and records applied revision", () => {
    const paths = tempPaths();
    // seed existing machine-specific content
    mkdirSync(join(dir!, ".claude"), { recursive: true });
    writeFileSync(paths.claudeSettings, JSON.stringify({ theme: "dark", env: { ENABLE_TOOL_SEARCH: "1" } }));
    mkdirSync(join(dir!, ".codex"), { recursive: true });
    writeFileSync(paths.codexAuth, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));

    syncRelayConfigs(relay(1), "local", paths);

    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://ai.openremi.fun");

    const auth = JSON.parse(readFileSync(paths.codexAuth, "utf8"));
    expect(auth).toEqual({ OPENAI_API_KEY: "sk-codex" });
    expect(auth.auth_mode).toBeUndefined();

    const cfg = parseToml(readFileSync(paths.codexConfig, "utf8")) as Record<string, any>;
    expect(cfg.model_providers.OpenAI.base_url).toBe("https://vip.openremi.fun/v1");

    const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    expect(state.claude.revision).toBe(1);
    expect(state.codex.revision).toBe(1);
  });

  it("is idempotent: same revision does not rewrite; higher revision does", () => {
    const paths = tempPaths();
    syncRelayConfigs(relay(1), "local", paths);
    const firstMtime = readFileSync(paths.claudeSettings, "utf8");
    // re-apply same revision: settings.json backup dir should stay empty (no rewrite)
    syncRelayConfigs(relay(1), "local", paths);
    const versionsDir = join(dir!, ".claude", ".versions");
    expect(existsSync(versionsDir) ? readdirSync(versionsDir).length : 0).toBe(0);

    // higher revision updates + backs up the previous file
    const bumped = relay(2);
    bumped.claude!.auth_token = "sk-ant-rotated";
    syncRelayConfigs(bumped, "local", paths);
    expect(JSON.parse(readFileSync(paths.claudeSettings, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-rotated");
    expect(readdirSync(versionsDir).length).toBe(1);
    expect(JSON.parse(readFileSync(paths.stateFile, "utf8")).claude.revision).toBe(2);
    void firstMtime;
  });

  it("no-op on undefined relay or null engine", () => {
    const paths = tempPaths();
    syncRelayConfigs(undefined, "local", paths);
    expect(existsSync(paths.claudeSettings)).toBe(false);
    syncRelayConfigs({ claude: null, codex: null }, "local", paths);
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });

  it("fail-closed: a malformed existing settings.json is never overwritten", () => {
    const paths = tempPaths();
    mkdirSync(join(dir!, ".claude"), { recursive: true });
    writeFileSync(paths.claudeSettings, "{ this is not valid json");
    syncRelayConfigs(relay(1), "local", paths);
    // the corrupt file is left intact (not replaced with relay-only content)
    expect(readFileSync(paths.claudeSettings, "utf8")).toBe("{ this is not valid json");
    // and the engine was NOT marked applied, so a later fix will retry
    expect(existsSync(paths.stateFile) ? JSON.parse(readFileSync(paths.stateFile, "utf8")).claude : undefined).toBeUndefined();
  });

  it("strict revision monotonicity: a stale lower-revision response never rolls back (no race)", () => {
    const paths = tempPaths();
    syncRelayConfigs(relay(2), "local", paths);
    // a slow, late-arriving response at a LOWER revision must be ignored
    const stale = relay(1);
    stale.claude!.auth_token = "sk-stale";
    syncRelayConfigs(stale, "local", paths);
    expect(JSON.parse(readFileSync(paths.claudeSettings, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant");
  });

  it("codex first-create: if auth.json write fails, the freshly-created config.toml is removed", () => {
    const paths = tempPaths();
    // Make the auth.json write fail: point its parent at a regular file so mkdir throws.
    mkdirSync(join(dir!, ".codex"), { recursive: true });
    const badParent = join(dir!, ".codex", "blocker");
    writeFileSync(badParent, "x");
    paths.codexAuth = join(badParent, "auth.json"); // parent is a file → write fails
    syncRelayConfigs(relay(1), "local", paths);
    // config.toml did not exist before and auth failed → it must NOT be left behind
    expect(existsSync(paths.codexConfig)).toBe(false);
    // codex engine not marked applied (so it retries later)
    expect(existsSync(paths.stateFile) ? JSON.parse(readFileSync(paths.stateFile, "utf8")).codex : undefined).toBeUndefined();
  });

  it("fail-closed #4: a token-only update never pairs the new token with a stale local base_url", () => {
    const paths = tempPaths();
    mkdirSync(join(dir!, ".claude"), { recursive: true });
    // machine already has an OLD gateway + token
    writeFileSync(paths.claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old.example/", ANTHROPIC_AUTH_TOKEN: "old-tok" } }));
    const wire: RelayWire = {
      claude: { fragment: "{}", auth_token: "sk-new", revision: 1 }, // token but NO base_url in this fragment
      codex: null,
    };
    syncRelayConfigs(wire, "local", paths);
    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8"));
    // refused: the new token was NOT written next to the stale local base_url
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("old-tok");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://old.example/");
  });

  it("codex fails closed when a token has no active-provider base_url (no files written)", () => {
    const paths = tempPaths();
    const bad: RelayWire = {
      claude: null,
      codex: {
        // valid TOML, but the active provider has no base_url
        fragment: ['model_provider = "OpenAI"', "[model_providers.OpenAI]", 'wire_api = "responses"'].join("\n"),
        auth_token: "sk-codex",
        revision: 1,
      },
    };
    syncRelayConfigs(bad, "local", paths);
    expect(existsSync(paths.codexConfig)).toBe(false);
    expect(existsSync(paths.codexAuth)).toBe(false);
  });

  it("resets applied state when the daemon's workspace changes (global-file safety)", () => {
    const paths = tempPaths();
    syncRelayConfigs(relay(2), "workspace-a", paths);
    // same revision but a different workspace → must re-apply (don't trust the other ws's state)
    const other = relay(2);
    other.claude!.auth_token = "sk-workspace-b";
    syncRelayConfigs(other, "workspace-b", paths);
    expect(JSON.parse(readFileSync(paths.claudeSettings, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe("sk-workspace-b");
    expect(JSON.parse(readFileSync(paths.stateFile, "utf8")).workspace).toBe("workspace-b");
  });
});
