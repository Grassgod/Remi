import { z } from "zod";
import { IssueSchema, IssueWorkspaceSchema } from "./issues";
import { ProjectSchema } from "./projects";
import { TimelineEntriesSchema } from "./timeline";

export const ManagedIssueShareSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  view_count: z.number(),
  last_viewed_at: z.string().nullable(),
  created_at: z.string(),
}).loose();

export const ManagedIssueShareResponseSchema = z.object({
  share: ManagedIssueShareSchema.nullable(),
}).loose();

const SharedAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
  url: z.string(),
  download_url: z.string(),
}).loose();

const SessionEventSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  seq: z.number(),
  author_type: z.string(),
  author_id: z.string().nullable(),
  kind: z.string(),
  body: z.string(),
  task_id: z.string().nullable(),
  source_comment_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
}).loose();

const SharedTaskSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  status: z.string(),
  issue_id: z.string().nullable(),
  issue_session_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  messages: z.array(z.record(z.string(), z.unknown())).default([]),
}).loose();

const SharedSessionSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  status: z.string(),
  is_default: z.boolean(),
  summary: z.string().nullable(),
  created_by_type: z.string(),
  created_by_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  participants: z.array(z.record(z.string(), z.unknown())).default([]),
  events: z.array(SessionEventSchema).default([]),
  tasks: z.array(SharedTaskSchema).default([]),
}).loose();

const SessionResultSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  source_session_id: z.string(),
  title: z.string(),
  body: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  published_by_type: z.string(),
  published_by_id: z.string().nullable(),
  created_at: z.string(),
}).loose();

const IssueUsageSchema = z.object({
  total_input_tokens: z.number().default(0),
  total_output_tokens: z.number().default(0),
  total_cache_read_tokens: z.number().default(0),
  total_cache_write_tokens: z.number().default(0),
  total_tokens: z.number().default(0),
  task_count: z.number().default(0),
}).loose();

export const SharedIssueBundleSchema = z.object({
  share: z.object({
    expires_at: z.string(),
    view_count: z.number(),
    last_viewed_at: z.string().nullable(),
  }).loose(),
  issue: IssueSchema.extend({
    attachments: z.array(SharedAttachmentSchema).default([]),
  }).loose(),
  project: ProjectSchema.nullable(),
  parent_issue: IssueSchema.nullable(),
  children: z.array(IssueSchema).default([]),
  child_progress: z.object({ total: z.number(), done: z.number() }),
  dependencies: z.array(z.record(z.string(), z.unknown())).default([]),
  timeline: TimelineEntriesSchema,
  sessions: z.array(SharedSessionSchema).default([]),
  session_results: z.array(SessionResultSchema).default([]),
  tasks: z.array(SharedTaskSchema).default([]),
  issue_workspace: IssueWorkspaceSchema.nullable(),
  usage: IssueUsageSchema,
  actors: z.array(z.object({
    type: z.string(),
    id: z.string(),
    name: z.string(),
    avatar_url: z.string().nullable(),
  }).loose()).default([]),
}).loose();

export const EMPTY_MANAGED_ISSUE_SHARE_RESPONSE = { share: null };

export const EMPTY_SHARED_ISSUE_BUNDLE = {
  share: { expires_at: "", view_count: 0, last_viewed_at: null },
  issue: {
    id: "",
    workspace_id: "",
    number: 0,
    identifier: "",
    title: "",
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    start_date: null,
    due_date: null,
    metadata: {},
    attachments: [],
    completed_at: null,
    archived_at: null,
    created_at: "",
    updated_at: "",
  },
  project: null,
  parent_issue: null,
  children: [],
  child_progress: { total: 0, done: 0 },
  dependencies: [],
  timeline: [],
  sessions: [],
  session_results: [],
  tasks: [],
  issue_workspace: null,
  usage: {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_tokens: 0,
    task_count: 0,
  },
  actors: [],
};
