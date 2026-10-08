/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MemberWithUser } from "../types";
import { describe, expect, it, vi } from "vitest";
import { useActorName } from "./hooks";
import { workspaceKeys } from "./queries";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "ws-1" }));
// Closed first-screen gate: agents and squads stay disabled, members pending.
vi.mock("../platform/use-after-first-screen", () => ({ useAfterFirstScreen: () => false }));
vi.mock("../api", () => ({
  api: {
    listMembers: () => new Promise(() => {}),
    listAgents: () => new Promise(() => {}),
    listSquads: () => new Promise(() => {}),
    getBaseUrl: () => "https://remi.example.test",
  },
}));

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useActorName", () => {
  const member: MemberWithUser = {
    id: "mem_member",
    workspace_id: "ws-1",
    user_id: "usr_member",
    name: "测试用户",
    role: "owner",
    avatar_url: "/uploads/member.png",
    created_at: "2026-10-08T00:00:00Z",
  };

  it.each([member.id, member.user_id])("resolves a member's name and avatar for identity %s", (id) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(workspaceKeys.members("ws-1"), [member]);
    const { result } = renderHook(() => useActorName(), { wrapper: createWrapper(qc) });

    expect(result.current.getMemberName(id)).toBe("测试用户");
    expect(result.current.getActorName("member", id)).toBe("测试用户");
    expect(result.current.getActorInitials("member", id)).toBe("测");
    expect(result.current.getActorAvatarUrl("member", id)).toBe("https://remi.example.test/uploads/member.png");
    expect(result.current.getActorName("member", "mem_ws-1_usr_member")).toBe("Unknown");
    expect(result.current.getActorAvatarUrl("member", "missing")).toBeNull();
    qc.clear();
  });

  it("prefers the exact member row over another member's user-id alias", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(workspaceKeys.members("ws-1"), [
      { ...member, id: "mem_other", user_id: member.id, name: "Other member", avatar_url: "/other.png" },
      member,
    ]);
    const { result } = renderHook(() => useActorName(), { wrapper: createWrapper(qc) });

    expect(result.current.getActorName("member", member.id)).toBe(member.name);
    expect(result.current.getActorAvatarUrl("member", member.id)).toBe("https://remi.example.test/uploads/member.png");
    qc.clear();
  });

  // The issues board memoizes its column groups on getActorName and rebuilds
  // columns in an effect; an unstable callback re-rendered it without end.
  it("keeps its callbacks stable while the actor lists are pending or gated", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(() => useActorName(), { wrapper: createWrapper(qc) });
    const first = result.current;

    rerender();

    expect(result.current.getActorName).toBe(first.getActorName);
    expect(result.current).toBe(first);
    expect(result.current.getActorName("member", "u-1")).toBe("Unknown");
    qc.clear();
  });
});
