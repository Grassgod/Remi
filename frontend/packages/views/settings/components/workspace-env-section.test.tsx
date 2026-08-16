import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockGetWorkspaceEnv = vi.hoisted(() => vi.fn());
const mockUpdateWorkspaceEnv = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: {
    getWorkspaceEnv: mockGetWorkspaceEnv,
    updateWorkspaceEnv: mockUpdateWorkspaceEnv,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WorkspaceEnvSection } from "./workspace-env-section";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };
function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("WorkspaceEnvSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceEnv.mockResolvedValue({ workspace_id: "ws-1", env: { GH_TOKEN: "ghp_x" } });
    mockUpdateWorkspaceEnv.mockResolvedValue({ workspace_id: "ws-1", env: { GH_TOKEN: "ghp_x" } });
  });

  it("does not fetch env values until the admin reveals them", () => {
    render(<WorkspaceEnvSection workspaceId="ws-1" />, { wrapper: Wrapper });
    expect(screen.getByText("Reveal & edit")).toBeInTheDocument();
    expect(mockGetWorkspaceEnv).not.toHaveBeenCalled();
  });

  it("reveals rows with masked values and saves edits through the env endpoint", async () => {
    const user = userEvent.setup();
    render(<WorkspaceEnvSection workspaceId="ws-1" />, { wrapper: Wrapper });

    await user.click(screen.getByText("Reveal & edit"));
    await waitFor(() => expect(mockGetWorkspaceEnv).toHaveBeenCalledWith("ws-1"));

    // Value renders masked (password input) by default.
    const valueInput = screen.getByDisplayValue("ghp_x");
    expect(valueInput).toHaveAttribute("type", "password");

    await user.clear(valueInput);
    await user.type(valueInput, "ghp_new");
    await user.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(mockUpdateWorkspaceEnv).toHaveBeenCalledWith("ws-1", {
        env: { GH_TOKEN: "ghp_new" },
      }),
    );
  });

  it("rejects duplicate keys before hitting the API", async () => {
    const user = userEvent.setup();
    mockGetWorkspaceEnv.mockResolvedValue({
      workspace_id: "ws-1",
      env: { GH_TOKEN: "a" },
    });
    render(<WorkspaceEnvSection workspaceId="ws-1" />, { wrapper: Wrapper });

    await user.click(screen.getByText("Reveal & edit"));
    await screen.findByDisplayValue("GH_TOKEN");

    await user.click(screen.getByText("Add"));
    const keyInputs = screen.getAllByPlaceholderText("KEY");
    await user.type(keyInputs[keyInputs.length - 1]!, "GH_TOKEN");
    await user.click(screen.getByText("Save"));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mockUpdateWorkspaceEnv).not.toHaveBeenCalled();
  });
});
