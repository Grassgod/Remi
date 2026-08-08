import type { QueryClient } from "@tanstack/react-query";
import type { StoreApi, UseBoundStore } from "zustand";
import type { AuthState } from "../../auth/store";
import type { WSEventType } from "../../types/events";

/** Everything a WS handler needs from the hook that owns the subscription. */
export interface SyncContext {
  qc: QueryClient;
  authStore: UseBoundStore<StoreApi<AuthState>>;
  onToast?: (message: string, type?: "info" | "error") => void;
  /** Read at event time so a (rare) onboarding flip doesn't re-subscribe
   *  every handler. */
  hasOnboardedRef: { readonly current: boolean };
}

/** Structurally compatible with WSClient's EventHandler — the extra
 *  `actorId` / `actorType` arguments are unused by every handler here. */
export type SyncHandler = (payload: unknown) => void;

/**
 * Event name -> handler. Keys are constrained to the WS event union, so a
 * typo'd event name is a compile error instead of a silently dead
 * subscription.
 */
export type SyncHandlerMap = Partial<Record<WSEventType, SyncHandler>>;

export interface SyncModule {
  handlers: SyncHandlerMap;
  /** Teardown for handler-local state (buffers, flush timers). Omit when the
   *  module keeps none. */
  dispose?: () => void;
}

/** A domain's contribution to the sync map, built once per subscription. */
export type SyncRegistrar = (ctx: SyncContext) => SyncModule;
