import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockMutate = vi.hoisted(() => vi.fn());
const preferencesRef = vi.hoisted(() => ({
  current: {} as Record<string, "all" | "muted">,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      workspace_id: "workspace-1",
      preferences: preferencesRef.current,
    },
  }),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/notification-preferences/queries", () => ({
  notificationPreferenceOptions: () => ({ queryKey: ["notification-preferences"] }),
}));

vi.mock("@multiremi/core/notification-preferences/mutations", () => ({
  useUpdateNotificationPreferences: () => ({ mutate: mockMutate }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import { NotificationsTab } from "./notifications-tab";

const TEST_RESOURCES = {
  en: { common: enCommon, settings: enSettings },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

describe("NotificationsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preferencesRef.current = {};
  });

  it("defaults the Feishu group to enabled when legacy preferences omit it", () => {
    preferencesRef.current = { updates: "muted" };

    render(<NotificationsTab />, { wrapper: I18nWrapper });

    expect(screen.getByRole("switch", { name: "Feishu messages" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Priority & Due date" })).not.toBeChecked();
  });

  it("persists Feishu message muting independently from legacy updates", async () => {
    preferencesRef.current = { updates: "muted" };
    const user = userEvent.setup();
    render(<NotificationsTab />, { wrapper: I18nWrapper });

    await user.click(screen.getByRole("switch", { name: "Feishu messages" }));

    expect(mockMutate).toHaveBeenCalledWith(
      { updates: "muted", feishu_messages: "muted" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });
});
