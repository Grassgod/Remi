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
import { loadLarkSsoConfig } from "@multiremi/api/helpers/integrations.js";
import { chatAttachmentValidationError } from "@multiremi/contracts/attachments.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { advancesFeishuPresentation, parseFeishuPresentation } from "@multiremi/contracts/feishu-presentation.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { activeRequestReadCache, cacheKey } from "@multiremi/store/request-read-cache.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { numberAllocationLockKey } from "@multiremi/store/advisory-locks.js";
import { advisoryXactLock } from "@multiremi/store/db/postgres.js";
import {
  decryptFeishuBotSecret,
  encryptFeishuBotSecret,
  feishuBotSecretHint,
} from "@multiremi/feishu-bot/credentials.js";
import { normalizeFeishuBotErrorCode } from "@multiremi/feishu-bot/diagnostics.js";
import { isRuntimeEffectivelyOnline } from "@multiremi/store/repos/runtimes-repo.js";
import {
  IssueTopicConfigError,
  readWorkspaceIssueTopics,
  readWorkspaceIssueTopicsForDelivery,
  readWorkspaceIssueTopicsLenient,
} from "@multiremi/issue-topics/config.js";
import { findMarkdownImages } from "@shared/feishu-markdown-images.js";
import { createLogger } from "@shared/logger.js";
import { isFeishuOpenId, parseOutboundMention } from "@shared/feishu-mention.js";
import { hashQuestionCardToken, mintQuestionCardToken } from "@multiremi/store/question-card-token.js";
import {
  buildCardHeader,
  buildIssueDecisionCard,
  buildTaskInteractionCard,
  decisionMentionElement,
  decodeDecisionCardBody,
  encodeDecisionCardBody,
  questionCardAction,
} from "@shared/feishu-task-card.js";
import {
  FEISHU_CONCIERGE_CONFIG_CAPABILITY,
  FEISHU_DECISION_CARD_CAPABILITY,
  FEISHU_ISSUE_DECISION_CARD_CAPABILITY,
  type FeishuDecisionDegradeReason,
} from "@multiremi/contracts/types.js";
import type {
  FeishuBotAuditAction,
  IssueTopicConfig,
  FeishuPresentationCheckpoint,
  FeishuBotDesiredState,
  FeishuBotDomain,
  FeishuBotErrorCode,
  FeishuBotRuntimeState,
  FeishuBotAgentRouteScope,
  FeishuBotSender,
  FeishuBotCancelCandidate,
  FeishuBotCancelRejection,
  FeishuBotCancelResult,
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
  MultiremiIssueDecision,
  MultiremiChatSession,
  MultiremiTask,
  MultiremiTaskHumanRequest,
  MultiremiWorkspaceMember,
  SubmitFeishuBotMessageInput,
  SubmitFeishuBotMessageResult,
  ReportFeishuBotRuntimeStatusInput,
  ReplaceFeishuBotAgentRouteInput,
  UpsertFeishuBotConfigInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export type IssueDecisionOperatorMemberResolution =
  | { status: "resolved"; member: MultiremiWorkspaceMember }
  | { status: "unmapped" }
  | { status: "ambiguous" };

const log = createLogger("multiremi-store");

/** How many ambiguous candidates travel to the reply card. */
const MAX_STOP_CANDIDATES = 5;

/** One Task a stop request could act on, with the context a human needs. */
export interface ResolvedCancelTarget {
  task: MultiremiTask;
  agentName: string | null;
  issueKey: string | null;
  chatTitle: string | null;
}

/**
 * Tie-break for a group top-level stop, where the Feishu client gives no
 * thread lineage: stop the sender's only unfinished Task, otherwise list the
 * choices.
 *
 * Guessing which of several concurrent runs the user meant is not recoverable —
 * a cancelled run cannot be resumed — while asking costs one more message. The
 * candidates arrive newest-first, so this function is the single place a
 * "most recent wins" policy would go if that trade-off were ever revisited.
 */
export function resolveFallbackCancelTarget(
  candidates: ResolvedCancelTarget[],
): { kind: "none" } | { kind: "ambiguous"; count: number } | { kind: "target"; target: ResolvedCancelTarget } {
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "target", target: candidates[0]! };
  return { kind: "ambiguous", count: candidates.length };
}

function rejectedCancel(reason: FeishuBotCancelRejection): FeishuBotCancelResult {
  return {
    outcome: "rejected",
    agentName: null,
    taskId: null,
    issueKey: null,
    chatTitle: null,
    candidates: [],
    candidateCount: 0,
    reason,
  };
}

function cancelledCancel(target: ResolvedCancelTarget): FeishuBotCancelResult {
  return {
    outcome: "cancelled",
    agentName: target.agentName,
    taskId: target.task.id,
    issueKey: target.issueKey,
    chatTitle: target.chatTitle,
    candidates: [],
    candidateCount: 1,
    reason: null,
  };
}

function toCancelCandidate(target: ResolvedCancelTarget): FeishuBotCancelCandidate {
  return {
    taskId: target.task.id,
    status: target.task.status,
    agentName: target.agentName,
    issueId: target.task.issueId,
    issueKey: target.issueKey,
    chatTitle: target.chatTitle,
    startedAt: target.task.startedAt ?? target.task.createdAt,
  };
}

