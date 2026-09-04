import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { isInboxLedgerType } from "@multiremi/contracts/inbox";
import { inboxKeys } from "./queries";
import type { InboxItem, InboxPage, IssueStatus } from "../types";

function updateInboxCaches(
  qc: QueryClient,
  wsId: string,
  update: (items: InboxItem[]) => InboxItem[],
): void {
  qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), (old) => old ? update(old) : old);
  qc.setQueryData<InfiniteData<InboxPage>>(inboxKeys.pages(wsId), (old) => old
    ? { ...old, pages: old.pages.map((page) => ({ ...page, items: update(page.items) })) }
    : old);
}

export function onInboxNew(
  qc: QueryClient,
  wsId: string,
  _item: InboxItem,
) {
  void qc.invalidateQueries({ queryKey: inboxKeys.all(wsId) });
}

export function onInboxIssueStatusChanged(
  qc: QueryClient,
  wsId: string,
  issueId: string,
  status: IssueStatus,
) {
  updateInboxCaches(qc, wsId, (items) =>
    items.map((i) =>
      i.issue_id === issueId ? { ...i, issue_status: status } : i,
    ),
  );
}

// The server preserves ledger history without a live issue link and removes
// actionable notifications. Apply the same lifecycle immediately in cache.
export function onInboxIssueDeleted(
  qc: QueryClient,
  wsId: string,
  issueId: string,
) {
  updateInboxCaches(qc, wsId, (items) =>
    items.flatMap((item) => {
      if (item.issue_id !== issueId) return [item];
      if (!isInboxLedgerType(item.type)) return [];
      return [{ ...item, issue_id: null, issue_status: null }];
    }),
  );
  void qc.invalidateQueries({ queryKey: inboxKeys.summary(wsId) });
}

export function onInboxInvalidate(qc: QueryClient, wsId: string) {
  void qc.invalidateQueries({ queryKey: inboxKeys.all(wsId) });
}
