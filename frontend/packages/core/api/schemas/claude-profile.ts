import { z } from "zod";

export const RuntimeClaudeProfileConfigSchema = z.object({
  profile: z.object({ name: z.string(), base_url: z.string(), model: z.string(), env_key: z.string(), auth_mode: z.enum(["api_key", "env"]).optional(), credential_id: z.string().optional(), auth_header: z.enum(["bearer", "x-api-key"]).optional() }).strict().nullable(),
});
