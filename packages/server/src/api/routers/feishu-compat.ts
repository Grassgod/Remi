import type { Context, Hono } from "hono";
import {
  supportsConversations,
  type MessageConnection,
  type MessageConversation,
  type MessageConversationKind,
  type MessageConversationSummary,
  type MessageOutcome,
  type MessageSource,
  type MessageSourceStatus,
} from "@multiremi/contracts/messaging.js";
import type { MultiremiAssigneeType } from "@multiremi/contracts/types.js";
import { createId } from "@multiremi/ids.js";
import type { StoredCanonicalMessage } from "@multiremi/store/repos/messaging-repo.js";
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
import {
  cleanQuery,
  errorResponse,
  issueDraft,
  normalizeAllowlist,
  parseBooleanQuery,
  parseLimit,
  parseOffset,
  probeConnection,
  requireText,
  resolveProcessedFilter,
} from "./messaging.js";
import type { RouterDeps } from "./deps.js";

const BASE = "/api/workspaces/:workspaceId/feishu";

/** The compat layer serves exactly one channel; everything else is invisible to it. */
const CHANNEL = "feishu";

/**
 * The legacy `/feishu` API, served by the Messaging Core.
 *
 * Desktop builds already in the field call these paths, so they keep working —
 * but nothing behind them is Feishu-specific any more. Each route translates
 * the legacy vocabulary into the Core's and back:
 *
 *   sidecar endpoint  → Connection on channel `feishu`
 *   chat id           → external conversation id
 *   message id        → external message id, resolved within the workspace
 *
 * The translation is one-directional on purpose. New surfaces call
 * `/messaging`, which addresses a message by `(connectionId, externalMessageId)`
 * and never has to guess. This file guesses, carefully, and refuses when it
 * cannot: the legacy id space assumed one account per channel, and that
 * assumption is what the Core removed.
 */
