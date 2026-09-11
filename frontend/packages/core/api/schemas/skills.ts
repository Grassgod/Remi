import { z } from "zod";

export const SkillSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  config: z.record(z.string(), z.unknown()),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  files: z.array(z.object({
    id: z.string(),
    skill_id: z.string(),
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    created_at: z.string(),
    updated_at: z.string(),
  }).loose()),
}).loose();
