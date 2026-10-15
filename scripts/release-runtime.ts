import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import releaseSnapshot from "../packages/acp/src/runtime-versions.json";
import {
  BRIDGE_PACKAGE, RUNTIME_PIN, antigravityPinProblem, compareVersions, isStableVersion, validRuntimeVersions, versionsAtLeast,
  type AntigravityArtifact, type AntigravityPin, type AntigravityPlatformKey, type RuntimeProvider, type RuntimeVersions,
} from "../packages/acp/src/runtime-versions.js";

export const SNAPSHOT_PATH = "packages/acp/src/runtime-versions.json";
export interface RuntimeSnapshot {
  schema: number;
  preparedFor: string | null;
  checkedAt: string | null;
  claude: RuntimeVersions;
  codex: RuntimeVersions;
  /** Google's Antigravity ACP server: pinned by hand with `pin-antigravity`, carried by `prepare`. */
  antigravity: AntigravityPin;
}
const ROOT = resolve(import.meta.dir, "..");

type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;
export async function latestRuntimeVersions(fetcher: RegistryFetch = fetch, floor: RuntimeSnapshot = releaseSnapshot): Promise<Record<RuntimeProvider, RuntimeVersions>> {
  const requests = new Map<string, Promise<string>>();
  const latest = (name: string) => {
    let request = requests.get(name);
    if (!request) {
      request = (async () => {
        const response = await fetcher(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`${name}: registry HTTP ${response.status}`);
        const pkg = await response.json() as { name?: string; version?: string; deprecated?: string };
        if (pkg.name !== name || !isStableVersion(pkg.version) || pkg.deprecated) {
          throw new Error(`${name}: latest is not a supported stable release`);
        }
        return pkg.version;
      })();
      requests.set(name, request);
    }
    return request;
  };
  const entries = await Promise.all((["claude", "codex"] as const).map(async (provider) => {
    const [acp, sdk, executable] = await Promise.all([
      latest(BRIDGE_PACKAGE[provider]), latest(RUNTIME_PIN[provider].package),
      latest(provider === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex"),
    ]);
    const versions = { acp, sdk, executable };
    // A rolled-back dist-tag must not silently downgrade a prepared release.
    if (!versionsAtLeast(versions, floor[provider])) {
      throw new Error(`${provider}: registry latest is older than the release snapshot`);
    }
    return [provider, versions] as const;
  }));
  return Object.fromEntries(entries) as Record<RuntimeProvider, RuntimeVersions>;
}

export function checkReleaseSnapshot(version: string, snapshot: RuntimeSnapshot): void {
  if (!isStableVersion(version) || snapshot.schema !== 1 || snapshot.preparedFor !== version
    || !snapshot.checkedAt || !Number.isFinite(Date.parse(snapshot.checkedAt))
    || !validRuntimeVersions(snapshot.claude) || !validRuntimeVersions(snapshot.codex)) {
    throw new Error("Release dependencies were not prepared for this version. Run bun run release:prepare --version <next> before committing the release.");
  }
  checkAntigravityPin(snapshot.antigravity);
}

/** Structural check of the Antigravity block; it changes only through `pin-antigravity`. */
export function checkAntigravityPin(pin: unknown): void {
  const problem = antigravityPinProblem(pin);
  if (problem) throw new Error(`Invalid Antigravity pin (${problem}). Run bun run release:pin-antigravity --version <server>.`);
}

/** The public ACP registry; it lists only each agent's latest release and no checksums. */
export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_PLATFORMS: Record<string, AntigravityPlatformKey> = {
  "darwin-aarch64": "darwin-arm64", "darwin-x86_64": "darwin-x64", "linux-x86_64": "linux-x64", "linux-aarch64": "linux-arm64",
};

async function archiveDigest(fetcher: RegistryFetch, url: string): Promise<{ sha256: string; bytes: number }> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    hash.update(value);
  }
  if (!bytes) throw new Error(`${url}: empty archive`);
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Pin a new Antigravity ACP server: read the registry entry, download every
 * supported archive (Windows is not supported) to compute its size and sha256,
 * and write only the `antigravity` block. The archives are never stored.
 */
