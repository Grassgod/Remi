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

import { nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, nullableString } from "@multiremi/store/helpers.js";
import {
  decryptFeishuBotSecret,
  encryptFeishuBotSecret,
  feishuBotSecretHint,
} from "@multiremi/feishu-bot/credentials.js";
import { normalizeFeishuBotErrorCode } from "@multiremi/feishu-bot/diagnostics.js";
import { isRuntimeEffectivelyOnline } from "@multiremi/store/repos/runtimes-repo.js";
import type {
  FeishuBotDesiredState,
  FeishuBotDomain,
  FeishuBotErrorCode,
  FeishuBotRuntimeState,
  FeishuBotSecretOp,
  FeishuBotStatus,
  MultiremiFeishuBotConfig,
  MultiremiFeishuBotDaemonConfig,
  MultiremiFeishuBotDirective,
  MultiremiFeishuBotRuntimeStatus,
  ReportFeishuBotRuntimeStatusInput,
  UpsertFeishuBotConfigInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

const DOMAINS: ReadonlySet<FeishuBotDomain> = new Set<FeishuBotDomain>(["feishu", "lark", "bytedance"]);
const RUNTIME_STATES: ReadonlySet<FeishuBotRuntimeState> = new Set<FeishuBotRuntimeState>([
  "stopped",
  "starting",
  "online",
  "failed",
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

export class FeishuBotConfigError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "FeishuBotConfigError";
  }
}

export class FeishuBotRepo {
  constructor(private readonly ctx: StoreContext) {}

  getConfig(workspaceId: string): MultiremiFeishuBotConfig | null {
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ?")
      .get(workspaceId) as Row | null;
    return row ? mapConfig(row) : null;
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

    const existing = this.rawConfigRow(workspaceId);
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
    const verificationToken = resolveSecretColumn(
      workspaceId,
      "verification_token",
      input.verificationTokenOp,
      input.verificationToken,
      nullableString(existing?.verification_token_encrypted),
    );
    const encryptKey = resolveSecretColumn(
      workspaceId,
      "encrypt_key",
      input.encryptKeyOp,
      input.encryptKey,
      nullableString(existing?.encrypt_key_encrypted),
    );

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
         verification_token_encrypted, encrypt_key_encrypted,
         domain, enabled, revision,
         bot_name, bot_open_id, last_tested_at, last_test_error, last_test_error_code,
         created_at, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         runtime_id = excluded.runtime_id,
         app_id = excluded.app_id,
         app_secret_encrypted = excluded.app_secret_encrypted,
         app_secret_hint = excluded.app_secret_hint,
         verification_token_encrypted = excluded.verification_token_encrypted,
         encrypt_key_encrypted = excluded.encrypt_key_encrypted,
         domain = excluded.domain,
         enabled = excluded.enabled,
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
      verificationToken.ciphertext,
      encryptKey.ciphertext,
      domain,
      input.enabled ? 1 : 0,
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
    verificationToken: string | null;
    encryptKey: string | null;
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
      verificationToken: decryptOptional(workspaceId, "verification_token", row.verification_token_encrypted),
      encryptKey: decryptOptional(workspaceId, "encrypt_key", row.encrypt_key_encrypted),
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
      verification_token: decryptOptional(workspaceId, "verification_token", row.verification_token_encrypted),
      encrypt_key: decryptOptional(workspaceId, "encrypt_key", row.encrypt_key_encrypted),
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
    return { revision, desired_state: "running", config_available: true };
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
    return this.disableWhere("agent_id = ? AND enabled = 1", agentId, actor);
  }

  disableConfigsReferencingRuntime(runtimeId: string, actor?: string | null): string[] {
    return this.disableWhere("runtime_id = ? AND enabled = 1", runtimeId, actor);
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

function resolveSecretColumn(
  workspaceId: string,
  field: "app_secret" | "verification_token" | "encrypt_key",
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

function decryptOptional(
  workspaceId: string,
  field: "verification_token" | "encrypt_key",
  value: unknown,
): string | null {
  const ciphertext = nullableString(value);
  if (!ciphertext) return null;
  return decryptFeishuBotSecret(ciphertext, { workspaceId, field });
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
    revision: Number(row.revision ?? 0),
    hasAppSecret: Boolean(nullableString(row.app_secret_encrypted)),
    hasVerificationToken: Boolean(nullableString(row.verification_token_encrypted)),
    hasEncryptKey: Boolean(nullableString(row.encrypt_key_encrypted)),
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

/** Exported for tests that need to age a reported state past the trust window. */
export const FEISHU_BOT_RUNTIME_STATE_STALE_MS = RUNTIME_STATE_STALE_MS;
