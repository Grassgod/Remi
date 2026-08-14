// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enPlugins from "../../locales/en/plugins.json";

const fixture = vi.hoisted(() => ({
  byProvider: new Map<string, unknown[]>(),
  states: new Map<string, unknown[]>(),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    pluginDetail: (id: string) => `/plugins/${id}`,
    runtimeDetail: (id: string) => `/runtimes/${id}`,
  }),
}));
vi.mock("@multiremi/core/plugins", () => ({
  pluginListOptions: (_wsId: string, provider: string) => ({
    queryKey: ["plugins", provider],
    queryFn: () => Promise.resolve(fixture.byProvider.get(provider) ?? []),
  }),
  pluginRuntimeStatesOptions: (_wsId: string, pluginId: string) => ({
    queryKey: ["plugins", pluginId, "runtimes"],
    queryFn: () => Promise.resolve(fixture.states.get(pluginId) ?? []),
  }),
  useImportAgentPlugin: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInspectAgentPluginRepository: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
  useRetryAgentPluginRuntime: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useNavigation: () => ({ push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PluginsPage } from "./plugins-page";

const resources = { en: { common: enCommon, plugins: enPlugins } };

function plugin(id: string, provider: "claude" | "codex", name: string) {
  return {
    id,
    provider,
    name,
    description: `${name} description`,
    activeVersion: { version: "1.0.0" },
    bindingCount: 1,
    updatedAt: "2026-08-14T00:00:00Z",
  };
}

function runtimeState(id: string, name: string, status: string) {
  return {
    id,
    runtimeId: id,
    pluginVersionId: "version-1",
    status,
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: null,
    lastError: null,
    lastAttemptAt: null,
    runtime: { id, name, status: "online" },
    version: { id: "version-1", version: "1.0.0" },
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <PluginsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("PluginsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.byProvider = new Map([
      ["claude", [plugin("claude-1", "claude", "Claude tools")]],
      ["codex", [plugin("codex-1", "codex", "Codex tools")]],
    ]);
    fixture.states = new Map([
      [
        "claude-1",
        [
          runtimeState("runtime-1", "Build Mac", "ready"),
          runtimeState("runtime-2", "Linux worker", "downloading"),
        ],
      ],
      ["codex-1", [runtimeState("runtime-3", "Codex host", "ready")]],
    ]);
  });

  it("keeps Claude and Codex catalogs separate and shows every Runtime state", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Claude tools")).toBeInTheDocument();
    expect(screen.getByText("Build Mac")).toBeInTheDocument();
    expect(screen.getByText("Linux worker")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Downloading")).toBeInTheDocument();
    expect(screen.queryByText("Codex tools")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Codex" }));

    expect(await screen.findByText("Codex tools")).toBeInTheDocument();
    expect(screen.queryByText("Claude tools")).not.toBeInTheDocument();
    expect(screen.getByText("Codex host")).toBeInTheDocument();
  });

  it("filters the active provider list without changing provider", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Claude tools");

    await user.type(screen.getByPlaceholderText("Search plugins..."), "missing");
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Claude" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
