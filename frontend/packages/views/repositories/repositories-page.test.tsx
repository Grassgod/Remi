import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const githubUrl = "https://github.com/multimira-ai/web.git";
const codebaseUrl = "git@code.byted.org:dev/agent-platform.git";

const repositories = [
  {
    id: "repo-github",
    name: "web",
    url: githubUrl,
    source: "github",
    description: "Web application",
    default_branch: "main",
    imported_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  },
  {
    id: "repo-codebase",
    name: "agent-platform",
    url: codebaseUrl,
    source: "codebase",
    description: "Agent platform",
    default_branch: null,
    imported_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  },
];

const mockImport = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: { queryKey?: readonly unknown[] }) => {
      if (options.queryKey?.[0] === "repositories") {
        return {
          data: { repositories, total: repositories.length },
          isLoading: false,
        };
      }
      if (options.queryKey?.[0] === "members") {
        return {
          data: [{ user_id: "user-1", name: "Owner", role: "owner" }],
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    },
  };
});

vi.mock("@multiremi/core/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/repositories")>();
  return {
    ...actual,
    useImportWorkspaceRepository: () => ({
      mutateAsync: mockImport,
      isPending: false,
    }),
    useRemoveWorkspaceRepository: () => ({
      mutateAsync: mockRemove,
      isPending: false,
    }),
  };
});

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { RepositoriesPage } from "./repositories-page";

describe("RepositoriesPage", () => {
  it("searches and filters imported repositories", async () => {
    const user = userEvent.setup();
    renderWithI18n(<RepositoriesPage />);

    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("agent-platform")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Codebase" }));
    expect(screen.queryByText("web")).not.toBeInTheDocument();
    expect(screen.getByText("agent-platform")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search repositories..." }),
      githubUrl,
    );
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.queryByText("agent-platform")).not.toBeInTheDocument();
  });

  it("imports a Codebase repository from its clone URL", async () => {
    const user = userEvent.setup();
    mockImport.mockResolvedValue({ repository: repositories[1] });
    renderWithI18n(<RepositoriesPage />);

    await user.click(screen.getByRole("button", { name: "Import repository" }));
    const dialog = screen.getByRole("dialog", { name: "Import repository" });
    await user.click(within(dialog).getByRole("button", { name: "Codebase" }));
    await user.type(
      within(dialog).getByLabelText("Clone URL", { selector: "input" }),
      codebaseUrl,
    );
    await user.click(within(dialog).getByRole("button", { name: "Import repository" }));

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Import repository" })).not.toBeInTheDocument();
    expect(mockImport).toHaveBeenCalledWith({
      source: "codebase",
      url: codebaseUrl,
    });
  });
});
