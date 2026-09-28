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

/**
 * How long one token's `last_used_at` stamp is allowed to stand before the next
 * verification rewrites it.
 *
 * The value is a "last seen" timestamp read by humans and by the daemon
 * retirement inventory, both at day granularity, so minute-level precision costs
 * a write per request and buys nothing (MUL-474). Only the UPDATE is throttled:
 * the token lookup, the revocation check and the expiry check in
 * {@link AccessTokensRepo.verifyAccessToken} still run on every request.
 */
const LAST_USED_AT_WRITE_INTERVAL_MS = 60_000;

/**
 * Ceiling on the throttle map.
 *
 * The map holds one entry per token seen in this process, so without a bound a
 * long-lived API process would grow it with every token it ever authenticated.
 * Entries older than the interval are dead weight the moment they expire, so the
 * sweep drops those first; only when a live burst still fills the map are the
 * oldest entries evicted. The map is trimmed *before* every insert, so its size
 * never exceeds this number.
 *
 * Eviction is not a correctness hole for the one-write-per-minute promise: the
 * next verification of an evicted token judges the window from the `last_used_at`
 * the row already carries (see {@link AccessTokensRepo.stampLastUsedAt}), so it
 * skips the write instead of stamping again.
 */
const LAST_USED_AT_MAP_MAX_ENTRIES = 4_096;

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
    // One clock read for both checks below: the expiry comparison and the throttle decision
    // must not disagree because the clock moved between them.
    const nowMs = Date.now();
    if (accessToken.expiresAt && Date.parse(accessToken.expiresAt) <= nowMs) return null;
    // The row read above is the one whose hash, type, revocation and expiry were just checked, and
    // the only write since is this `last_used_at` stamp — which the returned value does not carry
    // a stale copy of because `lastUsedAt` is not part of the validation. Re-reading it cost one
    // query on every authenticated request.
    return { ...accessToken, lastUsedAt: this.stampLastUsedAt(accessToken.id, accessToken.lastUsedAt, nowMs) };
  }

  /**
   * Record `last_used_at`, at most once per {@link LAST_USED_AT_WRITE_INTERVAL_MS}
   * per token.
   *
   * Returns the stamp that is now authoritative: the value written, or the one
   * already standing while this call is inside the throttle window.
   *
   * The map is only a fast path. When it has no entry — the first request in this
   * process, or an entry the capacity sweep evicted — the decision falls back to
   * the `last_used_at` that the verification's own SELECT already returned, so the
   * row stays the source of truth and no extra query is needed. Without that
   * fallback an evicted token would be stamped again immediately and the
   * one-write-per-minute promise would depend on map capacity.
   *
   * Two API processes each keep their own map and therefore each write once per
   * window — that is expected, and the field only needs day granularity.
   */
  private stampLastUsedAt(tokenId: string, storedLastUsedAt: string | null, nowMs: number): string {
    const throttled = lastUsedAtWrites.get(tokenId);
    if (throttled && withinLastUsedAtWindow(throttled.writtenAt, nowMs)) return throttled.lastUsedAt;

    // No usable map entry: judge the window from the value the row already carries.
    const storedMs = storedLastUsedAt ? Date.parse(storedLastUsedAt) : Number.NaN;
    if (storedLastUsedAt && Number.isFinite(storedMs) && withinLastUsedAtWindow(storedMs, nowMs)) {
      makeRoomForLastUsedAtWrite(nowMs);
      lastUsedAtWrites.set(tokenId, { writtenAt: storedMs, lastUsedAt: storedLastUsedAt });
      return storedLastUsedAt;
    }

    const lastUsedAt = new Date(nowMs).toISOString();
    this.db.run("UPDATE multiremi_access_tokens SET last_used_at = ? WHERE id = ?", [lastUsedAt, tokenId]);
    makeRoomForLastUsedAtWrite(nowMs);
    lastUsedAtWrites.set(tokenId, { writtenAt: nowMs, lastUsedAt });
    return lastUsedAt;
  }
}

/**
 * Is `stampMs` close enough to `nowMs` that the token is inside its write window?
 *
 * A stamp up to one interval in the past is exactly what the throttle exists for. A stamp slightly
 * in the *future* counts as inside the window too: an NTP step can put it there, and it drains on
 * its own. A future stamp more than one interval ahead cannot be what the clock will catch up to in
 * any reasonable time, so it is treated as an anomaly and the caller writes — the throttle must not
 * be able to wedge shut on a bad row.
 */
function withinLastUsedAtWindow(stampMs: number, nowMs: number): boolean {
  const ageMs = nowMs - stampMs;
  return ageMs < LAST_USED_AT_WRITE_INTERVAL_MS && ageMs > -LAST_USED_AT_WRITE_INTERVAL_MS;
}

/**
 * Process-local throttle state for {@link AccessTokensRepo.stampLastUsedAt}.
 *
 * Module scope rather than an instance field: one process serves through a single
 * store, but tests and one-off CLI paths may build several, and sharing the map
 * is what makes "one write per token per minute" hold whichever handle answers.
 */
const lastUsedAtWrites = new Map<string, { writtenAt: number; lastUsedAt: string }>();

/**
 * Make room for one more entry: drop everything that has already left its window, then evict the
 * oldest live entries until the map has room for the insert. Called *before* every `set`, so the
 * map's size never exceeds {@link LAST_USED_AT_MAP_MAX_ENTRIES}.
 */
function makeRoomForLastUsedAtWrite(nowMs: number): void {
  if (lastUsedAtWrites.size < LAST_USED_AT_MAP_MAX_ENTRIES) return;
  for (const [id, entry] of lastUsedAtWrites) {
    if (!withinLastUsedAtWindow(entry.writtenAt, nowMs)) lastUsedAtWrites.delete(id);
  }
  if (lastUsedAtWrites.size < LAST_USED_AT_MAP_MAX_ENTRIES) return;
  const oldest = [...lastUsedAtWrites.entries()]
    .sort((left, right) => left[1].writtenAt - right[1].writtenAt)
    .slice(0, lastUsedAtWrites.size - LAST_USED_AT_MAP_MAX_ENTRIES + 1);
  for (const [id] of oldest) lastUsedAtWrites.delete(id);
}

/** Test seam: how many throttle decisions the map currently holds. */
export function lastUsedAtThrottleSizeForTest(): number {
  return lastUsedAtWrites.size;
}

/** Test seam: forget every throttle decision, so a capacity case starts from empty. */
export function resetLastUsedAtThrottleForTest(): void {
  lastUsedAtWrites.clear();
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
