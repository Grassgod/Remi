// WebSocket payload and registry types shared by api/server.ts, api/realtime.ts and the routers
// that publish to live clients. Types only — the registries themselves live in api/realtime.ts.
import type { MultiremiAccessToken } from "@multiremi/contracts/types.js";
import type { DaemonProtocolSession } from "../daemon-protocol/session.js";

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
  canReportAgentPluginProtocol: boolean;
}

/**
 * A daemon socket speaking protocol v2 (MUL-417).
 *
 * Kept a separate `kind` from the v1 socket on purpose: the two carry unrelated
 * frame vocabularies, and a shared kind would mean every existing handler grew a
 * protocol switch. A-2 deletes the v1 variant once the client is v2-only.
 */
export type DaemonProtocolWebSocketData = {
  kind: "daemon-protocol";
  connectedAt: string;
  /** Credential the upgrade authenticated with, re-checked on every heartbeat. */
  accessToken: MultiremiAccessToken | null;
  /** True when the upgrade presented the deployment master daemon credential. */
  masterToken: boolean;
  /** The session, once the socket is open. Assigned by the `open` handler. */
  session: DaemonProtocolSession | null;
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

export type MultiremiWebSocketData = DaemonWebSocketData | DaemonProtocolWebSocketData | BrowserWebSocketData;

export type MultiremiWebSocketClient = {
  data: MultiremiWebSocketData;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

export type DaemonWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserUserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserScopeWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
