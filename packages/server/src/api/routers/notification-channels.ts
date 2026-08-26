import type { Context, Hono } from "hono";
import type {
  MultiremiNotificationChannelKind,
  MultiremiNotificationDeliveryStatus,
} from "@multiremi/contracts/types.js";
import type { DeliveryVisibilityScope } from "@multiremi/store/repos/notification-channels-repo.js";
import { NotificationChannelValidationError } from "@multiremi/store/repos/notification-channels-repo.js";
import {
  compatibilityWorkspaceId,
  denyCurrentUserWorkspaceAccess,
  readJson,
  requireWorkspaceAdmin,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  currentTaskAccessToken,
  currentWorkspaceMember,
  currentWorkspaceRoleStrict,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

type ChannelBody = {
  workspaceId?: string | null;
  workspace_id?: string | null;
  scope?: string;
  kind?: MultiremiNotificationChannelKind;
  name?: string;
  enabled?: boolean;
  target?: unknown;
  eventTypes?: unknown;
  event_types?: unknown;
  minSeverity?: string;
  min_severity?: string;
};

const DELIVERY_STATUSES = new Set<MultiremiNotificationDeliveryStatus>(["pending", "sent", "failed"]);

// A channel is owned either by the workspace (admin managed, mirrors every member's
// matching inbox item) or by exactly one member (mirrors only their own). Ownership is
// derived from the authenticated caller, never read off the request body — that is what
// stops anyone from pointing someone else's notifications at a group of their choosing.
const CHANNEL_SCOPES = new Set(["member", "workspace"]);
const OWNER_FIELDS = ["memberId", "member_id", "ownerId", "owner_id"] as const;

export function registerNotificationChannelRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/notification-channels", (c) => {
    const workspaceId = requestWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    // Admins moderate the whole workspace, so they see every channel. Everyone else
    // sees the workspace-level ones plus their own — never another member's group id.
    const channels = isWorkspaceAdmin(c, store, workspaceId)
      ? store.listNotificationChannels(workspaceId)
      : store.listNotificationChannelsVisibleToMember(
        workspaceId,
        currentWorkspaceMember(c, store, workspaceId)?.id ?? "",
      );
    return c.json({ channels, total: channels.length });
  });

  app.post("/api/multiremi/notification-channels", async (c) => {
    const body = await readJson<ChannelBody>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? requestWorkspaceId(c);
    const rejected = rejectOwnerOverride(c, body);
    if (rejected) return rejected;
    const scope = body.scope === undefined ? "member" : String(body.scope).trim().toLowerCase();
    if (!CHANNEL_SCOPES.has(scope)) {
      return c.json({ error: "scope must be member or workspace" }, 400);
    }
    const owner = resolveChannelOwner(c, store, workspaceId, scope);
    if (owner instanceof Response) return owner;
    try {
      const channel = store.createNotificationChannel({
        workspaceId,
        memberId: owner,
        kind: body.kind ?? "feishu_group",
        name: body.name ?? "",
        enabled: body.enabled,
        target: body.target,
        eventTypes: body.eventTypes ?? body.event_types,
        minSeverity: body.minSeverity ?? body.min_severity,
        createdBy: authenticatedRequestUserId(c),
      });
      return c.json({ channel }, 201);
    } catch (error) {
      return channelError(c, error);
    }
  });

  app.patch("/api/multiremi/notification-channels/:id", async (c) => {
    const current = store.getNotificationChannel(c.req.param("id"));
    if (!current) return c.json({ error: "notification channel not found" }, 404);
    const denied = requireChannelOwnership(c, store, current);
    if (denied) return denied;
    const body = await readJson<ChannelBody>(c);
    const rejected = rejectOwnerOverride(c, body);
    if (rejected) return rejected;
    if (body.scope !== undefined) {
      return c.json({ error: "scope cannot be changed after the channel is created" }, 400);
    }
    try {
      const channel = store.updateNotificationChannel(current.id, {
        name: body.name,
        enabled: body.enabled,
        target: body.target,
        eventTypes: body.eventTypes ?? body.event_types,
        minSeverity: body.minSeverity ?? body.min_severity,
      });
      return c.json({ channel });
    } catch (error) {
      return channelError(c, error);
    }
  });

  app.delete("/api/multiremi/notification-channels/:id", (c) => {
    const current = store.getNotificationChannel(c.req.param("id"));
    if (!current) return c.json({ error: "notification channel not found" }, 404);
    const denied = requireChannelOwnership(c, store, current);
    if (denied) return denied;
    store.deleteNotificationChannel(current.id);
    return c.json({ ok: true, id: current.id });
  });

  app.get("/api/multiremi/notification-deliveries", (c) => {
    const workspaceId = requestWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const rawStatus = c.req.query("status")?.trim();
    if (rawStatus && !DELIVERY_STATUSES.has(rawStatus as MultiremiNotificationDeliveryStatus)) {
      return c.json({ error: "status must be pending, sent, or failed" }, 400);
    }
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    const deliveries = store.listNotificationDeliveries({
      workspaceId,
      status: rawStatus as MultiremiNotificationDeliveryStatus | undefined,
      limit,
      scope: deliveryVisibility(c, store, workspaceId),
    });
    return c.json({ deliveries, total: deliveries.length });
  });

  app.post("/api/multiremi/notification-deliveries/:id/retry", (c) => {
    const current = store.getNotificationDelivery(c.req.param("id"));
    if (!current) return c.json({ error: "notification delivery not found" }, 404);
    const channel = store.getNotificationChannel(current.channelId);
    // The channel can be gone while its failure record lives on; only an admin may
    // re-drive an orphan, since there is no owner left to check against.
    const denied = channel
      ? requireChannelOwnership(c, store, channel)
      : requireNotificationAdmin(c, store, current.workspaceId);
    if (denied) return denied;
    if (current.status === "sent") {
      return c.json({ error: "sent notification deliveries cannot be retried" }, 409);
    }
    if (current.status === "pending" && leaseIsActive(current.leasedUntil)) {
      return c.json({ error: "notification delivery is currently being sent" }, 409);
    }
    const delivery = store.retryNotificationDelivery(current.id);
    if (!delivery) return c.json({ error: "notification delivery cannot be retried" }, 409);
    return c.json({ delivery }, 202);
  });
}

