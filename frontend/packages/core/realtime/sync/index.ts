import type { WSEventType } from "../../types/events";
import { createIssueHandlers } from "./issues";
import { createInboxHandlers } from "./inbox";
import { createTimelineHandlers } from "./timeline";
import { createWorkspaceHandlers } from "./workspace";
import { createTaskHandlers } from "./tasks";
import { createChatHandlers } from "./chat";
import type { SyncContext, SyncHandler, SyncRegistrar } from "./types";

export type { SyncContext, SyncHandler, SyncHandlerMap, SyncModule, SyncRegistrar } from "./types";
export { createPrefixRefresh } from "./prefix-refresh";
export { applyChatDoneToCache } from "./chat";
export { applyWorkspaceUpdatedToCache } from "./workspace";
export { handleInboxNew, resolveInboxSourceSlug } from "./inbox";

/**
 * Every domain that subscribes to WS events, in registration order. Adding a
 * handler is one entry in one of these modules — the hook registers and tears
 * down by iterating the merged map, so the two can never drift apart.
 */
export const SYNC_REGISTRARS: readonly SyncRegistrar[] = [
  createIssueHandlers,
  createInboxHandlers,
  createTimelineHandlers,
  createWorkspaceHandlers,
  createTaskHandlers,
  createChatHandlers,
];

export interface BuiltSyncHandlers {
  /** Insertion-ordered event -> handler pairs, ready for `ws.on`. */
  entries: ReadonlyArray<readonly [WSEventType, SyncHandler]>;
  /** Runs every module's teardown. */
  dispose: () => void;
}

/**
 * Instantiates every registrar against one context and flattens the result.
 * Two modules claiming the same event would silently shadow each other, so
 * that is rejected here rather than debugged later.
 */
export function buildSyncHandlers(ctx: SyncContext): BuiltSyncHandlers {
  const entries: Array<readonly [WSEventType, SyncHandler]> = [];
  const disposers: Array<() => void> = [];
  const claimed = new Set<string>();

  for (const register of SYNC_REGISTRARS) {
    const { handlers, dispose } = register(ctx);
    for (const [event, handler] of Object.entries(handlers)) {
      if (!handler) continue;
      if (claimed.has(event)) {
        throw new Error(`duplicate realtime sync handler for "${event}"`);
      }
      claimed.add(event);
      entries.push([event as WSEventType, handler]);
    }
    if (dispose) disposers.push(dispose);
  }

  return {
    entries,
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}
