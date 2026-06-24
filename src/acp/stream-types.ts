import type {
  RequestPermissionParams,
  PermissionOutcome,
  ElicitationCreateParams,
  ElicitationResult,
} from "./protocol.js";

/** Metadata passed alongside an ACP stream to the connector's stream consumer. */
export interface StreamMeta {
  sessionId?: string | null;
  displayName?: string | null;
  providerName?: string | null;
  agentType?: string | null;
  mode?: string | null;
  setPermissionHandler?: (handler: (params: RequestPermissionParams) => Promise<PermissionOutcome>) => void;
  setElicitationHandler?: (handler: (params: ElicitationCreateParams) => Promise<ElicitationResult>) => void;
}

/** Logger interface for stream handlers (injected, no remi dep). */
export interface StreamHandlerLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}
