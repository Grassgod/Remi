import { z } from "zod";

const statusSchema = z.enum(["pending", "running", "completed", "failed", "timeout"]);

const requestFields = {
  id: z.string().min(1),
  runtime_id: z.string().min(1),
  status: statusSchema,
  error: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
};

const skillSummarySchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  source_path: z.string().min(1),
  provider: z.string(),
  file_count: z.number().int().nonnegative(),
  error: z.string().optional(),
}).loose();

export const RuntimeLocalSkillListRequestSchema = z.object({
  ...requestFields,
  supported: z.boolean(),
  root: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
  skills: z.array(skillSummarySchema).optional(),
}).loose();

const importedSkillSchema = z.object({
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
    created_at: z.string(),
    updated_at: z.string(),
  }).loose()),
}).loose();

export const RuntimeLocalSkillImportRequestSchema = z.object({
  ...requestFields,
  skill_key: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  skill: importedSkillSchema.optional(),
}).loose().refine(value => value.status !== "completed" || value.skill !== undefined, {
  message: "Completed skill import must include the imported skill",
});
