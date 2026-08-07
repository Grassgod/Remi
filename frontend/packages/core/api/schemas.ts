import { z } from "zod";
import type { MultiremiTaskStatus } from "@multiremi/contracts";
import type {
  Agent,
  AgentTemplate,
  AgentTemplateSummary,
  Attachment,
  BillingBalance,
  BillingBatchesPage,
  BillingCheckoutSessionStatus,
  BillingPriceTier,
  BillingTopupsPage,
  BillingTransactionsPage,
  CreateAgentFromTemplateResponse,
  CreateBillingCheckoutSessionResponse,
  CreateBillingPortalSessionResponse,
  FleetModelsResponse,
  GroupedIssuesResponse,
  IssueSession,
  IssueSessionTask,
  ListIssuesResponse,
  ListLarkInstallationsResponse,
  ListProjectDocRevisionsResponse,
  ListProjectDocsResponse,
  ListWebhookDeliveriesResponse,
  ProjectDoc,
  RuntimeDirectoryScanRequest,
  Squad,
  SessionEvent,
  SessionParticipant,
  SessionResult,
  TimelineEntry,
  User,
  WebhookDelivery,
} from "../types";
import type { CloudRuntimeNode } from "../runtimes/cloud-runtime";

// Canary: prove the frontend can consume the shared @multiremi/contracts
// protocol package (see A1). Pure type re-export — zero runtime footprint.
export type ServerTaskStatus = MultiremiTaskStatus;

export interface AppConfigResponse {
  cdn_domain: string;
  allow_signup: boolean;
  google_client_id?: string;
  posthog_key?: string;
  posthog_host?: string;
  analytics_environment?: string;
  daemon_server_url?: string;
  workspace_creation_disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Schemas for the highest-risk API endpoints — those whose responses drive
// the issue detail page (timeline, comments, subscribers) and the issues
// list. These are the surfaces that white-screened in #2143 / #2147 / #2192.
//
// These schemas are intentionally LENIENT:
//   - String enums are stored as `z.string()` rather than `z.enum([...])`.
//     A new server-side enum value should render as a generic fallback in
//     the UI, never crash a `safeParse`.
//   - Optional fields are unioned with `null` and given fallbacks where
//     existing UI code already coerces them.
//   - Arrays default to `[]` so a missing `reactions` / `attachments` /
//     `entries` field doesn't take the page down.
//   - Every object schema ends with `.loose()` so unknown server-side
//     fields pass through unchanged. zod 4's `.object()` defaults to STRIP,
//     which would silently delete fields the schema didn't explicitly list
//     — fine while the TS type doesn't claim them, but the moment a future
//     PR adds a TS field without updating the schema, the cast `as T` lies
//     and the field shows up as `undefined` at runtime. `.loose()` removes
//     that synchronisation hazard.
//
// These schemas are deliberately not typed as `z.ZodType<TimelineEntry>` /
// `z.ZodType<Issue>` etc. — the strict TS types narrow string fields to
// literal unions, which would defeat the leniency above. `parseWithFallback`
// returns the parsed value cast to the caller-supplied `T`, so the strict
// type still flows out at the call site; the schema only guards shape.
// ---------------------------------------------------------------------------

const ReactionSchema = z.object({
  id: z.string(),
  comment_id: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  emoji: z.string(),
  created_at: z.string(),
});

// Nested attachments embedded in timeline/comment responses stay lenient on
// purpose: a single malformed attachment must not knock the whole timeline
// into the fallback `[]`.
const AttachmentSchema = z.object({
  id: z.string(),
}).loose();

// Standalone attachment lookup (`GET /api/attachments/{id}`) is the source of
// truth for click-time download URLs. The two fields the download flow opens
// in a new tab — `download_url` and `url` — must be strings, otherwise we'd
// happily `window.open(undefined)`. `filename` gates the toast/title and is
// also enforced so a missing value falls back to the empty record below.
export const AttachmentResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  download_url: z.string(),
  filename: z.string(),
  chat_session_id: z.string().nullable().optional(),
  chat_message_id: z.string().nullable().optional(),
}).loose();

