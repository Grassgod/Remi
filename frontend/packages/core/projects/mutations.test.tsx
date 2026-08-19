/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { Project } from "../types";
import { useUpdateProject } from "./mutations";
import { projectKeys } from "./queries";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    workspace_id: "ws-1",
    title: "Apollo",
    description: null,
    instructions: "Old instructions",
    instructions_revision: 7,
    instructions_updated_at: null,
    instructions_updated_by: null,
    icon: null,
    status: "in_progress",
    priority: "none",
    lead_type: null,
    lead_id: null,
    default_assignee_type: null,
    default_assignee_id: null,
    archived_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    issue_count: 0,
    done_count: 0,
    resource_count: 0,
    ...overrides,
  };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe("useUpdateProject", () => {
  let queryClient: QueryClient;
  const updateProject = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    updateProject.mockResolvedValue(makeProject({
      instructions: "New instructions",
      instructions_revision: 8,
    }));
    setApiInstance({ updateProject } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("forwards the expected revision without adding it to the optimistic project", async () => {
    const key = projectKeys.detail("ws-1", "project-1");
    queryClient.setQueryData(key, makeProject());
    const { result } = renderHook(() => useUpdateProject(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "project-1",
        instructions: "New instructions",
        expected_instructions_revision: 7,
      });
    });

    expect(updateProject).toHaveBeenCalledWith("project-1", {
      instructions: "New instructions",
      expected_instructions_revision: 7,
    });
    expect(queryClient.getQueryData<Project>(key)).toMatchObject({
      instructions: "New instructions",
      instructions_revision: 8,
    });
    expect(queryClient.getQueryData(key)).not.toHaveProperty(
      "expected_instructions_revision",
    );
  });
});
