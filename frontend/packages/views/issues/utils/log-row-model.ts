import { SessionLogEntrySchema, type SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionLogEntry } from "@multiremi/core/replica";
import type { ActivityGroup } from "./issue-activity-presentation";

/** One schema boundary and one reply-index pass for each immutable snapshot. */
export function buildLogRowModel(entries: readonly SessionLogEntry[]) {
  const rows = entries.map(entry => SessionLogEntrySchema.parse(entry));
  const byId = new Map<string, SessionLogRow>();
  const parentsWithReplies = new Set<string>();
  for (const row of rows) {
    byId.set(row.id, row);
    if (row.parent_id) parentsWithReplies.add(row.parent_id);
  }
  return { rows, byId, parentsWithReplies };
}

export interface TrailChoice { expanded: boolean; showOlder: boolean; truncateOlder: boolean }

/** Keep the existing measurement signature, serializing only changed trails. */
export class TrailSignatureCache {
  private rows = new Map<string, { deps: unknown[]; signature: string }>();
  signature(key: string, groups: readonly ActivityGroup[], choice: (id: string) => TrailChoice | undefined): string {
    const deps: unknown[] = [];
    for (const group of groups) {
      const state = choice(group.id);
      deps.push(group.id, state?.expanded, state?.showOlder, state?.truncateOlder, group.events.length);
      for (const event of group.events) deps.push(event.entry.id, event.entry.created_at, event.kind,
        event.kind === "log" ? event.entry.revision : event.entry.details,
        event.kind === "activity" ? event.entry.coalesced_count : undefined);
    }
    const old = this.rows.get(key);
    if (old && old.deps.length === deps.length && deps.every((dep, index) => Object.is(dep, old.deps[index]))) return old.signature;
    const signature = groups.length ? `:trail:${JSON.stringify(groups.map(group => [group.id, choice(group.id), group.events.map(event =>
      [event.entry.id, event.entry.created_at, event.kind === "log" ? event.entry.revision : [event.entry.details, event.entry.coalesced_count]])]))}` : "";
    this.rows.set(key, { deps, signature });
    return signature;
  }
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.rows.keys()) if (!keys.has(key)) this.rows.delete(key);
  }
}
