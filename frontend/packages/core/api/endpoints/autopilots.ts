import type {
  Autopilot,
  AutopilotRun,
  AutopilotTrigger,
  CreateAutopilotRequest,
  CreateAutopilotTriggerRequest,
  GetAutopilotResponse,
  ListAutopilotRunsResponse,
  ListAutopilotsResponse,
  ListWebhookDeliveriesResponse,
  UpdateAutopilotRequest,
  UpdateAutopilotTriggerRequest,
  WebhookDelivery,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  AutopilotRunSchema,
  AutopilotSchema,
  AutopilotTriggerSchema,
  EMPTY_AUTOPILOT,
  EMPTY_AUTOPILOT_RUN,
  EMPTY_AUTOPILOT_TRIGGER,
  EMPTY_GET_AUTOPILOT_RESPONSE,
  EMPTY_LIST_AUTOPILOT_RUNS_RESPONSE,
  EMPTY_LIST_AUTOPILOTS_RESPONSE,
  EMPTY_LIST_WEBHOOK_DELIVERIES_RESPONSE,
  EMPTY_WEBHOOK_DELIVERY,
  GetAutopilotResponseSchema,
  ListAutopilotRunsResponseSchema,
  ListAutopilotsResponseSchema,
  ListWebhookDeliveriesResponseSchema,
  WebhookDeliveryResponseSchema,
} from "../schemas/autopilots";