export const EMPTY_ATTACHMENT: Attachment = {
  id: "",
  workspace_id: "",
  issue_id: null,
  comment_id: null,
  chat_session_id: null,
  chat_message_id: null,
  uploader_type: "",
  uploader_id: "",
  filename: "",
  url: "",
  download_url: "",
  content_type: "",
  size_bytes: 0,
  created_at: "",
};

// All object schemas use `.loose()` so unknown server-side fields pass
// through unchanged. zod 4's `.object()` defaults to STRIP, which would
// silently drop new fields and surface as a "field neither showed up in
// the UI" mystery the next time the TS type adopted them but the schema
// wasn't updated in lock-step. `.loose()` removes that synchronisation
// hazard — the schema validates the shape it knows about and leaves the
// rest alone.
const TimelineEntrySchema = z.object({
  type: z.string(),
  id: z.string(),
  actor_type: z.string(),
  // System activities (issue_assigned, issue_updated, …) come back with
  // actor_id: null. A single null used to fail the whole array and blank the
  // activity feed via the fallback — normalize to "" instead.
  actor_id: z.preprocess((value) => value ?? "", z.string()),
  // Agent auto-reply comments only; null/absent everywhere else.
  task_id: z.string().nullable().optional(),
  created_at: z.string(),
  action: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  comment_type: z.string().optional(),
  reactions: z.array(ReactionSchema).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  coalesced_count: z.number().optional(),
}).loose();

// /timeline returns a flat array of TimelineEntry, oldest first. The
// previously cursor-paginated wrapper was removed (#1929) — at observed data
// sizes (p99 ~30 entries per issue) paged delivery only created bugs.
export const TimelineEntriesSchema = z.array(TimelineEntrySchema);

export const EMPTY_TIMELINE_ENTRIES: TimelineEntry[] = [];

const OptionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);

const BooleanWithDefaultSchema = (fallback: boolean) =>
  z.preprocess(
    (value) => (typeof value === "boolean" ? value : undefined),
    z.boolean().default(fallback),
  );

export const AppConfigSchema = z.object({
  cdn_domain: z.string().default(""),
  allow_signup: BooleanWithDefaultSchema(true),
  google_client_id: OptionalStringSchema,
  posthog_key: OptionalStringSchema,
  posthog_host: OptionalStringSchema,
  analytics_environment: OptionalStringSchema,
  daemon_server_url: OptionalStringSchema,
  workspace_creation_disabled: BooleanWithDefaultSchema(false).optional(),
}).loose();

export const EMPTY_APP_CONFIG: AppConfigResponse = {
  cdn_domain: "",
  allow_signup: true,
  google_client_id: "",
  daemon_server_url: "",
  workspace_creation_disabled: false,
};

export const CommentSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  issue_session_id: z.string().nullable().optional(),
  author_type: z.string(),
  author_id: z.string(),
  task_id: z.string().nullable().optional(),
  content: z.string(),
  type: z.string(),
  parent_id: z.string().nullable(),
  reactions: z.array(ReactionSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const CommentsListSchema = z.array(CommentSchema);

export const SessionParticipantSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  participant_type: z.string(),
  participant_id: z.string(),
  role: z.string().default("participant"),
  status: z.string().default("active"),
  joined_at: z.string(),
  updated_at: z.string(),
}).loose();

export const SessionParticipantListSchema = z.array(SessionParticipantSchema);
export const EMPTY_SESSION_PARTICIPANTS: SessionParticipant[] = [];

export const IssueSessionSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  status: z.string(),
  is_default: z.boolean().default(false),
  summary: z.string().nullable().default(null),
  created_by_type: z.string().default("system"),
  created_by_id: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  participants: z.array(SessionParticipantSchema).default([]),
}).loose();

export const IssueSessionListSchema = z.array(IssueSessionSchema);
export const EMPTY_ISSUE_SESSIONS: IssueSession[] = [];
export const EMPTY_ISSUE_SESSION: IssueSession = {
  id: "",
  issue_id: "",
  workspace_id: "",
  title: "",
  status: "active",
  is_default: false,
  summary: null,
  created_by_type: "system",
  created_by_id: null,
  created_at: "",
  updated_at: "",
  participants: [],
};

const SessionEventSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  seq: z.number(),
  author_type: z.string(),
  author_id: z.string().nullable().default(null),
  kind: z.string(),
  body: z.string(),
  task_id: z.string().nullable().default(null),
  source_comment_id: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
}).loose();

