/**
 * Workspace Feishu concierge bot configuration (MUL-206).
 *
 * Owns `multiremi_feishu_bot_configs` (one row per workspace) and
 * `multiremi_feishu_bot_runtime_states` (one row per Runtime that has ever
 * reported on this workspace's connector).
 *
 * Two invariants drive the shape of this repo:
 *
 * 1. **Secrets never leave as plaintext except to the selected Runtime.**
 *    `getConfig()` returns a view with `has*` booleans; only
 *    `getDaemonConfig()` decrypts, and it refuses any Runtime other than the
 *    configured one.
 * 2. **The bot cannot run in two places.** `directiveForRuntime()` hands
 *    `running` to exactly one Runtime, and withholds it from the newly selected
 *    Runtime until every other Runtime has confirmed `stopped` (or gone
 *    offline). That is the two-phase handover acceptance criterion 8 asks for.
 */

import { FEISHU_IMAGE_MAX_BYTES } from "@connectors/feishu/outbound-images.js";
import { chatAttachmentValidationError } from "@multiremi/contracts/attachments.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { advancesFeishuPresentation, parseFeishuPresentation } from "@multiremi/contracts/feishu-presentation.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import {
  decryptFeishuBotSecret,
  encryptFeishuBotSecret,
  feishuBotSecretHint,
} from "@multiremi/feishu-bot/credentials.js";
import { normalizeFeishuBotErrorCode } from "@multiremi/feishu-bot/diagnostics.js";
import { isRuntimeEffectivelyOnline } from "@multiremi/store/repos/runtimes-repo.js";
import { readWorkspaceIssueTopics } from "@multiremi/issue-topics/config.js";
import { findMarkdownImages } from "@shared/feishu-markdown-images.js";
import { isFeishuOpenId, parseOutboundMention } from "@shared/feishu-mention.js";
import { FEISHU_CONCIERGE_CONFIG_CAPABILITY } from "@multiremi/contracts/types.js";
import type {
  FeishuBotAuditAction,
  FeishuPresentationCheckpoint,
  FeishuBotDesiredState,
  FeishuBotDomain,
  FeishuBotErrorCode,
  FeishuBotRuntimeState,
  FeishuBotAgentRouteScope,
  FeishuBotSender,
  FeishuBotSessionSnapshot,
  FeishuBotSecretOp,
  FeishuBotStatus,
  MultiremiFeishuBotAuditEntry,
  MultiremiFeishuBotConfig,
  MultiremiFeishuBotDaemonConfig,
  MultiremiFeishuBotDirective,
  MultiremiFeishuBotOutboundDelivery,
  MultiremiFeishuBotRuntimeStatus,
  MultiremiFeishuBotAgentRoute,
  MultiremiAttachment,
  CreateAttachmentInput,
  MultiremiIssue,
  MultiremiChatSession,
  MultiremiTask,
  MultiremiTaskHumanRequest,
  SubmitFeishuBotMessageInput,
  SubmitFeishuBotMessageResult,
  ReportFeishuBotRuntimeStatusInput,
  ReplaceFeishuBotAgentRouteInput,
  UpsertFeishuBotConfigInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

interface ResolvedFeishuSender {
  id: string | null;
  allowed: boolean;
  displayName: string;
  actorId: string;
  profileDescription: string;
}

const DOMAINS: ReadonlySet<FeishuBotDomain> = new Set<FeishuBotDomain>(["feishu", "lark", "bytedance"]);
const RUNTIME_STATES: ReadonlySet<FeishuBotRuntimeState> = new Set<FeishuBotRuntimeState>([
  "stopped",
  "starting",
  "online",
  "failed",
]);
const ROUTE_SCOPES: ReadonlySet<FeishuBotAgentRouteScope> = new Set([
  "p2p_default",
  "group_default",
  "chat",
]);

/**
 * How long a Runtime's reported state stays trustworthy. Past this the Runtime
 * is treated as gone for handover purposes, so a machine that was unplugged
 * mid-connector cannot block a replacement forever.
 */
const RUNTIME_STATE_STALE_MS = 90_000;

export interface FeishuBotStatusSnapshot {
  status: FeishuBotStatus;
  config: MultiremiFeishuBotConfig | null;
  desiredState: FeishuBotDesiredState;
  runtimeOnline: boolean;
  appliedRevision: number | null;
  botName: string | null;
  lastHeartbeatAt: string | null;
  errorCode: FeishuBotErrorCode | null;
  errorMessage: string | null;
  staleRuntimeIds: string[];
}

export interface ResolvedFeishuBotAgent {
  agentId: string;
  agentName: string;
}

export class FeishuBotConfigError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "FeishuBotConfigError";
  }
}

export class FeishuBotRepo {
  constructor(private readonly ctx: StoreContext) {}

  listTaskReceiptMessageIds(workspaceId: string, taskId: string): string[] {
    return (this.ctx.db.query(`SELECT d.external_message_id FROM multiremi_feishu_bot_deliveries d
      JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id
      JOIN multiremi_feishu_bot_configs c ON c.workspace_id = d.workspace_id AND c.app_id = b.app_id
      WHERE d.workspace_id = ? AND d.task_id = ?
      ORDER BY d.created_at, d.external_message_id`).all(workspaceId, taskId) as Row[])
      .map(row => String(row.external_message_id));
  }

