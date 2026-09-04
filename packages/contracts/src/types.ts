// Wire contracts for every Multiremi product domain. Entities and their Create*/Update* input DTOs
// are grouped into the sections below; within a section, enums come first, then entities, then the
// inputs that build them. Type-only module — no runtime code lives here.

// ─── Agents, skills & templates ──────────────────────────────────────────────────────────────────

export type MultiremiAgentProvider = "claude" | "codex" | string;

export type MultiremiAgentVisibility = "private" | "workspace";

export type MultiremiSkillImportSource = "github" | "skills_sh" | "clawhub";

export interface MultiremiSkillFile {
  id?: string;
  skillId?: string;
  path: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MultiremiSkill {
  id?: string;
  workspaceId?: string;
  name: string;
  description?: string;
  content: string;
  config?: Record<string, unknown>;
  files?: MultiremiSkillFile[];
  createdBy?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MultiremiAgentTemplateSkill {
  sourceUrl: string;
  source_url?: string;
  cachedName: string;
  cached_name?: string;
  cachedDescription: string;
  cached_description?: string;
}

export interface MultiremiAgentTemplateSummary {
  slug: string;
  name: string;
  description: string;
  category?: string;
  icon?: string;
  accent?: string;
  skills: MultiremiAgentTemplateSkill[];
  recommendedProvider?: MultiremiAgentProvider;
  recommendedModel?: string | null;
  requiredPlugins?: string[];
}

export interface MultiremiAgentTemplate extends MultiremiAgentTemplateSummary {
  instructions: string;
}

export type MultiremiAgentRole = "normal" | "maintainer" | "supervisor";

export interface MultiremiAgent {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  avatar_url?: string | null;
  provider: MultiremiAgentProvider;
  workspaceId: string;
  workspace_id?: string;
  ownerId: string;
  owner_id?: string;
  visibility: MultiremiAgentVisibility;
  runtimeId: string | null;
  runtime_id?: string | null;
  instructions: string;
  skills: MultiremiSkill[];
  maxConcurrentTasks: number;
  max_concurrent_tasks?: number;
  executable: string | null;
  model: string | null;
  allowedTools: string[];
  customEnv: Record<string, string>;
  customArgs: string[];
  mcpConfig: unknown | null;
  thinkingLevel: string | null;
  issueCreationRequiresProposal: boolean;
  issue_creation_requires_proposal?: boolean;
  role: MultiremiAgentRole;
  supervisor?: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  id?: string;
  name: string;
  provider: MultiremiAgentProvider;
  template?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiAgentVisibility | string | null;
  runtimeId?: string | null;
  runtime_id?: string | null;
  instructions?: string;
  skills?: MultiremiSkill[];
  maxConcurrentTasks?: number;
  max_concurrent_tasks?: number;
  executable?: string | null;
  model?: string | null;
  allowedTools?: string[];
  allowed_tools?: string[];
  customEnv?: Record<string, string>;
  custom_env?: Record<string, string>;
  customArgs?: string[];
  custom_args?: string[];
  mcpConfig?: unknown | null;
  mcp_config?: unknown | null;
  thinkingLevel?: string | null;
  thinking_level?: string | null;
  issueCreationRequiresProposal?: boolean;
  issue_creation_requires_proposal?: boolean;
  role?: MultiremiAgentRole;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  provider?: MultiremiAgentProvider;
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiAgentVisibility | string | null;
  runtimeId?: string | null;
  runtime_id?: string | null;
  instructions?: string;
  skills?: MultiremiSkill[];
  maxConcurrentTasks?: number;
  max_concurrent_tasks?: number;
  executable?: string | null;
  model?: string | null;
  allowedTools?: string[];
  allowed_tools?: string[];
  customEnv?: Record<string, string>;
  custom_env?: Record<string, string>;
  customArgs?: string[];
  custom_args?: string[];
  mcpConfig?: unknown | null;
  mcp_config?: unknown | null;
  thinkingLevel?: string | null;
  thinking_level?: string | null;
  issueCreationRequiresProposal?: boolean;
  issue_creation_requires_proposal?: boolean;
  role?: MultiremiAgentRole;
}

export interface CreateAgentFromTemplateInput {
  templateSlug?: string;
  template_slug?: string;
  name: string;
  runtimeId?: string | null;
  runtime_id?: string | null;
  provider?: MultiremiAgentProvider | null;
  model?: string | null;
  thinkingLevel?: string | null;
  thinking_level?: string | null;
  visibility?: string;
  maxConcurrentTasks?: number;
  max_concurrent_tasks?: number;
  description?: string | null;
  instructions?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  extraSkillIds?: string[];
  extra_skill_ids?: string[];
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  issueCreationRequiresProposal?: boolean;
  issue_creation_requires_proposal?: boolean;
  role?: MultiremiAgentRole;
}

export interface CreateAgentFromTemplateResult {
  agent: MultiremiAgent;
  importedSkillIds: string[];
  imported_skill_ids: string[];
  reusedSkillIds: string[];
  reused_skill_ids: string[];
  attachedPluginIds?: string[];
  attached_plugin_ids?: string[];
  missingPlugins?: string[];
  missing_plugins?: string[];
}

export interface CreateSkillInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  description?: string;
  content?: string;
  config?: Record<string, unknown> | null;
  files?: MultiremiSkillFile[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface ImportSkillInput {
  url?: string;
  sourceUrl?: string;
  source_url?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface UpdateSkillInput {
  workspaceId?: string | null;
  workspace_id?: string | null;
  name?: string;
  description?: string;
  content?: string;
  config?: Record<string, unknown> | null;
  files?: MultiremiSkillFile[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface SetAgentSkillsInput {
  skillIds?: string[];
  skill_ids?: string[];
}

// Agent Plugins are provider-native packages. Claude and Codex share this management
// envelope, but their manifests, artifacts and runtime loaders are deliberately not interchangeable.
export type MultiremiAgentPluginProvider = "claude" | "codex";

export type MultiremiAgentPluginSourceType = "manifest" | "git" | "marketplace" | "zip" | "runtime";

export type MultiremiAgentPluginVersionPolicy = "follow_active" | "pinned";

/**
 * Version of the daemon/server protocol used to stage provider-native Agent Plugins.
 * A daemon must advertise at least this value during registration and heartbeat.
 */
export const MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION = 1;

export type MultiremiAgentPluginRuntimeStatus =
  | "pending"
  | "downloading"
  | "verifying"
  | "installing"
  | "preflight"
  | "ready"
  | "retry_scheduled"
  | "setup_required"
  | "blocked";

export type MultiremiAgentPluginDesiredReason = "active_binding" | "pinned_binding" | "candidate" | "task_snapshot";

export interface MultiremiAgentPluginArtifactFile {
  path: string;
  encoding: "utf8" | "base64";
  content?: string;
  size: number;
  digest: string;
  executable?: boolean;
}

export interface MultiremiAgentPluginVersion {
  id: string;
  pluginId: string;
  version: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  files: MultiremiAgentPluginArtifactFile[];
  artifactDigest: string;
  artifactUrl: string;
  artifactSize: number;
  sourceRevision: string | null;
  requirements: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}

export interface MultiremiAgentPluginRuntimeSummary {
  desired: number;
  ready: number;
  pending: number;
  retrying: number;
  setupRequired: number;
  blocked: number;
  offline: number;
}

export interface MultiremiAgentPlugin {
  id: string;
  workspaceId: string;
  provider: MultiremiAgentPluginProvider;
  name: string;
  description: string;
  sourceType: MultiremiAgentPluginSourceType;
  sourceUrl: string | null;
  sourceRef: string | null;
  sourceSubdir: string | null;
  activeVersionId: string | null;
  candidateVersionId: string | null;
  activeVersion: MultiremiAgentPluginVersion | null;
  candidateVersion: MultiremiAgentPluginVersion | null;
  bindingCount: number;
  runtimeSummary: MultiremiAgentPluginRuntimeSummary;
  createdBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportAgentPluginInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  provider: MultiremiAgentPluginProvider | string;
  name?: string | null;
  description?: string | null;
  version?: string | null;
  manifestPath?: string | null;
  manifest_path?: string | null;
  manifest: Record<string, unknown>;
  files?: Array<{
    path: string;
    content?: string;
    encoding?: "utf8" | "base64";
    executable?: boolean;
  }>;
  sourceType?: MultiremiAgentPluginSourceType | string | null;
  source_type?: MultiremiAgentPluginSourceType | string | null;
  sourceUrl?: string | null;
  source_url?: string | null;
  sourceRef?: string | null;
  source_ref?: string | null;
  sourceSubdir?: string | null;
  source_subdir?: string | null;
  sourceRevision?: string | null;
  source_revision?: string | null;
  requirements?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  activate?: boolean;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface InspectAgentPluginRepositoryInput {
  workspaceId?: string | null;
  workspace_id?: string | null;
  sourceUrl?: string | null;
  source_url?: string | null;
  sourceRef?: string | null;
  source_ref?: string | null;
  sourceSubdir?: string | null;
  source_subdir?: string | null;
}

export interface MultiremiAgentPluginRepositoryCandidate {
  provider: MultiremiAgentPluginProvider;
  name: string;
  description: string;
  version: string;
  sourceSubdir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  fileCount: number;
  artifactSize: number;
  /** Defaults to true for responses from servers predating deferred size calculation. */
  artifactSizeKnown?: boolean;
}

export interface MultiremiAgentPluginRepositoryInspection {
  sourceUrl: string;
  sourceRef: string;
  defaultBranch: string;
  branches: string[];
  sourceRevision: string;
  candidates: MultiremiAgentPluginRepositoryCandidate[];
}

export interface ImportAgentPluginFromGitInput {
  mode: "git";
  id?: string;
  provider?: MultiremiAgentPluginProvider | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  sourceUrl?: string | null;
  source_url?: string | null;
  sourceRef?: string | null;
  source_ref?: string | null;
  sourceSubdir?: string | null;
  source_subdir?: string | null;
  manifestPath?: string | null;
  manifest_path?: string | null;
  expectedRevision?: string | null;
  expected_revision?: string | null;
  requirements?: Record<string, unknown> | null;
  activate?: boolean;
}

export type ImportAgentPluginRequest =
  | ImportAgentPluginInput
  | ImportAgentPluginFromGitInput;

export interface CreateAgentPluginVersionInput {
  version?: string | null;
  manifestPath?: string | null;
  manifest_path?: string | null;
  manifest: Record<string, unknown>;
  files?: ImportAgentPluginInput["files"];
  sourceRevision?: string | null;
  source_revision?: string | null;
  requirements?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  activate?: boolean;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface UpdateAgentPluginInput {
  name?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  source_url?: string | null;
  sourceRef?: string | null;
  source_ref?: string | null;
  sourceSubdir?: string | null;
  source_subdir?: string | null;
}

export interface MultiremiAgentPluginBinding {
  id: string;
  agentId: string;
  pluginId: string;
  versionPolicy: MultiremiAgentPluginVersionPolicy;
  versionId: string | null;
  resolvedVersionId: string | null;
  connectionId: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  plugin: MultiremiAgentPlugin;
  resolvedVersion: MultiremiAgentPluginVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentPluginBindingInput {
  pluginId?: string;
  plugin_id?: string;
  versionPolicy?: MultiremiAgentPluginVersionPolicy | string;
  version_policy?: MultiremiAgentPluginVersionPolicy | string;
  versionId?: string | null;
  version_id?: string | null;
  connectionId?: string | null;
  connection_id?: string | null;
  config?: Record<string, unknown> | null;
  enabled?: boolean;
}

export interface UpdateAgentPluginBindingInput {
  versionPolicy?: MultiremiAgentPluginVersionPolicy | string;
  version_policy?: MultiremiAgentPluginVersionPolicy | string;
  versionId?: string | null;
  version_id?: string | null;
  connectionId?: string | null;
  connection_id?: string | null;
  config?: Record<string, unknown> | null;
  enabled?: boolean;
}

export interface MultiremiTaskPluginSnapshotEntry {
  bindingId: string;
  pluginId: string;
  versionId: string;
  name: string;
  provider: MultiremiAgentPluginProvider;
  version: string;
  digest: string;
  artifactUrl: string;
  sourceRevision: string | null;
  config: Record<string, unknown>;
  connectionId: string | null;
}

export interface MultiremiAgentPluginRuntimeState {
  id: string;
  workspaceId: string;
  runtimeId: string;
  pluginId: string;
  pluginVersionId: string;
  desired: boolean;
  desiredReason: MultiremiAgentPluginDesiredReason;
  status: MultiremiAgentPluginRuntimeStatus;
  observedDigest: string | null;
  retryCount: number;
  retryGeneration: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastReadyAt: string | null;
  plugin: MultiremiAgentPlugin;
  version: MultiremiAgentPluginVersion;
  runtime: MultiremiRuntime;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiAgentPluginRuntimeDesired {
  stateId: string;
  pluginId: string;
  versionId: string;
  name: string;
  provider: MultiremiAgentPluginProvider;
  version: string;
  digest: string;
  artifactUrl: string;
  sourceRevision: string | null;
  requirements: Record<string, unknown>;
  desiredReason: MultiremiAgentPluginDesiredReason;
  status: MultiremiAgentPluginRuntimeStatus;
  observedDigest: string | null;
  retryCount: number;
  retryGeneration: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface MultiremiAgentPluginRuntimeDesiredSnapshot {
  runtimeId: string;
  revision: string;
  plugins: MultiremiAgentPluginRuntimeDesired[];
}

export interface ReportAgentPluginRuntimeStateInput {
  status: MultiremiAgentPluginRuntimeStatus | string;
  attempts?: number;
  retryGeneration?: number;
  retry_generation?: number;
  observedDigest?: string | null;
  observed_digest?: string | null;
  nextRetryAt?: string | null;
  next_retry_at?: string | null;
  lastErrorCode?: string | null;
  last_error_code?: string | null;
  lastError?: string | null;
  last_error?: string | null;
}

// ─── Runtimes & daemon ───────────────────────────────────────────────────────────────────────────

export type MultiremiRuntimeStatus = "online" | "offline";

export type MultiremiRuntimeVisibility = "private" | "public";

export type MultiremiRuntimeLocalSkillRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export type MultiremiRuntimeModelListRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export type MultiremiRuntimeDirectoryScanRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export type MultiremiRuntimeUpdateRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export type MultiremiRuntimeCommandRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export type MultiremiRuntimeProvisionKind = "npm-global" | "command";
export type MultiremiRuntimeProvisionTriggerKind = "cron" | "on_register" | "on_change";
export type MultiremiRuntimeProvisionStatus = "pending" | "converged" | "drifted" | "failed";

export interface MultiremiRuntime {
  id: string;
  name: string;
  provider: MultiremiAgentProvider | "any";
  daemonId: string | null;
  legacyDaemonId: string | null;
  daemonDisplayName: string | null;
  runtimeMode: string;
  deviceInfo: string;
  metadata: Record<string, unknown>;
  workspaceId: string | null;
  ownerId: string | null;
  visibility: MultiremiRuntimeVisibility;
  status: MultiremiRuntimeStatus;
  maxConcurrency: number;
  taskCount: number;
  activeTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  models: MultiremiRuntimeModel[];
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiCloudRuntimeNode {
  id: string;
  ownerId: string;
  owner_id: string;
  instanceId: string;
  instance_id: string;
  region: string;
  instanceType: string;
  instance_type: string;
  imageId: string;
  image_id: string;
  subnetId: string;
  subnet_id: string;
  name: string;
  status: string;
  tags: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

export interface MultiremiRuntimeLocalSkillSummary {
  key: string;
  name: string;
  description?: string;
  sourcePath: string;
  source_path?: string;
  provider: string;
  fileCount: number;
  file_count?: number;
}

export interface MultiremiRuntimeLocalSkillListRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeLocalSkillRequestStatus;
  skills: MultiremiRuntimeLocalSkillSummary[];
  supported: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeLocalSkillImportRequest {
  id: string;
  runtimeId: string;
  skillKey: string;
  name: string | null;
  description: string | null;
  status: MultiremiRuntimeLocalSkillRequestStatus;
  skill: MultiremiSkill | null;
  skillId: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeModelListRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeModelListRequestStatus;
  models: MultiremiRuntimeModel[];
  supported: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeDirectoryCandidate {
  path: string;
  name: string;
  remoteUrl: string | null;
  currentBranch: string | null;
  isDirty: boolean | null;
  // Present in browse mode (true for git working trees, false for plain dirs);
  // scan-mode candidates may omit it.
  isGitRepo?: boolean;
}

export interface MultiremiRuntimeDirectoryScanParams {
  root?: string;
  maxDepth?: number;
  // "scan" (default) hunts for git working trees; "browse" lists immediate child dirs.
  mode?: "scan" | "browse";
  // Browse mode echoes the expanded absolute root back (e.g. "~" -> "/home/dev")
  // so the folder-picker UI can show the current dir and ascend even when the
  // listing is empty. Absent for scan mode / as-requested params.
  resolvedRoot?: string;
}

export interface MultiremiRuntimeDirectoryScanRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeDirectoryScanRequestStatus;
  params: MultiremiRuntimeDirectoryScanParams;
  candidates: MultiremiRuntimeDirectoryCandidate[];
  supported: boolean;
  error: string | null;
  runStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a runtime update request targets: the remi CLI binary (`cli`), the ACP
 * bridges (`acp`), or the underlying agent CLI — claude/codex (`agent`).
 */
export type MultiremiRuntimeUpdateScope = "cli" | "acp" | "agent";

export interface MultiremiRuntimeUpdateRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeUpdateRequestStatus;
  scope: MultiremiRuntimeUpdateScope;
  targetVersion: string;
  target_version?: string;
  output: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeCommandRequest {
  id: string;
  runtimeId: string;
  command: string;
  args: string[];
  redactedCommand: string;
  redactedArgs: string[];
  provisionId: string | null;
  timeoutMs: number;
  createdBy: string | null;
  status: MultiremiRuntimeCommandRequestStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  durationMs: number | null;
  error: string | null;
  runStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiWorkspaceRuntimeProvision {
  id: string;
  workspaceId: string;
  kind: MultiremiRuntimeProvisionKind;
  enabled: boolean;
  package: string | null;
  version: string | null;
  versionCheck: boolean;
  bin: string | null;
  registry: string | null;
  command: string | null;
  args: string[];
  redactedCommand: string | null;
  redactedArgs: string[];
  triggerKinds: MultiremiRuntimeProvisionTriggerKind[];
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  timeoutMs: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiRuntimeProvisionState {
  provisionId: string;
  runtimeId: string;
  status: MultiremiRuntimeProvisionStatus;
  observedVersion: string | null;
  lastCommandRequestId: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceRuntimeProvisionInput {
  kind?: MultiremiRuntimeProvisionKind | string;
  enabled?: boolean;
  package?: string | null;
  version?: string | null;
  versionCheck?: boolean;
  version_check?: boolean;
  bin?: string | null;
  registry?: string | null;
  command?: string | null;
  args?: string[];
  triggerKinds?: MultiremiRuntimeProvisionTriggerKind[];
  trigger_kinds?: MultiremiRuntimeProvisionTriggerKind[];
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  timeoutMs?: number;
  timeout_ms?: number;
  createdBy?: string | null;
  created_by?: string | null;
}

export type UpdateWorkspaceRuntimeProvisionInput = Partial<CreateWorkspaceRuntimeProvisionInput>;

export interface MultiremiDaemonHeartbeatAck {
  runtime_id: string;
  status: "ok" | "runtime_gone";
  runtime_gone?: boolean;
  pending_update?: {
    id: string;
    target_version: string;
    scope?: MultiremiRuntimeUpdateScope;
  };
  pending_model_list?: {
    id: string;
  };
  pending_local_skills?: {
    id: string;
  };
  pending_directory_scan?: {
    id: string;
    root?: string;
    max_depth?: number;
    mode?: string;
  };
  pending_local_skill_import?: {
    id: string;
    skill_key: string;
  };
  pending_local_skill_imports?: Array<{
    id: string;
    skill_key: string;
  }>;
  pending_command?: {
    id: string;
    command: string;
    args: string[];
    timeout_ms: number;
  };
  pending_bot_menu?: {
    id: string;
    config: ResolvedBotMenuConfig;
    dry_run: boolean;
  };
  /**
   * Feishu concierge assignment for this Runtime. Present only when the daemon
   * advertised `feishu_concierge_protocol`. Carries no credentials — see
   * `MultiremiFeishuBotDirective`.
   */
  feishu_bot?: MultiremiFeishuBotDirective;
  /** One leased proactive reply for the Runtime hosting the Feishu concierge. */
  pending_feishu_outbound?: MultiremiFeishuBotOutboundDelivery;
  ssh_mesh?: MultiremiSshMeshHeartbeatAck;
  /** Platform maintenance directive: daemons must pause task claims while draining. */
  drain?: MultiremiDaemonDrainDirective;
}

/** Server → daemon drain instruction carried in every heartbeat ack. */
export interface MultiremiDaemonDrainDirective {
  mode: MultiremiPlatformMaintenanceMode;
  generation: number;
}

export const MULTIREMI_SSH_MESH_PROTOCOL_VERSION = 1;

export type MultiremiSshMeshNodeKind = "runtime" | "control_plane";

export type MultiremiSshMeshRuntimeStatus =
  | "disabled"
  | "syncing"
  | "ready"
  | "setup_required"
  | "blocked"
  | "error";

export type MultiremiSshMeshPeerStatus =
  | "ready"
  | "unreachable"
  | "host_key_mismatch"
  | "auth_failed"
  | "error";

export interface MultiremiSshMeshPeerProbe {
  /** Canonical machine identity used by browser and control-plane APIs. */
  node_id?: string;
  /** Protocol v1 compatibility field; its value is the opaque SSH Mesh node id. */
  daemon_id: string;
  status: MultiremiSshMeshPeerStatus;
  latency_ms?: number | null;
  error_code?: string | null;
  error?: string | null;
  checked_at?: string | null;
}

/** Machine-level SSH Mesh state observed by a daemon and sent with heartbeat. */
export interface MultiremiDaemonSshMeshStatus {
  status: MultiremiSshMeshRuntimeStatus;
  key_version?: number | null;
  config_revision?: string | null;
  probe_revision?: number;
  ssh_user?: string | null;
  hostname?: string | null;
  port?: number;
  addresses?: string[];
  /** OpenSSH public host keys as `algorithm base64`, without a host prefix. */
  host_keys?: string[];
  public_key_installed?: boolean;
  config_installed?: boolean;
  peers?: MultiremiSshMeshPeerProbe[];
  last_error_code?: string | null;
  last_error?: string | null;
}

export interface MultiremiSshMeshHeartbeatAck {
  enabled: boolean;
  key_version: number;
  config_revision: string;
  needs_sync: boolean;
  rotation_state: "stable" | "rolling_out" | "rekey_required";
  probe_revision: number;
  needs_probe: boolean;
}

export interface MultiremiDaemonSshMeshHost {
  daemon_id: string;
  alias: string;
  hostname: string | null;
  ssh_user: string | null;
  port: number;
  addresses: string[];
  host_keys: string[];
}

/** Daemon-only response. `private_key` must never be exposed on browser routes. */
export interface MultiremiDaemonSshMeshConfig {
  protocol_version: number;
  enabled: boolean;
  key_version: number;
  config_revision: string;
  rotation_state: "stable" | "rolling_out" | "rekey_required";
  probe_revision: number;
  probe_target_daemon_ids: string[];
  private_key?: string;
  public_key?: string;
  authorized_public_keys: string[];
  hosts: MultiremiDaemonSshMeshHost[];
}

export interface MultiremiRuntimeModelThinkingLevel {
  value: string;
  label: string;
  description?: string;
}

export interface MultiremiRuntimeModelThinking {
  supportedLevels: MultiremiRuntimeModelThinkingLevel[];
  supported_levels?: MultiremiRuntimeModelThinkingLevel[];
  defaultLevel?: string;
  default_level?: string;
}

export interface MultiremiRuntimeModel {
  id: string;
  label: string;
  provider: string;
  default: boolean;
  thinking?: MultiremiRuntimeModelThinking;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegisterRuntimeInput {
  id?: string;
  name: string;
  provider: MultiremiAgentProvider | "any";
  daemonId?: string | null;
  daemon_id?: string | null;
  legacyDaemonId?: string | null;
  legacy_daemon_id?: string | null;
  runtimeMode?: string | null;
  runtime_mode?: string | null;
  deviceInfo?: string | null;
  device_info?: string | null;
  metadata?: Record<string, unknown> | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiRuntimeVisibility | string;
  status?: MultiremiRuntimeStatus;
  maxConcurrency?: number;
  max_concurrency?: number;
  models?: MultiremiRuntimeModel[];
}

export interface UpdateRuntimeInput {
  name?: string;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiRuntimeVisibility | string;
  maxConcurrency?: number;
  max_concurrency?: number;
  runtimeMode?: string | null;
  runtime_mode?: string | null;
  deviceInfo?: string | null;
  device_info?: string | null;
  metadata?: Record<string, unknown> | null;
  models?: MultiremiRuntimeModel[];
}

export interface CreateCloudRuntimeNodeInput {
  instanceType?: string;
  instance_type?: string;
  name?: string;
  region?: string;
  imageId?: string;
  image_id?: string;
  subnetId?: string;
  subnet_id?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface CreateRuntimeLocalSkillImportInput {
  skillKey?: string;
  skill_key?: string;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface ReportRuntimeLocalSkillListInput {
  status?: string;
  skills?: MultiremiRuntimeLocalSkillSummary[];
  supported?: boolean;
  error?: string;
}

export interface CreateRuntimeDirectoryScanInput {
  root?: string;
  maxDepth?: number;
  max_depth?: number;
  mode?: "scan" | "browse";
}

export interface ReportRuntimeDirectoryScanInput {
  status?: "completed" | "failed";
  candidates?: MultiremiRuntimeDirectoryCandidate[];
  supported?: boolean;
  error?: string;
  // Expanded absolute root the daemon browsed (browse mode); merged into params.
  resolvedRoot?: string;
}

export interface ReportRuntimeLocalSkillImportInput {
  status?: string;
  skill?: {
    name?: string;
    description?: string;
    content?: string;
    sourcePath?: string;
    source_path?: string;
    provider?: string;
    files?: MultiremiSkillFile[];
  } | null;
  error?: string;
}

export interface ReportRuntimeModelListInput {
  status?: string;
  models?: MultiremiRuntimeModel[];
  supported?: boolean;
  error?: string;
}

export interface CreateRuntimeUpdateInput {
  targetVersion?: string;
  target_version?: string;
  scope?: MultiremiRuntimeUpdateScope;
}

export interface ReportRuntimeUpdateInput {
  status?: string;
  output?: string;
  error?: string;
}

export interface CreateRuntimeCommandInput {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  timeout_ms?: number;
  createdBy?: string | null;
  created_by?: string | null;
  provisionId?: string | null;
  provision_id?: string | null;
  provisionKind?: MultiremiRuntimeProvisionKind;
}

export interface ReportRuntimeCommandInput {
  status?: "completed" | "failed" | "timeout";
  exitCode?: number | null;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  duration_ms?: number;
  error?: string;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────────────────────────

export type MultiremiTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "waiting_local_directory"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export type MultiremiTaskHumanRequestKind = "permission" | "question";

export type MultiremiTaskHumanRequestStatus = "pending" | "responded" | "timeout" | "cancelled";

export interface MultiremiTaskHumanRequest {
  id: string;
  taskId: string;
  kind: MultiremiTaskHumanRequestKind;
  payload: Record<string, unknown>;
  status: MultiremiTaskHumanRequestStatus;
  response: Record<string, unknown> | null;
  respondedBy: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export type MultiremiTaskPromptMode = "bootstrap" | "delta";

export interface MultiremiTaskPromptArtifact {
  taskId: string;
  mode: MultiremiTaskPromptMode;
  prompt: string;
  sha256: string;
  assembledAt: string;
}

export interface RecordTaskPromptInput {
  mode: MultiremiTaskPromptMode;
  prompt: string;
  sha256: string;
}

export interface CreateTaskHumanRequestInput {
  id?: string;
  taskId: string;
  kind: MultiremiTaskHumanRequestKind;
  payload: Record<string, unknown>;
}

export type MultiremiTaskSteerKind = "steer" | "force_answer";

/** Mid-run user intervention: a directive injected into an executing task's
 *  provider session without cancelling the run. `force_answer` asks the agent
 *  to stop exploring and deliver its best conclusion now. */
export interface MultiremiTaskSteerMessage {
  id: string;
  taskId: string;
  task_id?: string;
  authorType: string;
  author_type?: string;
  authorId: string | null;
  author_id?: string | null;
  kind: MultiremiTaskSteerKind;
  content: string;
  createdAt: string;
  created_at?: string;
  consumedAt: string | null;
  consumed_at?: string | null;
}

export interface CreateTaskSteerMessageInput {
  id?: string;
  taskId: string;
  kind: MultiremiTaskSteerKind;
  content: string;
  authorType?: string;
  authorId?: string | null;
}

/** Safe Issue identity attached to a Chat task whose conversation is bound to an Issue. */
export interface MultiremiBoundIssue {
  id: string;
  key: string;
  title: string;
  status: string;
}

export interface MultiremiTask {
  id: string;
  taskKind: "direct" | "quick_create";
  agentId: string;
  runtimeId: string | null;
  /** Engine the task executed under, snapshotted at claim time (the agent's
   *  provider can change mid-run). Null until the task is claimed. Optional on
   *  the wire — it's a server-internal scheduling field the daemon doesn't
   *  receive, so a claim-response task may omit it. */
  provider?: string | null;
  /** Immutable provider-native Plugin set resolved when the task is claimed.
   * Infrastructure retries carry this snapshot forward; a user-created rerun
   * starts empty and resolves the Agent's current bindings on its own claim. */
  pluginSnapshot: MultiremiTaskPluginSnapshotEntry[];
  plugin_snapshot?: MultiremiTaskPluginSnapshotEntry[];
  /** Stable hash of the exact Plugin versions, binding config and connection
   * references used by this execution. Provider sessions only resume when it
   * still matches. Null until a normal queued task is claimed. */
  executionFingerprint: string | null;
  execution_fingerprint?: string | null;
  issueId: string | null;
  issueSessionId: string | null;
  issue_session_id?: string | null;
  /** Generation of this task's per-agent Issue Session lane, frozen at claim
   * time and persisted so late completions cannot promote into a newer lane. */
  issueSessionGeneration?: number | null;
  issue_session_generation?: number | null;
  /** Immutable snapshot of whether this task owns the shared Issue workspace. */
  holdsWorkspace: boolean;
  holds_workspace?: boolean;
  chatSessionId: string | null;
  autopilotRunId: string | null;
  triggerCommentId: string | null;
  trigger_comment_id?: string | null;
  triggerSummary: string | null;
  trigger_summary?: string | null;
  triggerThreadId?: string | null;
  trigger_thread_id?: string | null;
  triggerCommentContent?: string | null;
  trigger_comment_content?: string | null;
  triggerAuthorType?: string | null;
  trigger_author_type?: string | null;
  triggerAuthorName?: string | null;
  trigger_author_name?: string | null;
  triggerCommentAttachments?: unknown[];
  trigger_comment_attachments?: unknown[];
  newCommentCount?: number | null;
  new_comment_count?: number | null;
  newCommentsSince?: string | null;
  new_comments_since?: string | null;
  priorSessionId?: string | null;
  prior_session_id?: string | null;
  priorWorkDir?: string | null;
  prior_work_dir?: string | null;
  session_id?: string | null;
  authToken?: string | null;
  auth_token?: string | null;
  chatMessage?: string | null;
  chat_message?: string | null;
  boundIssueUpdates?: string[];
  bound_issue_updates?: string[];
  boundIssueUpdatesOmittedCount?: number;
  bound_issue_updates_omitted_count?: number;
  /** Issue attached to a Chat session, distinct from the task's owned Issue. */
  boundIssue?: MultiremiBoundIssue | null;
  bound_issue?: MultiremiBoundIssue | null;
  chatMessageAttachments?: unknown[];
  chat_message_attachments?: unknown[];
  autopilotId?: string | null;
  autopilot_id?: string | null;
  autopilotSource?: string | null;
  autopilot_source?: string | null;
  autopilotTitle?: string | null;
  autopilot_title?: string | null;
  autopilotDescription?: string | null;
  autopilot_description?: string | null;
  autopilotTriggerPayload?: unknown | null;
  autopilot_trigger_payload?: unknown | null;
  /** Normalized source revision for an SCM-backed automation claim. */
  scmRevision?: string | null;
  scm_revision?: string | null;
  quickCreatePrompt?: string | null;
  quick_create_prompt?: string | null;
  workspaceContext?: string | null;
  workspace_context?: string | null;
  /** Workspace-level env for the task session, injected below agent customEnv. */
  workspaceEnv?: Record<string, string>;
  workspace_env?: Record<string, string>;
  requestingUserName?: string | null;
  requesting_user_name?: string | null;
  requestingUserProfileDescription?: string | null;
  requesting_user_profile_description?: string | null;
  workspaceId: string;
  status: MultiremiTaskStatus;
  priority: number;
  prompt: string;
  attempt: number;
  maxAttempts: number;
  parentTaskId: string | null;
  /** Immutable capability attenuation snapshot. Once true, every descendant
   * task must also require a human-approved proposal before creating Issues. */
  issueCreationRestricted: boolean;
  issue_creation_restricted?: boolean;
  /** Stable identity shared by a delegated task, its infrastructure retries,
   *  and any tasks that return control to the delegating agent. */
  delegationId: string | null;
  delegation_id?: string | null;
  /** Agent that initiated this delegation. A return task has
   *  agentId === delegatedByAgentId, which prevents a return from bouncing. */
  delegatedByAgentId: string | null;
  delegated_by_agent_id?: string | null;
  assignmentEventId: string | null;
  assignment_event_id?: string | null;
  /** System event that caused the automation-owned task to be assigned. This
   * lineage is propagated to Issue status outbox events so task lifecycle
   * write-backs cannot recursively trigger another automation run. */
  assignmentSourceEventId: string | null;
  assignment_source_event_id?: string | null;
  projectionFromSeq: number | null;
  projection_from_seq?: number | null;
  projectionToSeq: number | null;
  projection_to_seq?: number | null;
  projectionMode: MultiremiSessionProjectionMode | null;
  projection_mode?: MultiremiSessionProjectionMode | null;
  projectionDegradeLevel: number;
  projection_degrade_level?: number;
  projectionTruncated: boolean;
  projection_truncated?: boolean;
  projectionOmittedEvents: number;
  projection_omitted_events?: number;
  projectionEstimatedTokens: number;
  projection_estimated_tokens?: number;
  result: string | null;
  error: string | null;
  failureReason: string | null;
  failure_reason?: string | null;
  branchName: string | null;
  sessionId: string | null;
  workDir: string | null;
  progressSummary: string | null;
  progressStep: number | null;
  progressTotal: number | null;
  waitReason: string | null;
  wait_reason?: string | null;
  usage: TaskUsageEntry[];
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export type MultiremiTaskQueueBlockerReason =
  | "session"
  | "issue_workspace"
  | "legacy_issue"
  | "agent_capacity";

export interface MultiremiTaskQueueBlocker {
  taskId: string;
  agentId: string;
  agentName: string;
  issueSessionId: string | null;
  issueSessionTitle: string | null;
  reason: MultiremiTaskQueueBlockerReason;
}

export interface MultiremiTaskTriggerMetadata {
  triggerThreadId: string | null;
  triggerCommentContent: string | null;
  triggerAuthorType: string | null;
  triggerAuthorName: string | null;
  newCommentCount: number;
  newCommentsSince: string | null;
}

export interface MultiremiTaskWithAgent extends MultiremiTask {
  agent: MultiremiAgent | null;
  issue: MultiremiIssue | null;
  project: MultiremiProject | null;
  projectResources: MultiremiProjectResource[];
  projectDocs: MultiremiProjectDocsIndex | null;
  /** Full Wiki bodies used only to materialize the Issue workspace working copy. */
  projectWikiDocs?: MultiremiProjectDoc[];
  repositoryWikiContexts?: MultiremiTaskRepositoryWikiContext[];
  projectContexts: MultiremiTaskProjectContext[];
  repos: MultiremiRepoData[];
}

export interface MultiremiTaskRepositoryWikiContext {
  repository: {
    id: string;
    name: string;
    url: string;
    defaultBranch: string | null;
  };
  docs: MultiremiRepositoryWikiDoc[];
}

export interface MultiremiTaskProjectContext {
  project: MultiremiProject;
  resources: MultiremiProjectResource[];
  docs: MultiremiProjectDoc[];
  repos: MultiremiRepoData[];
}

export interface MultiremiTaskMessage {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  tool: string | null;
  content: string | null;
  input: Record<string, unknown> | null;
  output: string | null;
  /** ACP tool call id — pairs a tool_use with its tool_result. */
  toolCallId: string | null;
  /** ACP tool status: pending | in_progress | completed | failed. */
  status: string | null;
  /** Low-frequency display semantics: title/kind/locations/content_blocks/duration_ms/entries/usage. */
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export type MultiremiOrganizerActionKind = "steer" | "force_answer" | "cancel" | "redispatch";

export interface MultiremiOrganizerAction {
  id: string;
  workspaceId: string;
  supervisorTaskId: string;
  supervisorAgentId: string;
  targetTaskId: string;
  targetIssueId: string | null;
  replacementTaskId: string | null;
  reportIssueId: string;
  action: MultiremiOrganizerActionKind;
  reason: string;
  createdAt: string;
}

export interface CreateOrganizerActionInput {
  id?: string;
  workspaceId: string;
  supervisorTaskId: string;
  supervisorAgentId: string;
  targetTaskId: string;
  targetIssueId: string | null;
  replacementTaskId?: string | null;
  reportIssueId: string;
  action: MultiremiOrganizerActionKind;
  reason: string;
}

export interface TaskUsageEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Total context tokens consumed, for bridges (ACP `used`) that report no input/output split. */
  totalTokens?: number;
}

export interface CreateTaskInput {
  id?: string;
  taskKind?: "direct" | "quick_create";
  task_kind?: "direct" | "quick_create";
  agentId: string;
  runtimeId?: string | null;
  runtime_id?: string | null;
  /** Server-internal execution snapshot fields used by automatic retries. */
  provider?: string | null;
  pluginSnapshot?: MultiremiTaskPluginSnapshotEntry[];
  plugin_snapshot?: MultiremiTaskPluginSnapshotEntry[];
  executionFingerprint?: string | null;
  execution_fingerprint?: string | null;
  issueId?: string | null;
  issueSessionId?: string | null;
  issue_session_id?: string | null;
  /** Server-internal lane generation. Public task creation strips this field. */
  issueSessionGeneration?: number | null;
  issue_session_generation?: number | null;
  chatSessionId?: string | null;
  triggerCommentId?: string | null;
  trigger_comment_id?: string | null;
  triggerSummary?: string | null;
  trigger_summary?: string | null;
  workspaceId?: string | null;
  priority?: number;
  prompt: string;
  requestingUserName?: string | null;
  requesting_user_name?: string | null;
  requestingUserProfileDescription?: string | null;
  requesting_user_profile_description?: string | null;
  workDir?: string | null;
  sessionId?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  /** Server-internal retry level used to shrink Session projection budgets. */
  projectionDegradeLevel?: number | null;
  projection_degrade_level?: number | null;
  parentTaskId?: string | null;
  parent_task_id?: string | null;
  /** Server-derived capability snapshot. Public task creation must not trust
   * this value; TasksRepo derives it from parent lineage and the target Agent. */
  issueCreationRestricted?: boolean;
  issue_creation_restricted?: boolean;
  /** Server-internal delegation lineage. Public task creation strips it. */
  delegationId?: string | null;
  delegation_id?: string | null;
  delegatedByAgentId?: string | null;
  delegated_by_agent_id?: string | null;
  assignmentEventId?: string | null;
  assignment_event_id?: string | null;
  assignmentAuthorType?: string;
  assignment_author_type?: string;
  assignmentAuthorId?: string | null;
  assignment_author_id?: string | null;
  assignmentSourceEventId?: string | null;
  assignment_source_event_id?: string | null;
  /**
   * Resume-unsafe retry: abandon the chat session's promoted provider session.
   * Skips session/work_dir inheritance and chat-session runtime affinity so the
   * task truly restarts in the pool rather than resuming the failed session on
   * the original machine. local_directory affinity still applies.
   */
  resetProviderSession?: boolean;
}

export interface TaskMessageInput {
  seq?: number;
  type: string;
  tool?: string | null;
  content?: string | null;
  input?: Record<string, unknown> | null;
  output?: string | null;
  toolCallId?: string | null;
  status?: string | null;
  meta?: Record<string, unknown> | null;
}

// ─── Issues, comments & timeline ─────────────────────────────────────────────────────────────────

export type MultiremiIssuePriority = "urgent" | "high" | "medium" | "low" | "none";

export type MultiremiIssueDependencyType = "blocks" | "blocked_by" | "related";

export type MultiremiAssigneeType = "agent" | "member" | "squad";

export type MultiremiIssueKind = "execution" | "intake";

export interface MultiremiIssueAutoTitleMetadata {
  locked?: boolean;
  generated_at?: string;
  model?: string;
  source?: "auto" | "manual";
  content_hash?: string;
  count?: number;
}

export const MULTIREMI_ISSUE_ARCHIVE_DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;
export const MULTIREMI_ISSUE_ARCHIVE_DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const MULTIREMI_ISSUE_ARCHIVE_MIN_TTL_MS = 60 * 60 * 1000;
export const MULTIREMI_ISSUE_ARCHIVE_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const MULTIREMI_ISSUE_ARCHIVE_MIN_SWEEP_INTERVAL_MS = 60 * 1000;

export interface MultiremiIssue {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: MultiremiIssuePriority;
  workspaceId: string;
  projectId: string | null;
  parentIssueId: string | null;
  issueKind: MultiremiIssueKind;
  sourceIssueId: string | null;
  assigneeType: MultiremiAssigneeType | null;
  assigneeId: string | null;
  position: number;
  startDate: string | null;
  dueDate: string | null;
  acceptanceCriteria: unknown[];
  contextRefs: unknown[];
  metadata: Record<string, string | number | boolean>;
  labels: MultiremiLabel[];
  /** Included on daemon task claims so prompts can make issue attachments directly discoverable. */
  attachments?: MultiremiAttachment[];
  createdBy: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiIssueWithTasks extends MultiremiIssue {
  tasks: MultiremiTask[];
  reactions: MultiremiIssueReaction[];
  attachments: MultiremiAttachment[];
  children: MultiremiIssue[];
  childProgress: MultiremiIssueChildProgress;
  dependencies: MultiremiIssueDependency[];
}

export interface MultiremiIssueShare {
  id: string;
  issueId: string;
  workspaceId: string;
  createdBy: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MultiremiIssueWorkspaceStatus =
  | "preparing"
  | "ready"
  | "in_use"
  | "dirty"
  | "runtime_offline"
  | "cleaned"
  | "error";

export interface MultiremiIssueWorkspaceRepo {
  repoUrl: string;
  repoName: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  status: "ready" | "dirty" | "error";
  dirty: boolean;
  error: string | null;
}

export interface MultiremiIssueWorkspace {
  issueId: string;
  workspaceId: string;
  issueKey: string;
  runtimeId: string | null;
  runtimeName: string | null;
  runtimeStatus: MultiremiRuntimeStatus | null;
  runtimeProvider: string | null;
  runtimeMode: string | null;
  runtimeDeviceInfo: string | null;
  runtimeDaemonId: string | null;
  runtimeMachineName: string | null;
  rootPath: string;
  branchName: string;
  status: MultiremiIssueWorkspaceStatus;
  repos: MultiremiIssueWorkspaceRepo[];
  lastTaskId: string | null;
  cleanedAt: string | null;
  cleanedArchiveId: string | null;
  cleanedArchiveSourceRevision: string | null;
  cleanedArchiveSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiIssueWorkspaceArchiveBinding {
  archiveId: string;
  sourceRevision: string;
  sha256: string;
}

export type MultiremiSessionArchiveStatus =
  | "pending"
  | "uploading"
  | "ready"
  | "failed"
  | "superseded";

export const MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS = 60 * 60 * 1000;
export const MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const MULTIREMI_SESSION_ARCHIVE_MIN_GC_INTERVAL_MS = 60 * 1000;
export const MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION = "preparation-failed";

/**
 * Control-plane metadata for a provider-native Issue session archive.
 * Archive bytes live in SessionArchiveStore, never in SQL.
 */
export interface MultiremiSessionArchive {
  id: string;
  workspaceId: string;
  issueId: string;
  runtimeId: string;
  daemonId: string;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  uploadedSizeBytes: number;
  fileCount: number | null;
  status: MultiremiSessionArchiveStatus;
  relativePath: string;
  metadata: Record<string, unknown>;
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: string | null;
  retryExhaustedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface InitSessionArchiveInput {
  workspaceId: string;
  issueId: string;
  runtimeId: string;
  daemonId: string;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  fileCount?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ReportSessionArchiveFailureInput {
  workspaceId: string;
  issueId: string;
  runtimeId: string;
  daemonId: string;
  stage: "prepare";
  error: string;
}

export interface ReportIssueWorkspaceInput {
  issueId: string;
  runtimeId: string;
  rootPath: string;
  branchName: string;
  status: MultiremiIssueWorkspaceStatus;
  repos?: MultiremiIssueWorkspaceRepo[];
  lastTaskId?: string | null;
  cleanedAt?: string | null;
}

export interface MarkIssueWorkspaceCleanedInput extends MultiremiIssueWorkspaceArchiveBinding {
  issueId: string;
  runtimeId: string;
}

export interface MultiremiIssueAssigneeGroup {
  id: string;
  assigneeType: MultiremiAssigneeType | null;
  assigneeId: string | null;
  issues: MultiremiIssue[];
  total: number;
}

export interface MultiremiAssigneeFrequencyEntry {
  assigneeType: MultiremiAssigneeType;
  assignee_type: MultiremiAssigneeType;
  assigneeId: string;
  assignee_id: string;
  frequency: number;
}

export interface MultiremiIssueChildProgress {
  parentIssueId: string;
  total: number;
  done: number;
}

export interface MultiremiIssueDependency {
  id: string;
  workspaceId: string;
  issueId: string;
  dependsOnIssueId: string;
  type: MultiremiIssueDependencyType;
  issue: MultiremiIssue | null;
  dependsOnIssue: MultiremiIssue | null;
  createdAt: string;
}

export interface MultiremiIssueComment {
  id: string;
  issueId: string;
  issue_id?: string;
  issueSessionId: string | null;
  issue_session_id?: string | null;
  authorType: string;
  author_type?: string;
  authorId: string | null;
  author_id?: string | null;
  /** Task whose run produced this comment (agent auto-reply). Null for everything else. */
  taskId: string | null;
  task_id?: string | null;
  parentId: string | null;
  parent_id?: string | null;
  body: string;
  content?: string;
  type?: string;
  resolvedAt: string | null;
  resolved_at?: string | null;
  resolvedByType: string | null;
  resolved_by_type?: string | null;
  resolvedById: string | null;
  resolved_by_id?: string | null;
  reactions: MultiremiCommentReaction[];
  attachments: MultiremiAttachment[];
  replyCount?: number;
  reply_count?: number;
  lastActivityAt?: string;
  last_activity_at?: string;
  contentTruncated?: boolean;
  content_truncated?: boolean;
  createdAt: string;
  created_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface ListIssueCommentsInput {
  issueSessionId?: string | null;
  issue_session_id?: string | null;
  since?: string | null;
  thread?: string | null;
  tail?: number | null;
  recent?: number | null;
  rootsOnly?: boolean;
  roots_only?: boolean;
  summary?: boolean;
  before?: string | null;
  beforeId?: string | null;
  before_id?: string | null;
}

export interface ListIssueCommentsResult {
  comments: MultiremiIssueComment[];
  nextBefore: string | null;
  nextBeforeId: string | null;
  next_before?: string | null;
  next_before_id?: string | null;
}

export interface MultiremiIssueActivity {
  id: string;
  issueId: string;
  actorType: string;
  actorId: string | null;
  type: string;
  body: string | null;
  data: unknown | null;
  createdAt: string;
}

export interface MultiremiTimelineEntry {
  type: "activity" | "comment";
  id: string;
  issueSessionId?: string | null;
  issue_session_id?: string | null;
  actorType: string;
  actor_type?: string;
  actorId: string | null;
  actor_id?: string | null;
  /** Task whose run produced this comment (agent auto-reply) — opens its transcript. */
  taskId?: string | null;
  task_id?: string | null;
  createdAt: string;
  created_at?: string;
  action?: string | null;
  details?: unknown | null;
  content?: string | null;
  parentId?: string | null;
  parent_id?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  commentType?: string | null;
  comment_type?: string | null;
  reactions?: MultiremiCommentReaction[];
  attachments?: MultiremiAttachment[];
  resolvedAt?: string | null;
  resolved_at?: string | null;
  resolvedByType?: string | null;
  resolved_by_type?: string | null;
  resolvedById?: string | null;
  resolved_by_id?: string | null;
}

export interface MultiremiTimelinePage {
  entries: MultiremiTimelineEntry[];
  next_cursor: null;
  prev_cursor: null;
  has_more_before: false;
  has_more_after: false;
  target_index?: number;
}

export interface CreateIssueInput {
  id?: string;
  title: string;
  description?: string | null;
  status?: string;
  priority?: MultiremiIssuePriority | string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  parentIssueId?: string | null;
  parent_issue_id?: string | null;
  issueKind?: MultiremiIssueKind | string;
  issue_kind?: MultiremiIssueKind | string;
  sourceIssueId?: string | null;
  source_issue_id?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  position?: number | null;
  startDate?: string | null;
  start_date?: string | null;
  dueDate?: string | null;
  due_date?: string | null;
  acceptanceCriteria?: unknown[];
  acceptance_criteria?: unknown[];
  contextRefs?: unknown[];
  context_refs?: unknown[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface CreateIssueWithTaskInput extends CreateIssueInput {
  agentId?: string;
  prompt?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: MultiremiIssuePriority | string;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  parentIssueId?: string | null;
  parent_issue_id?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  position?: number | null;
  startDate?: string | null;
  start_date?: string | null;
  dueDate?: string | null;
  due_date?: string | null;
  acceptanceCriteria?: unknown[];
  acceptance_criteria?: unknown[];
  contextRefs?: unknown[];
  context_refs?: unknown[];
  /** Server-internal creator lineage for assignment/status-triggered tasks. */
  parentTaskId?: string | null;
  parent_task_id?: string | null;
}

export interface BatchUpdateIssuesInput {
  issueIds?: string[];
  issue_ids?: string[];
  updates?: UpdateIssueInput;
}

export interface BatchDeleteIssuesInput {
  issueIds?: string[];
  issue_ids?: string[];
}

export interface ListIssuesInput {
  workspaceId?: string | null;
  workspace_id?: string | null;
  statuses?: string[];
  status?: string[];
  priorities?: string[];
  priority?: string[];
  assigneeTypes?: MultiremiAssigneeType[];
  assignee_types?: MultiremiAssigneeType[];
  assigneeId?: string | null;
  assignee_id?: string | null;
  assigneeIds?: string[];
  assignee_ids?: string[];
  projectId?: string | null;
  project_id?: string | null;
  projectIds?: string[];
  project_ids?: string[];
  metadata?: Record<string, string | number | boolean> | null;
  includeNoAssignee?: boolean;
  includeNoProject?: boolean;
  includeArchived?: boolean;
  include_archived?: boolean;
  archivedOnly?: boolean;
  archived_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface AssignIssueInput {
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  prompt?: string | null;
  actorType?: string | null;
  actor_type?: string | null;
  actorId?: string | null;
  actor_id?: string | null;
  /** Server-internal creator lineage. */
  parentTaskId?: string | null;
  parent_task_id?: string | null;
}

export interface AssignIssueResult {
  issue: MultiremiIssue;
  task: MultiremiTask | null;
}

export interface QuickCreateIssueInput {
  agentId?: string | null;
  agent_id?: string | null;
  squadId?: string | null;
  squad_id?: string | null;
  prompt: string;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  requesterId?: string | null;
  requester_id?: string | null;
}

export interface QuickCreateIssueResult {
  issue: MultiremiIssue;
  task: MultiremiTask;
}

export interface CreateIssueDependencyInput {
  id?: string;
  dependsOnIssueId?: string;
  depends_on_issue_id?: string;
  type?: MultiremiIssueDependencyType | string;
}

export interface CreateIssueCommentInput {
  issueSessionId?: string | null;
  issue_session_id?: string | null;
  authorType?: string;
  authorId?: string | null;
  /** Set only by the agent auto-reply path, to link the comment to its run. */
  taskId?: string | null;
  task_id?: string | null;
  parentId?: string | null;
  parent_id?: string | null;
  attachmentIds?: string[];
  attachment_ids?: string[];
  body?: string;
  content?: string;
}

export interface UpdateIssueCommentInput {
  body?: string;
  content?: string;
  attachmentIds?: string[];
  attachment_ids?: string[];
}

export interface MultiremiIssueSearchResult extends MultiremiIssue {
  matchSource: "key" | "title" | "description" | "comment";
  matchedSnippet?: string;
  matchedDescriptionSnippet?: string;
  matchedCommentSnippet?: string;
}

export interface MultiremiProjectSearchResult extends MultiremiProject {
  matchSource: "title" | "description";
  matchedSnippet?: string;
}

// ─── Issue sessions ──────────────────────────────────────────────────────────────────────────────

export type MultiremiIssueSessionStatus = "active" | "archived";

export type MultiremiSessionParticipantType = "agent" | "member";

export type MultiremiSessionProjectionMode = "bootstrap" | "delta";

export interface MultiremiIssueSession {
  id: string;
  issueId: string;
  issue_id?: string;
  workspaceId: string;
  workspace_id?: string;
  title: string;
  status: MultiremiIssueSessionStatus;
  isDefault: boolean;
  is_default?: boolean;
  holdsWorkspace: boolean;
  holds_workspace?: boolean;
  summary: string | null;
  createdByType: string;
  created_by_type?: string;
  createdById: string | null;
  created_by_id?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface MultiremiSessionParticipant {
  id: string;
  sessionId: string;
  session_id?: string;
  participantType: MultiremiSessionParticipantType;
  participant_type?: MultiremiSessionParticipantType;
  participantId: string;
  participant_id?: string;
  role: string;
  status: string;
  joinedAt: string;
  joined_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface MultiremiSessionEvent {
  id: string;
  sessionId: string;
  session_id?: string;
  seq: number;
  authorType: string;
  author_type?: string;
  authorId: string | null;
  author_id?: string | null;
  kind: string;
  body: string;
  taskId: string | null;
  task_id?: string | null;
  sourceCommentId: string | null;
  source_comment_id?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  created_at?: string;
}

export interface MultiremiSessionAgentLane {
  sessionId: string;
  session_id?: string;
  agentId: string;
  agent_id?: string;
  providerSessionId: string | null;
  provider_session_id?: string | null;
  runtimeId: string | null;
  runtime_id?: string | null;
  provider: string | null;
  executionFingerprint: string | null;
  execution_fingerprint?: string | null;
  workDir: string | null;
  work_dir?: string | null;
  cursorSeq: number;
  cursor_seq?: number;
  generation: number;
  status: string;
  lastTaskId: string | null;
  last_task_id?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface MultiremiSessionResult {
  id: string;
  issueId: string;
  issue_id?: string;
  sourceSessionId: string;
  source_session_id?: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  publishedByType: string;
  published_by_type?: string;
  publishedById: string | null;
  published_by_id?: string | null;
  createdAt: string;
  created_at?: string;
}

export interface MultiremiSessionProjection {
  sessionId: string;
  session_id?: string;
  targetAgentId: string;
  target_agent_id?: string;
  mode: MultiremiSessionProjectionMode;
  fromSeq: number;
  from_seq?: number;
  toSeq: number;
  to_seq?: number;
  /** Deterministic newline-delimited JSON projection for the ACP user turn. */
  jsonl: string;
  truncated: boolean;
  omittedEvents: number;
  omitted_events?: number;
  estimatedTokens: number;
  estimated_tokens?: number;
}

export interface CreateIssueSessionInput {
  id?: string;
  issueId?: string;
  issue_id?: string;
  title?: string;
  createdByType?: string;
  created_by_type?: string;
  createdById?: string | null;
  created_by_id?: string | null;
  participantAgentIds?: string[];
  participant_agent_ids?: string[];
  holdsWorkspace?: boolean;
  holds_workspace?: boolean;
}

export interface UpdateIssueSessionInput {
  title?: string;
  status?: MultiremiIssueSessionStatus;
  summary?: string | null;
}

export interface AddSessionParticipantInput {
  participantType?: MultiremiSessionParticipantType;
  participant_type?: MultiremiSessionParticipantType;
  participantId?: string;
  participant_id?: string;
  role?: string;
}

export interface CreateSessionTaskInput {
  agentId?: string;
  agent_id?: string;
  prompt: string;
  createdByType?: string;
  created_by_type?: string;
  createdById?: string | null;
  created_by_id?: string | null;
  sourceEventId?: string | null;
  source_event_id?: string | null;
  priority?: number;
  /** Server-internal creator lineage. */
  parentTaskId?: string | null;
  parent_task_id?: string | null;
}

export interface PublishSessionResultInput {
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  publishedByType?: string;
  published_by_type?: string;
  publishedById?: string | null;
  published_by_id?: string | null;
  /** Server-internal creator lineage. Public routes derive this from the task credential. */
  sourceTaskId?: string | null;
}

// ─── Inbox, reactions, attachments, labels & pins ────────────────────────────────────────────────

export type MultiremiPinnedItemType = "issue" | "project";

export interface MultiremiIssueSubscriber {
  id: string;
  issueId: string;
  issue_id?: string;
  memberId: string;
  member_id?: string;
  userType: string;
  user_type?: string;
  userId: string;
  user_id?: string;
  reason: MultiremiSubscriptionReason;
  createdAt: string;
  created_at?: string;
}

export interface MultiremiInboxItem {
  id: string;
  workspaceId: string;
  workspace_id?: string;
  issueId: string | null;
  issue_id?: string | null;
  memberId: string;
  member_id?: string;
  recipientType: string;
  recipient_type?: string;
  recipientId: string;
  recipient_id?: string;
  actorType: string;
  actor_type?: string;
  actorId: string | null;
  actor_id?: string | null;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  details: unknown | null;
  read: boolean;
  archived: boolean;
  createdAt: string;
  created_at?: string;
  issue: MultiremiIssue | null;
}

export interface MultiremiInboxPage {
  items: MultiremiInboxItem[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface MultiremiInboxSummary {
  unread: number;
  attention: number;
}

export type MultiremiNotificationChannelKind = "inapp" | "feishu_group" | "agent_chat";
export type MultiremiNotificationDeliveryStatus = "pending" | "sent" | "failed";

export interface MultiremiNotificationChannel {
  id: string;
  workspaceId: string;
  /** null = workspace-level channel (admin managed); otherwise the owning member id. */
  memberId: string | null;
  kind: MultiremiNotificationChannelKind;
  name: string;
  enabled: boolean;
  target: { chatId: string };
  eventTypes: string[];
  minSeverity: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiNotificationDelivery {
  id: string;
  workspaceId: string;
  inboxItemId: string;
  channelId: string;
  channelKind: MultiremiNotificationChannelKind;
  targetLabel: string;
  status: MultiremiNotificationDeliveryStatus;
  attempts: number;
  claimSeq: number;
  leasedUntil: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface MultiremiAgentIssueUpdateSubscription {
  chatSessionId: string;
  issueId: string | null;
  channelId: string | null;
  enabled: boolean;
  debounceWindowSeconds: number;
}

export interface MultiremiIssueReaction {
  id: string;
  issueId: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface MultiremiCommentReaction {
  id: string;
  commentId: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface MultiremiAttachment {
  id: string;
  workspaceId: string;
  issueId: string | null;
  commentId: string | null;
  chatSessionId: string | null;
  chatMessageId: string | null;
  uploaderType: string;
  uploaderId: string;
  filename: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface MultiremiLabel {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiPinnedItem {
  id: string;
  workspaceId: string;
  userId: string;
  itemType: MultiremiPinnedItemType;
  itemId: string;
  position: number;
  createdAt: string;
}

export interface CreateMultiremiReactionInput {
  actorType?: string;
  actor_type?: string;
  actorId?: string | null;
  actor_id?: string | null;
  emoji: string;
}

export interface CreateAttachmentInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  issueId?: string | null;
  issue_id?: string | null;
  commentId?: string | null;
  comment_id?: string | null;
  chatSessionId?: string | null;
  chat_session_id?: string | null;
  chatMessageId?: string | null;
  chat_message_id?: string | null;
  uploaderType?: string;
  uploader_type?: string;
  uploaderId?: string | null;
  uploader_id?: string | null;
  filename: string;
  url: string;
  contentType?: string | null;
  content_type?: string | null;
  sizeBytes?: number | null;
  size_bytes?: number | null;
}

export interface CreateLabelInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  color: string;
}

export interface UpdateLabelInput {
  name?: string;
  color?: string;
}

export interface CreatePinnedItemInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  userId?: string | null;
  user_id?: string | null;
  itemType?: MultiremiPinnedItemType | string;
  item_type?: MultiremiPinnedItemType | string;
  itemId?: string;
  item_id?: string;
}

export interface ReorderPinnedItemInput {
  id: string;
  position: number;
}

// ─── Projects & docs ─────────────────────────────────────────────────────────────────────────────

export type MultiremiProjectStatus = "planned" | "in_progress" | "paused" | "completed" | "cancelled";

export type MultiremiProjectPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface MultiremiProject {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  instructions: string;
  deltaInstructions: string;
  instructionsRevision: number;
  instructionsUpdatedAt: string | null;
  instructionsUpdatedBy: string | null;
  icon: string | null;
  status: MultiremiProjectStatus;
  priority: MultiremiProjectPriority;
  leadType: "member" | "agent" | null;
  leadId: string | null;
  /** Default assignee prefilled on issues created under this project (e.g. a squad). */
  defaultAssigneeType: MultiremiAssigneeType | null;
  defaultAssigneeId: string | null;
  issueCount: number;
  doneCount: number;
  resourceCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiProjectResource {
  id: string;
  projectId: string;
  workspaceId: string;
  resourceType: string;
  resourceRef: Record<string, unknown>;
  label: string | null;
  position: number;
  createdAt: string;
  createdBy: string | null;
}

export interface MultiremiProjectDevice {
  projectId: string;
  workspaceId: string;
  daemonId: string;
  displayName: string;
  online: boolean;
  providers: Array<MultiremiAgentProvider | "any">;
  createdAt: string;
  createdBy: string | null;
}

/** Daemon-only projection used by the co-resident bot's persistent project switcher. */
export interface MultiremiDaemonBotProject {
  id: string;
  title: string;
  cwd: string;
}

export type MultiremiProjectDocKind = "wiki" | "memory";

export interface MultiremiProjectDoc {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: MultiremiProjectDocKind;
  slug: string;
  /** Workspace-relative Markdown path. Slug remains the stable document identity. */
  path: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  /** Cited sources. type: issue|task|comment|url|file (lenient — unknown types are kept). */
  refs: MultiremiProjectDocRef[];
  sourceTaskId: string | null;
  sourceIssueId: string | null;
  authorType: "member" | "agent" | null;
  authorId: string | null;
  updatedByType: "member" | "agent" | null;
  updatedById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** ProjectKnowledge control-plane fields. SQL rows created before migration may omit them on the wire. */
  storageBackend?: "sql" | "openviking";
  contentUri?: string | null;
  contentSha256?: string | null;
  syncStatus?: "sql" | "pending" | "ready" | "failed" | "deleting";
  syncError?: string | null;
  snapshotOid?: string | null;
  /** Compilation run that produced the current formal version. Legacy rows are null. */
  compilationRunId?: string | null;
}

export interface MultiremiProjectDocRevision {
  id: string;
  docId: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  authorType: "member" | "agent" | null;
  authorId: string | null;
  createdAt: string;
  contentSha256?: string | null;
  snapshotOid?: string | null;
  contentUri?: string | null;
  /** Compilation run that produced this revision. Legacy rows are null. */
  compilationRunId?: string | null;
}

export type MultiremiRepositoryWikiStatus =
  | "unbuilt"
  | "building"
  | "healthy"
  | "stale"
  | "failed";

/** Repository-scoped code facts. Bodies live in OpenViking in production. */
export interface MultiremiRepositoryWikiDoc {
  id: string;
  repositoryId: string;
  workspaceId: string;
  path: string;
  /** Legacy-friendly leaf reference; clients should prefer path. */
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  refs: MultiremiProjectDocRef[];
  sourceTaskId: string | null;
  sourceIssueId: string | null;
  authorType: "member" | "agent" | null;
  authorId: string | null;
  updatedByType: "member" | "agent" | null;
  updatedById: string | null;
  sourceRevision: string | null;
  status: MultiremiRepositoryWikiStatus;
  statusMessage: string | null;
  version: number;
  storageBackend: "sql" | "openviking";
  contentUri: string | null;
  contentSha256: string | null;
  syncStatus: "sql" | "pending" | "ready" | "failed" | "deleting";
  syncError: string | null;
  snapshotOid: string | null;
  createdAt: string;
  updatedAt: string;
  /** Compilation run that produced the current formal version. Legacy rows are null. */
  compilationRunId?: string | null;
}

export interface MultiremiRepositoryWikiDocRevision {
  id: string;
  docId: string;
  version: number;
  path: string;
  title: string;
  summary: string | null;
  body: string;
  sourceRevision: string | null;
  authorType: "member" | "agent" | null;
  authorId: string | null;
  contentUri: string | null;
  contentSha256: string | null;
  snapshotOid: string | null;
  createdAt: string;
  /** Compilation run that produced this revision. Legacy rows are null. */
  compilationRunId?: string | null;
}

export interface CreateRepositoryWikiDocInput {
  id?: string;
  path?: string | null;
  slug?: string | null;
  title?: string;
  summary?: string | null;
  body?: string | null;
  tags?: string[] | null;
  refs?: MultiremiProjectDocRef[] | null;
  sourceTaskId?: string | null;
  source_task_id?: string | null;
  sourceIssueId?: string | null;
  source_issue_id?: string | null;
  sourceRevision?: string | null;
  source_revision?: string | null;
  authorType?: "member" | "agent" | null;
  author_type?: "member" | "agent" | null;
  authorId?: string | null;
  author_id?: string | null;
}

export interface UpdateRepositoryWikiDocInput {
  path?: string | null;
  slug?: string | null;
  title?: string;
  summary?: string | null;
  body?: string | null;
  tags?: string[] | null;
  refs?: MultiremiProjectDocRef[] | null;
  sourceRevision?: string | null;
  source_revision?: string | null;
  status?: MultiremiRepositoryWikiStatus;
  statusMessage?: string | null;
  status_message?: string | null;
  expectedVersion?: number | null;
  expected_version?: number | null;
  updatedByType?: "member" | "agent" | null;
  updated_by_type?: "member" | "agent" | null;
  updatedById?: string | null;
  updated_by_id?: string | null;
}

/** One final-graph mutation submitted by `remi wiki push`. */
export type RepositoryWikiBatchOperation =
  | {
      kind: "create";
      input: CreateRepositoryWikiDocInput;
    }
  | {
      kind: "update";
      ref: string;
      input: UpdateRepositoryWikiDocInput;
    }
  | {
      kind: "delete";
      ref: string;
      expectedVersion?: number | null;
      expected_version?: number | null;
    };

export interface RepositoryWikiBatchInput {
  operations: RepositoryWikiBatchOperation[];
}

export interface RepositoryWikiBatchResult {
  kind: RepositoryWikiBatchOperation["kind"];
  doc: MultiremiRepositoryWikiDoc;
}

/** Workspace-wide doc listing entry: a doc plus its project's title for grouping. */
export interface MultiremiWorkspaceProjectDoc extends MultiremiProjectDoc {
  projectTitle: string;
}

/** Injection index attached to task dispatch. Bodies only for memory entries, trimmed. */
export interface MultiremiProjectDocIndexEntry {
  id: string;
  slug: string;
  path: string;
  title: string;
  summary: string | null;
  /** memory entries carry a body (trimmed to 500 chars); wiki entries are null. */
  body: string | null;
  kind: MultiremiProjectDocKind;
  pinned: boolean;
  sourceIssueId: string | null;
  updatedAt: string;
}

export interface MultiremiProjectDocRef {
  type: string;
  value: string;
}

export interface MultiremiProjectDocsIndex {
  memory: MultiremiProjectDocIndexEntry[];
  wiki: MultiremiProjectDocIndexEntry[];
  /** Body of the `_schema` doc (trimmed to 1500 chars), null when absent. `_schema` is not in wiki[]. */
  schema: string | null;
}

export type MultiremiKnowledgeScope = "project_wiki" | "repository_wiki" | "memory";
export type MultiremiKnowledgeSubmissionSourceType =
  | "agent"
  | "issue_completion"
  | "external"
  | "legacy_wiki"
  | "legacy_memory";
export type MultiremiKnowledgeSubmissionStatus =
  | "pending"
  | "processing"
  | "consumed"
  | "partial"
  | "rejected"
  | "archived";
export type MultiremiKnowledgeCompilationMode =
  | "issue_ingest"
  | "repository_update"
  | "memory_curate"
  | "lint"
  | "legacy_migration"
  | "manual_edit";
export type MultiremiKnowledgeCompilationStatus =
  | "preparing"
  | "validating"
  | "published"
  | "published_with_warnings"
  | "failed"
  | "noop";
export type MultiremiKnowledgeCompilationAction =
  | "create"
  | "update"
  | "merge"
  | "split"
  | "reject"
  | "noop";

export interface MultiremiKnowledgeSubmission {
  id: string;
  workspaceId: string;
  projectId: string | null;
  repositoryId: string | null;
  scope: MultiremiKnowledgeScope;
  sourceType: MultiremiKnowledgeSubmissionSourceType;
  proposedPath: string | null;
  proposedSlug: string | null;
  body: string;
  patch: string | null;
  baseRevision: string | null;
  sourceTaskId: string | null;
  sourceIssueId: string | null;
  sourceRevision: string | null;
  authorAgentId: string | null;
  contentSha256: string;
  status: MultiremiKnowledgeSubmissionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiKnowledgeCompilationRun {
  id: string;
  workspaceId: string;
  projectId: string | null;
  repositoryId: string | null;
  taskId: string | null;
  agentId: string | null;
  autopilotRunId: string | null;
  mode: MultiremiKnowledgeCompilationMode;
  status: MultiremiKnowledgeCompilationStatus;
  resultSummary: string | null;
  dedupeKey: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface MultiremiKnowledgeSubmissionListInput {
  workspaceId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  scope?: string | null;
  status?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface MultiremiKnowledgeCompilationRunListInput {
  workspaceId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  status?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface MultiremiKnowledgeCursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MultiremiKnowledgeCompilationRunSource {
  id: string;
  runId: string;
  submissionId: string | null;
  sourceType: "submission" | "scm_event";
  sourceRef: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MultiremiKnowledgeCompilationOutput {
  id: string;
  runId: string;
  artifactScope: MultiremiKnowledgeScope;
  docId: string | null;
  revisionId: string | null;
  version: number | null;
  action: MultiremiKnowledgeCompilationAction;
  contentSha256: string | null;
  createdAt: string;
}

export interface CreateKnowledgeSubmissionInput {
  workspaceId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  scope: MultiremiKnowledgeScope;
  sourceType: MultiremiKnowledgeSubmissionSourceType;
  proposedPath?: string | null;
  proposedSlug?: string | null;
  body?: string | null;
  patch?: string | null;
  baseRevision?: string | null;
  sourceTaskId?: string | null;
  sourceIssueId?: string | null;
  sourceRevision?: string | null;
  authorAgentId?: string | null;
  /** Legacy migration deduplicates against every status, not only pending Raw. */
  dedupeAllStatuses?: boolean;
}

export interface CreateKnowledgeCompilationRunInput {
  workspaceId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  autopilotRunId?: string | null;
  mode: MultiremiKnowledgeCompilationMode;
  status?: MultiremiKnowledgeCompilationStatus;
  resultSummary?: string | null;
  dedupeKey?: string | null;
}

export interface MultiremiRepoData {
  url: string;
  description?: string;
}

export interface CreateProjectInput {
  id?: string;
  title: string;
  description?: string | null;
  instructions?: string;
  deltaInstructions?: string;
  delta_instructions?: string;
  icon?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  status?: MultiremiProjectStatus;
  priority?: MultiremiProjectPriority;
  leadType?: "member" | "agent" | null;
  lead_type?: "member" | "agent" | null;
  leadId?: string | null;
  lead_id?: string | null;
  defaultAssigneeType?: MultiremiAssigneeType | null;
  default_assignee_type?: MultiremiAssigneeType | null;
  defaultAssigneeId?: string | null;
  default_assignee_id?: string | null;
  resources?: CreateProjectResourceInput[];
}

export interface UpdateProjectInput {
  title?: string;
  description?: string | null;
  instructions?: string;
  deltaInstructions?: string;
  delta_instructions?: string;
  expectedInstructionsRevision?: number;
  expected_instructions_revision?: number;
  icon?: string | null;
  status?: MultiremiProjectStatus;
  priority?: MultiremiProjectPriority;
  leadType?: "member" | "agent" | null;
  lead_type?: "member" | "agent" | null;
  leadId?: string | null;
  lead_id?: string | null;
  defaultAssigneeType?: MultiremiAssigneeType | null;
  default_assignee_type?: MultiremiAssigneeType | null;
  defaultAssigneeId?: string | null;
  default_assignee_id?: string | null;
}

export interface CreateProjectResourceInput {
  id?: string;
  resourceType?: string;
  resource_type?: string;
  resourceRef?: Record<string, unknown>;
  resource_ref?: Record<string, unknown>;
  label?: string | null;
  position?: number | null;
  createdBy?: string | null;
}

export interface CreateProjectDeviceInput {
  daemonId?: string;
  daemon_id?: string;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface ReplaceProjectDevicesInput {
  daemonIds?: string[];
  daemon_ids?: string[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface UpdateProjectResourceInput {
  resourceRef?: Record<string, unknown>;
  resource_ref?: Record<string, unknown>;
  label?: string | null;
  position?: number | null;
}

export interface CreateProjectDocInput {
  id?: string;
  kind?: string | null;
  slug?: string | null;
  path?: string | null;
  title?: string;
  summary?: string | null;
  body?: string | null;
  tags?: string[] | null;
  pinned?: boolean | null;
  refs?: MultiremiProjectDocRef[] | null;
  sourceTaskId?: string | null;
  source_task_id?: string | null;
  sourceIssueId?: string | null;
  source_issue_id?: string | null;
  authorType?: "member" | "agent" | null;
  author_type?: "member" | "agent" | null;
  authorId?: string | null;
  author_id?: string | null;
}

export interface UpdateProjectDocInput {
  slug?: string | null;
  path?: string | null;
  title?: string;
  summary?: string | null;
  body?: string | null;
  tags?: string[] | null;
  pinned?: boolean | null;
  refs?: MultiremiProjectDocRef[] | null;
  expectedVersion?: number | null;
  expected_version?: number | null;
  updatedByType?: "member" | "agent" | null;
  updated_by_type?: "member" | "agent" | null;
  updatedById?: string | null;
  updated_by_id?: string | null;
}

// ─── Squads ──────────────────────────────────────────────────────────────────────────────────────

export type MultiremiSquadMemberType = "agent" | "member";

export interface MultiremiSquad {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  avatarUrl: string | null;
  leaderId: string | null;
  creatorId: string | null;
  archivedAt: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiSquadMember {
  id: string;
  squadId: string;
  memberType: MultiremiSquadMemberType;
  memberId: string;
  role: string;
  createdAt: string;
}

export interface CreateSquadInput {
  id?: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  avatarUrl?: string | null;
  workspaceId?: string | null;
  leaderId?: string | null;
  creatorId?: string | null;
  memberIds?: string[];
}

export interface UpdateSquadInput {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  avatarUrl?: string | null;
  leaderId?: string | null;
}

export interface AddSquadMemberInput {
  memberType: MultiremiSquadMemberType;
  memberId: string;
  role?: string;
}

export interface RemoveSquadMemberInput {
  memberType: MultiremiSquadMemberType;
  memberId: string;
}

// ─── Feishu message ingestion ───────────────────────────────────────────────────────────────────

export type MultiremiFeishuSourceType = "personal_automation";

export interface MultiremiFeishuAllowlistEntry {
  chatId: string;
  addedAt: string;
}

export interface MultiremiFeishuSource {
  id: string;
  workspaceId: string;
  name: string;
  type: MultiremiFeishuSourceType;
  endpointName: string;
  allowlist: MultiremiFeishuAllowlistEntry[];
  enabled: boolean;
  retentionDays: number;
  pollIntervalSeconds: number;
  unprocessedRetrySeconds: number;
  unprocessedRetryLimit: number;
  accessTokenSet: boolean;
  accessTokenHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMultiremiFeishuSourceInput {
  id?: string;
  workspaceId?: string;
  workspace_id?: string;
  name?: string | null;
  type?: MultiremiFeishuSourceType;
  endpointName?: string;
  endpoint_name?: string;
  allowlist?: Array<string | Partial<MultiremiFeishuAllowlistEntry>>;
  enabled?: boolean;
  retentionDays?: number;
  retention_days?: number;
  pollIntervalSeconds?: number;
  poll_interval_seconds?: number;
  unprocessedRetrySeconds?: number;
  unprocessed_retry_seconds?: number;
  unprocessedRetryLimit?: number;
  unprocessed_retry_limit?: number;
}

export interface UpdateMultiremiFeishuSourceInput {
  name?: string | null;
  endpointName?: string;
  endpoint_name?: string;
  allowlist?: Array<string | Partial<MultiremiFeishuAllowlistEntry>>;
  enabled?: boolean;
  retentionDays?: number;
  retention_days?: number;
  pollIntervalSeconds?: number;
  poll_interval_seconds?: number;
  unprocessedRetrySeconds?: number;
  unprocessed_retry_seconds?: number;
  unprocessedRetryLimit?: number;
  unprocessed_retry_limit?: number;
}

export interface MultiremiFeishuSyncCursor {
  sourceId: string;
  stream: string;
  cursor: Record<string, unknown> | null;
  watermark: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
  updatedAt: string;
}

export interface MultiremiFeishuMessage {
  messageId: string;
  workspaceId: string;
  sourceId: string;
  chatId: string;
  chatType: string | null;
  chatName: string | null;
  threadId: string | null;
  rootId: string | null;
  parentId: string | null;
  sender: Record<string, unknown>;
  content: Record<string, unknown>;
  searchableText: string;
  contentFingerprint: string;
  messageAppLink: string | null;
  createdAt: string;
  updatedAt: string | null;
  recalled: boolean;
  edited: boolean;
  ingestedAt: string;
  processedAt: string | null;
  retryCount: number;
  lastRetryAt: string | null;
}

export interface MultiremiFeishuChat {
  sourceId: string;
  chatId: string;
  chatName: string | null;
  chatType: string | null;
  messageCount: number;
  lastMessageAt: string;
  inAllowlist: boolean;
}

export interface MultiremiFeishuSourceStatus {
  sourceId: string;
  unprocessedCount: number;
  timedOutCount: number;
  mutedDeliveryCount: number;
  pendingIssueProposalCount: number;
  oldestUnprocessedAt: string | null;
  maximumRetryCount: number;
  lastSuccessfulIngestAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  lagSeconds: number | null;
  consecutiveFailures: number;
  connectionAlertedAt: string | null;
  connectionAlertDeliveryFailureCount: number;
  connectionAlertDeliveryErrorCode: string | null;
  connectionAlertDeliveryFailedAt: string | null;
}

export type MultiremiFeishuMessageOutcomeKind =
  | "issue_proposed"
  | "issue_created"
  | "notified"
  | "reply_drafted"
  | "ignored"
  | "dismissed";

export interface MultiremiFeishuMessageOutcome {
  id: string;
  workspaceId: string;
  messageId: string;
  outcomeKind: MultiremiFeishuMessageOutcomeKind;
  ref: string | null;
  reason: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface ResolveMultiremiFeishuMessageInput {
  workspaceId?: string;
  workspace_id?: string;
  outcome: MultiremiFeishuMessageOutcomeKind;
  ref?: string | null;
  reason?: string | null;
  taskId?: string | null;
  task_id?: string | null;
}

export interface NotifyMultiremiFeishuMessageInput {
  summary: string;
}

export interface DraftReplyMultiremiFeishuMessageInput {
  draftText?: string;
  draft_text?: string;
}

export interface CreateIssueFromMultiremiFeishuMessageInput {
  title: string;
  description?: string | null;
  priority?: MultiremiIssuePriority | string;
  projectId?: string | null;
  project_id?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
}

export type MultiremiFeishuIssueProposalStatus = "pending" | "approved" | "rejected";

export interface MultiremiFeishuIssueProposal {
  id: string;
  workspaceId: string;
  messageId: string;
  inboxItemId: string | null;
  issue: CreateIssueFromMultiremiFeishuMessageInput;
  status: MultiremiFeishuIssueProposalStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export interface MultiremiFeishuIssueProposalMessageSummary {
  messageId: string;
  sourceId: string;
  chatId: string;
  chatName: string | null;
  sender: Record<string, unknown>;
  searchableText: string;
  messageAppLink: string | null;
  createdAt: string;
}

export interface MultiremiFeishuIssueProposalListItem extends MultiremiFeishuIssueProposal {
  message: MultiremiFeishuIssueProposalMessageSummary;
}

// ─── Autopilots ──────────────────────────────────────────────────────────────────────────────────

export type MultiremiAutopilotStatus = "active" | "paused" | "archived";

export type MultiremiAutopilotExecutionMode = "create_issue" | "run_only" | "trigger_issue";

export type MultiremiAutopilotSessionPolicy = "new" | "reuse_latest";

export type MultiremiAutopilotWorkspacePolicy = "reuse_issue";

export type MultiremiAutopilotAssigneeType = "agent" | "squad";

export type MultiremiAutopilotTriggerKind = "schedule" | "webhook" | "api" | "system_event" | "scm_event";

export type MultiremiAutopilotRunStatus = "issue_created" | "running" | "completed" | "failed" | "skipped";

export type MultiremiAutopilotRunSource = "manual" | "schedule" | "webhook" | "api" | "system_event" | "scm_event";

export type MultiremiIssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";

export interface MultiremiSystemEventCondition {
  field: "status";
  operator: "becomes";
  value: MultiremiIssueStatus;
}

export interface MultiremiAutopilotSystemEventConfig {
  resource: "issue";
  event: "status_changed";
  conditions: MultiremiSystemEventCondition[];
  projectId?: string | null;
  project_id?: string | null;
}

export interface MultiremiAutopilotFeishuEventConfig {
  resource: "feishu_source";
  event: "messages_ingested";
  sourceIds?: string[];
  source_ids?: string[];
  triggerIssueId: string;
  trigger_issue_id?: string;
}

export interface MultiremiAutopilotScmEventConfig {
  resource: "scm";
  events: MultiremiScmCanonicalEventType[];
  connectionId?: string | null;
  connection_id?: string | null;
  repositoryIds?: string[];
  repository_ids?: string[];
  branch?: string | null;
}

export type MultiremiAutopilotEventConfig =
  | MultiremiAutopilotSystemEventConfig
  | MultiremiAutopilotFeishuEventConfig
  | MultiremiAutopilotScmEventConfig;

export type MultiremiSystemEventStatus = "pending" | "processing" | "processed" | "failed";

export interface MultiremiSystemEvent {
  id: string;
  workspaceId: string;
  resource: "issue" | "feishu_source";
  event: "status_changed" | "messages_ingested";
  resourceId: string;
  projectId: string | null;
  payload: Record<string, unknown>;
  status: MultiremiSystemEventStatus;
  attemptCount: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface MultiremiAutopilot {
  id: string;
  workspaceId: string;
  workspace_id?: string;
  title: string;
  description: string | null;
  projectId: string | null;
  project_id?: string | null;
  assigneeType: MultiremiAutopilotAssigneeType;
  assignee_type?: MultiremiAutopilotAssigneeType;
  assigneeId: string;
  assignee_id?: string;
  status: MultiremiAutopilotStatus;
  executionMode: MultiremiAutopilotExecutionMode;
  execution_mode?: MultiremiAutopilotExecutionMode;
  sessionPolicy: MultiremiAutopilotSessionPolicy;
  session_policy?: MultiremiAutopilotSessionPolicy;
  workspacePolicy: MultiremiAutopilotWorkspacePolicy;
  workspace_policy?: MultiremiAutopilotWorkspacePolicy;
  issueTitleTemplate: string | null;
  issue_title_template?: string | null;
  triggerKind: string;
  trigger_kind?: string;
  triggerLabel: string | null;
  trigger_label?: string | null;
  cronExpression: string | null;
  cron_expression?: string | null;
  issueCreationRestricted: boolean;
  issue_creation_restricted?: boolean;
  issueCreationRestrictionReason: "restricted_task" | "human_policy" | null;
  issue_creation_restriction_reason?: "restricted_task" | "human_policy" | null;
  issueCreationRestrictedByTaskId: string | null;
  issue_creation_restricted_by_task_id?: string | null;
  createdByType: "member" | "agent";
  created_by_type?: "member" | "agent";
  createdById: string;
  created_by_id?: string;
  lastRunAt: string | null;
  last_run_at?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface MultiremiAutopilotTrigger {
  id: string;
  autopilotId: string;
  kind: MultiremiAutopilotTriggerKind;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  webhookToken: string | null;
  webhookPath: string | null;
  webhookUrl: string | null;
  provider: MultiremiWebhookProvider | null;
  label: string | null;
  eventFilters: MultiremiWebhookEventFilter[] | null;
  eventConfig: MultiremiAutopilotEventConfig | null;
  event_config?: MultiremiAutopilotEventConfig | null;
  issueCreationRestricted: boolean;
  issueCreationRestrictionReason: "restricted_task" | "human_policy" | null;
  issueCreationRestrictedByTaskId: string | null;
  signingSecretSet: boolean;
  signingSecretHint: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiAutopilotRun {
  id: string;
  autopilotId: string;
  source: MultiremiAutopilotRunSource;
  status: MultiremiAutopilotRunStatus;
  issueId: string | null;
  taskId: string | null;
  triggerId: string | null;
  eventId: string | null;
  issueSessionId: string | null;
  triggeredAt: string;
  completedAt: string | null;
  failureReason: string | null;
  payload: unknown | null;
  result: unknown | null;
  createdAt: string;
}

export interface CreateAutopilotInput {
  id?: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  assigneeType?: MultiremiAutopilotAssigneeType;
  assignee_type?: MultiremiAutopilotAssigneeType;
  assigneeId: string;
  assignee_id?: string;
  status?: MultiremiAutopilotStatus;
  executionMode?: MultiremiAutopilotExecutionMode;
  execution_mode?: MultiremiAutopilotExecutionMode;
  sessionPolicy?: MultiremiAutopilotSessionPolicy;
  session_policy?: MultiremiAutopilotSessionPolicy;
  workspacePolicy?: MultiremiAutopilotWorkspacePolicy;
  workspace_policy?: MultiremiAutopilotWorkspacePolicy;
  issueTitleTemplate?: string | null;
  issue_title_template?: string | null;
  triggerKind?: string;
  trigger_kind?: string;
  triggerLabel?: string | null;
  trigger_label?: string | null;
  cronExpression?: string | null;
  cron_expression?: string | null;
  createdByType?: "member" | "agent";
  created_by_type?: "member" | "agent";
  createdById?: string | null;
  created_by_id?: string | null;
  issueCreationRestricted?: boolean;
  issue_creation_restricted?: boolean;
  /** Server-owned audit fields. Public routes overwrite these values. */
  issueCreationRestrictionReason?: "restricted_task" | "human_policy" | null;
  issueCreationRestrictedByTaskId?: string | null;
}

export interface CreateAutopilotTriggerInput {
  kind?: MultiremiAutopilotTriggerKind;
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  label?: string | null;
  provider?: MultiremiWebhookProvider | string | null;
  enabled?: boolean;
  eventFilters?: MultiremiWebhookEventFilter[] | null;
  event_filters?: MultiremiWebhookEventFilter[] | null;
  eventConfig?: MultiremiAutopilotEventConfig | null;
  event_config?: MultiremiAutopilotEventConfig | null;
  issueCreationRestricted?: boolean;
  issue_creation_restricted?: boolean;
  /** Server-owned audit fields. Public routes overwrite these values. */
  issueCreationRestrictionReason?: "restricted_task" | "human_policy" | null;
  issueCreationRestrictedByTaskId?: string | null;
}

export interface UpdateAutopilotTriggerInput {
  enabled?: boolean;
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  label?: string | null;
  eventFilters?: MultiremiWebhookEventFilter[] | null;
  event_filters?: MultiremiWebhookEventFilter[] | null;
  eventConfig?: MultiremiAutopilotEventConfig | null;
  event_config?: MultiremiAutopilotEventConfig | null;
  issueCreationRestricted?: boolean;
  issue_creation_restricted?: boolean;
  /** Server-owned audit fields. Public routes overwrite these values. */
  issueCreationRestrictionReason?: "restricted_task" | "human_policy" | null;
  issueCreationRestrictedByTaskId?: string | null;
}

export interface UpdateAutopilotInput {
  title?: string;
  description?: string | null;
  projectId?: string | null;
  assigneeType?: MultiremiAutopilotAssigneeType;
  assigneeId?: string;
  status?: MultiremiAutopilotStatus;
  executionMode?: MultiremiAutopilotExecutionMode;
  sessionPolicy?: MultiremiAutopilotSessionPolicy;
  workspacePolicy?: MultiremiAutopilotWorkspacePolicy;
  issueTitleTemplate?: string | null;
  triggerKind?: string;
  triggerLabel?: string | null;
  cronExpression?: string | null;
  issueCreationRestricted?: boolean;
  issue_creation_restricted?: boolean;
  /** Server-owned audit fields. Public routes overwrite these values. */
  issueCreationRestrictionReason?: "restricted_task" | "human_policy" | null;
  issueCreationRestrictedByTaskId?: string | null;
}

export interface RunAutopilotInput {
  source?: MultiremiAutopilotRunSource;
  prompt?: string | null;
  payload?: unknown | null;
  triggerIssueId?: string | null;
  trigger_issue_id?: string | null;
  triggerId?: string | null;
  trigger_id?: string | null;
  eventId?: string | null;
  event_id?: string | null;
}

// ─── Users, workspaces, membership & tokens ──────────────────────────────────────────────────────

export interface MultiremiWorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string | null;
  name: string;
  email: string | null;
  role: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiUser {
  id: string;
  externalId: string | null;
  external_id: string | null;
  name: string;
  email: string;
  avatarUrl: string | null;
  avatar_url: string | null;
  language: string | null;
  timezone: string | null;
  onboardedAt: string | null;
  onboarded_at: string | null;
  onboardingQuestionnaire: Record<string, unknown>;
  onboarding_questionnaire: Record<string, unknown>;
  starterContentState: string | null;
  starter_content_state: string | null;
  profileDescription: string;
  profile_description: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

export interface MultiremiWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  context: string | null;
  settings: Record<string, unknown>;
  repos: unknown[];
  issuePrefix: string;
  issue_prefix: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

// ─── Workspace Feishu bot menu ─────────────────────────────────────────────────────────────────

export type BotMenuUserIdType = "open_id" | "union_id" | "user_id";

export interface BotMenuBehavior {
  type: "target" | "event_key" | "send_message";
  url?: string;
  eventKey?: string;
  isPrimary?: boolean;
}

export interface BotMenuIcon {
  token?: string;
  color?: string;
  fileKey?: string;
}

export interface BotMenuItemConfig {
  name: string;
  i18nName?: Record<string, string>;
  icon?: BotMenuIcon;
  tag?: string;
  behaviors?: BotMenuBehavior[];
  children?: BotMenuItemConfig[];
}

export type BotMenuAudienceTarget =
  | { type: "member"; memberId: string }
  | { type: "role"; role: "owner" | "admin" | "member" }
  | { type: "external"; userId: string; userIdType: BotMenuUserIdType };

export interface BotMenuUserConfig {
  target: BotMenuAudienceTarget;
  label?: string;
  items: BotMenuItemConfig[];
}

export interface BotMenuConfig {
  default?: BotMenuItemConfig[];
  users?: BotMenuUserConfig[];
}

/** Daemon-facing menu after member/role targets have been resolved to Feishu identifiers. */
export interface ResolvedBotMenuUserConfig {
  userId: string;
  userIdType: BotMenuUserIdType;
  label?: string;
  items: BotMenuItemConfig[];
}

export interface ResolvedBotMenuConfig {
  default?: BotMenuItemConfig[];
  users?: ResolvedBotMenuUserConfig[];
}

export type MultiremiBotMenuPublishRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export interface BotMenuPublishResult {
  dryRun: boolean;
  defaultPublished: boolean;
  userMenuCount: number;
}

export interface MultiremiBotMenuPublishRequest {
  id: string;
  runtimeId: string;
  workspaceId: string;
  config: ResolvedBotMenuConfig;
  dryRun: boolean;
  status: MultiremiBotMenuPublishRequestStatus;
  result: BotMenuPublishResult | null;
  error: string | null;
  createdBy: string | null;
  runStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotMenuPublishRequestInput {
  workspaceId: string;
  config: ResolvedBotMenuConfig;
  dryRun: boolean;
  createdBy?: string | null;
}

export interface ReportBotMenuPublishInput {
  status: "completed" | "failed";
  result?: BotMenuPublishResult | null;
  error?: string | null;
}

/**
 * Workspace Feishu concierge bot (MUL-206).
 *
 * One bot per workspace: `multiremi_feishu_bot_configs` is keyed by workspace
 * so the control plane, not a daemon machine's environment, owns which Agent
 * answers Feishu messages and which Runtime hosts the connector.
 */

/** Capability a Runtime must advertise before it can be selected to host the bot. */
export const FEISHU_CONCIERGE_CONFIG_CAPABILITY = "feishu_concierge_config_v1";

/** Protocol version a daemon reports in register/heartbeat when it can host the bot. */
export const FEISHU_CONCIERGE_PROTOCOL_VERSION = 1;

/** Adds durable proactive topic replies without removing v1 inbound support. */
export const FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION = 2;

export type FeishuBotDomain = "feishu" | "lark" | "bytedance";

/** Workspace policy for creating one Feishu topic per newly created Issue. */
export interface IssueTopicConfig {
  enabled: boolean;
  chatId: string;
  /** Omitted means every project, including projectless Issues. */
  projectIds?: string[];
}

/** What the control plane wants the selected Runtime to do with the connector. */
export type FeishuBotDesiredState = "running" | "stopped";

/** What a Runtime reports back about the connector it is hosting. */
export type FeishuBotRuntimeState = "stopped" | "starting" | "online" | "failed";

export interface MultiremiFeishuBotOutboundDelivery {
  id: string;
  claimToken: string;
  claim_token?: string;
  chatId: string;
  chat_id?: string;
  threadId: string | null;
  thread_id?: string | null;
  replyToMessageId: string | null;
  reply_to_message_id?: string | null;
  body: string;
  /** Stable across retries so Feishu can deduplicate send-success/ack-failure. */
  idempotencyKey: string;
  idempotency_key?: string;
}

/**
 * Aggregate status shown in Workspace Settings. Derived from the config row,
 * the selected Runtime's liveness, and the reported per-Runtime states — it is
 * never stored directly, so it cannot drift from those inputs.
 */
export type FeishuBotStatus =
  | "not_configured"
  | "stopped"
  | "deploying"
  | "connecting"
  | "online"
  | "degraded"
  | "failed"
  | "runtime_offline";

/** Stable, non-sensitive failure vocabulary safe to render in the browser. */
export type FeishuBotErrorCode =
  | "invalid_credentials"
  | "insufficient_permissions"
  | "agent_unavailable"
  | "runtime_unavailable"
  | "connector_start_failed"
  | "network_unreachable"
  | "unknown";

/** Server-side config row. Secrets live only in the `*Encrypted` fields. */
export interface MultiremiFeishuBotConfig {
  workspaceId: string;
  agentId: string;
  runtimeId: string;
  appId: string;
  domain: FeishuBotDomain;
  enabled: boolean;
  /** Bumped on every mutation; daemons refetch when their applied revision lags. */
  revision: number;
  hasAppSecret: boolean;
  /** Non-reversible display prefix of the stored app secret, e.g. `abcd••••`. */
  appSecretHint: string | null;
  botName: string | null;
  botOpenId: string | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  lastTestErrorCode: FeishuBotErrorCode | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Admin-facing view. Secret fields are reported as `configured` booleans plus a
 * short hint; the plaintext never leaves the server.
 */
export interface FeishuBotConfigView {
  configured: boolean;
  workspace_id: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_archived: boolean;
  runtime_id: string | null;
  runtime_name: string | null;
  runtime_online: boolean;
  runtime_supports_config: boolean;
  app_id: string;
  domain: FeishuBotDomain;
  enabled: boolean;
  revision: number;
  app_secret_configured: boolean;
  app_secret_hint: string | null;
  bot_name: string | null;
  bot_open_id: string | null;
  last_tested_at: string | null;
  last_test_error: string | null;
  last_test_error_code: FeishuBotErrorCode | null;
  created_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Member-visible projection: whether the bot is usable, and nothing else. No
 * credentials, no Runtime identity, no error detail.
 */
export interface FeishuBotAvailabilityView {
  configured: boolean;
  available: boolean;
  bot_name: string | null;
}

export interface FeishuBotStatusView {
  status: FeishuBotStatus;
  workspace_id: string;
  enabled: boolean;
  revision: number;
  desired_state: FeishuBotDesiredState;
  runtime_id: string | null;
  runtime_name: string | null;
  runtime_online: boolean;
  applied_revision: number | null;
  bot_name: string | null;
  last_heartbeat_at: string | null;
  error_code: FeishuBotErrorCode | null;
  /** Already redacted server-side; safe to render verbatim. */
  error_message: string | null;
  /** Runtimes other than the selected one that still report a live connector. */
  stale_runtime_ids: string[];
}

/**
 * `keep` preserves the stored secret, `set` replaces it, `clear` removes it.
 * Editing a non-secret field therefore cannot silently wipe a credential.
 */
export type FeishuBotSecretOp = "keep" | "set" | "clear";

export interface UpsertFeishuBotConfigInput {
  agentId: string;
  runtimeId: string;
  appId: string;
  domain: FeishuBotDomain;
  enabled: boolean;
  appSecretOp: FeishuBotSecretOp;
  appSecret?: string;
  actor?: string | null;
}

/** Per-Runtime reported state, used to derive status and detect double-runs. */
export interface MultiremiFeishuBotRuntimeStatus {
  workspaceId: string;
  runtimeId: string;
  appliedRevision: number;
  state: FeishuBotRuntimeState;
  botName: string | null;
  botOpenId: string | null;
  errorCode: FeishuBotErrorCode | null;
  errorMessage: string | null;
  reportedAt: string;
}

export interface ReportFeishuBotRuntimeStatusInput {
  appliedRevision: number;
  state: FeishuBotRuntimeState;
  botName?: string | null;
  botOpenId?: string | null;
  errorCode?: FeishuBotErrorCode | null;
  errorMessage?: string | null;
}

/**
 * Heartbeat/register ack fragment. Deliberately carries no credentials: the
 * daemon learns only that its assignment changed and then fetches the payload
 * over its own authenticated, runtime-scoped route.
 */
export interface MultiremiFeishuBotDirective {
  revision: number;
  desired_state: FeishuBotDesiredState;
  /** False while another Runtime still holds the connector (two-phase handover). */
  config_available: boolean;
}

/** Runtime-scoped payload returned to the daemon. Contains decrypted secrets. */
export interface MultiremiFeishuBotDaemonConfig {
  workspace_id: string;
  runtime_id: string;
  agent_id: string;
  revision: number;
  desired_state: FeishuBotDesiredState;
  app_id: string;
  app_secret: string;
  domain: FeishuBotDomain;
}

/**
 * What the daemon actually fetches before starting the connector: the
 * credentials plus the Agent row the Task bridge needs.
 *
 * They travel together on purpose. The daemon could read the Agent off a
 * heartbeat instead, but then a start would mix one revision's credentials
 * with whatever Agent the last heartbeat happened to carry; here the whole
 * assignment is consistent as of a single revision.
 */
export interface MultiremiFeishuBotDaemonPayload extends MultiremiFeishuBotDaemonConfig {
  /** Wire-shaped Agent row (snake_case), or null when the Agent has vanished. */
  bot_agent: Record<string, unknown> | null;
}

/** One inbound Feishu event submitted by the Runtime hosting the connector. */
export interface SubmitFeishuBotMessageInput {
  revision: number;
  externalSessionKey: string;
  externalMessageId: string;
  replyToMessageId?: string | null;
  senderOpenId?: string | null;
  senderUserId?: string | null;
  senderUnionId?: string | null;
  senderTenantKey?: string | null;
  senderName?: string | null;
  chatId?: string | null;
  threadId?: string | null;
  text: string;
}

/** The canonical Chat/Task lineage selected for an inbound Feishu event. */
export interface SubmitFeishuBotMessageResult {
  chatSessionId: string;
  taskId: string;
  status: MultiremiTaskStatus;
  duplicate: boolean;
  steered: boolean;
  senderMembership: "member" | "non_member" | "unbound";
}

/** Runtime-facing Task snapshot used by connector delivery polling. */
export interface FeishuBotTaskSnapshot {
  taskId: string;
  status: MultiremiTaskStatus;
  result: string | null;
  error: string | null;
  sessionId: string | null;
  workDir: string | null;
  usage: TaskUsageEntry[];
}

/** Current canonical Chat/Task lineage bound to one Feishu conversation. */
export interface FeishuBotSessionSnapshot {
  chatSessionId: string | null;
  task: FeishuBotTaskSnapshot | null;
}

/** Result of validating credentials against the Feishu open platform. */
export interface FeishuBotTestResult {
  ok: boolean;
  bot_name: string | null;
  bot_open_id: string | null;
  app_name: string | null;
  runtime_online: boolean;
  runtime_supports_config: boolean;
  error_code: FeishuBotErrorCode | null;
  error_message: string | null;
}

export type FeishuBotAuditAction =
  | "configured"
  | "updated"
  | "deleted"
  | "enabled"
  | "disabled"
  | "redeployed"
  | "tested"
  | "registration_started"
  | "registration_used";

/**
 * One audited change to the concierge. `details` records which fields moved and
 * whether a secret was replaced — never a secret's value.
 */
export interface MultiremiFeishuBotAuditEntry {
  id: string;
  workspaceId: string;
  action: FeishuBotAuditAction;
  actorType: string;
  actorId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MultiremiPromptSettings {
  bootstrapPrompt: string;
  deltaPrompt: string;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UpdateMultiremiPromptSettingsInput {
  bootstrapPrompt?: string;
  bootstrap_prompt?: string;
  deltaPrompt?: string;
  delta_prompt?: string;
  expectedRevision?: number;
  expected_revision?: number;
}

export type MultiremiWorkspaceInvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface MultiremiWorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspace_id: string;
  inviterId: string;
  inviter_id: string;
  inviteeEmail: string;
  invitee_email: string;
  inviteeUserId: string | null;
  invitee_user_id: string | null;
  role: string;
  status: MultiremiWorkspaceInvitationStatus;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  expiresAt: string;
  expires_at: string;
  inviterName?: string;
  inviter_name?: string;
  inviterEmail?: string;
  inviter_email?: string;
  workspaceName?: string;
  workspace_name?: string;
}

export type MultiremiAccessTokenType = "pat" | "daemon" | "task";
export type MultiremiAccessTokenPurpose = "personal" | "session" | "cli" | "daemon" | "task";

export interface MultiremiAccessToken {
  id: string;
  workspaceId: string;
  daemonId: string | null;
  taskId: string | null;
  agentId: string | null;
  userId: string;
  name: string;
  type: MultiremiAccessTokenType;
  purpose: MultiremiAccessTokenPurpose;
  scopes?: string[];
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MultiremiCreatedAccessToken extends MultiremiAccessToken {
  token: string;
}

export interface CreateWorkspaceMemberInput {
  id?: string;
  workspaceId?: string | null;
  userId?: string | null;
  name: string;
  email?: string | null;
  role?: string;
}

export interface UpdateWorkspaceMemberInput {
  name?: string;
  email?: string | null;
  role?: string;
  workspaceId?: string | null;
}

export interface UpdateMultiremiUserInput {
  name?: string;
  email?: string;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  language?: string | null;
  profileDescription?: string | null;
  profile_description?: string | null;
  timezone?: string | null;
  onboardingQuestionnaire?: Record<string, unknown>;
  onboarding_questionnaire?: Record<string, unknown>;
  starterContentState?: string | null;
  starter_content_state?: string | null;
}

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  slug?: string;
  description?: string | null;
  context?: string | null;
  settings?: Record<string, unknown>;
  repos?: unknown[];
  issuePrefix?: string;
  issue_prefix?: string;
}

export interface CreateWorkspaceInvitationInput {
  email?: string;
  inviteeEmail?: string;
  invitee_email?: string;
  role?: string;
}

export interface CreateAccessTokenInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  daemonId?: string | null;
  daemon_id?: string | null;
  taskId?: string | null;
  task_id?: string | null;
  agentId?: string | null;
  agent_id?: string | null;
  name: string;
  type?: MultiremiAccessTokenType | string;
  purpose?: MultiremiAccessTokenPurpose | string;
  expiresInDays?: number | null;
  expires_in_days?: number | null;
  userId?: string | null;
  user_id?: string | null;
}

// ─── Notifications, subscriptions & feedback ─────────────────────────────────────────────────────

export type MultiremiSubscriptionReason = "created" | "assigned" | "commented" | "mentioned" | "manual";

export type MultiremiNotificationGroupKey =
  | "assignments"
  | "status_changes"
  | "comments"
  | "updates"
  | "feishu_messages"
  | "agent_activity"
  | "system_notifications";

export type MultiremiNotificationGroupValue = "all" | "muted";

export type MultiremiNotificationPreferences = Partial<Record<MultiremiNotificationGroupKey, MultiremiNotificationGroupValue>>;

export interface MultiremiNotificationPreferenceResponse {
  workspaceId: string;
  memberId: string | null;
  preferences: MultiremiNotificationPreferences;
  updatedAt: string | null;
}

export interface MultiremiFeedback {
  id: string;
  workspaceId: string;
  userId: string;
  memberId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateFeedbackInput {
  id?: string;
  message: string;
  url?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  userId?: string | null;
  user_id?: string | null;
  memberId?: string | null;
  member_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ─── Chat ────────────────────────────────────────────────────────────────────────────────────────

export type MultiremiChatSessionStatus = "active" | "archived";

export type MultiremiChatMessageRole = "user" | "assistant" | "system";

export interface MultiremiChatSession {
  id: string;
  workspaceId: string;
  creatorId: string | null;
  agentId: string;
  /** Optional Issue whose context is attached to tasks created from this Chat. */
  issueId: string | null;
  title: string;
  status: MultiremiChatSessionStatus;
  sessionId: string | null;
  workDir: string | null;
  /** Runtime that produced the promoted provider session (sessionId). */
  sessionRuntimeId: string | null;
  /** Engine that produced the promoted provider session — the sessionId is
   *  specific to it, so a follow-up only resumes when the agent's current
   *  provider still matches. */
  sessionProvider: string | null;
  /** Plugin execution fingerprint paired atomically with sessionId. */
  sessionExecutionFingerprint: string | null;
  latestTaskId: string | null;
  unreadSince: string | null;
  hasUnread: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiChatMessage {
  id: string;
  chatSessionId: string;
  taskId: string | null;
  role: MultiremiChatMessageRole;
  body: string;
  failureReason: string | null;
  elapsedMs: number | null;
  createdAt: string;
}

export interface CreateChatSessionInput {
  id?: string;
  agentId?: string;
  agent_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  creatorId?: string | null;
  creator_id?: string | null;
  issueId?: string | null;
  issue_id?: string | null;
  title?: string | null;
}

export interface UpdateChatSessionInput {
  title?: string;
  status?: MultiremiChatSessionStatus;
  issueId?: string | null;
  issue_id?: string | null;
}

export interface SendChatMessageInput {
  body?: string | null;
  content?: string | null;
  attachmentIds?: string[];
  attachment_ids?: string[];
  /** Server-internal creator lineage. */
  parentTaskId?: string | null;
  parent_task_id?: string | null;
}

export interface SendChatMessageResult {
  session: MultiremiChatSession;
  message: MultiremiChatMessage;
  task: MultiremiTask;
}

// ─── Source control connections & normalized events ─────────────────────────────────────────────

export type MultiremiScmProvider = "github" | "codebase";

export type MultiremiScmSyncMode = "poll" | "webhook" | "hybrid";

export type MultiremiScmSyncStream =
  | "default_branch"
  | "change_requests"
  | "comments"
  | "reviews"
  | "pipelines";

export type MultiremiScmEntityType =
  | "repository"
  | "change_request"
  | "comment"
  | "review"
  | "pipeline"
  | "ref";

export type MultiremiScmCanonicalEventType =
  | "change.opened"
  | "change.updated"
  | "change.closed"
  | "change.reopened"
  | "change.merged"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "review.submitted"
  | "review.dismissed"
  | "pipeline.started"
  | "pipeline.completed"
  | "default_branch.updated"
  | "push.observed";

export type MultiremiScmEventSource = "poll" | "webhook";

export type MultiremiScmEventFidelity = "exact" | "inferred";

export type MultiremiScmEventStatus = "pending" | "processing" | "processed" | "failed";

export type MultiremiScmEventDeliveryStatus = "pending" | "processing" | "delivered" | "failed" | "skipped";

export type MultiremiScmRepositoryScope = "all" | "selected";

export type MultiremiScmRepositoryAssignmentOrigin = "default" | "explicit";

export type MultiremiScmVerificationStatus =
  | "unverified"
  | "verifying"
  | "valid"
  | "partial"
  | "invalid"
  | "rate_limited"
  | "unreachable";

export interface MultiremiScmConnection {
  id: string;
  workspaceId: string;
  name: string;
  provider: MultiremiScmProvider;
  mode: MultiremiScmSyncMode;
  baseUrl: string;
  apiBaseUrl: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  repositoryScope: MultiremiScmRepositoryScope;
  isDefault: boolean;
  accessTokenSet: boolean;
  accessTokenHint: string | null;
  webhookSecretSet: boolean;
  webhookSecretHint: string | null;
  verificationStatus: MultiremiScmVerificationStatus;
  verifiedAt: string | null;
  verificationIdentity: string | null;
  verifiedRepositoryCount: number;
  verifiedRepositoryTotal: number;
  verificationErrorCode: string | null;
  verificationError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Server-only secret view. It must never be serialized by a browser API. */
export interface MultiremiScmConnectionCredential {
  accessToken: string | null;
  webhookSecret: string | null;
}

export interface CreateScmConnectionInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  provider: MultiremiScmProvider;
  mode?: MultiremiScmSyncMode;
  baseUrl?: string | null;
  base_url?: string | null;
  apiBaseUrl?: string | null;
  api_base_url?: string | null;
  accessToken?: string | null;
  access_token?: string | null;
  webhookSecret?: string | null;
  webhook_secret?: string | null;
  pollIntervalSeconds?: number;
  poll_interval_seconds?: number;
  enabled?: boolean;
  repositoryScope?: MultiremiScmRepositoryScope;
  repository_scope?: MultiremiScmRepositoryScope;
  repositoryIds?: string[];
  repository_ids?: string[];
}

export interface UpdateScmConnectionInput {
  name?: string;
  mode?: MultiremiScmSyncMode;
  baseUrl?: string | null;
  base_url?: string | null;
  apiBaseUrl?: string | null;
  api_base_url?: string | null;
  accessToken?: string | null;
  access_token?: string | null;
  clearAccessToken?: boolean;
  clear_access_token?: boolean;
  webhookSecret?: string | null;
  webhook_secret?: string | null;
  clearWebhookSecret?: boolean;
  clear_webhook_secret?: boolean;
  pollIntervalSeconds?: number;
  poll_interval_seconds?: number;
  enabled?: boolean;
  repositoryScope?: MultiremiScmRepositoryScope;
  repository_scope?: MultiremiScmRepositoryScope;
  /** When present for selected scope, atomically replaces the complete binding set. */
  repositoryIds?: string[];
  repository_ids?: string[];
}

export interface MultiremiScmRepositoryBinding {
  id: string;
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  repositoryUrl: string;
  externalId: string | null;
  owner: string | null;
  name: string;
  defaultBranch: string | null;
  enabled: boolean;
  assignmentOrigin: MultiremiScmRepositoryAssignmentOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertScmRepositoryBindingInput {
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  repositoryUrl: string;
  repositorySource?: MultiremiScmProvider | "unknown" | null;
  repository_source?: MultiremiScmProvider | "unknown" | null;
  externalId?: string | null;
  owner?: string | null;
  name: string;
  defaultBranch?: string | null;
  enabled?: boolean;
  assignmentOrigin?: MultiremiScmRepositoryAssignmentOrigin;
  assignment_origin?: MultiremiScmRepositoryAssignmentOrigin;
  transfer?: boolean;
}

export interface MultiremiScmVerificationResult {
  status: MultiremiScmVerificationStatus;
  verifiedAt: string;
  identity: string | null;
  repositoryCount: number;
  repositoryTotal: number;
  errorCode: string | null;
  error: string | null;
}

export interface MultiremiScmSyncCursor {
  connectionId: string;
  repositoryId: string;
  stream: MultiremiScmSyncStream;
  cursor: Record<string, unknown> | null;
  watermark: string | null;
  baselineCompletedAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  suspendedUntil: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
  updatedAt: string;
}

export interface UpsertScmSyncCursorInput {
  connectionId: string;
  repositoryId: string;
  stream: MultiremiScmSyncStream;
  cursor?: Record<string, unknown> | null;
  watermark?: string | null;
  baselineCompletedAt?: string | null;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  suspendedUntil?: string | null;
}

export interface ClaimScmSyncStreamInput {
  connectionId: string;
  repositoryId: string;
  stream: MultiremiScmSyncStream;
  owner: string;
  now?: string;
  leaseMs?: number;
}

export interface UpdateClaimedScmSyncCursorInput extends UpsertScmSyncCursorInput {
  leaseToken: string;
  leaseUntil?: string;
}

export interface ReleaseScmSyncStreamInput {
  connectionId: string;
  repositoryId: string;
  stream: MultiremiScmSyncStream;
  leaseToken: string;
}

export interface MultiremiScmEntitySnapshot {
  connectionId: string;
  repositoryId: string;
  entityType: MultiremiScmEntityType;
  externalId: string;
  version: string | null;
  /** Provider-derived timestamp used to reject stale hybrid observations. */
  revisionAt: string;
  /** Provider version (or a stable content fallback) used as a deterministic tie-breaker. */
  revision: string;
  contentHash: string;
  payload: Record<string, unknown>;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertScmEntitySnapshotInput {
  connectionId: string;
  repositoryId: string;
  entityType: MultiremiScmEntityType;
  externalId: string;
  version?: string | null;
  revisionAt?: string;
  revision?: string;
  contentHash: string;
  payload: Record<string, unknown>;
  observedAt?: string;
}

export interface AdvanceScmEntitySnapshotResult {
  applied: boolean;
  previous: MultiremiScmEntitySnapshot | null;
  snapshot: MultiremiScmEntitySnapshot;
}

export type MultiremiScmChangeRequestState = "open" | "closed" | "merged" | "draft";

/** Provider-neutral current-state projection used by issue surfaces. */
export interface MultiremiScmChangeRequest {
  id: string;
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  provider: MultiremiScmProvider;
  externalId: string;
  number: number | null;
  title: string;
  body: string | null;
  state: MultiremiScmChangeRequestState;
  draft: boolean;
  url: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  headSha: string | null;
  baseSha: string | null;
  author: string | null;
  providerCreatedAt: string | null;
  providerUpdatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  mergeSha: string | null;
  mergeableState: string | null;
  checksConclusion: string | null;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
}

/** Change request joined with its repository binding identity, so multi-repo issue surfaces can label the source repo. */
export interface MultiremiScmChangeRequestWithRepository extends MultiremiScmChangeRequest {
  repositoryName: string | null;
  repositoryOwner: string | null;
  repositoryUrl: string | null;
}

export type MultiremiScmIssueLinkSource = "auto" | "manual" | "legacy";

export interface MultiremiScmIssueLink {
  id: string;
  workspaceId: string;
  changeRequestId: string;
  issueId: string;
  source: MultiremiScmIssueLinkSource;
  active: boolean;
  linkedAt: string;
  unlinkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiScmCanonicalEvent {
  id: string;
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  provider: MultiremiScmProvider;
  type: MultiremiScmCanonicalEventType;
  subjectType: string;
  subjectId: string;
  logicalKey: string;
  primarySource: MultiremiScmEventSource;
  fidelity: MultiremiScmEventFidelity;
  occurredAt: string | null;
  observedAt: string;
  payload: Record<string, unknown>;
  status: MultiremiScmEventStatus;
  attemptCount: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface MultiremiScmEventEvidence {
  id: string;
  eventId: string;
  source: MultiremiScmEventSource;
  providerEventId: string | null;
  dedupeKey: string;
  payload: Record<string, unknown> | null;
  rawBody: string | null;
  observedAt: string;
  createdAt: string;
}

export interface RecordScmCanonicalEventInput {
  workspaceId: string;
  connectionId: string;
  repositoryId: string;
  type: MultiremiScmCanonicalEventType;
  subjectType: string;
  subjectId: string;
  logicalKey: string;
  fidelity: MultiremiScmEventFidelity;
  occurredAt?: string | null;
  observedAt?: string;
  payload: Record<string, unknown>;
  evidence: {
    source: MultiremiScmEventSource;
    providerEventId?: string | null;
    dedupeKey: string;
    payload?: Record<string, unknown> | null;
    rawBody?: string | null;
  };
}

export interface MultiremiScmEventDelivery {
  id: string;
  eventId: string;
  triggerId: string;
  autopilotRunId: string | null;
  status: MultiremiScmEventDeliveryStatus;
  attemptCount: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────────────────────────

export type MultiremiWebhookProvider = "generic" | "github" | "codebase";

export type MultiremiWebhookSignatureStatus = "not_required" | "valid" | "invalid" | "missing";

export type MultiremiWebhookDeliveryStatus = "queued" | "dispatched" | "rejected" | "ignored" | "failed";

export type MultiremiWebhookDeliveryResultStatus = "accepted" | "duplicate" | "rejected" | "ignored" | "failed" | "skipped";

export interface MultiremiWebhookEventFilter {
  event: string;
  actions?: string[];
}

export interface MultiremiWebhookDelivery {
  id: string;
  workspaceId: string;
  autopilotId: string;
  triggerId: string;
  provider: MultiremiWebhookProvider;
  event: string;
  dedupeKey: string | null;
  dedupeSource: string | null;
  signatureStatus: MultiremiWebhookSignatureStatus;
  status: MultiremiWebhookDeliveryStatus;
  attemptCount: number;
  selectedHeaders: Record<string, unknown>;
  contentType: string | null;
  rawBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  autopilotRunId: string | null;
  replayedFromDeliveryId: string | null;
  error: string | null;
  receivedAt: string;
  lastAttemptAt: string;
  createdAt: string;
}

export interface MultiremiWebhookDeliveryResult {
  status: MultiremiWebhookDeliveryResultStatus;
  duplicate: boolean;
  delivery: MultiremiWebhookDelivery;
  run: MultiremiAutopilotRun | null;
}

// ─── Usage, analytics & metrics ──────────────────────────────────────────────────────────────────

export type MultiremiAnalyticsEventName =
  | "runtime_registered"
  | "runtime_ready"
  | "runtime_failed"
  | "runtime_offline"
  | "autopilot_created"
  | "autopilot_run_started"
  | "autopilot_run_completed"
  | "autopilot_run_failed"
  | string;

export interface MultiremiRuntimeUsage {
  runtimeId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MultiremiUsageDaily {
  date: string;
  runtimeId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Pre-0.2.49 ACP bridges only reported the context-occupancy total, so
  // historical rows carry totalTokens with zero splits; keep it in the
  // aggregate so that history is not silently erased.
  totalTokens: number;
  taskCount: number;
}

export interface MultiremiUsageByAgent {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  taskCount: number;
}

export interface MultiremiUsageByHour {
  hour: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MultiremiRuntimeDaily {
  date: string;
  totalSeconds: number;
  taskCount: number;
  failedCount: number;
}

/** Per-agent run-time rollup for the dashboard leaderboard (`/api/dashboard/agent-runtime`). */
export interface MultiremiAgentRuntime {
  agentId: string;
  totalSeconds: number;
  taskCount: number;
  failedCount: number;
}

export interface MultiremiTaskActivityByHour {
  hour: number;
  count: number;
}

export interface MultiremiAgentRunCount {
  agentId: string;
  agent_id?: string;
  runCount: number;
  run_count?: number;
}

export interface MultiremiAgentActivityBucket {
  agentId: string;
  agent_id?: string;
  bucketAt: string;
  bucket_at?: string;
  taskCount: number;
  task_count?: number;
  failedCount: number;
  failed_count?: number;
}

// ─── Platform lifecycle ─────────────────────────────────────────────────────

export type MultiremiPlatformDeploymentDriver = "systemd_release" | "docker_compose";

export type MultiremiPlatformOperationKind =
  | "check_updates"
  | "restart"
  | "update"
  | "rollback";

export type MultiremiPlatformOperationStatus =
  | "queued"
  | "preparing"
  | "pulling"
  | "draining"
  | "switching"
  | "restarting"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolling_back"
  | "rolled_back";

export type MultiremiPlatformMaintenanceMode = "normal" | "draining";

/** Persistent platform maintenance (drain) state — one row, survives API restarts. */
export interface MultiremiPlatformMaintenance {
  mode: MultiremiPlatformMaintenanceMode;
  generation: number;
  operationId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  reason: string | null;
}

/** Aggregated drain progress used by the updater wait loop and the dashboard. */
export interface MultiremiPlatformDrainStatus {
  maintenance: MultiremiPlatformMaintenance;
  onlineDaemons: number;
  ackedDaemons: number;
  /** Server-authoritative count of in-flight tasks (dispatched/running/waiting/awaiting). */
  activeTasks: number;
  /** Online runtimes that have not acknowledged the current generation. */
  pendingRuntimes: Array<{ id: string; name: string; daemonId: string | null }>;
  /** All online daemons acked the current generation and no task is in flight. */
  ready: boolean;
}

export type MultiremiPlatformServiceId =
  | "api"
  | "web"
  | "ssh-mesh-control-plane"
  | "postgres"
  | "openviking";
export type MultiremiPlatformServiceStatus = "ready" | "degraded" | "stopped" | "unknown";

export interface MultiremiPlatformService {
  id: MultiremiPlatformServiceId;
  name: string;
  status: MultiremiPlatformServiceStatus;
  detail: string | null;
  version: string | null;
  checkedAt: string | null;
}

export interface MultiremiPlatformRelease {
  version: string;
  ref: string;
  publishedAt: string | null;
  releaseUrl: string | null;
  manifestUrl: string | null;
  apiImage: string | null;
  webImage: string | null;
}

export interface MultiremiPlatformOperation {
  id: string;
  kind: MultiremiPlatformOperationKind;
  status: MultiremiPlatformOperationStatus;
  driver: MultiremiPlatformDeploymentDriver;
  targetVersion: string | null;
  targetRef: string | null;
  targetManifest: Record<string, unknown>;
  progress: Record<string, unknown>;
  requestedBy: string;
  output: string | null;
  error: string | null;
  previousRelease: MultiremiPlatformRelease | null;
  resultRelease: MultiremiPlatformRelease | null;
  /** Set by the cancel endpoint; the updater honors it before the switch phase. */
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type MultiremiPlatformAutoUpdateResult =
  | "checking"
  | "update_queued"
  | "no_update"
  | "busy"
  | "blocked"
  | "updated"
  | "failed";

export interface MultiremiPlatformAutoUpdateSchedule {
  enabled: boolean;
  /** Daily wall-clock time in HH:mm format. */
  time: string;
  /** IANA time zone used to interpret `time`. */
  timezone: string;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastResult: MultiremiPlatformAutoUpdateResult | null;
}

export interface MultiremiPlatformStatus {
  canManage: boolean;
  driver: MultiremiPlatformDeploymentDriver;
  currentRelease: MultiremiPlatformRelease | null;
  latestRelease: MultiremiPlatformRelease | null;
  updateAvailable: boolean;
  /** Backward-compatible alias for autoUpdateSchedule.enabled. */
  autoUpdateStable: boolean;
  autoUpdateSchedule: MultiremiPlatformAutoUpdateSchedule;
  updaterStatus: "ready" | "stale" | "offline";
  updaterHeartbeatAt: string | null;
  services: MultiremiPlatformService[];
  activeOperation: MultiremiPlatformOperation | null;
  /** Most recent operation (may equal activeOperation); shows terminal outcomes after the banner clears. */
  lastOperation: MultiremiPlatformOperation | null;
  maintenance: MultiremiPlatformMaintenance;
  recentReleases: MultiremiPlatformRelease[];
}

export interface CreatePlatformOperationInput {
  kind: MultiremiPlatformOperationKind;
  targetVersion?: string | null;
  targetRef?: string | null;
  targetManifest?: Record<string, unknown>;
}

export interface ReportPlatformOperationInput {
  status: MultiremiPlatformOperationStatus;
  progress?: Record<string, unknown>;
  output?: string | null;
  error?: string | null;
  previousRelease?: MultiremiPlatformRelease | null;
  resultRelease?: MultiremiPlatformRelease | null;
}

export interface MultiremiAnalyticsEvent {
  id: string;
  name: MultiremiAnalyticsEventName;
  distinctId: string;
  workspaceId: string | null;
  properties: Record<string, unknown>;
  metricsOnly: boolean;
  createdAt: string;
}

export interface MultiremiMetricCounter {
  name: string;
  labels: Record<string, string>;
  value: number;
}
