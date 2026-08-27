import type { Context, Hono } from "hono";
import type {
  CreateIssueFromMultiremiFeishuMessageInput,
  CreateMultiremiFeishuSourceInput,
  DraftReplyMultiremiFeishuMessageInput,
  NotifyMultiremiFeishuMessageInput,
  ResolveMultiremiFeishuMessageInput,
  UpdateMultiremiFeishuSourceInput,
} from "@multiremi/contracts/types.js";
import {
  FeishuChatDirectoryError,
  normalizeFeishuChatQuery,
  normalizeFeishuChatScope,
} from "@multiremi/feishu-ingest/chat-directory.js";
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

  app.get("/api/workspaces/:workspaceId/feishu/endpoints", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanFeishuSourceAdmin(c, deps, workspaceId);
    if (denied) return denied;
    const names = deps.feishuSidecarEndpoints.names();
    const sourceCounts = new Map<string, number>();
    for (const source of store.listFeishuSources({ workspaceId })) {
      sourceCounts.set(source.endpointName, (sourceCounts.get(source.endpointName) ?? 0) + 1);
    }
    const endpoints = await Promise.all(names.map(async (name) => ({
      ...await deps.feishuEndpointHealth.get(name) ?? deps.feishuEndpointHealth.unknown(name),
      sourceCount: sourceCounts.get(name) ?? 0,
    })));
    return c.json({ configured: names.length > 0, endpoints });
  });

  app.post("/api/workspaces/:workspaceId/feishu/endpoints/:name/check", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanFeishuSourceAdmin(c, deps, workspaceId);
    if (denied) return denied;
    const name = c.req.param("name");
    const endpoint = await deps.feishuEndpointHealth.get(name, true);
    if (!endpoint) return c.json({ error: "Feishu sidecar endpoint not found" }, 404);
    const sourceCount = store.listFeishuSources({ workspaceId })
      .filter((source) => source.endpointName === name).length;
    return c.json({ endpoint: { ...endpoint, sourceCount } });
  });

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
      ?? requireHumanFeishuSourceAdmin(c, deps, workspaceId);
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

  app.delete("/api/workspaces/:workspaceId/feishu/sources/:sourceId", (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const source = loaded.source;
    if (!store.deleteFeishuSource(source.id)) return c.json({ error: "Feishu source not found" }, 404);
    publishWorkspaceEvent(c, store, "feishu:source_deleted", source.workspaceId, {
      sourceId: source.id,
      endpointName: source.endpointName,
      name: source.name,
    });
    return c.json({ deleted: true });
  });

  // Candidate chats for the allowlist picker. An empty allowlist ingests nothing, so
  // the dashboard cannot bootstrap one from already-ingested messages — the lookup is
  // proxied through a *registered endpoint name*, never a caller-supplied URL.
  app.get("/api/workspaces/:workspaceId/feishu/sources/:sourceId/available-chats", async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 20;
      const chats = await deps.feishuChatDirectory.search({
        endpointName: loaded.source.endpointName,
        scope: normalizeFeishuChatScope(c.req.query("scope")),
        query: normalizeFeishuChatQuery(c.req.query("q")),
        limit,
      });
      const allowlist = new Set(loaded.source.allowlist.map((entry) => entry.chatId));
      return c.json({
        chats: chats.map((chat) => ({ ...chat, inAllowlist: allowlist.has(chat.chatId) })),
        total: chats.length,
        limit,
      });
    } catch (error) {
      if (error instanceof FeishuChatDirectoryError) {
        return c.json({ error: "Feishu chat lookup failed", code: error.code }, error.status);
      }
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/feishu/messages", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 100;
      const offset = parseOffset(c.req.query("offset"));
      const page = store.listFeishuMessagesPage({
        workspaceId,
        sourceId: cleanQuery(c.req.query("source") ?? c.req.query("source_id")),
        query: cleanQuery(c.req.query("q")),
        processed: resolveProcessedFilter(
          parseBooleanQuery(c.req.query("processed"), "processed"),
          parseBooleanQuery(c.req.query("unprocessed"), "unprocessed"),
        ),
        since: cleanQuery(c.req.query("since")),
        until: cleanQuery(c.req.query("until")),
        chatId: cleanQuery(c.req.query("chat") ?? c.req.query("chat_id")),
        limit,
        offset,
      });
      const outcomes = store.listFeishuMessageOutcomesByMessageIds(page.messages.map((message) => message.messageId));
      const outcomesByMessage = new Map<string, typeof outcomes>();
      for (const outcome of outcomes) {
        const entries = outcomesByMessage.get(outcome.messageId) ?? [];
        entries.push(outcome);
        outcomesByMessage.set(outcome.messageId, entries);
      }
      const messages = page.messages.map((message) => ({
        ...message,
        outcomes: outcomesByMessage.get(message.messageId) ?? [],
      }));
      return c.json({
        messages,
        total: page.total,
        limit,
        offset,
        hasMore: offset + messages.length < page.total,
      });
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/feishu/chats", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const chats = store.listFeishuChats(workspaceId);
    return c.json({ chats, total: chats.length });
  });

  app.get("/api/workspaces/:workspaceId/feishu/proposals", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 100;
      const offset = parseOffset(c.req.query("offset"));
      const page = store.listFeishuIssueProposals({
        workspaceId,
        status: parseProposalStatus(c.req.query("status")),
        sourceId: cleanQuery(c.req.query("source") ?? c.req.query("source_id")),
        limit,
        offset,
      });
      return c.json({
        proposals: page.proposals,
        total: page.total,
        limit,
        offset,
        hasMore: offset + page.proposals.length < page.total,
      });
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

  app.post("/api/workspaces/:workspaceId/feishu/messages/:messageId/propose-issue", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueFromMultiremiFeishuMessageInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const token = currentAccessToken(c);
    const taskToken = token?.type === "task" ? token : null;
    try {
      const result = store.createFeishuIssueProposal(c.req.param("messageId"), {
        ...body,
        workspaceId,
        recipientId: taskToken?.userId ?? currentRequestUserId(c),
        taskId: taskToken?.taskId ?? null,
        actorType: taskToken ? "agent" : "member",
        actorId: taskToken?.agentId ?? currentRequestUserId(c),
      });
      if (result.inboxItem) {
        store.emitWorkspaceEvent({
          type: "inbox:new",
          workspaceId,
          actorType: taskToken ? "agent" : "member",
          actorId: taskToken?.agentId ?? currentRequestUserId(c),
          payload: { item: result.inboxItem },
        });
      }
      return c.json(
        { ...result, outcomes: store.listFeishuMessageOutcomes(result.message.messageId) },
        result.delivered && result.created ? 201 : 200,
      );
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.post("/api/workspaces/:workspaceId/feishu/messages/:messageId/create-issue", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanFeishuApprover(c, deps, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateIssueFromMultiremiFeishuMessageInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const result = store.createFeishuIssueOutcome(c.req.param("messageId"), {
        ...body,
        workspaceId,
        taskId: null,
        createdBy: currentRequestUserId(c),
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

  app.post("/api/workspaces/:workspaceId/feishu/proposals/:proposalId/approve", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanFeishuApprover(c, deps, workspaceId);
    if (denied) return denied;
    try {
      const result = store.approveFeishuIssueProposal(c.req.param("proposalId"), {
        workspaceId,
        approvedBy: currentRequestUserId(c),
      });
      if (result.created && result.issue) publishIssueCreated(c, store, result.issue);
      return c.json(
        { ...result, outcomes: store.listFeishuMessageOutcomes(result.message.messageId) },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return feishuIngestErrorResponse(c, error);
    }
  });

  app.post("/api/workspaces/:workspaceId/feishu/proposals/:proposalId/reject", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanFeishuApprover(c, deps, workspaceId);
    if (denied) return denied;
    try {
      const result = store.rejectFeishuIssueProposal(c.req.param("proposalId"), {
        workspaceId,
        rejectedBy: currentRequestUserId(c),
      });
      return c.json({ ...result, outcomes: store.listFeishuMessageOutcomes(result.message.messageId) });
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
    if (result.inboxItem) {
      deps.store.emitWorkspaceEvent({
        type: "inbox:new",
        workspaceId,
        actorType: taskToken ? "agent" : "member",
        actorId: taskToken?.agentId ?? currentRequestUserId(c),
        payload: { item: result.inboxItem },
      });
    }
    return c.json(
      { ...result, outcomes: deps.store.listFeishuMessageOutcomes(result.message.messageId) },
      result.delivered ? 201 : 200,
    );
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
    ?? (requireAdmin ? requireHumanFeishuSourceAdmin(c, deps, workspaceId) : null);
  if (denied) return denied;
  const source = deps.store.getFeishuSource(c.req.param("sourceId") ?? "");
  if (!source || source.workspaceId !== workspaceId) return c.json({ error: "Feishu source not found" }, 404);
  return { source };
}

function requireHumanFeishuSourceAdmin(c: Context, deps: RouterDeps, workspaceId: string): Response | null {
  if (currentAccessToken(c)?.type === "task") {
    return c.json({ error: "forbidden for task token", code: "human_admin_required" }, 403);
  }
  return requireWorkspaceAdmin(c, deps.store, workspaceId);
}

function requireHumanFeishuApprover(c: Context, deps: RouterDeps, workspaceId: string): Response | null {
  if (currentAccessToken(c)?.type === "task") {
    return c.json({ error: "forbidden for task token", code: "human_approval_required" }, 403);
  }
  return requireWorkspaceAdmin(c, deps.store, workspaceId);
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

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("offset must be a non-negative integer");
  return parsed;
}

function resolveProcessedFilter(processed: boolean | undefined, unprocessed: boolean | undefined): boolean | undefined {
  if (processed !== undefined && unprocessed !== undefined && processed === unprocessed) {
    throw new Error("processed and unprocessed filters conflict");
  }
  if (processed !== undefined) return processed;
  if (unprocessed !== undefined) return !unprocessed;
  return undefined;
}

function parseProposalStatus(value: string | undefined): "pending" | "approved" | "rejected" | undefined {
  if (value === undefined) return undefined;
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  throw new Error("status must be pending, approved, or rejected");
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
  if (
    message.startsWith("Feishu source not found")
    || message.startsWith("Feishu message not found")
    || message.startsWith("Feishu issue proposal not found")
  ) {
    return c.json({ error: message }, 404);
  }
  if (
    message === "Inbox recipient is unavailable or notifications are muted"
    || message === "Inbox recipient is unavailable"
    || message.includes("proposal is already")
  ) {
    return c.json({ error: message }, 409);
  }
  if (
    message.includes("required")
    || message.includes("must be")
    || message.includes("filters conflict")
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
