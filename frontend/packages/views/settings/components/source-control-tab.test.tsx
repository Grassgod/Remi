import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const updateWorkspace = vi.hoisted(() => vi.fn());
const setQueryData = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const workspaceRef = vi.hoisted(() => ({
  current: {
    id: "workspace-1",
    name: "Acme",
    settings: { retained_setting: "yes" } as Record<string, unknown>,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [{ user_id: "user-1", role: "owner" }] }),
  useQueryClient: () => ({ setQueryData }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));

vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => workspaceRef.current,
  useWorkspacePaths: () => ({ repositories: () => "/acme/repositories" }),
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  workspaceKeys: { list: () => ["workspaces"] },
}));

vi.mock("@multiremi/core/api", () => ({ api: { updateWorkspace } }));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: navigate }),
}));

vi.mock("./scm-connections-section", () => ({
  ScmConnectionsSection: () => <div data-testid="scm-connections" />,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { SourceControlTab } from "./source-control-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

describe("SourceControlTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRef.current.settings = { retained_setting: "yes" };
    updateWorkspace.mockImplementation(async (_id: string, input: { settings: Record<string, unknown> }) => ({
      ...workspaceRef.current,
      settings: input.settings,
    }));
  });

  it("shows provider-independent collaboration settings and commit identity", () => {
    render(<SourceControlTab />, { wrapper: I18nWrapper });

    expect(screen.getByTestId("scm-connections")).toBeInTheDocument();
    expect(screen.getByText("Co-authored-by: Remi <remi@openremi.fun>")).toBeInTheDocument();
    expect(screen.queryByText(/GitHub App/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enable GitHub features/i)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Code changes sidebar" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Auto-link issues and code changes" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Complete issue after merge" })).not.toBeChecked();
  });

  it("persists the generic merge behavior without dropping unrelated settings", async () => {
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });

    await user.click(screen.getByRole("switch", { name: "Complete issue after merge" }));

    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: {
        retained_setting: "yes",
        scm_complete_issue_on_merge_enabled: true,
      },
    }));
  });

  it("opens the shared repository management surface", async () => {
    const user = userEvent.setup();
    render(<SourceControlTab />, { wrapper: I18nWrapper });

    await user.click(screen.getByRole("button", { name: /Manage repositories/ }));
    expect(navigate).toHaveBeenCalledWith("/acme/repositories");
  });
});
