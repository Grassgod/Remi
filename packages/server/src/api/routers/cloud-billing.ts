import type { Hono } from "hono";
import {
  readJson,
} from "../helpers.js";
import {
  cJsonCloudBillingBalance,
  cJsonCloudBillingPortal,
  emptyBillingPage,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerCloudBillingRoutes(app: Hono, _deps: RouterDeps): void {
  app.get("/api/cloud-billing/balance", () => cJsonCloudBillingBalance());
  app.get("/api/cloud-billing/transactions", (c) => c.json(emptyBillingPage(c)));
  app.get("/api/cloud-billing/batches", (c) => c.json(emptyBillingPage(c)));
  app.get("/api/cloud-billing/topups", (c) => c.json(emptyBillingPage(c)));
  app.get("/api/cloud-billing/price-tiers", (c) => c.json([
    {
      id: "local-disabled",
      display_name: "Local Bun Multiremi",
      amount_cents: 0,
      credits: 0,
      bonus_credits: 0,
      disabled: true,
      configured: false,
    },
  ]));
  app.post("/api/cloud-billing/checkout-sessions", async (c) => {
    const body = await readJson<{ tier_id?: string; customer_email?: string }>(c);
    return c.json({
      order_id: `local-${Date.now()}`,
      session_id: "local-disabled",
      url: "",
      tier_id: body.tier_id ?? "local-disabled",
      configured: false,
      disabled: true,
      error: "cloud billing is not configured in local Bun Multiremi",
    }, 201);
  });
  app.get("/api/cloud-billing/checkout-sessions/:sessionId", (c) => c.json({
    order_id: `local-${c.req.param("sessionId")}`,
    status: "disabled",
    amount_cents: 0,
    credits: 0,
    bonus_credits: 0,
    currency: "usd",
    tier_id: "local-disabled",
    configured: false,
  }));
  app.post("/api/cloud-billing/portal-sessions", () => cJsonCloudBillingPortal());
}