export const SessionEventListSchema = z.array(SessionEventSchema);
export const EMPTY_SESSION_EVENTS: SessionEvent[] = [];

export const SessionResultSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  source_session_id: z.string(),
  title: z.string().default(""),
  body: z.string(),
  // The kind/refs conventions the issue page reads live in here (see
  // docs/issue-key-results.md), so the bag is decoration on top of a result:
  // a server that sends null — or a JSON string it forgot to parse — must
  // cost the result its badges, not drop it (and with it the whole list) from
  // the key-results panel.
  metadata: z.preprocess(
    (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}),
    z.record(z.string(), z.unknown()),
  ),
  published_by_type: z.string(),
  published_by_id: z.string().nullable().default(null),
  created_at: z.string(),
}).loose();

export const SessionResultListSchema = z.array(SessionResultSchema);
export const EMPTY_SESSION_RESULTS: SessionResult[] = [];
export const EMPTY_SESSION_RESULT: SessionResult = {
  id: "",
  issue_id: "",
  source_session_id: "",
  title: "",
  body: "",
  metadata: {},
  published_by_type: "member",
  published_by_id: null,
  created_at: "",
};

export const IssueSessionTaskSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  runtime_id: z.preprocess((value) => value ?? "", z.string()),
  issue_id: z.string(),
  issue_session_id: z.string(),
  prompt: z.string().optional(),
  status: z.string(),
  priority: z.number().default(0),
  dispatched_at: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
  result: z.unknown().nullable().default(null),
  error: z.string().nullable().default(null),
  created_at: z.string(),
}).loose();

export const IssueSessionTaskListSchema = z.array(IssueSessionTaskSchema);
export const EMPTY_ISSUE_SESSION_TASKS: IssueSessionTask[] = [];
export const EMPTY_ISSUE_SESSION_TASK: IssueSessionTask = {
  id: "",
  agent_id: "",
  runtime_id: "",
  issue_id: "",
  issue_session_id: "",
  status: "queued",
  priority: 0,
  dispatched_at: null,
  started_at: null,
  completed_at: null,
  result: null,
  error: null,
  created_at: "",
};

// Metadata is primitive-only by API/DB contract. Stay lenient on shape:
// unknown keys land as `unknown` to a caller, but the field itself defaults
// to {} so consumers never need to nil-guard `issue.metadata`.
const IssueMetadataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});

