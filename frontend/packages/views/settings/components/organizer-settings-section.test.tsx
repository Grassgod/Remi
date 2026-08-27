// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockGetSettings = vi.hoisted(() => vi.fn());
const mockUpdateSettings = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: {
    getWorkspaceOrganizerSettings: mockGetSettings,
    updateWorkspaceOrganizerSettings: mockUpdateSettings,
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { OrganizerSettingsSection } from "./organizer-settings-section";

const resources = { en: { common: enCommon, settings: enSettings } };

function renderSection(canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="en" resources={resources}>
        {children}
      </I18nProvider>
    </QueryClientProvider>
  );
  render(
    <OrganizerSettingsSection workspaceId="ws-1" canManage={canManage} />,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue({ workspace_id: "ws-1", mode: "report_only" });
  mockUpdateSettings.mockImplementation(async (_workspaceId: string, mode: string) => ({
    workspace_id: "ws-1",
    mode,
  }));
});

afterEach(() => {
  cleanup();
});

describe("OrganizerSettingsSection", () => {
  it("defaults to report-only and saves an explicit intervention choice", async () => {
    const user = userEvent.setup();
    renderSection();

    const reportOnly = await screen.findByRole("radio", { name: /^Report only/ });
    expect(reportOnly).toBeChecked();
    expect(screen.getByRole("button", { name: "Save mode" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /^Allow intervention/ }));
    await user.click(screen.getByRole("button", { name: "Save mode" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith("ws-1", "act");
    });
  });

  it("keeps the mode visible but read-only for regular members", async () => {
    renderSection(false);

    expect(await screen.findByRole("radio", { name: /^Report only/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("radio", { name: /^Allow intervention/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Only workspace owners and admins can change this mode.")).toBeInTheDocument();
  });
});
