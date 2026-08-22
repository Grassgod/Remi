import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ScmConnection } from "@multiremi/core/types";
import zhAutopilots from "../../locales/zh-Hans/autopilots.json";
import zhCommon from "../../locales/zh-Hans/common.json";

const connectionsRef = vi.hoisted(() => ({ current: [] as ScmConnection[] }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data: options.queryKey.includes("connections")
      ? { connections: connectionsRef.current }
      : undefined,
  }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

import {
  getDefaultScmEventConfig,
  ScmEventConfigSection,
} from "./scm-event-config";

const TEST_RESOURCES = {
  "zh-Hans": { common: zhCommon, autopilots: zhAutopilots },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="zh-Hans" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function connection(provider: "github" | "codebase"): ScmConnection {
  return {
    id: `${provider}-internal-id`,
    workspaceId: "workspace-1",
    name: provider === "github" ? "主连接" : "内网连接",
    provider,
    mode: "hybrid",
    baseUrl: null,
    apiBaseUrl: null,
    enabled: true,
    pollIntervalSeconds: 60,
    repositoryScope: "all",
    isDefault: true,
    accessTokenSet: true,
    accessTokenHint: null,
    webhookSecretSet: true,
    webhookSecretHint: null,
    verificationStatus: "valid",
    verifiedAt: "2026-08-21T00:00:00.000Z",
    verificationIdentity: "test-user",
    verifiedRepositoryCount: 0,
    verifiedRepositoryTotal: 0,
    verificationErrorCode: null,
    verificationError: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    repositories: [],
  };
}

describe("ScmEventConfigSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionsRef.current = [];
  });

  it("renders the localized all-connections label instead of the sentinel value", () => {
    render(
      <ScmEventConfigSection config={getDefaultScmEventConfig()} onChange={vi.fn()} />,
      { wrapper: I18nWrapper },
    );

    const selector = screen.getByRole("combobox");
    expect(selector).toHaveTextContent("全部连接");
    expect(selector).not.toHaveTextContent("__all__");
  });

  it.each([
    ["github", "主连接 · GitHub"],
    ["codebase", "内网连接 · Codebase"],
  ] as const)("renders a %s connection name and provider instead of its id", (provider, label) => {
    const selected = connection(provider);
    connectionsRef.current = [selected];

    render(
      <ScmEventConfigSection
        config={{ ...getDefaultScmEventConfig(), connectionId: selected.id }}
        onChange={vi.fn()}
      />,
      { wrapper: I18nWrapper },
    );

    const selector = screen.getByRole("combobox");
    expect(selector).toHaveTextContent(label);
    expect(selector).not.toHaveTextContent(selected.id);
  });

  it("shows an unavailable connection instead of changing a stale selection to all connections", () => {
    const selected = { ...connection("github"), enabled: false };
    connectionsRef.current = [selected];

    render(
      <ScmEventConfigSection
        config={{ ...getDefaultScmEventConfig(), connectionId: selected.id }}
        onChange={vi.fn()}
      />,
      { wrapper: I18nWrapper },
    );

    const selector = screen.getByRole("combobox");
    expect(selector).toHaveTextContent("连接不可用");
    expect(selector).not.toHaveTextContent("全部连接");
    expect(selector).not.toHaveTextContent(selected.id);
  });
});