  listSenders(workspaceId: string): FeishuBotSender[] {
    const config = this.getConfig(workspaceId);
    if (!config) return [];
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_bot_senders
       WHERE workspace_id = ? AND app_id = ?
       ORDER BY allowed ASC, last_seen_at DESC, id ASC`,
    ).all(workspaceId, config.appId) as Row[]).map(toSender);
  }

  listSenderProfileSources(workspaceId: string, before: string) {
    const config = this.getConfig(workspaceId);
    if (!config) return [];
    const rows = this.ctx.db.query(`SELECT s.id, s.app_id, s.open_id,
        (SELECT d.external_message_id FROM multiremi_feishu_bot_deliveries d
         WHERE d.sender_id = s.id ORDER BY d.created_at DESC, d.external_message_id DESC LIMIT 1) AS message_id
      FROM multiremi_feishu_bot_senders s
      WHERE s.workspace_id = ? AND s.app_id = ?
        AND s.open_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM multiremi_feishu_bot_deliveries d WHERE d.sender_id = s.id)
        AND (s.profile_checked_at IS NULL OR s.profile_checked_at < ?)
      ORDER BY s.profile_checked_at ASC, s.last_seen_at DESC, s.id ASC LIMIT 10`
    ).all(workspaceId, config.appId, before) as Row[];
    return rows.flatMap(row => row.message_id ? [{ id: String(row.id), appId: String(row.app_id),
      openId: String(row.open_id), messageId: String(row.message_id) }] : []);
  }

  updateSenderProfile(workspaceId: string, appId: string, senderId: string,
    profile: { name: string; nameEn: string | null } | null, checkedAt: string): void {
    if (this.getConfig(workspaceId)?.appId !== appId) return;
    this.ctx.db.run(`UPDATE multiremi_feishu_bot_senders
      SET display_name = COALESCE(?, display_name), name_en = COALESCE(?, name_en), profile_checked_at = ?
      WHERE id = ? AND workspace_id = ? AND app_id = ?`,
    [profile?.name ?? null, profile?.nameEn ?? null, checkedAt, senderId, workspaceId, appId]);
  }

  setSenderAllowed(workspaceId: string, senderId: string, allowed: boolean, actorId?: string | null): FeishuBotSender | null {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const config = this.getConfig(workspaceId);
      if (!config) return null;
      const row = this.ctx.db.query(
        `SELECT * FROM multiremi_feishu_bot_senders WHERE id = ? AND workspace_id = ? AND app_id = ?`,
      ).get(senderId, workspaceId, config.appId) as Row | null;
      if (!row) return null;
      if (Boolean(Number(row.allowed)) !== allowed) {
        this.ctx.db.run("UPDATE multiremi_feishu_bot_senders SET allowed = ? WHERE id = ?", [allowed ? 1 : 0, senderId]);
        this.recordAudit(workspaceId, allowed ? "sender_allowed" : "sender_revoked", {
          actorId,
          details: { sender_id: senderId, app_id: config.appId },
        });
      }
      return toSender({ ...row, allowed: allowed ? 1 : 0 });
    })();
  }

  /** Chat history and delegated tasks retain their input's current authority.
   * Keep this separate from the static task policy so approval can take effect
   * without clearing an independent Agent or parent-task restriction. */
  isTaskIssueCreationRestricted(taskId: string): boolean {
    return Boolean(this.ctx.db.query(
      `WITH RECURSIVE lineage AS (
         SELECT id, parent_task_id, chat_session_id FROM multiremi_tasks WHERE id = ?
         UNION
         SELECT p.id, p.parent_task_id, p.chat_session_id FROM multiremi_tasks p
         JOIN lineage child ON p.id = child.parent_task_id
       )
       SELECT 1 AS restricted FROM multiremi_feishu_bot_deliveries d
       JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id
       JOIN multiremi_feishu_bot_configs c ON c.workspace_id = d.workspace_id
       LEFT JOIN multiremi_feishu_bot_senders s ON s.id = d.sender_id
       WHERE c.sender_access_policy = 'allowlist' AND d.sender_recorded = 1
         AND (d.task_id IN (SELECT id FROM lineage)
           OR b.chat_session_id IN (SELECT chat_session_id FROM lineage))
         AND (s.id IS NULL OR s.allowed = 0)
       LIMIT 1`,
    ).get(taskId));
  }

  getConfig(workspaceId: string): MultiremiFeishuBotConfig | null {
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ?")
      .get(workspaceId) as Row | null;
    return row ? mapConfig(row) : null;
  }

  listRoutes(workspaceId: string): MultiremiFeishuBotAgentRoute[] {
    const rows = this.ctx.db.query(
      `SELECT r.*, a.name AS agent_name, a.archived_at AS agent_archived_at
       FROM multiremi_feishu_bot_agent_routes r
       LEFT JOIN multiremi_agents a ON a.id = r.agent_id
       WHERE r.workspace_id = ?
       ORDER BY CASE r.scope
         WHEN 'p2p_default' THEN 0
         WHEN 'group_default' THEN 1
         ELSE 2
       END, r.chat_name ASC, r.chat_id ASC, r.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(mapRoute);
  }

  replaceRoutes(
    workspaceId: string,
    inputs: readonly ReplaceFeishuBotAgentRouteInput[],
    actor?: string | null,
  ): MultiremiFeishuBotAgentRoute[] {
    if (inputs.length > 500) {
      throw new FeishuBotConfigError("too many routes", 400, "too_many_routes");
    }
    const normalized = inputs.map((input) => this.normalizeRouteInput(workspaceId, input));
    const keys = new Set<string>();
    for (const route of normalized) {
      const key = routeKey(route.scope, route.chatId);
      if (keys.has(key)) {
        throw new FeishuBotConfigError("duplicate route", 400, "duplicate_route");
      }
      keys.add(key);
    }

    this.ctx.db.transaction(() => {
      const existing = this.listRoutes(workspaceId);
      const existingByKey = new Map(existing.map((route) => [routeKey(route.scope, route.chatId), route]));
      const retainedIds = new Set<string>();
      const now = nowIso();
      const updatedBy = cleanOptionalString(actor);
      for (const route of normalized) {
        const current = existingByKey.get(routeKey(route.scope, route.chatId));
        if (!current) {
          const id = createId("fbr");
          this.ctx.db.run(
            `INSERT INTO multiremi_feishu_bot_agent_routes (
               id, workspace_id, scope, chat_id, chat_name, agent_id,
               created_at, updated_at, updated_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, workspaceId, route.scope, route.chatId, route.chatName, route.agentId, now, now, updatedBy],
          );
          retainedIds.add(id);
          continue;
        }
        retainedIds.add(current.id);
        if (current.agentId === route.agentId && current.chatName === route.chatName) continue;
        this.ctx.db.run(
          `UPDATE multiremi_feishu_bot_agent_routes
           SET chat_name = ?, agent_id = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
          [route.chatName, route.agentId, now, updatedBy, current.id],
        );
      }
      for (const route of existing) {
        if (!retainedIds.has(route.id)) {
          this.ctx.db.run("DELETE FROM multiremi_feishu_bot_agent_routes WHERE id = ?", route.id);
        }
      }
    })();
    return this.listRoutes(workspaceId);
  }

  updateRouteChatName(workspaceId: string, chatId: string, chatName: string | null): void {
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_agent_routes
       SET chat_name = ?, updated_at = ?
       WHERE workspace_id = ? AND scope = 'chat' AND chat_id = ?
         AND COALESCE(chat_name, '') <> COALESCE(?, '')`,
      [cleanOptionalString(chatName), nowIso(), workspaceId, chatId, cleanOptionalString(chatName)],
    );
  }

  resolveRouteAgent(
    workspaceId: string,
    chatType: "p2p" | "group",
    chatId?: string | null,
  ): ResolvedFeishuBotAgent | null {
    const candidates: Row[] = [];
    const normalizedChatId = cleanOptionalString(chatId);
    if (normalizedChatId) {
      const exact = this.ctx.db.query(
        `SELECT r.agent_id, a.name AS agent_name, a.workspace_id AS agent_workspace_id,
                a.archived_at AS agent_archived_at
         FROM multiremi_feishu_bot_agent_routes r
         LEFT JOIN multiremi_agents a ON a.id = r.agent_id
         WHERE r.workspace_id = ? AND r.scope = 'chat' AND r.chat_id = ?
         ORDER BY r.updated_at DESC, r.id DESC LIMIT 1`,
      ).get(workspaceId, normalizedChatId) as Row | null;
      if (exact) candidates.push(exact);
    }
    const typeDefault = this.ctx.db.query(
      `SELECT r.agent_id, a.name AS agent_name, a.workspace_id AS agent_workspace_id,
              a.archived_at AS agent_archived_at
       FROM multiremi_feishu_bot_agent_routes r
       LEFT JOIN multiremi_agents a ON a.id = r.agent_id
       WHERE r.workspace_id = ? AND r.scope = ? AND r.chat_id IS NULL
       ORDER BY r.updated_at DESC, r.id DESC LIMIT 1`,
    ).get(workspaceId, chatType === "p2p" ? "p2p_default" : "group_default") as Row | null;
    if (typeDefault) candidates.push(typeDefault);

    for (const candidate of candidates) {
      if (candidate.agent_workspace_id !== workspaceId || candidate.agent_archived_at != null) continue;
      const agentId = String(candidate.agent_id ?? "");
      if (agentId) return { agentId, agentName: String(candidate.agent_name ?? agentId) };
    }
    const config = this.getConfig(workspaceId);
    if (!config) return null;
    const agent = this.ctx.agents().getAgent(config.agentId);
    return { agentId: config.agentId, agentName: agent?.name ?? config.agentId };
  }

  /** Reject run intent before changing the saved host, secrets, or revision. */
  private requireDeployableRuntime(workspaceId: string, runtimeId: string): void {
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime || runtime.workspaceId !== workspaceId) {
      throw new FeishuBotConfigError("runtime does not belong to this workspace", 400, "runtime_not_in_workspace");
    }
    if (!isRuntimeEffectivelyOnline(runtime)) {
      throw new FeishuBotConfigError(
        "runtime is offline or its heartbeat has expired; bring it online before enabling or deploying, or save with enabled=false",
        409,
        "runtime_offline",
      );
    }
    if (runtime.metadata[FEISHU_CONCIERGE_CONFIG_CAPABILITY] !== true) {
      throw new FeishuBotConfigError(
        "runtime does not advertise Feishu concierge configuration support; select a capable runtime or save with enabled=false",
        409,
        "runtime_config_unsupported",
      );
    }
  }

  /**
   * Create or replace the workspace's config. Secret columns follow the
   * caller's per-field op so a PUT that only changes the domain cannot wipe an
   * app secret the admin never re-typed.
   */
  upsertConfig(workspaceId: string, input: UpsertFeishuBotConfigInput): MultiremiFeishuBotConfig {
    const agentId = cleanOptionalString(input.agentId);
    const runtimeId = cleanOptionalString(input.runtimeId);
    const appId = cleanOptionalString(input.appId);
    if (!agentId) throw new FeishuBotConfigError("agent_id is required", 400, "agent_required");
    if (!runtimeId) throw new FeishuBotConfigError("runtime_id is required", 400, "runtime_required");
    if (!appId) throw new FeishuBotConfigError("app_id is required", 400, "app_id_required");
    const domain = normalizeDomain(input.domain);

    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new FeishuBotConfigError("agent does not belong to this workspace", 400, "agent_not_in_workspace");
    }
    if (agent.archivedAt) {
      throw new FeishuBotConfigError("agent is archived", 400, "agent_archived");
    }
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime || runtime.workspaceId !== workspaceId) {
      throw new FeishuBotConfigError("runtime does not belong to this workspace", 400, "runtime_not_in_workspace");
    }
    if (!this.ctx.runtimes().runtimeCanRunAgent(runtime, agent)) {
      throw new FeishuBotConfigError(
        "runtime cannot run the selected agent provider",
        400,
        "runtime_agent_incompatible",
      );
    }
    if (input.enabled) this.requireDeployableRuntime(workspaceId, runtimeId);

    const existing = this.rawConfigRow(workspaceId);
    const senderAccessPolicy = input.senderAccessPolicy ?? existing?.sender_access_policy ?? "agent";
    if (senderAccessPolicy !== "agent" && senderAccessPolicy !== "allowlist") {
      throw new FeishuBotConfigError("sender_access_policy must be agent or allowlist", 400, "invalid_sender_access_policy");
    }
    const appSecret = resolveSecretColumn(
      workspaceId,
      "app_secret",
      input.appSecretOp,
      input.appSecret,
      nullableString(existing?.app_secret_encrypted),
    );
    if (!appSecret.ciphertext) {
      throw new FeishuBotConfigError("app_secret is required", 400, "app_secret_required");
    }
    const now = nowIso();
    const previousRevision = Number(existing?.revision ?? 0);
    const revision = previousRevision + 1;
    // Any change to the identity of the bot invalidates the recorded bot
    // profile and test result: they described a different app or agent.
    const identityChanged = !existing
      || String(existing.app_id ?? "") !== appId
      || String(existing.domain ?? "") !== domain
      || String(existing.agent_id ?? "") !== agentId
      || appSecret.changed;
    const hint = appSecret.hint ?? nullableString(existing?.app_secret_hint);

    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_configs (
         workspace_id, agent_id, runtime_id, app_id,
         app_secret_encrypted, app_secret_hint,
         domain, enabled, sender_access_policy, revision,
         bot_name, bot_open_id, last_tested_at, last_test_error, last_test_error_code,
         created_at, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         runtime_id = excluded.runtime_id,
         app_id = excluded.app_id,
         app_secret_encrypted = excluded.app_secret_encrypted,
         app_secret_hint = excluded.app_secret_hint,
         domain = excluded.domain,
         enabled = excluded.enabled,
         sender_access_policy = excluded.sender_access_policy,
         revision = excluded.revision,
         bot_name = excluded.bot_name,
         bot_open_id = excluded.bot_open_id,
         last_tested_at = excluded.last_tested_at,
         last_test_error = excluded.last_test_error,
         last_test_error_code = excluded.last_test_error_code,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      workspaceId,
      agentId,
      runtimeId,
      appId,
      appSecret.ciphertext,
      hint,
      domain,
      input.enabled ? 1 : 0,
      senderAccessPolicy,
      revision,
      identityChanged ? null : nullableString(existing?.bot_name),
      identityChanged ? null : nullableString(existing?.bot_open_id),
      identityChanged ? null : nullableString(existing?.last_tested_at),
      identityChanged ? null : nullableString(existing?.last_test_error),
      identityChanged ? null : nullableString(existing?.last_test_error_code),
      nullableString(existing?.created_at) ?? now,
      now,
      cleanOptionalString(input.actor),
    );
    return this.getConfig(workspaceId)!;
  }

  deleteConfig(workspaceId: string): boolean {
    const existing = this.rawConfigRow(workspaceId);
    if (!existing) return false;
    this.ctx.db.run("DELETE FROM multiremi_feishu_bot_configs WHERE workspace_id = ?", workspaceId);
    // Reported states are intentionally kept: a Runtime that is still hosting
    // the connector must keep appearing here until it confirms it stopped, so
    // `directiveForRuntime` can go on telling it to stop after the row is gone.
    return true;
  }

  /**
   * Flip the run/stop intent without touching credentials. Returns null when
   * nothing is configured so callers can 404 rather than create a config.
   */
  setEnabled(workspaceId: string, enabled: boolean, actor?: string | null): MultiremiFeishuBotConfig | null {
    const existing = this.rawConfigRow(workspaceId);
    if (!existing) return null;
    if (enabled) this.requireDeployableRuntime(workspaceId, String(existing.runtime_id));
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_configs
          SET enabled = ?, revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE workspace_id = ?`,
      enabled ? 1 : 0,
      nowIso(),
      cleanOptionalString(actor),
      workspaceId,
    );
    return this.getConfig(workspaceId);
  }

  /**
   * Force a redeploy without a config change. Bumping the revision is enough:
   * the selected Runtime sees a revision it has not applied and restarts.
   */
  bumpRevision(workspaceId: string, actor?: string | null): MultiremiFeishuBotConfig | null {
    const existing = this.rawConfigRow(workspaceId);
    if (!existing) return null;
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_configs
          SET revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE workspace_id = ?`,
      nowIso(),
      cleanOptionalString(actor),
      workspaceId,
    );
    return this.getConfig(workspaceId);
  }

  recordTestResult(
    workspaceId: string,
    result: {
      botName?: string | null;
      botOpenId?: string | null;
      errorCode?: FeishuBotErrorCode | null;
      errorMessage?: string | null;
    },
  ): MultiremiFeishuBotConfig | null {
    if (!this.rawConfigRow(workspaceId)) return null;
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_configs
          SET bot_name = ?, bot_open_id = ?, last_tested_at = ?,
              last_test_error = ?, last_test_error_code = ?, updated_at = ?
        WHERE workspace_id = ?`,
      cleanOptionalString(result.botName),
      cleanOptionalString(result.botOpenId),
      nowIso(),
      cleanOptionalString(result.errorMessage),
      normalizeFeishuBotErrorCode(result.errorCode),
      nowIso(),
      workspaceId,
    );
    return this.getConfig(workspaceId);
  }

  /** Decrypted secrets, for building a `test` request against the open platform. */
  revealSecrets(workspaceId: string): {
    appId: string;
    appSecret: string;
    domain: FeishuBotDomain;
  } | null {
    const row = this.rawConfigRow(workspaceId);
    if (!row) return null;
    return {
      appId: String(row.app_id ?? ""),
      appSecret: decryptFeishuBotSecret(String(row.app_secret_encrypted ?? ""), {
        workspaceId,
        field: "app_secret",
      }),
      domain: normalizeDomain(row.domain),
    };
  }

  /**
   * Runtime-scoped fetch. Returns null for any Runtime that is not the selected
   * host — a daemon token bound to Runtime B may not read the credentials
   * assigned to Runtime A even inside the same workspace.
   */
  getDaemonConfig(workspaceId: string, runtimeId: string): MultiremiFeishuBotDaemonConfig | null {
    const row = this.rawConfigRow(workspaceId);
    if (!row) return null;
    if (String(row.runtime_id ?? "") !== runtimeId) return null;
    const directive = this.directiveForRuntime(workspaceId, runtimeId);
    if (!directive || !directive.config_available) return null;
    return {
      workspace_id: workspaceId,
      runtime_id: runtimeId,
      agent_id: String(row.agent_id ?? ""),
      revision: Number(row.revision ?? 0),
      desired_state: directive.desired_state,
      app_id: String(row.app_id ?? ""),
      app_secret: decryptFeishuBotSecret(String(row.app_secret_encrypted ?? ""), {
        workspaceId,
        field: "app_secret",
      }),
      domain: normalizeDomain(row.domain),
    };
  }

  assertInboundAttachmentScope(workspaceId: string, runtimeId: string,
    input: Pick<SubmitFeishuBotMessageInput, "revision" | "externalSessionKey" | "externalMessageId">): MultiremiFeishuBotConfig {
    const config = this.getConfig(workspaceId);
    if (!config?.enabled) throw new FeishuBotConfigError("feishu bot is not running", 409, "bot_not_running");
    if (config.runtimeId !== runtimeId) throw new FeishuBotConfigError("runtime does not host this feishu bot", 403, "runtime_not_selected");
    if (config.revision !== input.revision) throw new FeishuBotConfigError("feishu bot assignment is stale", 409, "stale_revision");
    requiredBoundedString(input.externalSessionKey, "external_session_key", 1_024);
    requiredBoundedString(input.externalMessageId, "external_message_id", 512);
    return config;
  }

  createInboundAttachment(workspaceId: string, runtimeId: string,
    scope: Pick<SubmitFeishuBotMessageInput, "revision" | "externalSessionKey" | "externalMessageId">,
    input: CreateAttachmentInput): MultiremiAttachment {
    return this.ctx.db.transaction(() => {
      const config = this.assertInboundAttachmentScope(workspaceId, runtimeId, scope);
      const attachment = this.ctx.issues().createAttachment({ ...input, workspaceId,
        issueId: null, commentId: null, chatSessionId: null, chatMessageId: null,
        uploaderType: "daemon", uploaderId: runtimeId });
      this.ctx.db.run(`INSERT INTO multiremi_feishu_bot_inbound_attachments
        (attachment_id, workspace_id, runtime_id, app_id, revision, external_session_key, external_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [attachment.id, workspaceId, runtimeId, config.appId,
          scope.revision, scope.externalSessionKey.trim(), scope.externalMessageId.trim()]);
      return attachment;
    })();
  }

  /** Atomic Chat message + outbox registration. File bytes are already persisted. */
  sendChatAttachments(taskId: string, inputs: CreateAttachmentInput[], body = "") {
    const result = this.ctx.db.transaction(() => {
      const task = this.ctx.tasks().getTask(taskId);
      if (!task?.chatSessionId) throw new Error("current task is not a Chat task");
      const session = this.ctx.chat().getChatSession(task.chatSessionId);
      if (!session || session.workspaceId !== task.workspaceId) throw new Error("chat session not found");
      if (!inputs.length || inputs.length > 10) throw new Error("between 1 and 10 attachments are required");
      for (const input of inputs) {
        const error = chatAttachmentValidationError(input.filename, Number(input.sizeBytes));
        if (error) throw new Error(error);
      }
      const config = this.getConfig(task.workspaceId);
      const binding = this.ctx.db.query(`SELECT * FROM multiremi_feishu_bot_chat_bindings
        WHERE chat_session_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(session.id, session.workspaceId) as Row | null;
      if (binding && (!config?.enabled || binding.app_id !== config.appId)) {
        throw new Error("Feishu bot is unavailable for this Chat");
      }
      // Policy extension point: evaluate future workspace Chat delivery policy
      // before creating either the assistant message or outbound rows.
      const message = this.ctx.chat().appendChatMessageWithinTransaction({ chatSessionId: session.id,
        taskId, role: "assistant", body });
      const attachments = inputs.map(input => this.ctx.issues().createAttachment({ ...input,
        workspaceId: session.workspaceId, chatSessionId: session.id, chatMessageId: message.id,
        uploaderType: "agent", uploaderId: task.agentId }));
      const deliveryIds: string[] = [];
      if (binding) {
        if (!binding.chat_id) throw new Error("Feishu Chat has no destination");
        const batchId = createId("fbo");
        const now = nowIso();
        for (const [index, attachment] of attachments.entries()) {
          // Keep a readable batch order; claim eligibility is enforced by the
          // predecessor, not by sorting (other deliveries may run concurrently).
          const id = `${batchId}_${String(index).padStart(2, "0")}`;
          const descriptor = { id: attachment.id, filename: attachment.filename,
            contentType: attachment.contentType, sizeBytes: attachment.sizeBytes };
          // One file per delivery gives retries an independent stable Feishu UUID.
          this.ctx.db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
            (id, workspace_id, binding_id, chat_id, thread_id, reply_to_message_id,
             body, attachments, previous_delivery_id, status, available_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
            [id, task.workspaceId, binding.id, binding.chat_id, binding.thread_id,
              binding.reply_to_message_id, deliveryIds.length === 0 ? body : "", toJson([descriptor]),
              deliveryIds.at(-1) ?? null, now, now, now]);
          deliveryIds.push(id);
        }
      }
      return { message, attachments, delivery_ids: deliveryIds };
    })();
    const session = this.ctx.chat().getChatSession(result.message.chatSessionId)!;
    this.ctx.emitChatEvent(session, "chat:message", { message_id: result.message.id,
      role: "assistant", content: result.message.body, task_id: taskId, created_at: result.message.createdAt },
      { actorType: "agent", actorId: this.ctx.tasks().getTask(taskId)!.agentId });
    return result;
  }

  /**
   * Join one Feishu event to the canonical browser Chat/Task execution path.
   * The event id is the idempotency key; an active Task receives a steer,
   * otherwise a new Task resumes the Chat Session's promoted provider lineage.
   */
  submitMessage(
    workspaceId: string,
    runtimeId: string,
    input: SubmitFeishuBotMessageInput,
  ): SubmitFeishuBotMessageResult {
    const config = this.getConfig(workspaceId);
    if (!config || !config.enabled) {
      throw new FeishuBotConfigError("feishu bot is not running", 409, "bot_not_running");
    }
    if (config.runtimeId !== runtimeId) {
      throw new FeishuBotConfigError("runtime does not host this feishu bot", 403, "runtime_not_selected");
    }
    if (config.revision !== input.revision) {
      throw new FeishuBotConfigError("feishu bot assignment is stale", 409, "stale_revision");
    }
    const externalSessionKey = requiredBoundedString(input.externalSessionKey, "external_session_key", 1_024);
    const externalMessageId = requiredBoundedString(input.externalMessageId, "external_message_id", 512);
    const text = requiredBoundedString(input.text, "text", 200_000);
    const chatId = cleanOptionalString(input.chatId);
    const chatType = resolveFeishuBotChatType(input, externalSessionKey);
    const threadId = cleanOptionalString(input.threadId);
    // Ordinary private messages stay in the main chat, even when an older
    // daemon unconditionally supplies the incoming message as a reply target.
    const replyToMessageId = chatType === "p2p" && !threadId
      ? null : cleanOptionalString(input.replyToMessageId) ?? externalMessageId;
    const routeAgent = this.resolveRouteAgent(workspaceId, chatType, chatId)!;
    const workspace = this.ctx.workspaces().getWorkspace(workspaceId);
    const topicConfig = workspace ? readWorkspaceIssueTopics(workspace.settings) : null;
    let enqueuedTask: MultiremiTask | null = null;

    const result = this.ctx.db.transaction((): SubmitFeishuBotMessageResult => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const sender = this.resolveSender(workspaceId, config.appId, input, config.senderAccessPolicy);
      let binding = this.ctx.db.query(
        `SELECT * FROM multiremi_feishu_bot_chat_bindings
          WHERE workspace_id = ? AND app_id = ? AND agent_id = ? AND external_session_key = ?`,
      ).get(workspaceId, config.appId, routeAgent.agentId, externalSessionKey) as Row | null;
      const autoCreateGroupIssue = sender.allowed
        && !this.ctx.agents().getAgent(routeAgent.agentId)?.issueCreationRequiresProposal
        && chatType === "group"
        && Boolean(chatId)
        && topicConfig?.enabled === true
        && topicConfig.chatId === chatId;
      const createGroupIssue = () => this.ctx.issues().createIssue({
        title: issueTitleFromFeishuMessage(text),
        description: text,
        status: "in_progress",
        workspaceId,
        projectId: topicConfig?.projectIds?.length === 1 ? topicConfig.projectIds[0] : null,
        assigneeType: "agent",
        assigneeId: routeAgent.agentId,
        createdBy: sender.actorId,
        contextRefs: [{
          type: "feishu_bot_message",
          message_id: externalMessageId,
          chat_id: chatId,
          thread_id: cleanOptionalString(input.threadId) ?? externalMessageId,
        }],
      });
      const duplicate = this.ctx.db.query(
        `SELECT d.task_id, b.chat_session_id, b.agent_id, a.name AS agent_name, t.status
           FROM multiremi_feishu_bot_deliveries d
           JOIN multiremi_feishu_bot_chat_bindings b ON b.id = d.binding_id
           LEFT JOIN multiremi_agents a ON a.id = b.agent_id
           JOIN multiremi_tasks t ON t.id = d.task_id
          WHERE d.workspace_id = ? AND d.external_message_id = ?`,
      ).get(workspaceId, externalMessageId) as Row | null;
      if (duplicate) {
        return {
          chatSessionId: String(duplicate.chat_session_id),
          taskId: String(duplicate.task_id),
          agentId: String(duplicate.agent_id),
          agentName: String(duplicate.agent_name ?? duplicate.agent_id),
          status: String(duplicate.status) as SubmitFeishuBotMessageResult["status"],
          duplicate: true,
          steered: false,
          senderAllowed: sender.allowed,
        };
      }

      const attachmentIds = [...new Set(input.attachmentIds ?? [])];
      if (attachmentIds.length > 10) throw new Error("at most 10 attachments are allowed per message");
      for (const attachmentId of attachmentIds) {
        const upload = this.ctx.db.query(`SELECT a.id FROM multiremi_feishu_bot_inbound_attachments u
          JOIN multiremi_attachments a ON a.id = u.attachment_id
          WHERE u.attachment_id = ? AND u.workspace_id = ? AND u.runtime_id = ? AND u.app_id = ?
            AND u.revision = ? AND u.external_session_key = ? AND u.external_message_id = ?
            AND a.chat_message_id IS NULL AND a.chat_session_id IS NULL`)
          .get(attachmentId, workspaceId, runtimeId, config.appId, input.revision, externalSessionKey, externalMessageId);
        if (!upload) throw new FeishuBotConfigError("attachment does not belong to this inbound message", 403, "invalid_attachment");
      }

      if (!binding) {
        const issue = autoCreateGroupIssue ? createGroupIssue() : null;
        const chat = this.ctx.chat().createChatSessionWithinTransaction({
          workspaceId,
          agentId: routeAgent.agentId,
          creatorId: sender.actorId,
          title: issue ? `${issue.key}: ${issue.title}` : "Feishu conversation",
        });
        const bindingId = createId("fcb");
        const now = nowIso();
        this.assertChatHasNoBinding(chat.id, bindingId);
        this.ctx.db.run(
          `INSERT INTO multiremi_feishu_bot_chat_bindings (
             id, workspace_id, app_id, agent_id, external_session_key,
             chat_session_id, issue_id, chat_id, thread_id, reply_to_message_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bindingId,
          workspaceId,
          config.appId,
          routeAgent.agentId,
          externalSessionKey,
          chat.id,
          issue?.id ?? null,
          chatId,
          threadId,
          replyToMessageId,
          now,
          now,
        );
        binding = { id: bindingId, chat_session_id: chat.id, issue_id: issue?.id ?? null };
        if (issue) this.ensureDefaultAgentIssueUpdatesChannel(chat);
      } else if (autoCreateGroupIssue) {
        const chatSessionId = String(binding.chat_session_id);
        const chat = this.ctx.chat().getChatSession(chatSessionId);
        if (chat && !binding.issue_id
          && (!chat.latestTaskId || !this.isTaskIssueCreationRestricted(chat.latestTaskId))) {
          const issue = createGroupIssue();
          this.ctx.db.run(
            "UPDATE multiremi_feishu_bot_chat_bindings SET issue_id = ?, updated_at = ? WHERE id = ?",
            [issue.id, nowIso(), String(binding.id)],
          );
          binding.issue_id = issue.id;
          this.ensureDefaultAgentIssueUpdatesChannel(chat);
          this.ctx.chat().updateChatSession(chat.id, {
            title: `${issue.key}: ${issue.title}`,
          });
        }
      }

      this.ctx.db.run(
        `UPDATE multiremi_feishu_bot_chat_bindings
         SET chat_id = COALESCE(?, chat_id),
             thread_id = COALESCE(?, thread_id),
             reply_to_message_id = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          chatId,
          threadId,
          replyToMessageId,
          nowIso(),
          String(binding.id),
        ],
      );

      const chatSessionId = String(binding.chat_session_id);
      const activeTask = this.ctx.chat().getPendingChatTask(chatSessionId);
      let task;
      let steered = false;
      if (activeTask) {
        task = activeTask;
        steered = true;
      } else {
        task = this.ctx.tasks().createTaskWithinTransaction({
          agentId: routeAgent.agentId,
          // The selected Runtime owns the connector transport. Task execution
          // follows the routed Agent and normal Chat/session affinity instead.
          chatSessionId,
          issueId: nullableString(binding.issue_id),
          workspaceId,
          holdsWorkspace: false,
          prompt: text,
          requestingUserName: sender.displayName,
          requestingUserProfileDescription: sender.profileDescription,
        });
        enqueuedTask = task;
      }

      const now = nowIso();
      const messageId = createId("msg");
      this.ctx.chat().appendChatMessageWithinTransaction({
        id: messageId,
        chatSessionId,
        taskId: task.id,
        role: "user",
        body: text,
        createdAt: now,
      });
      for (const attachmentId of attachmentIds) {
        this.ctx.db.run(`UPDATE multiremi_attachments SET chat_session_id = ?, chat_message_id = ?
          WHERE id = ? AND workspace_id = ? AND chat_session_id IS NULL AND chat_message_id IS NULL`,
          [chatSessionId, messageId, attachmentId, workspaceId]);
      }
      if (steered) {
        this.ctx.tasks().createTaskSteerMessage({ taskId: task.id, kind: "steer", content: text,
          authorType: "external", authorId: sender.actorId, sourceChatMessageId: messageId });
      }
      this.ctx.db.run(
        "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
        task.id,
        now,
        chatSessionId,
      );
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_deliveries (
           workspace_id, external_message_id, binding_id, task_id,
           reply_to_message_id, created_at, updated_at, sender_id, sender_recorded
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        workspaceId,
        externalMessageId,
        String(binding.id),
        task.id,
        replyToMessageId,
        now,
        now,
        sender.id,
      );
      if (input.deliveryMode === "native_cot_v1" && chatId && !steered) {
        // Use the same leased queue as proactive replies. A lost inbound WS
        // consumer must not strand a running Task's result or question card.
        const openId = isFeishuOpenId(input.senderOpenId) ? input.senderOpenId : null;
        this.ctx.db.run(
          `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
             id, workspace_id, binding_id, task_id, chat_id, thread_id,
             reply_to_message_id, body, status, available_at, created_at, updated_at,
             mention_snapshot, interaction_open_id, presentation_checkpoint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'pending', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO NOTHING`,
          [createId("fbo"), workspaceId, String(binding.id), task.id, chatId,
            threadId, replyToMessageId,
            now, now, now, toJson(chatType === "group" && openId
              ? { mode: "person", openId, resolvedOpenId: openId } : { mode: "none", resolvedOpenId: null }),
            openId, toJson({ version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: {} })],
        );
      }
      return {
        chatSessionId,
        taskId: task.id,
        agentId: routeAgent.agentId,
        agentName: routeAgent.agentName,
        status: task.status,
        duplicate: false,
        steered,
        ...(input.deliveryMode === "native_cot_v1" && chatId ? { deliveryQueued: true } : {}),
        senderAllowed: sender.allowed,
      };
    })();
    if (enqueuedTask) this.ctx.notifyTaskEnqueued(enqueuedTask);
    return result;
  }

  // Both callers create a fresh Chat in the same transaction and hold the
  // workspace lifecycle lock. Check globally: a corrupt cross-workspace row
  // must not make an already occupied Chat look available.
  private assertChatHasNoBinding(chatSessionId: string, bindingId: string): void {
    const existing = this.ctx.db.query(`SELECT id FROM multiremi_feishu_bot_chat_bindings
      WHERE chat_session_id = ? ORDER BY id LIMIT 1`).get(chatSessionId) as Row | null;
    if (existing) {
      throw new FeishuBotConfigError(
        `Cannot create binding ${bindingId}: Chat ${chatSessionId} already has binding ${String(existing.id)}`,
        409,
        "chat_binding_conflict",
      );
    }
  }

  getIssueIdForChatSession(chatSessionId: string): string | null {
    const row = this.ctx.db.query(
      `SELECT issue_id FROM multiremi_feishu_bot_chat_bindings
       WHERE chat_session_id = ? AND issue_id IS NOT NULL
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(chatSessionId) as Row | null;
    return nullableString(row?.issue_id);
  }

  /**
   * A binding row exists only for Chats the connector created as Feishu
   * transport, whether or not they ever grew an Issue. Both kinds live in
   * Feishu, not in the user's private conversation list.
   */
  isTransportChatSession(chatSessionId: string): boolean {
    return this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_feishu_bot_chat_bindings
       WHERE chat_session_id = ? LIMIT 1`,
    ).get(chatSessionId) != null;
  }

  /** The selected transport may stream and relay answers for its bound Chats
   * even when execution is queued or assigned to a different machine. */
  canDaemonAccessTask(workspaceId: string, daemonId: string, taskId: string): boolean {
    return this.ctx.db.query(`SELECT 1 AS present
      FROM multiremi_feishu_bot_configs c
      JOIN multiremi_runtimes r ON r.id = c.runtime_id AND r.workspace_id = c.workspace_id
      JOIN multiremi_feishu_bot_chat_bindings b ON b.workspace_id = c.workspace_id AND b.app_id = c.app_id
      JOIN multiremi_tasks t ON t.chat_session_id = b.chat_session_id
        AND t.workspace_id = b.workspace_id AND t.agent_id = b.agent_id
      WHERE c.workspace_id = ? AND c.enabled = 1 AND r.daemon_id = ? AND t.id = ? LIMIT 1`)
      .get(workspaceId, daemonId, taskId) != null;
  }

  private ensureDefaultAgentIssueUpdatesChannel(session: MultiremiChatSession): void {
    const member = session.creatorId
      ? this.ctx.workspaces().getWorkspaceMember(session.creatorId)
        ?? this.ctx.workspaces().findWorkspaceMemberForUser(session.creatorId, session.workspaceId)
      : null;
    this.ctx.notificationChannels().upsertAgentChatNotificationChannel({
      workspaceId: session.workspaceId,
      chatSessionId: session.id,
      name: `${session.title} Issue updates`,
      enabled: true,
      memberId: member && member.workspaceId === session.workspaceId && !member.archivedAt ? member.id : null,
      createdBy: session.creatorId,
    });
  }

  getChatConversationKind(chatSessionId: string): "p2p" | "group" | null {
    const row = this.ctx.db.query(
      `SELECT external_session_key, thread_id
       FROM multiremi_feishu_bot_chat_bindings
       WHERE chat_session_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    ).get(chatSessionId) as Row | null;
    if (!row) return null;
    return row.thread_id != null || String(row.external_session_key ?? "").includes(":thread:")
      ? "group"
      : "p2p";
  }

  prepareIssueTopicWithinTransaction(issue: MultiremiIssue): boolean {
    const workspace = this.ctx.workspaces().getWorkspace(issue.workspaceId);
    if (!workspace) return false;
    const topicConfig = readWorkspaceIssueTopics(workspace.settings);
    if (!topicConfig.enabled || !topicConfig.chatId) return false;
    if (topicConfig.projectIds && (!issue.projectId || !topicConfig.projectIds.includes(issue.projectId))) {
      return false;
    }
    const bot = this.statusSnapshot(issue.workspaceId);
    if (bot.status !== "online" || !bot.config) return false;
    const routeAgent = this.resolveRouteAgent(issue.workspaceId, "group", topicConfig.chatId)!;

    return this.ctx.db.transaction(() => {
      const existing = this.ctx.db.query(
        `SELECT 1 AS present
         FROM multiremi_feishu_bot_chat_bindings b
         JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
         WHERE b.workspace_id = ? AND b.issue_id = ?
         LIMIT 1`,
      ).get(issue.workspaceId, issue.id) as Row | null;
      if (existing) return false;

      const chat = this.ctx.chat().createChatSessionWithinTransaction({
        id: `chat_issue_topic_${issue.id}`,
        workspaceId: issue.workspaceId,
        agentId: routeAgent.agentId,
        creatorId: issue.createdBy ?? "local",
        title: `${issue.key}: ${issue.title}`,
      });
      const bindingId = `fcb_issue_topic_${issue.id}`;
      const deliveryId = `fbo_issue_topic_${issue.id}`;
      const now = nowIso();
      this.assertChatHasNoBinding(chat.id, bindingId);
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_chat_bindings (
           id, workspace_id, app_id, agent_id, external_session_key,
           chat_session_id, issue_id, chat_id, thread_id, reply_to_message_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          bindingId,
          issue.workspaceId,
          bot.config!.appId,
          routeAgent.agentId,
          `pending:${issue.id}`,
          chat.id,
          issue.id,
          topicConfig.chatId,
          now,
          now,
        ],
      );
      this.ensureDefaultAgentIssueUpdatesChannel(chat);
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
           id, workspace_id, binding_id, task_id, chat_id, thread_id,
           reply_to_message_id, body, status, available_at, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, 'pending', ?, ?, ?)`,
        [
          deliveryId,
          issue.workspaceId,
          bindingId,
          topicConfig.chatId,
          issueTopicBody(issue),
          now,
          now,
          now,
        ],
      );
      return true;
    })();
  }

  /**
   * Wake the Agent bound to an Issue's Feishu topic when the Issue task asks a
   * human for input. The wake Task is deliberately workspace-free: it only
   * lets the topic Agent decide how to present the request. The original Task
   * and human-request id stay in the prompt so any follow-up can be correlated
   * without creating a second Issue execution.
   */
  prepareHumanRequestPush(request: MultiremiTaskHumanRequest): MultiremiTask | null {
    const sourceTask = this.ctx.tasks().getTask(request.taskId);
    if (!sourceTask?.issueId) return null;
    const issue = this.ctx.issues().getIssue(sourceTask.issueId);
    if (!issue) return null;
    const workspace = this.ctx.workspaces().getWorkspace(issue.workspaceId);
    if (!workspace) return null;
    const topics = readWorkspaceIssueTopics(workspace.settings);
    if (!topics.enabled || !topics.chatId) return null;
    const bot = this.statusSnapshot(issue.workspaceId);
    if (bot.status !== "online" || !bot.config) return null;

    return this.ctx.db.transaction(() => {
      const binding = this.ctx.db.query(
        `SELECT b.* FROM multiremi_feishu_bot_chat_bindings b
         JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
         WHERE b.workspace_id = ? AND b.issue_id = ? AND c.status = 'active'
           AND b.chat_id = ? AND b.reply_to_message_id IS NOT NULL
         ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
         LIMIT 1`,
      ).get(issue.workspaceId, issue.id, topics.chatId) as Row | null;
      if (!binding) return null;
      const bindingId = String(binding.id);
      const existing = this.ctx.db.query(
        `SELECT wake_task_id FROM multiremi_feishu_bot_human_request_pushes
         WHERE binding_id = ? AND request_id = ? LIMIT 1`,
      ).get(bindingId, request.id) as Row | null;
      if (existing) return this.ctx.tasks().getTask(String(existing.wake_task_id));

      const agentId = String(binding.agent_id ?? "");
      if (!agentId) return null;
      const payload = request.payload ?? {};
      const wakeTask = this.ctx.tasks().createTaskWithinTransaction({
        agentId,
        chatSessionId: String(binding.chat_session_id),
        issueId: issue.id,
        workspaceId: issue.workspaceId,
        holdsWorkspace: false,
        prompt: humanRequestPushPrompt(issue, sourceTask, request),
        requestingUserName: "Multiremi",
        requestingUserProfileDescription: "System notification for a pending Issue human request.",
      });
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_human_request_pushes (
           id, workspace_id, binding_id, issue_id, source_task_id,
           request_id, wake_task_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId("fhrp"),
          issue.workspaceId,
          bindingId,
          issue.id,
          sourceTask.id,
          request.id,
          wakeTask.id,
          now,
          now,
        ],
      );
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
           id, workspace_id, binding_id, task_id, chat_id, thread_id,
           reply_to_message_id, body, status, available_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          createId("fbo"),
          issue.workspaceId,
          bindingId,
          wakeTask.id,
          topics.chatId,
          cleanOptionalString(binding.thread_id),
          cleanOptionalString(binding.reply_to_message_id),
          humanRequestPushBody(issue, sourceTask, request, payload),
          now,
          now,
          now,
        ],
      );
      return wakeTask;
    })();
  }

  /** Caller owns the terminal-task transaction. */
  prepareIssueRoundPushesWithinTransaction(input: {
    issue: MultiremiIssue;
    leaderTask: MultiremiTask;
  }): MultiremiTask[] {
    const config = this.getConfig(input.issue.workspaceId);
    if (!config?.enabled) return [];
    const rows = this.ctx.db.query(
      `SELECT b.* FROM multiremi_feishu_bot_chat_bindings b
       JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
       WHERE b.workspace_id = ? AND b.app_id = ?
         AND b.issue_id = ? AND c.status = 'active'
         AND b.chat_id IS NOT NULL AND b.reply_to_message_id IS NOT NULL
       ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC`,
    ).all(input.issue.workspaceId, config.appId, input.issue.id) as Row[];
    const enqueued: MultiremiTask[] = [];
    const seenChats = new Set<string>();
    for (const binding of rows) {
      const bindingChatId = cleanOptionalString(binding.chat_id);
      const chatSessionId = String(binding.chat_session_id);
      const conversationKey = bindingChatId ? `chat:${bindingChatId}` : `session:${chatSessionId}`;
      if (seenChats.has(conversationKey)) continue;
      seenChats.add(conversationKey);
      if (!this.ctx.notificationChannels().getAgentChatNotificationChannel(chatSessionId)?.enabled) continue;
      const bindingId = String(binding.id);
      const alreadyPrepared = this.ctx.db.query(
        `SELECT 1 AS present FROM multiremi_feishu_bot_round_pushes
         WHERE binding_id = ? AND leader_task_id = ?`,
      ).get(bindingId, input.leaderTask.id) as Row | null;
      if (alreadyPrepared) continue;

      let wakeTask = this.ctx.chat().getPendingChatTask(chatSessionId);
      // Binding changes cannot turn an existing private/different-Issue user
      // turn into an Issue notification. Only coalesce into the same transport.
      if (wakeTask && (wakeTask.issueId !== input.issue.id
        || wakeTask.workspaceId !== input.issue.workspaceId
        || wakeTask.agentId !== binding.agent_id)) wakeTask = null;
      let deliveryMode: "inbound" | "proactive";
      if (wakeTask) {
        const proactive = this.ctx.db.query(
          `SELECT 1 AS present FROM multiremi_feishu_bot_round_pushes
           WHERE wake_task_id = ? AND delivery_mode = 'proactive' LIMIT 1`,
        ).get(wakeTask.id) as Row | null;
        deliveryMode = proactive ? "proactive" : "inbound";
        const pending = wakeTask.status === "queued"
          ? { messages: [], omittedCount: 0 }
          : this.ctx.chat().preparePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId, wakeTask.id);
        this.ctx.tasks().createTaskSteerMessage({
          taskId: wakeTask.id,
          kind: "steer",
          content: roundPushPrompt(input.issue, pending.messages.map((message) => message.body), pending.omittedCount),
          authorType: "system",
          authorId: null,
        });
      } else {
        deliveryMode = "proactive";
        wakeTask = this.ctx.tasks().createTaskWithinTransaction({
          agentId: String(binding.agent_id),
          chatSessionId,
          issueId: input.issue.id,
          workspaceId: input.issue.workspaceId,
          holdsWorkspace: false,
          prompt: roundPushPrompt(input.issue),
          requestingUserName: "Multiremi",
          requestingUserProfileDescription: "System-triggered summary for a completed Issue work round.",
        });
        enqueued.push(wakeTask);
      }
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_round_pushes (
           id, workspace_id, binding_id, issue_id, leader_task_id,
           wake_task_id, delivery_mode, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(binding_id, leader_task_id) DO NOTHING`,
        [
          createId("frp"),
          input.issue.workspaceId,
          bindingId,
          input.issue.id,
          input.leaderTask.id,
          wakeTask.id,
          deliveryMode,
          now,
          now,
        ],
      );
      if (deliveryMode === "proactive") this.upsertRoundPushDeliveryWithinTransaction(wakeTask, "");
    }
    return enqueued;
  }

  /** Caller owns the failed-task transaction. */
  retargetRoundPushTaskWithinTransaction(fromTaskId: string, toTaskId: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_round_pushes
       SET wake_task_id = ?, delivery_mode = 'proactive', updated_at = ?
       WHERE wake_task_id = ?`,
      [toTaskId, nowIso(), fromTaskId],
    );
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_human_request_pushes
       SET wake_task_id = ?, updated_at = ? WHERE wake_task_id = ?`,
      [toTaskId, nowIso(), fromTaskId],
    );
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_outbound_deliveries
       SET task_id = ?, body = '', status = 'pending', claim_token = NULL, leased_until = NULL,
           external_message_id = CASE WHEN presentation_checkpoint IS NULL THEN external_message_id ELSE NULL END,
           presentation_checkpoint = NULL, attempt_count = 0, last_error = NULL,
           available_at = ?, updated_at = ? WHERE task_id = ?`,
      [toTaskId, nowIso(), nowIso(), fromTaskId],
    );
    const retry = this.ctx.tasks().getTask(toTaskId);
    if (retry) this.upsertRoundPushDeliveryWithinTransaction(retry, "");
  }

  /** Enqueue at task creation; completion fills in the legacy final-body fallback. */
  upsertRoundPushDeliveryWithinTransaction(task: MultiremiTask, body: string): void {
    const row = this.ctx.db.query(
      `SELECT b.* FROM multiremi_feishu_bot_round_pushes r
       JOIN multiremi_feishu_bot_chat_bindings b ON b.id = r.binding_id
       WHERE r.wake_task_id = ? AND r.delivery_mode = 'proactive'
         AND b.workspace_id = r.workspace_id AND b.issue_id = r.issue_id
       ORDER BY r.created_at ASC, r.id ASC LIMIT 1`,
    ).get(task.id) as Row | null;
    if (!row) return;
    const chatId = cleanOptionalString(row.chat_id);
    const replyToMessageId = cleanOptionalString(row.reply_to_message_id);
    if (!chatId || !replyToMessageId) return;
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      [
        createId("fbo"),
        task.workspaceId,
        String(row.id),
        task.id,
        chatId,
        cleanOptionalString(row.thread_id),
        replyToMessageId,
        body,
        now,
        now,
        now,
      ],
    );
  }

  claimOutbound(
    workspaceId: string,
    runtimeId: string,
    nowInput: string | Date = new Date(),
    supportsTaskStream = false,
    supportsNativeCot = false,
    supportsAttachments = false,
  ): MultiremiFeishuBotOutboundDelivery | null {
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    const config = this.getConfig(workspaceId);
    const runtimeStatus = this.getRuntimeStatus(workspaceId, runtimeId);
    if (
      !config?.enabled
      || config.runtimeId !== runtimeId
      || runtimeStatus?.state !== "online"
      || runtimeStatus.appliedRevision !== config.revision
    ) return null;
    return this.ctx.db.transaction(() => {
      const nowIsoValue = now.toISOString();
      const row = this.ctx.db.query(
        `SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o
         JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id
         WHERE o.workspace_id = ? AND b.app_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_feishu_bot_round_pushes r
             WHERE r.wake_task_id = o.task_id AND r.binding_id = b.id
               AND r.workspace_id = o.workspace_id AND r.delivery_mode = 'proactive'
               AND (b.issue_id IS NULL OR b.issue_id <> r.issue_id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_feishu_bot_human_request_pushes h
             WHERE h.wake_task_id = o.task_id AND h.binding_id = b.id
               AND h.workspace_id = o.workspace_id
               AND (b.issue_id IS NULL OR b.issue_id <> h.issue_id)
           )
           AND (o.task_id IS NULL OR ? = 1 OR o.body <> '')
           AND (? = 1 OR o.presentation_checkpoint IS NULL)
           AND (? = 1 OR o.attachments IS NULL)
           AND (o.previous_delivery_id IS NULL OR EXISTS (
             SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries previous
             WHERE previous.id = o.previous_delivery_id AND previous.workspace_id = o.workspace_id
               AND previous.status = 'sent'))
           AND ((o.status = 'pending' AND o.available_at <= ?)
             OR (o.status = 'sending' AND o.leased_until IS NOT NULL AND o.leased_until <= ?))
         ORDER BY o.created_at ASC, o.id ASC LIMIT 1`,
      ).get(workspaceId, config.appId, supportsTaskStream ? 1 : 0, supportsNativeCot ? 1 : 0, supportsAttachments ? 1 : 0, nowIsoValue, nowIsoValue) as Row | null;
      if (!row) return null;
      let mention = parseOutboundMention(parseJson(row.mention_snapshot, null));
      if (supportsTaskStream && row.task_id && !row.mention_snapshot) {
        const topics = readWorkspaceIssueTopics(this.ctx.workspaces().getWorkspace(workspaceId)?.settings ?? {});
        if (topics.enabled && topics.chatId === row.chat_id) {
          mention = {
            mode: topics.notifyMode ?? "group_owner",
            ...(topics.notifyMode === "person" ? { openId: topics.notifyOpenId } : {}),
            // Do not add a surprise mention to a card already sent by an old daemon.
            ...(row.external_message_id ? { resolvedOpenId: null } : {}),
          };
        }
      }
      const claimToken = createId("foc");
      const presentation = parseFeishuPresentation(parseJson(row.presentation_checkpoint, null))
        ?? (supportsNativeCot && row.task_id && !row.external_message_id
          ? { version: "native_cot_v1" as const, startedAt: now.getTime(), throughSeq: 0, interactions: {} } : null);
      const leasedUntil = new Date(now.getTime() + (supportsTaskStream ? 120_000 : 30_000)).toISOString();
      const updated = this.ctx.db.run(
        `UPDATE multiremi_feishu_bot_outbound_deliveries
         SET status = 'sending', claim_token = ?, leased_until = ?,
             attempt_count = attempt_count + 1, updated_at = ?,
             mention_snapshot = COALESCE(mention_snapshot, ?), presentation_checkpoint = COALESCE(presentation_checkpoint, ?)
         WHERE id = ?
           AND (previous_delivery_id IS NULL OR EXISTS (
             SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries previous
             WHERE previous.id = multiremi_feishu_bot_outbound_deliveries.previous_delivery_id
               AND previous.workspace_id = multiremi_feishu_bot_outbound_deliveries.workspace_id
               AND previous.status = 'sent'))
           AND ((status = 'pending' AND available_at <= ?)
             OR (status = 'sending' AND leased_until IS NOT NULL AND leased_until <= ?))`,
        [claimToken, leasedUntil, nowIsoValue, mention ? toJson(mention) : null, presentation ? toJson(presentation) : null,
          String(row.id), nowIsoValue, nowIsoValue],
      );
      if (updated.changes !== 1) return null;
      return {
        ...outboundDelivery(row, claimToken),
        ...(supportsTaskStream && row.task_id ? {
          taskId: String(row.task_id),
          receiptMessageIds: this.listTaskReceiptMessageIds(workspaceId, String(row.task_id)),
          resumeMessageId: cleanOptionalString(row.external_message_id),
          ...(mention ? { mention } : {}),
          ...(presentation ? { presentation } : {}),
          ...(row.interaction_open_id ? { interactionOpenId: String(row.interaction_open_id) } : {}),
        } : {}),
      };
    })();
  }

  /** Checkpoint before the first send, under the existing delivery lease. */
  prepareOutboundMention(
    workspaceId: string, runtimeId: string, deliveryId: string, claimToken: string,
    openId: string | null, nowInput: string | Date = new Date(),
  ): { openId: string | null } | null {
    if (openId !== null && !isFeishuOpenId(openId)) throw new FeishuBotConfigError("invalid mention open_id", 400, "invalid_mention");
    const config = this.getConfig(workspaceId);
    if (!config || config.runtimeId !== runtimeId) return null;
    const now = new Date(nowInput).toISOString();
    return this.ctx.db.transaction(() => {
      const row = this.ctx.db.query(
        `SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o
         JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id
         WHERE o.id = ? AND o.workspace_id = ? AND o.status = 'sending'
           AND o.claim_token = ? AND o.leased_until > ? AND o.task_id IS NOT NULL
           AND b.app_id = ? AND b.agent_id = ?`,
      ).get(deliveryId, workspaceId, claimToken, now, config.appId, config.agentId) as Row | null;
      if (!row) return null;
      const mention = parseOutboundMention(parseJson(row.mention_snapshot, null));
      if (!mention) return null;
      if (mention.resolvedOpenId !== undefined) return { openId: mention.resolvedOpenId };
      if (mention.mode === "none" && openId !== null) return null;
      if (mention.mode === "person" && openId !== null && openId !== mention.openId) return null;
      const resolvedOpenId = row.external_message_id ? null : openId;
      const updated = this.ctx.db.run(
        `UPDATE multiremi_feishu_bot_outbound_deliveries SET mention_snapshot = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?
           AND leased_until > ? AND mention_snapshot = ?`,
        [toJson({ ...mention, resolvedOpenId }), now, deliveryId, workspaceId, claimToken, now, row.mention_snapshot],
      );
      if (updated.changes !== 1) return null;
      return { openId: resolvedOpenId };
    })();
  }

  getOutboundAttachment(
    workspaceId: string,
    runtimeId: string,
    deliveryId: string,
    claimToken: string,
    attachmentId: string,
  ): MultiremiAttachment | null {
    const config = this.getConfig(workspaceId);
    if (!config?.enabled || config.runtimeId !== runtimeId) return null;
    const delivery = this.ctx.db.query(
      `SELECT o.body, o.attachments FROM multiremi_feishu_bot_outbound_deliveries o
       JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id
       WHERE o.id = ? AND o.workspace_id = ? AND o.status = 'sending' AND o.claim_token = ?
         AND o.leased_until > ? AND b.app_id = ?`,
    ).get(deliveryId, workspaceId, claimToken, nowIso(), config.appId) as Row | null;
    if (!delivery) return null;
    const attachment = this.ctx.issues().getAttachment(attachmentId);
    if (!attachment || attachment.workspaceId !== workspaceId) return null;
    const explicit = parseJson<MultiremiFeishuBotOutboundDelivery["attachments"]>(delivery.attachments, []) ?? [];
    if (explicit.some(entry => entry.id === attachmentId)) return attachment;
    const referenced = findMarkdownImages(String(delivery.body ?? ""))
      .some((match) => match.source.kind === "attachment" && match.source.attachmentId === attachmentId);
    return referenced && attachment.contentType.toLowerCase().startsWith("image/")
      && attachment.sizeBytes <= FEISHU_IMAGE_MAX_BYTES ? attachment : null;
  }

  reportOutbound(
    workspaceId: string,
    runtimeId: string,
    deliveryId: string,
    input: {
      claimToken: string;
      status: "sent" | "failed" | "streaming";
      externalMessageId?: string | null;
      error?: string | null;
      presentation?: FeishuPresentationCheckpoint;
      retryable?: boolean;
    },
    nowInput: string | Date = new Date(),
  ): boolean {
    const config = this.getConfig(workspaceId);
    if (!config || config.runtimeId !== runtimeId) return false;
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    if (input.status === "streaming") {
      if (input.presentation) {
        if (!parseFeishuPresentation(input.presentation)) return false;
        const previous = this.ctx.db.query(
          `SELECT presentation_checkpoint FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ? AND workspace_id = ?`,
        ).get(deliveryId, workspaceId) as Row | null;
        const saved = parseFeishuPresentation(parseJson(previous?.presentation_checkpoint, null));
        if (!saved || !advancesFeishuPresentation(saved, input.presentation)) return false;
      }
      return this.ctx.db.run(
        `UPDATE multiremi_feishu_bot_outbound_deliveries
         SET external_message_id = COALESCE(?, external_message_id), leased_until = ?, updated_at = ?,
             presentation_checkpoint = COALESCE(?, presentation_checkpoint)
         WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?
           AND leased_until > ? AND (task_id IS NOT NULL OR attachments IS NOT NULL)
           AND binding_id IN (SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE app_id = ?)`,
        [cleanOptionalString(input.externalMessageId), new Date(now.getTime() + 120_000).toISOString(),
          now.toISOString(), input.presentation ? toJson(input.presentation) : null,
          deliveryId, workspaceId, input.claimToken, now.toISOString(), config.appId],
      ).changes === 1;
    }
    if (input.status === "sent") {
      return this.ctx.db.transaction(() => {
        const row = this.ctx.db.query(
          `SELECT binding_id, chat_id, reply_to_message_id, task_id, attachments
           FROM multiremi_feishu_bot_outbound_deliveries
           WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?`,
        ).get(deliveryId, workspaceId, input.claimToken) as Row | null;
        if (!row) return false;
        const externalMessageId = cleanOptionalString(input.externalMessageId);
        // Only a standalone Issue topic seed establishes a new conversation
        // root. A Task result sent to a private chat must preserve its binding.
        const seedsTopic = !row.task_id && !row.attachments && !cleanOptionalString(row.reply_to_message_id);
        if (seedsTopic && !externalMessageId) return false;
        const sentAt = now.toISOString();
        const updated = this.ctx.db.run(
          `UPDATE multiremi_feishu_bot_outbound_deliveries
           SET status = 'sent', external_message_id = ?, sent_at = ?,
               claim_token = NULL, leased_until = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?`,
          [externalMessageId, sentAt, sentAt, deliveryId, workspaceId, input.claimToken],
        );
        if (updated.changes !== 1) return false;
        if (seedsTopic) {
          this.ctx.db.run(
            `UPDATE multiremi_feishu_bot_chat_bindings
             SET thread_id = ?, reply_to_message_id = ?, external_session_key = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ? AND thread_id IS NULL`,
            [
              externalMessageId,
              externalMessageId,
              `${String(row.chat_id)}:thread:${externalMessageId}`,
              sentAt,
              String(row.binding_id),
              workspaceId,
            ],
          );
        }
        return true;
      })();
    }
    return this.ctx.db.transaction(() => {
      const row = this.ctx.db.query(
        `SELECT attempt_count FROM multiremi_feishu_bot_outbound_deliveries
         WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?`,
      ).get(deliveryId, workspaceId, input.claimToken) as Row | null;
      if (!row) return false;
      const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(6, Math.max(0, Number(row.attempt_count) - 1)));
      const terminal = input.retryable === false || Number(row.attempt_count) >= 6;
      const error = cleanOptionalString(input.error)?.slice(0, 2_000) ?? "Feishu send failed";
      const updated = this.ctx.db.run(
        `UPDATE multiremi_feishu_bot_outbound_deliveries
         SET status = ?, claim_token = NULL, leased_until = NULL,
             available_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?`,
        [
          terminal ? "failed" : "pending",
          new Date(now.getTime() + delayMs).toISOString(),
          error,
          now.toISOString(),
          deliveryId,
          workspaceId,
          input.claimToken,
        ],
      );
      if (updated.changes !== 1) return false;
      if (terminal) {
        // A failed caption/attachment must not let the rest of that batch
        // overtake it, nor leave descendants pending forever without a reason.
        this.ctx.db.run(
          `WITH RECURSIVE successors AS (
             SELECT id FROM multiremi_feishu_bot_outbound_deliveries
             WHERE previous_delivery_id = ? AND workspace_id = ?
             UNION
             SELECT o.id FROM multiremi_feishu_bot_outbound_deliveries o
             JOIN successors previous ON o.previous_delivery_id = previous.id
             WHERE o.workspace_id = ?
           )
           UPDATE multiremi_feishu_bot_outbound_deliveries
           SET status = 'failed', last_error = ?, updated_at = ?
           WHERE id IN (SELECT id FROM successors) AND status = 'pending'`,
          [deliveryId, workspaceId, workspaceId,
            `Not sent because earlier batch delivery ${deliveryId} failed: ${error}`.slice(0, 2_000), now.toISOString()],
        );
      }
      return true;
    })();
  }

  private resolveSender(
    workspaceId: string,
    appId: string,
    input: SubmitFeishuBotMessageInput,
    accessPolicy: MultiremiFeishuBotConfig["senderAccessPolicy"],
  ): ResolvedFeishuSender {
    const unionId = optionalBoundedString(input.senderUnionId, "sender_union_id", 512);
    const openId = optionalBoundedString(input.senderOpenId, "sender_open_id", 512);
    const userId = optionalBoundedString(input.senderUserId, "sender_user_id", 512);
    const tenantKey = optionalBoundedString(input.senderTenantKey, "sender_tenant_key", 512);
    const eventName = optionalBoundedString(input.senderName, "sender_name", 512);
    let account: FeishuBotSender | null = null;
    // open_id is always supplied by the real connector. Its app scope makes
    // the same account stable even when a later event adds or omits union_id.
    // Sender records are for attribution; only opt-in allowlists gate access.
    if (openId) {
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_senders
           (id, workspace_id, app_id, open_id, union_id, display_name, allowed, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(workspace_id, app_id, open_id) DO UPDATE SET
           union_id = COALESCE(excluded.union_id, multiremi_feishu_bot_senders.union_id),
           display_name = COALESCE(?, multiremi_feishu_bot_senders.display_name),
           last_seen_at = excluded.last_seen_at`,
        [createId("fbs"), workspaceId, appId, openId, unionId, eventName ?? "Feishu user", now, now, eventName],
      );
      account = toSender(this.ctx.db.query(
        "SELECT * FROM multiremi_feishu_bot_senders WHERE workspace_id = ? AND app_id = ? AND open_id = ?",
      ).get(workspaceId, appId, openId) as Row);
    }
    const displayName = account?.display_name ?? eventName ?? "Feishu user";
    const actorId = (openId ? `feishu:open:${appId}:${openId}` : null)
      ?? (unionId ? `feishu:union:${unionId}` : null)
      ?? (userId ? `feishu:user:${tenantKey ?? "unknown"}:${userId}` : null)
      ?? `feishu:session:${input.externalSessionKey}`;
    const profileDescription = accessPolicy === "agent" ? [
      "Source: Feishu personal bot",
      "Anyone who can message this bot may use the responding Agent's enabled capabilities. No separate sender approval or workspace membership is required.",
      "The Agent's own permissions and approval requirements still apply. The API checks the bot's current access policy; do not infer a pending approval from earlier conversation history.",
    ].join("\n") : [
      "Source: Feishu personal bot",
      "The space owner manages account access in Settings > Integrations > Feishu account allowlist.",
      "Approval can change during this Chat. Retry the requested action after the owner updates the allowlist; the API checks current access.",
    ].join("\n");
    return { id: account?.id ?? null, allowed: accessPolicy === "agent" || (account?.allowed ?? false), displayName, actorId, profileDescription };
  }

  resetSession(workspaceId: string, runtimeId: string, revision: number, externalSessionKey: string): boolean {
    const config = this.getConfig(workspaceId);
    if (!config || config.runtimeId !== runtimeId || config.revision !== revision) return false;
    const key = requiredBoundedString(externalSessionKey, "external_session_key", 1_024);
    const result = this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_chat_bindings
          SET external_session_key = external_session_key || ':closed:' || id,
              updated_at = ?
        WHERE workspace_id = ? AND app_id = ? AND external_session_key = ?`,
      nowIso(),
      workspaceId,
      config.appId,
      key,
    );
    return result.changes > 0;
  }

  cancelSessionTask(workspaceId: string, runtimeId: string, revision: number, externalSessionKey: string): string | null {
    const config = this.getConfig(workspaceId);
    if (!config || config.runtimeId !== runtimeId || config.revision !== revision) return null;
    const key = requiredBoundedString(externalSessionKey, "external_session_key", 1_024);
    const bindings = this.ctx.db.query(
      `SELECT chat_session_id FROM multiremi_feishu_bot_chat_bindings
        WHERE workspace_id = ? AND app_id = ? AND external_session_key = ?
        ORDER BY updated_at DESC, id DESC`,
    ).all(workspaceId, config.appId, key) as Row[];
    const seenSessions = new Set<string>();
    let latestCancelledTaskId: string | null = null;
    for (const binding of bindings) {
      const chatSessionId = String(binding.chat_session_id);
      if (seenSessions.has(chatSessionId)) continue;
      seenSessions.add(chatSessionId);
      const task = this.ctx.chat().getPendingChatTask(chatSessionId);
      if (!task) continue;
      this.ctx.tasks().cancelTask(task.id);
      latestCancelledTaskId ??= task.id;
    }
    return latestCancelledTaskId;
  }

  inspectSession(
    workspaceId: string,
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
  ): FeishuBotSessionSnapshot {
    const config = this.getConfig(workspaceId);
    if (!config || config.runtimeId !== runtimeId || config.revision !== revision) {
      return { chatSessionId: null, agentId: null, agentName: null, task: null };
    }
    const key = requiredBoundedString(externalSessionKey, "external_session_key", 1_024);
    const binding = this.ctx.db.query(
      `SELECT b.chat_session_id, b.agent_id, a.name AS agent_name
       FROM multiremi_feishu_bot_chat_bindings b
       LEFT JOIN multiremi_agents a ON a.id = b.agent_id
       WHERE b.workspace_id = ? AND b.app_id = ? AND b.external_session_key = ?
       ORDER BY b.updated_at DESC, b.id DESC LIMIT 1`,
    ).get(workspaceId, config.appId, key) as Row | null;
    if (!binding) return { chatSessionId: null, agentId: null, agentName: null, task: null };

    const chatSessionId = String(binding.chat_session_id);
    const chat = this.ctx.chat().getChatSession(chatSessionId);
    const task = chat?.latestTaskId ? this.ctx.tasks().getTask(chat.latestTaskId) : null;
    return {
      chatSessionId,
      agentId: String(binding.agent_id),
      agentName: String(binding.agent_name ?? binding.agent_id),
      task: task
        ? {
            taskId: task.id,
            status: task.status,
            result: task.result,
            error: task.error,
            sessionId: task.sessionId,
            workDir: task.workDir,
            usage: task.usage,
          }
        : null,
    };
  }

  /**
   * What this Runtime should be doing right now.
   *
   * Non-selected Runtimes are always told to stop. The selected Runtime is told
   * to run only once no other Runtime still claims the connector, which is what
   * makes a Runtime switch a handover rather than a double-run.
   */
  directiveForRuntime(workspaceId: string, runtimeId: string): MultiremiFeishuBotDirective | null {
    const row = this.rawConfigRow(workspaceId);
    if (!row) {
      // No config: a Runtime that still reports a live connector (because the
      // config was just deleted) must be told to stop. One that already
      // reports stopped needs no directive at all.
      const reported = this.getRuntimeStatus(workspaceId, runtimeId);
      if (!reported || reported.state === "stopped") return null;
      return { revision: 0, desired_state: "stopped", config_available: false };
    }
    const revision = Number(row.revision ?? 0);
    if (String(row.runtime_id ?? "") !== runtimeId) {
      return { revision, desired_state: "stopped", config_available: false };
    }
    if (!Number(row.enabled ?? 0)) {
      return { revision, desired_state: "stopped", config_available: false };
    }
    const blockers = this.liveForeignRuntimeIds(workspaceId, runtimeId);
    if (blockers.length > 0) {
      // Hold the new host at `stopped` until the previous one lets go.
      return { revision, desired_state: "stopped", config_available: false };
    }
    const topics = readWorkspaceIssueTopics(this.ctx.workspaces().getWorkspace(workspaceId)?.settings ?? {});
    return { revision, desired_state: "running", config_available: true,
      no_mention_chat_ids: topics.enabled && topics.chatId ? [topics.chatId] : [],
    };
  }

  getRuntimeStatus(workspaceId: string, runtimeId: string): MultiremiFeishuBotRuntimeStatus | null {
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND runtime_id = ?")
      .get(workspaceId, runtimeId) as Row | null;
    return row ? mapRuntimeStatus(row) : null;
  }

  listRuntimeStatuses(workspaceId: string): MultiremiFeishuBotRuntimeStatus[] {
    const rows = this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ?")
      .all(workspaceId) as Row[];
    return rows.map(mapRuntimeStatus);
  }

  reportRuntimeStatus(
    workspaceId: string,
    runtimeId: string,
    input: ReportFeishuBotRuntimeStatusInput,
  ): MultiremiFeishuBotRuntimeStatus {
    const state: FeishuBotRuntimeState = RUNTIME_STATES.has(input.state) ? input.state : "failed";
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_runtime_states (
         workspace_id, runtime_id, applied_revision, state,
         bot_name, bot_open_id, error_code, error_message, reported_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, runtime_id) DO UPDATE SET
         applied_revision = excluded.applied_revision,
         state = excluded.state,
         bot_name = excluded.bot_name,
         bot_open_id = excluded.bot_open_id,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         reported_at = excluded.reported_at`,
      workspaceId,
      runtimeId,
      Number.isSafeInteger(input.appliedRevision) && input.appliedRevision >= 0 ? input.appliedRevision : 0,
      state,
      cleanOptionalString(input.botName),
      cleanOptionalString(input.botOpenId),
      normalizeFeishuBotErrorCode(input.errorCode),
      cleanOptionalString(input.errorMessage),
      now,
    );
    return this.getRuntimeStatus(workspaceId, runtimeId)!;
  }

  recordAudit(
    workspaceId: string,
    action: FeishuBotAuditAction,
    input: { actorType?: string; actorId?: string | null; details?: Record<string, unknown> } = {},
  ): MultiremiFeishuBotAuditEntry {
    const id = createId("fba");
    const createdAt = nowIso();
    const details = input.details ?? {};
    // `created_at` only resolves to the millisecond and the id is random, so
    // back-to-back entries — a stop and the deploy that follows it — cannot be
    // ordered by either. The per-workspace seq is what makes the trail readable.
    const seq = Number(
      (this.ctx.db
        .query("SELECT COALESCE(MAX(seq), 0) AS seq FROM multiremi_feishu_bot_audit WHERE workspace_id = ?")
        .get(workspaceId) as { seq?: number } | null)?.seq ?? 0,
    ) + 1;
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_audit (id, workspace_id, seq, action, actor_type, actor_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      seq,
      action,
      input.actorType ?? "member",
      cleanOptionalString(input.actorId),
      toJson(details),
      createdAt,
    );
    return {
      id,
      workspaceId,
      action,
      actorType: input.actorType ?? "member",
      actorId: cleanOptionalString(input.actorId),
      details,
      createdAt,
    };
  }

  listAudit(workspaceId: string, limit = 50): MultiremiFeishuBotAuditEntry[] {
    const rows = this.ctx.db
      .query(
        `SELECT * FROM multiremi_feishu_bot_audit
          WHERE workspace_id = ?
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(workspaceId, Math.max(1, Math.min(200, Math.trunc(limit) || 50))) as Row[];
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      workspaceId: String(row.workspace_id ?? ""),
      action: String(row.action ?? "updated") as FeishuBotAuditAction,
      actorType: String(row.actor_type ?? "member"),
      actorId: nullableString(row.actor_id),
      details: parseJson<Record<string, unknown>>(row.details, {}),
      createdAt: String(row.created_at ?? ""),
    }));
  }

  /** Drop a Runtime's reported state — used when a Runtime is retired or deleted. */
  clearRuntimeStatus(runtimeId: string): void {
    this.ctx.db.run("DELETE FROM multiremi_feishu_bot_runtime_states WHERE runtime_id = ?", runtimeId);
  }

  /**
   * Workspaces whose configured Agent has just been archived, or whose Runtime
   * was removed, need the connector taken down rather than left orphaned.
   * Returns the workspaces that were disabled.
   */
  disableConfigsReferencingAgent(agentId: string, actor?: string | null): string[] {
    const routedWorkspaces = this.ctx.db.query(
      `SELECT workspace_id, scope, chat_id
       FROM multiremi_feishu_bot_agent_routes
       WHERE agent_id = ?
       ORDER BY workspace_id, scope, chat_id`,
    ).all(agentId) as Row[];
    for (const workspaceId of new Set(routedWorkspaces.map((row) => String(row.workspace_id)))) {
      const affected = routedWorkspaces
        .filter((row) => String(row.workspace_id) === workspaceId)
        .map((row) => ({ scope: String(row.scope), chat_id: nullableString(row.chat_id) }));
      // Keep the rows so the settings page can show which choices became
      // invalid. Resolution ignores archived Agents and falls through.
      this.recordAudit(workspaceId, "updated", {
        actorType: "system",
        actorId: actor ?? null,
        details: { routes: true, reason: "agent_archived", agent_id: agentId, affected },
      });
    }
    const disabled = this.disableWhere("agent_id = ? AND enabled = 1", agentId, actor);
    for (const workspaceId of disabled) {
      this.recordAudit(workspaceId, "disabled", {
        actorType: "system",
        actorId: actor ?? null,
        details: { reason: "agent_archived", agent_id: agentId },
      });
    }
    return disabled;
  }

  disableConfigsReferencingRuntime(runtimeId: string, actor?: string | null): string[] {
    const disabled = this.disableWhere("runtime_id = ? AND enabled = 1", runtimeId, actor);
    for (const workspaceId of disabled) {
      this.recordAudit(workspaceId, "disabled", {
        actorType: "system",
        actorId: actor ?? null,
        details: { reason: "runtime_removed", runtime_id: runtimeId },
      });
    }
    return disabled;
  }

  /** Everything the settings page and the status route need, in one read. */
  statusSnapshot(workspaceId: string): FeishuBotStatusSnapshot {
    const config = this.getConfig(workspaceId);
    if (!config) {
      return {
        status: "not_configured",
        config: null,
        desiredState: "stopped",
        runtimeOnline: false,
        appliedRevision: null,
        botName: null,
        lastHeartbeatAt: null,
        errorCode: null,
        errorMessage: null,
        staleRuntimeIds: this.liveForeignRuntimeIds(workspaceId, null),
      };
    }
    const runtime = this.ctx.runtimes().getRuntime(config.runtimeId);
    const runtimeOnline = Boolean(runtime && isRuntimeEffectivelyOnline(runtime));
    const reported = this.getRuntimeStatus(workspaceId, config.runtimeId);
    const staleRuntimeIds = this.liveForeignRuntimeIds(workspaceId, config.runtimeId);
    const desiredState: FeishuBotDesiredState = config.enabled && staleRuntimeIds.length === 0
      ? "running"
      : "stopped";

    const status = deriveStatus({
      enabled: config.enabled,
      revision: config.revision,
      runtimeOnline,
      reported,
      staleRuntimeCount: staleRuntimeIds.length,
    });
    return {
      status,
      config,
      desiredState,
      runtimeOnline,
      appliedRevision: reported?.appliedRevision ?? null,
      botName: reported?.botName ?? config.botName,
      lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
      errorCode: status === "failed" || status === "degraded"
        ? reported?.errorCode ?? config.lastTestErrorCode
        : null,
      errorMessage: status === "failed" || status === "degraded"
        ? reported?.errorMessage ?? config.lastTestError
        : null,
      staleRuntimeIds,
    };
  }

  private normalizeRouteInput(
    workspaceId: string,
    input: ReplaceFeishuBotAgentRouteInput,
  ): Required<Pick<ReplaceFeishuBotAgentRouteInput, "scope" | "agentId">> & {
    chatId: string | null;
    chatName: string | null;
  } {
    if (!ROUTE_SCOPES.has(input.scope)) {
      throw new FeishuBotConfigError("invalid route scope", 400, "invalid_route_scope");
    }
    const agentId = requiredBoundedString(input.agentId, "agent_id", 512);
    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new FeishuBotConfigError(
        "agent does not belong to this workspace",
        400,
        "agent_not_in_workspace",
      );
    }
    if (agent.archivedAt) {
      throw new FeishuBotConfigError("agent is archived", 400, "agent_archived");
    }
    const chatId = optionalBoundedString(input.chatId, "chat_id", 512);
    if (input.scope === "chat" && !chatId) {
      throw new FeishuBotConfigError("chat_id is required for chat routes", 400, "chat_id_required");
    }
    if (input.scope !== "chat" && chatId) {
      throw new FeishuBotConfigError(
        "chat_id is only allowed for chat routes",
        400,
        "chat_id_not_allowed",
      );
    }
    return {
      scope: input.scope,
      agentId,
      chatId: input.scope === "chat" ? chatId : null,
      chatName: input.scope === "chat" ? optionalBoundedString(input.chatName, "chat_name", 512) : null,
    };
  }

  private rawConfigRow(workspaceId: string): Row | null {
    return this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ?")
      .get(workspaceId) as Row | null;
  }

  /**
   * Runtimes other than `selfRuntimeId` that still claim a live connector for
   * this workspace, ignoring reports old enough to be untrustworthy.
   */
  private liveForeignRuntimeIds(workspaceId: string, selfRuntimeId: string | null): string[] {
    const cutoff = Date.now() - RUNTIME_STATE_STALE_MS;
    return this.listRuntimeStatuses(workspaceId)
      .filter((entry) => entry.runtimeId !== selfRuntimeId)
      .filter((entry) => entry.state === "online" || entry.state === "starting")
      .filter((entry) => {
        const reportedAt = Date.parse(entry.reportedAt);
        return Number.isFinite(reportedAt) && reportedAt >= cutoff;
      })
      .map((entry) => entry.runtimeId);
  }

  private disableWhere(clause: string, param: string, actor?: string | null): string[] {
    const rows = this.ctx.db
      .query(`SELECT workspace_id FROM multiremi_feishu_bot_configs WHERE ${clause}`)
      .all(param) as Row[];
    const workspaceIds = rows.map((row) => String(row.workspace_id ?? "")).filter(Boolean);
    if (!workspaceIds.length) return [];
    this.ctx.db.run(
      `UPDATE multiremi_feishu_bot_configs
          SET enabled = 0, revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE ${clause}`,
      nowIso(),
      cleanOptionalString(actor),
      param,
    );
    return workspaceIds;
  }
}

