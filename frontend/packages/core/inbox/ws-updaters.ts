import type { QueryClient } from "@tanstack/react-query";
import { inboxKeys } from "./queries";
import type { InboxItem, IssueStatus } from "../types";
export function onInboxNew(qc: QueryClient, wsId: string, _item: InboxItem) { onInboxInvalidate(qc, wsId); }
export function onInboxIssueStatusChanged(qc: QueryClient, wsId: string, _issueId: string, _status: IssueStatus) { onInboxInvalidate(qc, wsId); }
export function onInboxIssueDeleted(qc: QueryClient, wsId: string, _issueId: string) { onInboxInvalidate(qc, wsId); }
export function onInboxInvalidate(qc: QueryClient, wsId: string) { void qc.invalidateQueries({ queryKey: inboxKeys.all(wsId) }); }