export async function pinAntigravity(root: string, version: string, options: {
  dryRun?: boolean;
  fetch?: RegistryFetch;
  log?: (message: string) => void;
} = {}): Promise<AntigravityPin> {
  if (!isStableVersion(version)) throw new Error("--version requires a stable SemVer, without v");
  const fetcher = options.fetch ?? fetch;
  const snapshotPath = join(root, SNAPSHOT_PATH);
  const original = readFileSync(snapshotPath, "utf8");
  const snapshot = JSON.parse(original) as RuntimeSnapshot;
  if (snapshot.antigravity && isStableVersion(snapshot.antigravity.server) && compareVersions(version, snapshot.antigravity.server) < 0) {
    throw new Error(`Refusing to downgrade Antigravity from ${snapshot.antigravity.server} to ${version}`);
  }
  const response = await fetcher(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`ACP registry: HTTP ${response.status}`);
  const registry = await response.json() as { agents?: Array<Record<string, any>> };
  const agent = registry.agents?.find((entry) => entry?.id === "antigravity-acp");
  if (!agent) throw new Error("ACP registry has no antigravity-acp entry");
  if (agent.version !== version) throw new Error(`ACP registry lists antigravity-acp ${agent.version}, not ${version}`);
  const binaries = agent.distribution?.binary as Record<string, { archive?: unknown; cmd?: unknown; args?: unknown }> | undefined;
  const artifacts: Partial<Record<AntigravityPlatformKey, AntigravityArtifact>> = {};
  for (const [registryKey, platform] of Object.entries(REGISTRY_PLATFORMS)) {
    const binary = binaries?.[registryKey];
    if (!binary || typeof binary.archive !== "string") throw new Error(`ACP registry has no ${registryKey} archive`);
    if (binary.cmd !== "./agy_acp_server.par") throw new Error(`${registryKey}: unexpected command ${String(binary.cmd)}`);
    const args = Array.isArray(binary.args) && binary.args.every((arg) => typeof arg === "string") ? binary.args as string[] : [];
    options.log?.(`Hashing ${binary.archive}`);
    artifacts[platform] = { url: binary.archive, ...await archiveDigest(fetcher, binary.archive), ...(args.length ? { args } : {}) };
  }
  const pin: AntigravityPin = { server: version, terms: typeof agent.license_url === "string" ? agent.license_url : "", artifacts };
  checkAntigravityPin(pin);
  if (options.dryRun) return pin;
  if (readFileSync(snapshotPath, "utf8") !== original) throw new Error("Release files changed during pinning; refusing to overwrite them");
  writeFileSync(snapshotPath, JSON.stringify({ ...snapshot, antigravity: pin }, null, 2) + "\n");
  return pin;
}