export class AutopilotsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Autopilots
  async listAutopilots(params?: { status?: string }): Promise<ListAutopilotsResponse> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    const raw = await this.http.fetch<unknown>(`/api/autopilots?${search}`);
    return parseWithFallback(raw, ListAutopilotsResponseSchema, EMPTY_LIST_AUTOPILOTS_RESPONSE, {
      endpoint: "GET /api/autopilots",
    });
  }

  async getAutopilot(id: string): Promise<GetAutopilotResponse> {
    const raw = await this.http.fetch<unknown>(`/api/autopilots/${id}`);
    return parseWithFallback(
      raw,
      GetAutopilotResponseSchema,
      { ...EMPTY_GET_AUTOPILOT_RESPONSE, autopilot: { ...EMPTY_AUTOPILOT, id } },
      { endpoint: "GET /api/autopilots/:id" },
    );
  }

  async createAutopilot(data: CreateAutopilotRequest): Promise<Autopilot> {
    const raw = await this.http.fetch<unknown>("/api/autopilots", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseWithFallback(
      raw,
      AutopilotSchema,
      {
        ...EMPTY_AUTOPILOT,
        title: data.title,
        description: data.description ?? null,
        project_id: data.project_id ?? null,
        assignee_type: data.assignee_type ?? "agent",
        assignee_id: data.assignee_id,
        execution_mode: data.execution_mode,
        session_policy: data.session_policy ?? "new",
        workspace_policy: data.workspace_policy ?? "reuse_issue",
        issue_title_template: data.issue_title_template ?? null,
      },
      { endpoint: "POST /api/autopilots" },
    );
  }

  async updateAutopilot(id: string, data: UpdateAutopilotRequest): Promise<Autopilot> {
    const raw = await this.http.fetch<unknown>(`/api/autopilots/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, AutopilotSchema, { ...EMPTY_AUTOPILOT, id }, {
      endpoint: "PATCH /api/autopilots/:id",
    });
  }

  async deleteAutopilot(id: string): Promise<void> {
    await this.http.fetch(`/api/autopilots/${id}`, { method: "DELETE" });
  }

  async triggerAutopilot(id: string): Promise<AutopilotRun> {
    const raw = await this.http.fetch<unknown>(`/api/autopilots/${id}/trigger`, {
      method: "POST",
    });
    return parseWithFallback(
      raw,
      AutopilotRunSchema,
      { ...EMPTY_AUTOPILOT_RUN, autopilot_id: id },
      { endpoint: "POST /api/autopilots/:id/trigger" },
    );
  }

  async listAutopilotRuns(id: string, params?: { limit?: number; offset?: number }): Promise<ListAutopilotRunsResponse> {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", params.limit.toString());
    if (params?.offset) search.set("offset", params.offset.toString());
    const raw = await this.http.fetch<unknown>(`/api/autopilots/${id}/runs?${search}`);
    return parseWithFallback(
      raw,
      ListAutopilotRunsResponseSchema,
      EMPTY_LIST_AUTOPILOT_RUNS_RESPONSE,
      { endpoint: "GET /api/autopilots/:id/runs" },
    );
  }

  // Returns a single run including its full trigger_payload. List responses
  // omit trigger_payload to keep them small (a webhook envelope can be
  // up to 256 KiB × limit rows), so the detail view fetches via this route.
  async getAutopilotRun(autopilotId: string, runId: string): Promise<AutopilotRun> {
    const raw = await this.http.fetch<unknown>(
      `/api/autopilots/${autopilotId}/runs/${runId}`,
    );
    return parseWithFallback(
      raw,
      AutopilotRunSchema,
      { ...EMPTY_AUTOPILOT_RUN, id: runId, autopilot_id: autopilotId },
      { endpoint: "GET /api/autopilots/:id/runs/:runId" },
    );
  }

  async createAutopilotTrigger(autopilotId: string, data: CreateAutopilotTriggerRequest): Promise<AutopilotTrigger> {
    const raw = await this.http.fetch<unknown>(`/api/autopilots/${autopilotId}/triggers`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseWithFallback(
      raw,
      AutopilotTriggerSchema,
      {
        ...EMPTY_AUTOPILOT_TRIGGER,
        autopilot_id: autopilotId,
        kind: data.kind,
        event_config: data.event_config ?? null,
      },
      { endpoint: "POST /api/autopilots/:id/triggers" },
    );
  }

  async updateAutopilotTrigger(autopilotId: string, triggerId: string, data: UpdateAutopilotTriggerRequest): Promise<AutopilotTrigger> {
    const raw = await this.http.fetch<unknown>(
      `/api/autopilots/${autopilotId}/triggers/${triggerId}`,
      {
      method: "PATCH",
      body: JSON.stringify(data),
      },
    );
    return parseWithFallback(
      raw,
      AutopilotTriggerSchema,
      {
        ...EMPTY_AUTOPILOT_TRIGGER,
        id: triggerId,
        autopilot_id: autopilotId,
        event_config: data.event_config ?? null,
      },
      { endpoint: "PATCH /api/autopilots/:id/triggers/:triggerId" },
    );
  }

  async deleteAutopilotTrigger(autopilotId: string, triggerId: string): Promise<void> {
    await this.http.fetch(`/api/autopilots/${autopilotId}/triggers/${triggerId}`, { method: "DELETE" });
  }

  async rotateAutopilotTriggerWebhookToken(
    autopilotId: string,
    triggerId: string,
  ): Promise<AutopilotTrigger> {
    const raw = await this.http.fetch<unknown>(
      `/api/autopilots/${autopilotId}/triggers/${triggerId}/rotate-webhook-token`,
      { method: "POST" },
    );
    return parseWithFallback(
      raw,
      AutopilotTriggerSchema,
      { ...EMPTY_AUTOPILOT_TRIGGER, id: triggerId, autopilot_id: autopilotId },
      { endpoint: "POST /api/autopilots/:id/triggers/:triggerId/rotate-webhook-token" },
    );
  }

  // Webhook deliveries — list is slim (no raw_body / selected_headers /
  // response_body); detail returns the full row. Both responses are parsed
  // through a lenient schema so an unknown server-side `status` /
  // `signature_status` value degrades to a generic row instead of dropping
  // the whole list.
  async listAutopilotDeliveries(
    autopilotId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<ListWebhookDeliveriesResponse> {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", params.limit.toString());
    if (params?.offset) search.set("offset", params.offset.toString());
    const raw = await this.http.fetch<unknown>(
      `/api/autopilots/${autopilotId}/deliveries?${search}`,
    );
    return parseWithFallback(
      raw,
      ListWebhookDeliveriesResponseSchema,
      EMPTY_LIST_WEBHOOK_DELIVERIES_RESPONSE,
      { endpoint: "GET /api/autopilots/:id/deliveries" },
    );
  }

  async getAutopilotDelivery(
    autopilotId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    const raw = await this.http.fetch<unknown>(
      `/api/autopilots/${autopilotId}/deliveries/${deliveryId}`,
    );
    return parseWithFallback(
      raw,
      WebhookDeliveryResponseSchema,
      { ...EMPTY_WEBHOOK_DELIVERY, id: deliveryId, autopilot_id: autopilotId },
      { endpoint: "GET /api/autopilots/:id/deliveries/:deliveryId" },
    );
  }

  // Replay creates a NEW delivery row referencing the original via
  // `replayed_from_delivery_id`. Server rejects replays of
  // signature-invalid / rejected deliveries with 400 — the UI keeps the
  // button disabled for those rows, but the server is the source of truth.
  async replayAutopilotDelivery(
    autopilotId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    const raw = await this.http.fetch<unknown>(
      `/api/autopilots/${autopilotId}/deliveries/${deliveryId}/replay`,
      { method: "POST" },
    );
    return parseWithFallback(
      raw,
      WebhookDeliveryResponseSchema,
      { ...EMPTY_WEBHOOK_DELIVERY, autopilot_id: autopilotId },
      { endpoint: "POST /api/autopilots/:id/deliveries/:deliveryId/replay" },
    );
  }
}
