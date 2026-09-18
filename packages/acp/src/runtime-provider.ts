import { AcpProvider, type AcpProviderOptions } from "./provider.js";
import { AntigravityProvider } from "./antigravity.js";

export function createRuntimeProvider(options: AcpProviderOptions = {}) {
  return options.agentType === "antigravity" ? new AntigravityProvider(options) : new AcpProvider(options);
}
