/** Cursor inbox deep links select one canonical message, without grouping or automatic reads. */
export interface InboxCandidateInput { id?: string; session_id?: string; message_kind?: string; deleted_at?: string | null }
export interface DeepLinkCandidate {
  inboxItemId: string; commentId: string; sessionId: string;
  apiIndex: number; type: string;
}
export function rankDeepLinkCandidates(items: readonly InboxCandidateInput[], _runningIssueIds: ReadonlySet<string>): DeepLinkCandidate[] {
  const byId = new Map<string, DeepLinkCandidate>();
  items.forEach((item, index) => {
    const candidate = toDeepLinkCandidate(item, item.id ?? "", index);
    if (candidate && !byId.has(candidate.inboxItemId)) byId.set(candidate.inboxItemId, candidate);
  });
  return [...byId.values()];
}
export function toDeepLinkCandidate(item: InboxCandidateInput, id: string, apiIndex: number): DeepLinkCandidate | null {
  return id && item.session_id && !item.deleted_at ? { inboxItemId: id, commentId: id, sessionId: item.session_id, apiIndex, type: item.message_kind ?? "request" } : null;
}
