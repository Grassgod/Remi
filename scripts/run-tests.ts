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

export async function runTests(args: string[]): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "remi-test-home-"));
  try {
    const env = testProcessEnv(home);
    mkdirSync(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!, { recursive: true });
    mkdirSync(env.BUN_INSTALL_CACHE_DIR!, { recursive: true });
    const child = Bun.spawn([process.execPath, "test", ...args], {
      env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    let exitCode: number;
    try { exitCode = await child.exited; }
    finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
    const entries = homeEntries(home);
    if (entries.length > 0) {
      console.error("[test-home] unexpected writes:");
      for (const entry of entries) console.error(entry);
      return 1;
    }
    console.error("[test-home] residual paths: []");
    return exitCode;
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
