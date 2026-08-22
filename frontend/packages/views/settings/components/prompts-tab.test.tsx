import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const updatePrompts = vi.hoisted(() => vi.fn());
const refetchPrompts = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const roleRef = vi.hoisted(() => ({ current: "owner" }));

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
});