export const IssueSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  number: z.number(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  assignee_type: z.string().nullable(),
  assignee_id: z.string().nullable(),
  creator_type: z.string(),
  creator_id: z.string(),
  parent_issue_id: z.string().nullable(),
  project_id: z.string().nullable(),
  position: z.number(),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  metadata: IssueMetadataSchema,
  reactions: z.array(z.unknown()).optional(),
  labels: z.array(z.unknown()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const ListIssuesResponseSchema = z.object({
  issues: z.array(IssueSchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_LIST_ISSUES_RESPONSE: ListIssuesResponse = {
  issues: [],
  total: 0,
};

const IssueAssigneeGroupSchema = z.object({
  id: z.string(),
  assignee_type: z.string().nullable(),
  assignee_id: z.string().nullable(),
  issues: z.array(IssueSchema).default([]),
  total: z.number().default(0),
}).loose();

export const GroupedIssuesResponseSchema = z.object({
  groups: z.array(IssueAssigneeGroupSchema).default([]),
}).loose();

export const EMPTY_GROUPED_ISSUES_RESPONSE: GroupedIssuesResponse = {
  groups: [],
};

const SubscriberSchema = z.object({
  issue_id: z.string(),
  user_type: z.string(),
  user_id: z.string(),
  reason: z.string(),
  created_at: z.string(),
}).loose();

export const SubscribersListSchema = z.array(SubscriberSchema);

export const ChildIssuesResponseSchema = z.object({
  issues: z.array(IssueSchema).default([]),
}).loose();

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
// Workspace dashboard schemas
//
// The dashboard hits three independent rollup endpoints. Each returns a flat
// array, and every field is consumed by chart / KPI math — a missing number
// silently degrades to NaN downstream, so we coerce missing numbers to 0.
// String fields default to "" (no enum narrowing) to survive future model /
// agent ID drift, and so a single null from tz-aware SQL bucketing fails
// only that row instead of dropping the whole array to the `[]` fallback.
// ---------------------------------------------------------------------------

const DashboardUsageDailySchema = z.object({
  date: z.string().default(""),
  model: z.string().default(""),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
  cache_write_tokens: z.number().default(0),
  task_count: z.number().default(0),
}).loose();

export const DashboardUsageDailyListSchema = z.array(DashboardUsageDailySchema);

const DashboardUsageByAgentSchema = z.object({
  agent_id: z.string().default(""),
  model: z.string().default(""),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
  cache_write_tokens: z.number().default(0),
  task_count: z.number().default(0),
}).loose();

export const DashboardUsageByAgentListSchema = z.array(DashboardUsageByAgentSchema);

const DashboardAgentRunTimeSchema = z.object({
  agent_id: z.string().default(""),
  total_seconds: z.number().default(0),
  task_count: z.number().default(0),
  failed_count: z.number().default(0),
}).loose();

export const DashboardAgentRunTimeListSchema = z.array(DashboardAgentRunTimeSchema);

const DashboardRunTimeDailySchema = z.object({
  date: z.string().default(""),
  total_seconds: z.number().default(0),
  task_count: z.number().default(0),
  failed_count: z.number().default(0),
}).loose();

export const DashboardRunTimeDailyListSchema = z.array(DashboardRunTimeDailySchema);

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

// ---------------------------------------------------------------------------
// Agent template catalog — `/api/agent-templates*` and the
// create-from-template response. The desktop app's create-agent picker
// reaches these endpoints, and a future server change to the template shape
// would white-screen older installed builds (#2192 pattern) without these
// parsers. Lenient by the same rules as IssueSchema above: arrays default to
// `[]`, optional fields stay optional, `.loose()` lets unknown fields pass
// through unchanged.
// ---------------------------------------------------------------------------

const AgentTemplateSkillRefSchema = z.object({
  source_url: z.string(),
  cached_name: z.string().default(""),
  cached_description: z.string().default(""),
}).loose();

const AgentTemplateSummarySchemaBase = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().default(""),
  category: z.string().optional(),
  icon: z.string().optional(),
  accent: z.string().optional(),
  // skills MUST default to [] — picker code reads `template.skills.length`
  // and `.map(...)`, both of which crash on `undefined`. The most common
  // future drift (field renamed / wrapped) lands here.
  skills: z.array(AgentTemplateSkillRefSchema).default([]),
}).loose();

export const AgentTemplateSummarySchema = AgentTemplateSummarySchemaBase;

// List endpoint historically returns a bare array. Server could legitimately
// migrate to `{templates: [...]}` later — we accept either shape so an old
// desktop survives the upgrade.
export const AgentTemplateSummaryListSchema = z.union([
  z.array(AgentTemplateSummarySchemaBase),
  z.object({ templates: z.array(AgentTemplateSummarySchemaBase).default([]) })
    .loose()
    .transform((v) => v.templates),
]);

export const EMPTY_AGENT_TEMPLATE_SUMMARY_LIST: AgentTemplateSummary[] = [];

export const AgentTemplateSchema = AgentTemplateSummarySchemaBase.extend({
  // Detail-only field. Default "" so a malformed detail still renders the
  // header + skill list; the user just sees an empty Instructions block.
  instructions: z.string().default(""),
}).loose();

// Used as the parse fallback for `GET /api/agent-templates/:slug`. Slug comes
// from the URL, so we round-trip the requested one back into the fallback
// at the call site (see `getAgentTemplate` in client.ts).
export const EMPTY_AGENT_TEMPLATE_DETAIL: AgentTemplate = {
  slug: "",
  name: "",
  description: "",
  skills: [],
  instructions: "",
};

// `agent` is a full Agent record — schematising every field would duplicate
// a 50-field interface and bit-rot fast. We keep it loose and require only
// `id`, the one field the create-from-template flow consumes (used to
// navigate to the new agent's detail page). Downstream code already
// optional-chains the rest.
const MinimalAgentSchema = z.object({
  id: z.string(),
}).loose();

export const CreateAgentFromTemplateResponseSchema = z.object({
  agent: MinimalAgentSchema,
  imported_skill_ids: z.array(z.string()).default([]),
  reused_skill_ids: z.array(z.string()).default([]),
}).loose();

// Fallback when the success response fails to parse. The agent server-side
// has likely been created already, so we can't pretend nothing happened —
// the caller (`create-agent-dialog.tsx`) is responsible for noticing
// `agent.id === ""` and skipping navigation while keeping the list
// invalidation, so the user finds their new agent in the list.
export const EMPTY_CREATE_AGENT_FROM_TEMPLATE_RESPONSE: CreateAgentFromTemplateResponse = {
  agent: { id: "" } as Agent,
  imported_skill_ids: [],
  reused_skill_ids: [],
};

// Squad list responses carry lightweight membership previews used by hover
// cards. The preview fields are additive API fields, so older backends default
// cleanly to no preview instead of breaking newer frontends.
const SquadMemberPreviewSchema = z.object({
  member_type: z.string(),
  member_id: z.string(),
  role: z.string().default(""),
}).loose();

export const SquadSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  instructions: z.string().default(""),
  avatar_url: z.string().nullable().optional().transform((v) => v ?? null),
  leader_id: z.string(),
  creator_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable().optional().transform((v) => v ?? null),
  archived_by: z.string().nullable().optional().transform((v) => v ?? null),
  member_count: z.number().default(0),
  member_preview: z.array(SquadMemberPreviewSchema).default([]),
}).loose();

export const SquadListSchema = z.array(SquadSchema);
export const EMPTY_SQUAD_LIST: Squad[] = [];
export const EMPTY_SQUAD: Squad = {
  id: "",
  workspace_id: "",
  name: "",
  description: "",
  instructions: "",
  avatar_url: null,
  leader_id: "",
  creator_id: "",
  created_at: "",
  updated_at: "",
  archived_at: null,
  archived_by: null,
  member_count: 0,
  member_preview: [],
};

// Squad member status — backs the Squad detail page's Members tab. status
// is `string | null` (not the narrow `SquadMemberStatusValue` union) so a
// new server-side status doesn't fail the parse; the UI defaults to a
// neutral pill for unknown values.
const SquadActiveIssueBriefSchema = z.object({
  issue_id: z.string(),
  identifier: z.string(),
  title: z.string(),
  issue_status: z.string(),
}).loose();

const SquadMemberStatusSchema = z.object({
  member_type: z.string(),
  member_id: z.string(),
  status: z.string().nullable().optional().transform((v) => v ?? null),
  active_issues: z.array(SquadActiveIssueBriefSchema).default([]),
  last_active_at: z.string().nullable().optional().transform((v) => v ?? null),
}).loose();

export const SquadMemberStatusListResponseSchema = z.object({
  members: z.array(SquadMemberStatusSchema).default([]),
}).loose();

export const EMPTY_SQUAD_MEMBER_STATUS_LIST = { members: [] };

// ---------------------------------------------------------------------------
// Structured error body — POST /api/workspaces/:wsId/issues 409 conflict.
//
// When the server detects an active issue with the same title in the same
// workspace, it returns `{ code: "active_duplicate_issue", error, issue }`
// instead of letting the create through. The UI uses the embedded issue ref
// to offer "view existing" rather than dropping the user into a generic
// "create failed" toast.
//
// Strict guarantees:
//   - `code` is a literal so a future server rename (e.g. `duplicate_issue`)
//     fails the parse and falls back to a normal error toast — drift never
//     ships as a broken duplicate UI.
//   - `issue` is required; without an id/identifier/title the "view existing"
//     button has nothing to point at, so we'd rather fall back than guess.
//   - `issue.status` is intentionally OMITTED: the duplicate toast doesn't
//     render a StatusIcon (which has no fallback for unknown enum values),
//     so a future server-side rename of `status` must not knock this branch
//     out. `.loose()` lets the field pass through unchanged for any other
//     consumer.
// ---------------------------------------------------------------------------

export const DuplicateIssueErrorBodySchema = z.object({
  code: z.literal("active_duplicate_issue"),
  error: z.string().optional(),
  issue: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
  }).loose(),
}).loose();

