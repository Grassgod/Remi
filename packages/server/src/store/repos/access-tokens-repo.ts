// Access-token minting/verification, extracted verbatim from MultiremiStore (delegated).
import { type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import type {
  CreateAccessTokenInput,
  MultiremiAccessToken,
  MultiremiAccessTokenPurpose,
  MultiremiAccessTokenType,
  MultiremiCreatedAccessToken,
  MultiremiTask,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class BoundDaemonTokenRetirementRequiredError extends Error {
  readonly code = "daemon_retirement_required";

  constructor(readonly daemonId: string) {
    super(`Bound daemon ${daemonId} must be retired before its credential can be revoked`);
    this.name = "BoundDaemonTokenRetirementRequiredError";
  }
}

export class DaemonTokenExpiryNotAllowedError extends Error {
  readonly code = "daemon_token_expiry_not_allowed";

  constructor() {
    super("Daemon tokens cannot expire; retire the daemon to revoke machine trust");
    this.name = "DaemonTokenExpiryNotAllowedError";
  }
}

export class AccessTokensRepo {
  constructor(private db: SqlDatabase) {}

  async createAccessToken(
    input: CreateAccessTokenInput,
    beforeInsert?: () => void,
    scopes: string[] = [],
  ): Promise<MultiremiCreatedAccessToken> {
    const name = input.name?.trim();
    if (!name) throw new Error("Token name is required");
    const type = normalizeAccessTokenType(input.type);
    if (type === "daemon" && (input.expiresInDays != null || input.expires_in_days != null)) {
      throw new DaemonTokenExpiryNotAllowedError();
    }
    const purpose = normalizeAccessTokenPurpose(input.purpose, type);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const daemonId = type === "daemon" ? cleanOptionalString(input.daemonId ?? input.daemon_id) : null;
    const taskId = type === "task" ? cleanOptionalString(input.taskId ?? input.task_id) : null;
    const agentId = type === "task" ? cleanOptionalString(input.agentId ?? input.agent_id) : null;
    if (type === "task" && (!taskId || !agentId)) throw new Error("task tokens require taskId and agentId");
    const userId = cleanOptionalString(input.userId ?? input.user_id) ?? "local";
    const token = generateAccessToken(type);
    const hash = await hashAccessToken(token);
    const id = input.id ?? createId(type === "daemon" ? "dtk" : type === "task" ? "atk" : "pat");
    const now = nowIso();
    const expiresAt = normalizeAccessTokenExpiry(input.expiresInDays ?? input.expires_in_days ?? null);
    const insert = (): MultiremiCreatedAccessToken => {
      beforeInsert?.();
      this.db.run(
        `INSERT INTO multiremi_access_tokens (
          id, workspace_id, daemon_id, task_id, agent_id, user_id, name, type, purpose, scopes, token_hash, token_prefix, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, workspaceId, daemonId, taskId, agentId, userId, name, type, purpose, toJson(scopes), hash, token.slice(0, 12), expiresAt, now],
      );
      return {
        ...this.getAccessToken(id)!,
        token,
      };
    };
    return beforeInsert ? this.db.transaction(insert)() : insert();
  }

  async createTaskAccessToken(
    task: Pick<MultiremiTask, "id" | "agentId" | "workspaceId">,
    userId: string,
    scopes: string[] = [],
  ): Promise<MultiremiCreatedAccessToken> {
    return this.createAccessToken({
      workspaceId: task.workspaceId,
      taskId: task.id,
      agentId: task.agentId,
      userId,
      name: `Task ${task.id}`,
      type: "task",
      purpose: "task",
      expiresInDays: 1,
    }, undefined, scopes);
  }

  listAccessTokens(workspaceId?: string | null): MultiremiAccessToken[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multiremi_access_tokens WHERE workspace_id = ? AND type != 'task' ORDER BY created_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multiremi_access_tokens WHERE type != 'task' ORDER BY created_at DESC").all() as Row[];
    return rows.map(toAccessToken);
  }

  listPersonalAccessTokens(workspaceId: string, userId: string): MultiremiAccessToken[] {
    const rows = this.db.query(
      `SELECT * FROM multiremi_access_tokens
       WHERE workspace_id = ?
         AND user_id = ?
         AND type = 'pat'
         AND purpose = 'personal'
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
    ).all(workspaceId, userId, nowIso()) as Row[];
    return rows.map(toAccessToken);
  }

  listExpiringBoundDaemonTokens(workspaceId: string): MultiremiAccessToken[] {
    return (this.db.query(
      `SELECT * FROM multiremi_access_tokens
       WHERE workspace_id = ?
         AND type = 'daemon'
         AND daemon_id IS NOT NULL AND daemon_id != ''
         AND revoked_at IS NULL
         AND expires_at IS NOT NULL
       ORDER BY daemon_id ASC, created_at ASC`,
    ).all(workspaceId) as Row[]).map(toAccessToken);
  }

  getAccessToken(id: string): MultiremiAccessToken | null {
    const row = this.db.query("SELECT * FROM multiremi_access_tokens WHERE id = ?").get(id) as Row | null;
    return row ? toAccessToken(row) : null;
  }

  /** Atomically claim an unbound daemon token for its first registered daemon. */
  bindDaemonAccessToken(id: string, daemonId: string): MultiremiAccessToken | null {
    const normalizedDaemonId = cleanOptionalString(daemonId);
    if (!normalizedDaemonId) return null;
    const current = this.getAccessToken(id);
    if (!current || current.type !== "daemon" || current.expiresAt) return null;
    if (current.daemonId && current.daemonId !== normalizedDaemonId) return null;
    if (!current.daemonId) {
      this.db.run(
        `UPDATE multiremi_access_tokens SET daemon_id = ?
         WHERE id = ? AND type = 'daemon' AND daemon_id IS NULL AND expires_at IS NULL`,
        [normalizedDaemonId, id],
      );
    }
    const bound = this.getAccessToken(id);
    return bound?.daemonId === normalizedDaemonId ? bound : null;
  }

  /**
   * One-way compatibility upgrade for credentials minted by the historical
   * "add computer" dialog. Those credentials were PATs with purpose=cli even
   * though the daemon execution surface now requires a machine identity.
   */
  promoteCliAccessTokenToDaemon(
    id: string,
    workspaceId: string,
    daemonId: string,
  ): MultiremiAccessToken | null {
    const normalizedWorkspaceId = cleanOptionalString(workspaceId);
    const normalizedDaemonId = cleanOptionalString(daemonId);
    if (!normalizedWorkspaceId || !normalizedDaemonId) return null;
    const result = this.db.run(
      `UPDATE multiremi_access_tokens
       SET type = 'daemon', purpose = 'daemon', daemon_id = ?
       WHERE id = ?
         AND workspace_id = ?
         AND type = 'pat'
         AND purpose = 'cli'
         AND daemon_id IS NULL
         AND expires_at IS NULL
         AND revoked_at IS NULL
      `,
      [normalizedDaemonId, id, normalizedWorkspaceId],
    );
    if (result.changes !== 1) return null;
    const promoted = this.getAccessToken(id);
    return promoted?.type === "daemon" && promoted.daemonId === normalizedDaemonId
      ? promoted
      : null;
  }

  revokeAccessToken(id: string): MultiremiAccessToken | null {
    const current = this.getAccessToken(id);
    if (!current) return null;
    if (current.type === "daemon" && current.daemonId && !current.revokedAt) {
      throw new BoundDaemonTokenRetirementRequiredError(current.daemonId);
    }
    if (!current.revokedAt) {
      this.db.run("UPDATE multiremi_access_tokens SET revoked_at = ? WHERE id = ?", [nowIso(), id]);
    }
    return this.getAccessToken(id);
  }

  revokeTaskAccessTokens(taskId: string): number {
    const result = this.db.run(
      "UPDATE multiremi_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE type = 'task' AND task_id = ? AND revoked_at IS NULL",
      [nowIso(), taskId],
    );
    return result.changes;
  }

  async renewAccessTokenExpiry(
    id: string,
    options: { thresholdDays?: number; extensionDays?: number } = {},
  ): Promise<{ token: MultiremiAccessToken; renewed: boolean; rawToken?: string } | null> {
    const nowMs = Date.now();
    const thresholdDays = options.thresholdDays ?? 7;
    const extensionDays = options.extensionDays ?? 90;
    const now = new Date(nowMs).toISOString();
    const renewThresholdAt = new Date(nowMs + thresholdDays * 24 * 60 * 60 * 1000).toISOString();
    const newExpiresAt = new Date(nowMs + extensionDays * 24 * 60 * 60 * 1000).toISOString();
    const current = this.getAccessToken(id);
    if (!current || current.revokedAt) return null;
    if (current.expiresAt && Date.parse(current.expiresAt) <= nowMs) return null;
    if (!current.expiresAt || Date.parse(current.expiresAt) > Date.parse(renewThresholdAt)) {
      return { token: current, renewed: false };
    }
    const rawToken = generateAccessToken(current.type);
    const hash = await hashAccessToken(rawToken);
    const result = this.db.run(
      `UPDATE multiremi_access_tokens
       SET token_hash = ?, token_prefix = ?, expires_at = ?
       WHERE id = ?
         AND revoked_at IS NULL
         AND expires_at IS NOT NULL
         AND expires_at > ?
         AND expires_at <= ?`,
      [hash, rawToken.slice(0, 12), newExpiresAt, id, now, renewThresholdAt],
    );
    const token = this.getAccessToken(id);
    if (!token || token.revokedAt) return null;
    if (token.expiresAt && Date.parse(token.expiresAt) <= nowMs) return null;
    return { token, renewed: result.changes > 0, ...(result.changes > 0 ? { rawToken } : {}) };
  }

  async verifyAccessToken(rawToken: string, allowedTypes?: MultiremiAccessTokenType[]): Promise<MultiremiAccessToken | null> {
    const token = rawToken.trim();
    if (!token) return null;
    const hash = await hashAccessToken(token);
    const row = this.db.query("SELECT * FROM multiremi_access_tokens WHERE token_hash = ?").get(hash) as Row | null;
    if (!row) return null;
    const accessToken = toAccessToken(row);
    if (allowedTypes?.length && !allowedTypes.includes(accessToken.type)) return null;
    if (accessToken.revokedAt) return null;
    if (accessToken.expiresAt && Date.parse(accessToken.expiresAt) <= Date.now()) return null;
    this.db.run("UPDATE multiremi_access_tokens SET last_used_at = ? WHERE id = ?", [nowIso(), accessToken.id]);
    return this.getAccessToken(accessToken.id);
  }
}

function toAccessToken(row: Row): MultiremiAccessToken {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    daemonId: nullableString(row.daemon_id),
    taskId: nullableString(row.task_id),
    agentId: nullableString(row.agent_id),
    userId: String(row.user_id ?? "local"),
    name: String(row.name ?? ""),
    type: normalizeAccessTokenType(String(row.type ?? "pat")),
    purpose: normalizeAccessTokenPurpose(
      String(row.purpose ?? "personal"),
      normalizeAccessTokenType(String(row.type ?? "pat")),
    ),
    scopes: parseJson<string[]>(row.scopes, []),
    tokenPrefix: String(row.token_prefix ?? ""),
    lastUsedAt: nullableString(row.last_used_at),
    expiresAt: nullableString(row.expires_at),
    revokedAt: nullableString(row.revoked_at),
    createdAt: String(row.created_at),
  };
}

function generateAccessToken(type: MultiremiAccessTokenType): string {
  if (type === "task") {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return `mat_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  const prefix = type === "daemon" ? "mdt" : "mul";
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

function normalizeAccessTokenType(value: string | undefined): MultiremiAccessTokenType {
  const type = String(value ?? "pat").trim().toLowerCase();
  if (type === "pat" || type === "daemon" || type === "task") return type;
  throw new Error("token type must be pat, daemon, or task");
}

function normalizeAccessTokenPurpose(
  value: string | undefined,
  type: MultiremiAccessTokenType,
): MultiremiAccessTokenPurpose {
  if (type === "daemon") return "daemon";
  if (type === "task") return "task";
  const purpose = String(value ?? "personal").trim().toLowerCase();
  if (purpose === "personal" || purpose === "session" || purpose === "cli") return purpose;
  throw new Error("pat token purpose must be personal, session, or cli");
}

function normalizeAccessTokenExpiry(days: number | null | undefined): string | null {
  if (days == null) return null;
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(Date.now() + Math.floor(value) * 24 * 60 * 60 * 1000).toISOString();
}

async function hashAccessToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
