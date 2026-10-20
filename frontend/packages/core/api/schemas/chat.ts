import { z } from "zod";
import {
  BACKGROUND_LANE_STATES,
  BACKGROUND_TASK_STATUSES,
  BACKGROUND_TASK_STOP_REASONS,
  type BackgroundLaneState,
  type BackgroundTaskStatus,
  type BackgroundTaskStopOutcome,
  type BackgroundTaskStopReason,
} from "@multiremi/contracts/unified-model";
import { TRACE_BACKGROUND_TASK_STOP_OUTCOMES } from "@multiremi/contracts/trace";
import type { ChatSlashCommandsResponse, SlashCommandEntry } from "@multiremi/contracts/slash-commands";
import type { ChatBackgroundTask, ChatBackgroundTasksSnapshot } from "../../types";

/** A display-only count: a malformed value reads as absent instead of failing the list. */
const OptionalCountSchema = z.number().int().nonnegative().optional().catch(undefined);

export const ChatSessionSchema = z.object({
  id: z.string(), workspace_id: z.string(), creator_id: z.string(), agent_id: z.string(),
  project_id: z.string().nullable().optional(),
  title: z.string(), status: z.string(), has_unread: z.boolean().default(false),
  pinned: z.boolean().default(false),
  origin: z.object({ autopilot_id: z.string(), run_id: z.string() }).loose().nullable().default(null),
  unread_count: z.number().int().nonnegative().default(0),
  last_message: z.object({ content: z.string(), role: z.string(), created_at: z.string() }).nullable().default(null),
  runtime_workspace_id: z.string().nullable().optional(),
  // PR 6: running background tasks of the session registry (list items only).
  running_background_tasks: OptionalCountSchema,
  created_at: z.string(), updated_at: z.string(),
}).loose();
export const ChatSessionListSchema = z.array(ChatSessionSchema);
/** An update must explicitly confirm pin state; a read default cannot acknowledge an unpin. */
export const ChatSessionUpdateResponseSchema = ChatSessionSchema.extend({ pinned: z.boolean() });

/** Mutations returning 204 must not treat an unexpected JSON body as success. */
export const ChatNoContentSchema = z.undefined();

// ── Background tasks (PR 6 §5, §7) ──────────────────────────────────────────
//
// The registry row of `GET /api/chat/sessions/:id/background-tasks` and of the
// `chat:background_tasks` event. Rows are display data: one malformed row is
// dropped, not the list, and a status, reason or lane state this build does
// not know degrades (status `unknown`, reason and outcome null) so a newer
// server still renders.

const nullableString = z.string().nullable().catch(null).default(null);
const nullableNumber = z.number().nonnegative().nullable().catch(null).default(null);
const oneOf = <T extends string>(values: readonly T[]) => (value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const isStatus = oneOf<BackgroundTaskStatus>(BACKGROUND_TASK_STATUSES);
const isStopReason = oneOf<BackgroundTaskStopReason>(BACKGROUND_TASK_STOP_REASONS);
const isLaneState = oneOf<BackgroundLaneState>(BACKGROUND_LANE_STATES);
const isStopOutcome = oneOf<BackgroundTaskStopOutcome>(TRACE_BACKGROUND_TASK_STOP_OUTCOMES);

const UsageSchema = z.object({
  total_tokens: z.number().nonnegative(), tool_uses: z.number().nonnegative(), duration_ms: z.number().nonnegative(),
}).loose();

export const ChatBackgroundTaskSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().catch("").default(""),
  session_id: z.string(),
  agent_id: z.string().catch("").default(""),
  execution_scope: z.string().catch("").default(""),
  runtime_id: z.string().catch("").default(""),
  provider_session_id: z.string().catch("").default(""),
  task_id: z.string().min(1),
  task_type: z.string().catch("").default(""),
  name: z.string().catch("").default(""),
  command: nullableString,
  origin_attempt_id: z.string().catch("").default(""),
  origin_turn_id: nullableString,
  origin_item_id: nullableString,
  status: z.unknown().optional().transform((value): BackgroundTaskStatus => isStatus(value) ? value : "unknown"),
  stop_reason: z.unknown().optional().transform((value): BackgroundTaskStopReason | null => isStopReason(value) ? value : null),
  can_stop: z.boolean().catch(false).default(false),
  stop_requested_at: nullableString,
  stop_requested_by: nullableString,
  stop_outcome: z.unknown().optional().transform((value): BackgroundTaskStopOutcome | null => isStopOutcome(value) ? value : null),
  started_at: z.string(),
  ended_at: nullableString,
  duration_ms: nullableNumber,
  summary: nullableString,
  output_tail: nullableString,
  usage: UsageSchema.nullable().catch(null).default(null),
  lane_state: z.unknown().optional().transform((value): BackgroundLaneState => isLaneState(value) ? value : "closed"),
  parked_until: nullableString,
  created_at: z.string().catch("").default(""),
  updated_at: z.string().catch("").default(""),
  // Not in the contract row yet; each shows only when sent.
  origin_turn_seq: z.number().int().positive().nullable().optional().catch(undefined),
  output_unreadable: z.boolean().optional().catch(undefined),
}).loose();

/** The well-formed rows of a list; a row that does not parse is left out. */
export function parseChatBackgroundTasks(rows: unknown): ChatBackgroundTask[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = ChatBackgroundTaskSchema.safeParse(row);
    return parsed.success ? [parsed.data as ChatBackgroundTask] : [];
  });
}

/**
 * The read endpoint's answer, also the `chat:background_tasks` payload:
 * `{session_id, running, rows}`. `running` falls back to the running rows.
 */
export const ChatBackgroundTasksSnapshotSchema = z.object({
  session_id: z.string(),
  running: z.number().int().nonnegative().optional().catch(undefined),
  rows: z.unknown().transform(parseChatBackgroundTasks),
}).loose().transform((value): ChatBackgroundTasksSnapshot => ({
  session_id: value.session_id,
  rows: value.rows,
  running: value.running ?? value.rows.filter((row) => row.status === "running" || row.status === "paused").length,
}));

// ── Slash-command catalogue (ADR 0025) ──────────────────────────────────────
//
// `GET /api/chat/slash-commands`: display data for the composer menu. One
// malformed command is left out; an unknown `state` reads as `none` and an
// unknown kind as a plain command. A body without a command list is a broken
// answer, never an empty catalogue.
const SlashCommandEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().catch(""),
  hint: z.string().nullable().catch(null).default(null),
  kind: z.enum(["command", "skill", "mcp_prompt"]).catch("command"),
  skill_id: z.string().min(1).optional().catch(undefined),
}).loose();

export const ChatSlashCommandsSchema = z.object({
  state: z.enum(["session", "preview", "none"]).catch("none"),
  provider: z.string().nullable().catch(null).default(null),
  reported_at: z.string().nullable().catch(null).default(null),
  commands: z.array(z.unknown()).transform((rows): SlashCommandEntry[] => rows.flatMap((row) => {
    const parsed = SlashCommandEntrySchema.safeParse(row);
    if (!parsed.success) return [];
    const { name, description, hint, kind, skill_id } = parsed.data;
    return [{ name, description, hint, kind, ...(skill_id ? { skill_id } : {}) }];
  })),
}).loose().transform((value): ChatSlashCommandsResponse => ({
  state: value.state, provider: value.provider, reported_at: value.reported_at, commands: value.commands,
}));
