import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const longRepoUrl =
  "https://github.com/multimira-ai/a-very-long-repository-name-that-needs-a-tooltip";
const apiRepoUrl = "https://github.com/multimira-ai/api";
const webRepoUrl = "https://github.com/multimira-ai/web";

const mockCreateProjectMutate = vi.hoisted(() => vi.fn());

// Keep the real query helpers (queryOptions, useMutation) and only stub
// useQuery, keyed by query so the reference-project picker (projectListOptions)
// sees a project to attach while every other query stays empty.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options?: { queryKey?: readonly unknown[] }) => {
      const key = options?.queryKey;
      if (Array.isArray(key) && key[0] === "projects") {
        return { data: [{ id: "proj-lib", title: "Shared Library", icon: "📚" }] };
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
        status: "planned",
        priority: "medium",
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

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "workspace-1",
    name: "Test Workspace",
    slug: "test-workspace",
    repos: [{ url: longRepoUrl }, { url: apiRepoUrl }, { url: webRepoUrl }],
  }),
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => `/test-workspace/projects/${id}`,
  }),
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: vi.fn() }),
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: vi.fn() }),
}));

vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
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
    }) => <input placeholder={placeholder} onChange={(e) => onChange?.(e.target.value)} />,
  };
});

vi.mock("../issues/components/priority-icon", () => ({
  PriorityIcon: () => <span data-testid="priority-icon" />,
}));

vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
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
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { CreateProjectModal } from "./create-project";

describe("CreateProjectModal", () => {
  it("exposes full repository URLs in the repository picker", () => {
    render(<CreateProjectModal onClose={vi.fn()} />);

    expect(screen.getByTitle(longRepoUrl)).toHaveTextContent(longRepoUrl);
    expect(screen.getByRole("tooltip", { name: longRepoUrl })).toBeInTheDocument();
  });

  it("filters workspace repositories by search text", async () => {
    const user = userEvent.setup();

    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    const repoSearchInput = screen.getByRole("textbox", { name: "Search repositories..." });

    await user.type(repoSearchInput, "api");

    expect(
      screen.getByRole("button", { name: (name) => name.includes(apiRepoUrl) }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: (name) => name.includes(webRepoUrl) }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: (name) => name.includes(longRepoUrl) }),
    ).not.toBeInTheDocument();

    await user.clear(repoSearchInput);
    await user.type(repoSearchInput, "no-match");

    expect(screen.getByText("No repositories match your search.")).toBeInTheDocument();
  });

  it("submits mixed resource types including a project_ref", async () => {
    const user = userEvent.setup();
    mockCreateProjectMutate.mockResolvedValue({ id: "new-project", slug: "new-project" });

    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    // Title is required to enable the Create button.
    await user.type(screen.getByPlaceholderText("Project title"), "Mixed sources");

    // Git tab (default): attach a workspace repo → github_repo.
    await user.click(
      screen.getByRole("button", { name: (name) => name.includes(apiRepoUrl) }),
    );

    // Reference-project tab: attach the referenced project → project_ref.
    await user.click(screen.getByRole("button", { name: "Reference project" }));
    await user.click(screen.getByRole("button", { name: /Shared Library/i }));

    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() =>
      expect(mockCreateProjectMutate).toHaveBeenCalledTimes(1),
    );
    const payload = mockCreateProjectMutate.mock.calls[0]![0] as {
      resources?: unknown[];
    };
    expect(payload.resources).toEqual([
      { resource_type: "github_repo", resource_ref: { url: apiRepoUrl } },
      { resource_type: "project_ref", resource_ref: { project_id: "proj-lib" } },
    ]);
  });

  it("keeps the disabled-submit reason keyboard-reachable via a focusable wrapper", () => {
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    // Draft title starts empty, so the submit is disabled with a reason tooltip.
    const submit = screen.getByRole("button", { name: "Create Project" });
    expect(submit).toBeDisabled();

    // A disabled button can't take focus, so the tooltip trigger wraps it in a
    // focusable span — without tabIndex a keyboard user could never summon the
    // reason. Assert the wrapper and its focusability survive.
    const wrapper = submit.parentElement as HTMLElement;
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper).toHaveAttribute("tabindex", "0");

    // The reason string itself is wired into the tooltip content.
    expect(
      screen.getByRole("tooltip", { name: "Enter a project title first" }),
    ).toBeInTheDocument();
  });
});