export interface DuplicateIssueErrorBody {
  code: "active_duplicate_issue";
  error?: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
  };
}

// ---------------------------------------------------------------------------
// Webhook delivery schemas — backing the Autopilot Deliveries section. Enums
// (`status`, `signature_status`, `provider`) are kept as `z.string()` so a
// future server-side value (e.g. a Stripe provider, a new dedupe state)
// degrades to a generic UI fallback rather than collapsing the list into
// the empty array. `.loose()` lets unknown fields pass through, matching
// the rule used by every other endpoint here.
// ---------------------------------------------------------------------------

const WebhookDeliverySchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  autopilot_id: z.string(),
  trigger_id: z.string(),
  provider: z.string(),
  event: z.string(),
  dedupe_key: z.string().nullable(),
  dedupe_source: z.string().nullable(),
  signature_status: z.string(),
  status: z.string(),
  attempt_count: z.number().default(0),
  content_type: z.string().nullable(),
  response_status: z.number().nullable(),
  autopilot_run_id: z.string().nullable(),
  replayed_from_delivery_id: z.string().nullable(),
  error: z.string().nullable(),
  received_at: z.string(),
  last_attempt_at: z.string(),
  created_at: z.string(),
  // Detail-only fields. The list endpoint omits them; the detail endpoint
  // populates raw_body / selected_headers / response_body.
  selected_headers: z.record(z.string(), z.unknown()).nullable().optional(),
  raw_body: z.string().nullable().optional(),
  response_body: z.string().nullable().optional(),
}).loose();

