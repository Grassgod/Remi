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
export type RuntimeProvider = keyof typeof BRIDGE_PIN;
export interface RuntimeVersions { acp: string; sdk: string; executable: string }

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
