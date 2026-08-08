import { z } from "zod";
import type {
  FleetModelsResponse,
  RuntimeDirectoryScanRequest,
} from "../../types";
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
// (`/api/runtimes/:id/usage*`). Same leniency rules as the dashboard
// schemas above: numbers default to 0, strings to "", `.loose()` passes
// unknown fields.
// ---------------------------------------------------------------------------

const RuntimeUsageSchema = z.object({
  runtime_id: z.string().default(""),
  date: z.string().default(""),
  provider: z.string().default(""),
  model: z.string().default(""),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
  cache_write_tokens: z.number().default(0),
}).loose();

export const RuntimeUsageListSchema = z.array(RuntimeUsageSchema);

const RuntimeHourlyActivitySchema = z.object({
  hour: z.number().default(0),
  count: z.number().default(0),
}).loose();

export const RuntimeHourlyActivityListSchema = z.array(RuntimeHourlyActivitySchema);

const RuntimeUsageByAgentSchema = z.object({
  agent_id: z.string().default(""),
  model: z.string().default(""),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
  cache_write_tokens: z.number().default(0),
  task_count: z.number().default(0),
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
