import { z } from "zod";
import type {
  FleetModelsResponse,
  RuntimeDirectoryScanRequest,
} from "../../types";
import type {
  DaemonInventoryResponse,
  DaemonRetirementPlanResponse,
  RetireDaemonResponse,
  RuntimeProvision,
  RuntimeProvisionListResponse,
  RuntimeProvisionResponse,
  RuntimeProvisionState,
  RuntimeProvisionStatesResponse,
  SshMeshOverview,
  SshMeshTestResponse,
} from "../../runtimes/types";
import type { CloudRuntimeNode } from "../../runtimes/cloud-runtime";

export const CloudRuntimeNodeSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  instance_id: z.string(),
  region: z.string(),
  instance_type: z.string(),
  image_id: z.string(),
  subnet_id: z.string(),
  name: z.string(),
  status: z.string(),
  tags: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const CloudRuntimeNodeListSchema = z.array(CloudRuntimeNodeSchema);

export const EMPTY_CLOUD_RUNTIME_NODE_LIST: CloudRuntimeNode[] = [];

export const EMPTY_CLOUD_RUNTIME_NODE: CloudRuntimeNode = {
  id: "",
  owner_id: "",
  instance_id: "",
  region: "",
  instance_type: "",
  image_id: "",
  subnet_id: "",
  name: "",
  status: "",
  tags: {},
  metadata: {},
  created_at: "",
  updated_at: "",
};

const RuntimeProvisionSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  kind: z.string(),
  enabled: z.boolean(),
  package: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  version_check: z.boolean().default(true),
  bin: z.string().nullable().default(null),
  registry: z.string().nullable().default(null),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  trigger_kinds: z.array(z.string()).default([]),
  cron_expression: z.string().nullable().default(null),
  timezone: z.string().nullable().default(null),
  next_run_at: z.string().nullable().default(null),
  last_fired_at: z.string().nullable().default(null),
  timeout_ms: z.number().default(0),
  created_by: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

const RuntimeProvisionStateSchema = z.object({
  provision_id: z.string(),
  runtime_id: z.string(),
  status: z.string(),
  observed_version: z.string().nullable().default(null),
  last_command_request_id: z.string().nullable().default(null),
  last_checked_at: z.string().nullable().default(null),
  last_error: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const RuntimeProvisionListResponseSchema = z.object({
  provisions: z.array(RuntimeProvisionSchema).default([]),
}).loose();

export const RuntimeProvisionResponseSchema = z.object({
  provision: RuntimeProvisionSchema,
}).loose();

export const RuntimeProvisionStatesResponseSchema = z.object({
  states: z.array(RuntimeProvisionStateSchema).default([]),
}).loose();

export const EMPTY_RUNTIME_PROVISION_LIST: RuntimeProvisionListResponse = { provisions: [] };
export const EMPTY_RUNTIME_PROVISION_STATES: RuntimeProvisionStatesResponse = { states: [] };
export const EMPTY_RUNTIME_PROVISION: RuntimeProvision = {
  id: "",
  workspace_id: "",
  kind: "unknown",
  enabled: false,
  package: null,
  version: null,
  version_check: true,
  bin: null,
  registry: null,
  command: null,
  args: [],
  trigger_kinds: [],
  cron_expression: null,
  timezone: null,
  next_run_at: null,
  last_fired_at: null,
  timeout_ms: 0,
  created_by: null,
  created_at: "",
  updated_at: "",
};
export const EMPTY_RUNTIME_PROVISION_STATE: RuntimeProvisionState = {
  provision_id: "",
  runtime_id: "",
  status: "unknown",
  observed_version: null,
  last_command_request_id: null,
  last_checked_at: null,
  last_error: null,
  created_at: "",
  updated_at: "",
};
export const EMPTY_RUNTIME_PROVISION_RESPONSE: RuntimeProvisionResponse = {
  provision: EMPTY_RUNTIME_PROVISION,
};

// Fleet model catalog (`GET /api/models`) — feeds the machine-less create
// flow's engine toggle + model dropdown. Lenient by design: an unknown
// provider or a malformed model row must degrade to "engine with no
// catalog", never crash the create dialog.
const FleetProviderModelsSchema = z.object({
  provider: z.string(),
  online_runtime_count: z.number().default(0),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string().default(""),
      provider: z.string().optional(),
      default: z.boolean().optional(),
    }).loose(),
  ).default([]),
}).loose();

export const FleetModelsResponseSchema = z.object({
  providers: z.array(FleetProviderModelsSchema).default([]),
}).loose();

export const EMPTY_FLEET_MODELS: FleetModelsResponse = { providers: [] };

