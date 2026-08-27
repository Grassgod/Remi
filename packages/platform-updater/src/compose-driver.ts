import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import { DrainAbortedError, type PlatformDrainGate } from "./drain.js";
import type { CommandRunner, PlatformDeploymentDriver, PlatformInspection } from "./types.js";

interface ComposeConfig {
  composeFile: string;
  envFile: string;
  stateDir: string;
  apiHealthUrl: string;
  webHealthUrl: string;
  postgresContainer?: string | null;
  openvikingContainer?: string | null;
}

/** Services this stack owns outright and switches as one batch. */
const CORE_SERVICES = ["api", "web", "ssh-mesh-control-plane"] as const;
/**
 * The Feishu ingestion sidecar shares the API container's network namespace, so
 * it only exists when the operator enabled its Compose profile, and it must be
 * detached before the API container is replaced and reattached afterwards.
 */
const SIDECAR_SERVICE = "feishu-sidecar";

interface ComposeManifest {
  version: string;
  ref: string;
  releaseUrl?: string | null;
  manifestUrl?: string | null;
  apiImage: string;
  webImage: string;
}

export class DockerComposeDriver implements PlatformDeploymentDriver {
  readonly kind = "docker_compose" as const;

  constructor(private readonly config: ComposeConfig, private readonly runner: CommandRunner) {}

  async inspect(): Promise<PlatformInspection> {
    const [currentRelease, recentReleases, services] = await Promise.all([
      this.readCurrentRelease(), this.readRecentReleases(), this.inspectServices(),
    ]);
    return { driver: this.kind, currentRelease, recentReleases, services };
  }

