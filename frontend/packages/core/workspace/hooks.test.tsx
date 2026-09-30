/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useActorName } from "./hooks";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "ws-1" }));
// Closed first-screen gate: agents and squads stay disabled, members pending.
vi.mock("../platform/use-after-first-screen", () => ({ useAfterFirstScreen: () => false }));
vi.mock("../api", () => ({
  api: {
    listMembers: () => new Promise(() => {}),
    listAgents: () => new Promise(() => {}),
    listSquads: () => new Promise(() => {}),
  },
}));

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useActorName", () => {
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
