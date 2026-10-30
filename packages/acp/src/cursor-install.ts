import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { acquireInstallLock } from "./runtime-bundle.js";
import { CURSOR_PIN, CURSOR_PLATFORM_KEYS, cursorPinProblem, isCursorVersion, type CursorArtifact, type CursorPin, type CursorPlatformKey } from "./runtime-versions.js";

export const CURSOR_INSTALL_URL = "https://cursor.com/docs/cli/installation";
export const CURSOR_PREPARE_COMMAND = "remi runtime prepare --provider cursor";
export const CURSOR_MANIFEST = "install.json";
const EXECUTABLES = ["cursor-agent", "node"] as const;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface CursorInstallManifest {
  version: string;
  platform: CursorPlatformKey;
  sha256: string;
  bytes: number;
  installedAt: string;
}
export interface CursorLaunch {
  executable: string;
  args: string[];
  dir?: string;
  manifest?: CursorInstallManifest;
}
export interface CursorLocation {
  pin?: CursorPin;
  platform?: CursorPlatformKey | null;
  root?: string;
  env?: NodeJS.ProcessEnv;
}
export interface EnsureCursorOptions extends CursorLocation {
  force?: boolean;
  log?: (message: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  extract?: (archive: string, into: string) => void;
  freeBytes?: (path: string) => number;
  now?: () => Date;
}
export class CursorInstallError extends Error {
  constructor(readonly code: "cursor_unsupported_platform" | "cursor_not_installed" | "cursor_install_failed", message: string) {
    super(`[${code}] ${message}`);
    this.name = "CursorInstallError";
  }
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

export function cursorPlatformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CursorPlatformKey | null {
  const key = `${platform}-${arch}`;
  return (CURSOR_PLATFORM_KEYS as readonly string[]).includes(key) ? key as CursorPlatformKey : null;
}

export function cursorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.REMI_HOME ?? join(homedir(), ".remi"), "acp", "cursor");
}

function located(options: CursorLocation = {}) {
  const pin = options.pin ?? CURSOR_PIN;
  const problem = cursorPinProblem(pin);
  if (problem) throw new CursorInstallError("cursor_install_failed", problem);
  const platform = options.platform === undefined ? cursorPlatformKey() : options.platform;
  if (!platform || !pin.artifacts[platform]) {
    throw new CursorInstallError("cursor_unsupported_platform", `Cursor ${pin.version} has no pinned archive for ${platform ?? `${process.platform}-${process.arch}`}`);
  }
  const root = options.root ?? cursorRoot(options.env);
  return { pin, platform, artifact: pin.artifacts[platform]!, root, dir: join(root, `${pin.version}-${platform}`) };
}

export function cursorInstallDir(options: CursorLocation = {}): string {
  return located(options).dir;
}

function readManifest(dir: string): CursorInstallManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, CURSOR_MANIFEST), "utf8")) as CursorInstallManifest;
    if (!isCursorVersion(raw.version) || !(CURSOR_PLATFORM_KEYS as readonly string[]).includes(raw.platform)
      || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)
      || !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0
      || typeof raw.installedAt !== "string" || !Number.isFinite(Date.parse(raw.installedAt))) return null;
    return raw;
  } catch { return null; }
}

/** An earlier managed install selects Cursor for upgrade preparation; launch still uses the current pin. */
export function anyCursorInstall(root: string = cursorRoot()): boolean {
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      const dir = join(root, entry.name);
      const manifest = readManifest(dir);
      if (!manifest || entry.name !== `${manifest.version}-${manifest.platform}`) return false;
      if (!EXECUTABLES.every((binary) => executableFile(join(dir, binary)))) return false;
      try { return lstatSync(join(dir, "index.js")).isFile(); } catch { return false; }
    });
  } catch { return false; }
}

/** Read-only check of the release pin and extracted entry points. */
export function cursorInstallProblem(options: CursorLocation = {}): string | null {
  let where;
  try { where = located(options); } catch (error) { return (error as Error).message; }
  const manifest = readManifest(where.dir);
  if (!manifest) return `Cursor ${where.pin.version} is not installed (${where.dir}); run ${CURSOR_PREPARE_COMMAND}`;
  if (manifest.version !== where.pin.version || manifest.platform !== where.platform
    || manifest.sha256 !== where.artifact.sha256 || manifest.bytes !== where.artifact.bytes) {
    return `Cursor install at ${where.dir} does not match the release pin; run ${CURSOR_PREPARE_COMMAND}`;
  }
  for (const binary of EXECUTABLES) {
    if (!executableFile(join(where.dir, binary))) return `Cursor install is missing an executable ${binary} (${where.dir})`;
  }
  try { if (lstatSync(join(where.dir, "index.js")).isFile()) return null; } catch {}
  return `Cursor install is missing index.js (${where.dir})`;
}

export function installedCursor(options: CursorLocation = {}): CursorLaunch | null {
  if (cursorInstallProblem(options)) return null;
  const where = located(options);
  return { executable: join(where.dir, "cursor-agent"), args: ["acp"], dir: where.dir, manifest: readManifest(where.dir)! };
}

