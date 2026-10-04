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

it("keeps a shared run root through multiple files and their awaited afterAll children", () => {
  const directory = mkdtempSync(join(tmpdir(), "preload-multiple-files-"));
  const resultFile = join(directory, "events.jsonl");
  const files = ["first", "second"].map(name => join(directory, `${name}.test.ts`));
  try {
    for (let index = 0; index < files.length; index++) {
      writeFileSync(files[index]!, `import {test, expect, afterAll} from "bun:test";
        import {appendFileSync, existsSync} from "node:fs";
        const root = process.env.MULTIREMI_TEST_RUN_ROOT;
        function record(phase) {
          expect(existsSync(root)).toBe(true);
          appendFileSync(${JSON.stringify(resultFile)}, JSON.stringify({phase, file:${index}, root}) + "\\n");
        }
        test("root available in file ${index}", () => record("test"));
        afterAll(async () => {
          const child = Bun.spawn([process.execPath, "-e", 'console.log(require("fs").existsSync(process.argv[1]))', root],
            {env:{...process.env}, stdout:"pipe", stderr:"pipe"});
          expect(await new Response(child.stdout).text()).toBe("true\\n");
          expect(await child.exited).toBe(0);
          record("afterAll");
        });`);
    }
    const result = spawnSync(process.execPath, ["test", ...files], {
      cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const events = readFileSync(resultFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(4);
    for (const index of [0, 1]) {
      expect(events.filter(event => event.file === index).map(event => event.phase).sort()).toEqual(["afterAll", "test"]);
    }
    const roots = new Set(events.map(event => event.root));
    expect(roots.size).toBe(1);
    expect(existsSync(events[0].root)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
