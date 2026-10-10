import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("signal probe timed out")), 5_000); }),
    ]);
  } finally { clearTimeout(timer!); }
}

it.each([
  ["SIGINT", 0], ["SIGINT", 77], ["SIGTERM", 0], ["SIGTERM", 77],
] as const)("forwards %s and rejects interrupted child exit %i", async (signal, childExitCode) => {
  const directory = mkdtempSync(join(tmpdir(), "wrapper-signal-"));
  const file = join(directory, "signal.test.ts");
  writeFileSync(file, `import {test} from "bun:test";
    import {homedir} from "node:os";
    test("await signal", async () => {
      process.on("SIGINT", () => process.exit(${childExitCode}));
      process.on("SIGTERM", () => process.exit(${childExitCode}));
      console.log("SIGNAL_HOME=" + homedir());
      await new Promise(() => { setInterval(() => {}, 100); });
    }, 20_000);`);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../../scripts/run-tests.ts"), file], {
    cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  try {
    const home = await bounded((async () => {
      let text = "";
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Signal fixture exited before readiness: ${await stderr}`);
        text += decoder.decode(value, { stream: true });
        const match = /SIGNAL_HOME=([^\r\n]+)\r?\n/.exec(text);
        if (match) return match[1]!;
      }
    })());
    child.kill(signal);
    expect(await bounded(child.exited)).toBe(childExitCode || 1);
    expect(await stderr).toContain("[test-home] residual paths: []");
    expect(existsSync(home)).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reader.cancel();
    await stderr;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