function routeKey(scope: FeishuBotAgentRouteScope, chatId: string | null): string {
  return `${scope}\u0000${chatId ?? ""}`;
}

function mapRoute(row: Row): MultiremiFeishuBotAgentRoute {
  return {
    id: String(row.id ?? ""),
    workspaceId: String(row.workspace_id ?? ""),
    scope: String(row.scope ?? "") as FeishuBotAgentRouteScope,
    chatId: nullableString(row.chat_id),
    chatName: nullableString(row.chat_name),
    agentId: String(row.agent_id ?? ""),
    agentName: nullableString(row.agent_name),
    agentArchived: row.agent_name == null || row.agent_archived_at != null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    updatedBy: nullableString(row.updated_by),
  };
}

/**
 * Pure status derivation, exported so tests can cover the state machine without
 * a database.
 */
export function deriveStatus(input: {
  enabled: boolean;
  revision: number;
  runtimeOnline: boolean;
  reported: MultiremiFeishuBotRuntimeStatus | null;
  staleRuntimeCount: number;
}): FeishuBotStatus {
  if (!input.enabled) return "stopped";
  // A second Runtime still holding the connector is reported before anything
  // else: it is the one condition that silently produces duplicate replies.
  if (input.staleRuntimeCount > 0) return "degraded";
  if (!input.runtimeOnline) return "runtime_offline";
  const reported = input.reported;
  if (!reported) return "deploying";
  if (reported.appliedRevision < input.revision) {
    // The Runtime is alive but still on an older config: a failure it reported
    // for the previous revision must not be presented as the current state.
    return "deploying";
  }
  if (reported.state === "failed") return "failed";
  if (reported.state === "starting") return "connecting";
  if (reported.state === "online") return "online";
  return "deploying";
}

