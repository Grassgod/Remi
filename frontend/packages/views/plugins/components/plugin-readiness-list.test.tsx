// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentPluginRuntimeState } from "@multiremi/core/plugins";
import enCommon from "../../locales/en/common.json";
import enPlugins from "../../locales/en/plugins.json";

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ runtimeDetail: (id: string) => `/runtimes/${id}` }),
}));
vi.mock("@multiremi/core/plugins", () => ({
  useRetryAgentPluginRuntime: () => ({
    mutateAsync,
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PluginReadinessList } from "./plugin-readiness-list";

const resources = { en: { common: enCommon, plugins: enPlugins } };

const blockedState = {
  id: "state-1",
  runtimeId: "runtime-1",
  pluginId: "plugin-1",
  pluginVersionId: "version-1",
  status: "blocked",
  retryCount: 2,
  nextRetryAt: "2026-08-14T10:00:00Z",
  lastErrorCode: "dependency_missing",
  lastError: "Git is unavailable",
  lastAttemptAt: "2026-08-14T09:55:00Z",
  runtime: { id: "runtime-1", name: "Build Mac", status: "online" },
  version: { id: "version-1", version: "1.2.0" },
} as unknown as AgentPluginRuntimeState;

const daemonUpgradeState = {
  ...blockedState,
  id: "state-upgrade",
  status: "setup_required",
  retryCount: 0,
  nextRetryAt: null,
  lastErrorCode: "daemon_upgrade_required",
  lastError: "Upgrade the Multiremi daemon to enable Agent Plugins.",
  runtime: {
    ...blockedState.runtime,
    metadata: { cli_version: "0.2.26" },
  },
} as unknown as AgentPluginRuntimeState;

describe("PluginReadinessList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue([]);
  });

  it("shows the latest failure, retry metadata, and schedules a retry", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" resources={resources}>
        <PluginReadinessList pluginId="plugin-1" states={[blockedState]} />
      </I18nProvider>,
    );

    expect(screen.getByText("Build Mac")).toHaveAttribute(
      "href",
      "/runtimes/runtime-1",
    );
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText(/Git is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Next retry/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Retry$/i }));
    expect(mutateAsync).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      versionId: "version-1",
    });
  });

  it("allows an immediate version-scoped retry while retry is scheduled", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" resources={resources}>
        <PluginReadinessList
          pluginId="plugin-1"
          states={[{ ...blockedState, status: "retry_scheduled" }]}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^Retry$/i }));
    expect(mutateAsync).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      versionId: "version-1",
    });
  });

  it("uses Offline instead of the stale plugin state when the Runtime is down", () => {
    const offline = {
      ...blockedState,
      runtime: { ...blockedState.runtime, status: "offline" },
    } as AgentPluginRuntimeState;
    render(
      <I18nProvider locale="en" resources={resources}>
        <PluginReadinessList pluginId="plugin-1" states={[offline]} />
      </I18nProvider>,
    );

    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Retry$/i })).not.toBeInTheDocument();
  });

  it("turns an unsupported daemon into an upgrade action instead of a futile retry", () => {
    render(
      <I18nProvider locale="en" resources={resources}>
        <PluginReadinessList
          pluginId="plugin-1"
          states={[daemonUpgradeState]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Daemon upgrade required")).toBeInTheDocument();
    expect(
      screen.getByText(/This daemon version cannot install plugins/),
    ).toBeInTheDocument();
    expect(screen.getByText("Daemon CLI v0.2.26")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Upgrade daemon/i }),
    ).toHaveAttribute("href", "/runtimes/runtime-1");
    expect(
      screen.queryByText(/Upgrade the Multiremi daemon/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Retry$/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps waiting and downloading visibly distinct", () => {
    render(
      <I18nProvider locale="en" resources={resources}>
        <PluginReadinessList
          pluginId="plugin-1"
          states={[
            {
              ...blockedState,
              id: "state-pending",
              status: "pending",
              lastErrorCode: null,
              lastError: null,
            },
            {
              ...blockedState,
              id: "state-downloading",
              status: "downloading",
              lastErrorCode: null,
              lastError: null,
            },
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Waiting for daemon")).toBeInTheDocument();
    expect(screen.getByText("Downloading")).toBeInTheDocument();
  });

  it("gives a recovery step when a capable daemon never starts setup", () => {
    render(
      <I18nProvider locale="en" resources={resources}>
        <PluginReadinessList
          pluginId="plugin-1"
          states={[
            {
              ...blockedState,
              lastErrorCode: "daemon_plugin_reconcile_timeout",
              lastError: "Internal watchdog message",
            },
          ]}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByText(/Make sure it is running, then retry/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Internal watchdog message/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Retry$/i })).toBeInTheDocument();
  });
});