/** Discover an official CLI to offer Cursor as a runtime; preparation uses the release pin. */
export function installedUserCursorAgentExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const home = homedir();
  const candidates = [...paths.map((dir) => join(dir, "cursor-agent")), join(home, ".local", "bin", "cursor-agent")];
  const named = candidates.find(executableFile);
  if (named) return named;
  const agent = join(home, ".local", "bin", "agent");
  try { if (executableFile(agent) && realpathSync(agent).endsWith("/cursor-agent")) return agent; } catch {}
  return null;
}

/** Resolve an explicit override or the managed release pin, without starting a process. */
export function resolveCursorAgentExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.REMI_CURSOR_AGENT_EXECUTABLE?.trim();
  if (explicit) return executableFile(explicit) ? explicit : null;
  return installedCursor({ env })?.executable ?? null;
}

export function cursorHealthProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.REMI_CURSOR_AGENT_EXECUTABLE?.trim();
  if (explicit) return executableFile(explicit) ? null : `Cursor Agent executable is not available at ${explicit}`;
  return cursorInstallProblem({ env });
}

export function extractCursorArchive(archive: string, into: string): void {
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", into], {
    timeout: 10 * 60_000, stdio: ["ignore", "ignore", "pipe"],
  });
}

async function download(fetcher: NonNullable<EnsureCursorOptions["fetch"]>, artifact: CursorArtifact, target: string): Promise<void> {
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
      if (bytes > artifact.bytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`archive is larger than the pinned ${artifact.bytes} bytes`);
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) offset += writeSync(fd, value, offset, value.byteLength - offset);
    }
  } finally { closeSync(fd); }
  if (bytes !== artifact.bytes) throw new Error(`archive size mismatch: expected ${artifact.bytes} bytes, got ${bytes}`);
  const sha256 = hash.digest("hex");
  if (sha256 !== artifact.sha256) throw new Error(`archive sha256 mismatch: expected ${artifact.sha256}, got ${sha256}`);
}

/** Download and verify the release pin before atomically installing it. No login or installer script runs. */
export async function ensureCursorAgent(options: EnsureCursorOptions = {}): Promise<CursorLaunch> {
  const env = options.env ?? process.env;
  const explicit = env.REMI_CURSOR_AGENT_EXECUTABLE?.trim();
  if (explicit) {
    if (!executableFile(explicit)) throw new CursorInstallError("cursor_not_installed", `Cursor Agent executable is not available at ${explicit}`);
    return { executable: explicit, args: ["acp"] };
  }
  const where = located(options);
  const location = { pin: where.pin, platform: where.platform, root: where.root };
  if (!options.force) {
    const installed = installedCursor(location);
    if (installed) return installed;
  }
  const log = options.log ?? (() => {});
  mkdirSync(where.root, { recursive: true, mode: 0o700 });
  const lock = join(where.root, ".install.lock");
  try { acquireInstallLock(lock); }
  catch { throw new CursorInstallError("cursor_install_failed", `a Cursor installation is already in progress (${lock})`); }
  let stage: string | undefined;
  try {
    if (!options.force) {
      const installed = installedCursor(location);
      if (installed) return installed;
    }
    const free = (options.freeBytes ?? ((path) => {
      const stats = statfsSync(path);
      return Number(stats.bavail) * Number(stats.bsize);
    }))(where.root);
    const required = Math.max(1024 ** 3, where.artifact.bytes * 5);
    if (free < required) throw new Error(`needs ${(required / 1024 ** 3).toFixed(1)} GB free under ${where.root}, found ${(free / 1024 ** 3).toFixed(1)} GB`);
    stage = mkdtempSync(join(where.root, ".stage-"));
    const archive = join(stage, "archive.tar.gz"), extracted = join(stage, "x");
    mkdirSync(extracted);
    log(`Downloading Cursor ${where.pin.version} from ${where.artifact.url} (${(where.artifact.bytes / 1024 ** 2).toFixed(0)} MB)`);
    await download(options.fetch ?? fetch, where.artifact, archive);
    (options.extract ?? extractCursorArchive)(archive, extracted);
    for (const name of [...EXECUTABLES, "index.js"]) {
      let regular = false;
      try { regular = lstatSync(join(extracted, name)).isFile(); } catch {}
      if (!regular) throw new Error(`archive is missing ${name}`);
    }
    for (const binary of EXECUTABLES) chmodSync(join(extracted, binary), 0o755);
    const manifest: CursorInstallManifest = {
      version: where.pin.version, platform: where.platform, sha256: where.artifact.sha256, bytes: where.artifact.bytes,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    writeFileSync(join(extracted, CURSOR_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    let previous: string | null = null;
    if (existsSync(where.dir)) {
      previous = `${where.dir}.previous-${randomUUID()}`;
      renameSync(where.dir, previous);
    }
    try { renameSync(extracted, where.dir); }
    catch (error) {
      if (previous) renameSync(previous, where.dir);
      throw error;
    }
    log(`Installed Cursor ${where.pin.version} at ${where.dir}`);
    return installedCursor(location) ?? (() => { throw new Error("install did not verify"); })();
  } catch (error) {
    throw new CursorInstallError("cursor_install_failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
