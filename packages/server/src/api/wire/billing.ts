// Wire serializers for the billing domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import { parseOptionalInt } from "./context.js";

export function emptyBillingPage(c: { req: { query: (name: string) => string | undefined } }): {
  items: [];
  total: 0;
  page: number;
  page_size: number;
} {
  return {
    items: [],
    total: 0,
    page: Math.max(1, parseOptionalInt(c.req.query("page")) ?? 1),
    page_size: Math.max(1, parseOptionalInt(c.req.query("page_size") ?? c.req.query("pageSize")) ?? 20),
  };
}

export function cJsonCloudBillingBalance(): Response {
  return Response.json({
    owner_id: "local",
    balance_micro: 0,
    balance_credit: 0,
    updated_at: new Date(0).toISOString(),
    configured: false,
  });
}

export function cJsonCloudBillingPortal(): Response {
  return Response.json({
    url: "",
    configured: false,
    disabled: true,
    error: "cloud billing is not configured in local Bun Multiremi",
  }, { status: 201 });
}