function toSender(row: Row): FeishuBotSender {
  return {
    id: String(row.id),
    app_id: String(row.app_id),
    display_name: String(row.display_name),
    name_en: nullableString(row.name_en),
    open_id: String(row.open_id),
    union_id: nullableString(row.union_id),
    allowed: Boolean(Number(row.allowed)),
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
  };
}

function resolveSecretColumn(
  workspaceId: string,
  field: "app_secret",
  op: FeishuBotSecretOp,
  value: string | undefined,
  existing: string | null,
): { ciphertext: string | null; hint: string | null; changed: boolean } {
  if (op === "clear") return { ciphertext: null, hint: null, changed: existing !== null };
  if (op === "set") {
    const plaintext = String(value ?? "").trim();
    if (!plaintext) return { ciphertext: null, hint: null, changed: existing !== null };
    return {
      ciphertext: encryptFeishuBotSecret(plaintext, { workspaceId, field }),
      hint: feishuBotSecretHint(plaintext),
      changed: true,
    };
  }
  return { ciphertext: existing, hint: null, changed: false };
}

function requiredBoundedString(value: unknown, field: string, maxLength: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new FeishuBotConfigError(`${field} is required`, 400, `${field}_required`);
  if (normalized.length > maxLength) {
    throw new FeishuBotConfigError(`${field} is too long`, 400, `${field}_too_long`);
  }
  return normalized;
}