/** Newest first: the most recently started run is the likeliest intent. */
function compareCancelTargets(left: MultiremiTask, right: MultiremiTask): number {
  const key = (task: MultiremiTask) => `${task.startedAt ?? task.createdAt}\u0000${task.id}`;
  return key(right).localeCompare(key(left), "en");
}

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
      // Global lock order (MUL-405): W then N before the sender row UPDATE and
      // the audit row it writes. The audit seq is allocated under the number
      // lock, so taking it here keeps D after both.
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      advisoryXactLock(this.ctx.db, numberAllocationLockKey(`feishu-bot-audit:${workspaceId}`));
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
    const topicConfig = workspace ? readWorkspaceIssueTopicsLenient(workspace.settings, () => {
      log.warn(`Feishu inbound message: ignoring an invalid issueTopics config for ${workspaceId}`);
    }) : null;
    let enqueuedTask: MultiremiTask | null = null;
    const submitChanges: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const submitEvents = createCommitEventQueue();

    const result = this.ctx.db.transaction((): SubmitFeishuBotMessageResult => {
      // Global lock order (MUL-405): W then N, before any domain row lock.
      // Whether this message auto-creates an Issue is only known after the
      // sender is resolved, and resolving it writes the sender row (D). The
      // number lock is therefore taken unconditionally — it is per workspace
      // and held for the rest of this transaction, which is what keeps the
      // order the same on every path instead of depending on the payload.
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      advisoryXactLock(this.ctx.db, numberAllocationLockKey(`issue:${workspaceId}`));
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
      const createGroupIssue = () => this.ctx.issues().createIssueWithinTransaction({
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
      }, submitChanges, submitEvents);
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
        }, submitChanges, submitEvents);
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
        this.ctx.tasks().createTaskSteerMessageWithinTransaction({ taskId: task.id, kind: "steer", content: text,
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
    this.ctx.tasks().runCollectedChildStatusChanges(submitChanges);
    this.ctx.emitCommitEvents(submitEvents);
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

  /**
   * MUL-407: an Issue task has no chat session, so the Runtime that hosts the
   * Issue's Feishu topic cannot read or answer that task's human requests even
   * though the card was delivered there. A live topic binding for the task's
   * own Issue qualifies it — and only for reading a request and responding to
   * it. Creating and expiring stay with the executing daemon, so this predicate
   * must never be consulted for those verbs.
   */
  canDaemonAccessIssueTaskHumanRequest(workspaceId: string, daemonId: string, taskId: string): boolean {
    return this.ctx.db.query(`SELECT 1 AS present
      FROM multiremi_feishu_bot_configs c
      JOIN multiremi_runtimes r ON r.id = c.runtime_id AND r.workspace_id = c.workspace_id
      JOIN multiremi_feishu_bot_chat_bindings b ON b.workspace_id = c.workspace_id AND b.app_id = c.app_id
      JOIN multiremi_chat_sessions s ON s.id = b.chat_session_id AND s.status = 'active'
      JOIN multiremi_tasks t ON t.issue_id = b.issue_id AND t.workspace_id = b.workspace_id
      WHERE c.workspace_id = ? AND c.enabled = 1 AND r.daemon_id = ?
        AND b.issue_id IS NOT NULL AND t.id = ? LIMIT 1`)
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
    // A stored config the current validation would reject must not abort the
    // caller; an unusable target degrades later, at delivery time.
    const topicConfig = readWorkspaceIssueTopicsForDelivery(workspace.settings);
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
    if (!sourceTask) return null;
    // The asking Task and the Issue it names must agree before anything is
    // written: a Task whose `issue_id` aims at another workspace would
    // otherwise queue this workspace's delivery, and later its activity, onto
    // that workspace's Issue (MUL-407). The delivery's workspace is the Issue's,
    // so resolving through the Task's own workspace is the whole check.
    const issueId = this.issueIdInWorkspace(sourceTask.workspaceId, sourceTask.issueId);
    if (!issueId) return null;
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue) return null;
    const workspace = this.ctx.workspaces().getWorkspace(issue.workspaceId);
    if (!workspace) return null;
    // The push path must never throw on a stored config: a request with no
    // delivery leaves the person who was asked with no way to hear about it.
    const topics = readWorkspaceIssueTopicsForDelivery(workspace.settings);
    if (!topics.enabled || !topics.chatId) return null;
    const bot = this.statusSnapshot(issue.workspaceId);
    if (bot.status !== "online" || !bot.config) return null;
    const botConfig = bot.config;
    // Which person may press the button, decided before any delivery exists.
    // `none` and an unusable `person` target are terminal answers: the request
    // degrades to text, and no card is ever built for it.
    const recipient = resolveDecisionRecipient(topics);

    const childStatusChanges: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEvents = createCommitEventQueue();
    const wakeTask = this.ctx.db.transaction(() => {
      const binding = this.ctx.db.query(
        `SELECT b.* FROM multiremi_feishu_bot_chat_bindings b
         JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
         WHERE b.workspace_id = ? AND b.issue_id = ? AND c.status = 'active'
           AND b.chat_id = ?
         ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
         LIMIT 1`,
      ).get(issue.workspaceId, issue.id, topics.chatId) as Row | null;
      if (!binding) return null;
      const bindingId = String(binding.id);
      const existing = this.ctx.db.query(
        `SELECT wake_task_id, delivery_id FROM multiremi_feishu_bot_human_request_pushes
         WHERE binding_id = ? AND request_id = ? LIMIT 1`,
      ).get(bindingId, request.id) as Row | null;
      if (existing) {
        return existing.wake_task_id == null
          ? null
          : this.ctx.tasks().getTask(String(existing.wake_task_id));
      }

      const agentId = String(binding.agent_id ?? "");
      if (!agentId) return null;
      const payload = request.payload ?? {};
      const replyToMessageId = cleanOptionalString(binding.reply_to_message_id);
      // Without a topic seed there is no thread to reply into, so the request
      // stays on the web workbench. Record why instead of failing silently.
      if (!replyToMessageId) {
        const now = nowIso();
        this.ctx.db.run(
          `INSERT INTO multiremi_feishu_bot_human_request_pushes (
             id, workspace_id, binding_id, issue_id, source_task_id,
             request_id, wake_task_id, delivery_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          [
            createId("fhrp"), issue.workspaceId, bindingId, issue.id,
            sourceTask.id, request.id, now, now,
          ],
        );
        this.ctx.appendIssueActivity(issue.id, {
          actorType: "system",
          type: "decision_card_skipped",
          body: request.id,
          data: { request_id: request.id, source_task_id: sourceTask.id, reason: "no_topic" },
        }, deferredEvents);
        return null;
      }
      // A host that can render a server-built card gets one; every other host
      // keeps the pre-MUL-407 relay wake, so a platform deploy never depends on
      // the fleet having upgraded its daemon first. An unaddressable request
      // degrades to text on every host, old or new.
      const cardCapable = this.supportsDecisionCard(issue.workspaceId, botConfig.runtimeId);
      if (cardCapable || recipient.kind === "degraded") {
        const deliveryId = this.enqueueDecisionDeliveryWithinTransaction({
          issue, sourceTask, request, topics, binding, bindingId, payload, recipient,
          cardCapable, deferredEvents,
        });
        const now = nowIso();
        this.ctx.db.run(
          `INSERT INTO multiremi_feishu_bot_human_request_pushes (
             id, workspace_id, binding_id, issue_id, source_task_id,
             request_id, wake_task_id, delivery_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          [
            createId("fhrp"), issue.workspaceId, bindingId, issue.id,
            sourceTask.id, request.id, deliveryId, now, now,
          ],
        );
        return null;
      }
      const wakeTask = this.ctx.tasks().createTaskWithinTransaction({
        agentId,
        chatSessionId: String(binding.chat_session_id),
        issueId: issue.id,
        workspaceId: issue.workspaceId,
        holdsWorkspace: false,
        prompt: humanRequestPushPrompt(issue, sourceTask, request),
        requestingUserName: "Multiremi",
        requestingUserProfileDescription: "System notification for a pending Issue human request.",
      }, childStatusChanges, deferredEvents);
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
    if (wakeTask) this.ctx.tasks().runCollectedChildStatusChanges(childStatusChanges);
    this.ctx.emitCommitEvents(deferredEvents);
    return wakeTask;
  }

  /**
   * A bot host renders a server-built card only when it says it can (MUL-407).
   * The flag is re-advertised on every heartbeat, so silence means an older
   * build and the request keeps the relay-wake path until it upgrades.
   */
  supportsDecisionCard(workspaceId: string, runtimeId: string | null | undefined): boolean {
    if (!runtimeId) return false;
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime || runtime.workspaceId !== workspaceId) return false;
    return runtime.metadata[FEISHU_DECISION_CARD_CAPABILITY] === 1;
  }

  /**
   * Write the delivery for a pending human request. Runs inside the caller's
   * transaction: the push row, the delivery and the request's deadline must
   * become visible together, or the host would poll a request the control plane
   * has not committed yet.
   *
   * Two shapes come out of here:
   * - A host that renders cards gets a `decision_card` carrying the card plus
   *   its text twin (`recipient.kind === "card"`).
   * - A request nobody could be asked for — `notifyMode = none`, an unusable
   *   `person` target, or a `group_owner` that only the host might resolve and
   *   might fail to — is written as a `decision_card` whose body is the plain
   *   text and whose `degraded` field says why. The host posts text, and both
   *   the terminal patch and the reminder mention are skipped for that request.
   */
  private enqueueDecisionDeliveryWithinTransaction(input: {
    issue: MultiremiIssue;
    sourceTask: MultiremiTask;
    request: MultiremiTaskHumanRequest;
    topics: IssueTopicConfig;
    binding: Row;
    bindingId: string;
    payload: Record<string, unknown>;
    recipient: DecisionRecipientResolution;
    cardCapable: boolean;
    /** Caller-owned queue: the activities below are written before COMMIT. */
    deferredEvents: import("@multiremi/store/context.js").CommitEventQueue;
  }): string {
    const { issue, sourceTask, request, topics, binding, bindingId, recipient, deferredEvents } = input;
    const replyToMessageId = cleanOptionalString(binding.reply_to_message_id);
    const deliveryId = createId("fbo");
    const now = nowIso();
    const fallbackText = decisionCardTextBody({
      issue,
      workspaceSlug: this.ctx.workspaces().getWorkspace(issue.workspaceId)?.slug ?? null,
      request,
    });
    // Only a request the control plane already knows is unaddressable degrades
    // here. `group_owner` stays a card: the host holds the bot token, so it is
    // the only side that can find out whether a recipient exists, and it sends
    // the text twin itself when the lookup comes back empty.
    const degraded = recipient.kind === "degraded" ? recipient.reason : null;
    const token = this.rotateQuestionCardToken("multiremi_task_human_requests", request.id,
      recipient.kind === "resolved" ? recipient.openId : null);
    let body: string;
    if (degraded) {
      body = fallbackText;
    } else {
      const card = buildTaskInteractionCard(request, {
        token,
        header: buildCardHeader({ agentName: this.botAgentName(issue.workspaceId) }),
        ...(recipient.kind === "resolved" ? { recipientOpenId: recipient.openId } : {}),
        // `group_owner` is resolved by the host, which holds the bot token. The
        // card renders as if addressed and carries the sentinel @ to fill in.
        recipientPending: recipient.kind === "host_resolved",
      });
      // Written through the shared encoder so the host's parser can never
      // disagree with this shape again.
      body = encodeDecisionCardBody({ card, fallback_text: fallbackText });
    }
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at,
         mention_snapshot, interaction_open_id, kind, human_request_id, human_request_task_id,
         expires_at, degraded
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'decision_card', ?, ?, ?, ?)`,
      [
        deliveryId,
        issue.workspaceId,
        bindingId,
        topics.chatId,
        cleanOptionalString(binding.thread_id),
        replyToMessageId,
        body,
        now,
        now,
        now,
        recipient.kind === "resolved"
          ? toJson({ mode: "person", openId: recipient.openId, resolvedOpenId: recipient.openId })
          : toJson({ mode: topics.notifyMode ?? "group_owner" }),
        recipient.kind === "resolved" ? recipient.openId : null,
        request.id,
        sourceTask.id,
        request.expiresAt ?? null,
        degraded,
      ],
    );
    // A degrade the control plane already knows about and a degrade the host
    // discovers later both land on this Issue as the same activity type with the
    // same fields, so an operator reads one story rather than two dialects.
    if (degraded) {
      this.appendDecisionDegradedActivity(issue.id, {
        requestId: request.id,
        sourceTaskId: sourceTask.id,
        deliveryId,
        reason: degraded,
      }, deferredEvents);
    } else {
      this.ctx.appendIssueActivity(issue.id, {
        actorType: "system",
        type: "decision_card_queued",
        body: request.id,
        data: {
          request_id: request.id,
          source_task_id: sourceTask.id,
          delivery_id: deliveryId,
          kind: "decision_card",
          notify_mode: topics.notifyMode ?? "group_owner",
        },
      }, deferredEvents);
    }
    return deliveryId;
  }

  /**
   * A bot host renders a server-built Issue decision card only when it says so
   * (MUL-412). Declared separately from
   * {@link FEISHU_DECISION_CARD_CAPABILITY}: a host built before decisions can
   * still send the human-request cards it already understands, and the control
   * plane must not hand it a card whose buttons it cannot answer.
   */
  supportsIssueDecisionCard(workspaceId: string, runtimeId: string | null | undefined): boolean {
    if (!runtimeId) return false;
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime || runtime.workspaceId !== workspaceId) return false;
    return runtime.metadata[FEISHU_ISSUE_DECISION_CARD_CAPABILITY] === 1;
  }

  private rotateQuestionCardToken(
    table: "multiremi_task_human_requests" | "multiremi_issue_decisions",
    id: string,
    recipient: string | null,
  ): string {
    const token = mintQuestionCardToken();
    const status = table === "multiremi_issue_decisions" ? "escalated" : "pending";
    const updated = this.ctx.db.run(
      `UPDATE ${table} SET token_hash = ?, token_recipient = ?, token_consumed_at = NULL
       WHERE id = ? AND status = ? AND token_consumed_at IS NULL`,
      [hashQuestionCardToken(token), recipient, id, status],
    );
    if (updated.changes !== 1) throw new Error("question card is no longer pending");
    return token;
  }

  private rotatedQuestionCard(row: Row, recipientOpenId: string | null): Record<string, unknown> | null {
    const header = buildCardHeader({ agentName: this.botAgentName(String(row.workspace_id)) });
    const decisionId = cleanOptionalString(row.decision_id);
    if (decisionId) {
      const decision = this.ctx.issues().getIssueDecisionAnywhere(decisionId);
      if (!decision || decision.status !== "escalated") return null;
      return buildIssueDecisionCard(decision, { header,
        token: this.rotateQuestionCardToken("multiremi_issue_decisions", decisionId, recipientOpenId),
        ...(recipientOpenId ? { recipientOpenId } : { recipientPending: true }),
      });
    }
    const requestId = cleanOptionalString(row.human_request_id);
    const request = requestId ? this.ctx.tasks().getTaskHumanRequest(requestId) : null;
    if (!request || request.status !== "pending") return null;
    return buildTaskInteractionCard(request, { header,
      token: this.rotateQuestionCardToken("multiremi_task_human_requests", request.id, recipientOpenId),
      ...(recipientOpenId ? { recipientOpenId } : { recipientPending: true }),
    });
  }

  prepareTaskStreamQuestionCard(requestId: string, recipientOpenId: string): Record<string, unknown> | null {
    if (!isFeishuOpenId(recipientOpenId)) return null;
    return this.ctx.db.transaction(() => {
      const request = this.ctx.tasks().getTaskHumanRequest(requestId);
      const task = request ? this.ctx.tasks().getTask(request.taskId) : null;
      if (!request || !task || request.status !== "pending") return null;
      return this.rotatedQuestionCard({ human_request_id: requestId, workspace_id: task.workspaceId }, recipientOpenId);
    })();
  }

  /**
   * Queue the card for an E4 decision a person must decide (MUL-412).
   *
   * Runs inside the caller's transaction: the escalation (or the direct
   * `escalated` insert) and the delivery row become visible together, so a
   * rollback cannot leave a card for a decision that was never escalated and a
   * committed escalation cannot be missing its card. Every event goes on the
   * caller's queue.
   *
   * Three cases end without a card, each recorded on the Issue:
   * - the decision hangs on an Issue whose topic has no seed message —
   *   `decision_card_skipped(no_topic)`, the decision stays on the web;
   * - the bot or its host is not usable right now — no delivery at all (the
   *   request is still escalated and visible in the workbench and inbox);
   * - the host predates decision cards — no delivery, same reason.
   */
  prepareIssueDecisionCardWithinTransaction(
    issue: MultiremiIssue,
    decision: MultiremiIssueDecision,
    deferredEvents: import("@multiremi/store/context.js").CommitEventQueue,
  ): void {
    // Only the two "a person decides this" states get a card (A3). `pending`
    // belongs to the parent's owner agent, and the two terminal states are
    // already past asking.
    if (decision.status !== "escalated") return;
    if (decision.issueId !== issue.id) return;
    const workspace = this.ctx.workspaces().getWorkspace(issue.workspaceId);
    if (!workspace) return;
    // Same lenient read as the human-request path: a stored config the current
    // validation would reject degrades rather than aborting the escalation.
    const topics = readWorkspaceIssueTopicsForDelivery(workspace.settings);
    if (!topics.enabled || !topics.chatId) return;
    const bot = this.statusSnapshot(issue.workspaceId);
    if (bot.status !== "online" || !bot.config) return;
    const botConfig = bot.config;
    if (!this.supportsIssueDecisionCard(issue.workspaceId, botConfig.runtimeId)) return;
    // An existing row is the idempotency record: a repeated escalation of the
    // same decision must not queue a second card.
    const existing = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_feishu_bot_outbound_deliveries
       WHERE decision_id = ? LIMIT 1`,
    ).get(decision.id) as Row | null;
    if (existing) return;
    const recipient = resolveDecisionRecipient(topics);
    // The decision's own Issue is the delivery target: this is the Issue the
    // person answers against, so its topic is where the question belongs.
    const binding = this.ctx.db.query(
      `SELECT b.* FROM multiremi_feishu_bot_chat_bindings b
       JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
       WHERE b.workspace_id = ? AND b.issue_id = ? AND c.status = 'active'
         AND b.chat_id = ?
       ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC
       LIMIT 1`,
    ).get(issue.workspaceId, issue.id, topics.chatId) as Row | null;
    if (!binding) return;
    const bindingId = String(binding.id);
    const replyToMessageId = cleanOptionalString(binding.reply_to_message_id);
    if (!replyToMessageId) {
      this.ctx.appendIssueActivity(issue.id, {
        actorType: "system",
        type: "decision_card_skipped",
        body: decision.id,
        data: { decision_id: decision.id, reason: "no_topic" },
      }, deferredEvents);
      return;
    }
    const deliveryId = createId("fbo");
    const now = nowIso();
    const fallbackText = issueDecisionCardTextBody({
      issue,
      workspaceSlug: workspace.slug ?? null,
      decision,
    });
    const degraded = recipient.kind === "degraded" ? recipient.reason : null;
    const token = this.rotateQuestionCardToken("multiremi_issue_decisions", decision.id,
      recipient.kind === "resolved" ? recipient.openId : null);
    let body: string;
    if (degraded) {
      body = fallbackText;
    } else {
      const card = buildIssueDecisionCard(decision, {
        token,
        header: buildCardHeader({ agentName: this.botAgentName(issue.workspaceId) }),
        ...(recipient.kind === "resolved" ? { recipientOpenId: recipient.openId } : {}),
        recipientPending: recipient.kind === "host_resolved",
      });
      body = encodeDecisionCardBody({ card, fallback_text: fallbackText });
    }
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at,
         mention_snapshot, interaction_open_id, kind, decision_id, decision_issue_id, degraded
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'decision_card', ?, ?, ?)`,
      [
        deliveryId,
        issue.workspaceId,
        bindingId,
        topics.chatId,
        cleanOptionalString(binding.thread_id),
        replyToMessageId,
        body,
        now,
        now,
        now,
        recipient.kind === "resolved"
          ? toJson({ mode: "person", openId: recipient.openId, resolvedOpenId: recipient.openId })
          : toJson({ mode: topics.notifyMode ?? "group_owner" }),
        recipient.kind === "resolved" ? recipient.openId : null,
        decision.id,
        decision.issueId,
        degraded,
      ],
    );
    if (degraded) {
      this.appendDecisionCardDegradedActivity(issue.id, {
        decisionId: decision.id,
        deliveryId,
        reason: degraded,
      }, deferredEvents);
    } else {
      this.ctx.appendIssueActivity(issue.id, {
        actorType: "system",
        type: "decision_card_queued",
        body: decision.id,
        data: {
          decision_id: decision.id,
          delivery_id: deliveryId,
          kind: "decision_card",
          notify_mode: topics.notifyMode ?? "group_owner",
        },
      }, deferredEvents);
    }
  }

  /**
   * Rewrite a decision's card in place once it leaves `escalated` (MUL-412).
   *
   * Called from inside the answer/withdraw transaction, so the patch row and
   * the answer commit together. One patch per decision: the card only needs the
   * first terminal state, and a card click that races a web answer must not
   * produce two rewrites.
   */
  enqueueIssueDecisionCardPatchWithinTransaction(
    decision: MultiremiIssueDecision,
    deferredEvents: import("@multiremi/store/context.js").CommitEventQueue,
  ): void {
    if (decision.status !== "answered" && decision.status !== "withdrawn") return;
    if (this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_feishu_bot_outbound_deliveries
       WHERE kind = 'decision_card_patch' AND decision_id = ? LIMIT 1`,
    ).get(decision.id)) return;
    const row = this.ctx.db.query(
      `SELECT o.id, o.workspace_id, o.binding_id, o.chat_id, o.thread_id,
              o.external_message_id, o.decision_id, o.degraded
       FROM multiremi_feishu_bot_outbound_deliveries o
       WHERE o.kind = 'decision_card' AND o.decision_id = ?
         AND o.degraded IS NULL
       ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
    ).get(decision.id) as Row | null;
    // Nothing to rewrite when the card never left the outbox, was skipped, or
    // went out as text: a degraded decision has no card on screen, and editing
    // the text would replace the question with a receipt.
    const messageId = cleanOptionalString(row?.external_message_id);
    if (!row || !messageId) return;
    const now = nowIso();
    const card = buildIssueDecisionCard(decision, {
      header: buildCardHeader({ agentName: this.botAgentName(String(row.workspace_id)) }),
      receipt: true,
    });
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at,
         kind, decision_id, decision_issue_id, target_message_id
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?, 'decision_card_patch', ?, ?, ?)`,
      [
        createId("fbo"),
        String(row.workspace_id),
        String(row.binding_id),
        String(row.chat_id),
        cleanOptionalString(row.thread_id),
        messageId,
        encodeDecisionCardBody({ card }),
        now,
        now,
        now,
        decision.id,
        decision.issueId,
        messageId,
      ],
    );
  }

  /**
   * The one text nudge an unanswered decision card gets (MUL-412).
   *
   * Decisions do not expire (E4), so there is no deadline window to open and
   * close: the nudge is due a fixed offset after the card was sent, and
   * `reminder_sent_at` on the decision row is the single compare-and-set that
   * makes it once-only. A decision answered a second earlier produces nothing.
   */
  private materializeIssueDecisionRemindersWithinTransaction(
    workspaceId: string,
    now: Date,
    deferredEvents: import("@multiremi/store/context.js").CommitEventQueue,
  ): void {
    const threshold = new Date(now.getTime() - ISSUE_DECISION_CARD_REMINDER_DELAY_MS).toISOString();
    const due = this.ctx.db.query(
      `SELECT decision.id, decision.issue_id
       FROM multiremi_issue_decisions decision
       JOIN multiremi_issues issue ON issue.id = decision.issue_id
       WHERE decision.status = 'escalated' AND decision.reminder_sent_at IS NULL
         AND issue.workspace_id = ?
         AND (
           SELECT o.sent_at FROM multiremi_feishu_bot_outbound_deliveries o
           WHERE o.kind = 'decision_card' AND o.decision_id = decision.id
             AND o.status = 'sent' AND o.external_message_id IS NOT NULL
             AND o.degraded IS NULL AND o.sent_at IS NOT NULL
           ORDER BY o.created_at DESC, o.id DESC LIMIT 1
         ) <= ?
       ORDER BY decision.id ASC`,
    ).all(workspaceId, threshold) as Row[];
    for (const row of due) {
      const decision = this.ctx.issues().getIssueDecision(String(row.issue_id), String(row.id));
      if (!decision || decision.status !== "escalated") continue;
      const issueId = this.issueIdInWorkspace(workspaceId, decision.issueId);
      if (!issueId) continue;
      const issue = this.ctx.issues().getIssue(issueId)!;
      const card = this.ctx.db.query(
        `SELECT o.*
         FROM multiremi_feishu_bot_outbound_deliveries o
         WHERE o.kind = 'decision_card' AND o.decision_id = ?
           AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL
         ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
      ).get(decision.id) as Row | null;
      if (!card) continue;
      // Every check that could skip this row has passed, so the one-shot slot
      // is spent last: running the CAS earlier would burn the nudge on a row
      // this workspace never sends.
      const claimed = this.ctx.db.run(
        `UPDATE multiremi_issue_decisions SET reminder_sent_at = ?
         WHERE id = ? AND status = 'escalated' AND reminder_sent_at IS NULL`,
        [now.toISOString(), decision.id],
      );
      if (claimed.changes !== 1) continue;
      const recipientOpenId = cleanOptionalString(card.interaction_open_id);
      const mention = recipientOpenId
        ? { mode: "person" as const, openId: recipientOpenId, resolvedOpenId: recipientOpenId }
        : { mode: "none" as const, resolvedOpenId: null };
      const nowIsoValue = now.toISOString();
      const reminderCard = this.rotatedQuestionCard(card, recipientOpenId);
      if (!reminderCard) continue;
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
           id, workspace_id, binding_id, task_id, chat_id, thread_id,
           reply_to_message_id, body, status, available_at, created_at, updated_at,
           mention_snapshot, interaction_open_id, kind, decision_id, decision_issue_id, target_message_id
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'decision_reminder', ?, ?, ?)`,
        [
          createId("fbo"),
          issue.workspaceId,
          String(card.binding_id),
          String(card.chat_id),
          cleanOptionalString(card.thread_id),
          cleanOptionalString(card.reply_to_message_id),
          encodeDecisionCardBody({ card: reminderCard, fallback_text: issueDecisionReminderBody(issue, decision) }),
          nowIsoValue,
          nowIsoValue,
          nowIsoValue,
          toJson(mention),
          recipientOpenId,
          decision.id,
          decision.issueId,
          cleanOptionalString(card.external_message_id),
        ],
      );
      this.ctx.appendIssueActivity(issue.id, {
        actorType: "system",
        type: "decision_card_reminder",
        body: decision.id,
        data: { decision_id: decision.id },
      }, deferredEvents);
    }
  }

  /**
   * A host that restarted must be able to answer the decision cards still on
   * screen (MUL-412). Same shape as {@link listLiveDecisionCards}: the identity
   * the callback name is derived from plus the recipient the card was sent to.
   */
  listLiveIssueDecisionCards(workspaceId: string, runtimeId: string): Array<{
    decision_id: string;
    issue_id: string;
    chat_id: string;
    message_id: string;
    recipient_open_id: string;
  }> {
    if (!this.supportsIssueDecisionCard(workspaceId, runtimeId)) return [];
    const rows = this.ctx.db.query(
      `SELECT o.decision_id, o.chat_id, o.external_message_id, o.interaction_open_id,
              decision.issue_id
       FROM multiremi_feishu_bot_outbound_deliveries o
       JOIN multiremi_issue_decisions decision ON decision.id = o.decision_id
       WHERE o.workspace_id = ? AND o.kind = 'decision_card' AND o.status = 'sent'
         AND o.decision_id IS NOT NULL AND o.external_message_id IS NOT NULL
         AND o.interaction_open_id IS NOT NULL AND o.degraded IS NULL
         AND decision.status = 'escalated'
       ORDER BY o.created_at ASC, o.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map((row) => ({
      decision_id: String(row.decision_id),
      issue_id: String(row.issue_id),
      chat_id: String(row.chat_id),
      message_id: String(row.external_message_id),
      recipient_open_id: String(row.interaction_open_id),
    }));
  }

  /**
   * May this bot host read and answer this Issue's decisions (MUL-412)?
   *
   * Mirrors {@link canDaemonAccessIssueTaskHumanRequest}: the Issue must have an
   * active topic binding to this bot's configured app on a chat, and the token
   * must belong to the daemon that hosts it. Creating, escalating and
   * withdrawing stay with the executing side — this predicate only opens the
   * two verbs a card click needs.
   */
  canDaemonAccessIssueDecision(workspaceId: string, daemonId: string, issueId: string): boolean {
    return this.ctx.db.query(`SELECT 1 AS present
      FROM multiremi_feishu_bot_configs c
      JOIN multiremi_runtimes r ON r.id = c.runtime_id AND r.workspace_id = c.workspace_id
      JOIN multiremi_feishu_bot_chat_bindings b ON b.workspace_id = c.workspace_id AND b.app_id = c.app_id
      JOIN multiremi_chat_sessions s ON s.id = b.chat_session_id AND s.status = 'active'
      JOIN multiremi_issues i ON i.id = b.issue_id AND i.workspace_id = b.workspace_id
      WHERE c.workspace_id = ? AND c.enabled = 1 AND r.daemon_id = ?
        AND b.issue_id IS NOT NULL AND i.id = ? LIMIT 1`)
      .get(workspaceId, daemonId, issueId) != null;
  }

  /**
   * Resolve the Feishu operator behind a card click to a live workspace member
   * (MUL-412, S4 permission contract).
   *
   * An open_id is app-scoped. Direct `users.external_id` evidence is therefore
   * valid only when the configured SSO app is this bot app. Sender evidence is
   * likewise scoped by workspace + app + open_id before its union_id is used
   * to find users across apps. Never compare an open_id with a union_id.
   *
   * Sender rows are written by the trusted bot-host daemon API, which does not
   * independently verify Feishu event signatures. They prove only that this app
   * has seen the open_id, not that another app's open_id belongs to that person.
   * The daemon trust boundary is intentionally unchanged here.
   */
  resolveIssueDecisionOperatorMember(
    workspaceId: string,
    appId: string,
    openId: string | null | undefined,
  ): IssueDecisionOperatorMemberResolution {
    const id = cleanOptionalString(openId);
    const botAppId = cleanOptionalString(appId);
    if (!id || !botAppId) return { status: "unmapped" };
    const candidateUserIds = new Set<string>();
    const users = this.ctx.workspaces();

    if (loadLarkSsoConfig()?.appId === botAppId) {
      const rows = this.ctx.db.query(
        "SELECT id FROM multiremi_users WHERE external_id = ?",
      ).all(id) as Row[];
      for (const row of rows) candidateUserIds.add(String(row.id));
    }

    const senders = this.ctx.db.query(
      `SELECT union_id FROM multiremi_feishu_bot_senders
       WHERE workspace_id = ? AND app_id = ? AND open_id = ?`,
    ).all(workspaceId, botAppId, id) as Row[];
    for (const sender of senders) {
      const unionId = cleanOptionalString(sender.union_id);
      if (!unionId) continue;
      const rows = this.ctx.db.query(
        "SELECT id FROM multiremi_users WHERE feishu_union_id = ?",
      ).all(unionId) as Row[];
      for (const row of rows) candidateUserIds.add(String(row.id));
    }

    const candidates = new Map<string, MultiremiWorkspaceMember>();
    for (const userId of candidateUserIds) {
      const rows = this.ctx.db.query(
        "SELECT id FROM multiremi_workspace_members WHERE workspace_id = ? AND user_id = ?",
      ).all(workspaceId, userId) as Row[];
      for (const row of rows) {
        const member = users.getWorkspaceMember(String(row.id));
        if (!member || member.archivedAt) continue;
        // An agent's own account is never a valid answerer: S4 records the member
        // who answered, and an agent answer already has its own actor path.
        if (this.ctx.agents().getAgent(member.id)) continue;
        candidates.set(member.id, member);
      }
    }
    if (candidates.size === 0) return { status: "unmapped" };
    if (candidates.size > 1) return { status: "ambiguous" };
    return { status: "resolved", member: candidates.values().next().value! };
  }

  /**
   * The lane a card click needs to answer: the decision, its Issue's topic
   * binding, and the recipient. Returns null when the decision is not in this
   * workspace or has no live card, which the route reports as 404.
   */
  getIssueDecisionCardContext(workspaceId: string, decisionId: string): {
    decision: MultiremiIssueDecision;
    issue: MultiremiIssue;
    appId: string;
    chatId: string;
    messageId: string | null;
    recipientOpenId: string;
  } | null {
    const decision = this.ctx.issues().getIssueDecisionAnywhere(decisionId);
    if (!decision || decision.workspaceId !== workspaceId) return null;
    const issue = this.ctx.issues().getIssue(decision.issueId);
    if (!issue || issue.workspaceId !== workspaceId) return null;
    const row = this.ctx.db.query(
      `SELECT b.app_id, o.chat_id, o.external_message_id, o.interaction_open_id
       FROM multiremi_feishu_bot_outbound_deliveries o
       JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id AND b.workspace_id = o.workspace_id
       WHERE o.workspace_id = ? AND o.kind = 'decision_card' AND o.decision_id = ?
         AND o.degraded IS NULL
       ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
    ).get(workspaceId, decision.id) as Row | null;
    if (!row) return null;
    return {
      decision,
      issue,
      appId: String(row.app_id),
      chatId: String(row.chat_id ?? ""),
      messageId: cleanOptionalString(row.external_message_id),
      recipientOpenId: String(row.interaction_open_id ?? ""),
    };
  }

  private appendDecisionCardDegradedActivity(issueId: string, input: {
    decisionId: string;
    deliveryId: string;
    reason: string;
  }, deferredEvents: import("@multiremi/store/context.js").CommitEventQueue): void {
    // Same idempotency shape as the human-request degrade: the exact payload is
    // the key, so a repeated report cannot write the story twice.
    const data = {
      decision_id: input.decisionId,
      delivery_id: input.deliveryId,
      kind: "decision_card",
      reason: input.reason,
    };
    const alreadyRecorded = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_issue_activity
       WHERE issue_id = ? AND type = 'decision_card_degraded' AND data = ? LIMIT 1`,
    ).get(issueId, toJson(data)) as Row | null;
    if (alreadyRecorded) return;
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      type: "decision_card_degraded",
      body: input.decisionId,
      data,
    }, deferredEvents);
  }

  /**
   * A request that leaves `pending` must rewrite its card in place, no matter
   * where the answer came from (MUL-407). The patch is its own delivery so a
   * Feishu failure retries on the normal outbox backoff without touching the
   * original send or the request's own status.
   */
  enqueueDecisionCardPatch(request: MultiremiTaskHumanRequest, nowInput: string | Date = new Date()): void {
    const row = this.ctx.db.query(
      `SELECT o.id, o.workspace_id, o.binding_id, o.chat_id, o.thread_id,
              o.external_message_id, o.human_request_id, o.human_request_task_id, o.degraded
       FROM multiremi_feishu_bot_outbound_deliveries o
       WHERE o.kind = 'decision_card' AND o.human_request_id = ?
         AND o.degraded IS NULL
       ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
    ).get(request.id) as Row | null;
    // Nothing to patch when the card never left the outbox, was skipped, or went
    // out as text: a degraded request has no card on screen, and rewriting the
    // text message would replace the question with a receipt.
    const messageId = cleanOptionalString(row?.external_message_id);
    if (!row || !messageId) return;
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const nowIsoValue = now.toISOString();
    // One terminal patch per request: the answer may be written twice (web then
    // Feishu) but the card only needs the first terminal state.
    const existing = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_feishu_bot_outbound_deliveries
       WHERE kind = 'decision_card_patch' AND human_request_id = ? LIMIT 1`,
    ).get(request.id) as Row | null;
    if (existing) return;
    const card = buildTaskInteractionCard(request, {
      header: buildCardHeader({ agentName: this.botAgentName(String(row.workspace_id)) }),
      receipt: true,
    });
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at,
         kind, human_request_id, human_request_task_id, target_message_id
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?, 'decision_card_patch', ?, ?, ?)`,
      [
        createId("fbo"),
        String(row.workspace_id),
        String(row.binding_id),
        String(row.chat_id),
        cleanOptionalString(row.thread_id),
        messageId,
        // Written through the shared encoder: the host decodes the same shape,
        // which is what stops a terminal patch from landing as an empty card.
        encodeDecisionCardBody({ card }),
        nowIsoValue,
        nowIsoValue,
        nowIsoValue,
        request.id,
        cleanOptionalString(row.human_request_task_id),
        messageId,
      ],
    );
  }

  /**
   * Queue the one text nudge a pending decision card gets before its deadline.
   *
   * Deriving reminders at claim time is what keeps them correct: a request that
   * was answered a second earlier produces nothing, and `reminder_sent_at` is a
   * single compare-and-set so concurrent claims cannot each decide to nudge.
   * The window is [expires_at - lead, expires_at], so a host that was offline for
   * the whole window still delivers exactly one reminder when it comes back.
   */
  private materializeDecisionRemindersWithinTransaction(
    workspaceId: string,
    now: Date,
    deferredEvents: import("@multiremi/store/context.js").CommitEventQueue,
  ): void {
    const due = this.ctx.db.query(
      `SELECT request.id, request.task_id, request.expires_at, request.created_at
       FROM multiremi_task_human_requests request
       JOIN multiremi_tasks task ON task.id = request.task_id
      WHERE request.status = 'pending' AND request.reminder_sent_at IS NULL
         AND request.expires_at IS NOT NULL
         -- A reminder is worth sending only while it still leaves the reader
         -- time to act: under a minute of lifetime left, the nudge would arrive
         -- as the request expires. The bound is the same expression the CAS and
         -- the claim use, so SQLite and Postgres agree.
         AND request.expires_at >= ?
         AND task.issue_id IS NOT NULL AND task.workspace_id = ?
         AND (
           SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries o
           WHERE o.kind = 'decision_card' AND o.human_request_id = request.id
             AND o.status = 'sent' AND o.external_message_id IS NOT NULL
             AND o.degraded IS NULL
         ) > 0
       ORDER BY request.expires_at ASC, request.id ASC`,
    ).all(new Date(now.getTime() + ISSUE_DECISION_REMINDER_MIN_REMAINING_MS).toISOString(), workspaceId) as Row[];
    for (const row of due) {
      // A reminder is due once the deadline is within its lead. The lead is
      // half the request's lifetime, capped at ten minutes, so a five-minute
      // autopilot request is not already due when its card is sent.
      const leadMs = decisionReminderLeadMs(String(row.expires_at), String(row.created_at));
      const dueAt = Date.parse(String(row.expires_at)) - leadMs;
      if (now.getTime() < dueAt) continue;
      // Resolve and validate the whole target before touching `reminder_sent_at`.
      // The CAS is the one-shot slot, so it must not be spent on a row this
      // workspace will not remind for. The due query already scopes the Task to
      // this workspace; the Issue is re-checked so an inconsistent `issue_id`
      // cannot aim the reminder (and its activity) at another workspace.
      const request = this.ctx.tasks().getTaskHumanRequest(String(row.id));
      const task = this.ctx.tasks().getTask(String(row.task_id));
      if (!request || !task || task.workspaceId !== workspaceId) continue;
      const issueId = this.issueIdInWorkspace(workspaceId, task.issueId);
      if (!issueId) continue;
      const issue = this.ctx.issues().getIssue(issueId)!;
      // A card that has not gone out yet must not consume the one reminder: the
      // push is usually still inside its first attempt when a short request
      // enters the window. The claim for the send materializes it instead.
      const sent = this.ctx.db.query(
        `SELECT 1 AS present FROM multiremi_feishu_bot_outbound_deliveries
         WHERE kind = 'decision_card' AND human_request_id = ?
           AND status = 'sent' AND external_message_id IS NOT NULL AND degraded IS NULL
         LIMIT 1`,
      ).get(String(row.id)) as Row | null;
      if (!sent) continue;
      const card = this.ctx.db.query(
        `SELECT o.*
         FROM multiremi_feishu_bot_outbound_deliveries o
         WHERE o.kind = 'decision_card' AND o.human_request_id = ?
           AND o.status = 'sent' AND o.external_message_id IS NOT NULL AND o.degraded IS NULL
         ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
      ).get(request.id) as Row | null;
      if (!card) continue;
      // Every check that can reject the reminder has passed, so now spend the
      // one-shot slot. Running the CAS before them would burn it on a row that
      // is skipped: a cross-workspace Task would lose its reminder forever.
      const claimed = this.ctx.db.run(
        `UPDATE multiremi_task_human_requests SET reminder_sent_at = ?
         WHERE id = ? AND status = 'pending' AND reminder_sent_at IS NULL
           AND expires_at IS NOT NULL AND expires_at >= ?`,
        [now.toISOString(), String(row.id),
          new Date(now.getTime() + ISSUE_DECISION_REMINDER_MIN_REMAINING_MS).toISOString()],
      );
      if (claimed.changes !== 1) continue;
      // @ the person who was asked. The checkpoint on the card is what the
      // host actually used, so a `group_owner` lookup that succeeded once is
      // reused instead of being re-resolved (and possibly failing) here.
      const recipientOpenId = cleanOptionalString(card.interaction_open_id);
      const mention = recipientOpenId
        ? { mode: "person" as const, openId: recipientOpenId, resolvedOpenId: recipientOpenId }
        : { mode: "none" as const, resolvedOpenId: null };
      const nowIsoValue = now.toISOString();
      const reminderCard = this.rotatedQuestionCard(card, recipientOpenId);
      if (!reminderCard) continue;
      this.ctx.db.run(
        `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
           id, workspace_id, binding_id, task_id, chat_id, thread_id,
           reply_to_message_id, body, status, available_at, created_at, updated_at,
           mention_snapshot, interaction_open_id, kind, human_request_id, expires_at, target_message_id
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'decision_reminder', ?, ?, ?)`,
        [
          createId("fbo"),
          issue.workspaceId,
          String(card.binding_id),
          String(card.chat_id),
          cleanOptionalString(card.thread_id),
          cleanOptionalString(card.reply_to_message_id),
          encodeDecisionCardBody({ card: reminderCard, fallback_text: decisionReminderBody(issue, request) }),
          nowIsoValue,
          nowIsoValue,
          nowIsoValue,
          mention ? toJson(mention) : null,
          recipientOpenId,
          request.id,
          request.expiresAt ?? null,
          cleanOptionalString(card.external_message_id),
        ],
      );
      this.ctx.appendIssueActivity(issue.id, {
        actorType: "system",
        type: "decision_card_reminder",
        body: request.id,
        data: { request_id: request.id, expires_at: request.expiresAt ?? null },
      }, deferredEvents);
    }
  }

  /**
   * Cards that a bot host must be able to answer, for its startup recovery
   * (MUL-407). The click handler lives in the host process; a restart empties
   * it, and unlike a Task-stream card there is no presentation checkpoint to
   * rebuild from. Re-registering from the delivery row is what keeps a button
   * on screen working across a restart, so this returns the identity the
   * callback name is derived from plus the recipient the card was sent to.
   */
  listLiveDecisionCards(workspaceId: string, runtimeId: string): Array<{
    request_id: string;
    task_id: string;
    chat_id: string;
    message_id: string;
    recipient_open_id: string;
  }> {
    if (!this.supportsDecisionCard(workspaceId, runtimeId)) return [];
    const rows = this.ctx.db.query(
      `SELECT o.human_request_id, o.human_request_task_id, o.chat_id,
              o.external_message_id, o.interaction_open_id
       FROM multiremi_feishu_bot_outbound_deliveries o
       JOIN multiremi_task_human_requests request
         ON request.id = o.human_request_id AND request.status = 'pending'
       WHERE o.workspace_id = ? AND o.kind = 'decision_card' AND o.status = 'sent'
         AND o.human_request_id IS NOT NULL AND o.human_request_task_id IS NOT NULL
         AND o.external_message_id IS NOT NULL AND o.interaction_open_id IS NOT NULL
         AND o.degraded IS NULL
       ORDER BY o.created_at ASC, o.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map((row) => ({
      // Snake_case, like every other field the daemon protocol carries. The
      // client parser reads exactly these keys; emitting camelCase here
      // silently produced zero recoverable cards, which is what QA caught.
      request_id: String(row.human_request_id),
      task_id: String(row.human_request_task_id),
      chat_id: String(row.chat_id),
      message_id: String(row.external_message_id),
      recipient_open_id: String(row.interaction_open_id),
    }));
  }

  /**
   * The Issue a delivery belongs to, so a host-reported outcome can be recorded
   * on the same timeline the queue entry was. Returns null when the row is not
   * an Issue lane (a Chat reply has no Issue to write to).
   */
  /**
   * Resolve an Issue id to one this workspace may write to (MUL-407).
   *
   * Binding rows, Tasks and requests all carry a plain `issue_id` pointer that
   * can be stale, hand-edited or left behind by a move. Every reverse lookup in
   * this file funnels through here so the workspace check is applied once: one
   * workspace must never record an outcome on another workspace's Issue.
   */
  private issueIdInWorkspace(workspaceId: string, issueId: unknown): string | null {
    const id = cleanOptionalString(issueId);
    if (!id) return null;
    const issue = this.ctx.issues().getIssue(id);
    return issue && issue.workspaceId === workspaceId ? issue.id : null;
  }

  private issueIdForDeliveryRow(workspaceId: string, row: Row): string | null {
    // A decision lane names its Issue directly: it has no binding of its own
    // reason to resolve, and the asking Task column it would otherwise fall
    // back to is NULL for these rows (MUL-412).
    const decisionIssueId = this.issueIdInWorkspace(workspaceId, row.decision_issue_id);
    if (decisionIssueId) return decisionIssueId;
    const direct = this.ctx.db.query(
      `SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE id = ? AND workspace_id = ?`,
    ).get(String(row.binding_id), workspaceId) as Row | null;
    // The binding row belongs to this workspace, but its `issue_id` is what
    // actually selects the timeline the activity is written to, so the Issue
    // itself has to be checked too.
    const directIssueId = this.issueIdInWorkspace(workspaceId, direct?.issue_id);
    if (directIssueId) return directIssueId;
    // Falling back to the asking Task is only safe when both the Task and its
    // Issue belong to this delivery's workspace. A stale or hand-written task id
    // would otherwise let one workspace write its activity onto another
    // workspace's Issue (MUL-407).
    const taskId = cleanOptionalString(row.human_request_task_id);
    const task = taskId ? this.ctx.tasks().getTask(taskId) : null;
    if (!task || task.workspaceId !== workspaceId) return null;
    return this.issueIdInWorkspace(workspaceId, task.issueId);
  }

  /**
   * One activity type for every degradation, whoever decided it (MUL-407).
   *
   * The control plane writes this when it already knows nobody is addressable;
   * the host writes it when its own `group_owner` lookup fails or Feishu refuses
   * the card. Sharing the type and the fields means an operator reading the
   * Issue sees one story rather than two dialects of the same event.
   */
  private appendDecisionDegradedActivity(issueId: string, input: {
    requestId: string | null;
    sourceTaskId: string | null;
    deliveryId: string;
    reason: string;
  }, deferredEvents: import("@multiremi/store/context.js").CommitEventQueue): void {
    // The row's own `degraded` column is the first guard: `degraded =
    // COALESCE(?, degraded)` already committed inside this transaction, so a
    // repeat report cannot reach this method. This second check makes the
    // insert itself idempotent, keyed on the exact payload shape both backends
    // store (no JSON path functions, which SQLite and Postgres spell
    // differently).
    const data = {
      request_id: input.requestId,
      source_task_id: input.sourceTaskId,
      delivery_id: input.deliveryId,
      kind: "decision_card",
      reason: input.reason,
    };
    const alreadyRecorded = this.ctx.db.query(
      `SELECT 1 AS present FROM multiremi_issue_activity
       WHERE issue_id = ? AND type = 'decision_card_degraded' AND data = ? LIMIT 1`,
    ).get(issueId, toJson(data)) as Row | null;
    if (alreadyRecorded) return;
    this.ctx.appendIssueActivity(issueId, {
      actorType: "system",
      type: "decision_card_degraded",
      body: input.requestId,
      data,
    }, deferredEvents);
  }

  /** The Agent's name is the card's conversation label for a server-built card. */
  private botAgentName(workspaceId: string): string | null {
    const config = this.getConfig(workspaceId);
    if (!config) return null;
    return this.ctx.agents().getAgent(config.agentId)?.name ?? null;
  }

  /**
   * Non-transactional entry point for callers that own no transaction (tests,
   * standalone tooling): it opens the only transaction itself and publishes
   * everything after COMMIT. Production terminal paths call the `Within...`
   * variant with the queue they already own.
   */
  prepareIssueRoundPushes(input: {
    issue: MultiremiIssue;
    leaderTask: MultiremiTask;
  }): MultiremiTask[] {
    const childStatusChanges: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEvents = createCommitEventQueue();
    const tasks = this.ctx.db.transaction(() =>
      this.prepareIssueRoundPushesWithinTransaction({ ...input, childStatusChanges, deferredEvents }))();
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChanges);
    this.ctx.emitCommitEvents(deferredEvents);
    for (const task of tasks) this.ctx.notifyTaskEnqueued(task);
    return tasks;
  }

  /** Caller owns the terminal-task transaction. Both the collector and the
   * queue are required: this writer produces Issue transitions and realtime
   * pushes, and neither may be dropped or sent before COMMIT (MUL-400 S1). */
  prepareIssueRoundPushesWithinTransaction(input: {
    issue: MultiremiIssue;
    leaderTask: MultiremiTask;
    /** Caller-owned collector for Issue transitions these fresh rounds produce. */
    childStatusChanges: import("./tasks-repo.js").ChildStatusChangeCollector;
    /** Caller-owned queue for the realtime pushes these rounds would emit. */
    deferredEvents: import("@multiremi/store/context.js").CommitEventQueue;
  }): MultiremiTask[] {
    const childStatusChanges = input.childStatusChanges;
    const deferredEvents = input.deferredEvents;
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
        this.ctx.tasks().createTaskSteerMessageWithinTransaction({
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
        }, childStatusChanges, deferredEvents);
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
    // This claim owns its own transaction, so it owns the queue too: the
    // reminder activity below is written before COMMIT and published after it.
    const deferredEvents = createCommitEventQueue();
    const claimed = this.ctx.db.transaction(() => {
      const nowIsoValue = now.toISOString();
      // The reminder lane is materialized here rather than at request creation:
      // a request answered before its window closes must never produce one, and
      // `reminder_sent_at` is the single dedupe record. Doing it inside the claim
      // transaction means a host that polls continuously still queues one nudge.
      this.materializeDecisionRemindersWithinTransaction(workspaceId, now, deferredEvents);
      this.materializeIssueDecisionRemindersWithinTransaction(workspaceId, now, deferredEvents);
      // A decision lane only exists for a host that advertised the capability.
      // The filter belongs in SQL, not after the pick: skipping in JavaScript
      // would return null and strand every later delivery behind one row this
      // host cannot render — including ordinary replies in the same app. The
      // unclaimed row stays pending for a host that declares the capability.
      // Two capabilities gate two card families (MUL-407, MUL-412). A decision
      // lane needs the decision flag; a human-request lane needs the S5a one.
      // Both are re-advertised on every heartbeat, so a host that lost a flag
      // simply stops being handed that family — the rows stay pending for a
      // build that declares it. A degraded row is plain text, so any host may
      // send it, and a `*_patch` cannot exist for a degraded request (the
      // control plane never queues one), so blocking costs nothing there.
      const decisionsCapable = this.supportsIssueDecisionCard(workspaceId, runtimeId);
      const humanRequestsCapable = this.supportsDecisionCard(workspaceId, runtimeId);
      const plainTextRow = "o.kind IS NULL OR o.kind = '' OR o.degraded IS NOT NULL";
      const decisionFilter = decisionsCapable && humanRequestsCapable
        ? ""
        : decisionsCapable
          // Decision cards yes; a human-request card would strand this host.
          ? `AND (${plainTextRow} OR o.decision_id IS NOT NULL)`
          : humanRequestsCapable
            ? `AND (${plainTextRow} OR o.decision_id IS NULL)`
            : `AND (${plainTextRow})`;
      const row = this.ctx.db.query(
        `SELECT o.* FROM multiremi_feishu_bot_outbound_deliveries o
         JOIN multiremi_feishu_bot_chat_bindings b ON b.id = o.binding_id
         WHERE o.workspace_id = ? AND b.app_id = ?
           ${decisionFilter}
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
      const kind = cleanOptionalString(row.kind);
      let mention = parseOutboundMention(parseJson(row.mention_snapshot, null));
      if (supportsTaskStream && row.task_id && !row.mention_snapshot) {
        // An old relay row derives its @ here, and that read is the one place a
        // stored config could still abort the heartbeat that claims this row:
        // one claim returns one row, so a throw here would strand this delivery
        // and, on this host, the rows behind it — including the text
        // degradation of a request this workspace already accepted. Only an
        // invalid config is tolerated; an unknown failure still propagates
        // (MUL-407).
        let topics: IssueTopicConfig | null = null;
        try {
          topics = readWorkspaceIssueTopics(this.ctx.workspaces().getWorkspace(workspaceId)?.settings ?? {});
        } catch (error) {
          if (!(error instanceof IssueTopicConfigError)) throw error;
          // Never log the raw config: the unusable value is usually an open_id.
          log.warn(`Feishu outbound claim: ignoring an invalid issueTopics config for ${workspaceId}`);
        }
        if (topics?.enabled && topics.chatId === row.chat_id) {
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
      if ((kind === "decision_card" || kind === "decision_reminder") && !row.degraded && Number(row.attempt_count) > 0) {
        const card = this.rotatedQuestionCard(row, cleanOptionalString(row.interaction_open_id));
        if (card) {
          row.body = encodeDecisionCardBody({ card, fallback_text: decodeDecisionCardBody(String(row.body))?.fallback_text });
          this.ctx.db.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET body = ? WHERE id = ?", [row.body, String(row.id)]);
        }
      }
      return {
        ...outboundDelivery(row, claimToken),
        // The decision lanes carry their own recipient checkpoint and need no
        // Task stream, so they read these outside the `task_id` branch.
        ...(kind ? {
          ...(mention ? { mention } : {}),
          ...(row.interaction_open_id ? { interactionOpenId: String(row.interaction_open_id) } : {}),
        } : {}),
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
    this.ctx.emitCommitEvents(deferredEvents);
    return claimed;
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
      /**
       * Decision lanes only (MUL-407). The recipient the host actually
       * addressed, checkpointed with the send so the reminder can @ them
       * without repeating the lookup, and the reason a card went out as text.
       */
      interactionOpenId?: string | null;
      degraded?: FeishuDecisionDegradeReason | null;
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
    // This report owns its own transaction, so it owns the queue: the degrade
    // activity is written before COMMIT and published after it.
    const deferredEvents = createCommitEventQueue();
    if (input.status === "sent") {
      const sent = this.ctx.db.transaction(() => {
        const row = this.ctx.db.query(
          `SELECT binding_id, chat_id, reply_to_message_id, task_id, attachments,
                  kind, human_request_id, human_request_task_id, decision_id, decision_issue_id, degraded, body
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
               claim_token = NULL, leased_until = NULL, last_error = NULL, updated_at = ?,
               interaction_open_id = COALESCE(?, interaction_open_id),
               degraded = COALESCE(?, degraded)
           WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?`,
          [externalMessageId, sentAt, sentAt,
            cleanOptionalString(input.interactionOpenId),
            cleanOptionalString(input.degraded),
            deliveryId, workspaceId, input.claimToken],
        );
        if (updated.changes !== 1) return false;
        const card = decodeDecisionCardBody(String(row.body))?.card;
        const action = card ? questionCardAction(card) : null;
        const recipient = cleanOptionalString(input.interactionOpenId);
        if (action && recipient && !input.degraded) {
          const table = row.decision_id ? "multiremi_issue_decisions" : "multiremi_task_human_requests";
          this.ctx.db.run(
            `UPDATE ${table} SET token_recipient = COALESCE(token_recipient, ?)
             WHERE id = ? AND token_hash = ? AND token_consumed_at IS NULL`,
            [recipient, String(action.r), hashQuestionCardToken(String(action.t))],
          );
        }
        // A degrade the host decided (a `group_owner` lookup that came back
        // empty, or a card Feishu refused) is as much a part of the request's
        // story as one the control plane decided up front, so it gets the same
        // activity and the same fields. `degraded = COALESCE(?, degraded)` above
        // means a repeated report cannot write it twice, and the guarded insert
        // below keeps that true even when two reports race.
        const reportedDegrade = cleanOptionalString(input.degraded);
        if (reportedDegrade && !cleanOptionalString(row.degraded)) {
          const issueId = this.issueIdForDeliveryRow(workspaceId, row);
          const decisionId = cleanOptionalString(row.decision_id);
          if (issueId && decisionId) {
            this.appendDecisionCardDegradedActivity(issueId, { decisionId, deliveryId, reason: reportedDegrade }, deferredEvents);
          } else if (issueId) {
            this.appendDecisionDegradedActivity(issueId, {
              requestId: cleanOptionalString(row.human_request_id),
              sourceTaskId: cleanOptionalString(row.human_request_task_id),
              deliveryId,
              reason: reportedDegrade,
            }, deferredEvents);
          }
        }
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
      this.ctx.emitCommitEvents(deferredEvents);
      return sent;
    }
    return this.ctx.db.transaction(() => {
      const row = this.ctx.db.query(
        `SELECT attempt_count, body FROM multiremi_feishu_bot_outbound_deliveries
         WHERE id = ? AND workspace_id = ? AND status = 'sending' AND claim_token = ?`,
      ).get(deliveryId, workspaceId, input.claimToken) as Row | null;
      if (!row) return false;
      const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(6, Math.max(0, Number(row.attempt_count) - 1)));
      const terminal = input.retryable === false || Number(row.attempt_count) >= 6;
      const card = decodeDecisionCardBody(String(row.body))?.card;
      const token = card ? questionCardAction(card)?.t : null;
      const detail = cleanOptionalString(input.error) ?? "Feishu send failed";
      const error = (typeof token === "string" ? detail.replaceAll(token, "[REDACTED]") : detail).slice(0, 2_000);
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

  /**
   * Resolve and execute one Feishu stop request.
   *
   * The Feishu client's CoT "中断" control sends a plain `@bot /stop` text
   * (single chat: `/stop`) as a *new top-level* message, so it carries no
   * thread lineage back to the run the user was watching. Resolution therefore
   * has three levels:
   *
   * 1. The conversation key the connector derived (`chatId` in a single chat,
   *    `chatId:thread:rootId` inside a topic) — the precise case.
   * 2. Group top-level messages: the sender's own unfinished Tasks in this
   *    chat. Exactly one candidate can be stopped; several stay untouched and
   *    come back as a shortlist, because stopping the wrong long run is
   *    irreversible while asking again is cheap.
   * 3. Nothing — report "none" without writing anything.
   *
   * A request naming an explicit target (`/stop <task_id|Issue key>`) is only
   * honoured inside the sender's own candidate set, so an id cannot be used to
   * stop someone else's work.
   *
   * Scope: exactly one Chat Task is cancelled — the concierge run bound to this
   * conversation. Work this run delegated carries `parent_task_id` pointing
   * back at it, but that edge records what triggered the work, not whose run it
   * belongs to: delegated and Issue-side Tasks have no `chat_session_id` and
   * keep running. Stopping the Feishu conversation must not end Issue work.
   */
  cancelSessionTask(
    workspaceId: string,
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
    options: { chatId?: string | null; senderOpenId?: string | null; target?: string | null } = {},
  ): FeishuBotCancelResult {
    const config = this.getConfig(workspaceId);
    if (!config || config.runtimeId !== runtimeId || config.revision !== revision) {
      return rejectedCancel("stale_assignment");
    }
    const key = requiredBoundedString(externalSessionKey, "external_session_key", 1_024);
    const target = cleanOptionalString(options.target ?? null);
    const senderOpenId = cleanOptionalString(options.senderOpenId ?? null);
    const chatId = cleanOptionalString(options.chatId ?? null);

    const bindings = this.ctx.db.query(
      `SELECT chat_session_id FROM multiremi_feishu_bot_chat_bindings
        WHERE workspace_id = ? AND app_id = ? AND external_session_key = ?
        ORDER BY updated_at DESC, id DESC`,
    ).all(workspaceId, config.appId, key) as Row[];
    const sessionTargets: ResolvedCancelTarget[] = [];
    const seenSessions = new Set<string>();
    for (const binding of bindings) {
      const chatSessionId = String(binding.chat_session_id);
      if (seenSessions.has(chatSessionId)) continue;
      seenSessions.add(chatSessionId);
      const task = this.ctx.chat().getPendingChatTask(chatSessionId);
      if (task) sessionTargets.push(this.describeCancelTarget(task, chatId));
    }

    const candidates = chatId && senderOpenId
      ? this.listCancelCandidates(workspaceId, config.appId, chatId, senderOpenId, seenSessions)
      : [];

    if (target) {
      const match = [...sessionTargets, ...candidates]
        .find((candidate) => candidate.task.id === target || candidate.issueKey === target);
      if (!match) return rejectedCancel("target_not_candidate");
      this.ctx.tasks().cancelTask(match.task.id);
      return cancelledCancel(match);
    }

    if (sessionTargets.length) {
      for (const candidate of sessionTargets) this.ctx.tasks().cancelTask(candidate.task.id);
      return cancelledCancel(sessionTargets[0]!);
    }
    const resolution = resolveFallbackCancelTarget(candidates);
    if (resolution.kind === "target") {
      this.ctx.tasks().cancelTask(resolution.target.task.id);
      return cancelledCancel(resolution.target);
    }
    if (resolution.kind === "ambiguous") {
      return {
        outcome: "ambiguous",
        agentName: null,
        taskId: null,
        issueKey: null,
        chatTitle: null,
        candidates: candidates.slice(0, MAX_STOP_CANDIDATES).map(toCancelCandidate),
        candidateCount: resolution.count,
        reason: null,
      };
    }
    return {
      outcome: "none",
      agentName: null,
      taskId: null,
      issueKey: null,
      chatTitle: null,
      candidates: [],
      candidateCount: 0,
      reason: null,
    };
  }

  /**
   * The sender's own unfinished Tasks in one chat.
   *
   * "Unfinished" reuses the Chat queue's pending statuses instead of inventing
   * a second definition, and a Task whose newest inbound delivery cannot be
   * attributed to this sender is excluded rather than assumed.
   */
  private listCancelCandidates(
    workspaceId: string,
    appId: string,
    chatId: string,
    senderOpenId: string,
    excludedChatSessionIds: Set<string>,
  ): ResolvedCancelTarget[] {
    const rows = this.ctx.db.query(
      `SELECT b.chat_session_id
         FROM multiremi_feishu_bot_chat_bindings b
        WHERE b.workspace_id = ? AND b.app_id = ? AND b.chat_id = ?
          AND b.external_session_key NOT LIKE '%:closed:%'
        ORDER BY b.updated_at DESC, b.id DESC`,
    ).all(workspaceId, appId, chatId) as Row[];
    const seen = new Set(excludedChatSessionIds);
    const targets: ResolvedCancelTarget[] = [];
    for (const row of rows) {
      const chatSessionId = String(row.chat_session_id);
      if (seen.has(chatSessionId)) continue;
      seen.add(chatSessionId);
      const task = this.ctx.chat().getPendingChatTask(chatSessionId);
      if (!task) continue;
      if (!this.isTaskOwnedBySender(workspaceId, task.id, senderOpenId)) continue;
      targets.push(this.describeCancelTarget(task, chatId));
    }
    targets.sort((a, b) => compareCancelTargets(a.task, b.task));
    return targets;
  }

  /** Whether the newest inbound delivery for this Task belongs to the sender. */
  private isTaskOwnedBySender(workspaceId: string, taskId: string, senderOpenId: string): boolean {
    const row = this.ctx.db.query(
      `SELECT s.open_id AS open_id
         FROM multiremi_feishu_bot_deliveries d
         JOIN multiremi_feishu_bot_senders s ON s.id = d.sender_id
        WHERE d.workspace_id = ? AND d.task_id = ?
        ORDER BY d.created_at DESC, d.external_message_id DESC
        LIMIT 1`,
    ).get(workspaceId, taskId) as Row | null;
    return Boolean(row) && String(row!.open_id) === senderOpenId;
  }

  private describeCancelTarget(task: MultiremiTask, chatId: string | null): ResolvedCancelTarget {
    const agent = this.ctx.agents().getAgent(task.agentId);
    const issue = task.issueId ? this.ctx.issues().getIssue(task.issueId) : null;
    const chat = task.chatSessionId ? this.ctx.chat().getChatSession(task.chatSessionId) : null;
    return {
      task,
      agentName: agent?.name ?? null,
      issueKey: issue?.key ?? null,
      chatTitle: chat?.title ?? chatId,
    };
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
    // The directive only needs `enabled` and `chatId`, and it runs on every
    // heartbeat, before the outbound claim. A stored config the save-time
    // validation would reject — most often a `person` target written before
    // that validation existed — must not 500 the heartbeat: that is the same
    // request the delivery path below has already degraded to text (MUL-407).
    const topics = readWorkspaceIssueTopicsForDelivery(
      this.ctx.workspaces().getWorkspace(workspaceId)?.settings ?? {});
    return { revision, desired_state: "running", config_available: true,
      no_mention_chat_ids: topics.enabled && topics.chatId ? [topics.chatId] : [],
    };
  }

  getRuntimeStatus(workspaceId: string, runtimeId: string): MultiremiFeishuBotRuntimeStatus | null {
    // Read once for the runtime directive and once for the outbound claim in the same heartbeat.
    const cache = activeRequestReadCache();
    const key = cacheKey("multiremi_feishu_bot_runtime_states", "row", workspaceId, runtimeId);
    const cached = cache?.get<Row | null>(key);
    if (cached !== undefined) return cached ? mapRuntimeStatus(cached) : null;
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_runtime_states WHERE workspace_id = ? AND runtime_id = ?")
      .get(workspaceId, runtimeId) as Row | null;
    cache?.set(key, row);
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

  /**
   * `seq` is read as `MAX(seq) + 1` and the audit trail is ordered by it
   * (MUL-405), so concurrent writers must not read the same maximum. The read
   * and the insert share one transaction that first takes the per-workspace
   * number lock; callers already inside a transaction (sender allow/revoke, the
   * disable paths) join it and keep their own commit boundary.
   */
  recordAudit(
    workspaceId: string,
    action: FeishuBotAuditAction,
    input: { actorType?: string; actorId?: string | null; details?: Record<string, unknown> } = {},
  ): MultiremiFeishuBotAuditEntry {
    return this.ctx.db.transaction(() => this.recordAuditWithinTransaction(workspaceId, action, input))();
  }

  /** Caller already holds the transaction that takes the number lock. */
  private recordAuditWithinTransaction(
    workspaceId: string,
    action: FeishuBotAuditAction,
    input: { actorType?: string; actorId?: string | null; details?: Record<string, unknown> },
  ): MultiremiFeishuBotAuditEntry {
    // Global lock order (MUL-405, see store/advisory-locks.ts): the workspace
    // lifecycle row lock precedes the number lock. Callers that already hold it
    // (sender allow/revoke, the disable paths) re-lock the same row for free.
    this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
    advisoryXactLock(this.ctx.db, numberAllocationLockKey(`feishu-bot-audit:${workspaceId}`));
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
    // A heartbeat reads this for the runtime directive and again when it claims an outbound
    // message. Any write to the table clears the entry.
    const cache = activeRequestReadCache();
    const key = cacheKey("multiremi_feishu_bot_configs", "workspace", workspaceId);
    const cached = cache?.get<Row | null>(key);
    if (cached !== undefined) return cached;
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ?")
      .get(workspaceId) as Row | null;
    cache?.set(key, row);
    return row;
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

/** How long before its deadline a pending card gets its one nudge. */
export const ISSUE_DECISION_REMINDER_MAX_LEAD_MS = 10 * 60 * 1000;

/**
 * When the one reminder for a request is due (MUL-407).
 *
 * Ten minutes is the ceiling, not the rule: an unattended autopilot request
 * defaults to a five-minute lifetime, so a flat ten-minute lead would mark the
 * reminder due the instant the card went out. Half the lifetime keeps the nudge
 * meaningful for short deadlines without changing anything for long ones.
 */
export function decisionReminderLeadMs(expiresAt: string | null | undefined, createdAt: string): number {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const start = Date.parse(createdAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(start) || expiry <= start) return ISSUE_DECISION_REMINDER_MAX_LEAD_MS;
  return Math.min(ISSUE_DECISION_REMINDER_MAX_LEAD_MS, Math.floor((expiry - start) / 2));
}

/** A reminder is still worth sending only while this much lifetime remains. */
export const ISSUE_DECISION_REMINDER_MIN_REMAINING_MS = 60 * 1000;

/**
 * Decide who may press a decision card's button, from the topic's notify mode.
 * `group_owner` is deliberately `host_resolved`: only the bot host holds the
 * token that can read the chat owner.
 */
export type DecisionRecipientResolution =
  | { kind: "resolved"; openId: string; degraded: false }
  | { kind: "host_resolved"; degraded: false }
  | { kind: "degraded"; reason: FeishuDecisionDegradeReason; degraded: true };

export function resolveDecisionRecipient(topics: IssueTopicConfig): DecisionRecipientResolution {
  const mode = topics.notifyMode ?? "group_owner";
  if (mode === "none") return { kind: "degraded", reason: "notify_none", degraded: true };
  if (mode === "person") {
    return isFeishuOpenId(topics.notifyOpenId)
      ? { kind: "resolved", openId: topics.notifyOpenId, degraded: false }
      : { kind: "degraded", reason: "invalid_recipient", degraded: true };
  }
  return { kind: "host_resolved", degraded: false };
}

/**
 * The plain-text degradation of a decision card (MUL-407). It must carry
 * everything the card carried: the question, its numbered options, and a link
 * to the parent Issue's web workbench.
 */
export function decisionCardTextBody(input: {
  issue: Pick<MultiremiIssue, "id" | "key" | "title">;
  workspaceSlug?: string | null;
  publicUrl?: string | null;
  request: MultiremiTaskHumanRequest;
}): string {
  const { issue, request } = input;
  const payload = request.payload ?? {};
  const lines = [
    `**${issue.key} - ${issue.title}**`,
    "",
    request.kind === "permission"
      ? "任务在等你确认一项操作，需要你在 Remi 里点一下。"
      : "任务在等你回答一个问题，需要你在 Remi 里点一下。",
  ];
  const message = cleanOptionalString(payload.message);
  if (message) lines.push("", message);
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (questions.length) {
    lines.push("");
    questions.forEach((question, index) => {
      const row = (question ?? {}) as Record<string, unknown>;
      const nested = (row.question ?? {}) as Record<string, unknown>;
      const source = typeof nested === "object" && nested !== null && nested.question ? nested : row;
      lines.push(`${questions.length > 1 ? `${index + 1}. ` : ""}${String(source.question ?? "问题")}`);
      const options = Array.isArray(source.options) ? source.options : [];
      options.forEach((option, optionIndex) => {
        const item = (option ?? {}) as Record<string, unknown>;
        lines.push(`  ${optionIndex + 1}. ${String(item.label ?? item.value ?? "选项")}`);
      });
    });
  }
  const options = Array.isArray(payload.options) ? payload.options : [];
  if (options.length) {
    const title = String((payload.tool_call as Record<string, unknown> | undefined)?.title ?? "操作审批");
    lines.push("", `**${title}**`);
    options.forEach((option, index) => {
      const item = (option ?? {}) as Record<string, unknown>;
      lines.push(`${index + 1}. ${String(item.name ?? item.optionId ?? item.option_id ?? "选项")}`);
    });
  }
  const link = issueWebUrl(input);
  lines.push("", link
    ? `请在 Remi 工作台处理：[${issue.key}](${link})`
    : "请在 Remi 工作台处理此请求。");
  return lines.join("\n");
}

function decisionReminderBody(
  issue: Pick<MultiremiIssue, "id" | "key" | "title">,
  request: MultiremiTaskHumanRequest,
): string {
  const message = cleanOptionalString(request.payload?.message);
  return [
    `**${issue.key} - ${issue.title}**`,
    "",
    // No "card" wording: the same nudge follows a plain-text degradation.
    request.kind === "permission"
      ? "上面的确认请求还没人处理，再过一会儿就会超时。"
      : "上面这个问题还没人回答，再过一会儿就会超时。",
    ...(message ? ["", message] : []),
    "",
    "超时会视为未回答，未获授权的操作不会继续。",
  ].join("\n");
}

/**
 * How long an unanswered decision card waits before its one text nudge
 * (MUL-412). The 50 minutes is a fixed offset, not a deadline: an E4 decision
 * never expires, so there is no window to close — the nudge exists only to
 * pull an unanswered card back to the top of the topic.
 */
export const ISSUE_DECISION_CARD_REMINDER_DELAY_MS = 50 * 60 * 1000;

/**
 * The plain-text degradation of a decision card (MUL-412). It carries the
 * question, its numbered options and the parent Issue's workbench link, which
 * is everything a reader needs to act without the card.
 */
export function issueDecisionCardTextBody(input: {
  issue: Pick<MultiremiIssue, "id" | "key" | "title">;
  workspaceSlug?: string | null;
  publicUrl?: string | null;
  decision: Pick<MultiremiIssueDecision, "kind" | "title" | "body" | "options">;
}): string {
  const { issue, decision } = input;
  const lines = [`**${issue.key} - ${issue.title}**`, "", decision.title];
  const body = decision.body.trim();
  if (body) lines.push("", body);
  const options = Array.isArray(decision.options) ? decision.options : [];
  if (options.length) {
    lines.push("");
    options.forEach((option, index) => lines.push(`${index + 1}. ${String(option)}`));
  }
  const link = issueWebUrl(input);
  lines.push("", link
    ? `请在 Remi 工作台处理：[${issue.key}](${link})`
    : "请在 Remi 工作台处理此事项。");
  return lines.join("\n");
}

/** The one text nudge an unanswered decision card gets (MUL-412). */
function issueDecisionReminderBody(
  issue: Pick<MultiremiIssue, "id" | "key" | "title">,
  decision: Pick<MultiremiIssueDecision, "title">,
): string {
  return [
    `**${issue.key} - ${issue.title}**`,
    "",
    `「${decision.title}」还没人处理，请在话题里点卡片回复。`,
  ].join("\n");
}

/** Absolute web URL, or null when the deployment has no public address yet. */
function issueWebUrl(input: {
  issue: Pick<MultiremiIssue, "id">;
  workspaceSlug?: string | null;
  publicUrl?: string | null;
}): string | null {
  const base = cleanOptionalString(input.publicUrl ?? process.env.MULTIREMI_PUBLIC_URL);
  if (!base) return null;
  const trimmed = base.replace(/\/+$/, "");
  const slug = cleanOptionalString(input.workspaceSlug);
  const path = slug ? `/${encodeURIComponent(slug)}/issues/` : "/issues/";
  return `${trimmed}${path}${encodeURIComponent(input.issue.id)}`;
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
  const kind = cleanOptionalString(row.kind);
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
    ...(kind ? { kind: kind as MultiremiFeishuBotOutboundDelivery["kind"] } : {}),
    ...(row.human_request_id ? {
      humanRequestId: String(row.human_request_id),
      human_request_id: String(row.human_request_id),
    } : {}),
    ...(row.decision_id ? {
      decisionId: String(row.decision_id),
      decision_id: String(row.decision_id),
      // The host needs the Issue to derive the callback name and to read the
      // decision back; the delivery row already carries it for the queue join.
      ...(row.decision_issue_id ? {
        decisionIssueId: String(row.decision_issue_id),
        decision_issue_id: String(row.decision_issue_id),
      } : {}),
    } : {}),
    ...(row.human_request_task_id ? {
      humanRequestTaskId: String(row.human_request_task_id),
      human_request_task_id: String(row.human_request_task_id),
    } : {}),
    ...(row.target_message_id ? {
      targetMessageId: String(row.target_message_id),
      target_message_id: String(row.target_message_id),
    } : {}),
    ...(row.expires_at ? { expiresAt: String(row.expires_at), expires_at: String(row.expires_at) } : {}),
    ...(row.degraded ? {
      degraded: String(row.degraded) as MultiremiFeishuBotOutboundDelivery["degraded"],
      degradeReason: String(row.degraded) as MultiremiFeishuBotOutboundDelivery["degraded"],
    } : {}),
  };
}

/** Exported for tests that need to age a reported state past the trust window. */
export const FEISHU_BOT_RUNTIME_STATE_STALE_MS = RUNTIME_STATE_STALE_MS;
