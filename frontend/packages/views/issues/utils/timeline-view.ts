import type { TimelineEntry } from "@multiremi/core/types";
import type { CommentParentRef } from "../components/comment-card";
import { quotePreview } from "./quote-preview";

/**
 * Flat per-item shape consumed by `<Virtuoso>`. Virtuoso needs a flat array
 * where each entry is one rendered row; we keep the grouping logic from
 * `TimelineView.groups` (consecutive same-actor activities still collapse into
 * one activity-group row) but project it into a discriminated union the
 * itemContent dispatcher can switch on.
 */
export type TimelineItem =
  | { kind: "comment"; id: string; entry: TimelineEntry }
  | { kind: "resolved-bar"; id: string; entry: TimelineEntry }
  | { kind: "activity-group"; id: string; entries: TimelineEntry[] };

export type TimelineGroup = {
  type: "comment" | "activities";
  entries: TimelineEntry[];
};

export interface TimelineView {
  /** Maps a reply's id to a description of the comment it answers. */
  parentRefs: Map<string, CommentParentRef>;
  /** Ids of comments that have at least one loaded answer. */
  parentIds: Set<string>;
  groups: TimelineGroup[];
}

// Coalesce consecutive activities from the same actor + action.
// - task_completed / task_failed: no time limit (these repeat across runs)
// - all other actions: within a 2-minute window
// - squad_leader_evaluated: never coalesce; outcome/reason are audit data
const COALESCE_MS = 2 * 60 * 1000;
const NO_TIME_LIMIT_ACTIONS = new Set(["task_completed", "task_failed"]);
const NEVER_COALESCE_ACTIONS = new Set(["squad_leader_evaluated"]);

/**
 * Projects a raw timeline into what the stream renders. A session is already
 * one parallel track, so the timeline inside it is a single chronological
 * stream: every comment — root or reply — is an entry of its own, in
 * `created_at` order, exactly as the server returned it. Nothing is hoisted
 * under a parent.
 *
 * Threading survives as metadata only: `parentRefs` maps a reply's id to the
 * comment it answers (author + opening slice), and `parentIds` records which
 * comments have answers so the delete dialog can warn about the cascade.
 */
export function buildTimelineView(timeline: readonly TimelineEntry[]): TimelineView {
  const byId = new Map<string, TimelineEntry>();
  for (const e of timeline) {
    if (e.type === "comment") byId.set(e.id, e);
  }
  const parentRefs = new Map<string, CommentParentRef>();
  const parentIds = new Set<string>();
  for (const e of timeline) {
    if (e.type !== "comment" || !e.parent_id) continue;
    const parent = byId.get(e.parent_id);
    // A parent outside the loaded window cannot be described, so the reply
    // renders chip-less rather than pointing at a blank.
    if (!parent) continue;
    parentIds.add(parent.id);
    parentRefs.set(e.id, {
      id: parent.id,
      actorType: parent.actor_type,
      actorId: parent.actor_id,
      preview: quotePreview(parent.content ?? ""),
    });
  }

  const coalesced: TimelineEntry[] = [];
  for (const entry of timeline) {
    if (entry.type === "activity") {
      const prev = coalesced[coalesced.length - 1];
      if (
        !NEVER_COALESCE_ACTIONS.has(entry.action!) &&
        prev?.type === "activity" &&
        prev.action === entry.action &&
        prev.actor_type === entry.actor_type &&
        prev.actor_id === entry.actor_id &&
        (NO_TIME_LIMIT_ACTIONS.has(entry.action!) ||
          Math.abs(new Date(entry.created_at).getTime() - new Date(prev.created_at).getTime()) <= COALESCE_MS)
      ) {
        coalesced[coalesced.length - 1] = { ...entry, coalesced_count: (prev.coalesced_count ?? 1) + 1 };
        continue;
      }
    }
    coalesced.push(entry);
  }

  // Group consecutive activities together so the connector line works
  const groups: TimelineGroup[] = [];
  for (const entry of coalesced) {
    if (entry.type === "activity") {
      const last = groups[groups.length - 1];
      if (last?.type === "activities") {
        last.entries.push(entry);
      } else {
        groups.push({ type: "activities", entries: [entry] });
      }
    } else {
      groups.push({ type: "comment", entries: [entry] });
    }
  }

  return { parentRefs, parentIds, groups };
}

export function flattenGroups(
  groups: ReadonlyArray<TimelineGroup>,
  expandedResolved: ReadonlySet<string>,
): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const group of groups) {
    if (group.type === "comment") {
      const entry = group.entries[0]!;
      const isResolved = !!entry.resolved_at;
      const isExpanded = expandedResolved.has(entry.id);
      out.push(
        isResolved && !isExpanded
          ? { kind: "resolved-bar", id: entry.id, entry }
          : { kind: "comment", id: entry.id, entry },
      );
    } else {
      out.push({
        kind: "activity-group",
        id: group.entries[0]!.id,
        entries: group.entries,
      });
    }
  }
  return out;
}

/** Id of the trailing activity block — the only one expanded by default. */
export function lastActivityGroupId(groups: ReadonlyArray<TimelineGroup>): string | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g.type === "activities") return g.entries[0]!.id;
  }
  return null;
}
