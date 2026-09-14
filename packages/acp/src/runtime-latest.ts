import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AcpClient } from "./client.js";
import { AcpProvider, resolveAcpExecutableForAgent } from "./provider.js";
import { ensureNode, patchCodexUsageBridge } from "./provision.js";
import { installRuntimeBundle, runtimeBundleBridge, runtimeBundlePrefix, verifyRuntimeExecutable } from "./runtime-bundle.js";
import { BRIDGE_PACKAGE, RUNTIME_PIN, isStableVersion, versionsAtLeast, type RuntimeProvider, type RuntimeSelection } from "./runtime-versions.js";
import { selectedRuntimeVersions } from "./runtime-update-state.js";

type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;
export async function latestRuntimeVersions(providers: RuntimeProvider[], fetcher: RegistryFetch = fetch): Promise<RuntimeSelection> {
  const requests = new Map<string, Promise<string>>();
  const latest = (name: string) => {
    let request = requests.get(name);
    if (!request) {
      request = (async () => {
        const response = await fetcher(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`${name}: registry HTTP ${response.status}`);
        const pkg = await response.json() as { name?: string; version?: string; deprecated?: string };
        if (pkg.name !== name || !isStableVersion(pkg.version) || pkg.deprecated) {
          throw new Error(`${name}: latest is not a supported stable release`);
        }
        return pkg.version;
      })();
      requests.set(name, request);
    }
    return request;
  };
  const entries = await Promise.all(providers.map(async (provider) => {
    const [acp, sdk, executable] = await Promise.all([
      latest(BRIDGE_PACKAGE[provider]), latest(RUNTIME_PIN[provider].package),
      latest(provider === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex"),
    ]);
    const versions = { acp, sdk, executable };
    // A rolled-back dist-tag must not silently downgrade a working installation.
    if (!versionsAtLeast(versions, selectedRuntimeVersions(provider))) {
      throw new Error(`${provider}: registry latest is older than the selected runtime; keeping current versions`);
    }
    return [provider, versions] as const;
  }));
  return Object.fromEntries(entries);
}

/** Runs only in the isolated preparation CLI, never on the daemon's event loop. */
export async function prepareLatestRuntimes(providers: RuntimeProvider[]): Promise<RuntimeSelection> {
  const selection = await latestRuntimeVersions(providers);
  const log = (message: string) => console.error(`[runtime] ${message}`);
  const node = ensureNode(log);
  if (!node) throw new Error("Cannot prepare runtime updates: node unavailable");
  for (const provider of providers) {
    const versions = selection[provider]!;
    const bridge = runtimeBundleBridge(provider, runtimeBundlePrefix(provider, versions));
    let installed = false;
    try {
      installed = JSON.parse(readFileSync(join(bridge, "package.json"), "utf8")).version === versions.acp
        && verifyRuntimeExecutable(provider, bridge, node.node, versions) === versions.executable;
    } catch { /* A missing or damaged bundle is prepared in a separate directory. */ }
    if (!installed) {
      log(`preparing latest ${provider}: ACP ${versions.acp}, SDK ${versions.sdk}, executable ${versions.executable}`);
      installRuntimeBundle(provider, node, (directory) => {
        if (provider === "codex" && !patchCodexUsageBridge(log, directory)) throw new Error("Codex usage patch verification failed");
      }, versions);
    } else if (provider === "codex" && !patchCodexUsageBridge(log, bridge)) {
      throw new Error("Codex usage patch verification failed");
    }
    await verifyAcpRuntime(provider, bridge);
  }
  return selection;
}

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
