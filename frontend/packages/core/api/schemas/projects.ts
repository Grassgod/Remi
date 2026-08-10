import { z } from "zod";
import type { ListProjectsResponse, Project } from "../../types";

export const ProjectSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  title: z.string(),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  icon: z.string().nullable().optional().transform((value) => value ?? null),
  status: z.string().default("in_progress"),
  priority: z.string().default("none"),
  lead_type: z.enum(["member", "agent"]).nullable().optional().transform((value) => value ?? null),
  lead_id: z.string().nullable().optional().transform((value) => value ?? null),
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
  icon: null,
  status: "in_progress",
  priority: "none",
  lead_type: null,
  lead_id: null,
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
