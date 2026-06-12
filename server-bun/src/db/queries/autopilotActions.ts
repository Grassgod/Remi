/**
 * Autopilot action queries — the write half of the autopilot surface, porting
 * the Go sqlc queries behind the detail-page actions (server/pkg/db/queries/
 * autopilot.sql + webhook_delivery.sql): update/delete autopilot, trigger
 * CRUD + webhook-token rotation, run lookup (for the manual /trigger
 * response), and the delivery detail/replay reads + finalisers.
 *
 * Read/create helpers (list/get/create autopilot, list triggers) already live
 * in ./autopilots.ts — routes import those directly; this module only adds
 * what the action endpoints need.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { autopilot, autopilotRun, autopilotTrigger, webhookDelivery } from "../schema.js";
import type { Autopilot, AutopilotTrigger } from "./autopilots.js";

export type AutopilotRun = typeof autopilotRun.$inferSelect;
export type WebhookDelivery = typeof webhookDelivery.$inferSelect;
export type NewAutopilotTrigger = typeof autopilotTrigger.$inferInsert;
export type NewWebhookDelivery = typeof webhookDelivery.$inferInsert;

/**
 * Field-level update of an autopilot (mirrors Go UpdateAutopilot). The caller
 * builds the COALESCE semantics: absent keys keep the previous value (the Go
 * handler pre-fills params from the loaded row), so this helper just applies
 * the merged `set` and stamps updated_at. Returns the updated row.
 */
export async function updateAutopilot(
  db: Db,
  id: string,
  set: Partial<typeof autopilot.$inferInsert>,
): Promise<Autopilot | null> {
  const [a] = await db
    .update(autopilot)
    .set({ ...set, updatedAt: sql`now()` })
    .where(eq(autopilot.id, id))
    .returning();
  return a ?? null;
}

/** Delete an autopilot by UUID (caller resolves workspace scope first). */
export async function deleteAutopilot(db: Db, id: string): Promise<void> {
  await db.delete(autopilot).where(eq(autopilot.id, id));
}

/** Single trigger by UUID (mirrors Go GetAutopilotTrigger). null = not found. */
export async function getAutopilotTrigger(
  db: Db,
  triggerId: string,
): Promise<AutopilotTrigger | null> {
  const [t] = await db.select().from(autopilotTrigger).where(eq(autopilotTrigger.id, triggerId));
  return t ?? null;
}

/** Insert a trigger (mirrors Go CreateAutopilotTrigger). */
export async function createAutopilotTrigger(
  db: Db,
  input: NewAutopilotTrigger,
): Promise<AutopilotTrigger> {
  const [t] = await db.insert(autopilotTrigger).values(input).returning();
  return t!;
}

/**
 * Field-level update of a trigger (mirrors Go UpdateAutopilotTrigger). Same
 * caller-merges-COALESCE contract as updateAutopilot; next_run_at is always
 * written by the caller (the Go query overwrites it unconditionally).
 */
export async function updateAutopilotTrigger(
  db: Db,
  id: string,
  set: Partial<NewAutopilotTrigger>,
): Promise<AutopilotTrigger | null> {
  const [t] = await db
    .update(autopilotTrigger)
    .set({ ...set, updatedAt: sql`now()` })
    .where(eq(autopilotTrigger.id, id))
    .returning();
  return t ?? null;
}

/** Delete a trigger by UUID (caller has verified autopilot ownership). */
export async function deleteAutopilotTrigger(db: Db, triggerId: string): Promise<void> {
  await db.delete(autopilotTrigger).where(eq(autopilotTrigger.id, triggerId));
}

/**
 * Swap in a freshly minted bearer token (mirrors Go
 * RotateAutopilotTriggerWebhookToken). Restricted to kind='webhook' so an
 * accidental call against a schedule trigger is a no-op (returns null)
 * rather than corrupting unrelated state.
 */
export async function rotateAutopilotTriggerWebhookToken(
  db: Db,
  triggerId: string,
  token: string,
): Promise<AutopilotTrigger | null> {
  const [t] = await db
    .update(autopilotTrigger)
    .set({ webhookToken: token, updatedAt: sql`now()` })
    .where(and(eq(autopilotTrigger.id, triggerId), eq(autopilotTrigger.kind, "webhook")))
    .returning();
  return t ?? null;
}

/**
 * Bump last_fired_at after a (re)dispatch fires the trigger (mirrors Go
 * TouchAutopilotTriggerFiredAt).
 */
export async function touchAutopilotTriggerFiredAt(db: Db, triggerId: string): Promise<void> {
  await db
    .update(autopilotTrigger)
    .set({ lastFiredAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(autopilotTrigger.id, triggerId));
}

/** Single run by UUID (mirrors Go GetAutopilotRun). null = not found. */
export async function getAutopilotRun(db: Db, runId: string): Promise<AutopilotRun | null> {
  const [r] = await db.select().from(autopilotRun).where(eq(autopilotRun.id, runId));
  return r ?? null;
}

/**
 * Workspace-scoped full delivery row (mirrors Go GetWebhookDeliveryInWorkspace)
 * — includes raw_body / selected_headers / response_body for the detail and
 * replay endpoints. null = not found / wrong workspace.
 */
export async function getWebhookDeliveryInWorkspace(
  db: Db,
  wsId: string,
  deliveryId: string,
): Promise<WebhookDelivery | null> {
  const [d] = await db
    .select()
    .from(webhookDelivery)
    .where(and(eq(webhookDelivery.id, deliveryId), eq(webhookDelivery.workspaceId, wsId)));
  return d ?? null;
}

/** Full delivery row by UUID (mirrors Go GetWebhookDelivery). */
export async function getWebhookDelivery(db: Db, id: string): Promise<WebhookDelivery | null> {
  const [d] = await db.select().from(webhookDelivery).where(eq(webhookDelivery.id, id));
  return d ?? null;
}

/** Insert a delivery row (replay path; mirrors Go CreateWebhookDelivery). */
export async function createWebhookDelivery(
  db: Db,
  input: NewWebhookDelivery,
): Promise<WebhookDelivery> {
  const [d] = await db.insert(webhookDelivery).values(input).returning();
  return d!;
}

/**
 * Finalise a delivery that produced an autopilot_run (mirrors Go
 * UpdateWebhookDeliveryDispatched): link the run, record the HTTP status +
 * body we returned, refresh last_attempt_at.
 */
export async function finaliseWebhookDeliveryWithRun(
  db: Db,
  id: string,
  status: string,
  runId: string,
  responseStatus: number,
  responseBody: string,
): Promise<void> {
  await db
    .update(webhookDelivery)
    .set({
      status,
      autopilotRunId: runId,
      responseStatus,
      responseBody,
      lastAttemptAt: sql`now()`,
    })
    .where(eq(webhookDelivery.id, id));
}

/**
 * Finalise a delivery without a run link — failed dispatch (mirrors Go
 * UpdateWebhookDeliveryTerminal). Separate helper so callers can't
 * accidentally drop the run id when they only meant to set status/error.
 */
export async function finaliseWebhookDeliveryTerminal(
  db: Db,
  id: string,
  status: string,
  error: string,
  responseStatus: number,
  responseBody: string,
): Promise<void> {
  await db
    .update(webhookDelivery)
    .set({ status, error, responseStatus, responseBody, lastAttemptAt: sql`now()` })
    .where(eq(webhookDelivery.id, id));
}
