import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfigStore } from "@shared/db/config-store.js";
import { defaultRemiConfig } from "@shared/config.js";
import type { RemiConfig } from "@shared/config.js";

let db: Database;
let store: ConfigStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE remi_config (
      section    TEXT NOT NULL,
      key        TEXT NOT NULL DEFAULT '',
      value      TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (section, key)
    )
  `);
  store = new ConfigStore(db);
});

afterEach(() => {
  db.close();
});

describe("ConfigStore", () => {
  it("isEmpty returns true for fresh DB", () => {
    expect(store.isEmpty()).toBe(true);
  });

  it("save + load round-trips a config", () => {
    const config = defaultRemiConfig();
    config.provider.default = "codex";
    config.feishu.appId = "test-app-id";
    config.logLevel = "DEBUG";

    store.save(config);

    expect(store.isEmpty()).toBe(false);

    const loaded = store.load();
    expect(loaded.provider.default).toBe("codex");
    expect(loaded.feishu.appId).toBe("test-app-id");
    expect(loaded.logLevel).toBe("DEBUG");
  });

  it("getSection / setSection work independently", () => {
    store.setSection("provider", { default: "claude", claude: {}, codex: {} });
    const result = store.getSection("provider") as any;
    expect(result.default).toBe("claude");
  });

  it("setSection upserts on conflict", () => {
    store.setSection("logLevel", "INFO");
    store.setSection("logLevel", "DEBUG");
    expect(store.getSection("logLevel")).toBe("DEBUG");
  });

  it("load returns defaults for missing sections", () => {
    store.setSection("logLevel", "WARN");
    const loaded = store.load();
    expect(loaded.logLevel).toBe("WARN");
    expect(loaded.provider.default).toBe("claude");
    expect(loaded.feishu.port).toBe(9000);
    expect(loaded.feishu.multiremi).toEqual({
      enabled: false,
      serverUrl: "http://127.0.0.1:6120",
      token: "",
      workspaceId: "local",
    });
  });

  it("respects env overrides on load", () => {
    store.save(defaultRemiConfig());
    process.env.REMI_PROVIDER = "codex";
    try {
      const loaded = store.load();
      expect(loaded.provider.default).toBe("codex");
    } finally {
      delete process.env.REMI_PROVIDER;
    }
  });

  it("merges legacy Feishu config and applies Multiremi env overrides", () => {
    store.setSection("feishu", { appId: "legacy-app" });
    process.env.FEISHU_MULTIREMI_ENABLED = "true";
    process.env.FEISHU_MULTIREMI_SERVER_URL = "http://multiremi.internal:6120";
    process.env.FEISHU_MULTIREMI_TOKEN = "member-token";
    process.env.FEISHU_MULTIREMI_WORKSPACE_ID = "ws_team";
    try {
      const loaded = store.load();
      expect(loaded.feishu.appId).toBe("legacy-app");
      expect(loaded.feishu.appSecret).toBe("");
      expect(loaded.feishu.multiremi).toEqual({
        enabled: true,
        serverUrl: "http://multiremi.internal:6120",
        token: "member-token",
        workspaceId: "ws_team",
      });
    } finally {
      delete process.env.FEISHU_MULTIREMI_ENABLED;
      delete process.env.FEISHU_MULTIREMI_SERVER_URL;
      delete process.env.FEISHU_MULTIREMI_TOKEN;
      delete process.env.FEISHU_MULTIREMI_WORKSPACE_ID;
    }
  });

  it("save preserves all sections", () => {
    const config = defaultRemiConfig();
    config.mcp = [{ name: "test", command: "echo" }];
    config.cronJobs = [{ id: "j1", handler: "h1" }];
    store.save(config);

    const loaded = store.load();
    expect(loaded.mcp).toEqual([{ name: "test", command: "echo" }]);
    expect(loaded.cronJobs[0].id).toBe("j1");
  });
});
