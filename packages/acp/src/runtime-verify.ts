import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
  if (provider === "codex") verifyCodexRequestUsageProtocol(bridge);
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

/**
 * Per-request usage rests on app-server facts that patch anchors cannot prove
 * (codex-usage-v6 matched every anchor while its hook never ran): thread/start
 * must still opt into rawResponse/completed, initialize must still drop the
 * raw item stream, and the notification must still name the request.
 */
export function verifyCodexRequestUsageProtocol(bridge: string): void {
  const codex = createRequire(join(bridge, "dist", "index.js")).resolve("@openai/codex/bin/codex.js");
  const out = mkdtempSync(join(tmpdir(), "remi-codex-protocol-"));
  try {
    const result = spawnSync(Bun.which("node") ?? "node", [codex, "app-server", "generate-json-schema", "--experimental", "--out", out], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, CODEX_HOME: out },
    });
    if (result.status !== 0) throw new Error(`Codex app-server schema generation failed: ${result.stderr || result.error?.message || result.status}`);
    const schema = (file: string) => JSON.parse(readFileSync(join(out, file), "utf8"));
    const start = schema("v2/ThreadStartParams.json").properties ?? {};
    const raw = schema("v2/RawResponseCompletedNotification.json");
    const capabilities = schema("v1/InitializeParams.json").definitions?.InitializeCapabilities?.properties ?? {};
    const missing = [
      start.experimentalRawEvents?.type !== "boolean" && "thread/start experimentalRawEvents",
      !capabilities.optOutNotificationMethods && "initialize optOutNotificationMethods",
      !["threadId", "turnId", "responseId"].every(field => raw.required?.includes(field)) || !raw.properties?.usage
        ? "rawResponse/completed threadId/turnId/responseId/usage" : false,
    ].filter(Boolean);
    if (missing.length) throw new Error(`Codex request usage protocol changed: ${missing.join(", ")}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
