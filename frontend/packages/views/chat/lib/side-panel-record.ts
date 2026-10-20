import type { TraceItem } from "@multiremi/contracts/trace";
import type { SubagentPanelTarget } from "@multiremi/core/chat";
import { rowDoorbell } from "./background-tasks";
import { plainText } from "./subagents";

/**
 * What a chat has on record for its side panel (子代理 / 后台任务), read only
 * from what the page already holds: the loaded log window's turn cards and
 * rows, and the running turn's live trace. Nothing here reads a trace or the
 * background-task registry (MUL-472); the panel reads a turn's trace only
 * once its group is opened. Pure.
 *
 * A turn ran subagents when its card's `type_histogram` (the trace stats the
 * daemon reports at completion, PR 2) has a `subagent` bucket, when its card
 * lists `late_subagents` (PR 5), or, while it runs, when its live trace holds
 * a subagent item. Turns outside the loaded window, and cards that predate
 * the trace stats, are not on record.
 */

type LogRow = {
  kind: string;
  seq?: number;
  task_id?: string | null;
  author_type?: string | null;
  sender_type?: string | null;
  body_md?: string | null;
  created_at?: string | null;
  metadata?: unknown;
};

/** A turn that ran subagents: one group of the panel's chat-wide overview. */
export interface SubagentTurnRef {
  attemptId: string;
  turnId?: string;
  /** The running turn: its trace follows the socket. */
  live: boolean;
  /** When the turn was created (its card's `created_at`), in ms; null when unknown. */
  startedAt: number | null;
  /** The prompt that started it, plain text on one line; null when unknown. */
  prompt: string | null;
}

/** The running turn, as the page follows it. */
export interface LiveTurnRef {
  attemptId: string;
  turnId?: string;
  /** Its live trace holds a subagent item. */
  hasSubagents: boolean;
  /** When its trace says it started; used before its card is in the window. */
  startedAt?: string | null;
}

/** What the header toggle and the panel's overview know about a chat. */
export interface ChatPanelRecord {
  /** Turns that ran subagents, newest first ({@link chatSubagentTurns}). */
  turns: readonly SubagentTurnRef[];
  /**
   * The chat has background tasks on record: the session list counts one
   * running, the registry cache has rows, or the loaded window shows one
   * ({@link logHasBackgroundTasks}).
   */
  tasks: boolean;
}

export const EMPTY_PANEL_RECORD: ChatPanelRecord = Object.freeze({ turns: Object.freeze([]) as readonly SubagentTurnRef[], tasks: false });

/**
 * Where the header toggle opens the panel: the chat-wide 子代理 overview with
 * the newest turn that ran subagents in front, else the 后台任务 view.
 */
export function defaultPanelTarget(sessionId: string, record: ChatPanelRecord): SubagentPanelTarget {
  const newest = record.turns[0];
  return newest
    ? { sessionId, view: "subagents", attemptId: newest.attemptId, turnId: newest.turnId, live: newest.live, path: [] }
    : { sessionId, view: "tasks", attemptId: null, live: false, path: [], task: null };
}

/**
 * The overview's turns: the record's, with the attempt the panel was opened
 * on in front when the record does not hold it (a panel opened without one).
 */
export function overviewTurns(turns: readonly SubagentTurnRef[], target: Pick<SubagentPanelTarget, "attemptId" | "turnId" | "live">): readonly SubagentTurnRef[] {
  const attemptId = target.attemptId;
  if (!attemptId || turns.some((turn) => turn.attemptId === attemptId)) return turns;
  return [{ attemptId, turnId: target.turnId, live: target.live, startedAt: null, prompt: null }, ...turns];
}

const PROMPT_MAX = 120;

function metadataOf(row: LogRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
}

function histogramHas(value: unknown, type: string): boolean {
  return Array.isArray(value) && value.some((bucket) => !!bucket && typeof bucket === "object"
    && (bucket as { type?: unknown }).type === type && Number((bucket as { count?: unknown }).count) > 0);
}

