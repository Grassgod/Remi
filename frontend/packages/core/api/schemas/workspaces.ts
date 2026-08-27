// Workspace env endpoint schemas (`/api/workspaces/:id/env`). Same leniency
// rules as the other domains: `.loose()` passes unknown fields, values default
// so an older/newer server never white-screens the settings page.
import { z } from "zod";
import type { WorkspaceOrganizerSettings } from "../../types";

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

export const WorkspaceOrganizerSettingsSchema = z.object({
  workspace_id: z.string().default(""),
  mode: z.enum(["report_only", "act"]).default("report_only"),
}).loose();

export const EMPTY_WORKSPACE_ORGANIZER_SETTINGS: WorkspaceOrganizerSettings = {
  workspace_id: "",
  mode: "report_only",
};
