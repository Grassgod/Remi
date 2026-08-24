import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";
import { ApiError } from "@multiremi/core/api";
import type { RepositoryWikiDoc, RepositoryWikiSummary } from "@multiremi/core/types";

const mockMutate = vi.hoisted(() => vi.fn());
const mockPending = vi.hoisted(() => ({ value: false }));
const mockSummaries = vi.hoisted(() => ({ value: [] as unknown[] }));
const mockDocs = vi.hoisted(() => ({ value: [] as unknown[] }));
const mockInvalidate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey ?? [];
      if (key[0] === "repositories") {
        if (key[2] === "wiki-summaries") {
          return { data: mockSummaries.value, isLoading: false };
        }
        if (key[2] === "list") {
          return {
            data: {
              repositories: [{
                id: "repo-1",
                name: "web",
                url: "https://github.com/multimira-ai/web.git",
                source: "github",
                description: null,
                default_branch: "main",
                imported_at: null,
                updated_at: null,
              }],
              total: 1,
            },
            isLoading: false,
          };
        }
        if (key[3] === "wiki") {
          return { data: mockDocs.value, isLoading: false, isError: false };
        }
      }
      return { data: undefined, isLoading: false };
    },
    useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  };
});

vi.mock("@multiremi/core/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/repositories")>();
  return {
    ...actual,
    useBuildRepositoryWiki: () => ({
      mutate: mockMutate,
      isPending: mockPending.value,
    }),
  };
});

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    repositories: () => "/workspace/repos",
    repositoryWikiPage: (id: string, path: string) => `/workspace/repos/${id}/wiki/${path}`,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../navigation", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("../common/task-transcript", () => ({
  TranscriptButton: ({ title }: { title?: string }) => (
    <button type="button" aria-label={title}>{title}</button>
  ),
}));

vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { toast } from "sonner";
import { RepositoryWikiPage } from "./repository-wiki-page";

function summary(overrides: Partial<RepositoryWikiSummary> = {}): RepositoryWikiSummary {
  return {
    repository_id: "repo-1",
    repository_name: "web",
    status: "healthy",
    status_message: null,
    source_revision: null,
    page_count: 1,
    updated_at: null,
    build: null,
    ...overrides,
  };
}

function doc(overrides: Partial<RepositoryWikiDoc> = {}): RepositoryWikiDoc {
  return {
    id: "doc-1",
    repository_id: "repo-1",
    workspace_id: "workspace-1",
    path: "overview.md",
    slug: "overview",
    title: "Architecture Overview",
    summary: null,
    body: "The architecture body",
    tags: [],
    refs: [],
    source_revision: null,
    status: "healthy",
    status_message: null,
    version: 1,
    updated_at: "2026-08-24T00:00:00Z",
    ...overrides,
  };
}

function buildingSummary(): RepositoryWikiSummary {
  return summary({
    status: "building",
    build: {
      status: "building",
      run_id: "run-1",
      task_id: "task-1",
      failure_reason: null,
      started_at: "2026-08-24T00:00:00Z",
      updated_at: "2026-08-24T00:01:00Z",
      source_revision: null,
    },
  });
}

function renderPage() {
  return renderWithI18n(<RepositoryWikiPage repositoryId="repo-1" wikiPath={null} />);
}

describe("RepositoryWikiPage build state", () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockMutate.mockImplementation((_vars, opts) => {
      opts?.onSuccess?.({ run_id: "run-1", task_id: "task-1", status: "running" });
    });
    mockPending.value = false;
    mockSummaries.value = [summary()];
    mockDocs.value = [doc()];
    mockInvalidate.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.info).mockReset();
  });

  it("restores the building state from server summaries on first render", () => {
    mockSummaries.value = [buildingSummary()];
    renderPage();

    const button = screen.getByRole("button", { name: /Building Wiki/ });
    expect(button).toBeDisabled();
    expect(screen.getByText("Building")).toBeInTheDocument();
    // Existing docs stay visible while the rebuild runs.
    expect(screen.getAllByText("Architecture Overview").length).toBeGreaterThan(0);
    expect(screen.getByText("The architecture body")).toBeInTheDocument();
    // Execution transcript stays reachable during the build.
    expect(screen.getByRole("button", { name: "View build process" })).toBeInTheDocument();
  });

  it("does not send another request while a build is active", async () => {
    const user = userEvent.setup();
    mockSummaries.value = [buildingSummary()];
    renderPage();

    await user.click(screen.getByRole("button", { name: /Building Wiki/ }));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("offers a rebuild entry in the header when docs already exist", async () => {
    const user = userEvent.setup();
    renderPage();

    const rebuild = screen.getByRole("button", { name: /Rebuild/ });
    expect(rebuild).toBeEnabled();
    await user.click(rebuild);
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("disables the build action and shows the building label once the mutation is pending", () => {
    mockDocs.value = [];
    mockPending.value = true;
    renderPage();

    const button = screen.getByRole("button", { name: /Building Wiki/ });
    expect(button).toBeDisabled();
  });

  it("treats a 409 in-progress conflict as building, not as an error", async () => {
    const user = userEvent.setup();
    mockDocs.value = [];
    mockMutate.mockImplementation((_vars, opts) => {
      opts?.onError?.(new ApiError("wiki build already running", 409, "Conflict", {
        error: "wiki build already running",
        code: "repository_wiki_build_in_progress",
        run_id: "run-1",
        task_id: "task-1",
      }));
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: /Build with Atlas/ }));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces other build errors as error toasts", async () => {
    const user = userEvent.setup();
    mockDocs.value = [];
    mockMutate.mockImplementation((_vars, opts) => {
      opts?.onError?.(new ApiError("atlas agent offline", 500, "Internal Server Error"));
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: /Build with Atlas/ }));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("shows the failure reason with retry and transcript entries", async () => {
    const user = userEvent.setup();
    mockSummaries.value = [summary({
      status: "failed",
      build: {
        status: "failed",
        run_id: "run-1",
        task_id: "task-1",
        failure_reason: "clone failed: permission denied",
        started_at: "2026-08-24T00:00:00Z",
        updated_at: "2026-08-24T00:01:00Z",
        source_revision: null,
      },
    })];
    renderPage();

    expect(screen.getByText("Wiki build failed")).toBeInTheDocument();
    expect(screen.getByText("clone failed: permission denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View build process" })).toBeInTheDocument();
    // Docs from the previous successful build stay visible.
    expect(screen.getByText("The architecture body")).toBeInTheDocument();

    const rebuild = screen.getByRole("button", { name: /Rebuild/ });
    expect(rebuild).toBeEnabled();
    await user.click(rebuild);
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it("invalidates the wiki docs query when the build leaves the active state", () => {
    mockSummaries.value = [buildingSummary()];
    const { rerender } = renderPage();
    expect(mockInvalidate).not.toHaveBeenCalled();

    mockSummaries.value = [summary()];
    rerender(<RepositoryWikiPage repositoryId="repo-1" wikiPath={null} />);
    expect(mockInvalidate).toHaveBeenCalledWith({
      queryKey: ["repositories", "workspace-1", "repo-1", "wiki"],
    });
  });
});
