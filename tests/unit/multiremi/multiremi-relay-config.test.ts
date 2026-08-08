import { afterEach, describe, expect, it } from "bun:test";
import { extractBaseUrl, validateRelayFragment } from "@multiremi/relay/fragment.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const CLAUDE_FRAGMENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } });
const CODEX_FRAGMENT = [
  'model_provider = "OpenAI"',
  "",
  "[model_providers.OpenAI]",
  'base_url = "https://vip.openremi.fun/v1"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
].join("\n");

describe("relay config store", () => {
  it("upserts, masks token for browser, reveals plaintext for daemon", () => {
    const store = createStore();
    const rev = store.upsertRelayConfig("local", "claude", {
      fragment: CLAUDE_FRAGMENT,
      tokenOp: "set",
      authToken: "sk-ant-secret",
    });
    expect(rev).toBe(1);

    const browser = store.getRelayConfigForBrowser("local");
    expect(browser.claude?.fragment).toBe(CLAUDE_FRAGMENT);
    expect(browser.claude?.hasToken).toBe(true);
    // browser view never carries the plaintext token
    expect(JSON.stringify(browser)).not.toContain("sk-ant-secret");

    const daemon = store.getRelayConfigForDaemon("local");
    expect(daemon.claude?.authToken).toBe("sk-ant-secret");
    expect(daemon.claude?.revision).toBe(1);
    expect(daemon.codex).toBeNull();
  });

  it("token op keep preserves, clear removes, revision is monotonic", () => {
    const store = createStore();
    store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAGMENT, tokenOp: "set", authToken: "tok1" });
    // keep: fragment changes but token stays
    const newFrag = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://vip.openremi.fun" } });
    store.upsertRelayConfig("local", "claude", { fragment: newFrag, tokenOp: "keep" });
    let daemon = store.getRelayConfigForDaemon("local");
    expect(daemon.claude?.authToken).toBe("tok1");
    expect(daemon.claude?.fragment).toBe(newFrag);
    expect(daemon.claude?.revision).toBe(2);
    // clear: token wiped
    store.upsertRelayConfig("local", "claude", { fragment: newFrag, tokenOp: "clear" });
    daemon = store.getRelayConfigForDaemon("local");
    expect(daemon.claude?.authToken).toBe("");
    expect(store.getRelayConfigForBrowser("local").claude?.hasToken).toBe(false);
    expect(daemon.claude?.revision).toBe(3);
  });

  it("model discovery flag round-trips through workspace settings", () => {
    const store = createStore();
    expect(store.getRelayModelDiscovery("local")).toBe(false);
    store.setRelayModelDiscovery("local", true);
    expect(store.getRelayModelDiscovery("local")).toBe(true);
    expect(store.getRelayConfigForDaemon("local").modelDiscovery).toBe(true);
  });

  it("gateway models snapshot saves and revision-fences stale writes", () => {
    const store = createStore();
    store.saveGatewayModels("local", "codex", {
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      sourceRevision: 5,
    });
    expect(store.getGatewayModels("local", "codex")?.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }]);
    // stale run (lower revision) must not overwrite
    store.saveGatewayModels("local", "codex", { models: [{ id: "old", label: "Old" }], sourceRevision: 3 });
    expect(store.getGatewayModels("local", "codex")?.models[0].id).toBe("gpt-5.6-sol");
    // newer run wins
    store.saveGatewayModels("local", "codex", { models: [{ id: "gpt-6", label: "GPT-6" }], sourceRevision: 6 });
    expect(store.getGatewayModels("local", "codex")?.models[0].id).toBe("gpt-6");
    // error-only update keeps last-known-good models but records the error
    store.saveGatewayModels("local", "codex", { sourceRevision: 7, error: "gateway 503" });
    const snap = store.getGatewayModels("local", "codex");
    expect(snap?.models[0].id).toBe("gpt-6");
    expect(snap?.lastError).toBe("gateway 503");
  });
});

