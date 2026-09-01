import { z } from "zod";
import type {
  IssueSession,
  IssueSessionTask,
  SessionEvent,
  SessionParticipant,
  SessionResult,
} from "../../types";
import { AttachmentSchema, ReactionSchema } from "./primitives";

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
  holds_workspace: z.boolean().default(true),
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
  holds_workspace: true,
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

export const IssueSessionTaskSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  runtime_id: z.preprocess((value) => value ?? "", z.string()),
  issue_id: z.string(),
  issue_session_id: z.string(),
  holds_workspace: z.boolean().default(true),
  queue_blocker: z.object({
    task_id: z.string(),
    agent_id: z.string(),
    agent_name: z.string(),
    issue_session_id: z.string().nullable(),
    issue_session_title: z.string().nullable(),
    reason: z.enum(["session", "issue_workspace", "legacy_issue", "agent_capacity"]),
  }).nullable().optional(),
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
