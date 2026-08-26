import type { Context, Hono } from "hono";
import {
  boundedQueryInt,
  denyCurrentUserWorkspaceAccess,
  denyRestrictedTaskIssueCreation,
  headersToRecord,
  isJsonApiError,
  parseJsonBody,
  publishWorkspaceEvent,
  queryInt,
  readJson,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  webhookSignatureStatus,
} from "../helpers.js";
import {
  autopilotCompatibilityErrorResponse,
  autopilotCompatibilityResponse,
  autopilotCreateCompatibilityInput,
  autopilotCreateInput,
  autopilotRunCompatibilityResponse,
  autopilotTriggerCompatibilityResponse,
  autopilotTriggerCreateCompatibilityInput,
  autopilotTriggerResponse,
  autopilotTriggerUpdateCompatibilityInput,
  autopilotUpdateCompatibilityInput,
  cleanString,
  currentTaskAccessToken,
  validateAutopilotTriggerCompatibilityInput,
  validateAutopilotTriggerUpdateCompatibilityInput,
  webhookDeliveryResponse,
} from "../wire/index.js";
import type {
  AutopilotCompatibilityUpdateInput,
} from "../wire/index.js";
import type {
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  MultiremiAutopilot,
  RunAutopilotInput,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import { listWorkspaceRepositories } from "../helpers/repositories.js";
import { ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE } from "../../repository-wiki/atlas.js";

function loadAutopilotForCurrentUser(
  c: Context,
  store: RouterDeps["store"],
  autopilotId: string,
): { autopilot: MultiremiAutopilot } | Response {
  const autopilot = store.getAutopilot(autopilotId);
  if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, autopilot.workspaceId);
  return denied ?? { autopilot };
}

/** Keep server-only run fields out of every public run/trigger route. */
function publicRunAutopilotInput(input: RunAutopilotInput): RunAutopilotInput {
  return {
    source: input.source,
    prompt: input.prompt,
    payload: input.payload,
    triggerIssueId: input.triggerIssueId,
    trigger_issue_id: input.trigger_issue_id,
    triggerId: input.triggerId,
    trigger_id: input.trigger_id,
    eventId: input.eventId,
    event_id: input.event_id,
  };
}

function taskTokenSecretCreationDenied(c: Context, triggerKind: string | null | undefined): Response | null {
  if (currentTaskAccessToken(c) && cleanString(triggerKind)?.toLowerCase() === "webhook") {
    return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
  }
  return null;
}

function reservedAtlasAutopilotTitle(c: Context, title: unknown): Response | null {
  if (cleanString(typeof title === "string" ? title : null) !== ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE) return null;
  return c.json({
    error: `${ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE} is reserved for the platform Repository Wiki automation`,
    code: "atlas_identity_reserved",
  }, 409);
}

function denyRestrictedTaskCreateIssueAutopilot(
  c: Context,
  store: RouterDeps["store"],
  executionMode: unknown,
): Response | null {
  return executionMode === "create_issue" ? denyRestrictedTaskIssueCreation(c, store) : null;
}

