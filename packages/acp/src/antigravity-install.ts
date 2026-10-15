/**
 * Per-machine install of Google's Antigravity ACP server (PR 4 §1.2).
 *
 * The server is proprietary and has no redistribution grant, so Remi never
 * bundles, mirrors or commits it: each machine downloads the pinned archive
 * from dl.google.com after the operator accepts the terms, verifies its size
 * and sha256, and only then replaces the working install. Windows is not
 * supported.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, statfsSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireInstallLock } from "./runtime-bundle.js";
import {
  ANTIGRAVITY_PIN, ANTIGRAVITY_PLATFORM_KEYS,
  type AntigravityArtifact, type AntigravityPin, type AntigravityPlatformKey,
} from "./runtime-versions.js";

/** The ACP entry point and the Go harness it launches; both ship in every archive. */
export const ANTIGRAVITY_SERVER_BINARY = "agy_acp_server.par";
export const ANTIGRAVITY_HARNESS_BINARY = "localharness_external";
export const ANTIGRAVITY_BINARIES = [ANTIGRAVITY_SERVER_BINARY, ANTIGRAVITY_HARNESS_BINARY] as const;
export const ANTIGRAVITY_MANIFEST = "install.json";
export const ANTIGRAVITY_TERMS_ENV = "REMI_ACCEPT_ANTIGRAVITY_TERMS";
export const ANTIGRAVITY_PREPARE_COMMAND = "remi runtime prepare --provider antigravity --accept-antigravity-terms";

/**
 * Machine policy files the server's admin tier reads (server 1.4.0).
 * They override our environment and can pin the gateway URL or forbid it.
 */
export const ANTIGRAVITY_ADMIN_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Library/Application Support/Antigravity/admin_settings.json",
  linux: "/etc/antigravity/admin_settings.json",
};

/** Linux archives extract to about 1.1 GB; macOS ones to about 400 MB. */
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

export interface AntigravityInstallManifest {
  version: string;
  platform: AntigravityPlatformKey;
  sha256: string;
  bytes: number;
  installedAt: string;
  termsAcceptedAt: string;
}

export interface InstalledAntigravity {
  dir: string;
  manifest: AntigravityInstallManifest;
  executable: string;
  args: string[];
}

export interface AntigravityLocation {
  pin?: AntigravityPin;
  /** Defaults to this machine's platform; null means unsupported. */
  platform?: AntigravityPlatformKey | null;
  /** Defaults to `${REMI_HOME:-~/.remi}/acp/antigravity`. */
  root?: string;
}

export class AntigravityInstallError extends Error {
  constructor(readonly code: "antigravity_unsupported_platform" | "antigravity_not_installed" | "antigravity_terms_required"
    | "antigravity_install_failed", message: string) {
    super(`[${code}] ${message}`);
    this.name = "AntigravityInstallError";
  }
}

export function antigravityPlatformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AntigravityPlatformKey | null {
  const key = `${platform}-${arch}`;
  return (ANTIGRAVITY_PLATFORM_KEYS as readonly string[]).includes(key) ? key as AntigravityPlatformKey : null;
}

export function antigravityRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.REMI_HOME ?? join(homedir(), ".remi"), "acp", "antigravity");
}

function located(options: AntigravityLocation = {}): { pin: AntigravityPin; platform: AntigravityPlatformKey; artifact: AntigravityArtifact; root: string; dir: string } {
  const pin = options.pin ?? ANTIGRAVITY_PIN;
  const platform = options.platform === undefined ? antigravityPlatformKey() : options.platform;
  if (!platform) {
    throw new AntigravityInstallError("antigravity_unsupported_platform",
      `Antigravity is not supported on ${process.platform}-${process.arch}`);
  }
  const artifact = pin.artifacts[platform];
  if (!artifact) {
    throw new AntigravityInstallError("antigravity_unsupported_platform", `Antigravity ${pin.server} has no pinned ${platform} archive`);
  }
  const root = options.root ?? antigravityRoot();
  return { pin, platform, artifact, root, dir: join(root, `${pin.server}-${platform}`) };
}

export function antigravityInstallDir(options: AntigravityLocation = {}): string {
  return located(options).dir;
}

function readManifest(dir: string): AntigravityInstallManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ANTIGRAVITY_MANIFEST), "utf8")) as Record<string, unknown>;
    if (typeof raw.version !== "string" || typeof raw.platform !== "string" || typeof raw.sha256 !== "string"
      || !Number.isSafeInteger(raw.bytes) || typeof raw.installedAt !== "string" || typeof raw.termsAcceptedAt !== "string"
      || !Number.isFinite(Date.parse(raw.termsAcceptedAt))) return null;
    return raw as unknown as AntigravityInstallManifest;
  } catch {
    return null;
  }
}

function executableFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Why the pinned install is not usable, or null. Spawns nothing. */
export function antigravityInstallProblem(options: AntigravityLocation = {}): string | null {
  let where;
  try { where = located(options); } catch (error) { return (error as Error).message; }
  const manifest = readManifest(where.dir);
  if (!manifest) return `Antigravity ${where.pin.server} is not installed (${where.dir}); run ${ANTIGRAVITY_PREPARE_COMMAND}`;
  if (manifest.version !== where.pin.server || manifest.platform !== where.platform
    || manifest.sha256 !== where.artifact.sha256 || manifest.bytes !== where.artifact.bytes) {
    return `Antigravity install at ${where.dir} does not match the release pin; run ${ANTIGRAVITY_PREPARE_COMMAND}`;
  }
  for (const binary of ANTIGRAVITY_BINARIES) {
    if (!executableFile(join(where.dir, binary))) return `Antigravity install is missing an executable ${binary} (${where.dir})`;
  }
  return null;
}

/** The machine policy file that would override Remi's gateway routing, if present. */
export function antigravityAdminPolicyFile(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | null {
  const path = ANTIGRAVITY_ADMIN_SETTINGS[platform];
  return path && exists(path) ? path : null;
}

/** The fast daemon-start health check (§1.4): manifest, executables, no machine policy. */
export function antigravityHealthProblem(options: AntigravityLocation & { adminPolicy?: () => string | null } = {}): string | null {
  const install = antigravityInstallProblem(options);
  if (install) return install;
  const policy = (options.adminPolicy ?? (() => antigravityAdminPolicyFile()))();
  return policy ? `machine policy overrides gateway routing (${policy}); Remi cannot route Antigravity through its gateway` : null;
}

/** The pinned install when it matches the release pin, else null. Spawns nothing. */
export function installedAntigravity(options: AntigravityLocation = {}): InstalledAntigravity | null {
  if (antigravityInstallProblem(options)) return null;
  const where = located(options);
  return {
    dir: where.dir,
    manifest: readManifest(where.dir)!,
    executable: join(where.dir, ANTIGRAVITY_SERVER_BINARY),
    args: [...(where.artifact.args ?? [])],
  };
}

/** Launch command of the pinned server; throws with instructions when it is not installed. */
export function resolveAntigravityServer(options: AntigravityLocation = {}): { executable: string; args: string[] } {
  const installed = installedAntigravity(options);
  if (!installed) {
    throw new AntigravityInstallError("antigravity_not_installed", antigravityInstallProblem(options) ?? "Antigravity is not installed");
  }
  return { executable: installed.executable, args: installed.args };
}

interface InstallEntry { name: string; dir: string; manifest: AntigravityInstallManifest }

function installEntries(root: string): InstallEntry[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    if (name.startsWith(".stage-") || name.endsWith(".lock")) return [];
    const dir = join(root, name);
    const manifest = readManifest(dir);
    return manifest ? [{ name, dir, manifest }] : [];
  });
}

/** Any earlier install (any version) proves the operator already accepted the terms. */
export function antigravityConsentOnRecord(root: string = antigravityRoot()): string | null {
  const accepted = installEntries(root).map((entry) => entry.manifest.termsAcceptedAt).sort();
  return accepted[0] ?? null;
}

/** True when some Antigravity install (any version) exists, e.g. to pre-fetch a pin bump. */
export function anyAntigravityInstall(root: string = antigravityRoot()): boolean {
  return installEntries(root).length > 0;
}