/** A `late_subagents` list (PR 5) with at least one entry naming its item. */
function hasLateSubagents(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => !!entry && typeof entry === "object"
    && typeof (entry as { item_id?: unknown }).item_id === "string");
}

/** Whether a turn card's facts say it ran subagents. */
export function turnCardHasSubagents(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return histogramHas(meta.type_histogram, "subagent") || hasLateSubagents(meta.late_subagents);
}

/** Whether a turn card's facts say it started a background task (PR 6). */
export function turnCardHasBackgroundTasks(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return histogramHas(meta.type_histogram, "background_task");
}

/** The first line of a prompt, plain and capped; null when it has no words. */
export function promptLine(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const first = markdown.split("\n").map(plainText).find(Boolean);
  if (!first) return null;
  const chars = [...first];
  return chars.length > PROMPT_MAX ? `${chars.slice(0, PROMPT_MAX).join("")}…` : first;
}

function isMember(row: LogRow): boolean {
  return row.kind === "message" && (row.sender_type ?? row.author_type) === "member";
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The turns of the loaded window that ran subagents, newest first, plus the
 * running turn when its live trace has a subagent (also before its card is
 * in the window). Each carries its time and the first line of its prompt:
 * the member message delivered into it (`delivery_turn_id`), else the card's
 * `legacy_prompt`.
 */
export function chatSubagentTurns(entries: ReadonlyArray<LogRow>, live: LiveTurnRef | null = null): SubagentTurnRef[] {
  const prompts = new Map<string, string>();
  for (const row of entries) {
    if (!isMember(row)) continue;
    const turnId = metadataOf(row).delivery_turn_id;
    if (typeof turnId !== "string" || prompts.has(turnId)) continue;
    const line = promptLine(row.body_md);
    if (line) prompts.set(turnId, line);
  }
  const liveHasSubagents = !!live?.hasSubagents;
  const turns: SubagentTurnRef[] = [];
  let liveSeen = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const row = entries[index]!;
    if (row.kind !== "turn" || !row.task_id) continue;
    const meta = metadataOf(row);
    const turnId = typeof meta.turn_id === "string" ? meta.turn_id : undefined;
    const isLive = !!live && live.attemptId === row.task_id;
    if (isLive) liveSeen = true;
    if (!(turnCardHasSubagents(meta) || (isLive && liveHasSubagents))) continue;
    turns.push({
      attemptId: row.task_id,
      ...(turnId ? { turnId } : {}),
      live: isLive,
      startedAt: time(row.created_at),
      prompt: (turnId ? prompts.get(turnId) : undefined) ?? promptLine(typeof meta.legacy_prompt === "string" ? meta.legacy_prompt : null),
    });
  }
  if (live && liveHasSubagents && !liveSeen) {
    turns.unshift({
      attemptId: live.attemptId,
      ...(live.turnId ? { turnId: live.turnId } : {}),
      live: true,
      startedAt: time(live.startedAt),
      prompt: live.turnId ? prompts.get(live.turnId) ?? null : null,
    });
  }
  return turns;
}

/**
 * Whether the loaded window shows a background task: a turn card that
 * started one, or a doorbell line for one that ended. The session list's
 * running count and the registry cache add to this where the page has them.
 */
export function logHasBackgroundTasks(entries: ReadonlyArray<LogRow>): boolean {
  return entries.some((row) => (row.kind === "turn" && turnCardHasBackgroundTasks(row.metadata)) || rowDoorbell(row) !== null);
}

/** Running subagents as the running strip counts them: top-level ones, else nested ones. */
export function runningSubagentCount(items: readonly TraceItem[]): number {
  let top = 0;
  let nested = 0;
  for (const item of items) {
    if (item.type !== "subagent" || item.status !== "in_progress") continue;
    if (item.parent_id === null) top++;
    else nested++;
  }
  return top || nested;
}

/** The first top-level prompt of a trace, for a group whose card did not name one. */
export function tracePromptLine(items: readonly TraceItem[]): string | null {
  for (const item of items) {
    if (item.parent_id === null && item.type === "user_message") return promptLine(item.text);
  }
  return null;
}
