import type {
  CommandAction,
  FileChange,
  TraceAgentMessageItem,
  TraceCommandItem,
  TraceFileChangeItem,
  TraceItem,
  TraceReasoningItem,
  TraceToolItem,
  TraceWebSearchItem,
} from "@multiremi/contracts/trace";
import { isProcessItem } from "@multiremi/shared/turn-trace";
import {
  agentControl,
  describeStep,
  isHiddenStep,
  stepCategory,
  subagentResolver,
  summarizeSteps,
  type AgentControl,
  type AgentResolver,
  type StepCategory,
  type StepDescriptor,
  type StepSummaryFragment,
} from "@multiremi/shared/trace-step-copy";

/**
 * The Chat steps fold over a turn + items trace (PR 2 spec §4.1, PLAN §2).
 *
 * - Split: the process is every top-level item except the final reply, the
 *   user's message and the permission / question exchanges (Chat has its own
 *   message, dock and question UI). The card's `process_item_count` counts the
 *   same items minus reasoning, which draws no row (spec §10 D-count), so the
 *   finished fold renders exactly when it has rows.
 * - Rows: a command gives one row per parsed action (`${id}:${i}`), or one row
 *   under its own label when the model wrote one (`command.title`); a file
 *   change one row per file, web searches and other tools one row each. A
 *   tool call that messages, interrupts, resumes, closes or lists subagents is
 *   an agent-control row (PR 5 §6.1, shared `agentControl`) whose target reads
 *   as the subagent's name; a hidden step (Codex `wait`) gives no row.
 *   Reasoning gives no row; it only feeds the live label. Commentary, context
 *   compaction, subagents (one-line rows that open the subagent panel), the
 *   plan and notices are breaker blocks.
 * - Groups: two or more consecutive step rows share one collapsed summary row;
 *   a single row stands alone. Reasoning does not break a run, a breaker does.
 *
 * Pure: the components in `turn-step-list.tsx` / `turn-steps-fold.tsx` render it.
 */

export type StepItem = TraceCommandItem | TraceFileChangeItem | TraceWebSearchItem | TraceToolItem;

/** Icon of a row or breaker; the components map it to a glyph. */
export type StepIconKind =
  | "read"
  | "search"
  | "list"
  | "command"
  | "stopped"
  | "edit"
  | "web"
  | "tool"
  | "subagent"
  | "compaction"
  | "plan"
  | "notice"
  | "agent_message"
  | "agent_interrupt"
  | "agent_resume"
  | "agent_close"
  | "agent_list";

export interface StepRow {
  key: string;
  item: StepItem;
  /** The parsed action of a command row, or the file of a file-change row. */
  part?: CommandAction | FileChange;
  descriptor: StepDescriptor;
  category: StepCategory;
  icon: StepIconKind;
  /** The item is still in progress. */
  active: boolean;
  /** What an agent-control row does to which subagent (PR 5); absent on other rows. */
  control?: AgentControl;
}

export type BreakerItem = Exclude<TraceItem, StepItem>;

export type StepBlock =
  | { kind: "group"; key: string; rows: StepRow[]; active: boolean }
  | { kind: "row"; key: string; row: StepRow }
  | { kind: "breaker"; key: string; item: BreakerItem; descriptor: StepDescriptor; icon: StepIconKind | null };

export interface TurnSteps {
  blocks: StepBlock[];
  /** Every step row, in order. */
  rows: StepRow[];
  /** The last reasoning item of the process, for the live label. */
  lastReasoning: TraceReasoningItem | null;
  /** Top-level final replies (`phase: "final"`), in order. */
  finals: TraceAgentMessageItem[];
  /**
   * Process items that draw something: reasoning and empty messages excluded,
   * as the card's `process_item_count` counts (spec §10 D-count).
   */
  processCount: number;
  /**
   * The last item that draws something is a breaker still in progress (a
   * streaming message, a running subagent or compaction): it shows its own
   * progress, so no "thinking" line goes under it. A background subagent does
   * not count: it does not hold its caller.
   */
  breakerRunning: boolean;
  /**
   * Only background subagents are still in progress and the last thing the
   * caller did was a finished message: it waits for them, and the fold header
   * says so (「· N 个后台子代理运行中」) instead of a "thinking" line.
   */
  waitingOnBackground: boolean;
  /** Names the subagent a control row targets; built from every item of the trace. */
  resolveAgent: AgentResolver;
}

const STEP_TYPES: ReadonlySet<TraceItem["type"]> = new Set(["command", "file_change", "web_search", "tool"]);

export function isStepItem(item: TraceItem): item is StepItem {
  return STEP_TYPES.has(item.type);
}