export function registerFeishuCompatRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  const repo = store.messaging;

  app.get(`${BASE}/endpoints`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId) ?? requireHumanAdmin(c, deps, workspaceId);
    if (denied) return denied;
    const connections = feishuConnections(deps, workspaceId);
    const sourceCounts = new Map<string, number>();
    for (const source of repo.listSources({ workspaceId })) {
      sourceCounts.set(source.connectionId, (sourceCounts.get(source.connectionId) ?? 0) + 1);
    }
    // The migration made one Connection per legacy Source, so several can carry
    // the same endpoint name. Grouping keeps the old one-row-per-endpoint view.
    const grouped = new Map<string, { connections: MessageConnection[]; sourceCount: number }>();
    for (const connection of connections) {
      const name = endpointName(connection);
      const entry = grouped.get(name) ?? { connections: [], sourceCount: 0 };
      entry.connections.push(connection);
      entry.sourceCount += sourceCounts.get(connection.id) ?? 0;
      grouped.set(name, entry);
    }
    const endpoints = [...grouped].map(([name, entry]) => ({
      ...legacyEndpoint(deps, name, entry.connections),
      sourceCount: entry.sourceCount,
    }));
    return c.json({ configured: endpoints.length > 0, endpoints });
  });

  app.post(`${BASE}/endpoints/:name/check`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId) ?? requireHumanAdmin(c, deps, workspaceId);
    if (denied) return denied;
    const name = c.req.param("name");
    const connections = feishuConnections(deps, workspaceId).filter((item) => endpointName(item) === name);
    if (!connections.length) return c.json({ error: "Feishu connection not found" }, 404);
    try {
      // Every Connection under this name is probed: the old endpoint row stood
      // for a whole sidecar, and reporting one of several as its health would
      // hide the broken ones.
      const checked = await Promise.all(connections.map((connection) => probeConnection(deps, connection)));
      const sourceCount = connections
        .reduce((total, connection) => total + repo.listSources({ workspaceId, connectionId: connection.id }).length, 0);
      const health = checked.find((item) => item.health)?.health ?? null;
      return c.json({
        endpoint: {
          ...legacyEndpoint(deps, name, checked.map((item) => item.connection)),
          version: health?.version ?? null,
          sourceCount,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/sources`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sources = feishuSources(deps, workspaceId);
    return c.json({ sources: sources.map(({ source, connection }) => legacySource(source, connection)), total: sources.length });
  });

  app.post(`${BASE}/sources`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId) ?? requireHumanAdmin(c, deps, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<LegacySourceBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const requested = String(body.endpointName ?? body.endpoint_name ?? "").trim();
    const connection = resolveEndpoint(deps, workspaceId, requested);
    if (!connection) return c.json({ error: "Feishu endpoint_name is not configured by the server" }, 400);
    try {
      if (workspaceId === "local") store.ensureLocalWorkspace();
      const source = repo.upsertSource({
        id: createId("msrc"),
        workspaceId,
        connectionId: connection.id,
        name: requireText(body.name, "name"),
        allowlist: normalizeAllowlist(legacyAllowlistInput(body.allowlist)),
        enabled: body.enabled,
        retentionDays: body.retentionDays ?? body.retention_days,
        pollIntervalSeconds: body.pollIntervalSeconds ?? body.poll_interval_seconds,
        unprocessedRetrySeconds: body.unprocessedRetrySeconds ?? body.unprocessed_retry_seconds,
        unprocessedRetryLimit: body.unprocessedRetryLimit ?? body.unprocessed_retry_limit,
      });
      // `accessToken` is accepted and dropped. Credentials now belong to the
      // Provider's own login, not to a row an API caller can write.
      publishWorkspaceEvent(c, store, "feishu:source_created", workspaceId, {
        source: legacySource(source, connection),
      });
      return c.json({ source: legacySource(source, connection) }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/sources/:sourceId`, (c) => {
    const loaded = loadSource(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ source: legacySource(loaded.source, loaded.connection) });
  });

  app.get(`${BASE}/sources/:sourceId/status`, (c) => {
    const loaded = loadSource(c, deps);
    if (loaded instanceof Response) return loaded;
    const status = repo.getSourceStatus(loaded.source.id);
    if (!status) return c.json({ error: "Feishu source not found" }, 404);
    return c.json({ status: legacyStatus(status) });
  });

  app.patch(`${BASE}/sources/:sourceId`, async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<LegacySourceBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const requested = body.endpointName ?? body.endpoint_name;
    if (requested !== undefined && String(requested).trim() !== endpointName(loaded.connection)) {
      // Legacy could move a Source between endpoints by rewriting a column,
      // because a message id was unique on its own. It no longer is: messages
      // are keyed by (connection, message), so moving the Source would strand
      // everything already ingested under the old Connection.
      return c.json({
        error: "Feishu endpoint_name cannot be changed on an existing source; create a new source instead",
      }, 400);
    }
    try {
      const source = repo.upsertSource({
        id: loaded.source.id,
        workspaceId: loaded.source.workspaceId,
        connectionId: loaded.source.connectionId,
        name: body.name === undefined ? loaded.source.name : requireText(body.name, "name"),
        allowlist: body.allowlist === undefined
          ? loaded.source.allowlist
          : normalizeAllowlist(legacyAllowlistInput(body.allowlist)),
        enabled: body.enabled,
        retentionDays: body.retentionDays ?? body.retention_days,
        pollIntervalSeconds: body.pollIntervalSeconds ?? body.poll_interval_seconds,
        unprocessedRetrySeconds: body.unprocessedRetrySeconds ?? body.unprocessed_retry_seconds,
        unprocessedRetryLimit: body.unprocessedRetryLimit ?? body.unprocessed_retry_limit,
      });
      publishWorkspaceEvent(c, store, "feishu:source_updated", source.workspaceId, {
        source: legacySource(source, loaded.connection),
      });
      return c.json({ source: legacySource(source, loaded.connection) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete(`${BASE}/sources/:sourceId`, (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    if (!repo.deleteSource(loaded.source.id)) return c.json({ error: "Feishu source not found" }, 404);
    publishWorkspaceEvent(c, store, "feishu:source_deleted", loaded.source.workspaceId, {
      sourceId: loaded.source.id,
      endpointName: endpointName(loaded.connection),
      name: loaded.source.name,
    });
    return c.json({ deleted: true });
  });

  app.get(`${BASE}/sources/:sourceId/available-chats`, async (c) => {
    const loaded = loadSource(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const provider = deps.messagingProviders.get(loaded.connection.provider);
    if (!provider || !supportsConversations(provider)) {
      return c.json({ error: "Feishu chat lookup failed", code: "capability_unsupported" }, 400);
    }
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 20;
      const result = await provider.searchConversations({ connection: loaded.connection }, {
        query: c.req.query("q")?.trim() || undefined,
        limit,
        cursor: null,
      });
      const allowed = new Set(loaded.source.allowlist.map((entry) => entry.externalConversationId));
      return c.json({
        chats: result.conversations.map((conversation) => legacyAvailableChat(conversation, allowed)),
        total: result.conversations.length,
        limit,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${BASE}/messages`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 100;
      const offset = parseOffset(c.req.query("offset"));
      const page = repo.listMessages({
        workspaceId,
        sourceId: cleanQuery(c.req.query("source") ?? c.req.query("source_id")),
        externalConversationId: cleanQuery(c.req.query("chat") ?? c.req.query("chat_id")),
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
      const byMessage = groupOutcomes(repo.listOutcomesForMessages(page.messages));
      const messages = page.messages.map((message) => legacyMessage(
        message,
        byMessage.get(messageKey(message.connectionId, message.externalMessageId)) ?? [],
      ));
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

  app.get(`${BASE}/chats`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const chats = repo.listConversations(workspaceId).map(legacyChat);
    return c.json({ chats, total: chats.length });
  });

  app.get(`${BASE}/proposals`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const limit = parseLimit(c.req.query("limit")) ?? 100;
      const offset = parseOffset(c.req.query("offset"));
      const page = repo.listProposals({
        workspaceId,
        status: parseLegacyProposalStatus(c.req.query("status")),
        sourceId: cleanQuery(c.req.query("source") ?? c.req.query("source_id")),
        limit,
        offset,
      });
      const proposals = page.proposals.map((proposal) => legacyProposal(
        proposal,
        repo.getMessage(proposal.connectionId, proposal.externalMessageId),
      ));
      return c.json({
        proposals,
        total: page.total,
        limit,
        offset,
        hasMore: offset + proposals.length < page.total,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/messages/:messageId/resolve`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const ref = resolveMessageRef(c, deps);
    if (ref instanceof Response) return ref;
    const body = await readJsonStrict<LegacyResolveBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const token = currentAccessToken(c);
    try {
      const result = store.messagingOutcomes.record(ref, {
        workspaceId,
        outcome: body.outcome,
        reason: body.reason,
        taskId: token?.type === "task" ? token.taskId : body.taskId ?? body.task_id ?? null,
      });
      return c.json(legacyOutcomeResponse(deps, ref, { message: result.message, outcome: result.outcome }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/messages/:messageId/notify`, async (c) => {
    const body = await readJsonStrict<{ summary?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return inboxOutcomeResponse(c, deps, "notified", body.summary ?? "");
  });

  app.post(`${BASE}/messages/:messageId/draft-reply`, async (c) => {
    const body = await readJsonStrict<{ draftText?: string; draft_text?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return inboxOutcomeResponse(c, deps, "reply_drafted", body.draftText ?? body.draft_text ?? "");
  });

  app.post(`${BASE}/messages/:messageId/propose-issue`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const ref = resolveMessageRef(c, deps);
    if (ref instanceof Response) return ref;
    const body = await readJsonStrict<LegacyIssueBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const token = currentAccessToken(c);
    const taskToken = token?.type === "task" ? token : null;
    try {
      const result = store.messagingOutcomes.proposeIssue(ref, {
        ...issueDraft(body),
        workspaceId,
        recipientId: taskToken?.userId ?? currentRequestUserId(c),
        taskId: taskToken?.taskId ?? null,
        actorType: taskToken ? "agent" : "member",
        actorId: taskToken?.agentId ?? currentRequestUserId(c),
      });
      if (result.inboxItem) {
        publishWorkspaceEvent(c, store, "inbox:new", workspaceId, { item: result.inboxItem });
      }
      return c.json(
        {
          ...legacyOutcomeResponse(deps, ref, result),
          proposal: result.proposal ? legacyProposal(result.proposal, result.message) : null,
          inboxItem: result.inboxItem,
          delivered: result.delivered,
          created: result.created,
        },
        result.delivered && result.created ? 201 : 200,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/messages/:messageId/create-issue`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanApprover(c, deps, workspaceId);
    if (denied) return denied;
    const ref = resolveMessageRef(c, deps);
    if (ref instanceof Response) return ref;
    const body = await readJsonStrict<LegacyIssueBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const result = store.messagingOutcomes.createIssue(ref, {
        ...issueDraft(body),
        workspaceId,
        taskId: null,
        createdBy: currentRequestUserId(c),
      });
      if (result.created) publishIssueCreated(c, store, result.issue);
      return c.json(
        { ...legacyOutcomeResponse(deps, ref, result), issue: result.issue, created: result.created },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/proposals/:proposalId/approve`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanApprover(c, deps, workspaceId);
    if (denied) return denied;
    try {
      const result = store.messagingOutcomes.approveProposal(c.req.param("proposalId"), {
        workspaceId,
        approvedBy: currentRequestUserId(c),
      });
      if (result.created && result.issue) publishIssueCreated(c, store, result.issue);
      return c.json(
        {
          ...legacyOutcomeResponse(deps, result.proposal, result),
          proposal: legacyProposal(result.proposal, result.message),
          issue: result.issue,
          created: result.created,
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${BASE}/proposals/:proposalId/reject`, (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanApprover(c, deps, workspaceId);
    if (denied) return denied;
    try {
      const result = store.messagingOutcomes.rejectProposal(c.req.param("proposalId"), {
        workspaceId,
        rejectedBy: currentRequestUserId(c),
      });
      return c.json({
        ...legacyOutcomeResponse(deps, result.proposal, result),
        proposal: legacyProposal(result.proposal, result.message),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}

/** Notify and draft-reply differ only in which text they carry. */
function inboxOutcomeResponse(
  c: Context,
  deps: RouterDeps,
  kind: "notified" | "reply_drafted",
  text: string,
): Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId);
  if (denied) return denied;
  const ref = resolveMessageRef(c, deps);
  if (ref instanceof Response) return ref;
  const token = currentAccessToken(c);
  const taskToken = token?.type === "task" ? token : null;
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
      { ...legacyOutcomeResponse(deps, ref, result), inboxItem: result.inboxItem, delivered: result.delivered },
      result.delivered ? 201 : 200,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

/**
 * Finds the one message a legacy id refers to.
 *
 * The legacy schema keyed messages by channel id alone, which only worked while
 * exactly one account could ingest them. Two Connections on two accounts can now
 * hold the same channel message, and picking one would silently record an
 * outcome against the wrong account's copy — so an ambiguous id is refused and
 * the caller is pointed at the addressable API.
 */
function resolveMessageRef(
  c: Context,
  deps: RouterDeps,
): { connectionId: string; externalMessageId: string } | Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const externalMessageId = c.req.param("messageId") ?? "";
  const matches = deps.store.messaging.findMessagesByExternalId(workspaceId, externalMessageId);
  if (!matches.length) return c.json({ error: "Feishu message not found" }, 404);
  if (matches.length > 1) {
    return c.json({
      error: "Feishu message id matches more than one connection; use the messaging API to address it",
      code: "ambiguous_message_id",
    }, 409);
  }
  return { connectionId: matches[0]!.connectionId, externalMessageId };
}

/** Every legacy action answers with the message's full outcome ledger. */
function legacyOutcomeResponse(
  deps: RouterDeps,
  ref: { connectionId: string; externalMessageId: string },
  result: { message: StoredCanonicalMessage; outcome: MessageOutcome },
): Record<string, unknown> {
  const outcomes = deps.store.messaging.listOutcomes(ref.connectionId, ref.externalMessageId);
  return {
    message: legacyMessage(result.message, outcomes),
    outcome: legacyOutcome(result.outcome),
    outcomes: outcomes.map(legacyOutcome),
  };
}

function loadSource(
  c: Context,
  deps: RouterDeps,
  requireAdmin = false,
): { source: MessageSource; connection: MessageConnection } | Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId)
    ?? (requireAdmin ? requireHumanAdmin(c, deps, workspaceId) : null);
  if (denied) return denied;
  const source = deps.store.messaging.getSource(c.req.param("sourceId") ?? "");
  if (!source || source.workspaceId !== workspaceId) return c.json({ error: "Feishu source not found" }, 404);
  const connection = deps.store.messaging.getConnection(source.connectionId);
  // A Source on another channel is not a Feishu source, however it was reached.
  if (!connection || connection.channel !== CHANNEL) return c.json({ error: "Feishu source not found" }, 404);
  return { source, connection };
}

function feishuConnections(deps: RouterDeps, workspaceId: string): MessageConnection[] {
  return deps.store.messaging.listConnections({ workspaceId }).filter((item) => item.channel === CHANNEL);
}

function feishuSources(
  deps: RouterDeps,
  workspaceId: string,
): Array<{ source: MessageSource; connection: MessageConnection }> {
  const connections = new Map(feishuConnections(deps, workspaceId).map((item) => [item.id, item]));
  return deps.store.messaging.listSources({ workspaceId })
    .flatMap((source) => {
      const connection = connections.get(source.connectionId);
      return connection ? [{ source, connection }] : [];
    });
}

/**
 * Resolves a legacy endpoint name to the Connection a new Source should use.
 *
 * Several Connections can share a name after migration, so the choice is made
 * the same way every time: a working one first, then the oldest. Silently
 * picking differently between two calls would scatter one operator's Sources
 * across accounts.
 */
function resolveEndpoint(deps: RouterDeps, workspaceId: string, name: string): MessageConnection | null {
  if (!name) return null;
  const candidates = feishuConnections(deps, workspaceId).filter((item) => endpointName(item) === name);
  if (!candidates.length) return null;
  return candidates.find((item) => item.status === "ready")
    ?? [...candidates].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]!;
}

/**
 * The name an old client knows this Connection by.
 *
 * The migration records the legacy endpoint name in `config` where there was
 * one; a Connection created since then is known by its own name.
 */
function endpointName(connection: MessageConnection): string {
  const legacy = connection.config.legacy_endpoint_name;
  return typeof legacy === "string" && legacy.trim() ? legacy : connection.name;
}

function legacyEndpoint(
  deps: RouterDeps,
  name: string,
  connections: readonly MessageConnection[],
): Record<string, unknown> {
  // Worst status wins: one broken account under a name means the endpoint an
  // old client sees is not fully healthy.
  const failed = connections.find((item) => item.status !== "ready" && item.status !== "unknown");
  const unknown = connections.find((item) => item.status === "unknown");
  const provider = connections[0] ? deps.messagingProviders.get(connections[0].provider) : null;
  const checkedAt = connections
    .map((item) => item.lastCheckedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  return {
    name,
    // Legacy only knew ready / unreachable / unknown. The precise reason is
    // still reported in errorCode, so nothing is lost by collapsing here.
    status: failed ? "unreachable" : unknown ? "unknown" : "ready",
    checkedAt,
    // Legacy measured a round trip to the sidecar. There is no sidecar to time.
    latencyMs: null,
    // Only known right after a probe, so the list reports null and
    // `POST .../check` fills it in.
    version: null,
    capabilities: provider
      ? Object.entries(provider.manifest.capabilities).filter(([, on]) => on).map(([capability]) => capability)
      : null,
    errorCode: failed?.lastErrorCode ?? null,
    sourceCount: 0,
  };
}

function legacySource(source: MessageSource, connection: MessageConnection): Record<string, unknown> {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    name: source.name,
    // Legacy called this the ingestion transport. It is the channel now: there
    // is no separate automation product behind it any more.
    type: CHANNEL,
    endpointName: endpointName(connection),
    allowlist: source.allowlist.map((entry) => ({
      chatId: entry.externalConversationId,
      addedAt: entry.addedAt,
    })),
    enabled: source.enabled,
    retentionDays: source.retentionDays,
    pollIntervalSeconds: source.pollIntervalSeconds,
    unprocessedRetrySeconds: source.unprocessedRetrySeconds,
    unprocessedRetryLimit: source.unprocessedRetryLimit,
    // A Source never held a credential again: the Provider owns its own login.
    accessTokenSet: false,
    accessTokenHint: null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function legacyStatus(status: MessageSourceStatus): Record<string, unknown> {
  return {
    sourceId: status.sourceId,
    unprocessedCount: status.unprocessedCount,
    timedOutCount: status.timedOutCount,
    mutedDeliveryCount: status.mutedDeliveryCount,
    pendingIssueProposalCount: status.pendingProposalCount,
    oldestUnprocessedAt: status.oldestUnprocessedAt,
    maximumRetryCount: status.maximumRetryCount,
    lastSuccessfulIngestAt: status.lastSuccessfulIngestAt,
    lastErrorCode: status.lastErrorCode,
    lastErrorAt: status.lastErrorAt,
    lagSeconds: status.lagSeconds,
    consecutiveFailures: status.consecutiveFailures,
    connectionAlertedAt: status.alertedAt,
    connectionAlertDeliveryFailureCount: status.alertDeliveryFailureCount,
    connectionAlertDeliveryErrorCode: status.alertDeliveryErrorCode,
    connectionAlertDeliveryFailedAt: status.alertDeliveryFailedAt,
  };
}

function legacyMessage(
  message: StoredCanonicalMessage,
  outcomes: readonly MessageOutcome[],
): Record<string, unknown> {
  return {
    messageId: message.externalMessageId,
    workspaceId: message.workspaceId,
    sourceId: message.sourceId,
    chatId: message.externalConversationId,
    chatType: legacyChatType(message.conversationKind),
    chatName: message.conversationName,
    threadId: message.externalThreadId,
    rootId: message.externalRootId,
    parentId: message.externalParentId,
    // Old clients read a name through `name ?? senderName ?? sender_id`, so the
    // canonical sender is rendered under the keys that chain looks for.
    sender: {
      name: message.sender.displayName,
      sender_id: message.sender.externalSenderId,
      sender_type: message.sender.kind,
    },
    content: message.raw,
    searchableText: message.text,
    contentFingerprint: message.contentFingerprint,
    messageAppLink: message.url,
    createdAt: message.sentAt,
    // Legacy wrote `updated_at` on every write and the UI shows it as the last
    // change. The Core only records the one change that matters, so an unedited
    // message reports when it was sent rather than a blank.
    updatedAt: message.editedAt ?? message.sentAt,
    recalled: message.recalled,
    edited: message.editedAt !== null,
    ingestedAt: message.ingestedAt,
    processedAt: message.processedAt,
    retryCount: message.retryCount,
    lastRetryAt: message.lastRetryAt,
    outcomes: outcomes.map(legacyOutcome),
  };
}

function legacyOutcome(outcome: MessageOutcome): Record<string, unknown> {
  return {
    id: outcome.id,
    workspaceId: outcome.workspaceId,
    messageId: outcome.externalMessageId,
    outcomeKind: outcome.outcomeKind,
    ref: outcome.ref,
    reason: outcome.reason,
    taskId: outcome.taskId,
    createdAt: outcome.createdAt,
  };
}

function legacyChat(conversation: MessageConversationSummary): Record<string, unknown> {
  return {
    sourceId: conversation.sourceId,
    chatId: conversation.externalConversationId,
    chatName: conversation.name,
    chatType: legacyChatType(conversation.kind),
    messageCount: conversation.messageCount,
    lastMessageAt: conversation.lastMessageAt,
    inAllowlist: conversation.inAllowlist,
  };
}

function legacyAvailableChat(
  conversation: MessageConversation,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    chatId: conversation.externalConversationId,
    name: conversation.name,
    type: legacyChatType(conversation.kind),
    memberCount: conversation.memberCount,
    external: conversation.metadata.external === true,
    description: typeof conversation.metadata.description === "string" ? conversation.metadata.description : null,
    inAllowlist: allowed.has(conversation.externalConversationId),
  };
}

function legacyProposal(
  proposal: MessageOutcome,
  message: StoredCanonicalMessage | null,
): Record<string, unknown> {
  const payload = proposal.proposalPayload;
  return {
    id: proposal.id,
    workspaceId: proposal.workspaceId,
    messageId: proposal.externalMessageId,
    // The Core stores the reviewer's inbox item as the outcome's ref.
    inboxItemId: proposal.ref?.startsWith("inbox:") ? proposal.ref.slice("inbox:".length) : null,
    issue: {
      title: readString(payload.title) ?? "",
      description: readString(payload.description),
      priority: readString(payload.priority),
      projectId: readString(payload.projectId),
      assigneeType: readString(payload.assigneeType),
      assigneeId: readString(payload.assigneeId),
    },
    status: proposal.proposalStatus,
    resolvedAt: proposal.proposalResolvedAt,
    resolvedBy: proposal.proposalResolvedBy,
    createdAt: proposal.createdAt,
    message: message
      ? {
        messageId: message.externalMessageId,
        sourceId: message.sourceId,
        chatId: message.externalConversationId,
        chatName: message.conversationName,
        sender: { name: message.sender.displayName, sender_id: message.sender.externalSenderId },
        searchableText: message.text,
        messageAppLink: message.url,
        createdAt: message.sentAt,
      }
      : null,
  };
}

/** The channel's own vocabulary, which the Core normalized away. */
function legacyChatType(kind: MessageConversationKind): string | null {
  if (kind === "direct") return "p2p";
  if (kind === "unknown") return null;
  return kind;
}

function legacyAllowlistInput(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    if (typeof raw === "string") return raw;
    if (!raw || typeof raw !== "object") return raw;
    const entry = raw as Record<string, unknown>;
    const chatId = entry.chatId ?? entry.chat_id;
    return chatId === undefined ? entry : { ...entry, externalConversationId: chatId };
  });
}

function groupOutcomes(outcomes: readonly MessageOutcome[]): Map<string, MessageOutcome[]> {
  const grouped = new Map<string, MessageOutcome[]>();
  for (const outcome of outcomes) {
    const key = messageKey(outcome.connectionId, outcome.externalMessageId);
    grouped.set(key, [...grouped.get(key) ?? [], outcome]);
  }
  return grouped;
}

function messageKey(connectionId: string, externalMessageId: string): string {
  return `${connectionId} ${externalMessageId}`;
}

function parseLegacyProposalStatus(value: string | undefined): "pending" | "approved" | "rejected" | undefined {
  if (value === undefined) return undefined;
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  throw new Error("status must be pending, approved, or rejected");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requireHumanAdmin(c: Context, deps: RouterDeps, workspaceId: string): Response | null {
  if (currentAccessToken(c)?.type === "task") {
    return c.json({ error: "forbidden for task token", code: "human_admin_required" }, 403);
  }
  return requireWorkspaceAdmin(c, deps.store, workspaceId);
}

function requireHumanApprover(c: Context, deps: RouterDeps, workspaceId: string): Response | null {
  if (currentAccessToken(c)?.type === "task") {
    return c.json({ error: "forbidden for task token", code: "human_approval_required" }, 403);
  }
  return requireWorkspaceAdmin(c, deps.store, workspaceId);
}

interface LegacySourceBody {
  endpointName?: string;
  endpoint_name?: string;
  name?: string;
  allowlist?: unknown;
  enabled?: boolean;
  retentionDays?: number;
  retention_days?: number;
  pollIntervalSeconds?: number;
  poll_interval_seconds?: number;
  unprocessedRetrySeconds?: number;
  unprocessed_retry_seconds?: number;
  unprocessedRetryLimit?: number;
  unprocessed_retry_limit?: number;
}

interface LegacyResolveBody {
  outcome: MessageOutcome["outcomeKind"];
  reason?: string | null;
  taskId?: string | null;
  task_id?: string | null;
}

interface LegacyIssueBody {
  title?: string;
  description?: string | null;
  priority?: string | null;
  projectId?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
}
