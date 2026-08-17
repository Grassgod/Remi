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