function isFinal(item: TraceItem): item is TraceAgentMessageItem {
  return item.type === "agent_message" && item.parent_id === null && item.phase === "final";
}

function actionIcon(action: CommandAction | undefined): StepIconKind {
  switch (action?.type) {
    case "read": return "read";
    case "search": return "search";
    case "list_files": return "list";
    default: return "command";
  }
}

function row(item: StepItem, key: string, part?: CommandAction | FileChange, resolveAgent?: AgentResolver): StepRow {
  const descriptor = describeStep(item, part, resolveAgent);
  const category = stepCategory(item, part, resolveAgent) ?? "tool";
  const control = item.type === "tool" ? agentControl(item, resolveAgent) ?? undefined : undefined;
  if (control && control.kind !== "wait") {
    return { key, item, part, descriptor, category, icon: `agent_${control.kind}`, active: item.status === "in_progress", control };
  }
  let icon: StepIconKind;
  switch (item.type) {
    case "command":
      // Runs (including a refused read: Codex sends declined to the command
      // branch) use the terminal glyph, or the stop glyph once interrupted. A
      // titled command keeps its single action's glyph.
      if (descriptor.key.startsWith("run_")) icon = item.status === "stopped" ? "stopped" : "command";
      else if (descriptor.key.startsWith("titled_")) {
        icon = item.status === "stopped" ? "stopped" : actionIcon(item.actions.length === 1 ? item.actions[0] : undefined);
      } else icon = actionIcon(part as CommandAction | undefined);
      break;
    case "file_change": icon = "edit"; break;
    case "web_search": icon = "web"; break;
    default: icon = "tool";
  }
  return { key, item, part, descriptor, category, icon, active: item.status === "in_progress" };
}

/**
 * The step rows one item contributes; empty for anything that is not a step
 * and for a hidden step. `resolveAgent` ({@link subagentResolver}) names the
 * subagent a control row targets.
 */
export function stepRows(item: TraceItem, resolveAgent?: AgentResolver): StepRow[] {
  switch (item.type) {
    case "command": {
      // A command the model labelled (Claude's Bash description) is one row
      // under that label, with the whole command in its detail (PR 2 §13).
      if (item.title?.trim()) return [row(item, `${item.id}:0`)];
      // A refused command is one row; so is a command whose text is not parsed yet.
      if (item.status === "declined" || item.actions.length <= 1) return [row(item, `${item.id}:0`, item.actions[0])];
      return item.actions.map((action, index) => row(item, `${item.id}:${index}`, action));
    }
    case "file_change":
      if (item.changes.length <= 1) return [row(item, `${item.id}:0`, item.changes[0])];
      return item.changes.map((change, index) => row(item, `${item.id}:${index}`, change));
    case "web_search":
      return [row(item, item.id)];
    case "tool":
      return isHiddenStep(item) ? [] : [row(item, item.id, undefined, resolveAgent)];
    default:
      return [];
  }
}

function breakerIcon(item: BreakerItem): StepIconKind | null {
  switch (item.type) {
    case "subagent": return "subagent";
    case "compaction": return "compaction";
    case "plan": return "plan";
    case "notice": return "notice";
    default: return null;
  }
}

/** Items that draw nothing: reasoning (live label only), empty messages and hidden steps. */
function isSilent(item: TraceItem): boolean {
  if (item.type === "reasoning" || isHiddenStep(item)) return true;
  return item.type === "agent_message" && !item.text.trim();
}

const isBackgroundSubagent = (item: TraceItem): boolean => item.type === "subagent" && item.background === true;

/** Fold rows into blocks: runs of two or more step rows become a group. */
export function groupSteps(entries: ReadonlyArray<StepRow | { breaker: BreakerItem }>, resolveAgent?: AgentResolver): StepBlock[] {
  const blocks: StepBlock[] = [];
  let run: StepRow[] = [];
  const flush = () => {
    if (run.length > 1) blocks.push({ kind: "group", key: `group:${run[0]!.key}`, rows: run, active: run.some((r) => r.active) });
    else if (run.length === 1) blocks.push({ kind: "row", key: `row:${run[0]!.key}`, row: run[0]! });
    run = [];
  };
  for (const entry of entries) {
    if ("breaker" in entry) {
      flush();
      const item = entry.breaker;
      blocks.push({ kind: "breaker", key: `item:${item.id}`, item, descriptor: describeStep(item, undefined, resolveAgent), icon: breakerIcon(item) });
    } else {
      run.push(entry);
    }
  }
  flush();
  return blocks;
}