export function registerAutopilotRoutes(app: Hono, deps: RouterDeps): void {
  const { store, scheduler } = deps;

  app.get("/api/multiremi/autopilots", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const autopilots = store.listAutopilots(workspaceId);
    return c.json({ autopilots, total: autopilots.length });
  });
  app.get("/api/autopilots", (c) => {
    const workspaceId = c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const status = cleanString(c.req.query("status"));
    let autopilots = store.listAutopilots(workspaceId);
    if (status) autopilots = autopilots.filter((autopilot) => autopilot.status === status);
    const response = autopilots.map(autopilotCompatibilityResponse);
    return c.json({ autopilots: response, total: response.length });
  });
  app.post("/api/autopilots", async (c) => {
    const body = await readJsonStrict<CreateAutopilotInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const secretDenied = taskTokenSecretCreationDenied(c, body.triggerKind ?? body.trigger_kind);
    if (secretDenied) return secretDenied;
    const input = autopilotCreateCompatibilityInput(c, body);
    if (isJsonApiError(input)) return c.json({ error: input.apiError }, input.statusCode);
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, input.executionMode ?? input.execution_mode);
    if (issueDenied) return issueDenied;
    const reserved = reservedAtlasAutopilotTitle(c, input.title);
    if (reserved) return reserved;
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? "local");
    if (denied) return denied;
    try {
      const autopilot = store.createAutopilot(input);
      scheduler?.sync();
      const response = autopilotCompatibilityResponse(autopilot);
      publishWorkspaceEvent(c, store, "autopilot:created", autopilot.workspaceId, { autopilot: response });
      return c.json(response, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/multiremi/autopilots", async (c) => {
    const body = await readJson<CreateAutopilotInput>(c);
    const secretDenied = taskTokenSecretCreationDenied(c, body.triggerKind ?? body.trigger_kind);
    if (secretDenied) return secretDenied;
    const input = autopilotCreateInput(c, body);
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(
      c,
      store,
      input.executionMode ?? input.execution_mode ?? "create_issue",
    );
    if (issueDenied) return issueDenied;
    const reserved = reservedAtlasAutopilotTitle(c, input.title);
    if (reserved) return reserved;
    const denied = denyCurrentUserWorkspaceAccess(c, store, input.workspaceId ?? "local");
    if (denied) return denied;
    try {
      const autopilot = store.createAutopilot(input);
      scheduler?.sync();
      return c.json({ autopilot }, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/multiremi/autopilots/:id", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { autopilot } = loaded;
    return c.json({
      autopilot,
      triggers: store.listAutopilotTriggers(autopilot.id).map((trigger) =>
        autopilotTriggerResponse(trigger, { redactSecrets: Boolean(currentTaskAccessToken(c)) })
      ),
      runs: store.listAutopilotRuns(autopilot.id),
      deliveries: store.listWebhookDeliveries(autopilot.id),
    });
  });
  app.patch("/api/multiremi/autopilots/:id", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateAutopilotInput>(c);
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(
      c,
      store,
      body.executionMode ?? loaded.autopilot.executionMode,
    );
    if (issueDenied) return issueDenied;
    const reserved = reservedAtlasAutopilotTitle(c, body.title);
    if (reserved) return reserved;
    try {
      const autopilot = store.updateAutopilot(c.req.param("id"), body);
      scheduler?.sync();
      return c.json({ autopilot });
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/multiremi/autopilots/:id", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const autopilot = store.archiveAutopilot(c.req.param("id"));
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.get("/api/multiremi/autopilots/:id/runs", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ runs: store.listAutopilotRuns(c.req.param("id")) });
  });
  app.get("/api/multiremi/autopilots/:id/deliveries", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const deliveries = store.listWebhookDeliveries(c.req.param("id"));
    return c.json({ deliveries, total: deliveries.length });
  });
  app.get("/api/multiremi/autopilots/:id/deliveries/:deliveryId", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const delivery = store.getWebhookDelivery(c.req.param("deliveryId"));
    if (!delivery || delivery.autopilotId !== c.req.param("id")) return c.json({ error: "delivery not found" }, 404);
    return c.json({ delivery });
  });
  app.post("/api/multiremi/autopilots/:id/deliveries/:deliveryId/replay", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const result = store.replayWebhookDelivery(c.req.param("id"), c.req.param("deliveryId"));
    return c.json({ ...webhookDeliveryResponse(result) }, 201);
  });
  app.post("/api/multiremi/autopilots/:id/run", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const body = await readJson<RunAutopilotInput>(c);
    try {
      return c.json({ run: store.runAutopilot(c.req.param("id"), publicRunAutopilotInput(body)) }, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/multiremi/autopilots/:id/run-scheduled", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const run = scheduler?.trigger(c.req.param("id")) ?? store.runAutopilot(c.req.param("id"), { source: "schedule" });
    return c.json({ run }, 201);
  });
  app.get("/api/multiremi/scheduler", (c) => {
    return c.json({
      enabled: Boolean(scheduler),
      scheduledIds: scheduler?.scheduledIds() ?? [],
      total: scheduler?.scheduledCount() ?? 0,
    });
  });
  app.post("/api/multiremi/autopilots/:id/trigger", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const body = await readJson<RunAutopilotInput>(c);
    try {
      const input = publicRunAutopilotInput(body);
      return c.json({
        run: store.runAutopilot(c.req.param("id"), { ...input, source: input.source ?? "api" }),
      }, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/multiremi/autopilots/:id/webhook", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const rawBody = await c.req.raw.text();
    let body: RunAutopilotInput & { payload?: unknown };
    try {
      body = parseJsonBody<RunAutopilotInput & { payload?: unknown }>(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const headers = headersToRecord(c.req.raw.headers);
    const provider = headers["x-github-event"] ? "github" : "generic";
    const signatureStatus = webhookSignatureStatus(provider, headers, rawBody);
    const result = store.handleAutopilotWebhook(c.req.param("id"), {
      prompt: body.prompt ?? null,
      payload: body.payload ?? body,
      rawBody,
      headers,
      provider,
      signatureStatus,
    });
    const statusCode = result.status === "rejected" ? 401 : result.status === "accepted" ? 201 : result.status === "failed" ? 500 : 200;
    return c.json(webhookDeliveryResponse(result), statusCode);
  });
  app.get("/api/autopilots/:id", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { autopilot } = loaded;
    return c.json({
      autopilot: autopilotCompatibilityResponse(autopilot),
      triggers: store.listAutopilotTriggers(autopilot.id).map((trigger) =>
        autopilotTriggerCompatibilityResponse(trigger, { redactSecrets: Boolean(currentTaskAccessToken(c)) })
      ),
    });
  });
  app.patch("/api/autopilots/:id", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAutopilotInput & AutopilotCompatibilityUpdateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = autopilotUpdateCompatibilityInput(body);
    if (isJsonApiError(input)) return c.json({ error: input.apiError }, input.statusCode);
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(
      c,
      store,
      input.executionMode ?? loaded.autopilot.executionMode,
    );
    if (issueDenied) return issueDenied;
    const reserved = reservedAtlasAutopilotTitle(c, input.title);
    if (reserved) return reserved;
    try {
      const autopilot = store.updateAutopilot(c.req.param("id"), input);
      scheduler?.sync();
      const response = autopilotCompatibilityResponse(autopilot);
      publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot: response });
      return c.json(response);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/autopilots/:id", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const autopilot = store.archiveAutopilot(c.req.param("id"));
      scheduler?.sync();
      publishWorkspaceEvent(c, store, "autopilot:deleted", autopilot.workspaceId, { autopilot_id: autopilot.id });
      return c.body(null, 204);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/autopilots/:id/trigger", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const body = await readJsonStrictAllowEmpty<RunAutopilotInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const { autopilot } = loaded;
    if (autopilot.status !== "active") return c.json({ error: "autopilot is not active" }, 400);
    try {
      const input = publicRunAutopilotInput(body);
      return c.json(autopilotRunCompatibilityResponse(store.runAutopilot(autopilot.id, { ...input, source: input.source ?? "manual" })));
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/autopilots/:id/runs", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { autopilot } = loaded;
    const limit = boundedQueryInt(c.req.query("limit"), 20, 100);
    const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
    const repositoryNames = new Map(
      listWorkspaceRepositories(store, autopilot.workspaceId)
        .map((repository) => [repository.id, repository.name] as const),
    );
    const runs = store.listAutopilotRuns(autopilot.id).slice(offset, offset + limit).map((run) => autopilotRunCompatibilityResponse(run, {
      slim: true,
      resolveRepositoryName: (repositoryId) => repositoryNames.get(repositoryId) ?? null,
    }));
    return c.json({ runs, total: runs.length });
  });
  app.get("/api/autopilots/:id/runs/:runId", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { autopilot } = loaded;
    const run = store.getAutopilotRun(c.req.param("runId"));
    if (!run || run.autopilotId !== autopilot.id) return c.json({ error: "run not found" }, 404);
    return c.json(autopilotRunCompatibilityResponse(run));
  });
  app.get("/api/autopilots/:id/deliveries", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.listWebhookDeliveries(c.req.param("id")));
  });
  app.get("/api/autopilots/:id/deliveries/:deliveryId", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const delivery = store.getWebhookDelivery(c.req.param("deliveryId"));
    if (!delivery || delivery.autopilotId !== c.req.param("id")) return c.json({ error: "delivery not found" }, 404);
    return c.json(delivery);
  });
  app.post("/api/autopilots/:id/deliveries/:deliveryId/replay", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const result = store.replayWebhookDelivery(c.req.param("id"), c.req.param("deliveryId"));
    return c.json(webhookDeliveryResponse(result), 201);
  });
  app.post("/api/autopilots/:id/triggers", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const body = await readJsonStrict<CreateAutopilotTriggerInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const secretDenied = taskTokenSecretCreationDenied(c, body.kind);
    if (secretDenied) return secretDenied;
    const invalid = validateAutopilotTriggerCompatibilityInput(body);
    if (invalid) return c.json({ error: invalid }, 400);
    try {
      const trigger = store.createAutopilotTrigger(c.req.param("id"), autopilotTriggerCreateCompatibilityInput(body));
      scheduler?.sync();
      const response = autopilotTriggerCompatibilityResponse(trigger, { redactSecrets: Boolean(currentTaskAccessToken(c)) });
      const autopilot = store.getAutopilot(trigger.autopilotId);
      if (autopilot) publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot_id: autopilot.id, trigger: response });
      return c.json(response, 201);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.patch("/api/autopilots/:id/triggers/:triggerId", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const body = await readJsonStrict<UpdateAutopilotTriggerInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const current = store.getAutopilotTrigger(c.req.param("triggerId"));
    if (!current || current.autopilotId !== c.req.param("id")) return c.json({ error: "trigger not found" }, 404);
    const invalid = validateAutopilotTriggerUpdateCompatibilityInput(current, body);
    if (invalid) return c.json({ error: invalid }, 400);
    const input = autopilotTriggerUpdateCompatibilityInput(body);
    try {
      const trigger = store.updateAutopilotTrigger(c.req.param("id"), c.req.param("triggerId"), input);
      scheduler?.sync();
      const response = autopilotTriggerCompatibilityResponse(trigger, { redactSecrets: Boolean(currentTaskAccessToken(c)) });
      const autopilot = store.getAutopilot(trigger.autopilotId);
      if (autopilot) publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot_id: autopilot.id, trigger: response });
      return c.json(response);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/autopilots/:id/triggers/:triggerId", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const deleted = store.deleteAutopilotTrigger(c.req.param("id"), c.req.param("triggerId"));
    if (!deleted) return c.json({ error: "trigger not found" }, 404);
    scheduler?.sync();
    return c.body(null, 204);
  });
  app.post("/api/autopilots/:id/triggers/:triggerId/rotate-webhook-token", (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const current = store.getAutopilotTrigger(c.req.param("triggerId"));
    if (!current || current.autopilotId !== c.req.param("id")) return c.json({ error: "trigger not found" }, 404);
    if (current.kind !== "webhook") return c.json({ error: "trigger is not a webhook trigger" }, 400);
    try {
      return c.json(autopilotTriggerCompatibilityResponse(store.rotateAutopilotTriggerWebhookToken(c.req.param("id"), c.req.param("triggerId"))));
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });
  app.put("/api/autopilots/:id/triggers/:triggerId/signing-secret", async (c) => {
    const loaded = loadAutopilotForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const issueDenied = denyRestrictedTaskCreateIssueAutopilot(c, store, loaded.autopilot.executionMode);
    if (issueDenied) return issueDenied;
    const body = await readJsonStrict<{ signing_secret?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const current = store.getAutopilotTrigger(c.req.param("triggerId"));
    if (!current || current.autopilotId !== c.req.param("id")) return c.json({ error: "trigger not found" }, 404);
    if (current.kind !== "webhook") return c.json({ error: "trigger is not a webhook trigger" }, 400);
    const signingSecret = String(body.signing_secret ?? "").trim();
    if (signingSecret && signingSecret.length < 16) return c.json({ error: "signing_secret must be at least 16 characters" }, 400);
    try {
      const trigger = store.setAutopilotTriggerSigningSecret(
        c.req.param("id"),
        c.req.param("triggerId"),
        signingSecret,
      );
      const response = autopilotTriggerCompatibilityResponse(trigger, { redactSecrets: Boolean(currentTaskAccessToken(c)) });
      const autopilot = store.getAutopilot(trigger.autopilotId);
      if (autopilot) publishWorkspaceEvent(c, store, "autopilot:updated", autopilot.workspaceId, { autopilot_id: autopilot.id, trigger: response });
      return c.json(response);
    } catch (error) {
      return autopilotCompatibilityErrorResponse(c, error);
    }
  });

}
