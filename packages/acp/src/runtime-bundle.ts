import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_PACKAGE, BRIDGE_PIN, RUNTIME_PIN, type RuntimeProvider } from "./runtime-versions.js";

export function runtimeBundlePrefix(provider: RuntimeProvider): string {
  return join(process.env.REMI_HOME ?? join(homedir(), ".remi"), "acp", "bundles",
    `${provider}-${BRIDGE_PIN[provider]}-${RUNTIME_PIN[provider].version}`);
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

export function runtimePackageSatisfied(provider: RuntimeProvider, bridge: string): boolean {
  try { return runtimePackage(provider, bridge).version === RUNTIME_PIN[provider].version; }
  catch { return false; }
}

export function verifyRuntimeExecutable(provider: RuntimeProvider, bridge: string, node: string): string {
  const runtime = runtimePackage(provider, bridge);
  if (runtime.version !== RUNTIME_PIN[provider].version) {
    throw new Error(`${provider} SDK version mismatch: expected ${RUNTIME_PIN[provider].version}, got ${runtime.version}`);
  }
  const script = /\.[cm]?js$/.test(runtime.executable);
  const output = execFileSync(script ? node : runtime.executable, script ? [runtime.executable, "--version"] : ["--version"], {
    timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const version = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (version !== RUNTIME_PIN[provider].executableVersion) {
    throw new Error(`${provider} executable version mismatch: expected ${RUNTIME_PIN[provider].executableVersion}, got ${version ?? output.trim()}`);
  }
  return version;
}

export function runtimeBundleManifest(provider: RuntimeProvider) {
  const runtime = RUNTIME_PIN[provider];
  return {
    private: true,
    dependencies: { [BRIDGE_PACKAGE[provider]]: BRIDGE_PIN[provider] },
    // Upstream can pin an old SDK or use a floating range. Both must converge
    // on the release's tested executable, including dependencies nested under ACP.
    overrides: { [runtime.package]: runtime.version },
  };
}

/** Prepare in a new directory. A failed install never modifies a working bundle. */
export function installRuntimeBundle(
  provider: RuntimeProvider,
  tools: { node: string; npm: string },
  prepareBridge: (bridge: string) => void,
): void {
  const destination = runtimeBundlePrefix(provider);
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), `.prepare-${provider}-`));
  try {
    writeFileSync(join(stage, "package.json"), JSON.stringify(runtimeBundleManifest(provider), null, 2) + "\n");
    execFileSync(tools.npm, ["install", "--prefix", stage, "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", "--loglevel=error"], {
      timeout: 180_000, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PATH: `${dirname(tools.node)}:${process.env.PATH ?? ""}` },
    });
    const bridge = runtimeBundleBridge(provider, stage);
    const pkg = JSON.parse(readFileSync(join(bridge, "package.json"), "utf8"));
    if (pkg.version !== BRIDGE_PIN[provider]) throw new Error(`${provider} ACP version mismatch: ${pkg.version}`);
    prepareBridge(bridge);
    verifyRuntimeExecutable(provider, bridge, tools.node);
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
    rmSync(stage, { recursive: true, force: true });
  }
}
