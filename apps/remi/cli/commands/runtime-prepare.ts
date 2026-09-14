import type { CommandSpec } from "../core/command-registry.js";
import { join } from "node:path";

export function runtimePrepareCommandSpec(): CommandSpec {
  return {
    id: "runtime.prepare",
    path: ["runtime", "prepare"],
    description: "Install and verify this release's local ACP and bundled Claude/Codex runtimes",
    mutation: "write",
    options: [{ name: "provider", type: "string", repeatable: true, valueName: "claude|codex", description: "Prepare a provider; defaults to providers already present on this machine" }],
    run: async ({ options }) => {
      const { ensureAcpBridges, locateBridgePackage, BRIDGE_PIN, RUNTIME_PIN } = await import("@acp/provision.js");
      const { AcpProvider, resolveAcpExecutableForAgent } = await import("@acp/provider.js");
      const { AcpClient } = await import("@acp/client.js");
      const { loadMultiremiConfig } = await import("@multiremi/config.js");
      const { detectMultiremiProviders } = await import("../multiremi/daemon-health.js");
      const configured = process.env.MULTIREMI_PROVIDER || loadMultiremiConfig().provider;
      const requested = options.provider === undefined
        ? configured ? [configured] : [...new Set([...detectMultiremiProviders(), ...(["claude", "codex"] as const).filter((p) => locateBridgePackage(p))])]
        : Array.isArray(options.provider) ? options.provider : [options.provider];
      if (requested.some((p) => p !== "claude" && p !== "codex")) throw new Error("--provider must be claude or codex");
      const providers = requested as Array<"claude" | "codex">;
      // Preflight must not switch the executable used by the old daemon if a
      // later provider fails validation. Normal startup activates the bundle.
      ensureAcpBridges(providers, (message) => console.error(`[runtime] ${message}`), { strict: true, activate: false });
      for (const provider of providers) {
        const executable = provider === "codex"
          ? process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE || join(locateBridgePackage(provider)!, "dist", "index.js")
          : resolveAcpExecutableForAgent(provider, null, "claude-agent-acp");
        const checker = new AcpProvider({ agentType: provider, executable });
        try {
          if (!await checker.healthCheck()) throw new Error(`${provider} ACP health check failed after runtime preparation`);
        } finally { await checker.close(); }
        // Import/load the real bridge and negotiate ACP without creating a
        // conversation or sending a model prompt. Version strings aren't enough.
        const client = new AcpClient({ agentType: provider, executable });
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
      console.log(JSON.stringify({ runtimes: providers.map((provider) => ({
        provider, acp: BRIDGE_PIN[provider], sdk: RUNTIME_PIN[provider].version,
        bundled_executable: RUNTIME_PIN[provider].executableVersion, verified: true,
      })) }));
    },
  };
}
