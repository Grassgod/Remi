import { issueActivityLayer, type IssueActivityEntry } from "@multiremi/contracts/issue-activity";
import type { TimelineEntry } from "@multiremi/core/types";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { isSystemDetail } from "../components/issue-log-presentation";
import { coalesceActivities } from "./timeline-view";

export type ActivityEvent = { kind: "activity"; entry: TimelineEntry; system: boolean }
  | { kind: "log"; entry: SessionLogRow };
export interface ActivityGroup { id: string; events: ActivityEvent[]; system: boolean; collapsible: boolean }
export type GroupedEvent = { kind: "log"; entry: SessionLogRow } | { kind: "group"; group: ActivityGroup };

const FIELDS = [
  ["status", "status"], ["priority", "priority"], ["start_date", "startDate"], ["due_date", "dueDate"],
  ["title", "title"], ["description", "description"], ["project_id", "projectId"], ["parent_issue_id", "parentIssueId"],
] as const;

export function splitActivity(activity: IssueActivityEntry): TimelineEntry[] {
  const base: TimelineEntry = { ...activity, actor_id: activity.actor_id ?? "", details: activity.details ?? undefined };
  if (activity.action !== "issue_updated") return [base];
  const details = activity.details ?? {};
  const previous = details.previous && typeof details.previous === "object" && !Array.isArray(details.previous)
    ? details.previous as Record<string, unknown> : null;
  return FIELDS.flatMap(([field, camel]) => {
    const key = field in details ? field : camel in details ? camel : field === "parent_issue_id" && "parent_id" in details ? "parent_id" : null;
    if (!key || (previous && !(field in previous))) return [];
    const to = details[key];
    if (previous && previous[field] === to) return [];
    return [{ ...base, id: `${base.id}:${field}`, action: "issue_field_changed", details: {
      field, to, ...(previous ? { from: previous[field] } : {}),
    } }];
  });
}

/** Insert after all same-time rows, keeping the log's seq order authoritative. */
export function placeActivities(entries: readonly SessionLogRow[], activities: readonly IssueActivityEntry[], showSystem: boolean): ActivityEvent[] {
  const rows = entries.filter(entry => showSystem || !isSystemDetail(entry));
  const buckets = new Map<number, ActivityEvent[]>();
  for (const activity of [...activities].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const layer = issueActivityLayer(activity.action);
    if (!layer || (layer === "system" && !showSystem) || isDuplicateAssignment(activity, entries)) continue;
    let index = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i]!.seq === 0 || rows[i]!.created_at <= activity.created_at) index = i;
    const placed = buckets.get(index) ?? [];
    placed.push(...splitActivity(activity).map(entry => ({ kind: "activity" as const, entry, system: layer === "system" })));
    buckets.set(index, placed);
  }
  return [...(buckets.get(-1) ?? []), ...rows.flatMap((entry, index) => [
    { kind: "log" as const, entry }, ...(buckets.get(index) ?? []),
  ])];
}

export function isDuplicateAssignment(activity: IssueActivityEntry, entries: readonly SessionLogRow[]): boolean {
  if (activity.action !== "issue_assigned") return false;
  const d = activity.details ?? {};
  const type = d.to_type ?? d.toType ?? d.assignee_type ?? d.assigneeType;
  const id = d.to_id ?? d.toId ?? d.assignee_id ?? d.assigneeId;
  if (type !== "agent" || typeof id !== "string" || !id) return false;
  return entries.some(row => row.kind === "turn" && !isSystemDetail(row)
    && row.metadata.assignee_agent_id === id
    && Math.abs(Date.parse(row.created_at) - Date.parse(activity.created_at)) <= 10_000
    && (row.author_type === "system" || (row.author_type === activity.actor_type && row.author_id === activity.actor_id)));
}

/** Only conversation activities and delegation rows share a folding run. */
export function groupEvents(events: readonly ActivityEvent[]): GroupedEvent[] {
  const out: GroupedEvent[] = [];
  let run: ActivityEvent[] = [];
  const flush = () => {
    if (!run.length) return;
    const coalesced: ActivityEvent[] = [];
    let activities: TimelineEntry[] = [];
    const flushActivities = () => { coalesced.push(...coalesceActivities(activities).map(entry => ({ kind: "activity" as const, entry, system: false }))); activities = []; };
    for (const event of run) {
      if (event.kind === "activity") activities.push(event.entry);
      else { flushActivities(); coalesced.push(event); }
    }
    flushActivities();
    out.push({ kind: "group", group: { id: run[0]!.entry.id, events: coalesced, system: false, collapsible: coalesced.length >= 3 } });
    run = [];
  };
  for (const event of events) {
    const second = event.kind === "activity" ? !event.system : event.entry.kind === "turn" && !isSystemDetail(event.entry);
    if (second) run.push(event);
    else {
      flush();
      if (event.kind === "activity") out.push({ kind: "group", group: { id: event.entry.id, events: [event], system: true, collapsible: false } });
      else out.push(event);
    }
  }
  flush();
  return out;
}

/** Trailer rows reuse the preceding log row's measurement and stick anchor. */
export function activityTrails(events: readonly GroupedEvent[]): { entries: SessionLogRow[]; trailers: Map<string, ActivityGroup[]>; latestGroupId: string | null } {
  const entries: SessionLogRow[] = [];
  const trailers = new Map<string, ActivityGroup[]>();
  let latestGroupId: string | null = null;
  for (const event of events) {
    if (event.kind === "log") entries.push(event.entry);
    else {
      if (!event.group.system) latestGroupId = event.group.id;
      const anchor = entries.at(-1)?.id;
      if (!anchor) continue;
      const groups = trailers.get(anchor) ?? [];
      groups.push(event.group);
      trailers.set(anchor, groups);
    }
  }
  return { entries, trailers, latestGroupId };
}
