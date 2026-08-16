"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { WSClient } from "../api/ws-client";
import type { StoreApi, UseBoundStore } from "zustand";
import type { AuthState } from "../auth/store";
import { createLogger } from "../logger";
import { getCurrentWsId } from "../platform/workspace-storage";
import { issueKeys } from "../issues/queries";
import { projectKeys } from "../projects/queries";
import { projectDocKeys } from "../project-docs/queries";
import { autopilotKeys } from "../autopilots/queries";
import { runtimeKeys } from "../runtimes/queries";
import { runtimeModelsKeys } from "../runtimes/models";
import { labelKeys } from "../labels/queries";
import { agentPluginKeys } from "../plugins/queries";
import {
  agentTaskSnapshotKeys,
  agentActivityKeys,
  agentRunCountsKeys,
  agentTasksKeys,
} from "../agents/queries";
import { inboxKeys } from "../inbox/queries";
import { workspaceKeys } from "../workspace/queries";
import { chatKeys } from "../chat/queries";
import { useHasOnboarded } from "../paths";
import { buildSyncHandlers, createPrefixRefresh, type SyncContext } from "./sync";

export {
  applyChatDoneToCache,
  applyWorkspaceUpdatedToCache,
  handleInboxNew,
  resolveInboxSourceSlug,
} from "./sync";

const logger = createLogger("realtime-sync");

/**
 * Invalidates all workspace-scoped queries. Used after reconnect and when a
 * new WSClient instance is detected (workspace switch) to recover events
 * missed while disconnected.
 */
function invalidateWorkspaceScopedQueries(qc: QueryClient): void {
  const wsId = getCurrentWsId();
  if (wsId) {
    qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: inboxKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.members(wsId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.skills(wsId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.invitations(wsId) });
    qc.invalidateQueries({ queryKey: projectKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: projectDocKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
    qc.invalidateQueries({ queryKey: runtimeKeys.daemonInventory(wsId) });
    qc.invalidateQueries({ queryKey: autopilotKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: agentTasksKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: agentActivityKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: agentRunCountsKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: chatKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: labelKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
    qc.invalidateQueries({ queryKey: issueKeys.workspacesAll() });
    qc.invalidateQueries({ queryKey: ["issues", "tasks"] });
    qc.invalidateQueries({ queryKey: ["issues", "sessions"] });
  }
  qc.invalidateQueries({ queryKey: workspaceKeys.list() });
}

export interface RealtimeSyncStores {
  authStore: UseBoundStore<StoreApi<AuthState>>;
}

/**
 * Centralized WS -> store sync. Called once from WSProvider.
 *
 * Uses the "WS as invalidation signal + refetch" pattern:
 * - onAny handler extracts event prefix and calls the matching store refresh
 * - Debounce per-prefix prevents rapid-fire refetches (e.g. bulk issue updates)
 * - Precise handlers only for side effects (toast, navigation, self-check)
 *
 * The precise handlers live one file per domain under `realtime/sync/`; this
 * hook only owns the subscription lifecycle. Registration and teardown iterate
 * the same list, so a new handler can never be left subscribed on unmount.
 *
 * Per-issue events (comments, activity, reactions, subscribers) are handled
 * both here (invalidation fallback) and by per-page useWSEvent hooks (granular
 * updates). Daemon register events invalidate runtimes globally; heartbeats
 * are skipped to avoid excessive refetches.
 *
 * @param ws - WebSocket client instance (null when not yet connected)
 * @param stores - Platform-created Zustand store instances for auth and workspace
 * @param onToast - Optional callback for showing toast messages (platform-specific)
 */
export function useRealtimeSync(
  ws: WSClient | null,
  stores: RealtimeSyncStores,
  onToast?: (message: string, type?: "info" | "error") => void,
) {
  const { authStore } = stores;
  const qc = useQueryClient();

  // Captured via ref so the (rare) hasOnboarded change doesn't re-subscribe
  // every WS handler in this effect. The resolver reads `.current` at the
  // moment workspace-loss fires, which is what we want.
  const hasOnboarded = useHasOnboarded();
  const hasOnboardedRef = useRef(hasOnboarded);
  hasOnboardedRef.current = hasOnboarded;

  // Main sync: onAny -> prefix refresh with debounce, plus the per-domain
  // handler map.
  useEffect(() => {
    if (!ws) return;

    const ctx: SyncContext = { qc, authStore, onToast, hasOnboardedRef };
    const prefixRefresh = createPrefixRefresh(ctx);
    const { entries, dispose } = buildSyncHandlers(ctx);

    const unsubscribes: Array<() => void> = [ws.onAny(prefixRefresh.onAny)];
    for (const [event, handler] of entries) {
      unsubscribes.push(ws.on(event, handler));
    }

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      dispose();
      prefixRefresh.dispose();
    };
  }, [ws, qc, authStore, onToast]);

  // Reconnect -> refetch all data to recover missed events
  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onReconnect(async () => {
      logger.info("reconnected, refetching all data");
      try {
        invalidateWorkspaceScopedQueries(qc);
      } catch (e) {
        logger.error("reconnect refetch failed", e);
      }
    });

    return unsub;
  }, [ws, qc]);

  // New WSClient instance (workspace switch) -> invalidate workspace-scoped
  // queries to recover events missed while the previous instance was torn down.
  // Skips the initial assignment to avoid a redundant refetch on first mount.
  const wsInstanceRef = useRef<WSClient | null>(null);
  useEffect(() => {
    if (!ws) return;
    if (wsInstanceRef.current === null) {
      // First non-null instance — store and skip invalidation.
      wsInstanceRef.current = ws;
      return;
    }
    if (wsInstanceRef.current === ws) return;
    wsInstanceRef.current = ws;

    logger.info("new WSClient instance detected, invalidating workspace queries");
    invalidateWorkspaceScopedQueries(qc);
  }, [ws, qc]);
}
