/**
 * Workspace Feishu concierge bot routes (MUL-206).
 *
 * Replaces the daemon machine's environment variables as the source of truth
 * for which Agent answers Feishu messages, which Runtime hosts the connector,
 * and which Feishu app it authenticates as.
 *
 * Access rules, in one place so they are easy to audit:
 *
 * - Owner/admin see and change everything. `requireWorkspaceAdmin` already
 *   rejects daemon tokens, and `taskTokenHardDenyCategory` rejects task and
 *   share tokens for this whole subtree.
 * - An ordinary member gets availability only — whether a concierge exists and
 *   whether it is answering — never the app id, the Runtime, or an error.
 * - No response on any of these routes carries a secret. The app secret is
 *   write-only from the browser's point of view: it goes in, and comes back as
 *   `app_secret_configured` plus a four-character hint.
 */

import type { Context, Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { currentRequestUserId } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";
import {
  FeishuBotConfigError,
  type FeishuBotStatusSnapshot,
} from "@multiremi/store/repos/feishu-bot-repo.js";
import {
  FeishuBotEncryptionError,
  feishuBotEncryptionAvailable,
} from "@multiremi/feishu-bot/credentials.js";
import { redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import {
  FeishuBotRegistrationService,
  type FeishuBotRegistrationBrand,
} from "@multiremi/feishu-bot/registration.js";
import { verifyFeishuBotCredentials } from "@multiremi/feishu-bot/verify.js";
import { isRuntimeEffectivelyOnline } from "@multiremi/store/repos/runtimes-repo.js";
import {
  FEISHU_CONCIERGE_CONFIG_CAPABILITY,
  type FeishuBotAvailabilityView,
  type FeishuBotConfigView,
  type FeishuBotDomain,
  type FeishuBotSecretOp,
  type FeishuBotStatusView,
  type FeishuBotTestResult,
  type MultiremiRuntime,
  type UpsertFeishuBotConfigInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

const DOMAINS: readonly FeishuBotDomain[] = ["feishu", "lark", "bytedance"];

/**
 * Shared with the daemon router: a Runtime may only be selected to host the
 * concierge once it has told us it understands the config protocol.
 */
export function runtimeSupportsFeishuBotConfig(runtime: MultiremiRuntime): boolean {
  const capabilities = runtime.metadata[FEISHU_CONCIERGE_CONFIG_CAPABILITY];
  return capabilities === true;
}

export function registerFeishuBotRoutes(
  app: Hono,
  deps: RouterDeps,
  registrations = new FeishuBotRegistrationService(),
): void {
  const { store } = deps;

  // ── Read ────────────────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/feishu-bot", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    c.header("Cache-Control", "no-store");
    // A plain member is told whether a concierge is available and nothing else:
    // the app id and the host Runtime are deployment detail they cannot change.
    if (requireWorkspaceAdmin(c, store, workspaceId)) {
      return c.json(availabilityView(store.feishuBotStatusSnapshot(workspaceId)));
    }
    return c.json(configView(store, workspaceId));
  });

  app.get("/api/workspaces/:id/feishu-bot/status", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(statusView(store, workspaceId));
  });

  /** Agent and Runtime pickers, with the reasons an option cannot be chosen. */
  app.get("/api/workspaces/:id/feishu-bot/candidates", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const agents = store.listAgents()
      .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
      .map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider }));
    const runtimes = store.listRuntimes()
      .filter((runtime) => runtime.workspaceId === workspaceId)
      .map((runtime) => ({
        id: runtime.id,
        name: runtime.daemonId
          ? store.getDaemonProfile(workspaceId, runtime.daemonId)?.displayName ?? runtime.daemonId
          : runtime.name,
        provider: runtime.provider,
        daemon_id: runtime.daemonId,
        online: isRuntimeEffectivelyOnline(runtime),
        supports_config: runtimeSupportsFeishuBotConfig(runtime),
        last_heartbeat_at: runtime.lastHeartbeatAt,
      }));
    return c.json({
      workspace_id: workspaceId,
      agents,
      runtimes,
      encryption_available: feishuBotEncryptionAvailable(),
    });
  });

  app.get("/api/workspaces/:id/feishu-bot/audit", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const limit = Number(c.req.query("limit") ?? "50");
    return c.json({
      workspace_id: workspaceId,
      entries: store.listFeishuBotAudit(workspaceId, Number.isFinite(limit) ? limit : 50),
    });
  });

  // ── Write ───────────────────────────────────────────────────────────────
  app.put("/api/workspaces/:id/feishu-bot", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<FeishuBotConfigBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);

    const existed = store.getFeishuBotConfig(workspaceId) !== null;
    const parsed = parseConfigBody(body, workspaceId, registrations);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    c.header("Cache-Control", "no-store");
    try {
      const saved = store.upsertFeishuBotConfig(workspaceId, parsed.input);
      if (parsed.registrationUsed) {
        store.recordFeishuBotAudit(workspaceId, "registration_used", {
          actorId: currentRequestUserId(c),
          details: { app_id: saved.appId },
        });
      }
      store.recordFeishuBotAudit(workspaceId, existed ? "updated" : "configured", {
        actorId: currentRequestUserId(c),
        details: {
          agent_id: saved.agentId,
          runtime_id: saved.runtimeId,
          app_id: saved.appId,
          domain: saved.domain,
          enabled: saved.enabled,
          revision: saved.revision,
          // Which secrets moved, never what they became.
          app_secret_op: parsed.input.appSecretOp,
        },
      });
      return c.json(configView(store, workspaceId));
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  app.delete("/api/workspaces/:id/feishu-bot", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.deleteFeishuBotConfig(workspaceId)) {
      return c.json({ error: "feishu bot is not configured" }, 404);
    }
    // The connector is not stopped here: the next heartbeat hands the hosting
    // Runtime a `stopped` directive, and the row it reported keeps that
    // directive flowing until it confirms.
    store.recordFeishuBotAudit(workspaceId, "deleted", { actorId: currentRequestUserId(c) });
    c.header("Cache-Control", "no-store");
    return c.json(configView(store, workspaceId));
  });

  app.post("/api/workspaces/:id/feishu-bot/deploy", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrictAllowEmpty<Record<string, never>>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const config = store.getFeishuBotConfig(workspaceId);
    if (!config) return c.json({ error: "feishu bot is not configured" }, 404);
    // Deploy means "run, and pick up whatever is stored now" — enabling and
    // bumping the revision together covers both a cold start and a redeploy.
    const enabled = store.setFeishuBotEnabled(workspaceId, true, currentRequestUserId(c));
    store.recordFeishuBotAudit(workspaceId, config.enabled ? "redeployed" : "enabled", {
      actorId: currentRequestUserId(c),
      details: { runtime_id: config.runtimeId, revision: enabled?.revision ?? config.revision },
    });
    c.header("Cache-Control", "no-store");
    return c.json(statusView(store, workspaceId));
  });

  app.post("/api/workspaces/:id/feishu-bot/stop", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrictAllowEmpty<Record<string, never>>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const stopped = store.setFeishuBotEnabled(workspaceId, false, currentRequestUserId(c));
    if (!stopped) return c.json({ error: "feishu bot is not configured" }, 404);
    store.recordFeishuBotAudit(workspaceId, "disabled", {
      actorId: currentRequestUserId(c),
      details: { runtime_id: stopped.runtimeId, revision: stopped.revision },
    });
    c.header("Cache-Control", "no-store");
    return c.json(statusView(store, workspaceId));
  });

  /**
   * Verify credentials against the Feishu open platform. Accepts an inline
   * secret so an admin can test before saving; falls back to the stored one so
   * they can re-test later without retyping it.
   */
  app.post("/api/workspaces/:id/feishu-bot/test", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrictAllowEmpty<{
      app_id?: unknown;
      app_secret?: unknown;
      domain?: unknown;
      registration_session_id?: unknown;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);

    const stored = safeRevealSecrets(store, workspaceId);
    const registrationSessionId = optionalString(body.registration_session_id);
    // Peek, do not consume: a test must not burn the session the admin still
    // needs in order to save.
    const registration = registrationSessionId
      ? registrations.get(workspaceId, registrationSessionId)
      : null;
    const appId = optionalString(body.app_id) ?? registration?.app_id ?? stored?.appId ?? "";
    const appSecret = optionalString(body.app_secret)
      ?? peekRegistrationSecret(registrations, workspaceId, registrationSessionId)
      ?? stored?.appSecret
      ?? "";
    const domain = parseDomain(body.domain) ?? stored?.domain ?? "feishu";
    if (!appId || !appSecret) {
      return c.json({ error: "app_id and app_secret are required to test" }, 400);
    }

    const snapshot = store.feishuBotStatusSnapshot(workspaceId);
    const runtime = snapshot.config ? store.getRuntime(snapshot.config.runtimeId) : null;
    const verified = await verifyFeishuBotCredentials({ appId, appSecret, domain });
    // Only persist against the stored credentials — a probe of some other app
    // must not overwrite the recorded profile of the configured one.
    if (stored && appId === stored.appId && appSecret === stored.appSecret) {
      store.recordFeishuBotTestResult(workspaceId, {
        botName: verified.botName,
        botOpenId: verified.botOpenId,
        errorCode: verified.errorCode,
        errorMessage: verified.errorMessage,
      });
    }
    store.recordFeishuBotAudit(workspaceId, "tested", {
      actorId: currentRequestUserId(c),
      details: { app_id: appId, domain, ok: verified.ok, error_code: verified.errorCode },
    });

    const result: FeishuBotTestResult = {
      ok: verified.ok,
      bot_name: verified.botName,
      bot_open_id: verified.botOpenId,
      app_name: verified.appName,
      runtime_online: Boolean(runtime && isRuntimeEffectivelyOnline(runtime)),
      runtime_supports_config: Boolean(runtime && runtimeSupportsFeishuBotConfig(runtime)),
      error_code: verified.errorCode,
      error_message: verified.errorMessage,
    };
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });

  // ── Scan-to-create registration (optional credential fill) ──────────────
  app.post("/api/workspaces/:id/feishu-bot/registration", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrictAllowEmpty<{ brand?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const brand = parseBrand(body.brand);
    if (!brand) return c.json({ error: "brand must be feishu or lark" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      const session = await registrations.begin(workspaceId, brand);
      store.recordFeishuBotAudit(workspaceId, "registration_started", {
        actorId: currentRequestUserId(c),
        details: { brand, session_id: session.session_id },
      });
      return c.json(session, 202);
    } catch (error) {
      // Every failure here is upstream Feishu refusing the registration, so it
      // reports as a bad gateway rather than as our own error.
      return c.json({ error: redactFeishuBotError(error) }, 502);
    }
  });

  app.get("/api/workspaces/:id/feishu-bot/registration/:sessionId", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const session = registrations.get(workspaceId, c.req.param("sessionId"));
    if (!session) return c.json({ error: "registration session not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(session);
  });

  app.delete("/api/workspaces/:id/feishu-bot/registration/:sessionId", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    registrations.cancel(workspaceId, c.req.param("sessionId"));
    return c.body(null, 204);
  });
}