// ---------------------------------------------------------------------------
// Model gateway (relay config) schemas
// ---------------------------------------------------------------------------

const RelayEngineConfigSchema = z.object({
  fragment: z.string().default(""),
  hasToken: z.boolean().default(false),
  revision: z.number().default(0),
}).loose().nullable();

export const RelayConfigResponseSchema = z.object({
  claude: RelayEngineConfigSchema.default(null),
  codex: RelayEngineConfigSchema.default(null),
  modelDiscovery: z.boolean().default(false),
}).loose();

export type RelayConfigResponse = z.infer<typeof RelayConfigResponseSchema>;

export type RelayEngineConfig = z.infer<typeof RelayEngineConfigSchema>;

export const EMPTY_RELAY_CONFIG: RelayConfigResponse = { claude: null, codex: null, modelDiscovery: false };

// ---------------------------------------------------------------------------
// Runtime usage schemas — the runtime-detail page's four usage endpoints
// (`/api/runtimes/:id/usage*`).
//
// The token-bearing rollups (usage, usage/by-agent) are STRICT, matching
// the dashboard schemas (MUL-93): a row missing a numeric field means the
// wire contract drifted, and defaulting it to 0 used to render fabricated
// zeros as confirmed measurements. Their endpoints parse with
// `parseStrictResponse` so drift raises ApiContractError → `isError` →
// an explicit unavailable state with retry.
//
// The hour-of-day rollups (activity, usage/by-hour) stay lenient for now —
// they feed density visualizations where a degraded bucket is preferable
// to dropping the whole chart, and no KPI derives a dollar/token figure
// from them.
// ---------------------------------------------------------------------------

const RuntimeUsageSchema = z.object({
  runtime_id: z.string(),
  date: z.string(),
  provider: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
}).loose();

export const RuntimeUsageListSchema = z.array(RuntimeUsageSchema);

const RuntimeHourlyActivitySchema = z.object({
  hour: z.number().default(0),
  count: z.number().default(0),
}).loose();

export const RuntimeHourlyActivityListSchema = z.array(RuntimeHourlyActivitySchema);

const RuntimeUsageByAgentSchema = z.object({
  agent_id: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  task_count: z.number(),
}).loose();

export const RuntimeUsageByAgentListSchema = z.array(RuntimeUsageByAgentSchema);

const RuntimeUsageByHourSchema = z.object({
  hour: z.number().default(0),
  model: z.string().default(""),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
  cache_write_tokens: z.number().default(0),
  task_count: z.number().default(0),
}).loose();

export const RuntimeUsageByHourListSchema = z.array(RuntimeUsageByHourSchema);

export const CliLatestVersionResponseSchema = z
  .object({
    version: z.string().nullable(),
  })
  .loose();

export type CliLatestVersionResponse = z.infer<typeof CliLatestVersionResponseSchema>;

export const EMPTY_CLI_LATEST_VERSION: CliLatestVersionResponse = {
  version: null,
};

// ---------------------------------------------------------------------------
// Runtime directory scan — `POST/GET /api/runtimes/:id/directory-scans`. The
// daemon walks a directory tree for git repos while the UI polls the request
// row until it terminates. Lenient by the same rules as the other request
// schemas: `status` stays `z.string()` so an unknown terminal state degrades
// instead of crashing the poll loop, `candidates` defaults to `[]`, and the
// per-candidate metadata fields tolerate null/absent.
// ---------------------------------------------------------------------------

const RuntimeDirectoryCandidateSchema = z.object({
  path: z.string(),
  name: z.string().default(""),
  remote_url: z.string().nullable().default(null),
  current_branch: z.string().nullable().default(null),
  is_dirty: z.boolean().nullable().default(null),
  // Present in browse-mode responses; absent/null for scan-mode candidates.
  is_git_repo: z.boolean().nullable().optional(),
}).loose();

