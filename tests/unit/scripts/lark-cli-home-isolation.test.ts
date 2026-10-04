import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { larkCliTestEnv } from "../../helpers/lark-cli-isolation.js";

it("redirects signed-out CLI cache writes without creating anything in HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "lark-cli-env-"));
  const home = join(root, "home");
  mkdirSync(home);
  try {
    const env = larkCliTestEnv({
      ...process.env, HOME: home, USERPROFILE: home,
      MULTIREMI_TEST_RUN_ROOT: join(root, "run"),
      LARKSUITE_CLI_CONFIG_DIR: "", LARKSUITE_CLI_DATA_DIR: "", LARKSUITE_CLI_LOG_DIR: "",
    }, home);
    const child = Bun.spawnSync([process.execPath, "-e", `
      const {mkdirSync} = require("node:fs");
      const {join} = require("node:path");
      mkdirSync(join(process.env.LARKSUITE_CLI_CONFIG_DIR, "cache"), {recursive:true});
      mkdirSync(process.env.LARKSUITE_CLI_DATA_DIR, {recursive:true});
      mkdirSync(process.env.LARKSUITE_CLI_LOG_DIR, {recursive:true});
    `], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(join(root, "run", "lark-cli")).sort()).toEqual(["config", "data", "logs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([false, true])("preserves an existing CLI configuration and credential environment (explicit=%s)", (explicit) => {
  const home = mkdtempSync(join(tmpdir(), "lark-cli-config-"));
  try {
    const configDir = join(home, explicit ? "custom-cli" : ".lark-cli");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config.json"), "{}");
    const env = {
      HOME: home,
      LARKSUITE_CLI_CONFIG_DIR: explicit ? configDir : "",
      LARKSUITE_CLI_DATA_DIR: join(home, "existing-data"),
      LARKSUITE_CLI_LOG_DIR: join(home, "existing-logs"),
    };
    expect(larkCliTestEnv(env, home)).toEqual(env);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
