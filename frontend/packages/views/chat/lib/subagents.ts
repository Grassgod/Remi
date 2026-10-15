import type {
  TraceAgentMessageItem,
  TraceItem,
  TraceSubagentItem,
} from "@multiremi/contracts/trace";
import { isToolItem, subagentReply } from "@multiremi/shared/turn-trace";
import { isHiddenStep } from "@multiremi/shared/trace-step-copy";

/**
 * Subagents of a turn + items trace, for the Chat surfaces of PR 5 (§6.1):
 * the one-line step row, the fold header suffix, the completion row, the
 * running strip and the subagent panel. Pure.
 *
 * Labels use the subagent's `name` (Claude's short description, Codex's agent
 * name); the agent type is optional secondary text, and Claude native child
 * sessions carry neither type nor model (U2), so both hide when empty.
 */

export type SubagentStatus = "running" | "background" | "completed" | "failed" | "stopped";

export function isSubagent(item: TraceItem | undefined | null): item is TraceSubagentItem {
  return item?.type === "subagent";
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** `name` is the primary label; `type` the agent type, when it says something else. */
export function subagentLabel(item: TraceSubagentItem): { name: string; type: string | null } {
  const name = nonBlank(item.name) ?? nonBlank(item.title) ?? item.tool;
  const type = nonBlank(item.agent_type);
  return { name, type: type && type !== name ? type : null };
}

/** Markdown reduced to its words on one line. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const TASK_LINE_MAX = 60;

/**
 * One line of the subagent's task: the first line of its instructions with
 * the Markdown stripped, cut at 60 characters (Codex). Null without
 * instructions, or when they only repeat the name.
 */
export function subagentTaskLine(item: TraceSubagentItem): string | null {
  const prompt = nonBlank(item.prompt);
  if (!prompt) return null;
  const first = prompt.split("\n").map(plainText).find(Boolean);
  if (!first || first === subagentLabel(item).name) return null;
  const chars = [...first];
  return chars.length > TASK_LINE_MAX ? `${chars.slice(0, TASK_LINE_MAX).join("")}…` : first;
}

export function subagentStatus(item: TraceSubagentItem): SubagentStatus {
  switch (item.status) {
    case "in_progress": return item.background === true ? "background" : "running";
    case "failed": return "failed";
    case "stopped":
    case "declined": return "stopped";
    default: return "completed";
  }
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** How long a finished subagent ran (all its generations), or null. */
export function subagentDurationMs(item: TraceSubagentItem): number | null {
  if (item.duration_ms != null) return Math.max(0, item.duration_ms);
  const start = parseTime(item.started_at);
  const end = parseTime(item.completed_at);
  return start !== null && end !== null ? Math.max(0, end - start) : null;
}

/** Subagent item ids from the top-level subagent down to `id` (the panel's path). */
export function subagentPath(items: readonly TraceItem[], id: string): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.type === "subagent") path.unshift(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

/** Running subagents: top-level ones (the strip's chips) and nested ones (its "+N"). */
export function runningSubagents(items: readonly TraceItem[]): { top: TraceSubagentItem[]; nested: TraceSubagentItem[] } {
  const top: TraceSubagentItem[] = [];
  const nested: TraceSubagentItem[] = [];
  for (const item of items) {
    if (item.type !== "subagent" || item.status !== "in_progress") continue;
    (item.parent_id === null ? top : nested).push(item);
  }
  return { top, nested };
}

/**
 * The running subagents in tree order, each with its depth among running
 * ones: a running agent under a finished one moves up a level.
 */
export function runningTree(items: readonly TraceItem[]): Array<{ item: TraceSubagentItem; depth: number }> {
  const byId = new Map(items.map((item) => [item.id, item]));
  // The subagent an item belongs to, through any non-subagent parents.
  const owner = (parentId: string | null): string | null => {
    const seen = new Set<string>();
    let current = parentId ? byId.get(parentId) : undefined;
    while (current && current.type !== "subagent" && !seen.has(current.id)) {
      seen.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return current?.type === "subagent" ? current.id : null;
  };
  const under = new Map<string | null, TraceSubagentItem[]>();
  for (const item of items) {
    if (item.type !== "subagent") continue;
    const key = owner(item.parent_id);
    const list = under.get(key) ?? [];
    list.push(item);
    under.set(key, list);
  }
  const rows: Array<{ item: TraceSubagentItem; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const item of under.get(parent) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const running = item.status === "in_progress";
      if (running) rows.push({ item, depth });
      walk(item.id, running ? depth + 1 : depth);
    }
  };
  walk(null, 0);
  return rows;
}

const FAILURE_TEXT_MAX = 400;

/** Why a subagent failed, as far as it said: the end of its output or reply, at most 400 characters. */
export function subagentFailureText(items: readonly TraceItem[], item: TraceSubagentItem): string | null {
  const text = nonBlank(item.output) ?? nonBlank(subagentReply(items, item.id)?.text);
  if (!text) return null;
  const chars = [...text];
  return chars.length > FAILURE_TEXT_MAX ? `…${chars.slice(-FAILURE_TEXT_MAX).join("")}` : text;
}

/**
 * Background subagents the fold header names: top-level ones still running
 * in the background, and once the final reply has started, any top-level one
 * still running.
 */
export function backgroundRunningCount(items: readonly TraceItem[], finalStarted: boolean): number {
  let count = 0;
  for (const item of items) {
    if (item.type !== "subagent" || item.parent_id !== null || item.status !== "in_progress") continue;
    if (finalStarted || item.background === true) count++;
  }
  return count;
}

/**
 * One generation of a subagent in the panel's detail: the instructions it
 * was given (the spawn prompt, then each instruction a resumed generation
 * received), what it did, and the reply it gave.
 */
export interface SubagentGeneration {
  key: string;
  /** The instructions; null for none (Codex's synthetic task). */
  prompt: string | null;
  startedAt: string;
  /** When the generation ended: the next instructions, else the subagent's end; null while it runs. */
  endedAt: string | null;
  /** The subagent's direct children in this generation, its instructions excluded. */
  children: TraceItem[];
  /** The reply shown under the steps, which the steps then leave out. */
  reply: TraceAgentMessageItem | null;
  /** The last generation of a subagent that is still running. */
  running: boolean;
}

/** The last message with text that no tool call follows, among `children`. */
function replyOf(children: readonly TraceItem[]): TraceAgentMessageItem | null {
  let reply: TraceAgentMessageItem | null = null;
  for (const item of children) {
    if (item.type === "agent_message") {
      if (item.text.trim()) reply = item;
    } else if (isToolItem(item) && !isHiddenStep(item)) {
      reply = null;
    }
  }
  return reply;
}

/**
 * A subagent's detail as a mini conversation. A resumed agent (Claude
 * `SendMessage` to a finished agent) is one item whose later instructions are
 * child `user_message`s; each starts a generation. A generation's reply is
 * its last message with text that no tool call follows; the last generation
 * has one only once the subagent stopped running (the shared `subagentReply`
 * rule).
 */
export function subagentGenerations(items: readonly TraceItem[], item: TraceSubagentItem): SubagentGeneration[] {
  const generations: SubagentGeneration[] = [];
  const start = (key: string, prompt: string | null | undefined, startedAt: string): SubagentGeneration =>
    ({ key, prompt: nonBlank(prompt) ? prompt! : null, startedAt, endedAt: null, children: [], reply: null, running: false });
  let current = start(item.id, item.prompt, item.started_at);
  for (const child of items) {
    if (child.parent_id !== item.id) continue;
    if (child.type === "user_message") {
      current.endedAt = child.started_at;
      generations.push(current);
      current = start(child.id, child.text, child.started_at);
      continue;
    }
    current.children.push(child);
  }
  current.running = item.status === "in_progress";
  current.endedAt = current.running ? null : item.completed_at;
  generations.push(current);
  for (const generation of generations) generation.reply = generation.running ? null : replyOf(generation.children);
  return generations;
}
