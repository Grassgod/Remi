import { z } from "zod";
import type {
  ListScmConnectionsResponse,
  ListScmEventsResponse,
  ScmCapabilitiesResponse,
  ScmConnectionResponse,
} from "../../types";

const ScmStreamCapabilitySchema = z.object({
  poll: z.boolean(),
  webhook: z.boolean(),
  pollFidelity: z.enum(["exact", "inferred"]).nullable(),
  webhookFidelity: z.enum(["exact", "inferred"]).nullable(),
  limitations: z.array(z.string()).default([]),
}).loose();

const ScmProviderCapabilitiesSchema = z.object({
  provider: z.enum(["github", "codebase"]),
  streams: z.object({
    default_branch: ScmStreamCapabilitySchema,
    change_requests: ScmStreamCapabilitySchema,
    comments: ScmStreamCapabilitySchema,
    reviews: ScmStreamCapabilitySchema,
    pipelines: ScmStreamCapabilitySchema,
  }),
  supportsDeleteTombstones: z.boolean(),
  supportsConditionalRequests: z.boolean(),
}).loose();

export const ScmCapabilitiesResponseSchema = z.object({
  providers: z.object({
    github: ScmProviderCapabilitiesSchema,
    codebase: ScmProviderCapabilitiesSchema,
  }),
}).loose();

export const ScmRepositoryBindingSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  connectionId: z.string(),
  repositoryId: z.string(),
  repositoryUrl: z.string(),
  externalId: z.string().nullable().default(null),
  owner: z.string().nullable().default(null),
  name: z.string(),
  defaultBranch: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
}).loose();

export const ScmConnectionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  provider: z.enum(["github", "codebase"]),
  mode: z.enum(["poll", "webhook", "hybrid"]),
  baseUrl: z.string().nullable().default(null),
  apiBaseUrl: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  pollIntervalSeconds: z.number().int().positive().default(60),
  accessTokenSet: z.boolean().default(false),
  accessTokenHint: z.string().nullable().default(null),
  webhookSecretSet: z.boolean().default(false),
  webhookSecretHint: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  repositories: z.array(ScmRepositoryBindingSchema).default([]),
}).loose();

export const ListScmConnectionsResponseSchema = z.object({
  connections: z.array(ScmConnectionSchema).default([]),
}).loose();

export const ScmConnectionResponseSchema = z.object({
  connection: ScmConnectionSchema.nullable().default(null),
}).loose();

export const CanonicalScmEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  connectionId: z.string(),
  repositoryId: z.string(),
  provider: z.enum(["github", "codebase"]),
  type: z.enum([
    "change.opened",
    "change.updated",
    "change.closed",
    "change.reopened",
    "change.merged",
    "comment.created",
    "comment.updated",
    "comment.deleted",
    "review.submitted",
    "review.dismissed",
    "pipeline.started",
    "pipeline.completed",
    "default_branch.updated",
    "push.observed",
  ]),
  subjectType: z.string(),
  subjectId: z.string(),
  logicalKey: z.string(),
  primarySource: z.enum(["poll", "webhook"]),
  fidelity: z.enum(["exact", "inferred"]).catch("exact"),
  occurredAt: z.string().nullable(),
  observedAt: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["pending", "processing", "processed", "failed"]),
  attemptCount: z.number().int().nonnegative().default(0),
  availableAt: z.string(),
  leaseUntil: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  processedAt: z.string().nullable().default(null),
  createdAt: z.string(),
}).loose();

export const ListScmEventsResponseSchema = z.object({
  events: z.array(CanonicalScmEventSchema).default([]),
  total: z.number().int().nonnegative().default(0),
  nextAfter: z.string().nullable().default(null),
}).loose();

export const EMPTY_LIST_SCM_CONNECTIONS_RESPONSE: ListScmConnectionsResponse = {
  connections: [],
};

export const EMPTY_SCM_CONNECTION_RESPONSE: ScmConnectionResponse = {
  connection: null,
};

export const EMPTY_LIST_SCM_EVENTS_RESPONSE: ListScmEventsResponse = {
  events: [],
  total: 0,
  nextAfter: null,
};

export const EMPTY_SCM_CAPABILITIES_RESPONSE: ScmCapabilitiesResponse | null = null;
