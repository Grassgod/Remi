import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultRemiConfig } from "@shared/config.js";
import { ConfigStore } from "@shared/db/config-store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Config", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["FEISHU_PORT", "REMI_LOG_LEVEL"];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const { setDbPath } = require("@shared/db/index.js");
    setDbPath(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    const { closeDb } = require("@shared/db/index.js");
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("loads defaults from empty DB", () => {
    const { getDb } = require("@shared/db/index.js");
    const store = new ConfigStore(getDb());
    const config = store.load();
    expect(config.feishu.port).toBe(9000);
    expect(config.logLevel).toBe("INFO");
  });

  it("respects env overrides", () => {
    process.env.FEISHU_PORT = "9010";
    process.env.REMI_LOG_LEVEL = "DEBUG";

    const { getDb } = require("@shared/db/index.js");
    const store = new ConfigStore(getDb());
    const config = store.load();
    expect(config.feishu.port).toBe(9010);
    expect(config.logLevel).toBe("DEBUG");
  });

  it("round-trips through save/load", () => {
    const { getDb } = require("@shared/db/index.js");
    const store = new ConfigStore(getDb());
    const original = defaultRemiConfig();
    original.feishu.appId = "test-app";
    original.feishu.port = 8080;

    store.save(original);
    const loaded = store.load();
    expect(loaded.feishu.appId).toBe("test-app");
    expect(loaded.feishu.port).toBe(8080);
  });

  it("env overrides DB values", () => {
    process.env.REMI_LOG_LEVEL = "DEBUG";

    const { getDb } = require("@shared/db/index.js");
    const store = new ConfigStore(getDb());
    const original = defaultRemiConfig();
    original.logLevel = "WARN";
    store.save(original);

    const config = store.load();
    expect(config.logLevel).toBe("DEBUG");
  });
});
