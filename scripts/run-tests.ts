import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const CACHE_ROOT = resolve(import.meta.dir, "../node_modules/.cache/bun");

export function testProcessEnv(
  home: string,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    if (name.startsWith("XDG_")) delete env[name];
  }
  env.HOME = home;
  if (platform === "win32") env.USERPROFILE = home;
  env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(CACHE_ROOT, "transpiler");
  env.BUN_INSTALL_CACHE_DIR = join(CACHE_ROOT, "install");
  return env;
}

function homeEntries(home: string): string[] {
  const entries: string[] = [];
  function visit(directory: string, prefix = ""): void {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = join(prefix, name);
      const path = join(directory, name);
      entries.push(relativePath.split(sep).join("/"));
      // Do not follow symlinks out of this run's home.
      if (lstatSync(path).isDirectory()) visit(path, relativePath);
    }
  }
  visit(home);
  return entries;
}

export interface TestRunMetadata { childExitCode: number; homeEmpty: boolean; observerFailed: boolean; interrupted: boolean }
export async function runTests(args: string[], observe?: (text: string, stream: "stdout" | "stderr") => void, onComplete?: (metadata: TestRunMetadata) => void): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "remi-test-home-"));
  try {
    const env = testProcessEnv(home);
    mkdirSync(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!, { recursive: true });
    mkdirSync(env.BUN_INSTALL_CACHE_DIR!, { recursive: true });
    const child = Bun.spawn([process.execPath, "test", ...args], {
      env, stdin: "inherit", stdout: observe ? "pipe" : "inherit", stderr: observe ? "pipe" : "inherit",
    });
    let observerFailed = false;
    const pump = async (stream: ReadableStream<Uint8Array>, output: NodeJS.WriteStream, source: "stdout" | "stderr") => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) { output.write(chunk); try { observe!(decoder.decode(chunk, { stream: true }), source); } catch (error) { observerFailed = true; console.error("[test-home] log observer failed:", error); } }
      const tail = decoder.decode(); if (tail) { try { observe!(tail, source); } catch (error) { observerFailed = true; console.error("[test-home] log observer failed:", error); } }
    };
    const streams = observe ? [pump(child.stdout as ReadableStream<Uint8Array>, process.stdout, "stdout"), pump(child.stderr as ReadableStream<Uint8Array>, process.stderr, "stderr")] : [];
    const drained = Promise.all(streams).catch(error => { observerFailed = true; console.error("[test-home] stream drain failed:", error); });
    let interrupted = false;
    const interrupt = () => { interrupted = true; child.kill("SIGINT"); };
    const terminate = () => { interrupted = true; child.kill("SIGTERM"); };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    let exitCode: number;
    try { exitCode = await child.exited; await drained; }
    finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
    const entries = homeEntries(home);
    onComplete?.({ childExitCode: exitCode, homeEmpty: entries.length === 0, observerFailed, interrupted });
    if (entries.length > 0) {
      console.error("[test-home] unexpected writes:");
      for (const entry of entries) console.error(entry);
      return 1;
    }
    console.error("[test-home] residual paths: []");
    return exitCode || (observerFailed || interrupted ? 1 : 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { process.exitCode = await runTests(process.argv.slice(2)); }
  catch (error) {
    console.error("[test-home] runner failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
