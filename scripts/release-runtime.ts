import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import releaseSnapshot from "../packages/acp/src/runtime-versions.json";
import { BRIDGE_PACKAGE, RUNTIME_PIN, compareVersions, isStableVersion, validRuntimeVersions, versionsAtLeast, type RuntimeProvider, type RuntimeVersions } from "../packages/acp/src/runtime-versions.js";

export const SNAPSHOT_PATH = "packages/acp/src/runtime-versions.json";
export interface RuntimeSnapshot {
  schema: number;
  preparedFor: string | null;
  checkedAt: string | null;
  claude: RuntimeVersions;
  codex: RuntimeVersions;
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

export function checkRelease(root: string, options: { baseRef?: string; tag?: string }): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(join(root, SNAPSHOT_PATH), "utf8"));
  if (options.tag) {
    if (options.tag !== `v${pkg.version}`) throw new Error("Tag must match package.json");
    checkReleaseSnapshot(pkg.version, snapshot);
    return;
  }
  // PR and main checks require a fresh snapshot when preparing a new release;
  // ordinary development commits may retain the previous release's snapshot.
  if (!options.baseRef || !/^[a-f0-9]{40}$/.test(options.baseRef) || /^0+$/.test(options.baseRef)) {
    throw new Error("A valid base commit SHA is required for release preparation checks");
  }
  const base = JSON.parse(execFileSync("git", ["show", `${options.baseRef}:package.json`], { cwd: root, encoding: "utf8" }));
  if (base.version !== pkg.version) {
    if (compareVersions(pkg.version, base.version) <= 0) throw new Error("Release version must increase");
    checkReleaseSnapshot(pkg.version, snapshot);
  }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2), allowPositionals: true,
      options: { version: { type: "string" }, "dry-run": { type: "boolean" }, "base-ref": { type: "string" }, tag: { type: "string" } },
    });
    if (positionals.length !== 1) throw new Error("Expected prepare or check");
    if (positionals[0] === "prepare") {
      const version = values.version;
      if (!isStableVersion(version)) throw new Error("--version requires a stable SemVer, without v");
      const tag = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/v${version}`], { cwd: ROOT });
      if (tag.status !== 1) throw new Error("Target tag already exists or could not be checked; fetch tags and choose a new version");
      const snapshot = await prepareRelease(ROOT, version, { dryRun: values["dry-run"] });
      console.log(JSON.stringify({ written: !values["dry-run"], snapshot }, null, 2));
    } else if (positionals[0] === "check") {
      checkRelease(ROOT, { baseRef: values["base-ref"], tag: values.tag });
      console.log("Release dependency preparation check passed");
    } else {
      throw new Error("Expected prepare or check");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
