import type { ProvisionProvider } from "@acp/provision.js";
import type { CommandSpec } from "../core/command-registry.js";

const BUNDLED_PROVIDERS: readonly ProvisionProvider[] = ["claude", "codex"];

export interface RuntimePrepareDeps {
  configuredProvider(): string | undefined;
  detectProviders(): readonly string[];
  prepare(providers: ProvisionProvider[]): Promise<void>;
  versions(provider: ProvisionProvider): { acp: string; sdk: string; executable: string };
}

export function runtimePrepareCommandSpec(
  loadDeps: () => Promise<RuntimePrepareDeps> = loadRuntimePrepareDeps,
): CommandSpec {
  return {
    id: "runtime.prepare",
    path: ["runtime", "prepare"],
    description: "Install and verify this release's local ACP and bundled Claude/Codex runtimes",
    mutation: "write",
    options: [
      { name: "provider", type: "string", repeatable: true, valueName: "claude|codex", description: "Prepare a provider; defaults to providers already present on this machine" },
    ],
    run: async ({ options }) => {
      const deps = await loadDeps();
      const providers = resolveRuntimePrepareProviders({
        explicit: options.provider as string | string[] | undefined,
        configured: deps.configuredProvider(),
        detect: deps.detectProviders,
      });
      await deps.prepare(providers);
      console.log(JSON.stringify({ runtimes: providers.map((provider) => {
        const v = deps.versions(provider);
        return { provider, acp: v.acp, sdk: v.sdk, bundled_executable: v.executable, verified: true };
      }) }));
    },
  };
}

/**
 * Explicit --provider values must name a provider with an ACP bundle. The
 * default path (used by the installer during daemon auto-upgrade) keeps only
 * bundled providers among the configured/detected ones: others such as
 * antigravity have nothing to prepare, so an empty result is a successful no-op.
 */
export function resolveRuntimePrepareProviders(input: {
  explicit?: string | string[];
  configured?: string;
  detect: () => readonly string[];
}): ProvisionProvider[] {
  if (input.explicit !== undefined) {
    const requested = Array.isArray(input.explicit) ? input.explicit : [input.explicit];
    if (!requested.every(isBundledProvider)) throw new Error("--provider must be claude or codex");
    return [...new Set(requested)];
  }
  const candidates = input.configured ? [input.configured] : input.detect();
  return [...new Set(candidates.filter(isBundledProvider))];
}

function isBundledProvider(provider: string): provider is ProvisionProvider {
  return (BUNDLED_PROVIDERS as readonly string[]).includes(provider);
}

async function loadRuntimePrepareDeps(): Promise<RuntimePrepareDeps> {
  const { ensureAcpBridges, locateBridgePackage } = await import("@acp/provision.js");
  const { verifyAcpRuntime } = await import("@acp/runtime-verify.js");
  const { releaseRuntimeVersions } = await import("@acp/runtime-versions.js");
  const { loadMultiremiConfig } = await import("@multiremi/config.js");
  const { detectMultiremiProviders } = await import("../multiremi/daemon-health.js");
  return {
    configuredProvider: () => process.env.MULTIREMI_PROVIDER || loadMultiremiConfig().provider,
    detectProviders: () => [...detectMultiremiProviders(), ...BUNDLED_PROVIDERS.filter((p) => locateBridgePackage(p))],
    prepare: async (providers) => {
      // Preflight must not switch the executable used by the old daemon if a
      // later provider fails validation. Normal startup activates the bundle.
      ensureAcpBridges(providers, (message) => console.error(`[runtime] ${message}`), { strict: true, activate: false });
      for (const provider of providers) {
        await verifyAcpRuntime(provider, locateBridgePackage(provider)!);
      }
    },
    versions: releaseRuntimeVersions,
  };
}
