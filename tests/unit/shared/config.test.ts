import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../../src/shared/config.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Config", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["REMI_PROVIDER", "REMI_FALLBACK", "REMI_MODEL", "REMI_TIMEOUT"];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Save and clear env vars
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore env vars
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("loads defaults", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.toml"));
    expect(config.provider.default).toBe("claude");
    expect(config.provider.claude.timeout).toBe(300);
    expect(config.provider.claude.allowedTools).toEqual([]);
  });

  it("respects env overrides", () => {
    process.env.REMI_PROVIDER = "codex";
    process.env.REMI_TIMEOUT = "60";

    const config = loadConfig(join(tmpDir, "nonexistent.toml"));
    expect(config.provider.default).toBe("codex");
    expect(config.provider.name).toBe("codex");
    expect(config.provider.claude.timeout).toBe(60);
  });

  it("reads toml file", () => {
    const tomlPath = join(tmpDir, "remi.toml");
    writeFileSync(
      tomlPath,
      `
[provider]
default = "codex"

[provider.claude]
timeout = 120

[feishu]
app_id = "test-app"
port = 8080
`,
    );

    const config = loadConfig(tomlPath);
    expect(config.provider.default).toBe("codex");
    expect(config.provider.claude.timeout).toBe(120);
    expect(config.feishu.appId).toBe("test-app");
    expect(config.feishu.port).toBe(8080);
  });

  it("env overrides toml", () => {
    process.env.REMI_PROVIDER = "codex";

    const tomlPath = join(tmpDir, "remi.toml");
    writeFileSync(
      tomlPath,
      `
[provider]
default = "claude"
`,
    );

    const config = loadConfig(tomlPath);
    expect(config.provider.default).toBe("codex"); // env wins
  });
});