function optionalBoundedString(value: unknown, field: string, maxLength: number): string | null {
  const normalized = cleanOptionalString(value);
  if (normalized && normalized.length > maxLength) {
    throw new FeishuBotConfigError(`${field} is too long`, 400, `${field}_too_long`);
  }
  return normalized;
}

function normalizeDomain(value: unknown): FeishuBotDomain {
  const domain = String(value ?? "").trim();
  return DOMAINS.has(domain as FeishuBotDomain) ? (domain as FeishuBotDomain) : "feishu";
}

function mapConfig(row: Row): MultiremiFeishuBotConfig {
  return {
    workspaceId: String(row.workspace_id ?? ""),
    agentId: String(row.agent_id ?? ""),
    runtimeId: String(row.runtime_id ?? ""),
    appId: String(row.app_id ?? ""),
    domain: normalizeDomain(row.domain),
    enabled: Boolean(Number(row.enabled ?? 0)),
    senderAccessPolicy: row.sender_access_policy === "allowlist" ? "allowlist" : "agent",
    revision: Number(row.revision ?? 0),
    hasAppSecret: Boolean(nullableString(row.app_secret_encrypted)),
    appSecretHint: nullableString(row.app_secret_hint),
    botName: nullableString(row.bot_name),
    botOpenId: nullableString(row.bot_open_id),
    lastTestedAt: nullableString(row.last_tested_at),
    lastTestError: nullableString(row.last_test_error),
    lastTestErrorCode: normalizeFeishuBotErrorCode(row.last_test_error_code),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    updatedBy: nullableString(row.updated_by),
  };
}