export const RuntimeDirectoryScanRequestSchema = z.object({
  id: z.string(),
  runtime_id: z.string().default(""),
  status: z.string(),
  params: z.object({
    root: z.string().optional(),
    max_depth: z.number().optional(),
    // Browse mode echoes the expanded absolute root for the folder-picker.
    resolved_root: z.string().optional(),
  }).loose().default({}),
  candidates: z.array(RuntimeDirectoryCandidateSchema).default([]),
  supported: z.boolean().default(true),
  error: z.string().nullable().default(null),
  run_started_at: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

// Fallback for a malformed scan response. `status: "failed"` makes the poll
// loop terminate immediately (rather than spin) and surfaces a generic error
// to the caller instead of pretending the scan succeeded with no candidates.
export const EMPTY_RUNTIME_DIRECTORY_SCAN_REQUEST: RuntimeDirectoryScanRequest = {
  id: "",
  runtime_id: "",
  status: "failed",
  params: {},
  candidates: [],
  supported: true,
  error: null,
  run_started_at: null,
  created_at: "",
  updated_at: "",
};

// ---------------------------------------------------------------------------
// Daemon inventory — workspace-wide for managers and owner-scoped for regular
// members, including daemons that have a provisioned token but no registered
// runtime. This schema intentionally has no field defaults: partial or
// type-invalid inventory must fail closed rather than inventing a manageable
// machine.
// ---------------------------------------------------------------------------

const DaemonInventoryEntrySchema = z
  .object({
    daemon_id: z.string().min(1),
    runtime_count: z.number().int().nonnegative(),
    token_count: z.number().int().nonnegative(),
    last_seen: z.string().min(1).nullable(),
    name: z.string().min(1).nullable(),
  })
  .loose();

export const DaemonInventoryResponseSchema = z
  .object({
    workspace_id: z.string().min(1),
    daemons: z.array(DaemonInventoryEntrySchema),
  })
  .loose();

export const EMPTY_DAEMON_INVENTORY_RESPONSE: DaemonInventoryResponse = {
  workspace_id: "",
  daemons: [],
};

// ---------------------------------------------------------------------------
// Daemon retirement — machine-level impact preview and execution result.
// Fallbacks always fail closed: a malformed preview cannot enable the
// destructive action, and an unreadable execution response cannot claim that
// the daemon was retired.
// ---------------------------------------------------------------------------

const DaemonRetirementImpactSchema = z
  .object({
    runtimes_removed: z.number().int().nonnegative(),
    agents_detached: z.number().int().nonnegative(),
    queued_tasks_requeued: z.number().int().nonnegative(),
    session_lanes_reset: z.number().int().nonnegative(),
    chat_sessions_reset: z.number().int().nonnegative(),
    issue_workspaces_abandoned: z.number().int().nonnegative().default(0),
    tokens_revoked: z.number().int().nonnegative(),
  })
  .loose();

const DaemonRetirementTaskSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    agent_id: z.string().min(1),
    runtime_id: z.string().min(1),
    issue_id: z.string().min(1).nullable(),
  })
  .loose();

export const DaemonRetirementPlanSchema = z
  .object({
    workspace_id: z.string().min(1),
    daemon_id: z.string().min(1),
    snapshot: z.string().min(1),
    already_retired: z.boolean(),
    can_retire: z.boolean(),
    can_abandon_issue_workspaces: z.boolean().default(false),
    blocking_reasons: z.array(z.string()),
    runtimes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            provider: z.string().min(1),
            status: z.string().min(1),
          })
          .loose(),
      ),
    agents: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            provider: z.string().min(1),
            runtime_id: z.string().min(1),
          })
          .loose(),
      ),
    active_tasks: z.array(DaemonRetirementTaskSchema),
    queued_tasks: z.array(DaemonRetirementTaskSchema),
    local_directory_resources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            project_id: z.string().min(1),
            project_title: z.string(),
            label: z.string().nullable(),
            local_path: z.string(),
          })
          .loose(),
      ),
    issue_workspaces: z
      .array(
        z
          .object({
            issue_id: z.string().min(1),
            status: z.string().min(1),
            runtime_id: z.string().min(1),
            root_path: z.string(),
          })
          .loose(),
      ),
    impact: DaemonRetirementImpactSchema,
  })
  .loose();

export const DaemonRetirementPlanResponseSchema = z
  .object({ plan: DaemonRetirementPlanSchema })
  .loose();

export const EMPTY_DAEMON_RETIREMENT_PLAN_RESPONSE: DaemonRetirementPlanResponse = {
  plan: {
    workspace_id: "",
    daemon_id: "",
    snapshot: "",
    already_retired: false,
    can_retire: false,
    can_abandon_issue_workspaces: false,
    blocking_reasons: ["invalid_response"],
    runtimes: [],
    agents: [],
    active_tasks: [],
    queued_tasks: [],
    local_directory_resources: [],
    issue_workspaces: [],
    impact: {
      runtimes_removed: 0,
      agents_detached: 0,
      queued_tasks_requeued: 0,
      session_lanes_reset: 0,
      chat_sessions_reset: 0,
      issue_workspaces_abandoned: 0,
      tokens_revoked: 0,
    },
  },
};

export const RetireDaemonResponseSchema = z
  .object({
    status: z.literal("retired"),
    workspace_id: z.string().min(1),
    daemon_id: z.string().min(1),
    retired_at: z.string().min(1),
    already_retired: z.boolean(),
    impact: DaemonRetirementImpactSchema,
  })
  .loose();

