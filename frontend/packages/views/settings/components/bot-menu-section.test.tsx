import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const menuRef = vi.hoisted(() => ({ current: { workspace_id: "workspace-1", bot_menu: {} } }));
const membersRef = vi.hoisted(() => ({
  current: [{
    id: "member-1",
    workspace_id: "workspace-1",
    user_id: "user-1",
    role: "owner" as "owner" | "admin" | "member",
    created_at: "2026-01-01T00:00:00.000Z",
    name: "Owner",
    email: "owner@example.test",
    avatar_url: null,
  }],
}));
const mockUpdateBotMenu = vi.hoisted(() => vi.fn());
const mockPublishBotMenu = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options.queryKey ?? [];
    return key.includes("bot-menu")
      ? { data: menuRef.current, isPending: false }
      : { data: membersRef.current, isPending: false };
  },
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  botMenuOptions: () => ({ queryKey: ["workspaces", "workspace-1", "bot-menu"] }),
  memberListOptions: () => ({ queryKey: ["workspaces", "workspace-1", "members"] }),
  workspaceKeys: { botMenu: () => ["workspaces", "workspace-1", "bot-menu"] },
}));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/api", () => ({
  api: {
    updateBotMenu: mockUpdateBotMenu,
    publishBotMenu: mockPublishBotMenu,
    getBotMenuPublish: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BotMenuSection } from "./bot-menu-section";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };
function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("BotMenuSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    menuRef.current = { workspace_id: "workspace-1", bot_menu: {} };
    membersRef.current[0]!.role = "owner";
    mockUpdateBotMenu.mockImplementation(async (_workspaceId, botMenu) => ({
      workspace_id: "workspace-1",
      bot_menu: botMenu,
    }));
    mockPublishBotMenu.mockResolvedValue({
      id: "publish-1",
      workspace_id: "workspace-1",
      dry_run: true,
      status: "completed",
      result: { dryRun: true, defaultPublished: true, userMenuCount: 2 },
      error: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("lets an owner add and save a default menu item", async () => {
    const user = userEvent.setup();
    render(<BotMenuSection />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByPlaceholderText("Menu label"), "Status");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateBotMenu).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        default: [{ name: "Status", behaviors: [{ type: "send_message" }] }],
      }),
    ));
  });

  it("renders members as read-only", () => {
    membersRef.current[0]!.role = "member";
    render(<BotMenuSection />, { wrapper: Wrapper });

    expect(screen.getByText(/Only workspace owners and admins/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add item" })).not.toBeInTheDocument();
  });

  it("runs a dry-run publish and shows its result", async () => {
    const user = userEvent.setup();
    render(<BotMenuSection />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Dry run" }));

    await waitFor(() => expect(mockPublishBotMenu).toHaveBeenCalledWith("workspace-1", true));
    expect(await screen.findByText("Validation passed for the default menu and 2 personalized menus.")).toBeInTheDocument();
  });
});
