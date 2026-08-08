// Wire serializers for the webhooks domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type { MultiremiWebhookDeliveryResult } from "@multiremi/contracts/types.js";
import { isObjectRecord } from "./context.js";

export function publicWebhookDeliveryResponse(result: MultiremiWebhookDeliveryResult): {
  statusCode: 200 | 401 | 500;
  body: Record<string, unknown>;
} {
  const deliveryId = result.delivery.id;
  const runId = result.run?.id ?? result.delivery.autopilotRunId ?? null;
  if (result.duplicate) {
    const body: Record<string, unknown> = { status: "duplicate", delivery_id: deliveryId };
    if (runId) body.run_id = runId;
    return { statusCode: 200, body };
  }
  if (result.status === "rejected") {
    return {
      statusCode: 401,
      body: {
        status: "rejected",
        delivery_id: deliveryId,
        reason: result.delivery.error ?? "invalid_signature",
      },
    };
  }
  if (result.status === "ignored") {
    const responseBody = parseWebhookResponseBody(result.delivery.responseBody);
    const body: Record<string, unknown> = {
      status: "ignored",
      delivery_id: deliveryId,
      reason: result.delivery.error ?? responseBody.reason ?? "ignored",
    };
    if (responseBody.event) body.event = responseBody.event;
    return { statusCode: 200, body };
  }
  if (result.status === "skipped") {
    const body: Record<string, unknown> = {
      status: "skipped",
      delivery_id: deliveryId,
    };
    if (runId) body.run_id = runId;
    const reason = result.run?.failureReason ?? result.delivery.error;
    if (reason) body.reason = reason;
    return { statusCode: 200, body };
  }
  if (result.status === "failed") {
    return { statusCode: 500, body: { error: "failed to dispatch autopilot" } };
  }
  return {
    statusCode: 200,
    body: {
      status: "accepted",
      delivery_id: deliveryId,
      run_id: runId,
      autopilot_id: result.delivery.autopilotId,
      trigger_id: result.delivery.triggerId,
    },
  };
}

function parseWebhookResponseBody(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function webhookDeliveryResponse(result: MultiremiWebhookDeliveryResult) {
  return {
    status: result.status,
    duplicate: result.duplicate,
    delivery: result.delivery,
    deliveryId: result.delivery.id,
    delivery_id: result.delivery.id,
    run: result.run,
    runId: result.run?.id ?? null,
    run_id: result.run?.id ?? null,
  };
}
