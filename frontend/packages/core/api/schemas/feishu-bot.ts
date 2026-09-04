import { z } from "zod";
import type {
  FeishuBotAvailability,
  FeishuBotCandidates,
  FeishuBotConfig,
  FeishuBotStatusSnapshot,
  IssueTopicConfigResponse,
} from "../../types";

// ---------------------------------------------------------------------------
// Workspace Feishu concierge bot (MUL-206).
//
// Leniency follows the house rules: `status`, `domain` and `error_code` stay
// `z.string()` so a value a newer server invents renders through a `default`
// branch instead of dropping the whole response and white-screening Settings.
//
// The fallbacks below all describe an *unconfigured, unavailable* bot. That
// direction matters: if a response drifts, the page must degrade toward "you
// have nothing running, go configure it" rather than toward "everything is
// online" — the second would hide a dead concierge behind a green badge.
// ---------------------------------------------------------------------------

export const FeishuBotConfigSchema = z.object({
  configured: z.boolean().default(false),
  workspace_id: z.string().default(""),
  agent_id: z.string().nullable().default(null),
  agent_name: z.string().nullable().default(null),
  agent_archived: z.boolean().default(false),
  runtime_id: z.string().nullable().default(null),
  runtime_name: z.string().nullable().default(null),
  runtime_online: z.boolean().default(false),
  runtime_supports_config: z.boolean().default(false),
  app_id: z.string().default(""),
  domain: z.string().default("feishu"),
  enabled: z.boolean().default(false),
  revision: z.number().default(0),
  app_secret_configured: z.boolean().default(false),
  app_secret_hint: z.string().nullable().default(null),
  bot_name: z.string().nullable().default(null),
  bot_open_id: z.string().nullable().default(null),
  last_tested_at: z.string().nullable().default(null),
  last_test_error: z.string().nullable().default(null),
  last_test_error_code: z.string().nullable().default(null),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
  updated_by: z.string().nullable().default(null),
}).loose();

/**
 * `GET /api/workspaces/:id/feishu-bot` answers with one of two shapes: the full
 * config for an admin, the three-field availability projection for a member.
 * The member shape is a strict subset, so the discriminator is `workspace_id` —
 * present for admins, absent for members — rather than a server-sent flag.
 */
export const FeishuBotAvailabilitySchema = z.object({
  configured: z.boolean().default(false),
  available: z.boolean().default(false),
  bot_name: z.string().nullable().default(null),
}).loose();

export const IssueTopicConfigResponseSchema = z.object({
  workspace_id: z.string().default(""),
  config: z.object({
    enabled: z.boolean().default(false),
    chat_id: z.string().default(""),
    project_ids: z.array(z.string()).nullable().default(null),
  }).loose(),
}).loose();

export const FeishuBotStatusSchema = z.object({
  status: z.string().default("not_configured"),
  workspace_id: z.string().default(""),
  enabled: z.boolean().default(false),
  revision: z.number().default(0),
  desired_state: z.string().default("stopped"),
  runtime_id: z.string().nullable().default(null),
  runtime_name: z.string().nullable().default(null),
  runtime_online: z.boolean().default(false),
  applied_revision: z.number().nullable().default(null),
  bot_name: z.string().nullable().default(null),
  last_heartbeat_at: z.string().nullable().default(null),
  error_code: z.string().nullable().default(null),
  error_message: z.string().nullable().default(null),
  stale_runtime_ids: z.array(z.string()).default([]),
}).loose();

export const FeishuBotCandidatesSchema = z.object({
  workspace_id: z.string().default(""),
  agents: z.array(z.object({
    id: z.string(),
    name: z.string().default(""),
    provider: z.string().default(""),
  }).loose()).default([]),
  runtimes: z.array(z.object({
    id: z.string(),
    name: z.string().default(""),
    provider: z.string().default(""),
    daemon_id: z.string().nullable().default(null),
    online: z.boolean().default(false),
    supports_config: z.boolean().default(false),
    last_heartbeat_at: z.string().nullable().default(null),
  }).loose()).default([]),
  encryption_available: z.boolean().default(false),
}).loose();

export const FeishuBotTestResultSchema = z.object({
  ok: z.boolean().default(false),
  bot_name: z.string().nullable().default(null),
  bot_open_id: z.string().nullable().default(null),
  app_name: z.string().nullable().default(null),
  runtime_online: z.boolean().default(false),
  runtime_supports_config: z.boolean().default(false),
  error_code: z.string().nullable().default(null),
  error_message: z.string().nullable().default(null),
}).loose();

export const FeishuBotAuditListSchema = z.object({
  workspace_id: z.string().default(""),
  entries: z.array(z.object({
    id: z.string(),
    workspaceId: z.string().default(""),
    action: z.string().default(""),
    actorType: z.string().default(""),
    actorId: z.string().nullable().default(null),
    details: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().default(""),
  }).loose()).default([]),
}).loose();

export const FeishuBotRegistrationSessionSchema = z.object({
  session_id: z.string().default(""),
  status: z.string().default("pending"),
  verification_uri: z.string().default(""),
  user_code: z.string().default(""),
  expires_at: z.string().default(""),
  poll_interval_seconds: z.number().default(5),
  app_id: z.string().nullable().default(null),
  app_secret_available: z.boolean().default(false),
  created_by_open_id: z.string().nullable().default(null),
  error_message: z.string().nullable().default(null),
}).loose();

export const EMPTY_FEISHU_BOT_CONFIG: FeishuBotConfig = {
  configured: false,
  workspace_id: "",
  agent_id: null,
  agent_name: null,
  agent_archived: false,
  runtime_id: null,
  runtime_name: null,
  runtime_online: false,
  runtime_supports_config: false,
  app_id: "",
  domain: "feishu",
  enabled: false,
  revision: 0,
  app_secret_configured: false,
  app_secret_hint: null,
  bot_name: null,
  bot_open_id: null,
  last_tested_at: null,
  last_test_error: null,
  last_test_error_code: null,
  created_at: null,
  updated_at: null,
  updated_by: null,
};

export const EMPTY_FEISHU_BOT_AVAILABILITY: FeishuBotAvailability = {
  configured: false,
  available: false,
  bot_name: null,
};

export const EMPTY_ISSUE_TOPIC_CONFIG: IssueTopicConfigResponse = {
  workspace_id: "",
  config: {
    enabled: false,
    chat_id: "",
    project_ids: null,
  },
};

export const EMPTY_FEISHU_BOT_STATUS: FeishuBotStatusSnapshot = {
  status: "not_configured",
  workspace_id: "",
  enabled: false,
  revision: 0,
  desired_state: "stopped",
  runtime_id: null,
  runtime_name: null,
  runtime_online: false,
  applied_revision: null,
  bot_name: null,
  last_heartbeat_at: null,
  error_code: null,
  error_message: null,
  stale_runtime_ids: [],
};

// No Agent and no Runtime means every picker renders empty and Save stays
// disabled — a drifted candidates response cannot talk an admin into saving a
// config that names nothing.
export const EMPTY_FEISHU_BOT_CANDIDATES: FeishuBotCandidates = {
  workspace_id: "",
  agents: [],
  runtimes: [],
  encryption_available: false,
};
