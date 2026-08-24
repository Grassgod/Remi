import type { Hono } from "hono";
import { multiremiReleaseRepository } from "../helpers/integrations.js";
import type { RouterDeps } from "./deps.js";

const LATEST_VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const LATEST_VERSION_REQUEST_TIMEOUT_MS = 10_000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface LatestVersionCacheEntry {
  expiresAt: number;
  version: string | null;
}

interface LatestVersionResolverOptions {
  fetch?: Fetcher;
  now?: () => number;
  repository?: () => string;
  ttlMs?: number;
}

export function parseLatestReleaseVersion(location: string | null): string | null {
  if (!location) return null;
  try {
    const pathname = new URL(location, "https://github.com").pathname;
    return pathname.match(/\/releases\/tag\/(v[0-9]+(?:\.[0-9]+)+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createLatestVersionResolver(
  options: LatestVersionResolverOptions = {},
): () => Promise<string | null> {
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const repository = options.repository ?? multiremiReleaseRepository;
  const ttlMs = options.ttlMs ?? LATEST_VERSION_CACHE_TTL_MS;
  let cache: LatestVersionCacheEntry | null = null;
  let inFlight: Promise<string | null> | null = null;

  return async () => {
    const currentTime = now();
    if (cache && cache.expiresAt > currentTime) return cache.version;
    if (inFlight) return await inFlight;

    inFlight = (async () => {
      let version: string | null = null;
      try {
        const response = await fetcher(
          `https://github.com/${repository()}/releases/latest`,
          {
            redirect: "manual",
            signal: AbortSignal.timeout(LATEST_VERSION_REQUEST_TIMEOUT_MS),
          },
        );
        if (response.status >= 300 && response.status < 400) {
          version = parseLatestReleaseVersion(response.headers.get("location"));
        }
      } catch {
        // Version discovery is advisory; the runtime page degrades gracefully.
      }
      cache = { version, expiresAt: now() + ttlMs };
      return version;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}

export function registerCliLatestVersionRoutes(app: Hono, _deps: RouterDeps): void {
  const latestVersion = createLatestVersionResolver();
  app.get("/api/cli/latest-version", async (c) => {
    return c.json({ version: await latestVersion() });
  });
}
