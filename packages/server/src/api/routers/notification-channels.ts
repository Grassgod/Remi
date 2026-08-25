import type { Context, Hono } from "hono";
import type {
  MultiremiNotificationChannelKind,
  MultiremiNotificationDeliveryStatus,
} from "@multiremi/contracts/types.js";
import { NotificationChannelValidationError } from "@multiremi/store/repos/notification-channels-repo.js";
import {
  compatibilityWorkspaceId,
  denyCurrentUserWorkspaceAccess,
  readJson,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { authenticatedRequestUserId, currentTaskAccessToken } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

type ChannelBody = {
  workspaceId?: string | null;
  workspace_id?: string | null;
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

export function registerNotificationChannelRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/notification-channels", (c) => {
    const workspaceId = requestWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const channels = store.listNotificationChannels(workspaceId);
    return c.json({ channels, total: channels.length });
  });

  app.post("/api/multiremi/notification-channels", async (c) => {
    const body = await readJson<ChannelBody>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? requestWorkspaceId(c);
    const denied = requireNotificationAdmin(c, store, workspaceId);
    if (denied) return denied;
    try {
      const channel = store.createNotificationChannel({
        workspaceId,
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
    const denied = requireNotificationAdmin(c, store, current.workspaceId);
    if (denied) return denied;
    const body = await readJson<ChannelBody>(c);
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
    const denied = requireNotificationAdmin(c, store, current.workspaceId);
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
    });
    return c.json({ deliveries, total: deliveries.length });
  });

  app.post("/api/multiremi/notification-deliveries/:id/retry", (c) => {
    const current = store.getNotificationDelivery(c.req.param("id"));
    if (!current) return c.json({ error: "notification delivery not found" }, 404);
    const denied = requireNotificationAdmin(c, store, current.workspaceId);
    if (denied) return denied;
    if (current.status === "sent") {
      return c.json({ error: "sent notification deliveries cannot be retried" }, 409);
    }
    const delivery = store.retryNotificationDelivery(current.id);
    if (!delivery) return c.json({ error: "notification delivery cannot be retried" }, 409);
    return c.json({ delivery }, 202);
  });
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

function channelError(c: Context, error: unknown): Response {
  if (error instanceof NotificationChannelValidationError) {
    return c.json({ error: error.message }, 400);
  }
  throw error;
}
