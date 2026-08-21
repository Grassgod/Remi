import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhSettings from "../../locales/zh-Hans/settings.json";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data: options.queryKey[0] === "repositories"
      ? { repositories: [] }
      : { connections: [] },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/api", () => ({
  api: {
    getBaseUrl: () => "",
    createScmConnection: vi.fn(),
    updateScmConnection: vi.fn(),
    deleteScmConnection: vi.fn(),
    bindScmRepository: vi.fn(),
    unbindScmRepository: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ScmConnectionsSection } from "./scm-connections-section";

const TEST_RESOURCES = {
  "zh-Hans": { common: zhCommon, settings: zhSettings },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="zh-Hans" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

describe("ScmConnectionsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders localized labels instead of raw ingestion mode values", async () => {
    const user = userEvent.setup();
    render(<ScmConnectionsSection workspaceId="workspace-1" canManage />, {
      wrapper: I18nWrapper,
    });

    await user.click(screen.getAllByRole("button", { name: "添加连接" })[0]!);
    const modeSelect = screen.getByRole("combobox");
    expect(modeSelect).toHaveTextContent("主动拉取");
    expect(modeSelect).not.toHaveTextContent("poll");

    await user.click(modeSelect);
    await user.click(await screen.findByRole("option", { name: "Webhook" }));
    expect(modeSelect).toHaveTextContent("Webhook");
    expect(modeSelect).not.toHaveTextContent("webhook");

    await user.click(modeSelect);
    await user.click(await screen.findByRole("option", { name: "混合" }));
    expect(modeSelect).toHaveTextContent("混合");
    expect(modeSelect).not.toHaveTextContent("hybrid");
  });
});
