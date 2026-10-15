import type { ProvisionProvider } from "@acp/provision.js";
import type { CommandSpec } from "../core/command-registry.js";

const BUNDLED_PROVIDERS: readonly ProvisionProvider[] = ["claude", "codex"];
/** Antigravity is a per-machine download of Google's server, never part of a Remi bundle. */
export type RuntimePrepareProvider = ProvisionProvider | "antigravity";
const PREPARABLE_PROVIDERS: readonly RuntimePrepareProvider[] = [...BUNDLED_PROVIDERS, "antigravity"];

export type RuntimePrepareVersions = { acp: string; sdk: string; executable: string } | { server: string };

export interface RuntimePrepareDeps {
  configuredProvider(): string | undefined;
  detectProviders(): readonly string[];
  /** Some Antigravity install (any version) exists, so its terms were accepted before. */
  antigravityInstalled(): boolean;
  prepare(providers: RuntimePrepareProvider[], options: { acceptAntigravityTerms: boolean }): Promise<void>;
  versions(provider: RuntimePrepareProvider): RuntimePrepareVersions;
}

export function runtimePrepareCommandSpec(
  loadDeps: () => Promise<RuntimePrepareDeps> = loadRuntimePrepareDeps,
): CommandSpec {
  return {
    id: "runtime.prepare",
    path: ["runtime", "prepare"],
    description: "Install and verify this release's local ACP runtimes: bundled Claude/Codex and, on request, Google's Antigravity server",
    mutation: "write",
    options: [
      { name: "provider", type: "string", repeatable: true, valueName: "claude|codex|antigravity", description: "Prepare a provider; defaults to providers already present on this machine" },
      { name: "accept-antigravity-terms", type: "boolean", description: "Accept Google's Antigravity terms for the first Antigravity download (or set REMI_ACCEPT_ANTIGRAVITY_TERMS=1)" },
    ],
    run: async ({ options }) => {
      const deps = await loadDeps();
      const providers = resolveRuntimePrepareProviders({
        explicit: options.provider as string | string[] | undefined,
        configured: deps.configuredProvider(),
        detect: deps.detectProviders,
        antigravityInstalled: deps.antigravityInstalled,
      });
      await deps.prepare(providers, { acceptAntigravityTerms: options["accept-antigravity-terms"] === true });
      console.log(JSON.stringify({ runtimes: providers.map((provider) => {
        const v = deps.versions(provider);
        return "server" in v
          ? { provider, server: v.server, verified: true }
          : { provider, acp: v.acp, sdk: v.sdk, bundled_executable: v.executable, verified: true };
      }) }));
    },
  };
}

/**
 * Explicit --provider values must name a preparable provider. The default path
 * (used by the installer during daemon auto-upgrade) keeps the bundled
 * providers among the configured/detected ones, and Antigravity only when some
 * install already exists: Antigravity is opt-in, and pre-fetching a pin bump
 * before the CLI is replaced must never be a machine's first download. An
 * empty result is a successful no-op.
 */
export function resolveRuntimePrepareProviders(input: {
  explicit?: string | string[];
  configured?: string;
  detect: () => readonly string[];
  antigravityInstalled?: () => boolean;
}): RuntimePrepareProvider[] {
  if (input.explicit !== undefined) {
    const requested = Array.isArray(input.explicit) ? input.explicit : [input.explicit];
    if (!requested.every(isPreparableProvider)) throw new Error("--provider must be claude, codex or antigravity");
    return [...new Set(requested)];
  }
  const candidates = input.configured ? [input.configured] : input.detect();
  return [...new Set(candidates.filter((provider): provider is RuntimePrepareProvider =>
    isBundledProvider(provider) || (provider === "antigravity" && (input.antigravityInstalled?.() ?? false))))];
}

function isBundledProvider(provider: string): provider is ProvisionProvider {
  return (BUNDLED_PROVIDERS as readonly string[]).includes(provider);
}

function isPreparableProvider(provider: string): provider is RuntimePrepareProvider {
  return (PREPARABLE_PROVIDERS as readonly string[]).includes(provider);
}

async function loadRuntimePrepareDeps(): Promise<RuntimePrepareDeps> {
  const { ensureAcpBridges, locateBridgePackage } = await import("@acp/provision.js");
  const { verifyAcpRuntime, verifyAntigravityRuntime } = await import("@acp/runtime-verify.js");
  const { ANTIGRAVITY_PIN, releaseRuntimeVersions } = await import("@acp/runtime-versions.js");
  const { anyAntigravityInstall, ensureAntigravityServer } = await import("@acp/antigravity-install.js");
  const { loadMultiremiConfig } = await import("@multiremi/config.js");
  const { detectMultiremiProviders } = await import("../multiremi/daemon-health.js");
  return {
    configuredProvider: () => process.env.MULTIREMI_PROVIDER || loadMultiremiConfig().provider,
    detectProviders: () => [
      ...detectMultiremiProviders(), ...BUNDLED_PROVIDERS.filter((p) => locateBridgePackage(p)),
      ...(anyAntigravityInstall() ? ["antigravity"] : []),
    ],
    antigravityInstalled: () => anyAntigravityInstall(),
    prepare: async (providers, options) => {
      const bundled = providers.filter(isBundledProvider);
      // Preflight must not switch the executable used by the old daemon if a
      // later provider fails validation. Normal startup activates the bundle.
      ensureAcpBridges(bundled, (message) => console.error(`[runtime] ${message}`), { strict: true, activate: false });
      for (const provider of bundled) {
        await verifyAcpRuntime(provider, locateBridgePackage(provider)!);
      }
      if (providers.includes("antigravity")) {
        await ensureAntigravityServer({ acceptTerms: options.acceptAntigravityTerms, log: (message) => console.error(`[runtime] ${message}`) });
        // The daemon's own gateway shim sits in front of the fake upstream, so the check also proves the header policy.
        const { contractCheckShim } = await import("@daemon/agent-runtime/antigravity/gateway-shim.js");
        await verifyAntigravityRuntime({ shim: contractCheckShim });
      }
    },
    versions: (provider) => provider === "antigravity" ? { server: ANTIGRAVITY_PIN.server } : releaseRuntimeVersions(provider),
  };
}