/** Verify in a disposable home so release preparation cannot change local daemons. */
export async function verifyReleaseRuntimes(snapshot: RuntimeSnapshot): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "remi-release-runtime-"));
  const env = { ...process.env, REMI_HOME: home, REMI_CLAUDE_AGENT_ACP_EXECUTABLE: join(ROOT, "bin/remi-claude-agent-acp") };
  for (const key of ["REMI_CLAUDE_CODE_EXECUTABLE", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "REMI_CODEX_AGENT_ACP_EXECUTABLE", "REMI_CLAUDE_AGENT_ACP_DIR"]) {
    delete (env as Record<string, string | undefined>)[key];
  }
  try {
    const child = Bun.spawn([process.execPath, join(ROOT, "scripts/verify-runtime-candidate.ts"), JSON.stringify(snapshot)], {
      cwd: ROOT, env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Candidate runtime validation failed (exit ${code}); release files were not changed`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function prepareRelease(root: string, version: string, options: {
  dryRun?: boolean;
  latest?: (floor: RuntimeSnapshot) => Promise<Record<RuntimeProvider, RuntimeVersions>>;
  verify?: (snapshot: RuntimeSnapshot) => Promise<void>;
  now?: () => Date;
} = {}): Promise<RuntimeSnapshot> {
  const packagePath = join(root, "package.json"), snapshotPath = join(root, SNAPSHOT_PATH);
  const originalPackage = readFileSync(packagePath, "utf8"), originalSnapshot = readFileSync(snapshotPath, "utf8");
  const pkg = JSON.parse(originalPackage) as { version: string };
  const floor = JSON.parse(originalSnapshot) as RuntimeSnapshot;
  if (!isStableVersion(version) || compareVersions(version, pkg.version) < 0) {
    throw new Error("Expected a stable version at least as new as package.json");
  }
  const versions = await (options.latest ?? ((current) => latestRuntimeVersions(fetch, current)))(floor);
  const snapshot: RuntimeSnapshot = {
    schema: 1, preparedFor: version, checkedAt: (options.now ?? (() => new Date()))().toISOString(), ...versions,
    // Not an npm package: carried unchanged until someone runs pin-antigravity.
    antigravity: floor.antigravity,
  };
  checkReleaseSnapshot(version, snapshot);
  await (options.verify ?? verifyReleaseRuntimes)(snapshot);
  if (options.dryRun) return snapshot;
  // Do not overwrite edits made while the network/installation checks ran.
  if (readFileSync(packagePath, "utf8") !== originalPackage || readFileSync(snapshotPath, "utf8") !== originalSnapshot) {
    throw new Error("Release files changed during preparation; refusing to overwrite them");
  }
  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
    writeFileSync(packagePath, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
  } catch (error) {
    writeFileSync(snapshotPath, originalSnapshot);
    writeFileSync(packagePath, originalPackage);
    throw error;
  }
  return snapshot;
}

export function checkRelease(root: string, options: { baseRef?: string; tag?: string }): boolean {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(join(root, SNAPSHOT_PATH), "utf8"));
  if (options.tag) {
    if (options.tag !== `v${pkg.version}`) throw new Error("Tag must match package.json");
    checkReleaseSnapshot(pkg.version, snapshot);
    return false;
  }
  // PR and main checks require a fresh snapshot when preparing a new release;
  // ordinary development commits may retain the previous release's snapshot.
  if (!options.baseRef || !/^[a-f0-9]{40}$/.test(options.baseRef) || /^0+$/.test(options.baseRef)) {
    throw new Error("A valid base commit SHA is required for release preparation checks");
  }
  // Every commit keeps a well-formed Antigravity pin, release or not.
  checkAntigravityPin(snapshot.antigravity);
  const base = JSON.parse(execFileSync("git", ["show", `${options.baseRef}:package.json`], { cwd: root, encoding: "utf8" }));
  if (base.version !== pkg.version) {
    if (compareVersions(pkg.version, base.version) <= 0) throw new Error("Release version must increase");
    checkReleaseSnapshot(pkg.version, snapshot);
    return true;
  }
  return false;
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2), allowPositionals: true,
      options: { version: { type: "string" }, "dry-run": { type: "boolean" }, "base-ref": { type: "string" }, tag: { type: "string" } },
    });
    if (positionals.length !== 1) throw new Error("Expected prepare, pin-antigravity or check");
    if (positionals[0] === "prepare") {
      const version = values.version;
      if (!isStableVersion(version)) throw new Error("--version requires a stable SemVer, without v");
      const tag = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/v${version}`], { cwd: ROOT });
      if (tag.status !== 1) throw new Error("Target tag already exists or could not be checked; fetch tags and choose a new version");
      const snapshot = await prepareRelease(ROOT, version, { dryRun: values["dry-run"] });
      console.log(JSON.stringify({ written: !values["dry-run"], snapshot }, null, 2));
    } else if (positionals[0] === "pin-antigravity") {
      const pin = await pinAntigravity(ROOT, values.version ?? "", { dryRun: values["dry-run"], log: (message) => console.error(message) });
      console.log(JSON.stringify({ written: !values["dry-run"], antigravity: pin }, null, 2));
    } else if (positionals[0] === "check") {
      const versionChanged = checkRelease(ROOT, { baseRef: values["base-ref"], tag: values.tag });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version_changed=${versionChanged}\n`);
      console.log("Release dependency preparation check passed");
    } else {
      throw new Error("Expected prepare, pin-antigravity or check");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
