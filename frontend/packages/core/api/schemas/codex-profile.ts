import { z } from "zod";

export const RuntimeCodexProfileConfigSchema = z.object({
  profile: z.object({ name: z.string(), base_url: z.string(), model: z.string(), env_key: z.string(), auth_mode: z.enum(["api_key", "env"]).optional(), credential_id: z.string().optional() }).strict().nullable(),
});
