/** Tested release floor; verified automatic updates may select newer stable versions. */
export const BRIDGE_PIN = { claude: "0.76.0", codex: "1.11.0" } as const;
export const RUNTIME_PIN = {
  claude: { package: "@anthropic-ai/claude-agent-sdk", version: "0.3.270", executableVersion: "2.1.270" },
  codex: { package: "@openai/codex", version: "0.154.0", executableVersion: "0.154.0" },
} as const;
export const BRIDGE_PACKAGE = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
} as const;
export type RuntimeProvider = keyof typeof BRIDGE_PIN;
export interface RuntimeVersions { acp: string; sdk: string; executable: string }
export type RuntimeSelection = Partial<Record<RuntimeProvider, RuntimeVersions>>;

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
