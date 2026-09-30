import { expect } from "bun:test";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";

export function inboxReportEntry(store: MultiremiStore, task: MultiremiTask, sourceTaskId: string) {
  const entries = store.listIssueComments(task.issueId!)
    .filter(comment => comment.authorType === "system" && comment.issueSessionId === task.issueSessionId)
    .flatMap(comment => {
      const entry = store.getConversationLogEntryById(comment.id);
      return entry?.metadata.envelope?.source.taskId === sourceTaskId ? [entry] : [];
    });
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

/** Assert reports are durable envelopes on the recipient session's log. */
export function inboxReportBody(store: MultiremiStore, task: MultiremiTask, sourceTaskId?: string): string {
  const comments = store.listIssueComments(task.issueId!)
    .filter(comment => comment.authorType === "system" && comment.issueSessionId === task.issueSessionId);
  const envelopes = comments.filter(comment => {
    const envelope = store.getConversationLogEntryById(comment.id)?.metadata.envelope;
    return envelope && (sourceTaskId === undefined || envelope.source.taskId === sourceTaskId);
  });
  expect(envelopes.length).toBeGreaterThan(0);
  return envelopes.map(comment => {
    const entry = store.getConversationLogEntryById(comment.id)!;
    expect(entry.body_md).toBe(comment.body);
    return entry.body_md;
  }).join("\n\n");
}
