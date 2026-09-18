import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  loadCodexModelCatalog,
  mergeCodexSessionConfig,
} from "@daemon/agent-runtime/relay-sync.js";
import { prepareIssueSessionProviderHome, type IssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import type { RelayHttpRequest } from "@shared/relay-http.js";
import { runtimeModelsFromAcpCapabilities, runtimeModelsWithCatalogError } from "@multiremi/worker/daemon.js";

const fragment = 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"\nwire_api = "responses"\n';
const catalogModel = {
  slug: "custom-model", display_name: "Custom model", shell_type: "shell_command", visibility: "list",
  supported_in_api: true, priority: 1, support_verbosity: false,
  truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [],
  supported_reasoning_levels: [{ effort: "balanced", description: "Balanced reasoning" }],
  default_reasoning_level: "balanced", context_window: 128000, input_modalities: ["text"],
  model_messages: { instructions_template: "Complete template stays intact" }, unknown_future_field: 42,
};
const catalog = JSON.stringify({ models: [catalogModel] }, null, 2) + "\n";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-codex-catalog-"));
  roots.push(root);
  const base = join(root, "base");
  mkdirSync(base);
  writeFileSync(join(base, "config.toml"), 'model = "my-selected-model"\nmodel_reasoning_effort = "low"\nmodel_catalog_json = "/host/arbitrary.json"\n');
  const home: IssueSessionProviderHome = {
    storageRoot: root, root: join(root, "session"), home: join(root, "session", "home"),
    sessionId: "session", agentId: "agent", generation: 1, provider: "codex",
  };
  return { root, home, options: {
    baseCodexHome: base, linkCodexAuth: false, relayFragment: fragment,
    codexRelayUsesEnvApiKey: true, relayAuthToken: "fixture-key",
  } };
}

const successfulRequest: RelayHttpRequest = async () => ({ status: 200, text: catalog });

