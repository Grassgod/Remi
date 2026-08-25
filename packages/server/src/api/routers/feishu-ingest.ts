import type { Context, Hono } from "hono";
import type {
  CreateMultiremiFeishuSourceInput,
  ResolveMultiremiFeishuMessageInput,
  UpdateMultiremiFeishuSourceInput,
} from "@multiremi/contracts/types.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  publishWorkspaceEvent,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { currentAccessToken } from "../wire/index.js";
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

  app.patch("/api/workspaces/:workspaceId/feishu/sources/:sourceId", async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<UpdateMultiremiFeishuSourceInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
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

function feishuIngestErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Feishu source not found") || message.startsWith("Feishu message not found")) {
    return c.json({ error: message }, 404);
  }
  if (
    message.includes("required")
    || message.includes("must be")
    || message.includes("unsupported")
    || message.includes("invalid")
    || message.includes("Invalid")
  ) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: "Feishu ingestion request failed" }, 500);
}
