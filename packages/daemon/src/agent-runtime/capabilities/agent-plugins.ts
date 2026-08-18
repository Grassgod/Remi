import type { CapabilityBlock, EphemeralContext } from "../types.js";

/** Provider-native Agent Plugins; unrelated to Remi's host PluginRegistry. */
export const agentPluginsBlock: CapabilityBlock = {
  name: "agent-plugins",

  ephemeral(ctx: EphemeralContext) {
    const prepared = ctx.pluginRuntime;
    const codexHome = ctx.task.agent?.provider === "codex"
      ? ctx.providerHome?.home ?? prepared?.codexHome
      : undefined;
    if (!prepared) return codexHome ? { codexHome } : {};
    return {
      pluginPaths: prepared.pluginPaths,
      // The server-frozen execution fingerprint is the session reuse contract.
      // It covers the exact immutable versions plus binding configuration and
      // remains stable across daemons; the local pluginFingerprint is retained
      // only for materialization diagnostics.
      pluginFingerprint: prepared.executionFingerprint,
      codexHome,
    };
  },
};
