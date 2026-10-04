import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("replaces inherited test roots, preserves test inputs and cleans only its own run root", () => {
  const directory = mkdtempSync(join(tmpdir(), "preload-process-probe-"));
  const untrustedRoot = join(directory, "untrusted");
  const resultFile = join(directory, "result.json");
  const testFile = join(directory, "probe.test.ts");
  mkdirSync(untrustedRoot);
  writeFileSync(join(untrustedRoot, "sentinel"), "keep");
  writeFileSync(testFile, `import { test, expect } from "bun:test";
    import { homedir } from "node:os";
    import { writeFileSync } from "node:fs";
    test("environment", () => {
      expect(process.env.HOME).toBe(homedir());
      expect(process.env.MULTIREMI_TEST_PROBE_MARKER).toBe("preserved");
      expect(process.env.FEISHU_TEST_CHAT_ID).toBe("fixture");
      expect(process.env.MULTIREMI_TOKEN).toBeUndefined();
      writeFileSync(process.env.MULTIREMI_TEST_PROBE_RESULT, JSON.stringify({
        root: process.env.MULTIREMI_TEST_RUN_ROOT, state: process.env.MULTIREMI_STATE_DIR
      }));
    });`);
  try {
    const roots: string[] = [];
    for (let run = 0; run < 3; run++) {
      if (run === 2) appendFileSync(testFile, 'test("ordinary failure", () => expect(1).toBe(2));');
      const result = spawnSync(process.execPath, ["test", testFile], {
        cwd: resolve(import.meta.dir, "../../.."), encoding: "utf8", timeout: 15_000,
        env: { ...process.env, MULTIREMI_TEST_RUN_ROOT: untrustedRoot,
          MULTIREMI_STATE_DIR: untrustedRoot, MULTIREMI_TOKEN: "fixture-only",
          MULTIREMI_TEST_PROBE_MARKER: "preserved", FEISHU_TEST_CHAT_ID: "fixture",
          MULTIREMI_TEST_PROBE_RESULT: resultFile },
      });
      expect(result.status, result.stderr).toBe(run === 2 ? 1 : 0);
      const received = JSON.parse(readFileSync(resultFile, "utf8"));
      expect(received.root).not.toBe(untrustedRoot);
      expect(received.state).toBe(join(received.root, "state"));
      expect(existsSync(received.root)).toBe(false);
      roots.push(received.root);
    }
    expect(roots[0]).not.toBe(roots[1]);
    expect(readFileSync(join(untrustedRoot, "sentinel"), "utf8")).toBe("keep");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
