import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const updatePrompts = vi.hoisted(() => vi.fn());
const refetchPrompts = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const roleRef = vi.hoisted(() => ({ current: "owner" }));
const copyText = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    if (options.queryKey?.[0] === "workspace-prompt-settings") {
      return {
        data: {
          bootstrapPrompt: "Create a PR.",
          deltaPrompt: "",
          revision: 2,
          updatedAt: null,
          updatedBy: null,
        },
        isPending: false,
        isError: false,
        refetch: refetchPrompts,
      };
    }
    if (options.queryKey?.[0] === "workspace-prompt-template") {
      return {
        data: {
          bootstrap: "# Bootstrap Prompt\n\n{{issue_description}}",
          delta: "# Delta Prompt\n\n{{session_jsonl}}",
          sha256: { bootstrap: "a".repeat(64), delta: "b".repeat(64) },
        },
        isPending: false,
        isError: false,
        refetch: vi.fn(),
      };
    }
    return { data: [{ user_id: "user-1", role: roleRef.current }] };
  },
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/workspace/queries", () => ({ memberListOptions: () => ({ queryKey: ["members"] }) }));
vi.mock("@multiremi/core/api", () => ({
  api: {
    getWorkspacePromptSettings: vi.fn(),
    updateWorkspacePromptSettings: updatePrompts,
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@multiremi/ui/lib/clipboard", () => ({ copyText }));

import { PromptsTab } from "./prompts-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("PromptsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleRef.current = "owner";
    updatePrompts.mockResolvedValue({
      bootstrapPrompt: "Create a PR.",
      deltaPrompt: "Check new comments.",
      revision: 3,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("edits Bootstrap and Delta together under one revision", async () => {
    const user = userEvent.setup();
    render(<PromptsTab />, { wrapper: Wrapper });

    await user.clear(screen.getByLabelText("Workspace Bootstrap Prompt"));
    await user.type(screen.getByLabelText("Workspace Bootstrap Prompt"), "Bootstrap rule");
    await user.click(screen.getByRole("tab", { name: "Delta" }));
    await user.type(screen.getByLabelText("Workspace Delta Prompt"), "Check new comments.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updatePrompts).toHaveBeenCalledWith("workspace-1", {
      bootstrapPrompt: "Bootstrap rule",
      deltaPrompt: "Check new comments.",
      expectedRevision: 2,
    }));
  });

  it("keeps prompts read-only for a regular member", () => {
    roleRef.current = "member";
    render(<PromptsTab />, { wrapper: Wrapper });

    expect(screen.getByLabelText("Workspace Bootstrap Prompt")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows and copies the read-only platform template", async () => {
    const user = userEvent.setup();
    render(<PromptsTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "View template" }));
    const bootstrap = screen.getByLabelText("Bootstrap platform prompt template");
    expect(bootstrap).toHaveTextContent("{{issue_description}}");
    expect(bootstrap).not.toHaveAttribute("contenteditable", "true");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith("# Bootstrap Prompt\n\n{{issue_description}}");

    await user.click(screen.getByRole("tab", { name: "Delta" }));
    expect(screen.getByLabelText("Delta platform prompt template")).toHaveTextContent("{{session_jsonl}}");
  });

  it("keeps horizontal prompt tabs horizontal inside vertical settings tabs", () => {
    render(
      <Tabs defaultValue="prompts" orientation="vertical">
        <TabsList variant="line">
          <TabsTrigger value="prompts">Prompts</TabsTrigger>
        </TabsList>
        <TabsContent value="prompts"><PromptsTab /></TabsContent>
      </Tabs>,
      { wrapper: Wrapper },
    );

    const tabLists = screen.getAllByRole("tablist");
    const settingsTabs = tabLists[0];
    const promptTabs = tabLists.at(-1);
    expect(settingsTabs).toHaveAttribute("data-orientation", "vertical");
    expect(settingsTabs?.className).toContain("data-vertical:flex-col");
    expect(promptTabs).toHaveAttribute("data-orientation", "horizontal");
    expect(promptTabs?.className).toContain("data-horizontal:h-8");
    expect(promptTabs?.className).not.toContain("group-data-vertical/tabs:flex-col");
  });
});
