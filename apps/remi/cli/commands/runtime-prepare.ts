import type { CommandSpec } from "../core/command-registry.js";

export function runtimePrepareCommandSpec(): CommandSpec {
  return {
    id: "runtime.prepare",
    path: ["runtime", "prepare"],
    description: "Install and verify this release's local ACP and bundled Claude/Codex runtimes",
    mutation: "write",
    options: [
      { name: "provider", type: "string", repeatable: true, valueName: "claude|codex", description: "Prepare a provider; defaults to providers already present on this machine" },
    ],
    run: async ({ options }) => {
      const { ensureAcpBridges, locateBridgePackage } = await import("@acp/provision.js");
      const { verifyAcpRuntime } = await import("@acp/runtime-verify.js");
      const { releaseRuntimeVersions } = await import("@acp/runtime-versions.js");
      const { loadMultiremiConfig } = await import("@multiremi/config.js");
      const { detectMultiremiProviders } = await import("../multiremi/daemon-health.js");
      const configured = process.env.MULTIREMI_PROVIDER || loadMultiremiConfig().provider;
      const requested = options.provider === undefined
        ? configured ? [configured] : [...new Set([...detectMultiremiProviders(), ...(["claude", "codex"] as const).filter((p) => locateBridgePackage(p))])]
        : Array.isArray(options.provider) ? options.provider : [options.provider];
      if (requested.some((p) => p !== "claude" && p !== "codex")) throw new Error("--provider must be claude or codex");
      const providers = [...new Set(requested)] as Array<"claude" | "codex">;
      // Preflight must not switch the executable used by the old daemon if a
      // later provider fails validation. Normal startup activates the bundle.
      ensureAcpBridges(providers, (message) => console.error(`[runtime] ${message}`), { strict: true, activate: false });
      for (const provider of providers) {
        await verifyAcpRuntime(provider, locateBridgePackage(provider)!);
      }
      console.log(JSON.stringify({ runtimes: providers.map((provider) => {
        const v = releaseRuntimeVersions(provider);
        return { provider, acp: v.acp, sdk: v.sdk, bundled_executable: v.executable, verified: true };
      }) }));
    },
  };
}
