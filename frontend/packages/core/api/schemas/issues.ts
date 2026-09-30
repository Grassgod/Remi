import { z } from "zod";
import type {
  GroupedIssuesResponse,
  IssueRetitleResponse,
  IssueWorkspace,
  ListIssuesResponse,
} from "../../types";

export const BatchUpdateIssuesResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  skipped: z.array(z.object({
    issueId: z.string(),
    error: z.string(),
    code: z.string().nullable(),
  })).default([]),
});

// Metadata is primitive-only by API/DB contract. Stay lenient on shape:
// unknown keys land as `unknown` to a caller, but the field itself defaults
// to {} so consumers never need to nil-guard `issue.metadata`.
const IssueMetadataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});

export const IssueParentDoneGrantSchema = z.object({
  granted_at: z.string(),
  granted_by: z.string(),
  agent_id: z.string(),
  effective: z.boolean(),
  ineffective_reason: z.enum(["assignee_changed", "owner_not_agent"]).nullable(),
}).loose();

export const IssueSchema = z.object({
  runtime_workspace_id: z.string().nullable().optional(),
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
  parent_done_grant_at: z.string().nullable().optional(),
  parent_done_grant_by: z.string().nullable().optional(),
  parent_done_grant_agent_id: z.string().nullable().optional(),
  blocked_by: z.array(z.string()).optional(),
  issue_kind: z.enum(["execution", "intake"]).default("execution"),
  source_issue_id: z.string().nullable().default(null),
  project_id: z.string().nullable(),
  position: z.number(),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  metadata: IssueMetadataSchema,
  reactions: z.array(z.unknown()).optional(),
  labels: z.array(z.unknown()).optional(),
  completed_at: z.string().nullable().default(null),
  archived_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const IssueDetailSchema = IssueSchema.extend({
  pending_decision_count: z.number().int().nonnegative(),
  parent_done_grant: IssueParentDoneGrantSchema.nullable(),
}).loose();

const IssueDecisionKindSchema = z.enum([
  "merge",
  "production_change",
  "criteria",
  "question",
  "permission",
  "other",
]);

export const IssueDecisionAnswerSchema = z.object({
  answererType: z.enum(["member", "agent"]),
  answererId: z.string(),
  answer: z.string(),
  reason: z.string(),
  overturn: z.string().nullable(),
  answeredAt: z.string(),
}).loose();

export const IssueDecisionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  issueId: z.string(),
  sourceIssueId: z.string(),
  sourceTaskId: z.string().nullable(),
  kind: IssueDecisionKindSchema,
  title: z.string(),
  body: z.string(),
  options: z.array(z.string()).nullable(),
  status: z.enum(["pending", "escalated", "answered", "withdrawn"]),
  answer: IssueDecisionAnswerSchema.nullable(),
  answeredByMemberId: z.string().nullable(),
  answeredAt: z.string().nullable(),
  history: z.array(IssueDecisionAnswerSchema),
  ownerAgentId: z.string().nullable(),
  createdByAgentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).loose();

export const IssueDecisionEntrySchema = z.object({
  id: z.string(),
  bucket: z.enum(["waiting_on_human", "pending_owner", "answered"]),
  type: z.enum(["decision", "human_request"]),
  kind: IssueDecisionKindSchema,
  title: z.string(),
  body: z.string().nullable(),
  status: z.string(),
  issueId: z.string(),
  sourceIssueId: z.string().nullable(),
  sourceTaskId: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  payload: z.record(z.string(), z.unknown()).optional(),
  answer: IssueDecisionAnswerSchema.nullable(),
  history: z.array(IssueDecisionAnswerSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).loose();

export const IssueDecisionListSchema = z.object({
  waiting_on_human: z.array(IssueDecisionEntrySchema),
  owner_and_answered: z.object({
    pending: z.array(IssueDecisionEntrySchema),
    answered: z.array(IssueDecisionEntrySchema),
  }).loose(),
  count: z.number().int().nonnegative(),
}).loose();

export const IssueDecisionMutationResponseSchema = z.object({
  decision: IssueDecisionSchema,
}).loose();

export const IssueParentDoneGrantMutationResponseSchema = z.object({
  issue: z.record(z.string(), z.unknown()),
  parent_done_grant: IssueParentDoneGrantSchema.nullable(),
}).loose();

export const ListIssuesResponseSchema = z.object({
  issues: z.array(IssueSchema).default([]),
  total: z.number().default(0),
}).loose();

export const IssueStatusPagesResponseSchema = z.object({
  groups: z.record(z.string(), z.object({
    issues: z.array(IssueSchema),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }).loose()),
  archived_total: z.number().int().nonnegative().optional(),
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
  archived_total: z.number().int().nonnegative().optional(),
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

export const IssueDependencySchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  depends_on_issue_id: z.string(),
  direction: z.enum(["blocked_by", "blocks"]).nullable(),
  issue: IssueSchema.nullable(),
  depends_on_issue: IssueSchema.nullable(),
  created_at: z.string(),
}).loose();

export const IssueDependenciesResponseSchema = z.object({
  dependencies: z.array(IssueDependencySchema),
}).loose();

export const IssueDependencyMutationSchema = z.object({
  dependency: IssueDependencySchema,
}).loose();

export const IssueStatusHeldErrorSchema = z.object({
  code: z.literal("issue_status_held"),
  reason: z.enum(["children_open", "final_summary_missing"]),
  open_children: z.number().int().nonnegative(),
}).loose();

const IssueWorkspaceRepoSchema = z.object({
  repo_url: z.string(),
  repo_name: z.string(),
  worktree_path: z.string(),
  branch_name: z.string(),
  base_ref: z.string(),
  status: z.string(),
  dirty: z.boolean(),
  error: z.string().nullable(),
}).loose();

export const IssueWorkspaceSchema = z.object({
  issue_id: z.string(),
  workspace_id: z.string(),
  issue_key: z.string(),
  runtime_id: z.string().nullable(),
  runtime_name: z.string().nullable(),
  runtime_status: z.string().nullable(),
  runtime_provider: z.string().nullable().optional().default(null),
  runtime_mode: z.string().nullable().optional().default(null),
  runtime_device_info: z.string().nullable().optional().default(null),
  runtime_daemon_id: z.string().nullable().optional().default(null),
  runtime_machine_name: z.string().nullable().optional().default(null),
  root_path: z.string(),
  branch_name: z.string(),
  status: z.string(),
  repos: z.array(IssueWorkspaceRepoSchema).default([]),
  last_task_id: z.string().nullable(),
  cleaned_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const IssueWorkspaceResponseSchema = z.object({
  workspace: IssueWorkspaceSchema.nullable(),
}).loose();

export const EMPTY_ISSUE_WORKSPACE_RESPONSE: { workspace: IssueWorkspace | null } = {
  workspace: null,
};

export const IssueRetitleResponseSchema = z.object({
  title: z.string(),
  previous_title: z.string(),
  applied: z.boolean(),
  reason: z.enum([
    "generated",
    "gateway_unconfigured",
    "model_failed",
    "kept",
    "not_eligible",
  ]),
}).loose();

export const EMPTY_ISSUE_RETITLE_RESPONSE: IssueRetitleResponse = {
  title: "",
  previous_title: "",
  applied: false,
  reason: "model_failed",
};

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

export const QuickCreateIssueResponseSchema = z.object({ task_id: z.string().min(1), issue: IssueSchema });
