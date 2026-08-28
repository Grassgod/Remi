// Workspace env endpoint schemas (`/api/workspaces/:id/env`). Same leniency
// rules as the other domains: `.loose()` passes unknown fields, values default
// so an older/newer server never white-screens the settings page.
import { z } from "zod";

export const WorkspaceEnvResponseSchema = z.object({
  workspace_id: z.string().default(""),
  env: z.record(z.string(), z.string()).default({}),
}).loose();

export type WorkspaceEnvResponse = z.infer<typeof WorkspaceEnvResponseSchema>;

export const EMPTY_WORKSPACE_ENV: WorkspaceEnvResponse = { workspace_id: "", env: {} };

const PromptTemplateSha256Schema = z.object({
  bootstrap: z.string().regex(/^[a-f0-9]{64}$/),
  delta: z.string().regex(/^[a-f0-9]{64}$/),
});

export const PlatformPromptTemplatePreviewSchema = z.object({
  bootstrap: z.string(),
  delta: z.string(),
  sha256: PromptTemplateSha256Schema,
}).loose();

export type PlatformPromptTemplatePreview = z.infer<typeof PlatformPromptTemplatePreviewSchema>;

export const EMPTY_PLATFORM_PROMPT_TEMPLATE: PlatformPromptTemplatePreview = {
  bootstrap: "",
  delta: "",
  sha256: { bootstrap: "", delta: "" },
};

const BotMenuBehaviorSchema = z.object({
  type: z.enum(["target", "event_key", "send_message"]),
  url: z.string().optional(),
  eventKey: z.string().optional(),
  isPrimary: z.boolean().optional(),
}).loose();

const BotMenuItemSchema: z.ZodType<unknown> = z.lazy(() => z.object({
  name: z.string(),
  i18nName: z.record(z.string(), z.string()).optional(),
  icon: z.object({
    token: z.string().optional(),
    color: z.string().optional(),
    fileKey: z.string().optional(),
  }).loose().optional(),
  tag: z.string().optional(),
  behaviors: z.array(BotMenuBehaviorSchema).optional(),
  children: z.array(BotMenuItemSchema).optional(),
}).loose());

const BotMenuTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member"), memberId: z.string() }).loose(),
  z.object({ type: z.literal("role"), role: z.enum(["owner", "admin", "member"]) }).loose(),
  z.object({
    type: z.literal("external"),
    userId: z.string(),
    userIdType: z.enum(["open_id", "union_id", "user_id"]),
  }).loose(),
]);

export const BotMenuConfigSchema = z.object({
  default: z.array(BotMenuItemSchema).optional(),
  users: z.array(z.object({
    target: BotMenuTargetSchema,
    label: z.string().optional(),
    items: z.array(BotMenuItemSchema),
  }).loose()).optional(),
}).loose();

export const BotMenuResponseSchema = z.object({
  workspace_id: z.string(),
  bot_menu: BotMenuConfigSchema,
}).loose();

export const BotMenuPublishResponseSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  dry_run: z.boolean(),
  status: z.enum(["pending", "running", "completed", "failed", "timeout"]),
  result: z.object({
    defaultPublished: z.boolean(),
    userMenuCount: z.number(),
    dryRun: z.boolean(),
  }).loose().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const EMPTY_BOT_MENU_RESPONSE = {
  workspace_id: "",
  bot_menu: {},
};

export const EMPTY_BOT_MENU_PUBLISH_RESPONSE = {
  id: "",
  workspace_id: "",
  dry_run: true,
  status: "failed" as const,
  result: null,
  error: "Invalid server response",
  created_at: "",
  updated_at: "",
};