/** `all` is every item of the trace, at any depth: control rows name their target from it. */
function buildSteps(process: readonly TraceItem[], finals: TraceAgentMessageItem[], all: readonly TraceItem[]): TurnSteps {
  const resolveAgent = subagentResolver(all);
  const entries: Array<StepRow | { breaker: BreakerItem }> = [];
  const rows: StepRow[] = [];
  let lastReasoning: TraceReasoningItem | null = null;
  let processCount = 0;
  let breakerRunning = false;
  // The last item the caller produced (reasoning included), and what is still running.
  let tail: TraceItem | null = null;
  let backgroundRunning = false;
  let otherRunning = false;
  for (const item of process) {
    if (item.type === "reasoning") {
      lastReasoning = item;
      tail = item;
    }
    if (isSilent(item)) continue;
    processCount++;
    tail = item;
    if (item.status === "in_progress") {
      if (isBackgroundSubagent(item)) backgroundRunning = true;
      else otherRunning = true;
    }
    if (isStepItem(item)) {
      const itemRows = stepRows(item, resolveAgent);
      rows.push(...itemRows);
      entries.push(...itemRows);
      breakerRunning = false;
    } else {
      entries.push({ breaker: item as BreakerItem });
      // A background subagent does not hold its caller: what the caller does
      // next (thinking, reasoning) still shows.
      breakerRunning = item.status === "in_progress" && !isBackgroundSubagent(item);
    }
  }
  const waitingOnBackground = backgroundRunning && !otherRunning
    && tail?.type === "agent_message" && tail.status !== "in_progress";
  return { blocks: groupSteps(entries, resolveAgent), rows, lastReasoning, finals, processCount, breakerRunning, waitingOnBackground, resolveAgent };
}

/** The top-level fold of a turn: process blocks plus the final replies. */
export function buildTurnSteps(items: readonly TraceItem[]): TurnSteps {
  const process: TraceItem[] = [];
  const finals: TraceAgentMessageItem[] = [];
  for (const item of items) {
    if (isFinal(item)) finals.push(item);
    // Reasoning is read here whether or not the shared count includes it.
    else if (isProcessItem(item) || (item.type === "reasoning" && item.parent_id === null)) process.push(item);
  }
  return buildSteps(process, finals, items);
}

const NESTED_HIDDEN: ReadonlySet<TraceItem["type"]> = new Set(["user_message", "permission", "question"]);

export interface ChildStepsOptions {
  /** Leave this item out: the reply the subagent panel shows below the fold. */
  excludeId?: string | null;
  /** The subagent's direct children to use, when only a part of them (one generation) is wanted. */
  children?: readonly TraceItem[];
}

/**
 * The steps a subagent ran, for its detail in the subagent panel. Subagent
 * text is never final. Its instructions (`user_message`), permissions and
 * questions draw no row.
 */
export function buildChildSteps(items: readonly TraceItem[], parentId: string, options: ChildStepsOptions = {}): TurnSteps {
  const children = options.children ?? items.filter((item) => item.parent_id === parentId);
  return buildSteps(children.filter((item) => !NESTED_HIDDEN.has(item.type) && item.id !== options.excludeId), [], items);
}

// ── Summaries and the live label ────────────────────────────────────────────

/**
 * Summary fragments of a finished group, in the fixed category order. Pass
 * the steps' `resolveAgent` so control rows group as they were labelled.
 */
export function groupSummary(rows: readonly StepRow[], resolveAgent?: AgentResolver): StepSummaryFragment[] {
  return summarizeSteps(rows.map((r) => ({ item: r.item, part: r.part })), resolveAgent);
}

/** Join fragments with the locale's separator (zh "，", ja "、", en/ko ", "). */
export function joinSummary(
  fragments: readonly StepSummaryFragment[],
  translate: (fragment: StepSummaryFragment) => string,
  separator: string,
  empty: string,
): string {
  return fragments.length ? fragments.map(translate).join(separator) : empty;
}

/** Icon of a finished group: the first fragment's category. */
export function groupIcon(rows: readonly StepRow[], resolveAgent?: AgentResolver): StepIconKind {
  const first = groupSummary(rows, resolveAgent)[0]?.category;
  return rows.find((r) => r.category === first)?.icon ?? rows[0]?.icon ?? "tool";
}

/**
 * The last line of a reasoning summary with its markdown stripped, or null.
 * Codex shows the latest reasoning heading in place of "Thinking".
 */
export function reasoningHeadline(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim())
    .filter((line) => line && !/^<!--[\s\S]*-->$/.test(line));
  const last = lines.at(-1);
  if (!last) return null;
  const plain = last
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();
  return plain || null;
}

