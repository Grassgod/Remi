import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const statusRef = vi.hoisted(() => ({
  data: null as { canManage: boolean } | null,
  isPending: false,
  isSuccess: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: statusRef.data,
    isPending: statusRef.isPending,
    isSuccess: statusRef.isSuccess,
  }),
}));
vi.mock("@multiremi/core/platform-lifecycle", () => ({
  platformStatusOptions: () => ({ queryKey: ["platform-lifecycle", "status"] }),
}));
vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => ({ name: "Acme" }),
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    pathname: "/acme/settings",
    searchParams: new URLSearchParams(),
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

// The sidebar gating under test doesn't need real tab contents; stub them all
// so this test doesn't inherit every tab's data dependencies.
vi.mock("./account-tab", () => ({ AccountTab: () => <div /> }));
vi.mock("./preferences-tab", () => ({ PreferencesTab: () => <div /> }));
vi.mock("./notifications-tab", () => ({ NotificationsTab: () => <div /> }));
vi.mock("./tokens-tab", () => ({ TokensTab: () => <div /> }));
vi.mock("./workspace-tab", () => ({ WorkspaceTab: () => <div /> }));
vi.mock("./prompts-tab", () => ({ PromptsTab: () => <div /> }));
vi.mock("./members-tab", () => ({ MembersTab: () => <div /> }));
vi.mock("./source-control-tab", () => ({ SourceControlTab: () => <div /> }));
vi.mock("./integrations-tab", () => ({ IntegrationsTab: () => <div /> }));
vi.mock("./model-gateway-tab", () => ({ ModelGatewayTab: () => <div /> }));
vi.mock("./labs-tab", () => ({ LabsTab: () => <div /> }));
vi.mock("./storage-cleanup-tab", () => ({ StorageCleanupTab: () => <div /> }));
vi.mock("./platform-tab", () => ({ PlatformTab: () => <div /> }));

import { SettingsPage } from "./settings-page";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("SettingsPage platform tab visibility", () => {
  beforeEach(() => {
    statusRef.data = null;
    statusRef.isPending = false;
    statusRef.isSuccess = false;
  });

  it("shows the Version & Services tab optimistically while status is loading", () => {
    statusRef.isPending = true;
    render(<SettingsPage />, { wrapper: Wrapper });
    expect(screen.getByRole("tab", { name: /Version & Services/ })).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("keeps the tab once status resolves with manage permission", () => {
    statusRef.data = { canManage: true };
    statusRef.isSuccess = true;
    render(<SettingsPage />, { wrapper: Wrapper });
    expect(screen.getByRole("tab", { name: /Version & Services/ })).toBeInTheDocument();
  });

  it("hides the tab when the user cannot manage the platform", () => {
    statusRef.data = { canManage: false };
    statusRef.isSuccess = true;
    render(<SettingsPage />, { wrapper: Wrapper });
    expect(screen.queryByRole("tab", { name: /Version & Services/ })).not.toBeInTheDocument();
    expect(screen.queryByText("System")).not.toBeInTheDocument();
  });

  it("hides the tab when the status request fails (e.g. 403)", () => {
    render(<SettingsPage />, { wrapper: Wrapper });
    expect(screen.queryByRole("tab", { name: /Version & Services/ })).not.toBeInTheDocument();
  });
});
