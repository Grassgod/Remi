/**
 * Webhook-delivery queries — port of the Go list query
 * `ListWebhookDeliveriesByAutopilot` (server/pkg/db/queries/webhook_delivery.sql)
 * backing the "Deliveries" UI behind autopilot webhooks.
 *
 * Slim projection: the large columns (`raw_body`, `selected_headers`,
 * `response_body`) are deliberately excluded so a page of N deliveries never
 * pulls ~N × 256 KiB of raw bodies out of Postgres just to drop them in the
 * JSON encoder. Detail views fetch the full row separately. Newest first,
 * paged by limit/offset, workspace-scoped (multi-tenancy).
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { webhookDelivery } from "../schema.js";

/** The slim list-row shape (no raw_body / selected_headers / response_body). */
export type WebhookDeliverySlim = {
  id: string;
  workspaceId: string;
  autopilotId: string;
  triggerId: string;
  provider: string;
  event: string;
  dedupeKey: string | null;
  dedupeSource: string | null;
  signatureStatus: string;
  status: string;
  attemptCount: number;
  contentType: string | null;
  responseStatus: number | null;
  autopilotRunId: string | null;
  replayedFromDeliveryId: string | null;
  error: string | null;
  receivedAt: string;
  lastAttemptAt: string;
  createdAt: string;
};

/**
 * List recent webhook deliveries for an autopilot, scoped to the workspace,
 * newest first (mirrors Go ListWebhookDeliveriesByAutopilot: WHERE
 * autopilot_id = $1 AND workspace_id = $2 ORDER BY created_at DESC, paged).
 *
 * The Go query joins autopilot to enforce the workspace scope; here the caller
 * has already resolved the autopilot inside the workspace, so we filter on the
 * delivery's own `workspace_id` column (which is populated at ingress time and
 * always equals the autopilot's workspace). Big columns are not selected.
 */
export async function listWebhookDeliveriesByAutopilot(
  db: Db,
  wsId: string,
  autopilotId: string,
  limit: number,
  offset: number,
): Promise<WebhookDeliverySlim[]> {
  return db
    .select({
      id: webhookDelivery.id,
      workspaceId: webhookDelivery.workspaceId,
      autopilotId: webhookDelivery.autopilotId,
      triggerId: webhookDelivery.triggerId,
      provider: webhookDelivery.provider,
      event: webhookDelivery.event,
      dedupeKey: webhookDelivery.dedupeKey,
      dedupeSource: webhookDelivery.dedupeSource,
      signatureStatus: webhookDelivery.signatureStatus,
      status: webhookDelivery.status,
      attemptCount: webhookDelivery.attemptCount,
      contentType: webhookDelivery.contentType,
      responseStatus: webhookDelivery.responseStatus,
      autopilotRunId: webhookDelivery.autopilotRunId,
      replayedFromDeliveryId: webhookDelivery.replayedFromDeliveryId,
      error: webhookDelivery.error,
      receivedAt: webhookDelivery.receivedAt,
      lastAttemptAt: webhookDelivery.lastAttemptAt,
      createdAt: webhookDelivery.createdAt,
    })
    .from(webhookDelivery)
    .where(
      and(
        eq(webhookDelivery.autopilotId, autopilotId),
        eq(webhookDelivery.workspaceId, wsId),
      ),
    )
    .orderBy(desc(webhookDelivery.createdAt))
    .limit(limit)
    .offset(offset);
}
