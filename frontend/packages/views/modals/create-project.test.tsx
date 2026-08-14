import React from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const longRepoUrl =
  "https://github.com/multimira-ai/a-very-long-repository-name-that-needs-a-tooltip.git";
const apiRepoUrl = "https://github.com/multimira-ai/api.git";
const codebaseRepoUrl = "git@code.byted.org:dev/agent-platform.git";

const repositories = [
  {
    id: "repo-long",
    name: "a-very-long-repository-name-that-needs-a-tooltip",
    url: longRepoUrl,
    source: "github",
    description: null,
    default_branch: "main",
    imported_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  },
  {
    id: "repo-api",
    name: "api",
    url: apiRepoUrl,
    source: "github",
    description: "API service",
    default_branch: "main",
    imported_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  },
  {
    id: "repo-codebase",
    name: "agent-platform",
    url: codebaseRepoUrl,
    source: "codebase",
    description: null,
    default_branch: null,
    imported_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  },
];

const mockCreateProjectMutate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options?: { queryKey?: readonly unknown[] }) => {
      const key = options?.queryKey;
      if (Array.isArray(key) && key[0] === "repositories") {
        return { data: { repositories, total: repositories.length }, isLoading: false };
      }
      return { data: [] };
    },
  };
});

vi.mock("@multiremi/core/projects/mutations", () => ({
  useCreateProject: () => ({ mutateAsync: mockCreateProjectMutate }),
}));

vi.mock("@multiremi/core/projects", () => ({
  useProjectDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      draft: {
        title: "",
        description: "",
        leadType: undefined,
        leadId: undefined,
        icon: undefined,
      },
      setDraft: vi.fn(),
      clearDraft: vi.fn(),
    }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "workspace-1",
    name: "Test Workspace",
    slug: "test-workspace",
  }),
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => `/test-workspace/projects/${id}`,
    repositories: () => "/test-workspace/repos",
  }),
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: vi.fn() }),
  squadListOptions: () => ({ queryKey: ["squads"], queryFn: vi.fn() }),
  assigneeFrequencyOptions: () => ({ queryKey: ["assigneeFrequency"], queryFn: vi.fn() }),
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: vi.fn() }),
}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: mockPush }),
}));

vi.mock("../editor", () => {
  const ContentEditor = React.forwardRef<
    { getMarkdown: () => string },
    { placeholder?: string }
  >(({ placeholder }, ref) => {
    React.useImperativeHandle(ref, () => ({ getMarkdown: () => "" }));
    return <textarea placeholder={placeholder} />;
  });
  ContentEditor.displayName = "ContentEditor";

  return {
    ContentEditor,
    TitleEditor: ({
      placeholder,
      onChange,
    }: {
      placeholder?: string;
      onChange?: (value: string) => void;
    }) => <input placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} />,
  };
});

vi.mock("../issues/components/priority-icon", () => ({
  PriorityIcon: () => <span data-testid="priority-icon" />,
}));

vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("../issues/components/pickers/assignee-picker", () => ({
  AssigneePicker: ({
    onUpdate,
    allowedTypes,
    unassignedLabel,
  }: {
    onUpdate: (updates: { assignee_type: "agent" | "squad"; assignee_id: string }) => void;
    allowedTypes?: string[];
    unassignedLabel?: string;
  }) => (
    <div data-testid="default-executor-picker" data-allowed-types={allowedTypes?.join(",")}>
      <span>{unassignedLabel}</span>
      <button
        type="button"
        onClick={() => onUpdate({ assignee_type: "agent", assignee_id: "agent-build" })}
      >
        Pick build agent
      </button>
      <button
        type="button"
        onClick={() => onUpdate({ assignee_type: "squad", assignee_id: "squad-platform" })}
      >
        Pick platform squad
      </button>
    </div>
  ),
}));

vi.mock("@multiremi/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@multiremi/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@multiremi/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@multiremi/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

vi.mock("@multiremi/ui/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
  }) => (
    <button type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@multiremi/ui/components/common/emoji-picker", () => ({
  EmojiPicker: () => null,
}));

vi.mock("@multiremi/ui/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { CreateProjectModal } from "./create-project";

describe("CreateProjectModal", () => {
  it("lists imported repositories without source badges", () => {
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByTitle(longRepoUrl)).toHaveTextContent(longRepoUrl);
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("Codebase")).not.toBeInTheDocument();
  });

  it("filters imported repositories by name and URL", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    const search = screen.getByRole("textbox", {
      name: "Search imported repositories...",
    });
    await user.type(search, "agent-platform");

    expect(screen.getByRole("checkbox", { name: "agent-platform" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "api" })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "no-match");
    expect(screen.getByText("No imported repositories match your search.")).toBeInTheDocument();
  });

  it("submits only selected imported git repositories", async () => {
    const user = userEvent.setup();
    mockCreateProjectMutate.mockResolvedValue({ id: "new-project" });
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Project title"), "Platform");
    await user.click(screen.getByRole("checkbox", { name: "api" }));
    await user.click(screen.getByRole("checkbox", { name: "agent-platform" }));
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(mockCreateProjectMutate).toHaveBeenCalledTimes(1));
    expect(mockCreateProjectMutate.mock.calls[0]![0]).toMatchObject({
      title: "Platform",
      lead_type: "member",
      lead_id: "user-1",
      default_assignee_type: null,
      default_assignee_id: null,
    });
    expect(mockCreateProjectMutate.mock.calls[0]![0]).not.toHaveProperty("status");
    expect(mockCreateProjectMutate.mock.calls[0]![0]).not.toHaveProperty("priority");
    expect(mockCreateProjectMutate.mock.calls[0]![0].resources).toEqual([
      {
        resource_type: "github_repo",
        resource_ref: { url: apiRepoUrl, default_branch_hint: "main" },
      },
      {
        resource_type: "github_repo",
        resource_ref: { url: codebaseRepoUrl },
      },
    ]);
  });

  it("submits the selected agent or squad as the default executor", async () => {
    const user = userEvent.setup();
    mockCreateProjectMutate.mockClear();
    mockCreateProjectMutate.mockResolvedValue({ id: "new-project" });
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    expect(screen.getByTestId("default-executor-picker")).toHaveAttribute(
      "data-allowed-types",
      "agent,squad",
    );
    expect(screen.getByText("Default executor")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Project title"), "Platform");
    await user.click(screen.getByRole("checkbox", { name: "api" }));
    await user.click(screen.getByRole("button", { name: "Pick platform squad" }));
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(mockCreateProjectMutate).toHaveBeenCalledTimes(1));
    expect(mockCreateProjectMutate.mock.calls[0]![0]).toMatchObject({
      default_assignee_type: "squad",
      default_assignee_id: "squad-platform",
    });
  });

  it("does not expose local folders, fleet computers, project refs, or ad-hoc URLs", () => {
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    expect(screen.queryByText("From fleet")).not.toBeInTheDocument();
    expect(screen.queryByText("Reference project")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose a directory on this machine…")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/https:\/\/github\.com\/owner\/repo/i)).not.toBeInTheDocument();
  });

  it("requires both a title and at least one imported repository", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    let submit = screen.getByRole("button", { name: "Create Project" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("tooltip", { name: "Enter a project title first" })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Project title"), "Platform");
    submit = screen.getByRole("button", { name: "Create Project" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("tooltip", { name: "Select at least one repository" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "api" }));
    expect(screen.getByRole("button", { name: "Create Project" })).toBeEnabled();
  });
});
