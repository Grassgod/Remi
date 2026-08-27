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
    config.feishu.appId = "test-app-id";
    config.logLevel = "DEBUG";

    store.save(config);

    expect(store.isEmpty()).toBe(false);

    const loaded = store.load();
    expect(loaded.feishu.appId).toBe("test-app-id");
    expect(loaded.logLevel).toBe("DEBUG");
  });

  it("getSection / setSection work independently", () => {
    store.setSection("proxy", { http: "http://proxy.test", noProxy: "localhost" });
    const result = store.getSection("proxy") as any;
    expect(result.http).toBe("http://proxy.test");
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
    expect(loaded.feishu.port).toBe(9000);
  });

  it("respects connector env overrides on load", () => {
    store.save(defaultRemiConfig());
    process.env.FEISHU_PORT = "9010";
    try {
      const loaded = store.load();
      expect(loaded.feishu.port).toBe(9010);
    } finally {
      delete process.env.FEISHU_PORT;
    }
  });

  it("save preserves all sections", () => {
    const config = defaultRemiConfig();
    config.pluginConfigs = { sample: { enabled: true } };
    store.save(config);

    const loaded = store.load();
    expect(loaded.pluginConfigs).toEqual({ sample: { enabled: true } });
  });
});