interface FeishuBotConfigBody {
  agent_id?: unknown;
  runtime_id?: unknown;
  app_id?: unknown;
  domain?: unknown;
  enabled?: unknown;
  app_secret?: unknown;
  app_secret_op?: unknown;
  registration_session_id?: unknown;
}

function parseConfigBody(
  body: FeishuBotConfigBody,
  workspaceId: string,
  registrations: FeishuBotRegistrationService,
): { input: UpsertFeishuBotConfigInput; registrationUsed: boolean } | { error: string } {
  const domain = parseDomain(body.domain);
  if (!domain) return { error: "domain must be feishu, lark, or bytedance" };
  if (typeof body.enabled !== "boolean") return { error: "enabled must be explicitly true or false" };

  let appId = optionalString(body.app_id) ?? "";
  let appSecretOp = parseSecretOp(body.app_secret_op, body.app_secret);
  let appSecret = optionalString(body.app_secret) ?? undefined;
  let registrationUsed = false;

  // `app_secret_op: "registration"` is the browser saying "use whatever the
  // scan produced" — the plaintext travels server-side only.
  if (body.app_secret_op === "registration") {
    const sessionId = optionalString(body.registration_session_id);
    if (!sessionId) return { error: "registration_session_id is required for app_secret_op=registration" };
    const claimed = registrations.consume(workspaceId, sessionId);
    if (!claimed) return { error: "registration session is not complete" };
    appId = appId || claimed.appId;
    appSecret = claimed.appSecret;
    appSecretOp = "set";
    registrationUsed = true;
  }
  if (appSecretOp === "clear") return { error: "app_secret cannot be cleared while the bot is configured" };

  return {
    input: {
      agentId: optionalString(body.agent_id) ?? "",
      runtimeId: optionalString(body.runtime_id) ?? "",
      appId,
      domain,
      enabled: body.enabled,
      appSecretOp,
      appSecret,
    },
    registrationUsed,
  };
}

