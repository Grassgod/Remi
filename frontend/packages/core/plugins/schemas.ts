import { z } from "zod";
import type {
  AgentPlugin,
  AgentPluginBinding,
  AgentPluginRuntimeState,
  AgentPluginRepositoryInspection,
  AgentPluginVersion,
  CreateAgentPluginVersionResult,
} from "./types";

const UnknownRecordSchema = z.record(z.string(), z.unknown()).default({});

export const AgentPluginArtifactFileSchema = z
  .object({
    path: z.string(),
    encoding: z.string().default("utf8"),
    content: z.string().optional(),
    size: z.number().default(0),
    digest: z.string().default(""),
    executable: z.boolean().optional(),
  })
  .loose();

export const AgentPluginVersionSchema = z
  .object({
    id: z.string(),
    pluginId: z.string(),
    version: z.string().default(""),
    manifestPath: z.string().default(""),
    manifest: UnknownRecordSchema,
    files: z.array(AgentPluginArtifactFileSchema).default([]),
    artifactDigest: z.string().default(""),
    artifactUrl: z.string().default(""),
    artifactSize: z.number().default(0),
    sourceRevision: z.string().nullable().default(null),
    requirements: UnknownRecordSchema,
    metadata: UnknownRecordSchema,
    createdBy: z.string().nullable().default(null),
    createdAt: z.string().default(""),
  })
  .loose();

export const AgentPluginVersionListSchema = z.union([
  z.array(AgentPluginVersionSchema),
  z
    .object({ versions: z.array(AgentPluginVersionSchema).default([]) })
    .loose()
    .transform((value) => value.versions),
]);

export const AgentPluginRuntimeSummarySchema = z
  .object({
    desired: z.number().default(0),
    ready: z.number().default(0),
    pending: z.number().default(0),
    retrying: z.number().default(0),
    setupRequired: z.number().default(0),
    blocked: z.number().default(0),
    offline: z.number().default(0),
  })
  .loose();

export const AgentPluginSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().default(""),
    // Keep server-driven enums open. UI consumers must render an unknown
    // provider/source with a generic fallback rather than dropping the page.
    provider: z.string(),
    name: z.string().default(""),
    description: z.string().default(""),
    sourceType: z.string().default("manifest"),
    sourceUrl: z.string().nullable().default(null),
    sourceRef: z.string().nullable().default(null),
    sourceSubdir: z.string().nullable().default(null),
    activeVersionId: z.string().nullable().default(null),
    candidateVersionId: z.string().nullable().default(null),
    activeVersion: AgentPluginVersionSchema.nullable().default(null),
    candidateVersion: AgentPluginVersionSchema.nullable().default(null),
    bindingCount: z.number().default(0),
    runtimeSummary: AgentPluginRuntimeSummarySchema.default({
      desired: 0,
      ready: 0,
      pending: 0,
      retrying: 0,
      setupRequired: 0,
      blocked: 0,
      offline: 0,
    }),
    createdBy: z.string().nullable().default(null),
    archivedAt: z.string().nullable().default(null),
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
  })
  .loose();

export const AgentPluginListSchema = z.union([
  z.array(AgentPluginSchema),
  z
    .object({ plugins: z.array(AgentPluginSchema).default([]) })
    .loose()
    .transform((value) => value.plugins),
]);

export const AgentPluginDetailSchema = z.union([
  AgentPluginSchema.nullable(),
  z
    .object({ plugin: AgentPluginSchema.nullable().default(null) })
    .loose()
    .transform((value) => value.plugin),
]);

export const AgentPluginRepositoryCandidateSchema = z
  .object({
    provider: z.enum(["claude", "codex"]),
    name: z.string().min(1),
    description: z.string().default(""),
    version: z.string().min(1),
    sourceSubdir: z.string(),
    manifestPath: z.string().min(1),
    manifest: UnknownRecordSchema,
    fileCount: z.number().int().nonnegative(),
    artifactSize: z.number().int().nonnegative(),
  })
  .loose();

export const AgentPluginRepositoryInspectionSchema = z
  .object({
    sourceUrl: z.string(),
    sourceRef: z.string().min(1),
    defaultBranch: z.string(),
    branches: z.array(z.string()),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i),
    candidates: z.array(AgentPluginRepositoryCandidateSchema).min(1),
  })
  .loose();

