import type { Context, Hono } from "hono";
import type {
  CreateIssueFromMultiremiFeishuMessageInput,
  CreateMultiremiFeishuSourceInput,
  DraftReplyMultiremiFeishuMessageInput,
  NotifyMultiremiFeishuMessageInput,
  ResolveMultiremiFeishuMessageInput,
  UpdateMultiremiFeishuSourceInput,
} from "@multiremi/contracts/types.js";
import { publishIssueCreated } from "../helpers/store-bridge.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  publishWorkspaceEvent,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { currentAccessToken, currentRequestUserId } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerFeishuIngestRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/workspaces/:workspaceId/feishu/sources", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sources = store.listFeishuSources({ workspaceId });
    return c.json({ sources, total: sources.length });
  });

  app.post("/api/workspaces/:workspaceId/feishu/sources", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateMultiremiFeishuSourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const endpointName = body.endpointName ?? body.endpoint_name ?? "";
      requireConfiguredEndpoint(deps, endpointName);
      if (workspaceId === "local") store.ensureLocalWorkspace();
      const source = store.createFeishuSource({ ...body, workspaceId });
      publishWorkspaceEvent(c, store, "feishu:source_created", workspaceId, { source });
      return c.json({ source }, 201);
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/feishu/sources/:sourceId", (c) => {
    const loaded = loadSource(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ source: loaded.source });
  });

  app.get("/api/workspaces/:workspaceId/feishu/sources/:sourceId/status", (c) => {
    const loaded = loadSource(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ status: store.getFeishuSourceStatus(loaded.source.id) });
  });

  app.patch("/api/workspaces/:workspaceId/feishu/sources/:sourceId", async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<UpdateMultiremiFeishuSourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const requestedEndpointName = body.endpointName ?? body.endpoint_name;
      if (requestedEndpointName !== undefined) requireConfiguredEndpoint(deps, requestedEndpointName);
      const resultingEndpointName = requestedEndpointName ?? loaded.source.endpointName;
      const resultingEnabled = body.enabled ?? loaded.source.enabled;
      if (resultingEnabled) requireConfiguredEndpoint(deps, resultingEndpointName);
      const source = store.updateFeishuSource(loaded.source.id, body);
      publishWorkspaceEvent(c, store, "feishu:source_updated", source.workspaceId, { source });
      return c.json({ source });
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/feishu/messages", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const messages = store.listFeishuMessages({
        workspaceId,
        unprocessed: parseBooleanQuery(c.req.query("unprocessed"), "unprocessed"),
        since: cleanQuery(c.req.query("since")),
        until: cleanQuery(c.req.query("until")),
        chatId: cleanQuery(c.req.query("chat") ?? c.req.query("chat_id")),
        limit: parseLimit(c.req.query("limit")),
      });
      return c.json({ messages, total: messages.length });
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.post("/api/workspaces/:workspaceId/feishu/messages/:messageId/resolve", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const message = store.getFeishuMessage(c.req.param("messageId"));
    if (!message || message.workspaceId !== workspaceId) return c.json({ error: "Feishu message not found" }, 404);
    const body = await readJsonStrict<ResolveMultiremiFeishuMessageInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const token = currentAccessToken(c);
    const taskId = token?.type === "task" ? token.taskId : body.taskId ?? body.task_id;
    try {
      const resolved = store.resolveFeishuMessage(message.messageId, { ...body, workspaceId, taskId });
      return c.json({ ...resolved, outcomes: store.listFeishuMessageOutcomes(message.messageId) });
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.post("/api/workspaces/:workspaceId/feishu/messages/:messageId/notify", async (c) => {
    const body = await readJsonStrict<NotifyMultiremiFeishuMessageInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return createInboxOutcomeResponse(c, deps, "notified", body.summary);
  });

  app.post("/api/workspaces/:workspaceId/feishu/messages/:messageId/draft-reply", async (c) => {
    const body = await readJsonStrict<DraftReplyMultiremiFeishuMessageInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return createInboxOutcomeResponse(c, deps, "reply_drafted", body.draftText ?? body.draft_text ?? "");
  });

  app.post("/api/workspaces/:workspaceId/feishu/messages/:messageId/create-issue", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueFromMultiremiFeishuMessageInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const token = currentAccessToken(c);
    const taskToken = token?.type === "task" ? token : null;
    try {
      const result = store.createFeishuIssueOutcome(c.req.param("messageId"), {
        ...body,
        workspaceId,
        taskId: taskToken?.taskId ?? null,
        createdBy: taskToken?.userId ?? currentRequestUserId(c),
      });
      if (result.created) publishIssueCreated(c, store, result.issue);
      return c.json(
        { ...result, outcomes: store.listFeishuMessageOutcomes(result.message.messageId) },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });
}

function createInboxOutcomeResponse(
  c: Context,
  deps: RouterDeps,
  outcomeKind: "notified" | "reply_drafted",
  text: string,
): Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId);
  if (denied) return denied;
  const token = currentAccessToken(c);
  const taskToken = token?.type === "task" ? token : null;
  try {
    const result = deps.store.createFeishuInboxOutcome(c.req.param("messageId") ?? "", outcomeKind, {
      workspaceId,
      recipientId: taskToken?.userId ?? currentRequestUserId(c),
      taskId: taskToken?.taskId ?? null,
      actorType: taskToken ? "agent" : "member",
      actorId: taskToken?.agentId ?? currentRequestUserId(c),
      text,
    });
    deps.store.emitWorkspaceEvent({
      type: "inbox:new",
      workspaceId,
      actorType: taskToken ? "agent" : "member",
      actorId: taskToken?.agentId ?? currentRequestUserId(c),
      payload: { item: result.inboxItem },
    });
    return c.json({ ...result, outcomes: deps.store.listFeishuMessageOutcomes(result.message.messageId) }, 201);
  } catch (error) {
    return feishuIngestErrorResponse(c, error);
  }
}

function loadSource(
  c: Context,
  deps: RouterDeps,
  requireAdmin = false,
): { source: NonNullable<ReturnType<RouterDeps["store"]["getFeishuSource"]>> } | Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId)
    ?? (requireAdmin ? requireWorkspaceAdmin(c, deps.store, workspaceId) : null);
  if (denied) return denied;
  const source = deps.store.getFeishuSource(c.req.param("sourceId") ?? "");
  if (!source || source.workspaceId !== workspaceId) return c.json({ error: "Feishu source not found" }, 404);
  return { source };
}

function parseBooleanQuery(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) throw new Error("limit must be between 1 and 500");
  return parsed;
}

function cleanQuery(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function requireConfiguredEndpoint(deps: RouterDeps, endpointName: string): void {
  if (!deps.feishuSidecarEndpoints.has(endpointName)) {
    throw new Error("Feishu sidecar endpoint_name is not configured by the server");
  }
}

function feishuIngestErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Feishu source not found") || message.startsWith("Feishu message not found")) {
    return c.json({ error: message }, 404);
  }
  if (message === "Inbox recipient is unavailable or notifications are muted") {
    return c.json({ error: message }, 409);
  }
  if (
    message.includes("required")
    || message.includes("must be")
    || message.includes("must reference")
    || message.includes("unsupported")
    || message.includes("invalid")
    || message.includes("Invalid")
    || message.includes("not configured")
    || message.includes("dedicated Feishu command")
    || message.includes("assigned only by dedicated Feishu outcome commands")
  ) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: "Feishu ingestion request failed" }, 500);
}
