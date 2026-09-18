import { z } from "zod";

export const RuntimeWorkspaceSchema = z.object({
  id: z.string(), workspace_id: z.string(), daemon_id: z.string(), owner_id: z.string(),
  name: z.string(), root_path: z.string(), cwd: z.string(), context_paths: z.array(z.string()),
  env_file: z.string().nullable(), project_id: z.string().nullable(), archived_at: z.string().nullable(),
  status: z.string(), runtime_ids: z.array(z.string()), created_at: z.string(), updated_at: z.string(),
});
export const RuntimeWorkspaceListSchema = z.object({ workspaces: z.array(RuntimeWorkspaceSchema) });
