import { existsSync } from "node:fs";
import { join } from "node:path";
import { AcpClient } from "./client.js";
import { AcpProvider, resolveAcpExecutableForAgent } from "./provider.js";
import type { RuntimeProvider } from "./runtime-versions.js";

export async function verifyAcpRuntime(provider: RuntimeProvider, bridge: string): Promise<void> {
  const executable = provider === "codex"
    ? process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE || join(bridge, "dist", "index.js")
    : resolveAcpExecutableForAgent(provider, null, "claude-agent-acp");
  const env = provider === "claude" ? { REMI_CLAUDE_AGENT_ACP_DIR: bridge } : undefined;
  if (provider === "codex" && !existsSync(executable)) throw new Error("Codex ACP executable missing");
  const checker = new AcpProvider({ agentType: provider, executable, env });
  try {
    if (!await checker.healthCheck()) throw new Error(`${provider} ACP health check failed after runtime preparation`);
  } finally { await checker.close(); }
  const client = new AcpClient({ agentType: provider, executable, env, inheritProcessGroup: true, log: () => {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => { await client.start(); await client.initialize(); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${provider} ACP initialization timed out`)), 15_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.stop();
  }
}