describe("relay fragment validation", () => {
  it("accepts valid claude/codex fragments", () => {
    expect(validateRelayFragment("claude", CLAUDE_FRAGMENT).ok).toBe(true);
    expect(validateRelayFragment("codex", CODEX_FRAGMENT).ok).toBe(true);
    expect(validateRelayFragment("claude", "").ok).toBe(true); // empty = no-op
  });

  it("rejects secret-bearing keys smuggled into the fragment", () => {
    const withToken = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun", ANTHROPIC_AUTH_TOKEN: "sk-x" } });
    const r = validateRelayFragment("claude", withToken);
    expect(r.ok).toBe(false);
    const codexBearer = CODEX_FRAGMENT + '\nexperimental_bearer_token = "sk-x"';
    expect(validateRelayFragment("codex", codexBearer).ok).toBe(false);
  });

  it("rejects non-whitelisted keys, hooks, and prototype pollution", () => {
    expect(validateRelayFragment("claude", JSON.stringify({ hooks: {} })).ok).toBe(false);
    expect(validateRelayFragment("claude", JSON.stringify({ env: { SOMETHING_ELSE: "x" } })).ok).toBe(false);
    expect(validateRelayFragment("claude", '{"env":{"__proto__":{"a":1}}}').ok).toBe(false);
    expect(validateRelayFragment("codex", 'model_provider = "x"\nfoo = 1').ok).toBe(false);
  });

  it("rejects non-https and private/metadata gateway URLs", () => {
    expect(validateRelayFragment("claude", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://ai.openremi.fun" } })).ok).toBe(false);
    expect(validateRelayFragment("claude", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://169.254.169.254/" } })).ok).toBe(false);
    expect(validateRelayFragment("claude", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://10.0.0.1/" } })).ok).toBe(false);
    expect(validateRelayFragment("codex", CODEX_FRAGMENT.replace("https://vip.openremi.fun/v1", "https://localhost/v1")).ok).toBe(false);
  });

  it("extractBaseUrl reads the gateway URL from stored fragments", () => {
    expect(extractBaseUrl("claude", CLAUDE_FRAGMENT)).toBe("https://ai.openremi.fun");
    expect(extractBaseUrl("codex", CODEX_FRAGMENT)).toBe("https://vip.openremi.fun/v1");
    expect(extractBaseUrl("claude", "")).toBeNull();
  });

  it("enforces codex provider field types and model_provider reference", () => {
    const bad = (extra: string) =>
      validateRelayFragment("codex", `model_provider = "OpenAI"\n[model_providers.OpenAI]\nbase_url = "https://vip.openremi.fun/v1"\n${extra}`);
    expect(bad('wire_api = "chat"').ok).toBe(false);
    expect(bad("requires_openai_auth = 1").ok).toBe(false); // int, not boolean
    expect(bad('supports_websockets = "yes"').ok).toBe(false);
    expect(validateRelayFragment("codex", 'model_provider = "Missing"\n[model_providers.OpenAI]\nbase_url = "https://vip.openremi.fun/v1"').ok).toBe(false);
    // providers defined but no active model_provider → rejected (would leave a stale gateway on rename)
    expect(validateRelayFragment("codex", '[model_providers.OpenAI]\nbase_url = "https://vip.openremi.fun/v1"').ok).toBe(false);
  });
});

describe("relay config revision", () => {
  it("increments monotonically per engine", () => {
    const store = createStore();
    expect(store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAGMENT, tokenOp: "set", authToken: "a" })).toBe(1);
    expect(store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAGMENT, tokenOp: "keep" })).toBe(2);
    expect(store.upsertRelayConfig("local", "claude", { fragment: CLAUDE_FRAGMENT, tokenOp: "keep" })).toBe(3);
    // codex has its own independent counter
    expect(store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAGMENT, tokenOp: "set", authToken: "b" })).toBe(1);
  });
});
