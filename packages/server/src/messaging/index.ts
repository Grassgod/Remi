import { MessageProviderRegistry } from "./registry.js";
import { LarkCliMessageProvider } from "./providers/lark-cli/index.js";

export { MessageProviderRegistry } from "./registry.js";
export {
  MessagingScheduler,
  pollIsDue,
  type MessagingRunResult,
  type MessagingSchedulerOptions,
  type MessagingStore,
} from "./scheduler.js";
export {
  LARK_CLI_MESSAGE_PROVIDER_MANIFEST,
  LARK_CLI_MINIMUM_VERSION,
  LarkCliMessageProvider,
} from "./providers/lark-cli/index.js";

/**
 * The Providers this build ships with.
 *
 * Registration is the whole extension point. A Provider appearing here does
 * not mean its dependency is installed or its credential works — that is what
 * `checkHealth` reports per Connection, so an unusable Provider degrades to a
 * visible Connection status instead of a missing feature.
 */
export function createMessageProviderRegistry(): MessageProviderRegistry {
  return new MessageProviderRegistry([new LarkCliMessageProvider()]);
}