/**
 * Default to `keep` so a form that submits every field except the untouched
 * secret cannot wipe a stored credential. An explicit value always wins; a bare
 * non-empty value is treated as `set` for callers (curl, the CLI) that do not
 * bother with the op field.
 */
function parseSecretOp(op: unknown, value: unknown): FeishuBotSecretOp {
  if (op === "set" || op === "clear" || op === "keep") return op;
  if (op === undefined && typeof value === "string" && value.trim()) return "set";
  return "keep";
}

function parseDomain(value: unknown): FeishuBotDomain | null {
  if (value === undefined || value === null) return "feishu";
  const domain = String(value).trim();
  return DOMAINS.includes(domain as FeishuBotDomain) ? (domain as FeishuBotDomain) : null;
}

function parseBrand(value: unknown): FeishuBotRegistrationBrand | null {
  if (value === undefined || value === null) return "feishu";
  const brand = String(value).trim();
  return brand === "feishu" || brand === "lark" ? brand : null;
}

function optionalString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function peekRegistrationSecret(
  registrations: FeishuBotRegistrationService,
  workspaceId: string,
  sessionId: string | null,
): string | null {
  if (!sessionId) return null;
  const session = registrations.get(workspaceId, sessionId);
  if (!session || !session.app_secret_available) return null;
  // `consume` is single-use, so a test re-registers what it took.
  const claimed = registrations.consume(workspaceId, sessionId);
  return claimed?.appSecret ?? null;
}

