import { AcpProvider, type AcpProviderOptions } from "./provider.js";

/** Every runtime provider speaks ACP; agent differences live in adapters and access configs. */
export function createRuntimeProvider(options: AcpProviderOptions = {}) {
  return new AcpProvider(options);
}
