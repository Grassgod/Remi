// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRuntime } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enPlugins from "../../locales/en/plugins.json";

const fixture = vi.hoisted(() => ({ states: [] as unknown[] }));
const retry = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ runtimeDetail: (id: string) => `/runtimes/${id}` }),
}));
vi.mock("@multiremi/core/plugins", () => ({
  runtimePluginStatesOptions: (_wsId: string, runtimeId: string) => ({
    queryKey: ["runtimes", runtimeId, "plugins"],
    queryFn: () => Promise.resolve(fixture.states),
  }),
  useRetryAgentPluginRuntime: () => ({
    mutateAsync: retry,
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

import { RuntimePluginsTab } from "./runtime-plugins-tab";

const resources = { en: { common: enCommon, plugins: enPlugins } };
const runtime: AgentRuntime = {
  id: "runtime-1",
  workspace_id: "ws-1",
  daemon_id: null,
  name: "Build Mac",
  runtime_mode: "local",
  provider: "claude",
  launch_header: "",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: "user-1",
  visibility: "private",
  last_seen_at: null,
  created_at: "2026-08-14T00:00:00Z",
  updated_at: "2026-08-14T00:00:00Z",
};

function state({
  id,
  pluginId,
  pluginName,
  provider,
  versionId,
  version,
  status,
  activeVersionId,
  candidateVersionId = null,
}: {
  id: string;
  pluginId: string;
  pluginName: string;
  provider: "claude" | "codex";
  versionId: string;
  version: string;
  status: string;
  activeVersionId: string;
  candidateVersionId?: string | null;
}) {
  return {
    id,
    runtimeId: "runtime-1",
    pluginId,
    pluginVersionId: versionId,
    desiredReason:
      versionId === candidateVersionId ? "candidate" : "active_binding",
    status,
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: status === "setup_required" ? "auth_required" : null,
    lastError: status === "setup_required" ? "Sign-in is required" : null,
    lastAttemptAt: null,
    runtime: { id: "runtime-1", name: "Build Mac", status: "online" },
    plugin: {
      id: pluginId,
      name: pluginName,
      provider,
      activeVersionId,
      candidateVersionId,
    },
    version: { id: versionId, version },
  };
}

function renderTab(canManage: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <RuntimePluginsTab runtime={runtime} canManage={canManage} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("RuntimePluginsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retry.mockResolvedValue([]);
    fixture.states = [
      state({
        id: "state-active",
        pluginId: "plugin-1",
        pluginName: "Review tools",
        provider: "claude",
        versionId: "version-1",
        version: "1.0.0",
        status: "setup_required",
        activeVersionId: "version-1",
        candidateVersionId: "version-2",
      }),
      state({
        id: "state-candidate",
        pluginId: "plugin-1",
        pluginName: "Review tools",
        provider: "claude",
        versionId: "version-2",
        version: "2.0.0",
        status: "retry_scheduled",
        activeVersionId: "version-1",
        candidateVersionId: "version-2",
      }),
      state({
        id: "state-codex",
        pluginId: "plugin-2",
        pluginName: "Codex tools",
        provider: "codex",
        versionId: "version-3",
        version: "3.0.0",
        status: "ready",
        activeVersionId: "version-3",
      }),
    ];
  });

  it("shows cross-provider and multi-version desired states with scoped retry", async () => {
    const user = userEvent.setup();
    renderTab(true);

    expect(await screen.findAllByText("Review tools")).toHaveLength(2);
    expect(screen.getByText("Codex tools")).toBeInTheDocument();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("Candidate")).toBeInTheDocument();
    expect(screen.getAllByText(/Version [123]\.0\.0/)).toHaveLength(3);
    expect(screen.getByText(/Sign-in is required/)).toBeInTheDocument();

    const retryButtons = screen.getAllByRole("button", { name: /^Retry$/i });
    await user.click(retryButtons[1]!);
    expect(retry).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      versionId: "version-2",
    });
  });

  it("keeps retry hidden for read-only viewers", async () => {
    renderTab(false);

    expect(await screen.findByText("Codex tools")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Retry$/i })).not.toBeInTheDocument();
  });

  it("renders a stable empty state when no plugin is desired", async () => {
    fixture.states = [];
    renderTab(true);

    expect(await screen.findByText("No plugins required")).toBeInTheDocument();
  });
});