export const ListWebhookDeliveriesResponseSchema = z.object({
  deliveries: z.array(WebhookDeliverySchema).default([]),
  total: z.number().default(0),
}).loose();

export const WebhookDeliveryResponseSchema = WebhookDeliverySchema;

export const EMPTY_LIST_WEBHOOK_DELIVERIES_RESPONSE: ListWebhookDeliveriesResponse = {
  deliveries: [],
  total: 0,
};

export const EMPTY_WEBHOOK_DELIVERY: WebhookDelivery = {
  id: "",
  workspace_id: "",
  autopilot_id: "",
  trigger_id: "",
  provider: "",
  event: "",
  dedupe_key: null,
  dedupe_source: null,
  signature_status: "not_required",
  status: "queued",
  attempt_count: 0,
  content_type: null,
  response_status: null,
  autopilot_run_id: null,
  replayed_from_delivery_id: null,
  error: null,
  received_at: "",
  last_attempt_at: "",
  created_at: "",
};

// ---------------------------------------------------------------------------
// User (`/api/me` GET + PATCH). The auth store and Settings → Account both
// trust this shape — a drift here would knock both surfaces out. Kept
// lenient by the same rules as IssueSchema: enums stay `z.string()`,
// nullable fields are unioned with `null`, unknown server fields pass
// through via `.loose()`. `profile_description` is the field added in
// MUL-2406; the server emits `""` when unset (NOT NULL DEFAULT ''), so
// the schema defaults to `""` too — keeps the type tight without
// breaking older backends that don't return the column yet.
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  email: z.string().default(""),
  avatar_url: z.string().nullable().default(null),
  onboarded_at: z.string().nullable().default(null),
  onboarding_questionnaire: z.record(z.string(), z.unknown()).default({}),
  starter_content_state: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  profile_description: z.string().default(""),
  timezone: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const EMPTY_USER: User = {
  id: "",
  name: "",
  email: "",
  avatar_url: null,
  onboarded_at: null,
  onboarding_questionnaire: {},
  starter_content_state: null,
  language: null,
  profile_description: "",
  timezone: null,
  created_at: "",
  updated_at: "",
};

// ---------------------------------------------------------------------------
// Billing schemas (cloud-billing proxy surface)
//
// All billing JSON we receive comes from multimira-cloud verbatim — we proxy
// the bytes without re-shaping. These schemas use `loose()` so a future
// non-breaking field addition on the cloud side doesn't crash us; required
// fields are still strictly enforced. EMPTY_* constants supply the
// fallback parseWithFallback uses when the upstream response is malformed
// or unparseable.

export const BillingBalanceSchema = z.object({
  owner_id: z.string(),
  balance_micro: z.number(),
  balance_credit: z.number(),
  updated_at: z.string(),
}).loose();

