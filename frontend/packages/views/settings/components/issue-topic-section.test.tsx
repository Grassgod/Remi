import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";
import type { IssueTopicConfigResponse } from "@multiremi/core/types";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" }],
}));
const configRef = vi.hoisted(() => ({
  current: {
    workspace_id: "workspace-1",
    config: { enabled: true, chat_id: "oc_team", project_ids: ["prj_1"] as string[] | null },
  } as IssueTopicConfigResponse,
}));
const projectsRef = vi.hoisted(() => ({
  current: [
    { id: "prj_1", title: "Alpha", archived_at: null },
    { id: "prj_2", title: "Archived", archived_at: "2026-09-01T00:00:00Z" },
  ],
}));
const pendingRef = vi.hoisted(() => ({ members: false, config: false }));
const mockSave = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key.includes("members")) {
      return { data: membersRef.current, isPending: pendingRef.members };
    }
    if (key.includes("issue-topics")) {
      return { data: configRef.current, isPending: pendingRef.config };
    }
    if (key.includes("projects")) {
      return { data: projectsRef.current, isPending: false };
    }
    return { data: undefined, isPending: false };
  },
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
}));

vi.mock("@multiremi/core/feishu-bot/queries", () => ({
  issueTopicConfigOptions: () => ({ queryKey: ["feishu-bot", "issue-topics"], queryFn: vi.fn() }),
}));

vi.mock("@multiremi/core/feishu-bot/mutations", () => ({
  useSaveIssueTopicConfig: () => ({ mutateAsync: mockSave, isPending: false }),
}));

vi.mock("@multiremi/core/projects", () => ({
  projectListOptions: () => ({ queryKey: ["projects"], queryFn: vi.fn() }),
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (select: (state: { user: { id: string } }) => unknown) =>
    select({ user: { id: "user-1" } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { IssueTopicSection } from "./issue-topic-section";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function renderSection() {
  return render(<IssueTopicSection />, { wrapper: Wrapper });
}

function resetFixtures() {
  vi.clearAllMocks();
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  configRef.current = {
    workspace_id: "workspace-1",
    config: { enabled: true, chat_id: "oc_team", project_ids: ["prj_1"] },
  };
  projectsRef.current = [
    { id: "prj_1", title: "Alpha", archived_at: null },
    { id: "prj_2", title: "Archived", archived_at: "2026-09-01T00:00:00Z" },
  ];
  pendingRef.members = false;
  pendingRef.config = false;
  mockSave.mockResolvedValue(configRef.current);
}

describe("IssueTopicSection", () => {
  beforeEach(resetFixtures);

  it("defaults proactive notifications to the group owner and can disable mentions", async () => {
    const user = userEvent.setup();
    renderSection();
    const selector = await screen.findByRole("combobox", { name: "Proactive notification recipient" });
    expect(selector).toHaveTextContent("Group owner");
    await user.click(selector);
    await user.click(await screen.findByRole("option", { name: "No mention" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ notify_mode: "none", notify_open_id: null }));
  });

  it("requires a bot-scoped open ID for a specified recipient", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("combobox", { name: "Proactive notification recipient" }));
    await user.click(await screen.findByRole("option", { name: "Specific person" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const input = screen.getByLabelText("Recipient open_id (bot application)");
    await user.type(input, "ou_reviewer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ notify_mode: "person", notify_open_id: "ou_reviewer" }));
  });

  it("seeds the form from the stored config and hides archived projects", async () => {
    renderSection();

    await waitFor(() => expect(screen.getByLabelText("Feishu group chat ID")).toHaveValue("oc_team"));
    expect(screen.getByRole("switch", { name: "Create topics for new Issues" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Only selected projects" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Alpha" })).toBeChecked();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves an explicit project whitelist without changing null semantics", async () => {
    configRef.current = {
      workspace_id: "workspace-1",
      config: { enabled: false, chat_id: "", project_ids: null },
    };
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("switch", { name: "Create topics for new Issues" }));
    await user.type(screen.getByLabelText("Feishu group chat ID"), " oc_topics ");
    await user.click(screen.getByRole("switch", { name: "Only selected projects" }));
    await user.click(screen.getByRole("checkbox", { name: "Alpha" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith({
      enabled: true,
      chat_id: "oc_topics",
      project_ids: ["prj_1"],
      notify_mode: "group_owner",
      notify_open_id: null,
    }));
    expect(toast.success).toHaveBeenCalledWith("Issue topic settings saved");
  });

  it("renders a read-only form for regular members", async () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    renderSection();

    await waitFor(() => expect(screen.getByLabelText("Feishu group chat ID")).toBeDisabled());
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only workspace owners and admins/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Proactive notification recipient" })).toBeDisabled();
  });
});
