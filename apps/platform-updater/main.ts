import type { MultiremiPlatformOperation, MultiremiPlatformRelease } from "@multiremi/contracts";
import { PlatformUpdaterClient } from "@remi-platform/updater/client.js";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import { fetchReleaseFeed } from "@remi-platform/updater/release-feed.js";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import { BunCommandRunner, type PlatformDeploymentDriver } from "@remi-platform/updater/types.js";

const apiUrl = requiredEnv("MULTIREMI_API_URL");
const apiToken = requiredEnv("MULTIREMI_TOKEN");
const updaterToken = requiredEnv("MULTIREMI_PLATFORM_UPDATER_TOKEN");
const releaseFeedUrl = optionalEnv("MULTIREMI_PLATFORM_RELEASE_FEED_URL");
const pollMs = positiveNumber(process.env.MULTIREMI_PLATFORM_UPDATER_POLL_MS, 5_000);
const runner = new BunCommandRunner();
const client = new PlatformUpdaterClient(apiUrl, apiToken, updaterToken);
const driver = createDriver();
let latestRelease: MultiremiPlatformRelease | null = null;
let lastFeedCheck = 0;

console.info(`Multiremi platform updater started with ${driver.kind} driver`);

while (true) {
  try {
    if (Date.now() - lastFeedCheck > 300_000 || lastFeedCheck === 0) {
      latestRelease = await fetchReleaseFeed(releaseFeedUrl);
      lastFeedCheck = Date.now();
    }
    await client.heartbeat(await driver.inspect(), latestRelease);
    const operation = await client.claim();
    if (operation) await execute(operation);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  await Bun.sleep(pollMs);
}

async function execute(operation: MultiremiPlatformOperation): Promise<void> {
  try {
    if (operation.kind === "check_updates") {
      latestRelease = await fetchReleaseFeed(releaseFeedUrl);
      lastFeedCheck = Date.now();
    }
    const resolved = await resolveManifest(operation);
    const resultRelease = await driver.execute(resolved, (input) => client.report(operation.id, input));
    await client.report(operation.id, {
      status: operation.kind === "rollback" ? "rolled_back" : "succeeded",
      resultRelease,
      progress: { message: operation.kind === "check_updates" ? "Release information refreshed" : "Operation completed" },
    });
    await client.heartbeat(await driver.inspect(), latestRelease);
  } catch (error) {
    await client.report(operation.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveManifest(operation: MultiremiPlatformOperation): Promise<MultiremiPlatformOperation> {
  if (operation.kind !== "update" || Object.keys(operation.targetManifest).length > 0) return operation;
  const manifestUrl = operation.targetRef ?? latestRelease?.manifestUrl;
  if (!manifestUrl) throw new Error("update operation has no deployment manifest URL");
  assertHttpsUrl(manifestUrl, "deployment manifest URL");
  const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`deployment manifest returned ${response.status}`);
  const manifest = await response.json();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("deployment manifest is invalid");
  return { ...operation, targetManifest: manifest as Record<string, unknown> };
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function createDriver(): PlatformDeploymentDriver {
  const kind = process.env.MULTIREMI_PLATFORM_DRIVER ?? "systemd_release";
  if (kind === "docker_compose") {
    return new DockerComposeDriver({
      composeFile: requiredEnv("MULTIREMI_PLATFORM_COMPOSE_FILE"),
      envFile: requiredEnv("MULTIREMI_PLATFORM_COMPOSE_ENV_FILE"),
      stateDir: process.env.MULTIREMI_PLATFORM_STATE_DIR ?? "/var/lib/multiremi-platform-updater",
      apiHealthUrl: process.env.MULTIREMI_PLATFORM_API_HEALTH_URL ?? `${apiUrl.replace(/\/$/, "")}/readyz`,
      webHealthUrl: process.env.MULTIREMI_PLATFORM_WEB_HEALTH_URL ?? "http://127.0.0.1:3000/login",
      postgresContainer: optionalEnv("MULTIREMI_PLATFORM_POSTGRES_CONTAINER"),
      openvikingContainer: optionalEnv("MULTIREMI_PLATFORM_OPENVIKING_CONTAINER"),
    }, runner);
  }
  if (kind !== "systemd_release") throw new Error(`Unsupported platform driver: ${kind}`);
  return new SystemdReleaseDriver({
    root: process.env.MULTIREMI_PLATFORM_ROOT ?? "/opt/multiremi-platform",
    apiService: process.env.MULTIREMI_PLATFORM_API_SERVICE ?? "remi-platform-api.service",
    webService: process.env.MULTIREMI_PLATFORM_WEB_SERVICE ?? "remi-platform-web.service",
    apiHealthUrl: process.env.MULTIREMI_PLATFORM_API_HEALTH_URL ?? `${apiUrl.replace(/\/$/, "")}/readyz`,
    webHealthUrl: process.env.MULTIREMI_PLATFORM_WEB_HEALTH_URL ?? "http://127.0.0.1:3000/login",
    bunExecutable: process.env.MULTIREMI_PLATFORM_BUN ?? "/usr/local/bin/bun",
  }, runner);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
