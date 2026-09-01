import { describe, expect, it } from "bun:test";
import { defaultRemiConfig, loadConfig } from "@shared/config.js";

describe("loadConfig", () => {
  it("returns defaults in a clean environment without touching local state", () => {
    expect(loadConfig({})).toEqual(defaultRemiConfig());
  });

  it("preserves every supported environment override", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_PORT: "9010",
      FEISHU_DOMAIN: "lark",
      FEISHU_USER_ACCESS_TOKEN: "user-token",
      GOOGLE_API_KEY: "google-key",
      REMI_LOG_LEVEL: "DEBUG",
    });

    expect(config.feishu).toEqual({
      appId: "app-id",
      appSecret: "app-secret",
      port: 9010,
      domain: "lark",
      connectionMode: "websocket",
      userAccessToken: "user-token",
    });
    expect(config.google).toEqual({ apiKey: "google-key" });
    expect(config.logLevel).toBe("DEBUG");
  });

  it("loads active token sync and plugin settings from structured env", () => {
    const config = loadConfig({
      REMI_TOKEN_SYNC_RULES_JSON: JSON.stringify([
        { name: "claude", source: "feishu/user", target: "/tmp/claude-token", format: "raw" },
      ]),
      REMI_PLUGINS_DIR: "/opt/remi/plugins",
      REMI_PLUGINS_ENABLED_JSON: JSON.stringify(["sso"]),
      REMI_PLUGINS_ALLOW_EXTERNAL: "false",
      REMI_PLUGIN_CONFIGS_JSON: JSON.stringify({ sso: { enabled: true } }),
    });

    expect(config.tokenSync).toHaveLength(1);
    expect(config.plugins).toEqual({
      dir: "/opt/remi/plugins",
      enabled: ["sso"],
      allowExternal: false,
    });
    expect(config.pluginConfigs).toEqual({ sso: { enabled: true } });
  });

  it("reports malformed structured env explicitly", () => {
    expect(() => loadConfig({ REMI_PLUGIN_CONFIGS_JSON: "not-json" })).toThrow(
      "REMI_PLUGIN_CONFIGS_JSON must contain valid JSON",
    );
    expect(() => loadConfig({ REMI_PLUGINS_ALLOW_EXTERNAL: "maybe" })).toThrow(
      "REMI_PLUGINS_ALLOW_EXTERNAL must be true or false",
    );
    expect(() => loadConfig({ REMI_TOKEN_SYNC_RULES_JSON: '[{"format":"unknown"}]' })).toThrow(
      "REMI_TOKEN_SYNC_RULES_JSON has an invalid JSON shape",
    );
  });
});
