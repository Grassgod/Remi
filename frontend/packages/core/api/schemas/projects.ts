import { z } from "zod";
import type { ListProjectsResponse, Project } from "../../types";

export const ProjectSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  title: z.string(),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  instructions: z.string().nullish().catch("").transform((value) => value ?? ""),
  instructions_revision: z.number().int().nonnegative().optional().catch(0).transform((value) => value ?? 0),
  instructions_updated_at: z.string().datetime().nullish().catch(null).transform((value) => value ?? null),
  instructions_updated_by: z.string().min(1).nullish().catch(null).transform((value) => value ?? null),
  icon: z.string().nullable().optional().transform((value) => value ?? null),
  status: z.string().default("in_progress"),
  priority: z.string().default("none"),
  lead_type: z.enum(["member", "agent"]).nullable().optional().transform((value) => value ?? null),
  lead_id: z.string().nullable().optional().transform((value) => value ?? null),
  // `.catch(null)` so a future server-side assignee type degrades to "no
  // default" instead of failing the whole project parse (enum drift rule).
  default_assignee_type: z.enum(["member", "agent", "squad"]).nullable().optional().catch(null).transform((value) => value ?? null),
  default_assignee_id: z.string().nullable().optional().catch(null).transform((value) => value ?? null),
  archived_at: z.string().nullable().optional(),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
  issue_count: z.number().default(0),
  done_count: z.number().default(0),
  resource_count: z.number().default(0),
}).loose().transform((project) => ({
  ...project,
  archived_at:
    project.archived_at === undefined
      ? (["completed", "cancelled"].includes(project.status) ? project.updated_at : null)
      : project.archived_at,
}));

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_PROJECT: Project = {
  id: "",
  workspace_id: "",
  title: "",
  description: null,
  instructions: "",
  instructions_revision: 0,
  instructions_updated_at: null,
  instructions_updated_by: null,
  icon: null,
  status: "in_progress",
  priority: "none",
  lead_type: null,
  lead_id: null,
  default_assignee_type: null,
  default_assignee_id: null,
  archived_at: null,
  created_at: "",
  updated_at: "",
  issue_count: 0,
  done_count: 0,
  resource_count: 0,
};

export const EMPTY_PROJECT_LIST: ListProjectsResponse = {
  projects: [],
  total: 0,
};