export const EMPTY_BILLING_BALANCE: BillingBalance = {
  owner_id: "",
  balance_micro: 0,
  balance_credit: 0,
  updated_at: "",
};

// `tx_type` and `source` are kept as plain strings here; the cloud doc
// enumerates the canonical values but the frontend display tolerates
// unknown ones gracefully. Strict enums would crash the page on a future
// addition (e.g. a new `topup` source kind).
export const BillingTransactionSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  idempotency_key: z.string().default(""),
  tx_type: z.string(),
  source: z.string(),
  amount_micro: z.number(),
  balance_after: z.number(),
  reference_id: z.string().default(""),
  description: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
}).loose();

export const BillingTransactionsPageSchema = z.object({
  items: z.array(BillingTransactionSchema).default([]),
  total: z.number().default(0),
  page: z.number().default(1),
  page_size: z.number().default(20),
}).loose();

export const EMPTY_BILLING_TRANSACTIONS_PAGE: BillingTransactionsPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
};

export const BillingBatchSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  source_tx_id: z.string().default(""),
  source_type: z.string(),
  total_micro: z.number(),
  remaining_micro: z.number(),
  // Cloud either omits the key (never expires) or sends a string
  // timestamp. Null is also tolerated since some serializers emit
  // explicit nulls for absent timestamps.
  expires_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const BillingBatchesPageSchema = z.object({
  items: z.array(BillingBatchSchema).default([]),
  total: z.number().default(0),
  page: z.number().default(1),
  page_size: z.number().default(20),
}).loose();

export const EMPTY_BILLING_BATCHES_PAGE: BillingBatchesPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
};

export const BillingTopupSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  amount_cents: z.number(),
  currency: z.string().default("usd"),
  credits: z.number(),
  bonus_credits: z.number().default(0),
  status: z.string(),
  tier_id: z.string().default(""),
  stripe_checkout_id: z.string().default(""),
  // Only set after status reaches `credited` — leave optional rather
  // than coerce to "" so a UI can branch on existence.
  purchase_batch_id: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const BillingTopupsPageSchema = z.object({
  items: z.array(BillingTopupSchema).default([]),
  total: z.number().default(0),
  page: z.number().default(1),
  page_size: z.number().default(20),
}).loose();

export const EMPTY_BILLING_TOPUPS_PAGE: BillingTopupsPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
};

export const BillingPriceTierSchema = z.object({
  id: z.string(),
  // Cloud doc says display_name falls back to id; tolerate empty too.
  display_name: z.string().default(""),
  amount_cents: z.number(),
  credits: z.number(),
  bonus_credits: z.number().optional(),
  bonus_expires_in: z.string().optional(),
}).loose();

export const BillingPriceTierListSchema = z.array(BillingPriceTierSchema);

export const EMPTY_BILLING_PRICE_TIER_LIST: BillingPriceTier[] = [];

export const CreateBillingCheckoutSessionResponseSchema = z.object({
  order_id: z.string(),
  session_id: z.string(),
  url: z.string(),
}).loose();

export const EMPTY_CREATE_BILLING_CHECKOUT_SESSION_RESPONSE: CreateBillingCheckoutSessionResponse = {
  order_id: "",
  session_id: "",
  url: "",
};

export const BillingCheckoutSessionStatusSchema = z.object({
  order_id: z.string(),
  status: z.string(),
  amount_cents: z.number(),
  credits: z.number(),
  bonus_credits: z.number().default(0),
  currency: z.string().default("usd"),
  tier_id: z.string().default(""),
}).loose();

export const EMPTY_BILLING_CHECKOUT_SESSION_STATUS: BillingCheckoutSessionStatus = {
  order_id: "",
  status: "pending",
  amount_cents: 0,
  credits: 0,
  bonus_credits: 0,
  currency: "usd",
  tier_id: "",
};

export const CreateBillingPortalSessionResponseSchema = z.object({
  url: z.string(),
}).loose();