describe("isolated Codex Relay model catalog", () => {
  it("fetches the origin endpoint with bounded authenticated transport and preserves the complete body", async () => {
    let request: unknown;
    const result = await loadCodexModelCatalog(fragment, "fixture-key", async (url, init, options) => {
      request = { url, headers: init.headers, options };
      return { status: 200, text: catalog };
    });
    expect(request).toEqual({
      url: "https://gateway.example/backend-api/codex/models",
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
      options: { timeoutMs: 10_000, maxBodyBytes: 1_000_000 },
    });
    expect(result).toEqual({ status: "loaded", content: catalog });
  });

  it("distinguishes no Relay from HTTP, malformed, empty and oversized catalog failures without echoing secrets", async () => {
    expect(await loadCodexModelCatalog(fragment, "", successfulRequest)).toEqual({ status: "disabled" });
    for (const response of [
      { status: 503, text: "fixture-key" },
      { status: 200, text: '{ "fixture-key"' },
      { status: 200, text: '{"models":[]}' },
      { status: 200, text: '{"models":[{"id":"wrong-schema"}]}' },
      { status: 200, text: '{"models":[{"slug":"incomplete-native-model"}]}' },
      ...[
        { default_reasoning_level: 5 }, { supported_reasoning_levels: "invalid" },
        { context_window: "large" }, { input_modalities: false },
        { model_messages: { instructions_template: 42 } },
      ].map(patch => ({ status: 200, text: JSON.stringify({ models: [{ ...catalogModel, ...patch }] }) })),
      { status: 200, text: "x".repeat(1_000_001) },
    ]) {
      const result = await loadCodexModelCatalog(fragment, "fixture-key", async () => response);
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("fixture-key");
    }
    const result = await loadCodexModelCatalog(fragment, "fixture-key", async () => {
      throw new Error("Timeout while reading Bearer fixture-key");
    });
    expect(result).toEqual({ status: "error", error: "Codex model catalog request failed or timed out" });
  });

  it("writes the native catalog as 0600 and puts only its isolated path at TOML top level", async () => {
    const { home, options } = fixture();
    expect(await prepareIssueSessionProviderHome(home, { ...options, codexCatalogHttpRequest: successfulRequest }))
      .toEqual({ codexModelCatalog: { status: "loaded" } });
    const text = readFileSync(join(home.home, "config.toml"), "utf8");
    const config = parseToml(text);
    const path = join(home.home, "model-catalog.json");
    expect(config.model_catalog_json).toBe(path);
    expect(config.model).toBe("my-selected-model");
    expect(config.model_reasoning_effort).toBe("low");
    expect(text.indexOf("model_catalog_json")).toBeLessThan(text.indexOf("[model_providers"));
    expect(text).not.toContain("fixture-key");
    expect(text).not.toContain("/host/arbitrary.json");
    expect(readFileSync(path, "utf8")).toBe(catalog);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    await prepareIssueSessionProviderHome(home, { ...options, codexCatalogHttpRequest: successfulRequest });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes the catalog config after a failed refresh and does not use an inherited or fragment path", async () => {
    const { home, options } = fixture();
    await prepareIssueSessionProviderHome(home, { ...options, codexCatalogHttpRequest: successfulRequest });
    const result = await prepareIssueSessionProviderHome(home, {
      ...options, codexCatalogHttpRequest: async () => ({ status: 502, text: "fixture-key" }),
    });
    expect(result).toEqual({ codexModelCatalog: { status: "error", error: "Codex model catalog HTTP 502" } });
    const config = parseToml(readFileSync(join(home.home, "config.toml"), "utf8"));
    expect(config.model_catalog_json).toBeUndefined();
    expect(config.model).toBe("my-selected-model");
    expect(config.model_reasoning_effort).toBe("low");
    const untrusted = mergeCodexSessionConfig('model_catalog_json = "/host/old.json"',
      'model_catalog_json = "/host/injected.json"\n' + fragment, true);
    expect(parseToml(untrusted).model_catalog_json).toBeUndefined();
  });

  it("refuses a linked catalog target without changing the linked file", async () => {
    const { root, home, options } = fixture();
    await prepareIssueSessionProviderHome(home, { ...options, relayAuthToken: "" });
    const outside = join(root, "host-private.json");
    writeFileSync(outside, "host data");
    symlinkSync(outside, join(home.home, "model-catalog.json"));
    const result = await prepareIssueSessionProviderHome(home, { ...options, codexCatalogHttpRequest: successfulRequest });
    expect(result.codexModelCatalog?.status).toBe("error");
    expect(readFileSync(outside, "utf8")).toBe("host data");
    expect(parseToml(readFileSync(join(home.home, "config.toml"), "utf8")).model_catalog_json).toBeUndefined();
  });

  it("refuses a linked prepared home before fetching or changing outside files and modes", async () => {
    const { root, home, options } = fixture();
    await prepareIssueSessionProviderHome(home, { ...options, codexCatalogHttpRequest: successfulRequest });
    const outside = join(root, "outside-home");
    renameSync(home.home, outside);
    symlinkSync(outside, home.home, "dir");
    const outsideCatalog = join(outside, "model-catalog.json");
    const originalConfig = readFileSync(join(outside, "config.toml"), "utf8");
    chmodSync(outsideCatalog, 0o644);
    let requested = false;
    await expect(prepareIssueSessionProviderHome(home, {
      ...options,
      codexCatalogHttpRequest: async () => {
        requested = true;
        return { status: 200, text: catalog.replace("Complete template", "Changed template") };
      },
    })).rejects.toThrow("must be a real directory");
    expect(requested).toBe(false);
    expect(readFileSync(outsideCatalog, "utf8")).toBe(catalog);
    expect(statSync(outsideCatalog).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(outside, "config.toml"), "utf8")).toBe(originalConfig);
  });

  it("reports only actual bundled members and preserves their reasoning capabilities after a catalog failure", () => {
    expect(runtimeModelsWithCatalogError([
      { id: "bundled-gpt", label: "Bundled GPT", provider: "openai", default: true,
        thinking: { status: "supported", defaultLevel: "low", supportedLevels: [{ value: "low", label: "Low" }] } },
    ], "Codex model catalog HTTP 503")).toEqual([
      { id: "bundled-gpt", label: "Bundled GPT", provider: "openai", default: true,
        thinking: { status: "supported", defaultLevel: "low", supportedLevels: [{ value: "low", label: "Low" }] },
        catalog: { status: "error", error: "Codex model catalog HTTP 503" } },
    ]);
  });

  it("publishes a diagnostic-only report when no actual fallback members could be discovered", () => {
    const models = runtimeModelsWithCatalogError([], "Codex model catalog HTTP 503");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      default: false, providerDefault: true,
      thinking: { status: "unknown", supportedLevels: [] },
      catalog: { status: "error", error: "Codex model catalog HTTP 503" },
    });
    expect(models.filter(model => !model.providerDefault)).toEqual([]);
  });

  it("preserves ACP defaults and distinguishes unknown capabilities from explicit empty levels", () => {
    const models = runtimeModelsFromAcpCapabilities("codex", [
      { id: "custom", label: "Custom", default: false,
        effort: { status: "supported", defaultLevel: "balanced", supportedLevels: [{ value: "balanced", label: "Balanced" }] } },
      { id: "no-config", label: "No config", default: false, effort: { status: "unsupported", supportedLevels: [] } },
      { id: "unknown", label: "Unknown", default: false, effort: { status: "unknown", supportedLevels: [] } },
    ]);
    expect(models.map(model => model.thinking)).toEqual([
      { status: "supported", defaultLevel: "balanced", supportedLevels: [{ value: "balanced", label: "Balanced" }] },
      { status: "unsupported", supportedLevels: [] },
      { status: "unknown", supportedLevels: [] },
    ]);
  });
});
