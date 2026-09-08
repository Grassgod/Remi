import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { FeishuBotAgentRoute, FeishuBotCandidates } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const routesRef = vi.hoisted(() => ({
  current: { data: undefined as unknown, isPending: false, isError: false, error: null as unknown },
}));
const chatsRef = vi.hoisted(() => ({
  current: { data: undefined as unknown, isPending: false, isError: false, error: null as unknown },
}));
const issueTopicsRef = vi.hoisted(() => ({
  current: { data: undefined as unknown, isPending: false, isError: false, error: null as unknown },
}));
const mockSaveRoutes = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = JSON.stringify(options.queryKey);
    if (key.includes("issue-topics")) return issueTopicsRef.current;
    if (key.includes("chats")) return chatsRef.current;
    return routesRef.current;
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/feishu-bot/queries", () => ({
  feishuBotRoutesOptions: () => ({ queryKey: ["feishu-bot", "workspace-1", "routes"] }),
  feishuBotChatsOptions: (_workspaceId: string, enabled?: boolean) => ({
    queryKey: ["feishu-bot", "workspace-1", "chats"],
    enabled,
  }),
  issueTopicConfigOptions: () => ({ queryKey: ["feishu-bot", "workspace-1", "issue-topics"] }),
}));

vi.mock("@multiremi/core/feishu-bot/mutations", () => ({
  useSaveFeishuBotRoutes: () => ({ mutateAsync: mockSaveRoutes, isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { FeishuBotRoutes } from "./feishu-bot-routes";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

const CANDIDATES: FeishuBotCandidates = {
  workspace_id: "workspace-1",
  agents: [
    { id: "agt_remi", name: "Remi", provider: "acp:claude" },
    { id: "agt_lead", name: "Lead", provider: "acp:claude" },
    { id: "agt_worker", name: "Worker", provider: "acp:codex" },
  ],
  runtimes: [],
  encryption_available: true,
};

const ROUTES: FeishuBotAgentRoute[] = [
  route({ id: "route-p2p", scope: "p2p_default", agent_id: "agt_remi", agent_name: "Remi" }),
  route({ id: "route-group", scope: "group_default", agent_id: "agt_lead", agent_name: "Lead" }),
  route({
    id: "route-issue",
    scope: "chat",
    chat_id: "oc_issue",
    chat_name: "Issue dispatch",
    member_count: 42,
    agent_id: "agt_worker",
    agent_name: "Worker",
  }),
];

function route(overrides: Partial<FeishuBotAgentRoute>): FeishuBotAgentRoute {
  return {
    id: "route-1",
    scope: "chat",
    chat_id: null,
    chat_name: null,
    member_count: null,
    agent_id: "agt_remi",
    agent_name: "Remi",
    agent_archived: false,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
    updated_by: "user-1",
    ...overrides,
  };
}

function resetFixtures() {
  vi.clearAllMocks();
  routesRef.current = {
    data: { workspace_id: "workspace-1", routes: ROUTES },
    isPending: false,
    isError: false,
    error: null,
  };
  chatsRef.current = {
    data: {
      workspace_id: "workspace-1",
      chats: [
        { name: "Issue dispatch", chat_id: "oc_issue", member_count: 42, chat_mode: "topic" },
        { name: "Release coordination", chat_id: "oc_release", member_count: 12, chat_mode: "group" },
      ],
    },
    isPending: false,
    isError: false,
    error: null,
  };
  issueTopicsRef.current = {
    data: {
      workspace_id: "workspace-1",
      config: { enabled: true, chat_id: "oc_issue", project_ids: null },
    },
    isPending: false,
    isError: false,
    error: null,
  };
  mockSaveRoutes.mockResolvedValue({ workspace_id: "workspace-1", routes: ROUTES });
}

function renderRoutes() {
  return render(
    <FeishuBotRoutes workspaceId="workspace-1" candidates={CANDIDATES} candidatesPending={false} />,
    { wrapper: Wrapper },
  );
}

describe("FeishuBotRoutes", () => {
  beforeEach(resetFixtures);

  it("loads all three routing levels and marks the Issue topic group", async () => {
    renderRoutes();
    expect(await screen.findByRole("combobox", { name: "Direct messages use" })).toHaveTextContent("Remi");
    expect(screen.getByRole("combobox", { name: "Group chats use" })).toHaveTextContent("Lead");
    expect(screen.getByRole("combobox", { name: "Agent for Issue dispatch" })).toHaveTextContent("Worker");
    expect(screen.getByText("Issue topic group")).toBeInTheDocument();
    expect(screen.getByText(/42 members · oc_issue/)).toBeInTheDocument();
  });

  it("omits a conversation default when it follows the Default Agent", async () => {
    const user = userEvent.setup();
    renderRoutes();
    const p2pSelect = await screen.findByRole("combobox", { name: "Direct messages use" });
    await user.click(p2pSelect);
    await user.click(await screen.findByRole("option", { name: "Follow Default Agent" }));
    await user.click(screen.getByRole("button", { name: "Save routes" }));

    await waitFor(() => expect(mockSaveRoutes).toHaveBeenCalledTimes(1));
    const input = mockSaveRoutes.mock.calls[0]?.[0] as { routes: Array<{ scope: string }> };
    expect(input.routes.some((item) => item.scope === "p2p_default")).toBe(false);
    expect(input.routes.some((item) => item.scope === "group_default")).toBe(true);
    expect(input.routes.some((item) => item.scope === "chat")).toBe(true);
  });

  it("renders an archived route in red and blocks invalid replacement saves", async () => {
    routesRef.current = {
      ...routesRef.current,
      data: {
        workspace_id: "workspace-1",
        routes: [route({
          id: "route-archived",
          chat_id: "oc_design",
          chat_name: "Design review",
          agent_id: "agt_old",
          agent_name: "Old designer",
          agent_archived: true,
        })],
      },
    };
    renderRoutes();
    const row = await screen.findByTestId("feishu-route-oc_design");
    expect(row).toHaveClass("bg-destructive/5", "text-destructive");
    expect(within(row).getByText(/This Agent is archived/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save routes" })).toBeDisabled();
  });

  it("adds a selected group and saves its refreshed chat name", async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.click(screen.getByRole("button", { name: "Add group" }));
    const dialog = await screen.findByRole("dialog", { name: "Add group" });
    const chatSelect = within(dialog).getByRole("combobox", { name: "Select group" });
    await user.click(chatSelect);
    await user.click(await screen.findByRole("option", { name: /Release coordination/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Release coordination")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save routes" }));
    await waitFor(() => expect(mockSaveRoutes).toHaveBeenCalledTimes(1));
    const input = mockSaveRoutes.mock.calls[0]?.[0] as {
      routes: Array<{ scope: string; chat_id?: string | null; chat_name?: string | null }>;
    };
    expect(input.routes).toContainEqual(expect.objectContaining({
      scope: "chat",
      chat_id: "oc_release",
      chat_name: "Release coordination",
    }));
  });

  it("shows a readable error when the bot group directory returns 4xx", async () => {
    const user = userEvent.setup();
    chatsRef.current = {
      data: undefined,
      isPending: false,
      isError: true,
      error: {
        status: 422,
        body: {
          code: "credentials_unavailable",
          error: "Feishu bot credentials are unavailable",
        },
      },
    };
    renderRoutes();
    await user.click(screen.getByRole("button", { name: "Add group" }));
    const dialog = await screen.findByRole("dialog", { name: "Add group" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Feishu bot credentials are unavailable",
    );
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeDisabled();
  });
});