  async execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === "check_updates") return (await this.inspect()).currentRelease;
    if (operation.kind === "restart") {
      await report({ status: "restarting", progress: { message: "Restarting platform services" } });
      await this.mustCompose(["restart", ...CORE_SERVICES]);
      await this.verify();
      // A restart keeps the API container, so the sidecar keeps its namespace.
      // It is restarted with the batch, but never at the platform's expense.
      await this.restartSidecar();
      return (await this.inspect()).currentRelease;
    }
    if (operation.kind === "rollback") {
      const release = (await this.readRecentReleases()).find((item) => item.ref === operation.targetRef || item.version === operation.targetVersion);
      if (!release?.apiImage || !release.webImage) throw new Error("rollback release not found");
      return this.activate(release as ComposeManifest, operation, report, true, drain);
    }
    return this.activate(parseComposeManifest(operation.targetManifest), operation, report, false, drain);
  }

  private async activate(
    manifest: ComposeManifest,
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    rollback: boolean,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const previous = await this.readCurrentRelease();
    const originalEnv = await readFile(this.config.envFile, "utf8").catch(() => "");
    await report({ status: rollback ? "rolling_back" : "pulling", previousRelease: previous, progress: { message: rollback ? `Restoring ${manifest.version}` : `Pulling ${manifest.version}` } });
    try {
      await this.writeImageEnv(originalEnv, manifest.apiImage, manifest.webImage);
      await this.mustCompose(["pull", "api", "web"]);
      // Images are staged; only the container switch needs a drained platform.
      // waitUntilDrained throws (with the drain already released) on timeout or
      // operator cancel, so the switch below never runs in those cases.
      if (drain) await drain.waitUntilDrained(report);
      await report({ status: "switching", previousRelease: previous, progress: { message: "Applying image digests" } });
      // Docker refuses to replace a container another container borrows its
      // network namespace from, so the sidecar goes first and comes back after.
      await this.detachSidecar();
      await this.mustCompose(["up", "-d", "--no-deps", ...CORE_SERVICES]);
      // Do not call the control API between switching containers and verifying
      // them. A broken API image must not be able to block the local rollback.
      await this.verify();
      await this.attachSidecar();
      const release = toRelease(manifest);
      await this.writeRelease(release);
      return release;
    } catch (error) {
      if (error instanceof DrainAbortedError) {
        // The switch never ran: containers still run the previous images. Only
        // the staged env file needs restoring — recreating containers here
        // would cause the very restart the drain refused to perform.
        await this.restoreEnvFile(originalEnv);
        throw error;
      }
      if (previous?.apiImage && previous.webImage) {
        // Restore the host first. Reporting through the newly switched API can
        // fail for the same reason that triggered this rollback.
        await this.writeImageEnv(originalEnv, previous.apiImage, previous.webImage);
        await this.detachSidecar();
        await this.mustCompose(["up", "-d", "--no-deps", ...CORE_SERVICES]);
        await this.verify();
        // The restored API container has a new namespace too.
        await this.attachSidecar();
        await report({ status: "rolling_back", previousRelease: previous, error: errorMessage(error) });
      }
      throw error;
    }
  }

  /**
   * `feishu-sidecar` lives behind a Compose profile: an installation that never
   * enabled ingestion has no such service, and naming it would make every
   * Compose command fail. `config --services` resolves the profile from the
   * same env file the other commands use.
   */
  private async hasSidecar(): Promise<boolean> {
    const result = await this.compose(["config", "--services"]);
    if (result.exitCode !== 0) return false;
    return result.stdout.split("\n").some((line) => line.trim() === SIDECAR_SERVICE);
  }

  /** Remove the sidecar so the API container it borrows a namespace from can be replaced. */
  private async detachSidecar(): Promise<void> {
    if (!(await this.hasSidecar())) return;
    // Best effort: an absent or already-stopped sidecar must not block a
    // platform switch, and `up` recreates it either way.
    await this.compose(["rm", "--stop", "--force", SIDECAR_SERVICE]);
  }

  /**
   * Reattach the sidecar to the new API namespace. A sidecar that refuses to
   * start is a degraded ingestion path, not a failed platform release: the
   * control panel reports the endpoint as Unreachable and the API stays up.
   */
  private async attachSidecar(): Promise<void> {
    if (!(await this.hasSidecar())) return;
    await this.compose(["up", "-d", "--no-deps", "--force-recreate", SIDECAR_SERVICE]);
  }

  private async restartSidecar(): Promise<void> {
    if (!(await this.hasSidecar())) return;
    await this.compose(["restart", SIDECAR_SERVICE]);
  }

  private async restoreEnvFile(originalEnv: string): Promise<void> {
    const temp = `${this.config.envFile}.tmp-${process.pid}`;
    await writeFile(temp, originalEnv, { mode: 0o600 });
    await rename(temp, this.config.envFile);
  }

  private async writeImageEnv(source: string, apiImage: string, webImage: string): Promise<void> {
    validateImage(apiImage);
    validateImage(webImage);
    const values = new Map<string, string>();
    const passthrough: string[] = [];
    for (const line of source.split("\n")) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match) values.set(match[1]!, match[2]!);
      else if (line) passthrough.push(line);
    }
    values.set("REMI_API_IMAGE", apiImage);
    values.set("REMI_WEB_IMAGE", webImage);
    const next = [...passthrough, ...[...values.entries()].map(([key, value]) => `${key}=${value}`), ""].join("\n");
    const temp = `${this.config.envFile}.tmp-${process.pid}`;
    await writeFile(temp, next, { mode: 0o600 });
    await rename(temp, this.config.envFile);
  }

  private async writeRelease(release: MultiremiPlatformRelease): Promise<void> {
    const releases = join(this.config.stateDir, "releases");
    await mkdir(releases, { recursive: true });
    await writeFile(join(this.config.stateDir, "current-release.json"), `${JSON.stringify(release, null, 2)}\n`);
    await writeFile(join(releases, `${safeFile(release.version)}.json`), `${JSON.stringify(release, null, 2)}\n`);
  }

  private async readCurrentRelease(): Promise<MultiremiPlatformRelease | null> {
    return readRelease(join(this.config.stateDir, "current-release.json"));
  }

  private async readRecentReleases(): Promise<MultiremiPlatformRelease[]> {
    const result = await this.runner.run("find", [join(this.config.stateDir, "releases"), "-maxdepth", "1", "-type", "f", "-name", "*.json", "-printf", "%T@ %p\\n"]);
    if (result.exitCode !== 0) return [];
    const paths = result.stdout.trim().split("\n").filter(Boolean).sort().reverse().slice(0, 10).map((line) => line.replace(/^\S+\s+/, ""));
    const releases = await Promise.all(paths.map(readRelease));
    return releases.filter((release): release is MultiremiPlatformRelease => release !== null);
  }

  private async inspectServices(): Promise<MultiremiPlatformService[]> {
    const [result, sidecar] = await Promise.all([this.compose(["ps", "--format", "json"]), this.hasSidecar()]);
    const rows = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
    // The sidecar is only listed where it is actually deployed; an installation
    // without the profile should not see a permanently stopped service.
    const ids = [
      ...CORE_SERVICES,
      ...(sidecar ? [SIDECAR_SERVICE] as const : []),
      "postgres", "openviking",
    ] as const satisfies readonly MultiremiPlatformService["id"][];
    return Promise.all(ids.map(async (id) => {
      const row = rows.find((item) => item.Service === id);
      if (!row && (id === "postgres" || id === "openviking")) {
        return this.inspectExternalDependency(id);
      }
      const state = String(row?.State ?? "unknown");
      return { id, name: serviceName(id), status: state === "running" ? "ready" : state === "unknown" ? "unknown" : "stopped", detail: row ? String(row.Status ?? state) : null, version: row ? String(row.Image ?? "") || null : null, checkedAt: new Date().toISOString() };
    }));
  }

  private async inspectExternalDependency(id: "postgres" | "openviking"): Promise<MultiremiPlatformService> {
    const container = id === "postgres" ? this.config.postgresContainer : this.config.openvikingContainer;
    if (!container) {
      return { id, name: serviceName(id), status: "unknown", detail: "External container is not configured", version: null, checkedAt: new Date().toISOString() };
    }
    const result = await this.runner.run("docker", ["inspect", "--format", "{{json .State}}|{{.Config.Image}}", container]);
    if (result.exitCode !== 0) {
      return { id, name: serviceName(id), status: "stopped", detail: result.stderr.trim() || "Container not found", version: null, checkedAt: new Date().toISOString() };
    }
    const [stateJson = "{}", image = ""] = result.stdout.trim().split("|", 2);
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(stateJson) as Record<string, unknown>; } catch {}
    const health = state.Health && typeof state.Health === "object"
      ? String((state.Health as Record<string, unknown>).Status ?? "")
      : "";
    const running = state.Running === true;
    const status = running && (!health || health === "healthy") ? "ready" : running ? "degraded" : "stopped";
    return { id, name: serviceName(id), status, detail: health || String(state.Status ?? "unknown"), version: image || null, checkedAt: new Date().toISOString() };
  }

  private async verify(): Promise<void> {
    await Promise.all([verifyUrl(this.config.apiHealthUrl), verifyUrl(this.config.webHealthUrl)]);
  }

  private async compose(args: string[]) {
    return this.runner.run("docker", ["compose", "--env-file", this.config.envFile, "-f", this.config.composeFile, ...args], { cwd: dirname(this.config.composeFile) });
  }

  private async mustCompose(args: string[]): Promise<void> {
    const result = await this.compose(args);
    if (result.exitCode !== 0) throw new Error(`docker compose ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function parseComposeManifest(value: Record<string, unknown>): ComposeManifest {
  for (const key of ["version", "ref", "apiImage", "webImage"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`manifest ${key} is required`);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(String(value.version))) throw new Error("manifest version must be SemVer");
  if (value.manifestUrl) assertHttpsUrl(String(value.manifestUrl), "manifest manifestUrl");
  return value as unknown as ComposeManifest;
}

function validateImage(value: string): void {
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(value)) throw new Error("image must be an immutable GHCR digest");
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function toRelease(value: ComposeManifest): MultiremiPlatformRelease {
  return { version: value.version, ref: value.ref, publishedAt: new Date().toISOString(), releaseUrl: value.releaseUrl ?? null, manifestUrl: value.manifestUrl ?? null, apiImage: value.apiImage, webImage: value.webImage };
}

async function readRelease(path: string): Promise<MultiremiPlatformRelease | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as MultiremiPlatformRelease; } catch { return null; }
}

async function verifyUrl(url: string): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }); if (response.ok) return; } catch {}
    await Bun.sleep(2_500);
  }
  throw new Error(`${url} did not become healthy`);
}

function safeFile(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("release version is invalid");
  return value;
}

function serviceName(id: MultiremiPlatformService["id"]): string {
  if (id === "api") return "API";
  if (id === "web") return "Web";
  if (id === "ssh-mesh-control-plane") return "SSH Mesh Control Plane";
  if (id === "feishu-sidecar") return "Feishu Ingestion Sidecar";
  return id === "postgres" ? "PostgreSQL" : "OpenViking";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
