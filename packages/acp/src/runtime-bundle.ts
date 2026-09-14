import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_PACKAGE, RUNTIME_PIN, type RuntimeProvider, type RuntimeVersions } from "./runtime-versions.js";
import { selectedRuntimeVersions } from "./runtime-update-state.js";

export function runtimeBundlePrefix(provider: RuntimeProvider, versions = selectedRuntimeVersions(provider)): string {
  return join(process.env.REMI_HOME ?? join(homedir(), ".remi"), "acp", "bundles",
    `${provider}-${versions.acp}-${versions.sdk}-${versions.executable}`);
}

export function runtimeBundleBridge(provider: RuntimeProvider, prefix = runtimeBundlePrefix(provider)): string {
  return join(prefix, "node_modules", BRIDGE_PACKAGE[provider]);
}

function dependencyRoot(from: string, name: string): string {
  // Inspect the filesystem on every check. require.resolve caches successes
  // and misses, which makes an install/repair in this process appear stale.
  for (let directory = from; ; directory = dirname(directory)) {
    const root = join(directory, "node_modules", name);
    if (existsSync(join(root, "package.json"))) return root;
    if (dirname(directory) === directory) break;
  }
  throw new Error(`Cannot locate ${name} from ${from}`);
}

/** Resolve from the bridge, including nested dependencies; a top-level package alone proves nothing. */
export function runtimePackage(provider: RuntimeProvider, bridge: string): { root: string; version: string; executable: string } {
  const name = RUNTIME_PIN[provider].package;
  const root = dependencyRoot(bridge, name);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.name !== name) throw new Error(`Unexpected runtime package: ${pkg.name}`);
  let executable = join(root, "bin", "codex.js");
  if (provider === "claude") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const musl = process.platform === "linux" && !report?.header?.glibcVersionRuntime;
    const binaryPackage = `${name}-${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
    try {
      executable = join(dependencyRoot(root, binaryPackage), `claude${process.platform === "win32" ? ".exe" : ""}`);
    } catch {
      executable = join(root, "cli.js");
    }
  }
  if (!existsSync(executable)) throw new Error(`${provider} runtime executable missing: ${executable}`);
  return { root, version: String(pkg.version), executable };
}

export function runtimePackageSatisfied(provider: RuntimeProvider, bridge: string, versions = selectedRuntimeVersions(provider)): boolean {
  try { return runtimePackage(provider, bridge).version === versions.sdk; }
  catch { return false; }
}

export function verifyRuntimeExecutable(provider: RuntimeProvider, bridge: string, node: string, versions = selectedRuntimeVersions(provider)): string {
  const runtime = runtimePackage(provider, bridge);
  if (runtime.version !== versions.sdk) {
    throw new Error(`${provider} SDK version mismatch: expected ${versions.sdk}, got ${runtime.version}`);
  }
  const script = /\.[cm]?js$/.test(runtime.executable);
  const output = execFileSync(script ? node : runtime.executable, script ? [runtime.executable, "--version"] : ["--version"], {
    timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const version = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (version !== versions.executable) {
    throw new Error(`${provider} executable version mismatch: expected ${versions.executable}, got ${version ?? output.trim()}`);
  }
  return version;
}

export function runtimeBundleManifest(provider: RuntimeProvider, versions = selectedRuntimeVersions(provider)) {
  const runtime = RUNTIME_PIN[provider];
  return {
    private: true,
    dependencies: { [BRIDGE_PACKAGE[provider]]: versions.acp },
    // Upstream can pin an old SDK or use a floating range. Both must converge
    // on the release's tested executable, including dependencies nested under ACP.
    overrides: { [runtime.package]: versions.sdk },
  };
}

function acquireInstallLock(lock: string): void {
  if (existsSync(lock)) {
    let dead = false;
    try {
      const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid lock owner");
      try { process.kill(pid, 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    } catch {
      // A crash between mkdir and writing the owner must not wedge all future checks.
      dead = Date.now() - statSync(lock).mtimeMs > 10 * 60_000;
    }
    if (dead) rmSync(lock, { recursive: true, force: true });
  }
  mkdirSync(lock);
  try { writeFileSync(join(lock, "pid"), String(process.pid)); }
  catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
}

/** Prepare in a new directory. A failed install never modifies a working bundle. */
export function installRuntimeBundle(
  provider: RuntimeProvider,
  tools: { node: string; npm: string },
  prepareBridge: (bridge: string) => void,
  versions: RuntimeVersions = selectedRuntimeVersions(provider),
): void {
  const destination = runtimeBundlePrefix(provider, versions);
  mkdirSync(dirname(destination), { recursive: true });
  const lock = join(dirname(destination), `.install-${provider}.lock`);
  // A manual prepare and the background checker must never replace one bundle concurrently.
  try { acquireInstallLock(lock); }
  catch { throw new Error(`${provider} runtime installation already in progress (${lock})`); }
  let stage: string | undefined;
  try {
    stage = mkdtempSync(join(dirname(destination), `.prepare-${provider}-`));
    writeFileSync(join(stage, "package.json"), JSON.stringify(runtimeBundleManifest(provider, versions), null, 2) + "\n");
    execFileSync(tools.npm, ["install", "--prefix", stage, "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", "--loglevel=error"], {
      timeout: 180_000, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PATH: `${dirname(tools.node)}:${process.env.PATH ?? ""}` },
    });
    const bridge = runtimeBundleBridge(provider, stage);
    const pkg = JSON.parse(readFileSync(join(bridge, "package.json"), "utf8"));
    if (pkg.version !== versions.acp) throw new Error(`${provider} ACP version mismatch: ${pkg.version}`);
    prepareBridge(bridge);
    verifyRuntimeExecutable(provider, bridge, tools.node, versions);
    // Preserve any previous copy for running processes and manual recovery.
    let previous: string | null = null;
    if (existsSync(destination)) {
      previous = `${destination}.previous-${Date.now()}-${process.pid}`;
      renameSync(destination, previous);
    }
    try { renameSync(stage, destination); }
    catch (error) {
      if (previous) renameSync(previous, destination);
      throw error;
    }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
