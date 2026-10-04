import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { inboxKeys } from "./queries";
import { onInboxInvalidate, onInboxIssueDeleted, onInboxIssueStatusChanged } from "./ws-updaters";
describe("inbox refresh", () => {
  it("invalidates cursor pages and global counts together without mutating another workspace", () => {
    const qc = new QueryClient();
    qc.setQueryData(inboxKeys.pages("ws-1"), { pages: [{ items: [], next_cursor: "opaque" }] });
    qc.setQueryData(inboxKeys.summary("ws-1"), { unread_count: 7 });
    qc.setQueryData(inboxKeys.summary("ws-2"), { unread_count: 3 });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    onInboxInvalidate(qc, "ws-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all("ws-1") });
    expect(qc.getQueryState(inboxKeys.summary("ws-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(inboxKeys.summary("ws-2"))?.isInvalidated).toBe(false);
  });
  it("refreshes authoritative visibility after an issue status change or deletion", () => {
    const qc = new QueryClient(); const invalidate = vi.spyOn(qc, "invalidateQueries");
    onInboxIssueStatusChanged(qc, "ws-1", "iss-1", "done");
    onInboxIssueDeleted(qc, "ws-1", "iss-1");
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
