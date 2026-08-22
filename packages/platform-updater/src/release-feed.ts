import type { MultiremiPlatformRelease } from "@multiremi/contracts";

export async function fetchReleaseFeed(url: string | null): Promise<MultiremiPlatformRelease | null> {
  if (!url) return null;
  assertHttpsUrl(url, "release feed URL");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`release feed returned ${response.status}`);
  const body = await response.json() as { latest?: unknown } | MultiremiPlatformRelease;
  const candidate = "latest" in body ? body.latest : body;
  if (!candidate || typeof candidate !== "object") throw new Error("release feed has no latest release");
  const value = candidate as Record<string, unknown>;
  if (typeof value.version !== "string" || typeof value.ref !== "string") {
    throw new Error("release feed latest release is invalid");
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(value.version)) throw new Error("release feed version must be SemVer");
  if (value.manifestUrl) assertHttpsUrl(String(value.manifestUrl), "release manifest URL");
  return {
    version: value.version,
    ref: value.ref,
    publishedAt: stringOrNull(value.publishedAt),
    releaseUrl: stringOrNull(value.releaseUrl),
    manifestUrl: stringOrNull(value.manifestUrl),
    apiImage: stringOrNull(value.apiImage),
    webImage: stringOrNull(value.webImage),
  };
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
