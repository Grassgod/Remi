// Workspace Feishu concierge bot (MUL-206) — the admin-facing shape of
// `/api/workspaces/:id/feishu-bot`.
//
// The one rule that governs this whole file: the App Secret is write-only from
// the browser's point of view. It comes back only as a configured boolean and
// a short hint, so no query cache or serialized error can hold the credential.

export type FeishuBotDomain = "feishu" | "lark" | "bytedance";

export type FeishuBotDesiredState = "running" | "stopped";

/**
 * Aggregate status. Server-derived from the config row, the host Runtime's
 * liveness and what Runtimes report, so the UI never computes it — it only
 * renders it, with a `default` branch for values a newer server may add.
 */
export type FeishuBotStatus =
  | "not_configured"
  | "stopped"
  | "deploying"
  | "connecting"
  | "online"
  | "degraded"
  | "failed"
  | "runtime_offline";

/** Non-sensitive failure vocabulary. Rendered through the i18n table. */
export type FeishuBotErrorCode =
  | "invalid_credentials"
  | "insufficient_permissions"
  | "agent_unavailable"
  | "runtime_unavailable"
  | "connector_start_failed"
  | "network_unreachable"
  | "unknown";

/** `keep` leaves the stored secret alone — the default, so editing the Agent
 *  or the domain can never wipe a credential the admin did not retype. */
export type FeishuBotSecretOp = "keep" | "set" | "clear" | "registration";

export interface IssueTopicConfig {
  enabled: boolean;
  chat_id: string;
  /** Null means every project, including projectless Issues. */
  project_ids: string[] | null;
}

export interface IssueTopicConfigResponse {
  workspace_id: string;
  config: IssueTopicConfig;
}

export interface UpdateIssueTopicConfigRequest {
  enabled: boolean;
  chat_id: string;
  project_ids: string[] | null;
}

export interface FeishuBotConfig {
  configured: boolean;
  workspace_id: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_archived: boolean;
  runtime_id: string | null;
  runtime_name: string | null;
  runtime_online: boolean;
  runtime_supports_config: boolean;
  app_id: string;
  domain: FeishuBotDomain;
  enabled: boolean;
  revision: number;
  app_secret_configured: boolean;
  /** Display-only prefix such as `cli_••••••`. Never enough to authenticate. */
  app_secret_hint: string | null;
  bot_name: string | null;
  bot_open_id: string | null;
  last_tested_at: string | null;
  last_test_error: string | null;
  last_test_error_code: FeishuBotErrorCode | null;
  created_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** What an ordinary member is allowed to see: whether a concierge answers. */
export interface FeishuBotAvailability {
  configured: boolean;
  available: boolean;
  bot_name: string | null;
}

export interface FeishuBotStatusSnapshot {
  status: FeishuBotStatus;
  workspace_id: string;
  enabled: boolean;
  revision: number;
  desired_state: FeishuBotDesiredState;
  runtime_id: string | null;
  runtime_name: string | null;
  runtime_online: boolean;
  applied_revision: number | null;
  bot_name: string | null;
  last_heartbeat_at: string | null;
  error_code: FeishuBotErrorCode | null;
  /** Already redacted server-side; safe to render verbatim. */
  error_message: string | null;
  /** Runtimes other than the selected one still reporting a live connector. */
  stale_runtime_ids: string[];
}

export interface FeishuBotAgentCandidate {
  id: string;
  name: string;
  provider: string;
}

export interface FeishuBotRuntimeCandidate {
  id: string;
  name: string;
  provider: string;
  daemon_id: string | null;
  online: boolean;
  /** False until the Runtime has advertised `feishu_concierge_config_v1`. */
  supports_config: boolean;
  last_heartbeat_at: string | null;
}

export interface FeishuBotCandidates {
  workspace_id: string;
  agents: FeishuBotAgentCandidate[];
  runtimes: FeishuBotRuntimeCandidate[];
  /** False when the server has no encryption key, so saving a secret fails. */
  encryption_available: boolean;
}

export interface FeishuBotTestResult {
  ok: boolean;
  bot_name: string | null;
  bot_open_id: string | null;
  app_name: string | null;
  runtime_online: boolean;
  runtime_supports_config: boolean;
  error_code: FeishuBotErrorCode | null;
  error_message: string | null;
}

export type FeishuBotAuditAction =
  | "configured"
  | "updated"
  | "deleted"
  | "enabled"
  | "disabled"
  | "redeployed"
  | "tested"
  | "registration_started"
  | "registration_used";

export interface FeishuBotAuditEntry {
  id: string;
  workspaceId: string;
  action: FeishuBotAuditAction;
  actorType: string;
  actorId: string | null;
  /** Records which fields moved and whether a secret was replaced — never a value. */
  details: Record<string, unknown>;
  createdAt: string;
}

export interface FeishuBotAuditList {
  workspace_id: string;
  entries: FeishuBotAuditEntry[];
}

export type FeishuBotRegistrationBrand = "feishu" | "lark";

export type FeishuBotRegistrationStatus = "pending" | "ready" | "denied" | "expired" | "error";

/**
 * Scan-to-create session. Optional convenience: the admin scans a QR in the
 * Feishu app and the server holds the resulting credentials in memory until
 * the save consumes them. `app_secret_available` is the only trace of the
 * secret that reaches the browser.
 */
export interface FeishuBotRegistrationSession {
  session_id: string;
  status: FeishuBotRegistrationStatus;
  verification_uri: string;
  user_code: string;
  expires_at: string;
  poll_interval_seconds: number;
  app_id: string | null;
  app_secret_available: boolean;
  created_by_open_id: string | null;
  error_message: string | null;
}

/** Request body for `PUT /api/workspaces/:id/feishu-bot`. */
export interface UpsertFeishuBotRequest {
  agent_id: string;
  runtime_id: string;
  app_id: string;
  domain: FeishuBotDomain;
  enabled: boolean;
  app_secret?: string;
  app_secret_op?: FeishuBotSecretOp;
  registration_session_id?: string;
}

export interface FeishuBotTestRequest {
  app_id?: string;
  app_secret?: string;
  domain?: FeishuBotDomain;
  registration_session_id?: string;
}
