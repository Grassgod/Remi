// WebSocket payload and registry types shared by api/server.ts, api/realtime.ts and the routers
// that publish to live clients. Types only — the registries themselves live in api/realtime.ts.
import type { MultiremiAccessToken } from "@multiremi/contracts/types.js";

export interface MultiremiRealtimeState {
  enabled: boolean;
  connections: number;
}

export type DaemonWebSocketData = {
  kind: "daemon";
  connectedAt: string;
  runtimeId: string | null;
  runtimeIds: string[];
  accessToken: MultiremiAccessToken | null;
}

export type BrowserWebSocketData = {
  kind: "browser";
  connectedAt: string;
  workspaceId: string;
  authenticated: boolean;
  userId: string | null;
  accessToken: MultiremiAccessToken | null;
  scopeSubscriptions: string[];
}

export type MultiremiWebSocketData = DaemonWebSocketData | BrowserWebSocketData;

export type MultiremiWebSocketClient = {
  data: MultiremiWebSocketData;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

export type DaemonWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserUserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserScopeWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
