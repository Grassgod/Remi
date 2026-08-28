/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { InboxItem } from "../types";
import { useArchiveInbox, useArchiveInboxItems } from "./mutations";
import { inboxKeys } from "./queries";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function makeItem(id: string, type: InboxItem["type"]): InboxItem {
  return {
    id,
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: null,
    actor_id: null,
    type,
    severity: "info",
    issue_id: "issue-1",
    title: id,
    body: null,
    issue_status: "done",
    read: false,
    archived: false,
    created_at: "2026-08-25T10:00:00.000Z",
    details: null,
  };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useArchiveInbox", () => {
  let queryClient: QueryClient;
  const archiveInbox = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    archiveInbox.mockResolvedValue(makeItem("ledger-selected", "autopilot_run_failed"));
    setApiInstance({ archiveInbox } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("optimistically archives only the requested row when an issue has several notifications", async () => {
    const key = inboxKeys.list("ws-1");
    queryClient.setQueryData<InboxItem[]>(key, [
      makeItem("ledger-selected", "autopilot_run_failed"),
      makeItem("ledger-neighbor", "autopilot_run_completed"),
      makeItem("action-neighbor", "comment_mention"),
    ]);
    const { result } = renderHook(() => useArchiveInbox(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync("ledger-selected");
    });

    expect(archiveInbox).toHaveBeenCalledWith("ledger-selected");
    const after = queryClient.getQueryData<InboxItem[]>(key);
    expect(after?.map(({ id, archived, read }) => ({ id, archived, read }))).toEqual([
      { id: "ledger-selected", archived: true, read: true },
      { id: "ledger-neighbor", archived: false, read: false },
      { id: "action-neighbor", archived: false, read: false },
    ]);
  });

  it("archives every immutable row covered by a collapsed run entry", async () => {
    const key = inboxKeys.list("ws-1");
    queryClient.setQueryData<InboxItem[]>(key, [
      makeItem("run-latest", "autopilot_run_completed"),
      makeItem("run-earlier", "autopilot_run_completed"),
      makeItem("run-failed", "autopilot_run_failed"),
    ]);
    const { result } = renderHook(() => useArchiveInboxItems(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(["run-latest", "run-earlier"]);
    });

    expect(archiveInbox).toHaveBeenCalledTimes(2);
    expect(archiveInbox).toHaveBeenCalledWith("run-latest");
    expect(archiveInbox).toHaveBeenCalledWith("run-earlier");
    expect(queryClient.getQueryData<InboxItem[]>(key)?.map(({ id, archived }) => ({ id, archived })))
      .toEqual([
        { id: "run-latest", archived: true },
        { id: "run-earlier", archived: true },
        { id: "run-failed", archived: false },
      ]);
  });
});
