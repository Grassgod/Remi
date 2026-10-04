import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createInboxHandlers } from "../realtime/sync/inbox";
import { createIssueHandlers } from "../realtime/sync/issues";
import { createPrefixRefresh } from "../realtime/sync/prefix-refresh";
import type { SyncContext } from "../realtime/sync/types";
import type { WSMessage } from "../types/events";
vi.mock("../platform/workspace-storage", () => ({ getCurrentWsId: () => "ws-1" }));
afterEach(() => vi.useRealTimers());
describe("inbox dedicated and generic realtime registration", () => {
  for (const type of ["inbox:new", "inbox:read", "inbox:batch-read", "decision:updated"] as const) {
    it(`refreshes pages, counts and read message details once for ${type}`, async () => {
      vi.useFakeTimers();
      const qc = new QueryClient();
      const keys = [["inbox", "ws-1", "pages"], ["inbox", "ws-1", "summary"], ["message-detail", "ws-1", "read-decision"]];
      for (const key of [...keys, ["inbox", "ws-2", "pages"], ["message-detail", "ws-2", "read-decision"]]) qc.setQueryData(key, {});
      const ctx = { qc, authStore: { getState: () => ({}) } } as SyncContext;
      const handlers = { ...createInboxHandlers(ctx).handlers, ...createIssueHandlers(ctx).handlers };
      const prefix = createPrefixRefresh(ctx);
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      try {
        const payload = type === "decision:updated" ? { issue_id: "iss-1" } : { index_only: true };
        await handlers[type]?.(payload);
        prefix.onAny({ type, payload } as WSMessage);
        await vi.advanceTimersByTimeAsync(150);
        for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
        expect(qc.getQueryState(["inbox", "ws-2", "pages"])?.isInvalidated).toBe(false);
        expect(qc.getQueryState(["message-detail", "ws-2", "read-decision"])?.isInvalidated).toBe(false);
        expect(invalidate.mock.calls.filter(([filter]) => filter?.queryKey?.[0] === "inbox")).toHaveLength(1);
      } finally { prefix.dispose(); qc.clear(); }
    });
  }
});
