import { z } from "zod";
import type { ListLarkInstallationsResponse } from "../../types";

// ---------------------------------------------------------------------------
// Lark installations — `GET /api/workspaces/:id/lark/installations`, the list
// behind Settings → Lark. Same leniency rules as everything above: `status`
// and `region` stay `z.string()` so a new server-side value renders through
// the generic branch instead of dropping the row, and `installations`
// defaults to `[]`.
//
// The two capability booleans default to `false` on purpose: they gate the
// Bind CTA, so a drifted response must land on "ask the operator to enable
// Lark" rather than offering an install the backend would reject.
// ---------------------------------------------------------------------------

const LarkInstallationSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  agent_id: z.string().default(""),
  app_id: z.string().default(""),
  tenant_key: z.string().nullable().optional(),
  bot_open_id: z.string().default(""),
  installer_user_id: z.string().default(""),
  status: z.string().default(""),
  region: z.string().optional(),
  installed_at: z.string().default(""),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const ListLarkInstallationsResponseSchema = z.object({
  installations: z.array(LarkInstallationSchema).default([]),
  configured: z.boolean().default(false),
  install_supported: z.boolean().optional(),
}).loose();

export const EMPTY_LIST_LARK_INSTALLATIONS_RESPONSE: ListLarkInstallationsResponse = {
  installations: [],
  configured: false,
};