export const EMPTY_CREATE_BILLING_PORTAL_SESSION_RESPONSE: CreateBillingPortalSessionResponse = {
  url: "",
};

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
// Project docs — the project knowledge base (`kind` = wiki page | agent
// memory entry). Read-only surface today, so leniency matters more than
// precision: `kind` / `author_type` stay `z.string()` so a server-side
// addition renders through the generic branch, `tags` and `pinned` default
// rather than failing the row, and `body` / `summary` tolerate absence (a
// skeleton page created by the CLI has neither).
// ---------------------------------------------------------------------------

// A citation on a doc. `type` stays open (issue / task / comment / url / file
// today) so an unknown type renders as plain text instead of failing the row.
const ProjectDocRefSchema = z.object({
  type: z.string().default(""),
  value: z.string().default(""),
}).loose();

const ProjectDocSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  workspace_id: z.string().default(""),
  kind: z.string(),
  slug: z.string().default(""),
  title: z.string(),
  summary: z.string().nullable().default(null),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  // Citations are decoration on top of the doc: a server that doesn't send
  // them yet (or sends null / a JSON string it forgot to parse) must still
  // show the page, so anything non-array degrades to no badges, and a
  // non-object entry is dropped rather than failing the whole list.
  refs: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => typeof entry === "object" && entry !== null)
        : [],
    z.array(ProjectDocRefSchema),
  ),
  source_task_id: z.string().nullable().default(null),
  source_issue_id: z.string().nullable().default(null),
  author_type: z.string().nullable().default(null),
  author_id: z.string().nullable().default(null),
  updated_by_type: z.string().nullable().default(null),
  updated_by_id: z.string().nullable().default(null),
  version: z.number().default(1),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const ListProjectDocsResponseSchema = z.object({
  docs: z.array(ProjectDocSchema).default([]),
}).loose();

export const EMPTY_LIST_PROJECT_DOCS_RESPONSE: ListProjectDocsResponse = {
  docs: [],
};

export const EMPTY_PROJECT_DOC: ProjectDoc = {
  id: "",
  project_id: "",
  workspace_id: "",
  kind: "wiki",
  slug: "",
  title: "",
  summary: null,
  body: "",
  tags: [],
  pinned: false,
  refs: [],
  source_task_id: null,
  source_issue_id: null,
  author_type: null,
  author_id: null,
  updated_by_type: null,
  updated_by_id: null,
  version: 1,
  created_at: "",
  updated_at: "",
};

export const ProjectDocResponseSchema = z.object({
  doc: ProjectDocSchema,
}).loose();

const ProjectDocRevisionSchema = z.object({
  id: z.string(),
  doc_id: z.string(),
  version: z.number(),
  title: z.string(),
  summary: z.string().nullable().default(null),
  body: z.string().default(""),
  author_type: z.string().nullable().default(null),
  author_id: z.string().nullable().default(null),
  created_at: z.string().default(""),
}).loose();

export const ListProjectDocRevisionsResponseSchema = z.object({
  revisions: z.array(ProjectDocRevisionSchema).default([]),
}).loose();

export const EMPTY_LIST_PROJECT_DOC_REVISIONS_RESPONSE: ListProjectDocRevisionsResponse = {
  revisions: [],
};

// ---------------------------------------------------------------------------
// Lark installations — `GET /api/workspaces/:id/lark/installations`, the list
// behind Settings → Lark. Same leniency rules as everything above: `status`
// and `region` stay `z.string()` so a new server-side value renders through
// the generic branch instead of dropping the row, and `installations`
// defaults to `[]`.
//
// The two capability booleans default to `false` on purpose: they gate the
// Bind CTA, so a drifted response must land on "ask the operator to enable
// Lark" rather than offering an install the backend would reject.
// ---------------------------------------------------------------------------

const LarkInstallationSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  agent_id: z.string().default(""),
  app_id: z.string().default(""),
  tenant_key: z.string().nullable().optional(),
  bot_open_id: z.string().default(""),
  installer_user_id: z.string().default(""),
  status: z.string().default(""),
  region: z.string().optional(),
  installed_at: z.string().default(""),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const ListLarkInstallationsResponseSchema = z.object({
  installations: z.array(LarkInstallationSchema).default([]),
  configured: z.boolean().default(false),
  install_supported: z.boolean().optional(),
}).loose();

export const EMPTY_LIST_LARK_INSTALLATIONS_RESPONSE: ListLarkInstallationsResponse = {
  installations: [],
  configured: false,
};
