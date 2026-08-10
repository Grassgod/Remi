// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { CreateProjectResourceRequest, GithubRepoResourceRef } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enProjects from "../../locales/en/projects.json";

const repositories = [
  {
    id: "repo-api",
    name: "api-service",
    url: "git@code.byted.org:platform/api-service.git",
    source: "codebase",
    description: "API service",
    default_branch: "main",
    imported_at: null,
    updated_at: null,
  },
  {
    id: "repo-web",
    name: "web-console",
    url: "https://github.com/example/web-console.git",
    source: "github",
    description: null,
    default_branch: "develop",
    imported_at: null,
    updated_at: null,
  },
];

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({
      data: { repositories, total: repositories.length },
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "ws-1",
    name: "Workspace",
    slug: "workspace",
    repos: repositories.map(({ url }) => ({ url })),
  }),
}));

import { ProjectGitRepositoryPicker } from "./project-git-repository-picker";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function gitResource(url: string): CreateProjectResourceRequest {
  return { resource_type: "github_repo", resource_ref: { url } };
}

function renderPicker({
  attachedResources = [],
  onAttach = vi.fn(async (resources: CreateProjectResourceRequest[]) =>
    resources.map((resource) =>
      resource.resource_type === "github_repo" ? (resource.resource_ref as GithubRepoResourceRef).url : "",
    ),
  ),
  onClose = vi.fn(),
}: {
  attachedResources?: CreateProjectResourceRequest[];
  onAttach?: (
    resources: CreateProjectResourceRequest[],
  ) => Promise<readonly string[]>;
  onClose?: () => void;
} = {}) {
  render(
    <Wrapper>
      <ProjectGitRepositoryPicker
        attachedResources={attachedResources}
        onAttach={onAttach}
        onClose={onClose}
      />
    </Wrapper>,
  );
  return { onAttach, onClose };
}

describe("ProjectGitRepositoryPicker", () => {
  it("shows repository name, branch, and URL in the same hierarchy as project creation", () => {
    renderPicker();

    expect(screen.getByText("api-service")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(
      screen.getByTitle("git@code.byted.org:platform/api-service.git"),
    ).toBeInTheDocument();
  });

  it("keeps attached repositories locked and batches new selections", async () => {
    const user = userEvent.setup();
    const attachedUrl = repositories[0]!.url;
    const onAttach = vi.fn(async (_resources: CreateProjectResourceRequest[]) => [repositories[1]!.url]);
    const onClose = vi.fn();
    renderPicker({
      attachedResources: [gitResource(attachedUrl)],
      onAttach,
      onClose,
    });

    expect(
      screen.getByRole("checkbox", { name: "api-service" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Attached")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "web-console" }));
    expect(screen.getByRole("button", { name: "Attach 1" })).toBeEnabled();
    expect(onAttach).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Attach 1" }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(onAttach.mock.calls[0]![0]).toEqual([
      {
        resource_type: "github_repo",
        resource_ref: {
          url: repositories[1]!.url,
          default_branch_hint: "develop",
        },
      },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("adds an ad-hoc URL as a pending repository", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn(async () => ["git@github.com:example/tools.git"]);
    renderPicker({ onAttach });

    await user.click(
      screen.getByRole("button", { name: /Add repository by URL/i }),
    );
    const input = screen.getByRole("textbox", {
      name: /https:\/\/github\.com\/owner\/repo/i,
    });
    await user.type(input, "git@github.com:example/tools.git");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("tools")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("keeps failed selections pending after a partial batch result", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn(async () => [repositories[0]!.url]);
    const onClose = vi.fn();
    renderPicker({ onAttach, onClose });

    await user.click(screen.getByRole("checkbox", { name: "api-service" }));
    await user.click(screen.getByRole("checkbox", { name: "web-console" }));
    await user.click(screen.getByRole("button", { name: "Attach 2" }));

    await waitFor(() =>
      expect(screen.getByText("1 selected")).toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "web-console" })).toBeChecked();
  });
});
