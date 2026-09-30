// WebSocket payload and registry types shared by api/server.ts, api/realtime.ts and the routers
// that publish to live clients. Types only — the registries themselves live in api/realtime.ts.
import type { MultiremiAccessToken } from "@multiremi/contracts/types.js";
import type { DaemonProtocolSession } from "../daemon-protocol/session.js";

export interface MultiremiRealtimeState {
  enabled: boolean;
  connections: number;
}

/**
 * A daemon socket speaking protocol v2 (MUL-417).
 *
 * Daemon and browser sockets have distinct frame vocabularies and dispatchers.
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
  /**
   * Which v2 stream kind this socket serves (MUL-438): `/ws` carries `log:*`,
   * `/api/trace/ws` carries `trace:*`.
   */
  streamEndpoint?: "log" | "trace";
}

export type MultiremiWebSocketData = DaemonProtocolWebSocketData | BrowserWebSocketData;

export type MultiremiWebSocketClient = {
  data: MultiremiWebSocketData;
  sendText(message: string): void;
  /** Bun sockets expose their backlog; legacy registry test doubles may omit it. */
  getBufferedAmount?(): number;
  close(code?: number, reason?: string): void;
}

export type BrowserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;

export type BrowserUserWebSocketRegistry = Map<string, Set<MultiremiWebSocketClient>>;
