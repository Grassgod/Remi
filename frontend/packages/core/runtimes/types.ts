// Derived "health" type for runtimes — the user-facing state we display
// in lists, cards, and tooltips. The raw server field is binary (online /
// offline + last_seen_at); this enum splits the offline state into three
// time-bucketed flavors so users can tell "just lost" from "long gone".

export type RuntimeHealth =
  | "online" // green — within heartbeat threshold
  | "recently_lost" // amber — offline < 5 minutes (likely transient)
  | "offline" // grey — offline 5 minutes ~ 7 days
  | "about_to_gc"; // dim — within 1 day of the 7-day GC threshold

export interface DaemonInventoryEntry {
  daemon_id: string;
  runtime_count: number;
  token_count: number;
  last_seen: string | null;
  name: string | null;
}

export interface DaemonInventoryResponse {
  workspace_id: string;
  daemons: DaemonInventoryEntry[];
}

export type RuntimeProvisionKind = "npm-global" | "command";
export type RuntimeProvisionTriggerKind = "cron" | "on_register" | "on_change";
export type RuntimeProvisionStatus = "pending" | "converged" | "drifted" | "failed";

export interface RuntimeProvision {
  id: string;
  workspace_id: string;
  kind: string;
  enabled: boolean;
  package: string | null;
  version: string | null;
  version_check: boolean;
  bin: string | null;
  registry: string | null;
  /** Redacted command returned by the server; the raw command never crosses this boundary. */
  command: string | null;
  /** Redacted arguments returned by the server. */
  args: string[];
  trigger_kinds: string[];
  cron_expression: string | null;
  timezone: string | null;
  next_run_at: string | null;
  last_fired_at: string | null;
  timeout_ms: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeProvisionState {
  provision_id: string;
  runtime_id: string;
  status: string;
  observed_version: string | null;
  last_command_request_id: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeProvisionInput {
  kind?: RuntimeProvisionKind;
  enabled?: boolean;
  package?: string | null;
  version?: string | null;
  version_check?: boolean;
  bin?: string | null;
  registry?: string | null;
  command?: string | null;
  args?: string[];
  trigger_kinds?: RuntimeProvisionTriggerKind[];
  cron_expression?: string | null;
  timezone?: string | null;
  timeout_ms?: number;
}

export interface RuntimeProvisionListResponse {
  provisions: RuntimeProvision[];
}

export interface RuntimeProvisionResponse {
  provision: RuntimeProvision;
}

export interface RuntimeProvisionStatesResponse {
  states: RuntimeProvisionState[];
}

export interface DaemonRetirementRuntime {
  id: string;
  name: string;
  provider: string;
  status: string;
}

export interface DaemonRetirementAgent {
  id: string;
  name: string;
  provider: string;
  runtime_id: string;
}

export interface DaemonRetirementTask {
  id: string;
  status: string;
  agent_id: string;
  runtime_id: string;
  issue_id: string | null;
}

export interface DaemonRetirementLocalDirectory {
  id: string;
  project_id: string;
  project_title: string;
  label: string | null;
  local_path: string;
}

export interface DaemonRetirementIssueWorkspace {
  issue_id: string;
  status: string;
  runtime_id: string;
  root_path: string;
}

export interface DaemonRetirementImpact {
  runtimes_removed: number;
  agents_detached: number;
  queued_tasks_requeued: number;
  session_lanes_reset: number;
  chat_sessions_reset: number;
  issue_workspaces_abandoned: number;
  tokens_revoked: number;
}

export interface DaemonRetirementPlan {
  workspace_id: string;
  daemon_id: string;
  snapshot: string;
  already_retired: boolean;
  can_retire: boolean;
  can_abandon_issue_workspaces: boolean;
  blocking_reasons: string[];
  runtimes: DaemonRetirementRuntime[];
  agents: DaemonRetirementAgent[];
  active_tasks: DaemonRetirementTask[];
  queued_tasks: DaemonRetirementTask[];
  local_directory_resources: DaemonRetirementLocalDirectory[];
  issue_workspaces: DaemonRetirementIssueWorkspace[];
  impact: DaemonRetirementImpact;
}

export interface DaemonRetirementPlanResponse {
  plan: DaemonRetirementPlan;
}

export interface RetireDaemonResponse {
  status: "retired" | "";
  workspace_id: string;
  daemon_id: string;
  retired_at: string;
  already_retired: boolean;
  impact: DaemonRetirementImpact;
}

export type SshMeshRuntimeStatus =
  | "disabled"
  | "syncing"
  | "ready"
  | "setup_required"
  | "blocked"
  | "error"
  | "offline"
  | (string & {});

export type SshMeshPeerStatus =
  | "ready"
  | "unreachable"
  | "host_key_mismatch"
  | "auth_failed"
  | "error"
  | (string & {});

export type SshMeshNodeType =
  | "runtime"
  | "control_plane"
  | (string & {});

export interface SshMeshPeerTest {
  node_id: string;
  daemon_id: string;
  status: SshMeshPeerStatus;
  latency_ms: number | null;
  error_code: string | null;
  error: string | null;
  checked_at: string | null;
}

export interface SshMeshRuntime {
  node_id: string;
  node_type: SshMeshNodeType;
  daemon_id: string;
  runtime_ids: string[];
  name: string | null;
  status: SshMeshRuntimeStatus;
  protocol_version: number;
  key_version: number | null;
  config_revision: string | null;
  desired_config_revision: string;
  ssh_user: string | null;
  ssh_alias: string | null;
  hostname: string | null;
  port: number;
  addresses: string[];
  host_keys: string[];
  public_key_installed: boolean;
  config_installed: boolean;
  last_error_code: string | null;
  last_error: string | null;
  last_reported_at: string | null;
  probe_revision: number;
  desired_probe_revision: number;
  peer_tests: SshMeshPeerTest[];
}

export interface SshMeshOverview {
  workspace_id: string;
  enabled: boolean;
  key_version: number;
  fingerprint: string | null;
  rotation_state: "stable" | "rolling_out" | (string & {});
  config_revision: string;
  rotation_ready_daemons: number;
  rotation_total_daemons: number;
  rotation_ready_nodes: number;
  rotation_total_nodes: number;
  created_at: string | null;
  updated_at: string | null;
  nodes: SshMeshRuntime[];
  runtimes: SshMeshRuntime[];
}

export interface SshMeshTestResponse {
  request_id: string;
  probe_revision: number;
  status: "pending" | (string & {});
}