export type LiveLabel =
  | { id: string; kind: "step"; descriptor: StepDescriptor; icon: StepIconKind }
  | { id: string; kind: "reasoning"; text: string }
  | { id: "thinking"; kind: "thinking" }
  /** A breaker in progress shows its own progress: no label line at all. */
  | { id: "quiet"; kind: "quiet" };

/**
 * What a running turn is doing now: the last in-progress row's active copy;
 * else `quiet` while a breaker is still in progress (a streaming message, a
 * running subagent or compaction shows its own progress) or while the caller
 * only waits for background subagents (the fold header says so); else the
 * last line of the last reasoning item; else "Thinking".
 */
export function liveLabel(steps: Pick<TurnSteps, "rows" | "lastReasoning" | "breakerRunning"> & Partial<Pick<TurnSteps, "waitingOnBackground">>): LiveLabel {
  for (let i = steps.rows.length - 1; i >= 0; i--) {
    const r = steps.rows[i]!;
    if (r.active) return { id: `step:${r.key}`, kind: "step", descriptor: r.descriptor, icon: r.icon };
  }
  if (steps.breakerRunning || steps.waitingOnBackground) return { id: "quiet", kind: "quiet" };
  const headline = steps.lastReasoning ? reasoningHeadline(steps.lastReasoning.text) : null;
  if (headline) return { id: `reasoning:${headline}`, kind: "reasoning", text: headline };
  return { id: "thinking", kind: "thinking" };
}

/** The row an activity label belongs to, or null for thinking. */
export function labelRowKey(label: LiveLabel | null): string | null {
  return label?.kind === "step" ? label.id.slice("step:".length) : null;
}

/**
 * The block that shows the live label: the block holding the labelled row —
 * also while a finished row's label is still held — or null for the trailing
 * line (thinking, reasoning).
 */
export function liveBlockKey(steps: Pick<TurnSteps, "blocks">, label: LiveLabel | null): string | null {
  const rowKey = labelRowKey(label);
  if (!rowKey) return null;
  for (const block of steps.blocks) {
    if (block.kind === "group" && block.rows.some((r) => r.key === rowKey)) return block.key;
    if (block.kind === "row" && block.row.key === rowKey) return block.key;
  }
  return null;
}

// ── Timing ──────────────────────────────────────────────────────────────────

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export type FoldHeader =
  | { kind: "working" }
  | { kind: "working_for"; ms: number }
  | { kind: "worked_for"; ms: number }
  | { kind: "stopped_after"; ms: number }
  | { kind: "steps" };

/**
 * The live fold's title (Codex "Working" / "Working for" / "Worked for"):
 * under a second "Working", then "Working for {t}" until the first final reply
 * starts, then "Worked for {final.started_at - turn.started_at}". A cancelled
 * turn reads "Stopped after {t}"; a turn that ended without a final reply
 * reads "Worked for" its duration.
 */
export function liveFoldHeader(
  turn: { started_at: string; status: string; completed_at: string | null; duration_ms: number | null },
  finals: readonly TraceAgentMessageItem[],
  now: number,
): FoldHeader {
  const start = parseTime(turn.started_at);
  if (start === null) return { kind: "steps" };
  const finalStart = parseTime(finals[0]?.started_at);
  if (finalStart !== null) return { kind: "worked_for", ms: Math.max(0, finalStart - start) };
  if (turn.status === "running") {
    const elapsed = Math.max(0, now - start);
    return elapsed < 1000 ? { kind: "working" } : { kind: "working_for", ms: elapsed };
  }
  const end = parseTime(turn.completed_at);
  const duration = turn.duration_ms ?? (end !== null ? Math.max(0, end - start) : null);
  if (duration === null) return { kind: "steps" };
  return turn.status === "cancelled" ? { kind: "stopped_after", ms: duration } : { kind: "worked_for", ms: duration };
}

/**
 * The finished card's title: "Worked for {worked_ms ?? elapsed_ms}". A
 * cancelled turn reads the neutral "Steps": its notice already says it was
 * cancelled.
 */
export function finishedFoldHeader(meta: { status: string | null; workedMs: number | null; elapsedMs: number | null }): FoldHeader {
  if (meta.status === "cancelled") return { kind: "steps" };
  const ms = meta.workedMs ?? meta.elapsedMs;
  return ms != null ? { kind: "worked_for", ms } : { kind: "steps" };
}

// ── Waiting on a person ─────────────────────────────────────────────────────

/** The last top-level item is a permission or question the agent is waiting on. */
export function isAwaitingHuman(items: readonly TraceItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.parent_id !== null) continue;
    return (item.type === "permission" || item.type === "question") && item.status === "in_progress";
  }
  return false;
}