function mapRuntimeStatus(row: Row): MultiremiFeishuBotRuntimeStatus {
  const state = String(row.state ?? "stopped");
  return {
    workspaceId: String(row.workspace_id ?? ""),
    runtimeId: String(row.runtime_id ?? ""),
    appliedRevision: Number(row.applied_revision ?? 0),
    state: RUNTIME_STATES.has(state as FeishuBotRuntimeState) ? (state as FeishuBotRuntimeState) : "stopped",
    botName: nullableString(row.bot_name),
    botOpenId: nullableString(row.bot_open_id),
    errorCode: normalizeFeishuBotErrorCode(row.error_code),
    errorMessage: nullableString(row.error_message),
    reportedAt: String(row.reported_at ?? ""),
  };
}

function roundPushPrompt(
  issue: Pick<MultiremiIssue, "key" | "title">,
  updates: string[] = [],
  omittedCount = 0,
): string {
  const lines = [
    `The responsible agent completed a work round for ${issue.key} - ${issue.title}.`,
    "Report the current result to the users in this Feishu topic. Use the Bound Issue Updates context below when present.",
  ];
  if (updates.length) {
    lines.push("", "Updates delivered while the current Chat task was already active:", ...updates);
  }
  if (omittedCount > 0) lines.push("", `${omittedCount} earlier update aggregate(s) were omitted.`);
  return lines.join("\n");
}

