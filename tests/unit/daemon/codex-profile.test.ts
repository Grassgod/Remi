import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { resolveRuntimeCodexProfile } from "@daemon/agent-runtime/codex-profile.js";
import { prepareIssueSessionProviderHome, loadIssueSessionProviderEnv, type IssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { encryptRuntimeProviderKey, decryptRuntimeProviderKey } from "@multiremi/runtime-provider-credentials.js";

const profile = { name: "custom", base_url: "http://127.0.0.1:9000/v1", model: "unlisted-model", env_key: "REMI_CODEX_CUSTOM" };
const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
const originalPrevious = process.env.MULTIREMI_PROVIDER_ENCRYPTION_PREVIOUS_KEYS;
afterEach(() => {
  for (const [key, value] of [["MULTIREMI_PROVIDER_ENCRYPTION_KEY", originalKey], ["MULTIREMI_PROVIDER_ENCRYPTION_PREVIOUS_KEYS", originalPrevious]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it("injects routing and the custom model into isolated CODEX_HOME, keeping keys out of files", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-codex-profile-"));
  try {
    await writeFile(join(root, "config.toml"), 'model = "base-model"\nmodel_provider = "native"\n');
    const home: IssueSessionProviderHome = { storageRoot: root, root: join(root, "execution"), home: join(root, "execution", "home"), provider: "codex", agentId: "agent", sessionId: "session", generation: 1 };
    const relay = resolveRuntimeCodexProfile(profile, { REMI_CODEX_CUSTOM: "in-memory-only" });
    const env = await loadIssueSessionProviderEnv(home, { relayFragment: relay.fragment, relayAuthToken: relay.auth_token });
    await prepareIssueSessionProviderHome(home, { baseCodexHome: root, linkCodexAuth: false, relayFragment: relay.fragment, codexRelayUsesEnvApiKey: true });
    const toml = await readFile(join(home.home, "config.toml"), "utf8");
    expect(parse(toml)).toMatchObject({ model: "unlisted-model", model_provider: "remi_custom", model_providers: { remi_custom: { base_url: profile.base_url, env_key: "OPENAI_API_KEY", requires_openai_auth: false } } });
    expect(toml).not.toContain("in-memory-only");
    expect(env.OPENAI_API_KEY).toBe("in-memory-only");
    expect(await readFile(join(root, "config.toml"), "utf8")).toContain("base-model");
    expect(await Bun.file(join(home.home, "auth.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("fails on a missing environment key and never falls back to an unrelated machine key", () => {
  expect(() => resolveRuntimeCodexProfile(profile, { OPENAI_API_KEY: "unrelated" })).toThrow("REMI_CODEX_CUSTOM");
  expect(resolveRuntimeCodexProfile({ ...profile, auth_mode: "api_key", env_key: "" }, {}, "delivered-key").auth_token).toBe("delivered-key");
});

it("binds encrypted credentials to workspace, Runtime and immutable version and supports key rotation", () => {
  const first = Buffer.alloc(32, 1).toString("base64");
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = first;
  const scope = { workspaceId: "ws", runtimeId: "rt", credentialId: "rck_one" };
  const encrypted = encryptRuntimeProviderKey("private-value", scope);
  expect(decryptRuntimeProviderKey(encrypted, scope)).toBe("private-value");
  for (const changed of [{ workspaceId: "other" }, { runtimeId: "other" }, { credentialId: "rck_other" }]) expect(() => decryptRuntimeProviderKey(encrypted, { ...scope, ...changed })).toThrow();
  expect(() => decryptRuntimeProviderKey(encrypted.slice(0, -4) + "AAAA", scope)).toThrow();
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
  expect(() => decryptRuntimeProviderKey(encrypted, scope)).toThrow();
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_PREVIOUS_KEYS = first;
  expect(decryptRuntimeProviderKey(encrypted, scope)).toBe("private-value");
});
