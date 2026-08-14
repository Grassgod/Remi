// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enPlugins from "../../locales/en/plugins.json";

const activate = vi.hoisted(() => vi.fn());
const rollback = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({
  plugin: null as unknown,
  versions: [] as unknown[],
  states: [] as unknown[],
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    plugins: () => "/plugins",
    runtimeDetail: (id: string) => `/runtimes/${id}`,
  }),
}));
vi.mock("@multiremi/core/plugins", () => ({
  pluginDetailOptions: () => ({
    queryKey: ["plugin", "detail"],
    queryFn: () => Promise.resolve(fixture.plugin),
  }),
  pluginVersionsOptions: () => ({
    queryKey: ["plugin", "versions"],
    queryFn: () => Promise.resolve(fixture.versions),
  }),
  pluginRuntimeStatesOptions: () => ({
    queryKey: ["plugin", "runtimes"],
    queryFn: () => Promise.resolve(fixture.states),
  }),
  useActivateAgentPluginVersion: () => ({
    mutateAsync: activate,
    isPending: false,
  }),
  useRollbackAgentPluginVersion: () => ({
    mutateAsync: rollback,
    isPending: false,
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
}));
vi.mock("./plugin-import-dialog", () => ({
  PluginImportDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Version importer</div> : null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PluginDetailPage } from "./plugin-detail-page";

const resources = { en: { common: enCommon, plugins: enPlugins } };

function version(id: string, value: string, createdAt: string) {
  return {
    id,
    pluginId: "plugin-1",
    version: value,
    manifestPath: ".claude-plugin/plugin.json",
    manifest: { name: "Review tools" },
    files: [{ path: ".claude-plugin/plugin.json" }],
    artifactDigest: `digest-${id}`,
    artifactSize: 128,
    sourceRevision: null,
    requirements: {},
    createdAt,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <PluginDetailPage pluginId="plugin-1" />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("PluginDetailPage version lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activate.mockResolvedValue({ id: "plugin-1" });
    rollback.mockResolvedValue({ id: "plugin-1" });
    const active = version("version-2", "2.0.0", "2026-08-13T00:00:00Z");
    const candidate = version("version-3", "3.0.0", "2026-08-14T00:00:00Z");
    const previous = version("version-1", "1.0.0", "2026-08-12T00:00:00Z");
    fixture.plugin = {
      id: "plugin-1",
      provider: "claude",
      name: "Review tools",
      description: "Review code",
      sourceType: "manifest",
      sourceUrl: null,
      sourceRef: null,
      activeVersionId: active.id,
      candidateVersionId: candidate.id,
      activeVersion: active,
      candidateVersion: candidate,
      bindingCount: 2,
    };
    fixture.versions = [candidate, active, previous];
    fixture.states = [];
  });

  it("shows full history and executes candidate activation and targeted rollback", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Version history")).toBeInTheDocument();
    expect(screen.getAllByText("3.0.0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.0.0").length).toBeGreaterThan(0);
    expect(screen.getByText("1.0.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Activate" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Version 3.0.0");
    await user.click(within(dialog).getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("version-3"));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Roll back" }));
    dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Version 1.0.0");
    await user.click(within(dialog).getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("version-1"));
  });

  it("opens the directory importer for a new candidate version", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Import version" }),
    );
    expect(screen.getByRole("dialog", { name: "" })).toHaveTextContent(
      "Version importer",
    );
  });
});