export const AgentPluginRepositoryInspectionResponseSchema = z.union([
  AgentPluginRepositoryInspectionSchema.nullable(),
  z
    .object({
      inspection: AgentPluginRepositoryInspectionSchema.nullable().default(null),
    })
    .loose()
    .transform((value) => value.inspection),
]);

export const CreateAgentPluginVersionResultSchema = z
  .object({
    plugin: AgentPluginSchema,
    version: AgentPluginVersionSchema,
  })
  .loose();

export const AgentPluginBindingSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    pluginId: z.string(),
    versionPolicy: z.string().default("follow_active"),
    versionId: z.string().nullable().default(null),
    resolvedVersionId: z.string().nullable().default(null),
    connectionId: z.string().nullable().default(null),
    config: UnknownRecordSchema,
    enabled: z.boolean().default(true),
    plugin: AgentPluginSchema,
    resolvedVersion: AgentPluginVersionSchema.nullable().default(null),
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
  })
  .loose();

export const AgentPluginBindingListSchema = z.union([
  z.array(AgentPluginBindingSchema),
  z
    .object({ bindings: z.array(AgentPluginBindingSchema).default([]) })
    .loose()
    .transform((value) => value.bindings),
]);

export const AgentPluginBindingDetailSchema = z.union([
  AgentPluginBindingSchema.nullable(),
  z
    .object({ binding: AgentPluginBindingSchema.nullable().default(null) })
    .loose()
    .transform((value) => value.binding),
]);

const AgentPluginRuntimeSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    provider: z.string().default("any"),
    daemonId: z.string().nullable().default(null),
    legacyDaemonId: z.string().nullable().default(null),
    runtimeMode: z.string().default(""),
    deviceInfo: z.string().default(""),
    metadata: UnknownRecordSchema,
    workspaceId: z.string().nullable().default(null),
    ownerId: z.string().nullable().default(null),
    visibility: z.string().default("private"),
    status: z.string().default("offline"),
    maxConcurrency: z.number().default(0),
    taskCount: z.number().default(0),
    activeTaskCount: z.number().default(0),
    completedTaskCount: z.number().default(0),
    failedTaskCount: z.number().default(0),
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    cacheReadTokens: z.number().default(0),
    cacheWriteTokens: z.number().default(0),
    models: z.array(z.unknown()).default([]),
    lastHeartbeatAt: z.string().nullable().default(null),
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
  })
  .loose();

export const AgentPluginRuntimeStateSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().default(""),
    runtimeId: z.string(),
    pluginId: z.string(),
    pluginVersionId: z.string(),
    desired: z.boolean().default(true),
    desiredReason: z.string().default("active_binding"),
    status: z.string().default("unknown"),
    observedDigest: z.string().nullable().default(null),
    retryCount: z.number().default(0),
    retryGeneration: z.number().default(0),
    nextRetryAt: z.string().nullable().default(null),
    lastErrorCode: z.string().nullable().default(null),
    lastError: z.string().nullable().default(null),
    lastAttemptAt: z.string().nullable().default(null),
    lastReadyAt: z.string().nullable().default(null),
    plugin: AgentPluginSchema,
    version: AgentPluginVersionSchema,
    runtime: AgentPluginRuntimeSchema,
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
  })
  .loose();

export const AgentPluginRuntimeStateListSchema = z.union([
  z.array(AgentPluginRuntimeStateSchema),
  z
    .object({ states: z.array(AgentPluginRuntimeStateSchema).default([]) })
    .loose()
    .transform((value) => value.states),
  z
    .object({ runtimes: z.array(AgentPluginRuntimeStateSchema).default([]) })
    .loose()
    .transform((value) => value.runtimes),
]);

export const EMPTY_AGENT_PLUGIN_LIST: AgentPlugin[] = [];
export const EMPTY_AGENT_PLUGIN_DETAIL: AgentPlugin | null = null;
export const EMPTY_AGENT_PLUGIN_REPOSITORY_INSPECTION:
  | AgentPluginRepositoryInspection
  | null = null;
export const EMPTY_AGENT_PLUGIN_VERSION_LIST: AgentPluginVersion[] = [];
export const EMPTY_CREATE_AGENT_PLUGIN_VERSION_RESULT:
  | CreateAgentPluginVersionResult
  | null = null;
export const EMPTY_AGENT_PLUGIN_BINDING_LIST: AgentPluginBinding[] = [];
export const EMPTY_AGENT_PLUGIN_BINDING: AgentPluginBinding | null = null;
export const EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST: AgentPluginRuntimeState[] = [];