export function antigravityTermsAccepted(acceptTerms: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return acceptTerms === true || /^(1|true|yes)$/i.test(env[ANTIGRAVITY_TERMS_ENV]?.trim() ?? "");
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface EnsureAntigravityOptions extends AntigravityLocation {
  /** `--accept-antigravity-terms`; `REMI_ACCEPT_ANTIGRAVITY_TERMS=1` also counts. */
  acceptTerms?: boolean;
  /** Reinstall even when the pinned install is already valid (the remote "update ACP bridge"). */
  force?: boolean;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  /** Extract `archive` into the empty directory `into`. */
  extract?: (archive: string, into: string) => void;
  freeBytes?: (path: string) => number;
  now?: () => Date;
}

function defaultFreeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** `ditto` on macOS, `unzip` (or `bsdtar`) on Linux. */
export function extractAntigravityArchive(archive: string, into: string): void {
  const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"], timeout: EXTRACT_TIMEOUT_MS });
  if (process.platform === "darwin") {
    run("ditto", ["-x", "-k", archive, into]);
    return;
  }
  try {
    run("unzip", ["-q", archive, "-d", into]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    run("bsdtar", ["-x", "-f", archive, "-C", into]);
  }
}

async function download(fetcher: Fetcher, artifact: AntigravityArtifact, target: string): Promise<void> {
  const response = await fetcher(artifact.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${artifact.url}`);
  const hash = createHash("sha256");
  const fd = openSync(target, "w", 0o600);
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // Never let a wrong or hostile response fill the disk.
      if (bytes > artifact.bytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`archive is larger than the pinned ${artifact.bytes} bytes`);
      }
      hash.update(value);
      writeSync(fd, value);
    }
  } finally {
    closeSync(fd);
  }
  if (bytes !== artifact.bytes) throw new Error(`archive size mismatch: expected ${artifact.bytes} bytes, got ${bytes}`);
  const sha256 = hash.digest("hex");
  if (sha256 !== artifact.sha256) throw new Error(`archive sha256 mismatch: expected ${artifact.sha256}, got ${sha256}`);
}

/**
 * Keep the new install and one previous copy: the most recently installed of
 * the other versions and `.previous-*` copies (after a pin bump that is the
 * old version, which a daemon that has not restarted yet may still spawn).
 * Delete everything older and any stage a crashed install left. Runs under the lock.
 */
function prune(root: string, keep: string): void {
  for (const name of readdirSync(root)) {
    if (name.startsWith(".stage-")) rmSync(join(root, name), { recursive: true, force: true });
  }
  const others = installEntries(root).filter((entry) => entry.dir !== keep)
    .sort((a, b) => b.manifest.installedAt.localeCompare(a.manifest.installedAt));
  for (const entry of others.slice(1)) rmSync(entry.dir, { recursive: true, force: true });
}

/**
 * Install the pinned server when it is missing or invalid (lock, stage, verify,
 * atomic rename). Any failure leaves the working install untouched.
 */
export async function ensureAntigravityServer(options: EnsureAntigravityOptions = {}): Promise<InstalledAntigravity> {
  const where = located(options);
  const location = { pin: where.pin, platform: where.platform, root: where.root };
  const log = options.log ?? (() => {});
  if (!options.force) {
    const installed = installedAntigravity(location);
    if (installed) return installed;
  }
  const recorded = antigravityConsentOnRecord(where.root);
  if (!antigravityTermsAccepted(options.acceptTerms, options.env) && !recorded) {
    throw new AntigravityInstallError("antigravity_terms_required",
      `Antigravity is distributed by Google under its own terms (${where.pin.terms}). Review them, then run `
      + `${ANTIGRAVITY_PREPARE_COMMAND} (or set ${ANTIGRAVITY_TERMS_ENV}=1) to download it to this machine.`);
  }
  const now = options.now ?? (() => new Date());
  // The first acceptance stays on record across pin bumps.
  const termsAcceptedAt = recorded ?? now().toISOString();
  log(`Antigravity ACP server ${where.pin.server} is provided by Google under ${where.pin.terms}`
    + (recorded ? ` (terms accepted ${recorded})` : " (terms accepted now)"));

  mkdirSync(where.root, { recursive: true, mode: 0o700 });
  const lock = join(where.root, ".install.lock");
  try { acquireInstallLock(lock); }
  catch { throw new AntigravityInstallError("antigravity_install_failed", `an Antigravity installation is already in progress (${lock})`); }
  let stage: string | undefined;
  try {
    if (!options.force) {
      const installed = installedAntigravity(location);
      if (installed) return installed;
    }
    const required = Math.max(MIN_FREE_BYTES, where.artifact.bytes * 5);
    const free = (options.freeBytes ?? defaultFreeBytes)(where.root);
    if (free < required) {
      throw new Error(`needs ${(required / 1024 ** 3).toFixed(1)} GB free under ${where.root}, found ${(free / 1024 ** 3).toFixed(1)} GB`);
    }
    stage = mkdtempSync(join(where.root, ".stage-"));
    const archive = join(stage, "archive.zip");
    const extracted = join(stage, "x");
    mkdirSync(extracted);
    log(`Downloading ${where.artifact.url} (${(where.artifact.bytes / 1024 ** 2).toFixed(0)} MB)`);
    await download(options.fetch ?? fetch, where.artifact, archive);
    (options.extract ?? extractAntigravityArchive)(archive, extracted);
    for (const binary of ANTIGRAVITY_BINARIES) {
      const path = join(extracted, binary);
      let regular = false;
      try { regular = lstatSync(path).isFile(); } catch {}
      if (!regular) throw new Error(`archive is missing ${binary}`);
      chmodSync(path, 0o755);
    }
    const manifest: AntigravityInstallManifest = {
      version: where.pin.server, platform: where.platform, sha256: where.artifact.sha256, bytes: where.artifact.bytes,
      installedAt: now().toISOString(), termsAcceptedAt,
    };
    writeFileSync(join(extracted, ANTIGRAVITY_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    let previous: string | null = null;
    if (existsSync(where.dir)) {
      previous = `${where.dir}.previous-${Date.now()}-${process.pid}`;
      renameSync(where.dir, previous);
    }
    try {
      renameSync(extracted, where.dir);
    } catch (error) {
      if (previous) renameSync(previous, where.dir);
      throw error;
    }
    rmSync(stage, { recursive: true, force: true });
    stage = undefined;
    prune(where.root, where.dir);
    log(`Installed Antigravity ACP server ${where.pin.server} at ${where.dir}`);
    return installedAntigravity(location) ?? (() => { throw new Error("install did not verify"); })();
  } catch (error) {
    if (error instanceof AntigravityInstallError) throw error;
    throw new AntigravityInstallError("antigravity_install_failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
