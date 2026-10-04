import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testProcessEnv } from "../../../scripts/run-tests.js";

const ROOT = resolve(import.meta.dir, "../../..");

function fixture(body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "test-wrapper-fixture-"));
  const file = join(directory, "fixture.test.ts");
  try {
    writeFileSync(file, `import { test, expect } from "bun:test";
      import { homedir } from "node:os";
      import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
      import { join } from "node:path";
      console.log("STARTUP_HOME=" + homedir());
      ${body}`);
    const result = spawnSync(process.execPath, ["run", "test", file, ...args], {
      cwd: ROOT, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, XDG_CONFIG_HOME: "/untrusted", XDG_TEST_SENTINEL: "fixture", ...env },
    });
    const output = result.stdout + result.stderr;
    const home = /STARTUP_HOME=(.+)/.exec(output)?.[1];
    expect(home).toBeDefined();
    expect(existsSync(home!)).toBe(false);
    return { status: result.status, output };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("test HOME wrapper", () => {
  it("forwards CI database input and an explicitly disabled lock sentinel", () => {
    const result = fixture(`test("CI inputs", () => {
      expect(process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL).toBe("0");
      expect(process.env.MULTIREMI_TEST_POSTGRES_URL).toBe("postgres://fixture.invalid/isolated");
    });`, [], {
      MULTIREMI_TEST_LOCK_ORDER_SENTINEL: "0",
      MULTIREMI_TEST_POSTGRES_URL: "postgres://fixture.invalid/isolated",
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("[test-home] residual paths: []");
  });

  it("isolates startup HOME, clears XDG, forwards arguments and inherits test inputs", () => {
    const result = fixture(`
      test("selected with spaces", () => {
        expect(process.env.HOME).toBe(homedir());
        expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
        expect(process.env.XDG_TEST_SENTINEL).toBeUndefined();
        expect(process.env.GIT_CONFIG_GLOBAL).toBe(join(homedir(), ".gitconfig"));
        expect(process.env.BUN_INSTALL_CACHE_DIR.startsWith(homedir())).toBe(false);
        expect(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH.startsWith(homedir())).toBe(false);
        const child = Bun.spawnSync([process.execPath, "-e", 'console.log(require("os").homedir())']);
        expect(new TextDecoder().decode(child.stdout).trim()).toBe(homedir());
      });
      test("excluded", () => { throw new Error("must be filtered out"); });
    `, ["-t", "selected with spaces"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("[test-home] residual paths: []");
  });

  it("fails and names a home canary even when the test passes", () => {
    const result = fixture(`test("canary", () => {
      mkdirSync(join(homedir(), ".remi"), { recursive: true });
      writeFileSync(join(homedir(), ".remi", "qa-canary"), "fixture");
    });`);
    expect(result.output).toContain("1 pass");
    expect(result.status).toBe(1);
    expect(result.output).toContain(".remi/qa-canary");
  });

  it("rejects empty directories and symlinks without traversing them", () => {
    const result = fixture(`test("entries", () => {
      mkdirSync(join(homedir(), "empty"));
      symlinkSync(${JSON.stringify(ROOT)}, join(homedir(), "alias"), "junction");
    });`);
    expect(result.status).toBe(1);
    expect(result.output).toContain("\nalias\n");
    expect(result.output).toContain("\nempty\n");
    expect(result.output).not.toContain("alias/package.json");
  });

  it("preserves a failing child exit when home is clean", () => {
    const result = fixture('test("fails", () => { expect(1).toBe(2); });');
    expect(result.status).toBe(1);
    expect(result.output).toContain("[test-home] residual paths: []");
  });

  it("sets both Windows home variables without mutating inherited env", () => {
    const inherited = { HOME: "original", USERPROFILE: "original", XDG_DATA_HOME: "fixture",
      MULTIREMI_TEST_MARKER: "kept" };
    const env = testProcessEnv("fixture-home", inherited, "win32");
    expect(env.HOME).toBe("fixture-home");
    expect(env.USERPROFILE).toBe("fixture-home");
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.MULTIREMI_TEST_MARKER).toBe("kept");
    expect(inherited.HOME).toBe("original");
    expect(inherited.XDG_DATA_HOME).toBe("fixture");
  });
});
