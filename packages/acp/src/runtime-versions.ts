import snapshot from "./runtime-versions.json";

/** Immutable for each release; refreshed and verified by release:prepare before tagging. */
export const BRIDGE_PIN = { claude: snapshot.claude.acp, codex: snapshot.codex.acp } as const;
export const RUNTIME_PIN = {
  claude: { package: "@anthropic-ai/claude-agent-sdk", version: snapshot.claude.sdk, executableVersion: snapshot.claude.executable },
  codex: { package: "@openai/codex", version: snapshot.codex.sdk, executableVersion: snapshot.codex.executable },
} as const;
export const BRIDGE_PACKAGE = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
} as const;
/** Providers whose runtime is an npm bundle. Antigravity is a per-machine download, pinned separately. */
export type RuntimeProvider = keyof typeof BRIDGE_PIN;
export interface RuntimeVersions { acp: string; sdk: string; executable: string }

/**
 * Platforms with a pinned Antigravity ACP server archive. The registry also
 * lists Windows builds; Remi does not support them (PR 4 decision).
 */
export const ANTIGRAVITY_PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type AntigravityPlatformKey = typeof ANTIGRAVITY_PLATFORM_KEYS[number];

export interface AntigravityArtifact {
  /** Google's own download URL; Remi never mirrors or bundles the archive. */
  url: string;
  sha256: string;
  bytes: number;
  /** Arguments after `agy_acp_server.par` (the registry's Linux `--uid=`). */
  args?: string[];
}

export interface AntigravityPin {
  /** `agentInfo.version` the server reports from `initialize`. */
  server: string;
  /** Terms the operator accepts before the first install. */
  terms: string;
  artifacts: Partial<Record<AntigravityPlatformKey, AntigravityArtifact>>;
}

/** The Google Antigravity ACP server this release was tested with (`release:pin-antigravity`). */
export const ANTIGRAVITY_PIN: AntigravityPin = snapshot.antigravity as AntigravityPin;

/** Why `value` is not a valid Antigravity pin, or null when it is. */
export function antigravityPinProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "antigravity pin is missing";
  const pin = value as Record<string, unknown>;
  if (!isStableVersion(pin.server)) return "antigravity.server must be a stable version";
  if (!httpsUrl(pin.terms)) return "antigravity.terms must be an https URL";
  const artifacts = pin.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return "antigravity.artifacts is missing";
  const entries = Object.entries(artifacts as Record<string, unknown>);
  if (!entries.length) return "antigravity.artifacts is empty";
  for (const [platform, raw] of entries) {
    if (!(ANTIGRAVITY_PLATFORM_KEYS as readonly string[]).includes(platform)) return `antigravity: unknown platform ${platform}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `antigravity.${platform} must be an object`;
    const artifact = raw as Record<string, unknown>;
    const url = httpsUrl(artifact.url);
    if (!url || url.hostname !== "dl.google.com" || url.search || url.hash) {
      return `antigravity.${platform}.url must be a plain https://dl.google.com URL`;
    }
    if (!url.pathname.endsWith(".zip") || !url.pathname.includes(`-${pin.server}-`)) {
      return `antigravity.${platform}.url must name the ${pin.server} zip archive`;
    }
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return `antigravity.${platform}.sha256 must be 64 lowercase hex characters`;
    if (!Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) <= 0) return `antigravity.${platform}.bytes must be a positive integer`;
    if (artifact.args !== undefined && (!Array.isArray(artifact.args) || !artifact.args.every((arg) => typeof arg === "string"))) {
      return `antigravity.${platform}.args must be a string array`;
    }
  }
  return null;
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function releaseRuntimeVersions(provider: RuntimeProvider): RuntimeVersions {
  return { acp: BRIDGE_PIN[provider], sdk: RUNTIME_PIN[provider].version, executable: RUNTIME_PIN[provider].executableVersion };
}

export function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function compareVersions(left: string, right: string): number {
  if (!isStableVersion(left) || !isStableVersion(right)) throw new Error("Expected stable semantic versions");
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

export function validRuntimeVersions(value: unknown): value is RuntimeVersions {
  if (!value || typeof value !== "object") return false;
  const v = value as RuntimeVersions;
  return isStableVersion(v.acp) && isStableVersion(v.sdk) && isStableVersion(v.executable);
}

export function versionsAtLeast(value: RuntimeVersions, floor: RuntimeVersions): boolean {
  return (["acp", "sdk", "executable"] as const).every((key) => compareVersions(value[key], floor[key]) >= 0);
}