/** A missing encryption key must surface as a setup problem, not a 500. */
function safeRevealSecrets(store: MultiremiStore, workspaceId: string): ReturnType<MultiremiStore["revealFeishuBotSecrets"]> {
  try {
    return store.revealFeishuBotSecrets(workspaceId);
  } catch {
    return null;
  }
}

export function configView(store: MultiremiStore, workspaceId: string): FeishuBotConfigView {
  const snapshot = store.feishuBotStatusSnapshot(workspaceId);
  const config = snapshot.config;
  if (!config) {
    return {
      configured: false,
      workspace_id: workspaceId,
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
  }
  const agent = store.getAgent(config.agentId);
  const runtime = store.getRuntime(config.runtimeId);
  return {
    configured: true,
    workspace_id: workspaceId,
    agent_id: config.agentId,
    agent_name: agent?.name ?? null,
    agent_archived: Boolean(agent?.archivedAt),
    runtime_id: config.runtimeId,
    runtime_name: runtimeDisplayName(store, workspaceId, runtime),
    runtime_online: snapshot.runtimeOnline,
    runtime_supports_config: Boolean(runtime && runtimeSupportsFeishuBotConfig(runtime)),
    app_id: config.appId,
    domain: config.domain,
    enabled: config.enabled,
    revision: config.revision,
    app_secret_configured: config.hasAppSecret,
    app_secret_hint: config.appSecretHint,
    bot_name: snapshot.botName,
    bot_open_id: config.botOpenId,
    last_tested_at: config.lastTestedAt,
    last_test_error: config.lastTestError,
    last_test_error_code: config.lastTestErrorCode,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
    updated_by: config.updatedBy,
  };
}

export function statusView(store: MultiremiStore, workspaceId: string): FeishuBotStatusView {
  const snapshot = store.feishuBotStatusSnapshot(workspaceId);
  const runtime = snapshot.config ? store.getRuntime(snapshot.config.runtimeId) : null;
  return {
    status: snapshot.status,
    workspace_id: workspaceId,
    enabled: snapshot.config?.enabled ?? false,
    revision: snapshot.config?.revision ?? 0,
    desired_state: snapshot.desiredState,
    runtime_id: snapshot.config?.runtimeId ?? null,
    runtime_name: runtimeDisplayName(store, workspaceId, runtime),
    runtime_online: snapshot.runtimeOnline,
    applied_revision: snapshot.appliedRevision,
    bot_name: snapshot.botName,
    last_heartbeat_at: snapshot.lastHeartbeatAt,
    error_code: snapshot.errorCode,
    error_message: snapshot.errorMessage,
    stale_runtime_ids: snapshot.staleRuntimeIds,
  };
}

/** What a non-admin member is allowed to know. */
export function availabilityView(snapshot: FeishuBotStatusSnapshot): FeishuBotAvailabilityView {
  return {
    configured: snapshot.config !== null,
    available: snapshot.status === "online",
    bot_name: snapshot.botName,
  };
}

function configErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof FeishuBotConfigError) {
    return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409);
  }
  if (error instanceof FeishuBotEncryptionError) {
    return c.json({ error: error.message, code: error.code }, 503);
  }
  return c.json({ error: redactFeishuBotError(error) }, 400);
}

function runtimeDisplayName(
  store: MultiremiStore,
  workspaceId: string,
  runtime: MultiremiRuntime | null,
): string | null {
  if (!runtime) return null;
  if (!runtime.daemonId) return runtime.name;
  return store.getDaemonProfile(workspaceId, runtime.daemonId)?.displayName ?? runtime.daemonId;
}