function resolveFeishuBotChatType(
  input: SubmitFeishuBotMessageInput,
  externalSessionKey: string,
): "p2p" | "group" {
  if (input.chatType === "group" || input.chatType === "p2p") return input.chatType;
  if (cleanOptionalString(input.threadId) || externalSessionKey.includes(":thread:")) return "group";
  return "p2p";
}

function issueTitleFromFeishuMessage(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "Feishu group request";
  const maxLength = 120;
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function issueTopicBody(issue: Pick<MultiremiIssue, "key" | "title" | "description">): string {
  const title = `**${issue.key} - ${issue.title}**`;
  const description = cleanOptionalString(issue.description);
  return description ? `${title}\n\n${description}` : title;
}

function humanRequestPushBody(
  issue: Pick<MultiremiIssue, "key" | "title">,
  sourceTask: Pick<MultiremiTask, "id">,
  request: MultiremiTaskHumanRequest,
  payload: Record<string, unknown>,
): string {
  const message = cleanOptionalString(payload.message) ?? "Agent is waiting for a human answer.";
  return [
    `**${issue.key} - ${issue.title}**`,
    "",
    `Issue Task ${sourceTask.id} is waiting for a human ${request.kind === "permission" ? "decision" : "answer"}.`,
    `Request ID: ${request.id}`,
    "",
    message,
  ].join("\n");
}

function humanRequestPushPrompt(
  issue: Pick<MultiremiIssue, "key" | "title">,
  sourceTask: Pick<MultiremiTask, "id">,
  request: MultiremiTaskHumanRequest,
): string {
  const payload = request.payload ?? {};
  const message = cleanOptionalString(payload.message) ?? "Agent is waiting for a human answer.";
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  return [
    `An Issue task is waiting for a human ${request.kind === "permission" ? "decision" : "answer"}.`,
    `Issue: ${issue.key} - ${issue.title}`,
    `Source task id: ${sourceTask.id}`,
    `Human request id: ${request.id}`,
    "",
    message,
    ...(questions.length ? ["", `Questions/options: ${JSON.stringify(questions)}`] : []),
    "",
    "You are the Agent bound to this Feishu Issue topic. Decide how to notify the people in the topic and how to collect the answer. Keep the source task and request ids in any follow-up so the answer can be correlated. Do not create another Issue for this notification.",
  ].join("\n");
}

function outboundDelivery(row: Row, claimToken: string): MultiremiFeishuBotOutboundDelivery {
  const id = String(row.id);
  const bodyOrigin = row.task_id == null && !row.attachments ? "issue" : "agent";
  return {
    id,
    claimToken,
    claim_token: claimToken,
    chatId: String(row.chat_id),
    chat_id: String(row.chat_id),
    threadId: nullableString(row.thread_id),
    thread_id: nullableString(row.thread_id),
    replyToMessageId: nullableString(row.reply_to_message_id),
    reply_to_message_id: nullableString(row.reply_to_message_id),
    body: String(row.body),
    bodyOrigin,
    body_origin: bodyOrigin,
    idempotencyKey: id,
    idempotency_key: id,
    ...(row.attachments ? { attachments: parseJson(row.attachments, []) } : {}),
  };
}

/** Exported for tests that need to age a reported state past the trust window. */
export const FEISHU_BOT_RUNTIME_STATE_STALE_MS = RUNTIME_STATE_STALE_MS;
