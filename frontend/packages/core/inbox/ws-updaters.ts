import type { QueryClient } from "@tanstack/react-query";
import { isInboxLedgerType } from "@multiremi/contracts";
import { inboxKeys } from "./queries";
import type { InboxItem, IssueStatus } from "../types";

export function onInboxNew(
  qc: QueryClient,
  wsId: string,
  _item: InboxItem,
) {
  // Use invalidateQueries instead of setQueryData — triggers a refetch that
  // reliably notifies all observers. The inbox list is small so this is cheap.
  qc.invalidateQueries({ queryKey: inboxKeys.list(wsId) });
}

export function onInboxIssueStatusChanged(
  qc: QueryClient,
  wsId: string,
  issueId: string,
  status: IssueStatus,
) {
  qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), (old) =>
    old?.map((i) =>
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
  qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), (old) =>
    old?.flatMap((item) => {
      if (item.issue_id !== issueId) return [item];
      if (!isInboxLedgerType(item.type)) return [];
      return [{ ...item, issue_id: null, issue_status: null }];
    }),
  );
}

export function onInboxInvalidate(qc: QueryClient, wsId: string) {
  qc.invalidateQueries({ queryKey: inboxKeys.list(wsId) });
}
