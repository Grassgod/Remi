import { describe, expect, it } from "bun:test";
import { parse as parseToml } from "smol-toml";
import {
  deepMerge,
  mergeClaudeSettings,
  mergeCodexConfig,
  mergeCodexSessionConfig,
} from "@daemon/agent-runtime/relay-sync.js";

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

  it("removes inline secrets from Claude Relay fragments", () => {
    const out = mergeClaudeSettings({}, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://ai.openremi.fun",
        CUSTOM_TOKEN: "literal-secret",
        Authorization: "Bearer literal-secret",
        ENABLE_TOOL_SEARCH: "1",
      },
      nested: { api_key: "inline", keep: true },
    }), "runtime-token");
    const env = out.env as Record<string, string>;

    expect(env.ANTHROPIC_BASE_URL).toBe("https://ai.openremi.fun");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("runtime-token");
    expect(env.ENABLE_TOOL_SEARCH).toBe("1");
    expect(env.CUSTOM_TOKEN).toBeUndefined();
    expect(env.Authorization).toBeUndefined();
    expect(out.nested).toEqual({ keep: true });
  });

  it("preserves opaque Plugin names while sanitizing their config values", () => {
    const out = mergeClaudeSettings({
      enabledPlugins: {
        "token-counter@example": true,
        "wiki@example": true,
      },
    }, "", "");

    expect(out.enabledPlugins).toEqual({
      "token-counter@example": true,
      "wiki@example": true,
    });
  });

  it("mergeCodexConfig preserves projects/hooks, applies provider block, strips inline secret", () => {
    const current = [
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://old.example.com/v1"',
      'experimental_bearer_token = "sk-inline"',
      'env_key = "CORP_OPENAI_TOKEN"',
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
    expect(out.model_providers.OpenAI.env_key).toBe("CORP_OPENAI_TOKEN");
    expect(out.model_providers.OpenAI.wire_api).toBe("responses"); // untouched existing key
    expect(out.projects["/home/u/repo"].trust_level).toBe("trusted"); // machine-specific preserved
  });


  it("routes a Session Relay token through OPENAI_API_KEY without writing the token", () => {
    const current = [
      'model = "gpt-test"',
      "[model_providers.Legacy]",
      'experimental_bearer_token = "sk-legacy"',
    ].join("\n");
    const fragment = [
      'model_provider = "OpenAI"',
      "[model_providers.OpenAI]",
      'base_url = "https://vip.openremi.fun/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n");
    const text = mergeCodexSessionConfig(current, fragment, true);
    const out = parseToml(text) as Record<string, any>;

    expect(out.model).toBe("gpt-test");
    expect(out.model_provider).toBe("OpenAI");
    expect(out.model_providers.OpenAI.env_key).toBe("OPENAI_API_KEY");
    expect(out.model_providers.OpenAI.requires_openai_auth).toBe(false);
    expect(out.model_providers.Legacy.experimental_bearer_token).toBeUndefined();
    expect(text).not.toContain("sk-");
  });

  it("keeps only environment pointers for Codex Relay headers", () => {
    const fragment = [
      'model_provider = "OpenAI"',
      "[model_providers.OpenAI]",
      'base_url = "https://vip.openremi.fun/v1"',
      'env_key = "STATIC_TOKEN"',
      'experimental_bearer_token = "literal-token"',
      "[model_providers.OpenAI.http_headers]",
      'Authorization = "Bearer literal-secret"',
      "[model_providers.OpenAI.env_http_headers]",
      'Authorization = "OPENAI_GATEWAY_AUTH"',
      'Invalid = "Bearer literal-secret"',
    ].join("\n");
    const text = mergeCodexSessionConfig("", fragment, true);
    const out = parseToml(text) as Record<string, any>;

    expect(out.model_providers.OpenAI.http_headers).toBeUndefined();
    expect(out.model_providers.OpenAI.experimental_bearer_token).toBeUndefined();
    expect(out.model_providers.OpenAI.env_http_headers).toEqual({
      Authorization: "OPENAI_GATEWAY_AUTH",
    });
    expect(out.model_providers.OpenAI.env_key).toBe("OPENAI_API_KEY");
    expect(text).not.toContain("literal-secret");
    expect(text).not.toContain("literal-token");
  });

  it("rejects env Relay auth when no active Codex provider exists", () => {
    expect(() => mergeCodexSessionConfig('model = "gpt-test"\n', "", true)).toThrow(
      "no active model provider",
    );
  });

  it("mergeClaudeSettings fails closed when a token has no gateway base_url", () => {
    // token set but fragment (and existing settings) define no ANTHROPIC_BASE_URL
    expect(() => mergeClaudeSettings({}, "{}", "sk-orphan")).toThrow(/base_url/);
    // no token → allowed (pure no-op merge)
    expect(() => mergeClaudeSettings({}, "{}", "")).not.toThrow();
  });
});