export const EMPTY_RETIRE_DAEMON_RESPONSE: RetireDaemonResponse = {
  status: "",
  workspace_id: "",
  daemon_id: "",
  retired_at: "",
  already_retired: false,
  impact: {
    runtimes_removed: 0,
    agents_detached: 0,
    queued_tasks_requeued: 0,
    session_lanes_reset: 0,
    chat_sessions_reset: 0,
    issue_workspaces_abandoned: 0,
    tokens_revoked: 0,
  },
};

// ---------------------------------------------------------------------------
// Workspace SSH mesh — browser-safe control-plane projection. The private key
// is deliberately absent from both the schema and the inferred frontend type.
// Unknown status strings are retained so newer servers degrade to a neutral
// label instead of breaking an older desktop build.
// ---------------------------------------------------------------------------

const SshMeshPeerTestSchema = z
  .object({
    node_id: z.string().min(1).optional(),
    daemon_id: z.string().min(1),
    status: z.string().default("error"),
    latency_ms: z.number().nonnegative().nullable().default(null),
    error_code: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    checked_at: z.string().nullable().default(null),
  })
  .transform((peer) => ({
    ...peer,
    node_id: peer.node_id ?? peer.daemon_id,
  }));

const SshMeshRuntimeSchema = z
  .object({
    node_id: z.string().min(1).optional(),
    node_type: z.string().default("runtime"),
    daemon_id: z.string().min(1),
    runtime_ids: z.array(z.string()).default([]),
    name: z.string().nullable().default(null),
    status: z.string().default("offline"),
    protocol_version: z.number().int().nonnegative().default(0),
    key_version: z.number().int().nonnegative().nullable().default(null),
    config_revision: z.string().nullable().default(null),
    desired_config_revision: z.string().default(""),
    ssh_user: z.string().nullable().default(null),
    ssh_alias: z.string().nullable().default(null),
    hostname: z.string().nullable().default(null),
    port: z.number().int().positive().default(22),
    addresses: z.array(z.string()).default([]),
    host_keys: z.array(z.string()).default([]),
    public_key_installed: z.boolean().default(false),
    config_installed: z.boolean().default(false),
    last_error_code: z.string().nullable().default(null),
    last_error: z.string().nullable().default(null),
    last_reported_at: z.string().nullable().default(null),
    probe_revision: z.number().int().nonnegative().default(0),
    desired_probe_revision: z.number().int().nonnegative().default(0),
    peer_tests: z.array(SshMeshPeerTestSchema).default([]),
  })
  .transform((node) => ({
    ...node,
    node_id: node.node_id ?? node.daemon_id,
  }));

export const SshMeshOverviewSchema = z
  .object({
    workspace_id: z.string().min(1),
    enabled: z.boolean(),
    key_version: z.number().int().nonnegative(),
    fingerprint: z.string().nullable(),
    rotation_state: z.string(),
    config_revision: z.string(),
    rotation_ready_daemons: z.number().int().nonnegative(),
    rotation_total_daemons: z.number().int().nonnegative(),
    rotation_ready_nodes: z.number().int().nonnegative().optional(),
    rotation_total_nodes: z.number().int().nonnegative().optional(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    nodes: z.array(SshMeshRuntimeSchema).nullish(),
    runtimes: z.array(SshMeshRuntimeSchema).default([]),
  })
  .transform((overview) => ({
    ...overview,
    rotation_ready_nodes:
      overview.rotation_ready_nodes ?? overview.rotation_ready_daemons,
    rotation_total_nodes:
      overview.rotation_total_nodes ?? overview.rotation_total_daemons,
    nodes: overview.nodes ?? overview.runtimes,
  }));

export const EMPTY_SSH_MESH_OVERVIEW: SshMeshOverview = {
  workspace_id: "",
  enabled: false,
  key_version: 0,
  fingerprint: null,
  rotation_state: "stable",
  config_revision: "",
  rotation_ready_daemons: 0,
  rotation_total_daemons: 0,
  rotation_ready_nodes: 0,
  rotation_total_nodes: 0,
  created_at: null,
  updated_at: null,
  nodes: [],
  runtimes: [],
};

export const SshMeshTestResponseSchema = z
  .object({
    request_id: z.string().min(1),
    probe_revision: z.number().int().positive(),
    status: z.literal("pending"),
  });

export const EMPTY_SSH_MESH_TEST_RESPONSE: SshMeshTestResponse = {
  request_id: "",
  probe_revision: 0,
  status: "",
};
