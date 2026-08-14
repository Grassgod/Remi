import type {
  CreateAgentPluginBindingInput as ContractCreateAgentPluginBindingInput,
  CreateAgentPluginVersionInput as ContractCreateAgentPluginVersionInput,
  ImportAgentPluginFromGitInput as ContractImportAgentPluginFromGitInput,
  ImportAgentPluginInput as ContractImportAgentPluginInput,
  ImportAgentPluginRequest as ContractImportAgentPluginRequest,
  InspectAgentPluginRepositoryInput as ContractInspectAgentPluginRepositoryInput,
  MultiremiAgentPlugin as ContractAgentPlugin,
  MultiremiAgentPluginArtifactFile as ContractAgentPluginArtifactFile,
  MultiremiAgentPluginBinding as ContractAgentPluginBinding,
  MultiremiAgentPluginDesiredReason as ContractAgentPluginDesiredReason,
  MultiremiAgentPluginProvider as ContractAgentPluginProvider,
  MultiremiAgentPluginRepositoryCandidate as ContractAgentPluginRepositoryCandidate,
  MultiremiAgentPluginRepositoryInspection as ContractAgentPluginRepositoryInspection,
  MultiremiAgentPluginRuntimeState as ContractAgentPluginRuntimeState,
  MultiremiAgentPluginRuntimeStatus as ContractAgentPluginRuntimeStatus,
  MultiremiAgentPluginRuntimeSummary as ContractAgentPluginRuntimeSummary,
  MultiremiAgentPluginSourceType as ContractAgentPluginSourceType,
  MultiremiAgentPluginVersion as ContractAgentPluginVersion,
  MultiremiAgentPluginVersionPolicy as ContractAgentPluginVersionPolicy,
  UpdateAgentPluginBindingInput as ContractUpdateAgentPluginBindingInput,
} from "@multiremi/contracts";

export const AGENT_PLUGINS_API_BASE = "/api/multiremi/agent-plugins";

export type AgentPluginProvider = ContractAgentPluginProvider;
export type AgentPluginSourceType = ContractAgentPluginSourceType;
export type AgentPluginVersionPolicy = ContractAgentPluginVersionPolicy;
export type AgentPluginRuntimeStatus = ContractAgentPluginRuntimeStatus;
export type AgentPluginDesiredReason = ContractAgentPluginDesiredReason;
export type AgentPluginArtifactFile = ContractAgentPluginArtifactFile;
export type AgentPluginVersion = ContractAgentPluginVersion;
export type AgentPluginRuntimeSummary = ContractAgentPluginRuntimeSummary;
export type AgentPlugin = ContractAgentPlugin;
export type AgentPluginBinding = ContractAgentPluginBinding;
export type AgentPluginRuntimeState = ContractAgentPluginRuntimeState;
export type ImportAgentPluginInput = ContractImportAgentPluginInput;
export type ImportAgentPluginFromGitInput = ContractImportAgentPluginFromGitInput;
export type ImportAgentPluginRequest = ContractImportAgentPluginRequest;
export type InspectAgentPluginRepositoryInput =
  ContractInspectAgentPluginRepositoryInput;
export type AgentPluginRepositoryCandidate =
  ContractAgentPluginRepositoryCandidate;
export type AgentPluginRepositoryInspection =
  ContractAgentPluginRepositoryInspection;
export type CreateAgentPluginVersionInput =
  ContractCreateAgentPluginVersionInput;
export type CreateAgentPluginBindingInput =
  ContractCreateAgentPluginBindingInput;
export type UpdateAgentPluginBindingInput =
  ContractUpdateAgentPluginBindingInput;

export interface CreateAgentPluginVersionResult {
  plugin: AgentPlugin;
  version: AgentPluginVersion;
}

export interface RetryAgentPluginRuntimeInput {
  runtimeId: string;
  versionId?: string;
}

export type AgentPluginReadiness =
  | "ready"
  | "partial"
  | "checking"
  | "setup_required"
  | "incompatible"
  | "error"
  | "unknown";

export interface AgentPluginReadinessSummary {
  status: AgentPluginReadiness;
  total: number;
  ready: number;
  checking: number;
  setupRequired: number;
  blocked: number;
  unknown: number;
}

/** Minimal runtime-state shape accepted by the pure readiness helpers. */
export interface AgentPluginReadinessState {
  status: string;
  desired?: boolean;
  lastErrorCode?: string | null;
}
