import { createHash } from "node:crypto";
import { mkdir, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import { DrainAbortedError, type PlatformDrainGate } from "./drain.js";
import type { CommandRunner, PlatformDeploymentDriver, PlatformInspection } from "./types.js";

interface SystemdReleaseConfig {
  root: string;
  apiService: string;
  webService: string;
  apiHealthUrl: string;
  webHealthUrl: string;
  bunExecutable: string;
}

interface SystemdManifest {
  version: string;
  ref: string;
  releaseUrl?: string | null;
  sourceUrl: string;
  sourceSha256: string;
}

export class SystemdReleaseDriver implements PlatformDeploymentDriver {
  readonly kind = "systemd_release" as const;

  constructor(private readonly config: SystemdReleaseConfig, private readonly runner: CommandRunner) {}

  async inspect(): Promise<PlatformInspection> {
    const [currentRelease, recentReleases, api, web] = await Promise.all([
      this.readCurrentRelease(),
      this.readRecentReleases(),
      this.inspectService("api", "API", this.config.apiService),
      this.inspectService("web", "Web", this.config.webService),
    ]);
    return {
      driver: this.kind,
      currentRelease,
      recentReleases,
      services: [api, web, unknownDependency("postgres", "PostgreSQL"), unknownDependency("openviking", "OpenViking")],
    };
  }

  async execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === "check_updates") return (await this.inspect()).currentRelease;
    if (operation.kind === "restart") {
      await report({ status: "restarting", progress: { message: "Restarting platform services" } });
      await this.restartAndVerify();
      return (await this.inspect()).currentRelease;
    }
    if (operation.kind === "rollback") return this.rollback(operation, report, drain);
    return this.update(operation, report, drain);
  }

  private async update(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const manifest = parseSystemdManifest(operation.targetManifest);
    const previous = await this.readCurrentRelease();
    const releaseName = safeReleaseName(`${manifest.version}-${manifest.ref.slice(0, 12)}`);
    const releasesDir = join(this.config.root, "releases");
    const target = ensureChild(releasesDir, join(releasesDir, releaseName));
    const archive = ensureChild(this.config.root, join(this.config.root, `.download-${operation.id}.tar.gz`));
    await report({ status: "pulling", previousRelease: previous, progress: { message: `Downloading ${manifest.version}` } });
    try {
      await mkdir(target, { recursive: true });
      const response = await fetch(manifest.sourceUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`release archive returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== manifest.sourceSha256.toLowerCase()) throw new Error("release archive checksum mismatch");
      await writeFile(archive, bytes, { mode: 0o600 });
      await this.mustRun("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
      await this.mustRun(this.config.bunExecutable, ["install", "--frozen-lockfile", "--ignore-scripts", "--registry", "https://registry.npmjs.org"], target);
      await this.mustRun(this.config.bunExecutable, ["run", "--filter", "@multiremi/web", "build"], target, { STANDALONE: "true" });
      const release: MultiremiPlatformRelease = {
        version: manifest.version,
        ref: manifest.ref,
        publishedAt: new Date().toISOString(),
        releaseUrl: manifest.releaseUrl ?? null,
        manifestUrl: operation.targetRef,
        apiImage: null,
        webImage: null,
      };
      await writeFile(join(target, ".platform-release.json"), `${JSON.stringify(release, null, 2)}\n`);
      // The release is fully staged; only the symlink switch + service restart
      // require a drained platform. Timeout/cancel throws with drain released
      // and the current release untouched.
      if (drain) await drain.waitUntilDrained(report);
      await report({ status: "switching", previousRelease: previous, progress: { message: "Activating release" } });
      await this.switchCurrent(target);
      await report({ status: "restarting", previousRelease: previous, progress: { message: "Restarting services" } });
      await this.restartAndVerify();
      return release;
    } catch (error) {
      if (error instanceof DrainAbortedError) throw error;
      if (previous) {
        await report({ status: "rolling_back", previousRelease: previous, error: errorMessage(error) });
        await this.switchCurrent(await this.releasePathFor(previous));
        await this.restartAndVerify();
      }
      throw error;
    } finally {
      await rm(archive, { force: true });
    }
  }

  private async rollback(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const targetRelease = await this.findRelease(operation.targetRef ?? operation.targetVersion ?? "");
    if (!targetRelease) throw new Error("rollback release not found");
    const previous = await this.readCurrentRelease();
    if (drain) await drain.waitUntilDrained(report);
    await report({ status: "rolling_back", previousRelease: previous, progress: { message: `Switching to ${targetRelease.version}` } });
    await this.switchCurrent(await this.releasePathFor(targetRelease));
    await report({ status: "restarting", previousRelease: previous });
    await this.restartAndVerify();
    return targetRelease;
  }

  private async restartAndVerify(): Promise<void> {
    await this.mustRun("systemctl", ["restart", this.config.apiService, this.config.webService]);
    await Promise.all([verifyUrl(this.config.apiHealthUrl), verifyUrl(this.config.webHealthUrl)]);
  }

  private async switchCurrent(target: string): Promise<void> {
    const current = join(this.config.root, "current");
    const next = join(this.config.root, `.current-${process.pid}`);
    await rm(next, { force: true });
    await symlink(target, next);
    await rename(next, current);
  }

  private async readCurrentRelease(): Promise<MultiremiPlatformRelease | null> {
    try {
      const target = await readlink(join(this.config.root, "current"));
      return this.readRelease(resolve(this.config.root, target));
    } catch {
      return null;
    }
  }

  private async readRecentReleases(): Promise<MultiremiPlatformRelease[]> {
    try {
      const names = (await readdir(join(this.config.root, "releases"))).sort().reverse().slice(0, 10);
      const releases = await Promise.all(names.map((name) => this.readRelease(join(this.config.root, "releases", name))));
      return releases.filter((release): release is MultiremiPlatformRelease => release !== null);
    } catch {
      return [];
    }
  }

  private async readRelease(path: string): Promise<MultiremiPlatformRelease | null> {
    try {
      return JSON.parse(await readFile(join(path, ".platform-release.json"), "utf8")) as MultiremiPlatformRelease;
    } catch {
      return { version: basename(path), ref: basename(path), publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: null, webImage: null };
    }
  }

  private async findRelease(ref: string): Promise<MultiremiPlatformRelease | null> {
    return (await this.readRecentReleases()).find((release) => release.ref === ref || release.version === ref) ?? null;
  }

  private async releasePathFor(release: MultiremiPlatformRelease): Promise<string> {
    const entries = await readdir(join(this.config.root, "releases"));
    const name = entries.find((entry) => entry === release.ref || entry === release.version || entry.startsWith(`${release.version}-`));
    if (!name) throw new Error(`release directory for ${release.version} not found`);
    return ensureChild(join(this.config.root, "releases"), join(this.config.root, "releases", name));
  }

  private async inspectService(id: "api" | "web", name: string, unit: string): Promise<MultiremiPlatformService> {
    const result = await this.runner.run("systemctl", ["is-active", unit]);
    return { id, name, status: result.exitCode === 0 ? "ready" : "stopped", detail: result.stdout.trim() || result.stderr.trim() || null, version: null, checkedAt: new Date().toISOString() };
  }

  private async mustRun(command: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
    const result = await this.runner.run(command, args, { cwd, env });
    if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function parseSystemdManifest(value: Record<string, unknown>): SystemdManifest {
  for (const key of ["version", "ref", "sourceUrl", "sourceSha256"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`manifest ${key} is required`);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(String(value.version))) throw new Error("manifest version must be SemVer");
  if (!/^[a-f0-9]{64}$/i.test(String(value.sourceSha256))) throw new Error("manifest sourceSha256 is invalid");
  assertHttpsUrl(String(value.sourceUrl), "manifest sourceUrl");
  return value as unknown as SystemdManifest;
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function safeReleaseName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("release name is invalid");
  return value;
}

function ensureChild(parent: string, child: string): string {
  const base = `${resolve(parent)}/`;
  const candidate = resolve(child);
  if (!`${candidate}/`.startsWith(base)) throw new Error("release path escapes platform root");
  return candidate;
}

async function verifyUrl(url: string): Promise<void> {
  let lastError = "health check failed";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      lastError = `${url} returned ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await Bun.sleep(2_500);
  }
  throw new Error(lastError);
}

function unknownDependency(id: "postgres" | "openviking", name: string): MultiremiPlatformService {
  return { id, name, status: "unknown", detail: "Not managed by the systemd release driver", version: null, checkedAt: new Date().toISOString() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
