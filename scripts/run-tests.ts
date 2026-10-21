import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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

/**
 * Files a real developer HOME has and code must never touch: OpenSSH config
 * with the SSH Mesh include block, authorized_keys, an existing mesh workspace,
 * a mesh include, and daemon outbox / workspaces state. Every test process
 * starts with them, so a write, rewrite or deletion of existing files is caught
 * as well as a new file. Relative path -> contents (the include is absolute).
 */
export function homeSentinels(home: string): Record<string, string> {
  const meshRoot = join(home, ".multiremi", "ssh");
  const workspace = join(".multiremi", "ssh", "workspaces", "workspace-25bf8e1a2393f110");
  return {
    [join(workspace, "config")]: "Host remi-fixture\n  HostName 10.0.0.1\n",
    [join(workspace, "known_hosts")]: `remi-fixture ssh-ed25519 ${"B".repeat(64)}\n`,
    [join(workspace, "state.json")]: JSON.stringify({ daemonId: "real-home-sentinel", status: "ready" }),
    [join(".multiremi", "ssh", "config.d", "x.conf")]: "# Preserve this existing mesh include\n",
    [join(".ssh", "config")]: [
      "# >>> multiremi ssh mesh >>>",
      `Include "${join(meshRoot, "config.d", "*.conf")}"`,
      "# <<< multiremi ssh mesh <<<",
      "Host personal\n  HostName 10.0.0.2\n",
    ].join("\n"),
    [join(".ssh", "authorized_keys")]: `ssh-ed25519 ${"A".repeat(64)} personal\n`,
    [join(".multiremi", "outbox", "sentinel")]: "preserve outbox\n",
    [join(".remi", "multiremi", "workspaces", "sentinel")]: "preserve workspaces\n",
  };
}

function seedHome(home: string): void {
  for (const [path, contents] of Object.entries(homeSentinels(home))) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), contents, { mode: 0o600 });
  }
}

/** Whole-HOME snapshot: directories, file SHA-256 and symlink targets, never following links. */
export function homeSnapshot(home: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  function visit(directory: string, prefix = ""): void {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = join(prefix, name);
      const path = join(directory, name);
      const stat = lstatSync(path);
      const key = relativePath.split(sep).join("/");
      if (stat.isDirectory()) {
        snapshot.set(key, "directory");
        visit(path, relativePath);
      } else if (stat.isSymbolicLink()) snapshot.set(key, `symlink:${readlinkSync(path)}`);
      else if (stat.isFile()) snapshot.set(key, createHash("sha256").update(readFileSync(path)).digest("hex"));
      else snapshot.set(key, `special:${stat.mode}`);
    }
  }
  visit(home);
  return snapshot;
}

/** Added entries as bare paths; changed and deleted ones are labelled. */
export function homeChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, value] of after) {
    if (!before.has(path)) changes.push(path);
    else if (before.get(path) !== value) changes.push(`${path} (changed)`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`${path} (deleted)`);
  return changes.sort();
}

/** `homeEmpty`: HOME is exactly the seeded sentinels afterwards (name kept for CI reports). */
export interface TestRunMetadata { childExitCode: number; homeEmpty: boolean; observerFailed: boolean; interrupted: boolean }
export async function runTests(args: string[], observe?: (text: string, stream: "stdout" | "stderr") => void, onComplete?: (metadata: TestRunMetadata) => void): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "remi-test-home-"));
  try {
    seedHome(home);
    const seeded = homeSnapshot(home);
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
    const changes = homeChanges(seeded, homeSnapshot(home));
    onComplete?.({ childExitCode: exitCode, homeEmpty: changes.length === 0, observerFailed, interrupted });
    if (changes.length > 0) {
      console.error("[test-home] unexpected writes:");
      for (const entry of changes) console.error(entry);
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
