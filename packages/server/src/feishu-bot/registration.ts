/**
 * Scan-to-create bot registration, proxied for the browser (MUL-206).
 *
 * The CLI has had a working Feishu App Registration device flow for a while
 * (`apps/remi/cli/feishu-bot-creator.ts`), but only reachable from a terminal on
 * the daemon machine. This module runs the same flow from the control plane so
 * an admin can fill the credential form by scanning a QR code instead of
 * copy-pasting an app secret.
 *
 * Two deliberate constraints:
 *
 * - **The secret never reaches the browser.** A completed session returns the
 *   app id and `app_secret_available: true`; the plaintext stays in this
 *   process until the admin saves the config, at which point it is encrypted
 *   straight into the row.
 * - **Sessions are workspace-scoped, single-use and short-lived.** Consuming a
 *   session destroys it, so a leaked session id cannot be replayed.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@shared/logger.js";
import { redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";

const log = createLogger("feishu-bot-registration");

/** The registration endpoint only exists on the two public clouds. */
export type FeishuBotRegistrationBrand = "feishu" | "lark";

export type FeishuBotRegistrationStatus = "pending" | "ready" | "denied" | "expired" | "error";

export interface FeishuBotRegistrationSessionView {
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

interface Session {
  id: string;
  workspaceId: string;
  brand: FeishuBotRegistrationBrand;
  status: FeishuBotRegistrationStatus;
  verificationUri: string;
  userCode: string;
  expiresAtMs: number;
  pollIntervalSeconds: number;
  appId: string | null;
  appSecret: string | null;
  createdByOpenId: string | null;
  errorMessage: string | null;
}

const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS_PER_WORKSPACE = 3;

function originsFor(brand: FeishuBotRegistrationBrand): { accounts: string } {
  return { accounts: brand === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn" };
}

export interface FeishuBotRegistrationOptions {
  fetchImpl?: typeof fetch;
  /** Injected by tests to avoid real waits between poll attempts. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * In-memory session registry. Registration is an interactive, seconds-to-minutes
 * flow tied to one admin's browser tab; persisting it would mean persisting an
 * app secret outside the encrypted column, which is exactly what this feature
 * exists to avoid. A control-plane restart mid-scan just means scanning again.
 */
export class FeishuBotRegistrationService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: FeishuBotRegistrationOptions = {}) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms);
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  async begin(workspaceId: string, brand: FeishuBotRegistrationBrand): Promise<FeishuBotRegistrationSessionView> {
    this.sweep();
    this.enforceWorkspaceQuota(workspaceId);
    const { accounts } = originsFor(brand);
    const url = `${accounts}/oauth/v1/app/registration`;

    const init = await this.postForm(url, { action: "init" });
    if (init.error) throw new FeishuBotRegistrationError(`registration init failed: ${String(init.error)}`);

    const begin = await this.postForm(url, {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    if (begin.error) throw new FeishuBotRegistrationError(`registration begin failed: ${String(begin.error)}`);

    const deviceCode = String(begin.device_code ?? "");
    const verificationUri = String(begin.verification_uri_complete ?? "");
    if (!deviceCode || !verificationUri) {
      throw new FeishuBotRegistrationError("registration begin returned no device code");
    }
    const expiresIn = Number(begin.expires_in ?? 0) || 300;
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      brand,
      status: "pending",
      verificationUri,
      userCode: String(begin.user_code ?? ""),
      expiresAtMs: this.now() + Math.min(expiresIn * 1000, SESSION_TTL_MS),
      pollIntervalSeconds: Math.max(Number(begin.interval ?? 0) || 5, 2),
      appId: null,
      appSecret: null,
      createdByOpenId: null,
      errorMessage: null,
    };
    this.sessions.set(session.id, session);
    // The upstream flow needs someone to poll it; the browser polls *us* at its
    // own cadence, so the upstream loop runs here and only mutates the session.
    void this.drive(session, url, deviceCode);
    return view(session);
  }

  get(workspaceId: string, sessionId: string): FeishuBotRegistrationSessionView | null {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) return null;
    return view(session);
  }

  /**
   * Take the credentials produced by a completed session. Single-use: the
   * session is dropped so the same secret cannot be claimed twice.
   */
  consume(workspaceId: string, sessionId: string): { appId: string; appSecret: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) return null;
    if (session.status !== "ready" || !session.appId || !session.appSecret) return null;
    this.sessions.delete(sessionId);
    return { appId: session.appId, appSecret: session.appSecret };
  }

  cancel(workspaceId: string, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) return false;
    this.sessions.delete(sessionId);
    return true;
  }

  private enforceWorkspaceQuota(workspaceId: string): void {
    const owned = [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId);
    if (owned.length < MAX_SESSIONS_PER_WORKSPACE) return;
    // Drop the oldest so an admin who reloaded the page a few times is not locked out.
    const oldest = owned.sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0];
    if (oldest) this.sessions.delete(oldest.id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      // A finished session still holds an app secret, so it is dropped on the
      // same clock as a pending one rather than kept for the UI's convenience.
      if (session.expiresAtMs <= now) this.sessions.delete(id);
    }
  }

  private async drive(session: Session, url: string, deviceCode: string): Promise<void> {
    let interval = session.pollIntervalSeconds;
    while (this.now() < session.expiresAtMs && session.status === "pending") {
      await this.sleep(interval * 1000);
      if (session.status !== "pending") return;
      let payload: Record<string, unknown>;
      try {
        payload = await this.postForm(url, { action: "poll", device_code: deviceCode });
      } catch (error) {
        // A transient network blip must not end a scan the admin is mid-way through.
        log.warn(`registration poll failed: ${redactFeishuBotError(error)}`);
        continue;
      }
      const appId = optionalString(payload.client_id);
      const appSecret = optionalString(payload.client_secret);
      if (appId && appSecret) {
        session.appId = appId;
        session.appSecret = appSecret;
        session.createdByOpenId = isRecord(payload.user_info)
          ? optionalString(payload.user_info.open_id)
          : null;
        session.status = "ready";
        return;
      }
      const error = optionalString(payload.error);
      if (!error || error === "authorization_pending") continue;
      if (error === "slow_down") { interval += 5; continue; }
      if (error === "access_denied") {
        session.status = "denied";
        session.errorMessage = "the scan was declined in Feishu";
        return;
      }
      if (error === "expired_token") {
        session.status = "expired";
        session.errorMessage = "the registration session expired before it was approved";
        return;
      }
      session.status = "error";
      session.errorMessage = redactFeishuBotError(error);
      return;
    }
    if (session.status === "pending") {
      session.status = "expired";
      session.errorMessage = "the registration session expired before it was approved";
    }
  }

  private async postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    try {
      const parsed = await response.json();
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

export class FeishuBotRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuBotRegistrationError";
  }
}

function view(session: Session): FeishuBotRegistrationSessionView {
  return {
    session_id: session.id,
    status: session.status,
    verification_uri: session.verificationUri,
    user_code: session.userCode,
    expires_at: new Date(session.expiresAtMs).toISOString(),
    poll_interval_seconds: session.pollIntervalSeconds,
    app_id: session.appId,
    // The browser learns that a secret exists, never what it is.
    app_secret_available: Boolean(session.appSecret),
    created_by_open_id: session.createdByOpenId,
    error_message: session.errorMessage,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}
