/** Release-owned versions: upgrade the bridge and the executable it actually launches together. */
export const BRIDGE_PIN = { claude: "0.66.0", codex: "1.11.0" } as const;
export const RUNTIME_PIN = {
  claude: { package: "@anthropic-ai/claude-agent-sdk", version: "0.3.259", executableVersion: "2.1.259" },
  codex: { package: "@openai/codex", version: "0.153.4", executableVersion: "0.153.4" },
} as const;
export const BRIDGE_PACKAGE = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
} as const;
export type RuntimeProvider = keyof typeof BRIDGE_PIN;