function leaseIsActive(leasedUntil: string | null): boolean {
  if (!leasedUntil) return false;
  const expiresAt = Date.parse(leasedUntil);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function requestWorkspaceId(c: Context): string {
  return c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? compatibilityWorkspaceId(c);
}

function requireNotificationAdmin(c: Context, store: RouterDeps["store"], workspaceId: string): Response | null {
  if (currentTaskAccessToken(c)) {
    return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
  }
  return denyCurrentUserWorkspaceAccess(c, store, workspaceId)
    ?? requireWorkspaceAdmin(c, store, workspaceId);
}

/**
 * Mutating a channel: its owner may do it, and so may a workspace admin (who has to be
 * able to pull the plug on a personal channel that is misbehaving). Workspace-level
 * channels stay admin-only. Task tokens are refused outright in every case — an agent
 * must never be able to point notifications anywhere.
 */
function requireChannelOwnership(
  c: Context,
  store: RouterDeps["store"],
  channel: { workspaceId: string; memberId: string | null },
): Response | null {
  if (currentTaskAccessToken(c)) {
    return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
  }
  const denied = denyCurrentUserWorkspaceAccess(c, store, channel.workspaceId);
  if (denied) return denied;
  if (channel.memberId !== null) {
    const member = currentWorkspaceMember(c, store, channel.workspaceId);
    if (member && member.id === channel.memberId) return null;
  }
  return requireWorkspaceAdmin(c, store, channel.workspaceId);
}

/**
 * Ownership for a new channel. `workspace` needs admin; `member` binds the channel to
 * the caller's own membership and fails closed when there is no membership to bind to.
 */
function resolveChannelOwner(
  c: Context,
  store: RouterDeps["store"],
  workspaceId: string,
  scope: string,
): string | null | Response {
  if (scope === "workspace") {
    const denied = requireNotificationAdmin(c, store, workspaceId);
    return denied ?? null;
  }
  if (currentTaskAccessToken(c)) {
    return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
  }
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const member = currentWorkspaceMember(c, store, workspaceId);
  if (!member) {
    return c.json({ error: "no workspace membership to own a personal notification channel" }, 403);
  }
  return member.id;
}

function rejectOwnerOverride(c: Context, body: ChannelBody): Response | null {
  const record = body as Record<string, unknown>;
  const named = OWNER_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(record, field));
  if (!named) return null;
  return c.json({ error: `${named} cannot be set: a channel is always owned by its creator` }, 400);
}

function deliveryVisibility(
  c: Context,
  store: RouterDeps["store"],
  workspaceId: string,
): DeliveryVisibilityScope {
  if (isWorkspaceAdmin(c, store, workspaceId)) return { kind: "all" };
  const member = currentTaskAccessToken(c) ? null : currentWorkspaceMember(c, store, workspaceId);
  return member ? { kind: "member", memberId: member.id } : { kind: "workspaceOnly" };
}

function isWorkspaceAdmin(c: Context, store: RouterDeps["store"], workspaceId: string): boolean {
  if (currentTaskAccessToken(c)) return false;
  const role = currentWorkspaceRoleStrict(c, store, workspaceId);
  return role === "owner" || role === "admin";
}

function channelError(c: Context, error: unknown): Response {
  if (error instanceof NotificationChannelValidationError) {
    return c.json({ error: error.message }, 400);
  }
  throw error;
}
