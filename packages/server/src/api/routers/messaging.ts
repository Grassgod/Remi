import type { Context, Hono } from "hono";
import {
  MessageProviderError,
  supportsConversations,
  type MessageConnection,
  type MessageErrorCode,
  type MessageOutcomeKind,
  type MessageProposalStatus,
  type MessageProvider,
  type MessageProviderHealth,
  type MessageSource,
} from "@multiremi/contracts/messaging.js";
import type { MultiremiAssigneeType } from "@multiremi/contracts/types.js";
import { createId } from "@multiremi/ids.js";
import { MessagingOutcomeError, type MessageIssueInput } from "@multiremi/messaging/outcomes.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  publishIssueCreated,
  publishWorkspaceEvent,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { currentAccessToken, currentRequestUserId } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

const BASE = "/api/workspaces/:workspaceId/messaging";

/**
 * The channel-independent messaging API.
 *
 * Nothing here names a channel. A route reaches a channel only through the
 * Provider registered for a Connection, so a new channel adds routes to
 * nobody's file.
 */
export function registerMessagingRoutes(app: Hono, deps: RouterDeps): void {
  const repo = deps.store.messaging;

  app.get(`${BASE}/providers`, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    return c.json({
      providers: deps.messagingProviders.list().map((provider) => provider.manifest),
      channels: deps.messagingProviders.channels(),
    });
  });

  app.get(`${BASE}/connections`, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    const workspaceId = c.req.param("workspaceId");
    const sourceCounts = new Map<string, number>();
    for (const source of repo.listSources({ workspaceId })) {
      sourceCounts.set(source.connectionId, (sourceCounts.get(source.connectionId) ?? 0) + 1);
    }
    const connections = repo.listConnections({ workspaceId }).map((connection) => ({
      ...connection,
      sourceCount: sourceCounts.get(connection.id) ?? 0,
      // Whether a Provider is registered at all is a different problem from
      // whether its credential works, and the UI has to tell them apart.
      providerRegistered: deps.messagingProviders.has(connection.provider),
    }));
    return c.json({ connections, total: connections.length });
  });

  app.post(`${BASE}/connections`, async (c) => {
    const denied = denyWorkspace(c, deps) ?? requireHumanAdmin(c, deps);
    if (denied) return denied;
    const body = await readJsonStrict<CreateConnectionBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = c.req.param("workspaceId");
    try {
      const provider = resolveProvider(deps, body.provider ?? "");
      const connection = repo.upsertConnection({
        id: createId("mconn"),
        workspaceId,
        provider: provider.manifest.provider,
        channel: resolveChannel(provider, body.channel),
        name: requireText(body.name, "name"),
        config: body.config ?? {},
        status: "unknown",
      });
      publishWorkspaceEvent(c, deps.store, "messaging:connection_created", workspaceId, { connection });
      return c.json({ connection }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/connections/:connectionId`, (c) => {
    const loaded = loadConnection(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ connection: loaded });
  });

  app.patch(`${BASE}/connections/:connectionId`, async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<UpdateConnectionBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const connection = repo.upsertConnection({
        id: loaded.id,
        workspaceId: loaded.workspaceId,
        // Provider and channel are identity, not settings: changing either
        // would silently reinterpret every message already stored under this
        // Connection. Rebinding means a new Connection.
        provider: loaded.provider,
        channel: loaded.channel,
        name: body.name === undefined ? loaded.name : requireText(body.name, "name"),
        config: body.config ?? loaded.config,
      });
      publishWorkspaceEvent(c, deps.store, "messaging:connection_updated", connection.workspaceId, { connection });
      return c.json({ connection });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete(`${BASE}/connections/:connectionId`, (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    if (!repo.deleteConnection(loaded.id)) return c.json({ error: "Message connection not found" }, 404);
    publishWorkspaceEvent(c, deps.store, "messaging:connection_deleted", loaded.workspaceId, {
      connectionId: loaded.id,
      name: loaded.name,
    });
    return c.json({ deleted: true });
  });

  /** Probes the Provider now and stores the verdict, so the UI can retry on demand. */
  app.post(`${BASE}/connections/:connectionId/check`, async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    try {
      return c.json(await probeConnection(deps, loaded));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/sources`, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    const sources = repo.listSources({ workspaceId: c.req.param("workspaceId") });
    return c.json({ sources, total: sources.length });
  });

  app.post(`${BASE}/sources`, async (c) => {
    const denied = denyWorkspace(c, deps) ?? requireHumanAdmin(c, deps);
    if (denied) return denied;
    const body = await readJsonStrict<UpsertSourceBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = c.req.param("workspaceId");
    try {
      const connection = repo.getConnection(body.connectionId ?? "");
      if (!connection || connection.workspaceId !== workspaceId) {
        return c.json({ error: "Message connection not found" }, 404);
      }
      if (workspaceId === "local") deps.store.ensureLocalWorkspace();
      const source = repo.upsertSource({
        id: createId("msrc"),
        workspaceId,
        connectionId: connection.id,
        name: requireText(body.name, "name"),
        allowlist: normalizeAllowlist(body.allowlist),
        enabled: body.enabled,
        retentionDays: body.retentionDays,
        pollIntervalSeconds: body.pollIntervalSeconds,
        unprocessedRetrySeconds: body.unprocessedRetrySeconds,
        unprocessedRetryLimit: body.unprocessedRetryLimit,
      });
      publishWorkspaceEvent(c, deps.store, "messaging:source_created", workspaceId, { source });
      return c.json({ source }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/sources/:sourceId`, (c) => {
    const loaded = loadSource(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ source: loaded });
  });

  app.patch(`${BASE}/sources/:sourceId`, async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<UpsertSourceBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const source = repo.upsertSource({
        id: loaded.id,
        workspaceId: loaded.workspaceId,
        connectionId: loaded.connectionId,
        name: body.name === undefined ? loaded.name : requireText(body.name, "name"),
        allowlist: body.allowlist === undefined ? loaded.allowlist : normalizeAllowlist(body.allowlist),
        enabled: body.enabled,
        retentionDays: body.retentionDays,
        pollIntervalSeconds: body.pollIntervalSeconds,
        unprocessedRetrySeconds: body.unprocessedRetrySeconds,
        unprocessedRetryLimit: body.unprocessedRetryLimit,
      });
      publishWorkspaceEvent(c, deps.store, "messaging:source_updated", source.workspaceId, { source });
      return c.json({ source });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete(`${BASE}/sources/:sourceId`, (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    if (!repo.deleteSource(loaded.id)) return c.json({ error: "Message source not found" }, 404);
    publishWorkspaceEvent(c, deps.store, "messaging:source_deleted", loaded.workspaceId, {
      sourceId: loaded.id,
      connectionId: loaded.connectionId,
      name: loaded.name,
    });
    return c.json({ deleted: true });
  });

  app.get(`${BASE}/sources/:sourceId/status`, (c) => {
    const loaded = loadSource(c, deps);
    if (loaded instanceof Response) return loaded;
    const status = repo.getSourceStatus(loaded.id);
    if (!status) return c.json({ error: "Message source not found" }, 404);
    return c.json({ status });
  });

  /**
   * Candidate conversations for the allowlist picker.
   *
   * An empty allowlist ingests nothing, so this cannot be bootstrapped from
   * stored messages — it has to ask the channel. It goes through the
   * Connection's registered Provider, never a caller-supplied address.
   */
  app.get(`${BASE}/sources/:sourceId/available-conversations`, async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const connection = repo.getConnection(loaded.connectionId);
    if (!connection) return c.json({ error: "Message connection not found" }, 404);
    const provider = deps.messagingProviders.get(connection.provider);
    if (!provider || !supportsConversations(provider)) {
      return c.json({ error: "Provider cannot search conversations", code: "capability_unsupported" }, 400);
    }
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 20;
      const result = await provider.searchConversations({ connection }, {
        query: c.req.query("q")?.trim() || undefined,
        limit,
        cursor: c.req.query("cursor")?.trim() || null,
      });
      const allowed = new Set(loaded.allowlist.map((entry) => entry.externalConversationId));
      return c.json({
        conversations: result.conversations.map((conversation) => ({
          ...conversation,
          inAllowlist: allowed.has(conversation.externalConversationId),
        })),
        total: result.conversations.length,
        cursor: result.cursor,
        done: result.done,
        limit,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/conversations`, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    const conversations = repo.listConversations(c.req.param("workspaceId"));
    return c.json({ conversations, total: conversations.length });
  });

  app.get(`${BASE}/messages`, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 100;
      const offset = parseOffset(c.req.query("offset"));
      const page = repo.listMessages({
        workspaceId: c.req.param("workspaceId"),
        sourceId: cleanQuery(c.req.query("source")),
        connectionId: cleanQuery(c.req.query("connection")),
        externalConversationId: cleanQuery(c.req.query("conversation")),
        query: cleanQuery(c.req.query("q")),
        processed: resolveProcessedFilter(
          parseBooleanQuery(c.req.query("processed"), "processed"),
          parseBooleanQuery(c.req.query("unprocessed"), "unprocessed"),
        ),
        since: cleanQuery(c.req.query("since")),
        until: cleanQuery(c.req.query("until")),
        limit,
        offset,
      });
      const outcomes = repo.listOutcomesForMessages(page.messages);
      const byMessage = new Map<string, typeof outcomes>();
      for (const outcome of outcomes) {
        const key = messageKey(outcome.connectionId, outcome.externalMessageId);
        byMessage.set(key, [...byMessage.get(key) ?? [], outcome]);
      }
      const messages = page.messages.map((message) => ({
        ...message,
        outcomes: byMessage.get(messageKey(message.connectionId, message.externalMessageId)) ?? [],
      }));
      return c.json({
        messages,
        total: page.total,
        limit,
        offset,
        hasMore: offset + messages.length < page.total,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  const MESSAGE = `${BASE}/connections/:connectionId/messages/:externalMessageId`;

  app.get(MESSAGE, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    const ref = messageRef(c);
    const message = repo.getMessage(ref.connectionId, ref.externalMessageId);
    if (!message || message.workspaceId !== c.req.param("workspaceId")) {
      return c.json({ error: "Message not found" }, 404);
    }
    return c.json({ message, outcomes: repo.listOutcomes(ref.connectionId, ref.externalMessageId) });
  });

  app.post(`${MESSAGE}/resolve`, async (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    const body = await readJsonStrict<ResolveBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = c.req.param("workspaceId");
    const token = currentAccessToken(c);
    const ref = messageRef(c);
    try {
      const result = deps.store.messagingOutcomes.record(ref, {
        workspaceId,
        outcome: body.outcome as ResolveBody["outcome"],
        reason: body.reason,
        // A task token names its own task: an agent cannot attribute its work
        // to a different task by asking.
        taskId: token?.type === "task" ? token.taskId : body.taskId ?? null,
      });
      return c.json({ ...result, outcomes: repo.listOutcomes(ref.connectionId, ref.externalMessageId) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${MESSAGE}/notify`, async (c) => {
    const body = await readJsonStrict<NotifyBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return inboxOutcomeResponse(c, deps, "notified", body.summary ?? "");
  });

  app.post(`${MESSAGE}/draft-reply`, async (c) => {
    const body = await readJsonStrict<DraftReplyBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return inboxOutcomeResponse(c, deps, "reply_drafted", body.draftText ?? "");
  });

  app.post(`${MESSAGE}/propose-issue`, async (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    const body = await readJsonStrict<IssueBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = c.req.param("workspaceId");
    const token = currentAccessToken(c);
    const taskToken = token?.type === "task" ? token : null;
    const ref = messageRef(c);
    try {
      const result = deps.store.messagingOutcomes.proposeIssue(ref, {
        ...issueDraft(body),
        workspaceId,
        recipientId: taskToken?.userId ?? currentRequestUserId(c),
        taskId: taskToken?.taskId ?? null,
        actorType: taskToken ? "agent" : "member",
        actorId: taskToken?.agentId ?? currentRequestUserId(c),
      });
      if (result.inboxItem) {
        publishWorkspaceEvent(c, deps.store, "inbox:new", workspaceId, { item: result.inboxItem });
      }
      return c.json(
        { ...result, outcomes: repo.listOutcomes(ref.connectionId, ref.externalMessageId) },
        result.delivered && result.created ? 201 : 200,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${MESSAGE}/create-issue`, async (c) => {
    const denied = denyWorkspace(c, deps) ?? requireHumanApprover(c, deps);
    if (denied) return denied;
    const body = await readJsonStrict<IssueBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const ref = messageRef(c);
    try {
      const result = deps.store.messagingOutcomes.createIssue(ref, {
        ...issueDraft(body),
        workspaceId: c.req.param("workspaceId"),
        taskId: null,
        createdBy: currentRequestUserId(c),
      });
      if (result.created) publishIssueCreated(c, deps.store, result.issue);
      return c.json(
        { ...result, outcomes: repo.listOutcomes(ref.connectionId, ref.externalMessageId) },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/proposals`, (c) => {
    const denied = denyWorkspace(c, deps);
    if (denied) return denied;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 100;
      const offset = parseOffset(c.req.query("offset"));
      const page = repo.listProposals({
        workspaceId: c.req.param("workspaceId"),
        status: parseProposalStatus(c.req.query("status")) ?? undefined,
        sourceId: cleanQuery(c.req.query("source")),
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
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/proposals/:proposalId/approve`, (c) => {
    const denied = denyWorkspace(c, deps) ?? requireHumanApprover(c, deps);
    if (denied) return denied;
    try {
      const result = deps.store.messagingOutcomes.approveProposal(c.req.param("proposalId") ?? "", {
        workspaceId: c.req.param("workspaceId"),
        approvedBy: currentRequestUserId(c),
      });
      if (result.created && result.issue) publishIssueCreated(c, deps.store, result.issue);
      return c.json(
        { ...result, outcomes: repo.listOutcomes(result.proposal.connectionId, result.proposal.externalMessageId) },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/proposals/:proposalId/reject`, (c) => {
    const denied = denyWorkspace(c, deps) ?? requireHumanApprover(c, deps);
    if (denied) return denied;
    try {
      const result = deps.store.messagingOutcomes.rejectProposal(c.req.param("proposalId") ?? "", {
        workspaceId: c.req.param("workspaceId"),
        rejectedBy: currentRequestUserId(c),
      });
      return c.json({
        ...result,
        outcomes: repo.listOutcomes(result.proposal.connectionId, result.proposal.externalMessageId),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}

/**
 * Asks the Provider how the Connection is doing, and stores the answer.
 *
 * Exported because the legacy `/feishu` endpoint-check route has to reach the
 * same verdict: two probes that could disagree would be two definitions of
 * "connected". Throws only on a Provider bug — `checkHealth` is contracted to
 * report expected failures as a status, not an exception.
 */
export async function probeConnection(
  deps: RouterDeps,
  connection: MessageConnection,
): Promise<{ connection: MessageConnection; health: MessageProviderHealth | null }> {
  const repo = deps.store.messaging;
  const provider = deps.messagingProviders.get(connection.provider);
  if (!provider) {
    const checkedAt = new Date().toISOString();
    return {
      connection: repo.upsertConnection({
        ...connectionIdentity(connection),
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastErrorCode: "provider_unavailable",
        lastErrorAt: checkedAt,
      }),
      health: null,
    };
  }
  const health = await provider.checkHealth({ connection });
  return {
    connection: repo.upsertConnection({
      ...connectionIdentity(connection),
      externalAccountId: health.externalAccountId,
      externalAccountName: health.externalAccountName,
      status: health.status,
      lastCheckedAt: health.checkedAt,
      lastErrorCode: health.errorCode,
      lastErrorAt: health.errorCode ? health.checkedAt : null,
    }),
    health,
  };
}

/** The notify and draft-reply paths differ only in which text they carry. */
function inboxOutcomeResponse(
  c: Context,
  deps: RouterDeps,
  kind: "notified" | "reply_drafted",
  text: string,
): Response {
  const denied = denyWorkspace(c, deps);
  if (denied) return denied;
  const token = currentAccessToken(c);
  const taskToken = token?.type === "task" ? token : null;
  const workspaceId = c.req.param("workspaceId") ?? "";
  const ref = messageRef(c);
  try {
    const result = deps.store.messagingOutcomes.notify(ref, kind, {
      workspaceId,
      recipientId: taskToken?.userId ?? currentRequestUserId(c),
      taskId: taskToken?.taskId ?? null,
      actorType: taskToken ? "agent" : "member",
      actorId: taskToken?.agentId ?? currentRequestUserId(c),
      text,
    });
    if (result.inboxItem) {
      publishWorkspaceEvent(c, deps.store, "inbox:new", workspaceId, { item: result.inboxItem });
    }
    return c.json(
      { ...result, outcomes: deps.store.messaging.listOutcomes(ref.connectionId, ref.externalMessageId) },
      result.delivered ? 201 : 200,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

/**
 * The composite message identity, read from the path.
 *
 * Both halves are in the URL because neither is unique alone: the same channel
 * message id can be ingested by two Connections pointing at two accounts.
 */
function messageRef(c: Context): { connectionId: string; externalMessageId: string } {
  return {
    connectionId: c.req.param("connectionId") ?? "",
    externalMessageId: c.req.param("externalMessageId") ?? "",
  };
}

export function issueDraft(body: IssueBody): MessageIssueInput {
  return {
    title: body.title ?? "",
    description: body.description ?? null,
    priority: body.priority ?? null,
    projectId: body.projectId ?? null,
    assigneeType: body.assigneeType ?? null,
    assigneeId: body.assigneeId ?? null,
  };
}

function parseProposalStatus(value: string | undefined): MessageProposalStatus | null {
  const status = value?.trim();
  if (!status || status === "all") return null;
  if (status === "pending" || status === "approved" || status === "rejected") return status;
  throw new Error("status must be pending, approved, rejected or all");
}

interface CreateConnectionBody {
  provider?: string;
  channel?: string;
  name?: string;
  config?: Record<string, unknown>;
}

interface UpdateConnectionBody {
  name?: string;
  config?: Record<string, unknown>;
}

interface UpsertSourceBody {
  connectionId?: string;
  name?: string;
  allowlist?: unknown;
  enabled?: boolean;
  retentionDays?: number;
  pollIntervalSeconds?: number;
  unprocessedRetrySeconds?: number;
  unprocessedRetryLimit?: number;
}

interface ResolveBody {
  outcome: MessageOutcomeKind;
  reason?: string | null;
  taskId?: string | null;
}

interface NotifyBody {
  summary?: string;
}

interface DraftReplyBody {
  draftText?: string;
}

interface IssueBody {
  title?: string;
  description?: string | null;
  priority?: string | null;
  projectId?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
}

function connectionIdentity(connection: MessageConnection): {
  id: string; workspaceId: string; provider: string; channel: string; name: string;
} {
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    provider: connection.provider,
    channel: connection.channel,
    name: connection.name,
  };
}

function resolveProvider(deps: RouterDeps, provider: string): MessageProvider {
  const resolved = deps.messagingProviders.get(provider.trim());
  if (!resolved) throw new Error(`provider is not registered: ${provider.trim() || "(empty)"}`);
  return resolved;
}

function resolveChannel(provider: MessageProvider, channel: string | undefined): string {
  const requested = channel?.trim();
  const channels = provider.manifest.channels;
  if (!requested) {
    // Only defaulted when there is no choice to make; otherwise the caller must say.
    if (channels.length === 1) return channels[0]!;
    throw new Error(`channel is required for provider ${provider.manifest.provider}`);
  }
  if (!channels.includes(requested)) {
    throw new Error(`provider ${provider.manifest.provider} does not serve channel ${requested}`);
  }
  return requested;
}

export function normalizeAllowlist(value: unknown): MessageSource["allowlist"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("allowlist must be an array");
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const entries: MessageSource["allowlist"] = [];
  for (const raw of value) {
    const entry = typeof raw === "string" ? { externalConversationId: raw } : raw;
    if (!entry || typeof entry !== "object") throw new Error("allowlist entries must be objects");
    const record = entry as Record<string, unknown>;
    const id = String(record.externalConversationId ?? record.external_conversation_id ?? "").trim();
    if (!id) throw new Error("allowlist entries must reference a conversation");
    if (seen.has(id)) continue;
    seen.add(id);
    // A caller cannot backdate consent: an entry without a timestamp starts now,
    // and a supplied one is only honoured if it parses.
    const addedAt = String(record.addedAt ?? record.added_at ?? "").trim();
    entries.push({
      externalConversationId: id,
      addedAt: Number.isFinite(Date.parse(addedAt)) ? new Date(addedAt).toISOString() : now,
    });
  }
  return entries;
}

function loadConnection(c: Context, deps: RouterDeps, requireAdmin = false): MessageConnection | Response {
  const denied = denyWorkspace(c, deps) ?? (requireAdmin ? requireHumanAdmin(c, deps) : null);
  if (denied) return denied;
  const connection = deps.store.messaging.getConnection(c.req.param("connectionId") ?? "");
  if (!connection || connection.workspaceId !== c.req.param("workspaceId")) {
    return c.json({ error: "Message connection not found" }, 404);
  }
  return connection;
}

function loadSource(c: Context, deps: RouterDeps, requireAdmin = false): MessageSource | Response {
  const denied = denyWorkspace(c, deps) ?? (requireAdmin ? requireHumanAdmin(c, deps) : null);
  if (denied) return denied;
  const source = deps.store.messaging.getSource(c.req.param("sourceId") ?? "");
  if (!source || source.workspaceId !== c.req.param("workspaceId")) {
    return c.json({ error: "Message source not found" }, 404);
  }
  return source;
}

function denyWorkspace(c: Context, deps: RouterDeps): Response | null {
  return denyCurrentUserWorkspaceAccess(c, deps.store, c.req.param("workspaceId") ?? "");
}

/**
 * Administering a Connection or Source is a consent decision.
 *
 * A task token is an agent acting on someone's behalf, so it may read and it
 * may record outcomes, but it may not widen what the platform ingests.
 */
function requireHumanAdmin(c: Context, deps: RouterDeps): Response | null {
  if (currentAccessToken(c)?.type === "task") {
    return c.json({ error: "forbidden for task token", code: "human_admin_required" }, 403);
  }
  return requireWorkspaceAdmin(c, deps.store, c.req.param("workspaceId") ?? "");
}

/**
 * Approving an Issue, or creating one outright, is a human decision.
 *
 * An agent may propose; the point of a proposal is that somebody else says yes.
 */
function requireHumanApprover(c: Context, deps: RouterDeps): Response | null {
  if (currentAccessToken(c)?.type === "task") {
    return c.json({ error: "forbidden for task token", code: "human_approval_required" }, 403);
  }
  return requireWorkspaceAdmin(c, deps.store, c.req.param("workspaceId") ?? "");
}

function messageKey(connectionId: string, externalMessageId: string): string {
  return `${connectionId}\u0000${externalMessageId}`;
}

export function requireText(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

export function parseBooleanQuery(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) throw new Error("limit must be between 1 and 500");
  return parsed;
}

export function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("offset must be a non-negative integer");
  return parsed;
}

export function resolveProcessedFilter(processed: boolean | undefined, unprocessed: boolean | undefined): boolean | undefined {
  if (processed !== undefined && unprocessed !== undefined && processed === unprocessed) {
    throw new Error("processed and unprocessed filters conflict");
  }
  if (processed !== undefined) return processed;
  if (unprocessed !== undefined) return !unprocessed;
  return undefined;
}

export function cleanQuery(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof MessagingOutcomeError) {
    // The service already decided whether this was a bad request, a missing
    // message, or a decision somebody else already made.
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof MessageProviderError) {
    // The Provider already classified this; the status follows the code rather
    // than a guess at the message text.
    return c.json({ error: "Messaging provider request failed", code: error.code }, statusForCode(error.code));
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.endsWith("not found")) return c.json({ error: message }, 404);
  if (
    message.includes("required")
    || message.includes("must be")
    || message.includes("must not")
    || message.includes("must reference")
    || message.includes("filters conflict")
    || message.includes("not registered")
    || message.includes("does not serve")
    || message.includes("cannot be rebound")
  ) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: "Messaging request failed" }, 500);
}

function statusForCode(code: MessageErrorCode): 400 | 403 | 404 | 429 | 502 | 503 | 504 {
  switch (code) {
    // 403, not 401: the caller authenticated with Multiremi fine — it is the
    // channel credential behind the Connection that is not usable.
    case "unauthenticated":
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "capability_unsupported":
      return 400;
    case "timeout":
      return 504;
    case "provider_unavailable":
    case "provider_incompatible":
      return 503;
    default:
      return 502;
  }
}
