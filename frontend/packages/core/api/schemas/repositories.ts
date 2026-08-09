import { z } from "zod";
import type {
  RepositoryInspectionResponse,
  RepositoryMutationResponse,
  WorkspaceRepositoryListResponse,
} from "../../types";

export const workspaceRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  source: z.string().transform((source) =>
    source === "github" || source === "codebase" ? source : "unknown"
  ),
  description: z.string().nullable().default(null),
  default_branch: z.string().nullable().default(null),
  imported_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
}).loose();

export const repositoryListResponseSchema = z.object({
  repositories: z.array(workspaceRepositorySchema),
  total: z.number(),
}).loose();

export const repositoryMutationResponseSchema = z.object({
  repository: workspaceRepositorySchema,
}).loose();

export const repositoryInspectionResponseSchema = z.object({
  metadata: z.object({
    url: z.string(),
    name: z.string(),
    default_branch: z.string(),
    branches: z.array(z.string()),
  }).loose(),
}).loose();

export const EMPTY_REPOSITORY_LIST_RESPONSE: WorkspaceRepositoryListResponse = {
  repositories: [],
  total: 0,
};

export const EMPTY_REPOSITORY_MUTATION_RESPONSE: RepositoryMutationResponse = {
  repository: null,
};

export const EMPTY_REPOSITORY_INSPECTION_RESPONSE: RepositoryInspectionResponse = {
  metadata: null,
};
