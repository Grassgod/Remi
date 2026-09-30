"use client";

import {
  createContext,
  use,
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { WSClient } from "../api/ws-client";
import type { StreamSubscription, StreamSubscriptionHandlers } from "../api/ws-client";
import {
  TraceSocket,
  deriveTraceWsUrl,
  setTraceClientFactoryForTesting,
} from "../api/trace-socket";
import type { WSEventType, StorageAdapter } from "../types";
import type { ClientIdentity } from "../platform/types";
import type { StoreApi, UseBoundStore } from "zustand";
import type { AuthState } from "../auth/store";
import {
  getCurrentSlug,
  subscribeToCurrentSlug,
} from "../platform/workspace-storage";
import { createLogger } from "../logger";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

type EventHandler = (payload: unknown, actorId?: string, actorType?: string) => void;

interface WSContextValue {
  subscribe: (event: WSEventType, handler: EventHandler) => () => void;
  onReconnect: (callback: () => void) => () => void;
  /**
   * Subscribe to a v2 stream on the main socket (`log:*`). The returned handle
   * resumes from this client's own head after a reconnect or a server resync.
   */
  subscribeStream: (
    stream: "log",
    id: string,
    handlers: StreamSubscriptionHandlers,
    options?: { fromSeq?: number },
  ) => StreamSubscription | null;
  /**
   * Subscribe to `trace:<taskId>` on the lazily-created trace socket. The socket
   * opens on the first subscription and closes with the last one.
   */
  subscribeTrace: (taskId: string, handlers: StreamSubscriptionHandlers) => StreamSubscription | null;
}

const WSContext = createContext<WSContextValue | null>(null);

export interface WSProviderProps {
  children: ReactNode;
  /** WebSocket server URL (e.g. "ws://localhost:8080/ws") */
  wsUrl: string;
  /** Platform-created auth store instance */
  authStore: UseBoundStore<StoreApi<AuthState>>;
  /** Platform-specific storage adapter for reading auth tokens */
  storage: StorageAdapter;
  /** When true, use HttpOnly cookies instead of token query param for WS auth. */
  cookieAuth?: boolean;
  /** Identifies the WS client to the server (sent as query params on the upgrade URL). */
  identity?: ClientIdentity;
  /** Optional callback for showing toast messages (platform-specific, e.g. sonner) */
  onToast?: (message: string, type?: "info" | "error") => void;
}

export function WSProvider({
  children,
  wsUrl,
  authStore,
  storage,
  cookieAuth,
  identity,
  onToast,
}: WSProviderProps) {
  const user = authStore((s) => s.user);
  // Reactive read of the current workspace slug (URL-driven singleton in
  // packages/core/platform/workspace-storage.ts). When the workspace switches,
  // the useEffect below tears down the old WS connection and opens a new one
  // bound to the new workspace slug. SSR snapshot is `null` because this
  // provider only renders client-side under CoreProvider.
  const wsSlug = useSyncExternalStore(
    subscribeToCurrentSlug,
    getCurrentSlug,
    () => null,
  );
  const [wsClient, setWsClient] = useState<WSClient | null>(null);
  // The trace socket is created on the first `subscribeTrace` and torn down with
  // its last subscriber, so a user who never opens 「执行过程」 never opens a
  // second connection. It is keyed to the same auth identity as the main socket:
  // the effect below replaces it whenever the token or workspace changes.
  const [traceSocket, setTraceSocket] = useState<TraceSocket | null>(null);

  // Depend on identity primitives instead of the object reference so a parent
  // re-render that passes a new `{ platform, version, os }` literal does not
  // tear down and reconnect the WS when nothing about the identity actually
  // changed.
  const identityPlatform = identity?.platform;
  const identityVersion = identity?.version;
  const identityOS = identity?.os;

  useEffect(() => {
    if (!user || !wsSlug) return;

    // In token mode we need a token from storage; in cookie mode the HttpOnly
    // cookie is sent automatically with the WS upgrade request.
    const token = cookieAuth ? null : storage.getItem("multimira_token");
    if (!cookieAuth && !token) return;

    const ws = new WSClient(wsUrl, {
      logger: createLogger("ws"),
      cookieAuth,
      identity:
        identityPlatform || identityVersion || identityOS
          ? {
              platform: identityPlatform,
              version: identityVersion,
              os: identityOS,
            }
          : undefined,
    });
    ws.setAuth(token, wsSlug);
    setWsClient(ws);
    ws.connect();

    const traces = new TraceSocket({
      url: deriveTraceWsUrl(wsUrl),
      token,
      workspaceSlug: wsSlug,
      cookieAuth,
      logger: createLogger("ws.trace"),
    });
    setTraceSocket(traces);

    return () => {
      ws.disconnect();
      traces.close();
      setWsClient(null);
      setTraceSocket(null);
    };
  }, [
    user,
    wsSlug,
    wsUrl,
    storage,
    cookieAuth,
    identityPlatform,
    identityVersion,
    identityOS,
  ]);

  const stores: RealtimeSyncStores = { authStore };

  // Centralized WS -> store sync (uses state so it re-subscribes when WS changes)
  useRealtimeSync(wsClient, stores, onToast);

  const subscribe = useCallback(
    (event: WSEventType, handler: EventHandler) => {
      if (!wsClient) return () => {};
      return wsClient.on(event, handler);
    },
    [wsClient],
  );

  const onReconnectCb = useCallback(
    (callback: () => void) => {
      if (!wsClient) return () => {};
      return wsClient.onReconnect(callback);
    },
    [wsClient],
  );

  const subscribeStream = useCallback(
    (
      stream: "log",
      id: string,
      handlers: StreamSubscriptionHandlers,
      options?: { fromSeq?: number },
    ) => {
      if (!wsClient) return null;
      return wsClient.subscribeStream(stream, id, handlers, options);
    },
    [wsClient],
  );

  const subscribeTrace = useCallback(
    (taskId: string, handlers: StreamSubscriptionHandlers) => {
      if (!traceSocket) return null;
      return traceSocket.subscribe(taskId, handlers);
    },
    [traceSocket],
  );

  return (
    <WSContext.Provider
      value={{ subscribe, onReconnect: onReconnectCb, subscribeStream, subscribeTrace }}
    >
      {children}
    </WSContext.Provider>
  );
}

export { setTraceClientFactoryForTesting };

export function useWS() {
  const ctx = use(WSContext);
  if (!ctx) throw new Error("useWS must be used within WSProvider");
  return ctx;
}
